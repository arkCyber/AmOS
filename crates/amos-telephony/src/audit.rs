//! Bounded, structured call audit log for the telephony domain.
//!
//! `docs/telephony.md §5` requires every emergency dial to be audited (rate-limit
//! exempt but never un-audited) and every call attributable. This module provides a
//! small, self-contained, bounded store that the gRPC `TelephonyService` writes on
//! each accepted/rejected dial (see `crate::service`). It lives in the domain crate
//! so a real device backend and future daemon/ops surfaces can read the same trail
//! without depending on `amos-ai`.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Whether an audited operation was accepted or refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuditOutcome {
    /// The operation was carried out (e.g. an emergency call was placed).
    Accepted,
    /// The operation was refused / failed (e.g. provider rejected the dial).
    Rejected,
}

/// One attributable call event (operation + target + outcome + human note).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditEntry {
    /// Unix epoch seconds when the entry was recorded (non-normative for tests).
    pub ts: u64,
    /// e.g. `"emergency_dial"` or `"dial"`.
    pub operation: String,
    /// The dialed number (digits) for a dial; free-form otherwise.
    pub detail: String,
    pub outcome: AuditOutcome,
    /// Short human note (e.g. a provider error) — never secrets.
    pub note: String,
}

impl AuditEntry {
    pub fn new(
        operation: &str,
        detail: &str,
        outcome: AuditOutcome,
        note: impl Into<String>,
    ) -> Self {
        Self {
            ts: now_epoch_secs(),
            operation: operation.to_string(),
            detail: detail.to_string(),
            outcome,
            note: note.into(),
        }
    }
}

/// Current Unix epoch seconds (best-effort; 0 if the clock is pre-epoch).
fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A bounded, thread-safe call audit log (drops oldest past the cap, so a rogue
/// caller can never make the log grow unboundedly).
pub struct AuditLog {
    inner: Mutex<Inner>,
}

struct Inner {
    entries: VecDeque<AuditEntry>,
    cap: usize,
}

impl AuditLog {
    /// Default cap keeps recent activity bounded for memory safety.
    pub fn new() -> Self {
        Self::with_cap(1024)
    }

    pub fn with_cap(cap: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: VecDeque::new(),
                cap: cap.max(1),
            }),
        }
    }

    /// Append an entry, evicting the oldest if over capacity.
    pub fn record(&self, entry: AuditEntry) {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if g.entries.len() >= g.cap {
            g.entries.pop_front();
        }
        g.entries.push_back(entry);
    }

    /// Snapshot of the logged entries, newest-first (for tests / future ops UI).
    pub fn entries(&self) -> Vec<AuditEntry> {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.entries.iter().rev().cloned().collect()
    }

    pub fn len(&self) -> usize {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether any entry matches `pred` (helpers tests / callers assert presence).
    pub fn any(&self, pred: impl Fn(&AuditEntry) -> bool) -> bool {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.entries.iter().any(pred)
    }
}

impl Default for AuditLog {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_returns_newest_first() {
        let log = AuditLog::new();
        log.record(AuditEntry::new(
            "emergency_dial",
            "112",
            AuditOutcome::Accepted,
            "",
        ));
        log.record(AuditEntry::new(
            "dial",
            "13800138000",
            AuditOutcome::Accepted,
            "",
        ));
        let es = log.entries();
        assert_eq!(es.len(), 2);
        assert_eq!(es[0].operation, "dial");
        assert_eq!(es[1].operation, "emergency_dial");
        assert_eq!(es[1].detail, "112");
        assert_eq!(es[1].outcome, AuditOutcome::Accepted);
    }

    #[test]
    fn bounded_cap_evicts_oldest() {
        let log = AuditLog::with_cap(3);
        for i in 0..5 {
            log.record(AuditEntry::new(
                "dial",
                &i.to_string(),
                AuditOutcome::Accepted,
                "",
            ));
        }
        assert_eq!(log.len(), 3);
        let es = log.entries();
        // newest first: last three are 4,3,2
        assert_eq!(es[0].detail, "4");
        assert_eq!(es[2].detail, "2");
    }
}
