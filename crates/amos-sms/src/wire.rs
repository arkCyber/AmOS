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
            opt_u32(t, "unread"),
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
            m.get("from_me").and_then(Value::as_bool).unwrap_or(false),
            clamp_body(opt_str(m, "text"), i)?,
            req_ts(m, "ts_ms", i)?,
            m.get("read").and_then(Value::as_bool).unwrap_or(true),
        ));
    }
    Ok(out)
}

/// Parse one thread's messages without an expected-thread guard (for callers
/// that do not hold the request id, e.g. host tests).
pub fn parse_messages(payload: &str) -> Result<Vec<SmsMessage>, SmsError> {
    parse_messages_for(payload, None)
}

/// Parse a send reply: `{"ok":true}` on success, or
/// `{"error":…,"error_kind":…}` mapped to a typed error by [`checked`].
/// Anything else is a protocol violation — a send is never assumed to have
/// succeeded.
pub fn parse_send_reply(payload: &str) -> Result<(), SmsError> {
    let v = checked(payload)?;
    match v.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(()),
        Some(false) => Err(SmsError::Failed(
            "device rejected the send (ok=false)".into(),
        )),
        None => Err(SmsError::Invalid(
            "send reply without an 'ok' or 'error' field".into(),
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

fn opt_u32(o: &Value, key: &str) -> u32 {
    o.get(key)
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_snapshot() {
        let json = r#"{"threads":[
          {"id":"1","address":"13800138000","display_name":"家人","last_text":"回吗","last_ts_ms":1700000000000,"unread":1},
          {"id":"2","address":"10086","last_ts_ms":1690000000000}
        ]}"#;
        let ts = parse_snapshot(json).unwrap();
        assert_eq!(ts.len(), 2);
        assert_eq!(ts[0].display_name, "家人");
        assert_eq!(ts[0].unread, 1);
        // Optional fields default honestly.
        assert_eq!(ts[1].display_name, "");
        assert_eq!(ts[1].last_text, "");
        assert_eq!(ts[1].unread, 0);
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
            .map(|i| format!(r#"{{"id":"{i}","ts_ms":1}}"#))
            .collect();
        let json = format!(r#"{{"thread_id":"1","messages":[{}]}}"#, msgs.join(","));
        assert!(parse_messages(&json).is_err());
        // An over-long single body is rejected.
        let body = "a".repeat(MAX_BODY_CHARS + 1);
        let json =
            format!(r#"{{"thread_id":"1","messages":[{{"id":"m","text":"{body}","ts_ms":1}}]}}"#);
        assert!(parse_messages(&json).is_err());
    }

    #[test]
    fn messages_reply_must_belong_to_the_requested_thread() {
        let json = r#"{"thread_id":"2","messages":[{"id":"m1","ts_ms":1}]}"#;
        // Cross-check passes for the right thread…
        assert_eq!(parse_messages_for(json, Some("2")).unwrap().len(), 1);
        // …and fails loudly for the wrong one (would show the wrong chat).
        let err = parse_messages_for(json, Some("1")).unwrap_err();
        assert_eq!(err.kind(), "invalid");
    }

    #[test]
    fn send_reply_is_never_assumed_successful() {
        assert!(parse_send_reply(r#"{"ok":true}"#).is_ok());
        // A denial surfaces as a typed permission error.
        assert_eq!(
            parse_send_reply(r#"{"error":"SEND_SMS not granted","error_kind":"permission"}"#)
                .unwrap_err(),
            SmsError::PermissionDenied("SEND_SMS not granted".into())
        );
        // Malformed/ambiguous replies are failures, never silent success.
        assert!(parse_send_reply(r#"{"ok":false}"#).is_err());
        assert!(parse_send_reply(r#"{}"#).is_err());
        assert!(parse_send_reply("not json").is_err());
    }
}
