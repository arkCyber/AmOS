//! Bridge `amos-ai`'s threshold alerts to `amos-notifier` (DAL-A).
//!
//! Why this is its own module: `amos-ai`'s [`alerts`] module is the
//! **source of truth** for "what is wrong right now" (a derived view over
//! the existing counters — the discipline of never inventing a number
//! carries forward here). The notifier is the **delivery path** — a webhook,
//! a SMTP relay, or stderr. Joining them is what makes a threshold breach
//! visible to an operator who is not looking at `get_status.alerts`.
//!
//! ## Honesty rules (same as `alerts.rs`)
//!
//! 1. **Never invent a delivery.** The sink is `Option`-typed: `None` means
//!    "no notifier is wired in" and the bridge silently no-ops, exactly like
//!    `alerts.rs` silently produces no alerts when the daemon is healthy.
//! 2. **One alert per state transition, not per poll.** Polling at 1 Hz that
//!    fires every second would page on every interval; the bridge tracks the
//!    active id set and only fires on **appear** / **disappear**.
//! 3. **Severity is the alert's, not the bridge's.** A `Warn` from
//!    `alerts.rs` becomes a P1 (notifier semantics); an `Error` becomes a P0.
//!    This mapping lives **only** in [`severity_to_p_level`], which returns
//!    the dependency-free [`PLevel`]; the `notifier_sink` adapter renders that
//!    level into the notifier's `Alert` instead of re-deriving it.
//!
//! ## Why a feature flag
//!
//! `amos-notifier` is a separate compile unit and we want the daemon's
//! default build (the one that ships to devices) to not gain a transitive
//! dependency just because the operator wants to page on threshold breaches.
//! `feature = "notifier"` keeps the dependency opt-in; without the feature,
//! the bridge compiles to a no-op `Option::None` and the daemon's tests do
//! not pull `amos-notifier`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::alerts::{ActiveAlert, Severity};

/// The sink the bridge fires alerts through. We define the trait here
/// rather than depending on `amos-notifier` at the type level — the
/// notifier's `Dispatcher` is one valid implementation; a test sink is
/// another. The bridge's only contract is "call this with an alert".
///
/// `Send + Sync` because the bridge is called from the status-poll loop
/// (which runs on a tokio task) and the operator may have moved the
/// dispatcher onto a worker thread.
pub trait AlertSink: Send + Sync + std::fmt::Debug {
    fn fire(&self, alert: Alert);
}

/// What the bridge actually fires. A value type, not `amos-notifier::Alert`,
/// because the bridge must compile without that dependency.
#[derive(Debug, Clone)]
pub struct Alert {
    pub severity: Severity,
    pub id: String,
    pub message: String,
}

impl Alert {
    fn from_active(a: &ActiveAlert) -> Self {
        let severity = a.severity;
        let id = format!("amos-ai.{}", a.id);
        let message = a.detail.clone();
        Self {
            severity,
            id,
            message,
        }
    }
}

/// The notifier's page level, as this dependency-free bridge represents it.
///
/// The bridge must compile without `amos-notifier` (see the module docs), so
/// it states the level as its own type; the adapter (`notifier_sink`, which
/// *does* depend on the notifier) renders the returned level into the
/// notifier's `Alert`. Only `P0` (Error) and `P1` (Warn) have bridge sources —
/// the notifier's own `P2` is never produced here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PLevel {
    P0,
    P1,
}

/// Map `amos-ai` severity to the notifier's page level. **The** mapping:
/// `Error → P0`, `Warn → P1` is stated here and nowhere else — the adapter
/// consumes the returned [`PLevel`] rather than re-deriving it, so the two
/// cannot drift apart.
pub fn severity_to_p_level(s: Severity) -> PLevel {
    match s {
        Severity::Error => PLevel::P0,
        Severity::Warn => PLevel::P1,
    }
}

/// The bridge state — a small per-id "was it active last poll?" table so we
/// fire on transitions, not on every observation.
///
/// The bookkeeping is intentionally simple: a map from the alert id to its
/// severity. The keys are the alert ids, not the messages, because an alert's
/// *condition* is what matters; if the same id re-fires with a different
/// detail (the numbers behind it changed), the operator wants the new number,
/// not a suppressed duplicate.
///
/// The **value** is the severity, and it exists solely for the clear path:
/// the "resolved" line must carry the severity of the alert that resolved
/// (rule 3), which means the severity has to survive from the poll that saw
/// the alert to the poll that sees it gone. A `HashSet<String>` dropped it,
/// and the clear path then had nothing to render but a hardcoded `Warn` — so
/// every `Error`/P0 incident was "resolved" as a P1.
#[derive(Debug, Default)]
pub struct AlertBridge {
    /// The severity each active id last carried. A re-poll while still active
    /// = no fire (the notifier's suppression window handles the cross-channel
    /// side).
    last_active: HashMap<String, Severity>,
    /// Optional sink — the bridge is a no-op when not wired.
    sink: Option<Arc<dyn AlertSink>>,
}

impl AlertBridge {
    /// A bridge with no sink (the default for the daemon's standalone build).
    pub fn new() -> Self {
        Self::default()
    }

    /// Attach a sink. The bridge will fire on every *transition* into and
    /// out of the active set; the sink is responsible for whatever delivery
    /// policy it wants (webhook, SMTP, stderr).
    pub fn with_sink(mut self, sink: Arc<dyn AlertSink>) -> Self {
        self.sink = Some(sink);
        self
    }

    /// Compare the current alert set to the previous one and fire on the
    /// transitions. Returns the number of alerts **actually fired**
    /// (newly appeared and cleared) — when the bridge has no sink
    /// attached, every transition is silently a no-op and the return is
    /// `0`, regardless of how many alerts are active.
    ///
    /// The bookkeeping (the `last_active` map) is kept in sync even when
    /// there is no sink, so attaching a sink later picks up immediately
    /// at the current state rather than re-firing everything that was
    /// already true.
    pub fn observe(&mut self, alerts: &[ActiveAlert]) -> usize {
        // The "now" map is what `alerts` reports; the comparison uses
        // `String` ids (the bridge's own format) rather than the `&'static str`
        // ids from `alerts.rs` so a future rename on either side does not
        // silently break the transition tracking. The severity rides along so
        // the clear path below can render it.
        let now: HashMap<String, Severity> = alerts
            .iter()
            .map(|a| (format!("amos-ai.{}", a.id), a.severity))
            .collect();

        let mut fired = 0;

        // Newly active — fire (only when a sink is attached).
        for a in alerts {
            let id = format!("amos-ai.{}", a.id);
            if !self.last_active.contains_key(&id) {
                if let Some(sink) = self.sink.as_ref() {
                    sink.fire(Alert::from_active(a));
                    fired += 1;
                }
                // If no sink, the bookkeeping still records the transition
                // so a later `with_sink` doesn't re-fire everything that
                // was already true. The `fired` counter stays at zero —
                // the test contract is "no sink = no fires counted".
            }
        }

        // Cleared — fire a "resolved" alert so the operator's timeline reads
        // "P0: daemon down at 12:01; resolved at 12:14" rather than "P0
        // still paged" forever. The line carries the **cleared alert's own
        // severity** (rule 3): a `P0` incident resolves as a `P0`, not as the
        // `P1` a hardcoded `Warn` would emit — a resolution at the wrong level
        // is what leaves a pager unacknowledged. The notifier's suppression
        // window collapses any redundant `P0 cleared` from the same id within
        // the window.
        for (prev, severity) in &self.last_active {
            if !now.contains_key(prev) {
                if let Some(sink) = self.sink.as_ref() {
                    sink.fire(Alert {
                        severity: *severity,
                        id: format!("{prev}.cleared"),
                        message: format!("the condition that drove alert '{prev}' has cleared"),
                    });
                    fired += 1;
                }
            }
        }

        self.last_active = now;
        // The book-keeping invariant: a transition is *fired* iff a sink
        // is attached. `fired > 0` implies `sink.is_some()`, but the converse
        // is not true (a stable set has zero transitions). The debug assert
        // is therefore a one-way check.
        debug_assert!(
            self.sink.is_some() || fired == 0,
            "no sink = no fires; got fired={fired}"
        );
        fired
    }

    /// The number of ids currently tracked as active (the size of the last
    /// observed set, modulo transition lag of one poll).
    pub fn active_count(&self) -> usize {
        self.last_active.len()
    }
}

/// How long the bridge has been observing before a transition fires.
///
/// `amos-ai`'s status poll runs on operator-controlled cadence (default
/// 1 s). The bridge has no clock of its own — the operator passes `now`
/// through the alerts (which carry `active_for`) and uses that to decide
/// whether to fire. This helper is here so a unit test (which has no
/// clock) does not have to invent one.
pub fn poll_interval_hint() -> Duration {
    Duration::from_secs(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A test sink that records every alert handed to it. Lets the join
    /// policy be tested without a real webhook/SMTP/anything.
    #[derive(Default, Debug)]
    struct Capture {
        fired: Mutex<Vec<Alert>>,
    }
    impl AlertSink for Capture {
        fn fire(&self, alert: Alert) {
            self.fired.lock().unwrap().push(alert);
        }
    }

    fn alert(id: &'static str, severity: Severity, detail: &str) -> ActiveAlert {
        ActiveAlert {
            id,
            severity,
            detail: detail.into(),
            active_for: Duration::from_secs(1),
        }
    }

    #[test]
    fn a_bridge_without_a_sink_never_fires_even_with_active_alerts() {
        let mut bridge = AlertBridge::new();
        let alerts = vec![alert("breaker_open", Severity::Error, "down")];
        // No sink attached ⇒ `observe` returns 0 (nothing fired). The
        // bookkeeping still tracks the active id set so a later `with_sink`
        // call (or just the `active_count` diagnostic) sees reality.
        assert_eq!(bridge.observe(&alerts), 0, "no sink = no fires");
    }

    #[test]
    fn a_newly_appearing_alert_fires_exactly_once() {
        let capture = Arc::new(Capture::default());
        let mut bridge = AlertBridge::new().with_sink(capture.clone());

        let alerts = vec![alert("breaker_open", Severity::Error, "open")];
        assert_eq!(bridge.observe(&alerts), 1, "appear fires once");

        // A re-poll with the same alert set must NOT re-fire (the notifier's
        // suppression window is for cross-channel; the bridge is the
        // single-fire gate).
        assert_eq!(bridge.observe(&alerts), 0, "stable state fires nothing");
        assert_eq!(
            capture.fired.lock().unwrap().len(),
            1,
            "only one fire for a stable alert"
        );
    }

    #[test]
    fn a_cleared_alert_fires_a_resolution() {
        let capture = Arc::new(Capture::default());
        let mut bridge = AlertBridge::new().with_sink(capture.clone());

        let bad = vec![alert("breaker_open", Severity::Error, "open")];
        bridge.observe(&bad);
        // Cleared.
        assert_eq!(bridge.observe(&[]), 1, "the clear fires once");
        let log = capture.fired.lock().unwrap();
        assert_eq!(log.len(), 2, "appear + clear");
        assert_eq!(log[0].id, "amos-ai.breaker_open");
        assert_eq!(log[1].id, "amos-ai.breaker_open.cleared");
        // The resolved line carries the **cleared alert's** severity (rule 3):
        // this alert was an `Error`/P0, so the resolution is a P0 too. The
        // prior assertion pinned `Warn` — which is exactly the defect: a P0
        // incident resolving as a P1 leaves the P0 page unacknowledged.
        assert_eq!(log[1].severity, Severity::Error);
    }

    #[test]
    fn a_cleared_warn_alert_resolves_as_warn_not_a_blanket_error() {
        // The other half of the table: the resolution's severity is the
        // cleared alert's, so a `Warn` resolves as a `Warn`. Without this a
        // "hardcode `Error`" fix would pass the P0 test above.
        let capture = Arc::new(Capture::default());
        let mut bridge = AlertBridge::new().with_sink(capture.clone());

        bridge.observe(&[alert("log_trail_incomplete", Severity::Warn, "lost")]);
        bridge.observe(&[]);
        let log = capture.fired.lock().unwrap();
        assert_eq!(log.len(), 2, "appear + clear");
        assert_eq!(log[1].id, "amos-ai.log_trail_incomplete.cleared");
        assert_eq!(log[1].severity, Severity::Warn);
    }

    #[test]
    fn two_alerts_of_different_severity_each_resolve_at_their_own_level() {
        // Per-id, not per-poll: clearing both at once must give each its own
        // severity rather than one level for the batch.
        let capture = Arc::new(Capture::default());
        let mut bridge = AlertBridge::new().with_sink(capture.clone());

        bridge.observe(&[
            alert("breaker_open", Severity::Error, "open"),
            alert("log_trail_incomplete", Severity::Warn, "lost"),
        ]);
        bridge.observe(&[]);
        let log = capture.fired.lock().unwrap();
        let cleared: Vec<_> = log
            .iter()
            .filter(|a| a.id.ends_with(".cleared"))
            .map(|a| (a.id.as_str(), a.severity))
            .collect();
        assert_eq!(cleared.len(), 2, "both clears fire");
        assert!(
            cleared.contains(&("amos-ai.breaker_open.cleared", Severity::Error)),
            "the Error alert resolves as Error, got {cleared:?}"
        );
        assert!(
            cleared.contains(&("amos-ai.log_trail_incomplete.cleared", Severity::Warn)),
            "the Warn alert resolves as Warn, got {cleared:?}"
        );
    }

    #[test]
    fn the_severity_mapping_is_p0_for_error_p1_for_warn() {
        assert_eq!(severity_to_p_level(Severity::Error), PLevel::P0);
        assert_eq!(severity_to_p_level(Severity::Warn), PLevel::P1);
    }

    #[test]
    fn changing_the_detail_does_not_cause_a_re_fire() {
        // Same id, different number (e.g. more log bytes lost). The bridge
        // does not re-fire; the next `get_status` already carries the
        // updated number, and the operator's view of the alert is "live".
        let capture = Arc::new(Capture::default());
        let mut bridge = AlertBridge::new().with_sink(capture.clone());

        bridge.observe(&[alert(
            "log_trail_incomplete",
            Severity::Error,
            "10 byte(s) lost",
        )]);
        bridge.observe(&[alert(
            "log_trail_incomplete",
            Severity::Error,
            "11 byte(s) lost",
        )]);
        bridge.observe(&[alert(
            "log_trail_incomplete",
            Severity::Error,
            "12 byte(s) lost",
        )]);
        assert_eq!(
            capture.fired.lock().unwrap().len(),
            1,
            "the same id does not re-fire on a detail change"
        );
    }

    #[test]
    fn multiple_independent_alerts_each_fire_once() {
        let capture = Arc::new(Capture::default());
        let mut bridge = AlertBridge::new().with_sink(capture.clone());

        bridge.observe(&[
            alert("breaker_open", Severity::Error, "open"),
            alert("log_trail_incomplete", Severity::Error, "lost"),
        ]);
        assert_eq!(
            capture.fired.lock().unwrap().len(),
            2,
            "two distinct ids = two fires"
        );
    }

    #[test]
    fn a_recurrence_after_a_clear_fires_again() {
        let capture = Arc::new(Capture::default());
        let mut bridge = AlertBridge::new().with_sink(capture.clone());

        bridge.observe(&[alert("breaker_open", Severity::Error, "open")]);
        bridge.observe(&[]);
        bridge.observe(&[alert("breaker_open", Severity::Error, "open")]);
        let log = capture.fired.lock().unwrap();
        assert_eq!(log.len(), 3, "appear + clear + appear = 3 fires");
        assert_eq!(log[0].id, "amos-ai.breaker_open");
        assert_eq!(log[1].id, "amos-ai.breaker_open.cleared");
        assert_eq!(log[2].id, "amos-ai.breaker_open");
    }

    #[test]
    fn a_bridge_compiles_in_a_clean_room() {
        // The `Default` impl must produce a bridge that compiles, even with
        // no `amos-notifier` dependency wired in. This is the smoke test
        // for the feature-flag discipline.
        let _b = AlertBridge::default();
        let _hint = poll_interval_hint();
    }
}
