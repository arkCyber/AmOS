//! Threshold alerts over the daemon's **existing** honest counters (audit item
//! `CODE_AUDIT_REPORT.md` §「健康检查和监控」 → `[ ] 添加警告和告警机制`).
//!
//! Why: every condition worth alerting on is *already* reported — the breaker's state,
//! the pool's rejection counters, the log sink's lost bytes, the engine's degraded
//! flag, the governor's throttle flags, DVFS write failures. What was missing is a
//! **single place that says what is wrong right now**, so an operator (or the UI) does
//! not have to know which of eight blocks to read and which number counts as bad.
//!
//! Honesty rules (the same discipline as `breaker.rs` / `pool.rs`):
//!  - an alert is **derived**, never invented: every rule names the counter it reads,
//!    and a healthy daemon produces an empty list (no "all clear" object that could be
//!    mistaken for a health check we did not perform).
//!  - `active_for` is the time since **this process** first observed the condition —
//!    *not* "how long the problem has existed" (a restart resets it; say so, don't
//!    imply a longer history than we have).
//!  - alerts **clear themselves**: the list is recomputed on every call, so a
//!    recovered condition disappears instead of sticking around as a stale alarm.
//!  - there is **no delivery**: nothing is emailed, paged or pushed. Alerts are
//!    reported through `get_status.alerts` and logged once when they *appear*.
//!  - the detail string carries the actual numbers, so a UI can show "12 rejected"
//!    rather than "the pool is having problems".

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How bad the condition is. Two levels on purpose: inventing more would imply a
/// grading policy nobody implemented.
///
/// Ordering is **not** derived: `#[derive(PartialOrd, Ord)]` would order by
/// declaration (`Warn < Error`) and silently put warnings *before* errors in the
/// report. Use [`Severity::rank`], where lower = shown first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Warn,
    Error,
}

impl Severity {
    pub fn label(self) -> &'static str {
        match self {
            Severity::Warn => "warn",
            Severity::Error => "error",
        }
    }

    /// Report order: **errors first** (0), warnings after (1).
    pub fn rank(self) -> u8 {
        match self {
            Severity::Error => 0,
            Severity::Warn => 1,
        }
    }
}

/// One rule's verdict for the current observations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveAlert {
    /// Stable machine id (the UI localizes it; logs and tests match on it).
    pub id: &'static str,
    pub severity: Severity,
    /// The numbers behind the alert — never a vague sentence.
    pub detail: String,
    /// Time since **this process** first saw this condition.
    pub active_for: Duration,
}

/// Everything the rules are allowed to look at. Each field is an already-reported,
/// already-documented number — this type is a *view*, not new instrumentation.
#[derive(Debug, Clone, Default)]
pub struct Observations {
    /// Breaker state label ("closed" | "open" | "half_open"), when reported.
    pub breaker_state: Option<String>,
    /// Pool rejections (saturated + timed out) since start.
    pub pool_rejections: u64,
    /// Bytes the log sink could not persist.
    pub log_lost_bytes: u64,
    /// Failed log write/flush/rotate attempts.
    pub log_write_failures: u64,
    /// A real engine was requested but the deterministic mock is serving.
    pub degraded: bool,
    /// The energy governor is currently throttling.
    pub throttled: bool,
    /// DVFS writes that failed.
    pub dvfs_failures: u64,
}

/// A rule: id + severity + the predicate/detail over [`Observations`].
struct Rule {
    id: &'static str,
    severity: Severity,
    /// `Some(detail)` when the condition currently holds.
    check: fn(&Observations) -> Option<String>,
}

const RULES: &[Rule] = &[
    Rule {
        id: "breaker_open",
        severity: Severity::Error,
        check: |o| match o.breaker_state.as_deref() {
            Some("open") => Some(
                "the circuit breaker is open: generations are being skipped without \
                 reaching the backend"
                    .to_string(),
            ),
            _ => None,
        },
    },
    Rule {
        id: "engine_degraded",
        severity: Severity::Warn,
        check: |o| {
            o.degraded.then(|| {
                "a real engine was requested but the deterministic mock is serving".to_string()
            })
        },
    },
    Rule {
        id: "log_trail_incomplete",
        severity: Severity::Error,
        check: |o| {
            (o.log_lost_bytes > 0 || o.log_write_failures > 0).then(|| {
                format!(
                    "the on-disk log trail is incomplete: {} byte(s) lost, {} failed write(s)",
                    o.log_lost_bytes, o.log_write_failures
                )
            })
        },
    },
    Rule {
        id: "generations_rejected",
        severity: Severity::Warn,
        check: |o| {
            (o.pool_rejections > 0).then(|| {
                format!(
                    "{} generation(s) were rejected by the admission gate since start",
                    o.pool_rejections
                )
            })
        },
    },
    Rule {
        id: "power_throttled",
        severity: Severity::Warn,
        check: |o| {
            o.throttled.then(|| {
                "the energy governor is throttling (thermal or battery pressure)".to_string()
            })
        },
    },
    Rule {
        id: "dvfs_write_failures",
        severity: Severity::Warn,
        check: |o| {
            (o.dvfs_failures > 0).then(|| format!("{} DVFS write(s) failed", o.dvfs_failures))
        },
    },
];

/// Evaluates the rule set and remembers when each condition was first seen.
///
/// Pure state (no clock, no I/O): the caller passes `now`, so the whole alerting
/// policy — including the "first seen" bookkeeping and the appear/clear transitions —
/// is unit-testable offline.
#[derive(Debug, Default)]
pub struct AlertTracker {
    /// First time this process saw each currently-active rule.
    first_seen: HashMap<&'static str, Instant>,
}

impl AlertTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Evaluate the rules against `obs`.
    ///
    /// Returns the active alerts ordered by severity (errors first) then id — a
    /// deterministic order so a UI list does not reshuffle between polls.
    pub fn evaluate(&mut self, obs: &Observations, now: Instant) -> Vec<ActiveAlert> {
        let mut active: Vec<ActiveAlert> = Vec::new();
        for rule in RULES {
            let Some(detail) = (rule.check)(obs) else {
                continue;
            };
            let since = *self.first_seen.entry(rule.id).or_insert(now);
            active.push(ActiveAlert {
                id: rule.id,
                severity: rule.severity,
                detail,
                active_for: now.saturating_duration_since(since),
            });
        }
        // Forget conditions that are gone: a later recurrence must not inherit the
        // old timestamp (that would claim a longer history than this process saw).
        let live: std::collections::HashSet<&'static str> = active.iter().map(|a| a.id).collect();
        self.first_seen.retain(|id, _| live.contains(id));
        active.sort_by(|a, b| {
            a.severity
                .rank()
                .cmp(&b.severity.rank())
                .then(a.id.cmp(b.id))
        });
        active
    }

    /// Ids that are active right now (used to log only *appearing* conditions).
    pub fn active_ids(&self) -> Vec<&'static str> {
        let mut ids: Vec<&'static str> = self.first_seen.keys().copied().collect();
        ids.sort_unstable();
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(id: &str, alerts: &[ActiveAlert]) -> bool {
        alerts
            .iter()
            .any(|a| a.id == id && a.severity == Severity::Error)
    }
    fn has(id: &str, alerts: &[ActiveAlert]) -> bool {
        alerts.iter().any(|a| a.id == id)
    }

    #[test]
    fn a_healthy_daemon_produces_no_alerts() {
        // The important one: if everything is fine we must say *nothing* — an
        // "all clear" object could be mistaken for a check we did not perform.
        let mut t = AlertTracker::new();
        let obs = Observations {
            breaker_state: Some("closed".into()),
            ..Default::default()
        };
        assert!(t.evaluate(&obs, Instant::now()).is_empty());
        assert!(t.active_ids().is_empty());
    }

    #[test]
    fn an_open_breaker_is_an_error_but_half_open_is_not_an_alarm() {
        let mut t = AlertTracker::new();
        let open = Observations {
            breaker_state: Some("open".into()),
            ..Default::default()
        };
        assert!(err("breaker_open", &t.evaluate(&open, Instant::now())));
        // Half-open is the recovery path, not a failure state.
        let probing = Observations {
            breaker_state: Some("half_open".into()),
            ..Default::default()
        };
        assert!(t
            .evaluate(&probing, Instant::now() + Duration::from_secs(1))
            .is_empty());
        // A daemon that never reports the breaker cannot alert on its state.
        let unknown = Observations::default();
        assert!(t.evaluate(&unknown, Instant::now()).is_empty());
    }

    #[test]
    fn details_carry_the_real_numbers() {
        let mut t = AlertTracker::new();
        let obs = Observations {
            log_lost_bytes: 128,
            log_write_failures: 3,
            pool_rejections: 12,
            dvfs_failures: 2,
            ..Default::default()
        };
        let alerts = t.evaluate(&obs, Instant::now());
        let by = |id: &str| alerts.iter().find(|a| a.id == id).map(|a| a.detail.clone());
        assert_eq!(
            by("log_trail_incomplete").as_deref(),
            Some("the on-disk log trail is incomplete: 128 byte(s) lost, 3 failed write(s)")
        );
        assert_eq!(
            by("generations_rejected").as_deref(),
            Some("12 generation(s) were rejected by the admission gate since start")
        );
        assert_eq!(
            by("dvfs_write_failures").as_deref(),
            Some("2 DVFS write(s) failed")
        );
    }

    #[test]
    fn errors_come_before_warnings_and_the_order_is_stable() {
        let mut t = AlertTracker::new();
        let obs = Observations {
            breaker_state: Some("open".into()),
            degraded: true,
            throttled: true,
            ..Default::default()
        };
        let alerts = t.evaluate(&obs, Instant::now());
        // Errors first — asserted on the *requirement*, not on a sorted copy of
        // itself (which would have passed even with warnings ordered first).
        let ranks: Vec<u8> = alerts.iter().map(|a| a.severity.rank()).collect();
        assert_eq!(ranks, vec![0, 1, 1], "errors first: {alerts:?}");
        assert_eq!(alerts[0].id, "breaker_open");
        assert_eq!(alerts[0].severity, Severity::Error);
        assert!(alerts[1..].iter().all(|a| a.severity == Severity::Warn));
        // Ties break by id, so two polls of the same state render identically.
        let again = t.evaluate(&obs, Instant::now() + Duration::from_secs(5));
        assert_eq!(
            alerts.iter().map(|a| a.id).collect::<Vec<_>>(),
            again.iter().map(|a| a.id).collect::<Vec<_>>()
        );
        assert_eq!(again[1].id, "engine_degraded");
        assert_eq!(again[2].id, "power_throttled");
    }

    #[test]
    fn active_for_starts_at_zero_and_grows_with_the_condition() {
        let mut t = AlertTracker::new();
        let t0 = Instant::now();
        let obs = Observations {
            degraded: true,
            ..Default::default()
        };
        let first = t.evaluate(&obs, t0);
        assert_eq!(first[0].active_for, Duration::ZERO);
        let later = t.evaluate(&obs, t0 + Duration::from_secs(42));
        assert_eq!(later[0].active_for, Duration::from_secs(42));
    }

    #[test]
    fn a_cleared_condition_disappears_and_a_recurrence_restarts_the_clock() {
        let mut t = AlertTracker::new();
        let t0 = Instant::now();
        let bad = Observations {
            degraded: true,
            ..Default::default()
        };
        assert!(has("engine_degraded", &t.evaluate(&bad, t0)));
        let good = Observations::default();
        assert!(t.evaluate(&good, t0 + Duration::from_secs(10)).is_empty());
        assert!(
            t.active_ids().is_empty(),
            "cleared conditions are forgotten"
        );
        // Comes back later: the clock restarts (we do not claim 100s of history).
        let back = t.evaluate(&bad, t0 + Duration::from_secs(100));
        assert_eq!(back[0].active_for, Duration::ZERO);
    }

    #[test]
    fn engine_degraded_and_power_throttled_are_warnings() {
        let mut t = AlertTracker::new();
        let obs = Observations {
            degraded: true,
            throttled: true,
            ..Default::default()
        };
        let alerts = t.evaluate(&obs, Instant::now());
        assert!(has("engine_degraded", &alerts));
        assert!(has("power_throttled", &alerts));
        assert!(alerts.iter().all(|a| a.severity == Severity::Warn));
    }
}
