//! View-layer trash for SMS messages (REQ-A42).
//!
//! The system SMS store is owned by the platform's **default SMS app** — AmOS
//! cannot delete rows from it (docs/sms.md, `sms.rs`). What we *can* do honestly
//! is stop showing a message on every AmOS surface while keeping it restorable:
//! the trash. This module is the pure domain half of that seam.
//!
//! Two honesty rules mirror the rest of the crate:
//!
//! 1. **No content is stored.** A trash entry is ids + timestamps only
//!    ([`TrashEntry`]). Storing message bodies here would create a *second*
//!    copy of exactly the sensitive text the platform owns (and that REQ-A41
//!    masks on display) — so the trash list can say *what* was hidden (thread,
//!    time) but never re-shows the text until it is restored.
//! 2. **Bounded + deterministic.** The list holds at most [`DEFAULT_TRASH_CAP`]
//!    entries; adding past the cap evicts the *oldest* trashed entry, which
//!    makes that message visible again (an honest, documented trade-off, the
//!    same policy shape as the blocklist's cap).

use serde_json::{json, Value};

use crate::error::SmsError;
use crate::spec::SmsMessage;
use crate::wire::MAX_BODY_CHARS;

/// Upper bound on trashed entries. Eviction is FIFO by `trashed_ms`: the oldest
/// trashed message reappears in the UI again. It is never *silently* lost — the
/// evicted entry travels back in [`TrashAdd::evicted`], which is what lets the
/// bridge log the churn (a count alone cannot: it is pinned at the cap).
pub const DEFAULT_TRASH_CAP: usize = 256;

/// Wire/file version of the trash JSON. A *newer* version is refused (we would
/// misread it); a corrupt or wrong-shaped file is an error, never an empty list.
pub const TRASH_FILE_VERSION: u32 = 1;

/// One hidden message: identity only, no body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashEntry {
    /// Owning thread id (stable provider id).
    pub thread_id: String,
    /// Stable message id (device row id / mock id).
    pub message_id: String,
    /// The message's own timestamp (epoch ms), from the provider row.
    pub ts_ms: i64,
    /// When the user trashed it (epoch ms; ordering key, newest first).
    pub trashed_ms: i64,
}

/// What one [`SmsTrash::add`] did — **two** facts, because "a new entry was
/// created" and "an entry was evicted to make room" are different events and
/// the cap makes them co-occur.
///
/// The eviction used to be a silent `pop()` inside `add`: the entry simply
/// vanished from the list and the evicted message became visible again with no
/// trace. The module's own doctrine (and `sms.rs`'s) is that churn is
/// *logged, never silent*, but a caller that only learns "newly added" cannot
/// log what it was never told — so the evicted entry travels in the result.
/// (REQ-A1799 / F-SH-893.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashAdd {
    /// A new entry was created. `false` = the id was already trashed and merely
    /// moved to the front (its recency refreshed).
    pub newly: bool,
    /// The entry dropped to stay within the cap, if one was. Its message is
    /// visible again. At most one add evicts one entry (the list grows by one
    /// and the cap is fixed); a `cap` of 1 makes every add evict its own
    /// predecessor.
    pub evicted: Option<TrashEntry>,
}

/// What a thread list should show instead of a provider preview that points at
/// trashed content. Applied **only** while `at_last_ts_ms` still matches the
/// thread's live `last_ts_ms`: any newer message changes that timestamp, drops
/// the override, and the natural (fresh, non-trashed) preview shows again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewOverride {
    pub thread_id: String,
    /// The thread `last_ts_ms` this override was computed against.
    pub at_last_ts_ms: i64,
    /// Replacement preview text (already display-redacted by the caller).
    pub last_text: String,
    /// Replacement preview timestamp (the newest *visible* message).
    pub last_ts_ms: i64,
    /// Replacement unread count (a trashed unread message must not keep a badge).
    pub unread: u32,
    /// `true` when *every* message of the thread is trashed → hide the thread.
    pub hidden: bool,
}

/// The bounded trash set. Order: newest `trashed_ms` first; equal timestamps
/// keep insertion order (deterministic for tests and for stable UI lists).
#[derive(Debug, Clone)]
pub struct SmsTrash {
    entries: Vec<TrashEntry>,
    previews: Vec<PreviewOverride>,
    cap: usize,
}

impl SmsTrash {
    /// Empty trash with the default cap.
    pub fn new() -> Self {
        Self::with_cap(DEFAULT_TRASH_CAP)
    }

    /// Empty trash with an explicit cap (a cap of 0 is a caller bug and is
    /// clamped to 1 — "remember nothing" is not a usable trash).
    pub fn with_cap(cap: usize) -> Self {
        Self {
            entries: Vec::new(),
            previews: Vec::new(),
            cap: cap.max(1),
        }
    }

    /// The configured cap.
    pub fn cap(&self) -> usize {
        self.cap
    }

    /// Hide `(thread_id, message_id)`. [`TrashAdd::newly`] is `true` when newly
    /// added, `false` when it was already trashed (then it is merely moved to
    /// the front, so a re-trash refreshes its recency). [`TrashAdd::evicted`]
    /// names the entry dropped to stay within the cap, so the caller can log the
    /// churn instead of a message silently reappearing. Blank ids are a caller
    /// bug → error.
    pub fn add(
        &mut self,
        thread_id: &str,
        message_id: &str,
        ts_ms: i64,
        trashed_ms: i64,
    ) -> Result<TrashAdd, SmsError> {
        if thread_id.trim().is_empty() || message_id.trim().is_empty() {
            return Err(SmsError::Invalid(
                "trash add needs a non-blank thread id and message id".into(),
            ));
        }
        if let Some(pos) = self
            .entries
            .iter()
            .position(|e| e.thread_id == thread_id && e.message_id == message_id)
        {
            let mut e = self.entries.remove(pos);
            e.trashed_ms = trashed_ms;
            self.entries.insert(0, e);
            return Ok(TrashAdd {
                newly: false,
                evicted: None,
            });
        }
        let entry = TrashEntry {
            thread_id: thread_id.to_string(),
            message_id: message_id.to_string(),
            ts_ms,
            trashed_ms,
        };
        self.entries.insert(0, entry);
        // Evict the oldest trashed → it becomes visible again. Kept and returned,
        // not dropped on the floor: the churn is only observable to a caller that
        // is told which entry left.
        let mut evicted = None;
        while self.entries.len() > self.cap {
            evicted = self.entries.pop();
        }
        Ok(TrashAdd {
            newly: true,
            evicted,
        })
    }

    /// Undo a trash: the message shows again. `true` when an entry was removed.
    /// Any stored preview for the thread is dropped — it was computed against
    /// the trashed state and the caller recomputes one from the provider.
    pub fn restore(&mut self, thread_id: &str, message_id: &str) -> bool {
        let before = self.entries.len();
        self.entries
            .retain(|e| !(e.thread_id == thread_id && e.message_id == message_id));
        let removed = self.entries.len() != before;
        self.clear_preview(thread_id);
        removed
    }

    /// Drop everything; returns how many entries were purged. Previews go too —
    /// with no trash there is nothing to override.
    pub fn purge(&mut self) -> usize {
        let n = self.entries.len();
        self.entries.clear();
        self.previews.clear();
        n
    }

    /// Is this exact message trashed?
    pub fn contains(&self, thread_id: &str, message_id: &str) -> bool {
        self.entries
            .iter()
            .any(|e| e.thread_id == thread_id && e.message_id == message_id)
    }

    /// How many messages of `thread_id` are currently trashed.
    pub fn trashed_in(&self, thread_id: &str) -> usize {
        self.entries
            .iter()
            .filter(|e| e.thread_id == thread_id)
            .count()
    }

    /// Number of trashed messages.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// `true` when nothing is trashed.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Trashed entries, newest first.
    pub fn entries(&self) -> &[TrashEntry] {
        &self.entries
    }

    /// Store the replacement preview for `thread_id` (replaces any previous
    /// one; bounded to one per thread, and only threads with trashed content
    /// get one).
    ///
    /// The text is bounded to [`MAX_BODY_CHARS`] **here**, at the only door into
    /// the store, because [`Self::from_json`] refuses a stored `last_text` over
    /// that cap: the writer must not be able to produce a file its own reader
    /// rejects. The bound is not hypothetical — the producer redacts the whole
    /// ingested body and redaction *grows* it (`redact.rs`: output is input plus
    /// up to 2 bytes per masked span, since an amount span can be a single digit
    /// while `REDACTION` is three characters), so a body the wire accepted can
    /// redact past the cap. Redaction runs **before** this clamp, so truncating
    /// here can never store an unmasked tail; and a preview is a display excerpt
    /// of a body the protocol already caps at [`MAX_BODY_CHARS`].
    pub fn set_preview(&mut self, mut o: PreviewOverride) {
        if o.thread_id.trim().is_empty() {
            return; // defensive: a blank thread id can never match a live thread
        }
        o.last_text = clamp_preview_text(o.last_text);
        match self
            .previews
            .iter_mut()
            .find(|p| p.thread_id == o.thread_id)
        {
            Some(slot) => *slot = o,
            None => self.previews.push(o),
        }
    }

    /// The override for `thread_id`, **only** if it is still fresh (the thread's
    /// live `last_ts_ms` equals the one the override was computed against). A
    /// stale override is treated as absent: a new message legitimately owns the
    /// preview again.
    pub fn preview(&self, thread_id: &str, last_ts_ms: i64) -> Option<&PreviewOverride> {
        self.previews
            .iter()
            .find(|p| p.thread_id == thread_id && p.at_last_ts_ms == last_ts_ms)
    }

    /// Drop any override for `thread_id`.
    pub fn clear_preview(&mut self, thread_id: &str) {
        self.previews.retain(|p| p.thread_id != thread_id);
    }

    /// Stored overrides (persisted with the entries).
    pub fn previews(&self) -> &[PreviewOverride] {
        &self.previews
    }

    /// Serialize for the persistence file:
    /// `{"version":1,"entries":[{thread_id,message_id,ts_ms,trashed_ms}],
    /// "previews":[{thread_id,at_last_ts_ms,last_text,last_ts_ms,unread,hidden}]}`.
    pub fn to_json(&self) -> String {
        json!({
            "version": TRASH_FILE_VERSION,
            "entries": self.entries.iter().map(|e| json!({
                "thread_id": e.thread_id,
                "message_id": e.message_id,
                "ts_ms": e.ts_ms,
                "trashed_ms": e.trashed_ms,
            })).collect::<Vec<_>>(),
            "previews": self.previews.iter().map(|p| json!({
                "thread_id": p.thread_id,
                "at_last_ts_ms": p.at_last_ts_ms,
                "last_text": p.last_text,
                "last_ts_ms": p.last_ts_ms,
                "unread": p.unread,
                "hidden": p.hidden,
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// Parse a trash file produced by [`Self::to_json`]. Defensive field-by-field
    /// extraction (the wire.rs rule: a wrong shape is an error, never silence)
    /// and bounded: more entries than the cap is a protocol violation, not a
    /// silent truncation.
    pub fn from_json(text: &str, cap: usize) -> Result<Self, SmsError> {
        let v: Value = serde_json::from_str(text)
            .map_err(|e| SmsError::Invalid(format!("trash json: {e}")))?;
        let version = v
            .get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| SmsError::Invalid("trash json missing 'version'".into()))?;
        if version > TRASH_FILE_VERSION as u64 {
            return Err(SmsError::Invalid(format!(
                "trash json version {version} is newer than supported {TRASH_FILE_VERSION}"
            )));
        }
        let raw = v
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| SmsError::Invalid("trash json missing 'entries' array".into()))?;
        if raw.len() > cap {
            return Err(SmsError::Invalid(format!(
                "trash json has {} entries; cap is {cap}",
                raw.len()
            )));
        }
        let mut entries = Vec::with_capacity(raw.len());
        for (i, e) in raw.iter().enumerate() {
            let thread_id = req_str(e, "thread_id", i)?;
            let message_id = req_str(e, "message_id", i)?;
            if thread_id.trim().is_empty() || message_id.trim().is_empty() {
                return Err(SmsError::Invalid(format!("trash entry {i} has a blank id")));
            }
            entries.push(TrashEntry {
                thread_id,
                message_id,
                ts_ms: req_i64(e, "ts_ms", i)?,
                trashed_ms: req_i64(e, "trashed_ms", i)?,
            });
        }
        // Newest first; a total key (Reverse) keeps the sort deterministic and
        // clippy-clean (`sort_by_key` over the closure comparator).
        entries.sort_by_key(|e| std::cmp::Reverse(e.trashed_ms));
        // An *absent* `previews` key is a legitimate minimal/older shape (no
        // overrides stored); a *present* key of the wrong shape is an error, never
        // silence — the same two-facts split the `entries` block keeps.
        let mut previews = Vec::new();
        match v.get("previews") {
            None => {}
            Some(Value::Array(list)) => {
                if list.len() > cap {
                    return Err(SmsError::Invalid(format!(
                        "trash json has {} previews; cap is {cap}",
                        list.len()
                    )));
                }
                for (i, p) in list.iter().enumerate() {
                    let thread_id = req_str(p, "thread_id", i)?;
                    if thread_id.trim().is_empty() {
                        return Err(SmsError::Invalid(format!(
                            "trash preview {i} has a blank id"
                        )));
                    }
                    previews.push(PreviewOverride {
                        thread_id,
                        at_last_ts_ms: req_i64(p, "at_last_ts_ms", i)?,
                        last_text: req_text(p, "last_text", i)?,
                        last_ts_ms: req_i64(p, "last_ts_ms", i)?,
                        unread: req_u32(p, "unread", i)?,
                        hidden: req_bool(p, "hidden", i)?,
                    });
                }
            }
            Some(_) => {
                return Err(SmsError::Invalid(
                    "trash json 'previews' is not an array".into(),
                ))
            }
        }
        Ok(Self {
            entries,
            previews,
            cap: cap.max(1),
        })
    }
}

impl Default for SmsTrash {
    fn default() -> Self {
        Self::new()
    }
}

/// Hide trashed messages from one thread's rows: returns the visible messages
/// (in order) and how many were hidden. The bridge uses the count for its
/// audit log; callers keep ownership of the original slice.
pub fn filter_messages<'a>(
    msgs: &'a [SmsMessage],
    trash: &SmsTrash,
) -> (Vec<&'a SmsMessage>, usize) {
    let mut hidden = 0;
    let mut visible = Vec::with_capacity(msgs.len());
    for m in msgs {
        if trash.contains(&m.thread_id, &m.id) {
            hidden += 1;
        } else {
            visible.push(m);
        }
    }
    (visible, hidden)
}

/// One required string field (wire.rs-style honest parse errors).
fn req_str(v: &Value, key: &str, i: usize) -> Result<String, SmsError> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| SmsError::Invalid(format!("trash json [{i}] missing '{key}'")))
}

/// One required i64 field.
fn req_i64(v: &Value, key: &str, i: usize) -> Result<i64, SmsError> {
    v.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| SmsError::Invalid(format!("trash json [{i}] missing '{key}'")))
}

/// One required bool field. Mirrors [`crate::wire`]'s `req_bool` rule (REQ-A1772):
/// a missing/wrong field is an honest error, never a silent default — a fabricated
/// `hidden = false` would show a thread whose *every* message is trashed.
fn req_bool(v: &Value, key: &str, i: usize) -> Result<bool, SmsError> {
    v.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| SmsError::Invalid(format!("trash json [{i}] missing '{key}'")))
}

/// One required unsigned count. Mirrors [`crate::wire`]'s `req_u32` rule
/// (REQ-A1786): a missing field is an honest error rather than a fabricated `0`
/// badge, and an out-of-range value **saturates** instead of wrapping — a count
/// is a measurement, so `u32::MAX` keeps the "there is something unread" fact
/// where a `0` mints a small number the file never held.
fn req_u32(v: &Value, key: &str, i: usize) -> Result<u32, SmsError> {
    v.get(key)
        .and_then(Value::as_u64)
        .map(|n| n.min(u32::MAX as u64) as u32)
        .ok_or_else(|| SmsError::Invalid(format!("trash json [{i}] missing '{key}'")))
}

/// One required preview text. A body over [`MAX_BODY_CHARS`] is refused, not
/// silently truncated — mirrors [`crate::wire`]'s `clamp_body` ("a protocol
/// violation, not a silently-truncated message").
fn req_text(v: &Value, key: &str, i: usize) -> Result<String, SmsError> {
    let s = req_str(v, key, i)?;
    if s.chars().count() > MAX_BODY_CHARS {
        return Err(SmsError::Invalid(format!(
            "trash json [{i}] '{key}' exceeds {MAX_BODY_CHARS} characters"
        )));
    }
    Ok(s)
}

/// The **writer's** half of `req_text`'s cap: bound a preview on its way into
/// the store to the same [`MAX_BODY_CHARS`], so `to_json` → `from_json` is total
/// for every state this store can hold. A cap, not a rewrite — a text already
/// within the bound is returned untouched (no allocation), which is why the
/// boundary is `>` and not `>=` on both sides.
fn clamp_preview_text(text: String) -> String {
    if text.chars().count() <= MAX_BODY_CHARS {
        return text;
    }
    text.chars().take(MAX_BODY_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(thread: &str, id: &str) -> SmsMessage {
        SmsMessage::new(thread, id, false, "body", 1_000, true)
    }

    #[test]
    fn add_then_contains_and_order_is_newest_first() {
        let mut t = SmsTrash::new();
        assert!(t.add("1", "m1", 100, 1_000).unwrap().newly);
        assert!(t.add("1", "m2", 200, 2_000).unwrap().newly);
        assert!(t.contains("1", "m1") && t.contains("1", "m2"));
        assert_eq!(t.len(), 2);
        // Newest trashed first.
        assert_eq!(t.entries()[0].message_id, "m2");
        assert_eq!(t.entries()[1].message_id, "m1");
    }

    #[test]
    fn blank_ids_are_a_caller_error_not_a_silent_add() {
        let mut t = SmsTrash::new();
        assert!(t.add(" ", "m1", 0, 0).is_err());
        assert!(t.add("1", "", 0, 0).is_err());
        assert!(t.is_empty());
    }

    #[test]
    fn re_add_is_not_a_duplicate_but_refreshes_recency() {
        let mut t = SmsTrash::new();
        assert!(t.add("1", "m1", 100, 1_000).unwrap().newly);
        assert!(t.add("1", "m2", 200, 2_000).unwrap().newly);
        assert!(!t.add("1", "m1", 100, 3_000).unwrap().newly); // already trashed
        assert_eq!(t.len(), 2);
        assert_eq!(t.entries()[0].message_id, "m1"); // moved to front
        assert_eq!(t.entries()[0].trashed_ms, 3_000);
    }

    #[test]
    fn restore_makes_the_message_visible_again() {
        let mut t = SmsTrash::new();
        t.add("1", "m1", 100, 1_000).unwrap();
        assert!(t.restore("1", "m1"));
        assert!(!t.contains("1", "m1"));
        assert!(!t.restore("1", "m1"), "restoring twice is an honest false");
    }

    #[test]
    fn cap_evicts_the_oldest_which_becomes_visible_again() {
        let mut t = SmsTrash::with_cap(2);
        t.add("1", "m1", 100, 1_000).unwrap();
        t.add("1", "m2", 200, 2_000).unwrap();
        t.add("1", "m3", 300, 3_000).unwrap();
        assert_eq!(t.len(), 2);
        assert!(!t.contains("1", "m1"), "oldest entry was evicted");
        assert!(t.contains("1", "m2") && t.contains("1", "m3"));
        assert_eq!(t.cap(), 2);
    }

    #[test]
    fn eviction_is_reported_not_silent() {
        let mut t = SmsTrash::with_cap(2);
        // Under the cap nothing is dropped, so nothing is reported.
        assert_eq!(t.add("1", "m1", 100, 1_000).unwrap().evicted, None);
        assert_eq!(t.add("1", "m2", 200, 2_000).unwrap().evicted, None);
        // The third entry pushes past the cap: the add must *name* the entry it
        // dropped, because the module (and `sms.rs`) promise the churn is logged,
        // and a caller cannot log what it is not told.
        let add = t.add("1", "m3", 300, 3_000).unwrap();
        assert!(add.newly);
        let ev = add.evicted.expect("the dropped entry must be returned");
        assert_eq!((ev.thread_id.as_str(), ev.message_id.as_str()), ("1", "m1"));
        assert_eq!(ev.ts_ms, 100);
        // A re-trash evicts nothing: it moves an existing entry, it does not add
        // one, so there is nothing to report (positive control for `evicted`).
        assert_eq!(t.add("1", "m2", 200, 4_000).unwrap().evicted, None);
    }

    #[test]
    fn a_zero_cap_is_clamped_to_one_usable_slot() {
        let mut t = SmsTrash::with_cap(0);
        assert!(t.add("1", "m1", 0, 0).unwrap().newly);
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn purge_clears_entries_and_previews_and_counts() {
        let mut t = SmsTrash::new();
        t.add("1", "m1", 100, 1_000).unwrap();
        t.set_preview(PreviewOverride {
            thread_id: "1".into(),
            at_last_ts_ms: 100,
            last_text: "".into(),
            last_ts_ms: 0,
            unread: 0,
            hidden: true,
        });
        assert_eq!(t.purge(), 1);
        assert!(t.is_empty() && t.previews().is_empty());
        assert_eq!(t.purge(), 0);
    }

    #[test]
    fn filter_messages_hides_exactly_the_trashed_rows() {
        let mut t = SmsTrash::new();
        t.add("1", "m2", 0, 0).unwrap();
        let msgs = vec![msg("1", "m1"), msg("1", "m2"), msg("1", "m3")];
        let (visible, hidden) = filter_messages(&msgs, &t);
        assert_eq!(hidden, 1);
        assert_eq!(visible.len(), 2);
        assert_eq!(visible[0].id, "m1");
        assert_eq!(visible[1].id, "m3");
    }

    #[test]
    fn json_roundtrip_keeps_entries_previews_and_order() {
        let mut t = SmsTrash::new();
        t.add("1", "m1", 100, 1_000).unwrap();
        t.add("1", "m2", 200, 2_000).unwrap();
        t.set_preview(PreviewOverride {
            thread_id: "1".into(),
            at_last_ts_ms: 2_000,
            last_text: "earlier text".into(),
            last_ts_ms: 100,
            unread: 1,
            hidden: false,
        });
        let text = t.to_json();
        let back = SmsTrash::from_json(&text, DEFAULT_TRASH_CAP).unwrap();
        assert_eq!(back.entries(), t.entries());
        assert_eq!(back.previews(), t.previews());
        assert!(
            back.preview("1", 2_000).is_some(),
            "fresh override survives"
        );
        assert!(back.preview("1", 9_999).is_none(), "stale ts never matches");
    }

    #[test]
    fn corrupt_or_wrong_shaped_json_is_an_error() {
        assert!(SmsTrash::from_json("not json", DEFAULT_TRASH_CAP).is_err());
        assert!(SmsTrash::from_json("{}", DEFAULT_TRASH_CAP).is_err());
        assert!(
            SmsTrash::from_json(r#"{"version":1,"entries":"nope"}"#, DEFAULT_TRASH_CAP).is_err()
        );
        assert!(
            SmsTrash::from_json(
                r#"{"version":1,"entries":[{"message_id":"m1","ts_ms":0,"trashed_ms":0}]}"#,
                DEFAULT_TRASH_CAP
            )
            .is_err(),
            "missing thread_id fails loudly"
        );
    }

    #[test]
    fn a_newer_file_version_is_refused_not_misread() {
        assert!(SmsTrash::from_json(r#"{"version":99,"entries":[]}"#, DEFAULT_TRASH_CAP).is_err());
        assert!(SmsTrash::from_json(r#"{"version":1,"entries":[]}"#, DEFAULT_TRASH_CAP).is_ok());
    }

    #[test]
    fn more_entries_than_the_cap_is_a_violation_not_a_truncation() {
        let mut t = SmsTrash::with_cap(2);
        t.add("1", "m1", 0, 1).unwrap();
        t.add("1", "m2", 0, 2).unwrap();
        let text = t.to_json();
        assert!(SmsTrash::from_json(&text, 1).is_err());
        assert!(SmsTrash::from_json(&text, 2).is_ok());
    }

    #[test]
    fn equal_timestamps_keep_insertion_order_deterministically() {
        let mut t = SmsTrash::new();
        for i in 0..5 {
            t.add("1", &format!("m{i}"), 0, 500).unwrap();
        }
        let ids: Vec<_> = t.entries().iter().map(|e| e.message_id.clone()).collect();
        assert_eq!(ids, vec!["m4", "m3", "m2", "m1", "m0"]);
    }

    #[test]
    fn set_preview_replaces_per_thread_and_ignores_blank_ids() {
        let mut t = SmsTrash::new();
        let mk = |text: &str| PreviewOverride {
            thread_id: "1".into(),
            at_last_ts_ms: 10,
            last_text: text.into(),
            last_ts_ms: 5,
            unread: 0,
            hidden: false,
        };
        t.set_preview(mk("a"));
        t.set_preview(mk("b"));
        assert_eq!(t.previews().len(), 1);
        assert_eq!(t.preview("1", 10).unwrap().last_text, "b");
        t.clear_preview("1");
        assert!(t.preview("1", 10).is_none());
        t.set_preview(PreviewOverride {
            thread_id: " ".into(),
            at_last_ts_ms: 10,
            last_text: String::new(),
            last_ts_ms: 0,
            unread: 0,
            hidden: false,
        });
        assert!(
            t.previews().is_empty(),
            "blank thread id cannot match anything"
        );
    }

    /// Build one-preview JSON so each leaf perturbs exactly one field (`None`
    /// omits the key entirely — the "missing" case).
    fn preview_json(last_text: Option<&str>, unread: Option<&str>, hidden: Option<&str>) -> String {
        let mut fields = vec![
            r#""thread_id":"1""#.to_string(),
            r#""at_last_ts_ms":10"#.to_string(),
            r#""last_ts_ms":5"#.to_string(),
        ];
        if let Some(t) = last_text {
            fields.push(format!("\"last_text\":{t}"));
        }
        if let Some(u) = unread {
            fields.push(format!("\"unread\":{u}"));
        }
        if let Some(h) = hidden {
            fields.push(format!("\"hidden\":{h}"));
        }
        format!(
            r#"{{"version":1,"entries":[],"previews":[{{{}}}]}}"#,
            fields.join(",")
        )
    }

    #[test]
    fn previews_present_but_wrong_shaped_is_an_error_while_absent_is_empty() {
        // A *present* key of the wrong shape is a protocol violation, not silence:
        // the old `if let Some(list) = …as_array()` folded it into "no previews"
        // and hid the corruption.
        assert!(SmsTrash::from_json(
            r#"{"version":1,"entries":[],"previews":"nope"}"#,
            DEFAULT_TRASH_CAP
        )
        .is_err());
        // An *absent* key stays legitimate (a minimal/older file) …
        assert!(SmsTrash::from_json(r#"{"version":1,"entries":[]}"#, DEFAULT_TRASH_CAP).is_ok());
        // … and an empty array is the ordinary "no overrides" shape.
        let t = SmsTrash::from_json(
            r#"{"version":1,"entries":[],"previews":[]}"#,
            DEFAULT_TRASH_CAP,
        )
        .unwrap();
        assert!(t.previews().is_empty());
    }

    #[test]
    fn a_preview_missing_a_field_is_an_error_not_a_fabricated_default() {
        let ok = preview_json(Some(r#""x""#), Some("1"), Some("true"));
        assert!(SmsTrash::from_json(&ok, DEFAULT_TRASH_CAP).is_ok());
        // `hidden` absent: a fabricated `false` would show a thread whose every
        // message is trashed.
        let no_hidden = preview_json(Some(r#""x""#), Some("1"), None);
        assert!(SmsTrash::from_json(&no_hidden, DEFAULT_TRASH_CAP).is_err());
        // `unread` absent: a fabricated `0` would drop a real badge.
        let no_unread = preview_json(Some(r#""x""#), None, Some("false"));
        assert!(SmsTrash::from_json(&no_unread, DEFAULT_TRASH_CAP).is_err());
        // `last_text` absent: a fabricated `""` would draw an empty preview.
        let no_text = preview_json(None, Some("0"), Some("false"));
        assert!(SmsTrash::from_json(&no_text, DEFAULT_TRASH_CAP).is_err());
    }

    #[test]
    fn a_preview_unread_above_u32_saturates_instead_of_wrapping() {
        // 2^32 as a u64 used to wrap to `0` through `as u32`.
        let j = preview_json(Some(r#""x""#), Some("4294967296"), Some("false"));
        let t = SmsTrash::from_json(&j, DEFAULT_TRASH_CAP).unwrap();
        assert_eq!(t.previews()[0].unread, u32::MAX);
        // An ordinary value passes through unchanged (positive control).
        let j = preview_json(Some(r#""x""#), Some("7"), Some("false"));
        let t = SmsTrash::from_json(&j, DEFAULT_TRASH_CAP).unwrap();
        assert_eq!(t.previews()[0].unread, 7);
    }

    #[test]
    fn a_preview_text_over_the_protocol_limit_is_refused_not_truncated() {
        let too_long = "a".repeat(MAX_BODY_CHARS + 1);
        let j = preview_json(Some(&format!("\"{too_long}\"")), Some("0"), Some("false"));
        assert!(SmsTrash::from_json(&j, DEFAULT_TRASH_CAP).is_err());
        // Exactly at the limit is accepted (boundary control).
        let at_limit = "a".repeat(MAX_BODY_CHARS);
        let j = preview_json(Some(&format!("\"{at_limit}\"")), Some("0"), Some("false"));
        let t = SmsTrash::from_json(&j, DEFAULT_TRASH_CAP).unwrap();
        assert_eq!(t.previews()[0].last_text.chars().count(), MAX_BODY_CHARS);
    }

    /// A **writer** must not be able to produce a file its own reader refuses
    /// (REQ-A1919). `from_json` caps a stored `last_text` at [`MAX_BODY_CHARS`],
    /// and the only producer of `last_text` redacts the *whole* ingested body —
    /// and redaction grows it (`redact.rs`: output is input plus up to 2 bytes
    /// per masked span, since a masked amount span can be a single digit while
    /// `REDACTION` is three characters). So a body the wire accepted can redact
    /// past the cap, be written, and be refused on the next start — where the
    /// bridge `warn!`s and **starts empty**, and the next save makes that loss
    /// permanent. `set_preview` is the one door into the store, so the bound
    /// lives there.
    #[test]
    fn a_preview_longer_than_the_protocol_cap_is_bounded_by_the_store() {
        let mut t = SmsTrash::new();
        t.set_preview(PreviewOverride {
            thread_id: "1".into(),
            at_last_ts_ms: 10,
            last_text: "a".repeat(MAX_BODY_CHARS + 50),
            last_ts_ms: 5,
            unread: 0,
            hidden: false,
        });
        assert_eq!(
            t.previews()[0].last_text.chars().count(),
            MAX_BODY_CHARS,
            "the stored preview is bounded where it enters the store"
        );
        let back = SmsTrash::from_json(&t.to_json(), DEFAULT_TRASH_CAP)
            .expect("what this store writes, this store must read");
        assert_eq!(back.previews(), t.previews(), "and it round-trips");
    }

    /// The bound is a *cap*, not a rewrite: an ordinary preview is stored
    /// verbatim, including exactly at the limit (the same boundary `req_text`
    /// keeps with `>` rather than `>=`).
    #[test]
    fn a_preview_at_the_cap_is_stored_unchanged() {
        let at_cap = "a".repeat(MAX_BODY_CHARS);
        let mut t = SmsTrash::new();
        t.set_preview(PreviewOverride {
            thread_id: "1".into(),
            at_last_ts_ms: 10,
            last_text: at_cap.clone(),
            last_ts_ms: 5,
            unread: 2,
            hidden: true,
        });
        assert_eq!(t.previews()[0].last_text, at_cap);
        assert_eq!(t.previews()[0].unread, 2);
        assert!(t.previews()[0].hidden);
    }

    /// Negative control, disjoint from the case above: the fix is in the
    /// **writer**, never the reader — a hand-written file that still carries an
    /// over-long preview must keep answering `Err` (REQ-A1916's rule stands; a
    /// reader relaxed to accept it would load a shape this version never wrote).
    #[test]
    fn a_hand_written_file_over_the_cap_is_still_refused() {
        let too_long = "a".repeat(MAX_BODY_CHARS + 1);
        let j = preview_json(Some(&format!("\"{too_long}\"")), Some("0"), Some("false"));
        assert!(
            SmsTrash::from_json(&j, DEFAULT_TRASH_CAP).is_err(),
            "the reader is untouched: an over-cap preview on disk is still a violation"
        );
    }
}
