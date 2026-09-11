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
/// trashed message reappears in the UI again (never silently lost — the count
/// the bridge logs and reports makes the churn observable).
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

    /// Hide `(thread_id, message_id)`. `Ok(true)` when newly added, `Ok(false)`
    /// when it was already trashed (then it is merely moved to the front, so a
    /// re-trash refreshes its recency). Blank ids are a caller bug → error.
    pub fn add(
        &mut self,
        thread_id: &str,
        message_id: &str,
        ts_ms: i64,
        trashed_ms: i64,
    ) -> Result<bool, SmsError> {
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
            return Ok(false);
        }
        let entry = TrashEntry {
            thread_id: thread_id.to_string(),
            message_id: message_id.to_string(),
            ts_ms,
            trashed_ms,
        };
        self.entries.insert(0, entry);
        while self.entries.len() > self.cap {
            self.entries.pop(); // evict the oldest trashed → it becomes visible again
        }
        Ok(true)
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
    pub fn set_preview(&mut self, o: PreviewOverride) {
        if o.thread_id.trim().is_empty() {
            return; // defensive: a blank thread id can never match a live thread
        }
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
        let mut previews = Vec::new();
        if let Some(list) = v.get("previews").and_then(Value::as_array) {
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
                let last_text = p
                    .get("last_text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(MAX_BODY_CHARS)
                    .collect::<String>();
                previews.push(PreviewOverride {
                    thread_id,
                    at_last_ts_ms: req_i64(p, "at_last_ts_ms", i)?,
                    last_text,
                    last_ts_ms: req_i64(p, "last_ts_ms", i)?,
                    unread: p.get("unread").and_then(Value::as_u64).unwrap_or(0) as u32,
                    hidden: p.get("hidden").and_then(Value::as_bool).unwrap_or(false),
                });
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

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(thread: &str, id: &str) -> SmsMessage {
        SmsMessage::new(thread, id, false, "body", 1_000, true)
    }

    #[test]
    fn add_then_contains_and_order_is_newest_first() {
        let mut t = SmsTrash::new();
        assert!(t.add("1", "m1", 100, 1_000).unwrap());
        assert!(t.add("1", "m2", 200, 2_000).unwrap());
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
        assert!(t.add("1", "m1", 100, 1_000).unwrap());
        assert!(t.add("1", "m2", 200, 2_000).unwrap());
        assert!(!t.add("1", "m1", 100, 3_000).unwrap()); // already trashed
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
    fn a_zero_cap_is_clamped_to_one_usable_slot() {
        let mut t = SmsTrash::with_cap(0);
        assert!(t.add("1", "m1", 0, 0).unwrap());
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
}
