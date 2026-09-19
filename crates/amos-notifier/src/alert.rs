//! Alert value type + severity enum.
//!
//! An `Alert` is the unit of work for the dispatcher: a stable `id`
//! (used for deduplication inside a suppression window), a human-readable
//! `message`, optional `labels` (free-form JSON object), and a [`Severity`].
//!
//! Severity is **explicit on every alert** — there is no implicit "P2 by
//! default" fallback. A caller that does not know the severity must say
//! `Alert::p1(...)` (the safe middle). This is the same fail-closed rule
//! the rest of the workspace uses for any decision that has user-visible
//! consequences.

use serde::{Deserialize, Serialize};

/// P0 / P1 / P2 — see `README.md` for semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Severity {
    /// On-call, wake someone up.
    P0,
    /// Same-day response.
    P1,
    /// Business-hours response.
    P2,
}

impl Severity {
    /// The minimum interval (seconds) between two distinct alerts of the
    /// same `(id, severity)` pair. P0 has the smallest window because P0s
    /// are rare and re-paging within 30 s is desirable for genuine flapping;
    /// P2 has the largest because a firehose of P2s is exactly what
    /// suppresses are designed to prevent.
    pub fn suppression_window_secs(self) -> u64 {
        match self {
            Severity::P0 => 30,
            Severity::P1 => 300,
            Severity::P2 => 3600,
        }
    }

    /// Per-channel rate limit (alerts per second). P0 is **unlimited**
    /// (0 means "no token bucket — every alert ships immediately") because
    /// a P0 you rate-limit away is the worst possible outcome.
    pub fn rate_per_sec(self) -> f64 {
        match self {
            Severity::P0 => 0.0,
            Severity::P1 => 1.0,
            Severity::P2 => 0.1,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Severity::P0 => "P0",
            Severity::P1 => "P1",
            Severity::P2 => "P2",
        }
    }
}

/// One alert to be dispatched.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alert {
    /// Stable identifier (e.g. `"db.unreachable"`). Two alerts with the same
    /// `id` and `severity` inside a suppression window are **merged** — the
    /// operator sees "5× in 5 min" rather than 5 lines of noise.
    pub id: String,
    pub severity: Severity,
    pub message: String,
    /// Free-form labels (e.g. `{"host": "amos-edge-7", "service": "amos-ai"}`).
    #[serde(default)]
    pub labels: serde_json::Map<String, serde_json::Value>,
}

impl Alert {
    pub fn p0(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            severity: Severity::P0,
            message: message.into(),
            labels: Default::default(),
        }
    }
    pub fn p1(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            severity: Severity::P1,
            message: message.into(),
            labels: Default::default(),
        }
    }
    pub fn p2(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            severity: Severity::P2,
            message: message.into(),
            labels: Default::default(),
        }
    }

    pub fn with_label(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.labels
            .insert(key.into(), serde_json::Value::String(value.into()));
        self
    }

    /// A short, stable fingerprint used by the throttler as the dedup key.
    pub fn fingerprint(&self) -> String {
        format!("{}|{}", self.severity.label(), self.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppression_window_is_monotonic_p0_lt_p1_lt_p2() {
        assert!(Severity::P0.suppression_window_secs() < Severity::P1.suppression_window_secs());
        assert!(Severity::P1.suppression_window_secs() < Severity::P2.suppression_window_secs());
    }

    #[test]
    fn rate_per_sec_is_zero_for_p0_so_token_bucket_is_disabled() {
        // `0.0` means "no rate limit" (see Dispatcher semantics).
        assert_eq!(Severity::P0.rate_per_sec(), 0.0);
        assert!(Severity::P1.rate_per_sec() > 0.0);
        assert!(Severity::P2.rate_per_sec() > 0.0);
    }

    #[test]
    fn fingerprint_is_id_plus_severity_in_that_order() {
        let a = Alert::p0("db.unreachable", "down");
        assert_eq!(a.fingerprint(), "P0|db.unreachable");
        let b = Alert::p1("db.unreachable", "slow");
        assert_eq!(b.fingerprint(), "P1|db.unreachable");
    }

    #[test]
    fn with_label_attaches_a_string_value() {
        let a = Alert::p0("id", "msg").with_label("host", "edge-7");
        assert_eq!(a.labels.get("host").unwrap(), &serde_json::json!("edge-7"));
    }
}
