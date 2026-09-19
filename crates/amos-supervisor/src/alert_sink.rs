//! `amos-supervisor` + `amos-notifier` integration.
//!
//! Aerospace standard: **NASA Power of 10 #7 — Check at all return points** +
//! **DO-178C §5.4.1 — Each safety-critical failure mode must produce a
//! visible, time-stamped record that can be retrieved post-flight.**
//!
//! This module wires the supervisor's crash/restart lifecycle into the
//! [`Dispatcher`] so an operator gets an honest P0/P1/P2 alert when a
//! supervised daemon exits unexpectedly, exhausts its restart budget, or
//! fails to spawn.
//!
//! ## Measured state (2026-09-19, REQ-A444)
//!
//! The seam is armed by `src/bin/amos-supervisor.rs` **when the `notifier` feature is on**.
//! Before that round `Supervisor::with_alert_sink` had no caller anywhere in the tree
//! (`rust-unwired-scan` reported it as "referenced nowhere"), so `alert_sink` stayed `None` and
//! `fire_alert` was dead in *both* feature configurations — while this module's own docs
//! asserted the notifier build "wires this in". The mapping (`DaemonAlert::from_status`) was
//! unit-tested; the wiring (monitor loop → `fire_alert` → sink) had no test at all, which is how
//! the seam rotted. It is now covered end to end by `tests/alert_wiring.rs`.
//!
//! ## Why this is its own trait
//!
//! 1. The supervisor must remain `std::env`-free in its core (it already
//!    has a `TimesyncConfig::from_env`, gated by feature flag). Wiring
//!    the notifier should not force `amos-notifier` on every consumer.
//! 2. The wiring is a **fire-and-forget** alert — it must never block the
//!    monitor loop, and it must never panic if the dispatcher rejects the
//!    alert (e.g. suppression window).
//! 3. The same wiring applies to all three of: crash, restart-exhausted,
//!    spawn-failed. A single function with a known severity is what makes
//!    the alert honest (one type per failure mode, not "OOM" for everything).

use crate::DaemonStatus;
use std::sync::Arc;

/// Severity used for one alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertSeverity {
    /// P0 — wake someone up. Used for crash-exhaustion and spawn failures.
    P0,
    /// P1 — same-day response. Used for any single unexpected exit.
    P1,
    /// P2 — business-hours response. Used for explicit operator restart.
    P2,
}

impl AlertSeverity {
    /// Wire label.
    pub fn label(self) -> &'static str {
        match self {
            AlertSeverity::P0 => "P0",
            AlertSeverity::P1 => "P1",
            AlertSeverity::P2 => "P2",
        }
    }
}

/// One fire-and-forget alert to send to the notifier. The `From<&DaemonStatus>`
/// impl is the **single mapping** from a supervisor state to an alert — every
/// wire-up uses it, so a "P1 for crash" decision is made in one place.
#[derive(Debug, Clone)]
pub struct DaemonAlert {
    /// Stable id (e.g. `"daemon.amos-ai.crashed"`). Two alerts with the same id
    /// inside the suppression window are merged — so a daemon flapping five
    /// times in five minutes shows as "5× in 5 min", not five lines.
    pub id: String,
    pub severity: AlertSeverity,
    pub message: String,
    /// Optional labels (host, restart attempt count, …) the notifier attaches.
    pub labels: Vec<(String, String)>,
}

impl DaemonAlert {
    /// Convert to an `amos_notifier::Alert`. The conversion is infallible —
    /// `DaemonAlert` is the supervisor-side mirror of the notifier value type,
    /// kept dependency-free so `amos-supervisor` does not have to import
    /// `amos-notifier` in its core.
    #[cfg(feature = "notifier")]
    pub fn into_notifier_alert(self) -> amos_notifier::Alert {
        let mut alert = match self.severity {
            AlertSeverity::P0 => amos_notifier::Alert::p0(&self.id, &self.message),
            AlertSeverity::P1 => amos_notifier::Alert::p1(&self.id, &self.message),
            AlertSeverity::P2 => amos_notifier::Alert::p2(&self.id, &self.message),
        };
        for (k, v) in self.labels {
            alert = alert.with_label(k, v);
        }
        alert
    }
}

impl DaemonAlert {
    /// Map a supervisor status to the alert that should fire on entry. Returns
    /// `None` for states that do not warrant an alert (running / starting /
    /// stopped-by-operator).
    pub fn from_status(daemon: &str, status: &DaemonStatus) -> Option<Self> {
        match status {
            DaemonStatus::Running | DaemonStatus::Starting | DaemonStatus::Stopped => None,
            DaemonStatus::Restarting { attempt } => Some(Self {
                id: format!("daemon.{daemon}.crashed"),
                severity: AlertSeverity::P1,
                message: format!("daemon '{daemon}' exited unexpectedly; restart {attempt}"),
                labels: vec![
                    ("daemon".into(), daemon.into()),
                    ("attempt".into(), attempt.to_string()),
                ],
            }),
            DaemonStatus::Crashed { restarts } => Some(Self {
                id: format!("daemon.{daemon}.crash_exhausted"),
                severity: AlertSeverity::P0,
                message: format!(
                    "daemon '{daemon}' crashed and exhausted {restarts} restart(s); supervisor gave up"
                ),
                labels: vec![
                    ("daemon".into(), daemon.into()),
                    ("restarts".into(), restarts.to_string()),
                ],
            }),
        }
    }
}

/// A **dispatcher** in the sense "the thing the supervisor calls when something
/// happened". The supervisor itself does not depend on `amos-notifier`; it calls
/// this trait, and the binary wires the real `Dispatcher` into the implementation.
///
/// All methods are non-blocking and infallible. The supervisor's monitor loop
/// must not be delayed by an alert that the operator's webhook can't reach —
/// the alert is best-effort, like every other observability surface.
pub trait AlertSink: Send + Sync {
    /// Fire one alert. The implementation may choose to drop, coalesce or
    /// fan-out; the supervisor does not need to know.
    fn fire(&self, alert: DaemonAlert);
}

/// A no-op sink for tests / environments without a dispatcher.
#[derive(Debug, Default, Clone, Copy)]
pub struct NullSink;

impl AlertSink for NullSink {
    fn fire(&self, _alert: DaemonAlert) {
        // deliberately no-op
    }
}

/// A shared, thread-safe sink the monitor loop can call.
pub type SharedSink = Arc<dyn AlertSink>;

/// Create a `SharedSink` wrapping any concrete `AlertSink`.
pub fn shared<S: AlertSink + 'static>(sink: S) -> SharedSink {
    Arc::new(sink)
}

/// The notifier-backed implementation. `src/bin/amos-supervisor.rs` arms it when the
/// `notifier` feature is on (`Supervisor::with_alert_sink`), with the dispatcher's stderr
/// fallback enabled; a build without the feature has **no sink at all** (`None`) and says so at
/// startup. Which sink a build got is *stated*, not implied (REQ-A444).
#[cfg(feature = "notifier")]
pub struct NotifierSink {
    dispatcher: amos_notifier::Dispatcher,
}

#[cfg(feature = "notifier")]
impl NotifierSink {
    /// Wrap an existing dispatcher.
    pub fn new(dispatcher: amos_notifier::Dispatcher) -> Self {
        Self { dispatcher }
    }
}

#[cfg(feature = "notifier")]
impl AlertSink for NotifierSink {
    fn fire(&self, alert: DaemonAlert) {
        // The supervisor only ever feeds valid `DaemonAlert`s; the conversion is
        // infallible. If the dispatcher fails (which it must not — the notifier
        // has a stderr fallback), the supervisor's monitor loop is unaffected.
        self.dispatcher.fire(alert.into_notifier_alert());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_alert_id_and_severity(a: &DaemonAlert, id: &str, sev: AlertSeverity) {
        assert_eq!(a.id, id);
        assert_eq!(a.severity, sev);
        assert!(
            a.labels
                .iter()
                .any(|(k, v)| k == "daemon" && v == "amos-ai"),
            "label daemon=amos-ai must be present"
        );
    }

    #[test]
    fn running_state_is_silent() {
        assert!(DaemonAlert::from_status("amos-ai", &DaemonStatus::Running).is_none());
    }

    #[test]
    fn starting_state_is_silent() {
        assert!(DaemonAlert::from_status("amos-ai", &DaemonStatus::Starting).is_none());
    }

    #[test]
    fn stopped_state_is_silent() {
        assert!(DaemonAlert::from_status("amos-ai", &DaemonStatus::Stopped).is_none());
    }

    #[test]
    fn restarting_state_is_a_p1_with_the_attempt_count() {
        let a = DaemonAlert::from_status("amos-ai", &DaemonStatus::Restarting { attempt: 3 })
            .expect("a P1 alert");
        assert_alert_id_and_severity(&a, "daemon.amos-ai.crashed", AlertSeverity::P1);
        assert_eq!(
            a.labels.iter().find(|(k, _)| k == "attempt").unwrap().1,
            "3"
        );
    }

    #[test]
    fn crashed_state_is_a_p0_with_the_total_restart_count() {
        let a = DaemonAlert::from_status("amos-ai", &DaemonStatus::Crashed { restarts: 5 })
            .expect("a P0 alert");
        assert_alert_id_and_severity(&a, "daemon.amos-ai.crash_exhausted", AlertSeverity::P0);
        assert_eq!(
            a.labels.iter().find(|(k, _)| k == "restarts").unwrap().1,
            "5"
        );
    }

    #[test]
    fn null_sink_drops_alerts_silently() {
        // The test: no panic, no observable side-effect. The supervisor's monitor
        // loop calls `fire` on every crash; a sink that always succeeds is the
        // baseline guarantee.
        let sink = NullSink;
        sink.fire(DaemonAlert {
            id: "daemon.x.crashed".into(),
            severity: AlertSeverity::P1,
            message: "test".into(),
            labels: vec![],
        });
    }
}
