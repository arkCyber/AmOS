//! Stable JSON wire contract between the SMS domain and its (Kotlin) glue / UI.
//!
//! Kept pure + headless so parsing is unit-tested here, on the host, exactly
//! like every other domain crate. Two rules make it safe to trust:
//!
//! 1. **Never fabricate.** A missing/wrong field, an out-of-range number, an
//!    explicit `{"error":…}` payload or an oversized payload is an honest
//!    [`SmsError`] — never a silent default that could show invented data.
//! 2. **Bounded.** Hard caps on payload size and item counts mean a buggy or
//!    hostile glue cannot exhaust memory through this seam; exceeding a cap is a
//!    protocol violation and fails loudly instead of truncating silently.
//!
//! Error payloads map to typed errors via `error_kind`:
//! `{"error":"…","error_kind":"permission"}` ⇒ [`SmsError::PermissionDenied`].

use serde_json::Value;

use crate::error::SmsError;
use crate::folder::SmsFolderCounts;
use crate::provider::SmsSendOutcome;
use crate::spec::{SmsMessage, SmsThread};

/// Upper bound on a single glue reply (4 MiB). A snapshot for 500 threads with
/// 500-char previews is well under 1 MiB — this is head-room against a runaway
/// glue, not a practical limit.
pub const MAX_PAYLOAD_BYTES: usize = 4 << 20;
/// Upper bound on threads accepted from one snapshot.
pub const MAX_THREADS: usize = 500;
/// Upper bound on messages accepted from one thread read.
pub const MAX_MESSAGES: usize = 1000;
/// Upper bound on a stored message body / preview (16 KiB — far beyond any real
/// SMS, which caps at 1600 chars, but bounded).
pub const MAX_BODY_CHARS: usize = 16 * 1024;

/// Parse the snapshot JSON produced by a provider/glue:
/// `{"threads":[{"id","address","display_name","last_text","last_ts_ms","unread"}]}`.
pub fn parse_snapshot(payload: &str) -> Result<Vec<SmsThread>, SmsError> {
    let v = checked(payload)?;
    let list = v
        .get("threads")
        .and_then(Value::as_array)
        .ok_or_else(|| SmsError::Invalid("snapshot missing 'threads' array".into()))?;
    if list.len() > MAX_THREADS {
        return Err(SmsError::Invalid(format!(
            "snapshot has {} threads; limit is {MAX_THREADS}",
            list.len()
        )));
    }
    let mut out = Vec::with_capacity(list.len());
    for (i, t) in list.iter().enumerate() {
        let id = req_id(t, "id", i)?;
        let address = req_str(t, "address", i)?;
        if address.trim().is_empty() {
            return Err(SmsError::Invalid(format!(
                "empty 'address' at thread index {i}"
            )));
        }
        out.push(SmsThread::new(
            id,
            address,
            opt_str(t, "display_name"),
            clamp_body(opt_str(t, "last_text"), i)?,
            req_ts(t, "last_ts_ms", i)?,
            // `unread` is required for the same reason its row-sibling
            // `last_ts_ms` is: it is a **measurement**, and the type cannot
            // represent "unknown". Folding an absent one to `0` showed a thread
            // with a waiting message as fully read, and the `th.unread > 0` badge
            // never lit (REQ-A1786).
            req_u32(t, "unread", i)?,
        ));
    }
    Ok(out)
}

/// Parse one thread's messages JSON:
/// `{"thread_id","messages":[{id,from_me,text,ts_ms,read}]}`.
///
/// `expected_thread_id` guards against a glue that answers with a different
/// thread than the one asked for (which would silently show the wrong chat).
pub fn parse_messages_for(
    payload: &str,
    expected_thread_id: Option<&str>,
) -> Result<Vec<SmsMessage>, SmsError> {
    let v = checked(payload)?;
    let thread_id = req_str(&v, "thread_id", 0)?;
    if let Some(expected) = expected_thread_id {
        if thread_id != expected {
            return Err(SmsError::Invalid(format!(
                "messages reply is for thread '{thread_id}', expected '{expected}'"
            )));
        }
    }
    let list = v
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| SmsError::Invalid("messages missing 'messages' array".into()))?;
    if list.len() > MAX_MESSAGES {
        return Err(SmsError::Invalid(format!(
            "thread has {} messages; limit is {MAX_MESSAGES}",
            list.len()
        )));
    }
    let mut out = Vec::with_capacity(list.len());
    for (i, m) in list.iter().enumerate() {
        out.push(SmsMessage::new(
            thread_id.clone(),
            req_id(m, "id", i)?,
            // `from_me`/`read` are required, not defaulted: a missing field is a
            // protocol violation (rule 1). Defaulting them here fabricated data —
            // `unwrap_or(false)`/`unwrap_or(true)` made an incoming unread message
            // read as outgoing-and-read (REQ-A1772).
            req_bool(m, "from_me", i)?,
            clamp_body(opt_str(m, "text"), i)?,
            req_ts(m, "ts_ms", i)?,
            req_bool(m, "read", i)?,
        ));
    }
    Ok(out)
}

/// Parse one thread's messages without an expected-thread guard (for callers
/// that do not hold the request id, e.g. host tests).
pub fn parse_messages(payload: &str) -> Result<Vec<SmsMessage>, SmsError> {
    parse_messages_for(payload, None)
}

/// Parse a folder-counts payload from the glue:
/// `{"inbox":2,"sent":1,"draft":0}`.
///
/// Every key is required, exactly like the row fields above: the Kotlin
/// `counts()` always emits all three, so a missing one is a protocol violation —
/// not evidence of an empty folder. Reading them with `opt_u32` folded a missing
/// key to `0` (rule 1), showing a folder badge count the device never reported
/// (REQ-A1792).
pub fn parse_counts(payload: &str) -> Result<SmsFolderCounts, SmsError> {
    let v = checked(payload)?;
    Ok(SmsFolderCounts {
        inbox: req_u32(&v, "inbox", 0)?,
        sent: req_u32(&v, "sent", 0)?,
        draft: req_u32(&v, "draft", 0)?,
    })
}

/// Parse a send reply into the platform's verdict, or a typed error.
///
/// The reply's `state` is the verdict and There Is No Default:
///   * `{"state":"sent"}` — the radio confirmed it took the message.
///   * `{"state":"unconfirmed","detail":…}` — no verdict within the glue's window.
///     Deliberately *not* `{"ok":true}`: on Android `SmsManager` returns without
///     throwing even when the radio cannot send, so a reply that cannot name a
///     state must not be read as success (the defect this replaces).
///   * `{"error":…,"error_kind":…}` — a refusal, mapped to a typed error by [`checked`].
///
/// A reply with neither a known `state` nor an error is a protocol violation.
pub fn parse_send_reply(payload: &str) -> Result<SmsSendOutcome, SmsError> {
    let v = checked(payload)?;
    match v.get("state").and_then(Value::as_str) {
        Some("sent") => Ok(SmsSendOutcome::Sent),
        Some("unconfirmed") => Ok(SmsSendOutcome::Unconfirmed(
            v.get("detail")
                .and_then(Value::as_str)
                .unwrap_or("the platform did not confirm the send")
                .to_string(),
        )),
        Some(other) => Err(SmsError::Invalid(format!(
            "unknown SMS send state '{other}'"
        ))),
        None => Err(SmsError::Invalid(
            "send reply without a 'state' or 'error' field".into(),
        )),
    }
}

/// Size-check, parse and unwrap an explicit `{"error":…}` reply.
fn checked(payload: &str) -> Result<Value, SmsError> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(SmsError::Invalid(format!(
            "SMS payload is {} bytes; limit is {MAX_PAYLOAD_BYTES}",
            payload.len()
        )));
    }
    let v: Value = serde_json::from_str(payload)
        .map_err(|e| SmsError::Invalid(format!("unparseable SMS payload: {e}")))?;
    // An explicit error reply is a first-class outcome, not an empty success.
    if let Some(err) = v.get("error").and_then(Value::as_str) {
        return Err(match v.get("error_kind").and_then(Value::as_str) {
            Some("permission") => SmsError::PermissionDenied(err.to_string()),
            Some("unavailable") => SmsError::Unavailable(err.to_string()),
            Some("invalid") => SmsError::Invalid(err.to_string()),
            _ => SmsError::Failed(err.to_string()),
        });
    }
    Ok(v)
}

fn req_str(o: &Value, key: &str, idx: usize) -> Result<String, SmsError> {
    match o.get(key).and_then(Value::as_str) {
        Some(s) => Ok(s.to_string()),
        None => Err(SmsError::Invalid(format!(
            "missing string field '{key}' at index {idx}"
        ))),
    }
}

/// An id must be present and non-blank (a blank id would break list keys).
fn req_id(o: &Value, key: &str, idx: usize) -> Result<String, SmsError> {
    let s = req_str(o, key, idx)?;
    if s.trim().is_empty() {
        return Err(SmsError::Invalid(format!("empty '{key}' at index {idx}")));
    }
    Ok(s)
}

fn opt_str(o: &Value, key: &str) -> String {
    o.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// A required boolean. Rule 1 of this module: a missing/wrong field is an honest
/// error, never a silent default. A fabricated `from_me`/`read` would show an
/// incoming unread message as outgoing-and-read (REQ-A1772).
fn req_bool(o: &Value, key: &str, idx: usize) -> Result<bool, SmsError> {
    o.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| SmsError::Invalid(format!("missing boolean field '{key}' at index {idx}")))
}

/// A required unsigned count (`unread`, and each folder count in
/// [`parse_counts`]). Like [`req_bool`], a missing / wrong field is an honest
/// error rather than a silent `0`: the count is a measurement the glue reported,
/// and a fabricated zero is data the device never sent (REQ-A1786). An
/// out-of-range value is clamped to `u32::MAX` rather than
/// wrapped — this field is a count, not an id, so saturation keeps the "there is
/// something unread" fact instead of minting a small number.
fn req_u32(o: &Value, key: &str, idx: usize) -> Result<u32, SmsError> {
    o.get(key)
        .and_then(Value::as_u64)
        .map(|n| n.min(u32::MAX as u64) as u32)
        .ok_or_else(|| SmsError::Invalid(format!("missing integer field '{key}' at index {idx}")))
}

/// Reject a body longer than [`MAX_BODY_CHARS`] (a protocol violation, not a
/// silently-truncated message).
fn clamp_body(text: String, idx: usize) -> Result<String, SmsError> {
    if text.chars().count() > MAX_BODY_CHARS {
        return Err(SmsError::Invalid(format!(
            "message body at index {idx} exceeds {MAX_BODY_CHARS} characters"
        )));
    }
    Ok(text)
}

/// A timestamp must be a non-negative epoch-ms integer (a negative epoch is
/// impossible and would render as a bogus date).
fn req_ts(o: &Value, key: &str, idx: usize) -> Result<i64, SmsError> {
    match o.get(key).and_then(Value::as_i64) {
        Some(n) if n >= 0 => Ok(n),
        Some(n) => Err(SmsError::Invalid(format!(
            "negative '{key}' ({n}) at index {idx}"
        ))),
        None => Err(SmsError::Invalid(format!(
            "missing integer field '{key}' at index {idx}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_snapshot() {
        let json = r#"{"threads":[
          {"id":"1","address":"13800138000","display_name":"家人","last_text":"回吗","last_ts_ms":1700000000000,"unread":1},
          {"id":"2","address":"10086","last_ts_ms":1690000000000,"unread":0}
        ]}"#;
        let ts = parse_snapshot(json).unwrap();
        assert_eq!(ts.len(), 2);
        assert_eq!(ts[0].display_name, "家人");
        assert_eq!(ts[0].unread, 1);
        // The *text* fields default honestly: `""` is this type's own documented
        // "unknown / not a contact" value, so an absent name is not fabricated
        // data. A *count* has no such sentinel — hence `unread` is read from the
        // wire, never defaulted (REQ-A1786).
        assert_eq!(ts[1].display_name, "");
        assert_eq!(ts[1].last_text, "");
        assert_eq!(ts[1].unread, 0, "the thread reported zero unread");
    }

    /// `unread` is a **count** — a measurement the glue reported — so a missing
    /// one is a protocol violation, never a silent `0` (REQ-A1786). Rule 1 of this
    /// module ("a missing field … is an honest `SmsError` — never a silent default
    /// that could show invented data") already forces the **row-sibling**
    /// `last_ts_ms` (a missing timestamp must not render as 1970) and forced
    /// `from_me`/`read` on the message rows (REQ-A1772). `unread` was the last
    /// folded field of a thread row: an inbox thread whose unread count the glue
    /// did not send came back as "0 unread", so the `th.unread > 0` badge never
    /// lit and the user was never told a message was waiting.
    #[test]
    fn a_thread_without_unread_is_refused_not_defaulted() {
        // Absent → refuse. The fabricated zero is exactly what rule 1 bans.
        assert!(
            parse_snapshot(r#"{"threads":[{"id":"1","address":"10086","last_ts_ms":1}]}"#).is_err()
        );
        // Wrong type is the same protocol violation, not a coerced 0.
        assert!(parse_snapshot(
            r#"{"threads":[{"id":"1","address":"10086","last_ts_ms":1,"unread":"2"}]}"#
        )
        .is_err());
        // A count can never be negative.
        assert!(parse_snapshot(
            r#"{"threads":[{"id":"1","address":"10086","last_ts_ms":1,"unread":-1}]}"#
        )
        .is_err());
        // Positive control: an honest count survives untouched — including a
        // reported zero, so "refuse every thread" cannot pass this test.
        let ok = parse_snapshot(
            r#"{"threads":[
                {"id":"1","address":"10086","last_ts_ms":1,"unread":3},
                {"id":"2","address":"10010","last_ts_ms":2,"unread":0}]}"#,
        )
        .unwrap();
        assert_eq!(ok[0].unread, 3);
        assert_eq!(ok[1].unread, 0, "a reported zero is a fact, not an unknown");
    }

    /// The folder counts are the **third** count-shaped field on this seam and the
    /// last one still folded: `parse_counts` read each folder with `opt_u32`, whose
    /// `unwrap_or(0)` turned a **missing key** into a reported `0`. The Kotlin
    /// `counts()` always emits all three keys, so an omission is a protocol
    /// violation, not evidence of an empty folder — the same fabrication rule 1
    /// bans, and the same one its siblings `unread` (REQ-A1786) and the row/message
    /// fields (REQ-A1772) already refuse. `SmsFolderCounts` is bare `u32`s, so a
    /// folded zero is the *only* thing a missing count could become: the folder
    /// badges read "0 sent" for a count the device never sent.
    #[test]
    fn folder_counts_without_every_key_are_refused_not_defaulted() {
        // A partial reply must not become a silent zero per missing folder.
        assert!(parse_counts(r#"{"inbox":2,"sent":1}"#).is_err());
        assert!(parse_counts(r#"{"inbox":2}"#).is_err());
        // A wrong type / a negative is the same protocol violation, not a coerced 0.
        assert!(parse_counts(r#"{"inbox":2,"sent":"1","draft":0}"#).is_err());
        assert!(parse_counts(r#"{"inbox":2,"sent":-1,"draft":0}"#).is_err());
        // Positive control: an honest reply survives untouched — including a
        // genuine zero, so "refuse every counts reply" cannot pass this test.
        let ok = parse_counts(r#"{"inbox":2,"sent":1,"draft":0}"#).unwrap();
        assert_eq!((ok.inbox, ok.sent, ok.draft), (2, 1, 0));
    }

    #[test]
    fn rejects_garbage_snapshot() {
        assert!(parse_snapshot("{}").is_err());
        assert!(parse_snapshot("not json").is_err());
        assert!(parse_snapshot(r#"{"threads":[{"id":"1"}]}"#).is_err()); // missing fields
    }

    #[test]
    fn parses_messages_and_keeps_thread_id() {
        let json = r#"{"thread_id":"1","messages":[
          {"id":"m1","from_me":false,"text":"hi","ts_ms":1,"read":true},
          {"id":"m2","from_me":true,"text":"hey","ts_ms":2,"read":true}
        ]}"#;
        let msgs = parse_messages(json).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].thread_id, "1");
        assert!(!msgs[0].from_me);
        assert!(msgs[1].from_me);
    }

    /// `from_me`/`read` are required: a missing one is a protocol violation, not
    /// a fabricated direction/read-state (REQ-A1772). The fabrication this bans
    /// is exact: an incoming, unread message read as outgoing-and-read.
    #[test]
    fn a_message_without_from_me_or_read_is_refused_not_defaulted() {
        let no_from =
            r#"{"thread_id":"1","messages":[{"id":"m1","text":"hi","ts_ms":1,"read":true}]}"#;
        assert!(parse_messages(no_from).is_err());
        let no_read =
            r#"{"thread_id":"1","messages":[{"id":"m1","from_me":false,"text":"hi","ts_ms":1}]}"#;
        assert!(parse_messages(no_read).is_err());
        // With both present, the honest values survive untouched.
        let both = r#"{"thread_id":"1","messages":[{"id":"m1","from_me":false,"text":"hi","ts_ms":1,"read":false}]}"#;
        let m = &parse_messages(both).unwrap()[0];
        assert!(!m.from_me && !m.read, "an incoming unread message stays so");
    }

    #[test]
    fn error_payloads_become_typed_errors() {
        let denied = r#"{"error":"READ_SMS not granted","error_kind":"permission"}"#;
        assert_eq!(
            parse_snapshot(denied).unwrap_err(),
            SmsError::PermissionDenied("READ_SMS not granted".into())
        );
        // An error is an error for thread reads too — never an empty success.
        assert!(parse_messages(denied).is_err());
        // Unknown kinds degrade to Failed, still an error.
        let other = r#"{"error":"boom"}"#;
        assert!(matches!(parse_snapshot(other), Err(SmsError::Failed(_))));
    }

    #[test]
    fn rejects_impossible_values() {
        // Negative epoch is impossible.
        assert!(
            parse_snapshot(r#"{"threads":[{"id":"1","address":"10086","last_ts_ms":-5}]}"#)
                .is_err()
        );
        // Blank ids and blank addresses are protocol violations.
        assert!(
            parse_snapshot(r#"{"threads":[{"id":"  ","address":"10086","last_ts_ms":1}]}"#)
                .is_err()
        );
        assert!(parse_snapshot(r#"{"threads":[{"id":"1","address":"","last_ts_ms":1}]}"#).is_err());
        // Missing timestamps must not default to 0 (would render as 1970).
        assert!(parse_snapshot(r#"{"threads":[{"id":"1","address":"10086"}]}"#).is_err());
    }

    #[test]
    fn enforces_size_and_count_caps() {
        // Oversized payload is rejected before parsing.
        let huge = "x".repeat(MAX_PAYLOAD_BYTES + 1);
        assert!(parse_snapshot(&huge).is_err());
        // Too many threads / messages are protocol violations, not truncations.
        let threads: Vec<String> = (0..=MAX_THREADS)
            .map(|i| format!(r#"{{"id":"{i}","address":"10086","last_ts_ms":1}}"#))
            .collect();
        let json = format!(r#"{{"threads":[{}]}}"#, threads.join(","));
        assert!(parse_snapshot(&json).is_err());
        let msgs: Vec<String> = (0..=MAX_MESSAGES)
            .map(|i| format!(r#"{{"id":"{i}","from_me":false,"ts_ms":1,"read":true}}"#))
            .collect();
        let json = format!(r#"{{"thread_id":"1","messages":[{}]}}"#, msgs.join(","));
        assert!(parse_messages(&json).is_err());
        // An over-long single body is rejected.
        let body = "a".repeat(MAX_BODY_CHARS + 1);
        let json = format!(
            r#"{{"thread_id":"1","messages":[{{"id":"m","from_me":false,"text":"{body}","ts_ms":1,"read":true}}]}}"#
        );
        assert!(parse_messages(&json).is_err());
    }

    #[test]
    fn messages_reply_must_belong_to_the_requested_thread() {
        let json =
            r#"{"thread_id":"2","messages":[{"id":"m1","from_me":false,"ts_ms":1,"read":true}]}"#;
        // Cross-check passes for the right thread…
        assert_eq!(parse_messages_for(json, Some("2")).unwrap().len(), 1);
        // …and fails loudly for the wrong one (would show the wrong chat).
        let err = parse_messages_for(json, Some("1")).unwrap_err();
        assert_eq!(err.kind(), "invalid");
    }

    #[test]
    fn send_reply_is_never_assumed_successful() {
        assert_eq!(
            parse_send_reply(r#"{"state":"sent"}"#).unwrap(),
            SmsSendOutcome::Sent
        );
        // The third verdict survives the wire as itself, carrying its reason —
        // neither folded into "sent" nor turned into a failure.
        assert_eq!(
            parse_send_reply(r#"{"state":"unconfirmed","detail":"no verdict in 6000ms"}"#).unwrap(),
            SmsSendOutcome::Unconfirmed("no verdict in 6000ms".into())
        );
        assert_eq!(SmsSendOutcome::Sent.wire(), "sent");
        assert_eq!(
            SmsSendOutcome::Unconfirmed("x".into()).wire(),
            "unconfirmed"
        );
        // A denial surfaces as a typed permission error.
        assert_eq!(
            parse_send_reply(r#"{"error":"SEND_SMS not granted","error_kind":"permission"}"#)
                .unwrap_err(),
            SmsError::PermissionDenied("SEND_SMS not granted".into())
        );
        // The radio refusing the message is a typed error, not a verdict.
        assert_eq!(
            parse_send_reply(
                r#"{"error":"rejected by the radio: RADIO_OFF","error_kind":"rejected"}"#
            )
            .unwrap_err(),
            SmsError::Failed("rejected by the radio: RADIO_OFF".into())
        );
        // The pre-fix shape (`{"ok":true}`, no state) must NOT read as a send any
        // more: a reply that cannot name a verdict is a protocol violation.
        assert!(parse_send_reply(r#"{"ok":true}"#).is_err());
        assert!(parse_send_reply(r#"{"ok":false}"#).is_err());
        assert!(parse_send_reply(r#"{}"#).is_err());
        assert!(parse_send_reply(r#"{"state":"maybe"}"#).is_err());
        assert!(parse_send_reply("not json").is_err());
    }
}
