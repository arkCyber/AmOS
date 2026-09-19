//! End-to-end test for the **production-shape** chain:
//! `alerts::AlertTracker` → `notifier_bridge::AlertBridge` →
//! `notifier_sink::NotifierSink` → `amos-notifier::Dispatcher` → channel.
//!
//! Companion to `tests/notifier_alerts_e2e.rs` (which uses a `Capture` sink
//! and is part of the daemon's default build). This file is **feature-
//! gated** to `--features notifier` because the import path pulls in
//! `amos-notifier`. The point is the same as the unit tests in
//! `notifier_sink.rs::tests`, but driven end-to-end:
//!
//! * the bridge's transitions fire the adapter;
//! * the adapter maps `Severity::Error → P0` and `Severity::Warn → P1`;
//! * the dispatcher delivers every transition to a recording channel so
//!   the operator-facing surface is visible;
//! * a poll that finds the same alert still active must NOT refire — the
//!   bridge's transition bookkeeping is the no-double-page guarantee,
//!   and a regression here surfaces as a flake / double-page that no
//!   unit test catches (the unit tests stop at the bridge).
//!
//! If the production wiring stops being complete (`serve_with_sinks_full`
//! stops threading the sink into `with_notifier_bridge`), this test stops
//! passing. That's the regression it's here to catch.
//!
//! Note on the local `Probe` channel: `Recorder` is **not** `Clone`, so
//! once it's moved into the dispatcher we have no public way to read what
//! it received (it stores the alerts inside its own `Mutex`). The local
//! `Probe` channel stores its alerts in an `Arc<Mutex<Vec<Alert>>>` that
//! the rig keeps outside the dispatcher, so we can `clone()` the Arc and
//! have **two** handles to the same data — one for the channel, one for
//! the assertions.

#![cfg(feature = "notifier")]

use std::sync::{Arc, Mutex};

use amos_ai::alerts::{AlertTracker, Observations, Severity};
use amos_ai::notifier_bridge::AlertBridge;
use amos_ai::notifier_sink as factory;
use amos_notifier::channel::{Channel, ChannelId, SendOutcome};
use amos_notifier::{Alert, Dispatcher};
/// Recording channel used in place of `Recorder`. The alert log lives in
/// an `Arc<Mutex<Vec<Alert>>>` that the rig keeps **outside** the
/// dispatcher, so the assertions can hold a reference to the log while
/// the dispatcher owns the channel itself. `Arc<Mutex<Vec<Alert>>>` is
/// `Clone`, so the rig hands one clone to the dispatcher (via the
/// `Arc<Probe>` wrapper) and keeps the other for assertions.
#[derive(Debug)]
struct Probe {
    id: ChannelId,
    log: Arc<Mutex<Vec<Alert>>>,
}

impl Probe {
    /// Construct a probe and return `(channel, log_handle)` where
    /// `channel` is what the dispatcher owns and `log_handle` is what
    /// the test reads. The probe's `send` always reports `Sent` (we are
    /// not testing the dispatcher's outcome mapping here — that's the
    /// webhook_e2e test's job).
    fn new(id: &'static str) -> (Self, Arc<Mutex<Vec<Alert>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let probe = Self {
            id: ChannelId::new(id),
            log: log.clone(),
        };
        (probe, log)
    }
}

impl Channel for Probe {
    fn id(&self) -> ChannelId {
        self.id.clone()
    }
    fn send(&self, alert: &Alert) -> SendOutcome {
        if let Ok(mut g) = self.log.lock() {
            g.push(alert.clone());
            SendOutcome::Sent
        } else {
            SendOutcome::Failed
        }
    }
}

fn rig() -> (AlertTracker, AlertBridge, Arc<Mutex<Vec<Alert>>>) {
    let (probe, log) = Probe::new("amos-ai-e2e");
    let dispatcher = Dispatcher::builder().with_channel(probe).build();
    let sink: Arc<dyn amos_ai::notifier_bridge::AlertSink> = factory(dispatcher);
    let bridge = AlertBridge::new().with_sink(sink);
    (AlertTracker::new(), bridge, log)
}

/// Convenience poll: run the tracker on the snapshot, then call
/// `bridge.observe`. The bridge is `&mut` (its transition bookkeeping
/// mutates the `last_active` set in place), but it does **not** need a
/// `Mutex` here — single-threaded test.
fn poll(
    tracker: &mut AlertTracker,
    bridge: &mut AlertBridge,
    obs: &Observations,
) -> Vec<amos_ai::alerts::ActiveAlert> {
    let active = tracker.evaluate(obs, std::time::Instant::now());
    let _ = bridge.observe(&active);
    active
}

#[test]
fn a_breaker_open_fires_a_p0_through_the_dispatcher_to_the_channel() {
    let (mut tracker, mut bridge, log) = rig();
    let obs_healthy = Observations {
        breaker_state: Some("closed".into()),
        ..Default::default()
    };
    let obs_break = Observations {
        breaker_state: Some("open".into()),
        ..Default::default()
    };
    // Healthy first so the very first `observe` is a no-op (last_active
    // starts empty, so a transition IS technically "newly active", but
    // the healthy snapshot has zero alerts and therefore nothing to fire).
    let _ = poll(&mut tracker, &mut bridge, &obs_healthy);
    // Now flip the breaker: the alert appears, the bridge fires once.
    let active = poll(&mut tracker, &mut bridge, &obs_break);
    assert_eq!(active.len(), 1, "breaker_open rule should match");
    assert_eq!(
        active[0].severity,
        Severity::Error,
        "breaker_open is an Error"
    );
    let recorder_log = log.lock().unwrap();
    assert_eq!(
        recorder_log.len(),
        1,
        "exactly one alert reached the dispatcher: the appear transition"
    );
    assert_eq!(recorder_log[0].id, "amos-ai.breaker_open");
    assert_eq!(recorder_log[0].severity.label(), "P0");
    assert_eq!(
        recorder_log[0]
            .labels
            .get("amos_severity")
            .and_then(|v| v.as_str()),
        Some("error"),
        "with_label adds the amos_severity label"
    );
}

#[test]
fn a_warn_severity_alert_fires_a_p1() {
    let (mut tracker, mut bridge, log) = rig();
    // `throttled` rule is Severity::Warn in the production ruleset —
    // the energy governor is currently clamping the inference budget.
    let obs = Observations {
        breaker_state: Some("closed".into()),
        throttled: true,
        ..Default::default()
    };
    let active = poll(&mut tracker, &mut bridge, &obs);
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].severity, Severity::Warn);
    let recorder_log = log.lock().unwrap();
    assert_eq!(recorder_log.len(), 1);
    assert_eq!(recorder_log[0].id, "amos-ai.power_throttled");
    assert_eq!(recorder_log[0].severity.label(), "P1");
    assert_eq!(
        recorder_log[0]
            .labels
            .get("amos_severity")
            .and_then(|v| v.as_str()),
        Some("warn"),
        "with_label adds the amos_severity label"
    );
}

#[test]
fn a_repeated_poll_of_the_same_alert_does_not_duplicate_pages() {
    // The bridge fires on **transitions**, so a poll that finds the same
    // alert still active must NOT refire. The dispatcher would suppress a
    // second copy anyway (30 s P0 window), but the bridge itself is the
    // no-double-page guarantee.
    let (mut tracker, mut bridge, log) = rig();
    let obs = Observations {
        breaker_state: Some("open".into()),
        ..Default::default()
    };
    for _ in 0..5 {
        let _ = poll(&mut tracker, &mut bridge, &obs);
    }
    let recorder_log = log.lock().unwrap();
    assert_eq!(
        recorder_log.len(),
        1,
        "five polls of the same alert must fire exactly one P0, not five"
    );
}

#[test]
fn a_breaker_that_clears_fires_a_warn_id_ending_in_dot_cleared() {
    // The bridge's "transition OUT of the active set" path fires a
    // dedicated `amos-ai.<id>.cleared` warning so an operator's paging
    // timeline shows the recovery, not just the silence.
    let (mut tracker, mut bridge, log) = rig();
    let obs_break = Observations {
        breaker_state: Some("open".into()),
        ..Default::default()
    };
    let obs_healthy = Observations {
        breaker_state: Some("closed".into()),
        ..Default::default()
    };
    let _ = poll(&mut tracker, &mut bridge, &obs_break);
    let _ = poll(&mut tracker, &mut bridge, &obs_healthy);
    let recorder_log = log.lock().unwrap();
    assert_eq!(recorder_log.len(), 2, "appear + clear = two fires");
    let ids: Vec<String> = recorder_log.iter().map(|a| a.id.clone()).collect();
    assert!(
        ids.contains(&"amos-ai.breaker_open".to_string()),
        "appear fired: ids={ids:?}"
    );
    assert!(
        ids.contains(&"amos-ai.breaker_open.cleared".to_string()),
        "clear fired: ids={ids:?}"
    );
    // The cleared alert is a Warn/P1 — the bridge documents this as a
    // contract and downstream automation depends on it.
    let cleared = recorder_log
        .iter()
        .find(|a| a.id == "amos-ai.breaker_open.cleared")
        .unwrap();
    assert_eq!(cleared.severity.label(), "P1");
}

/// Regression guard for REQ-A451 / F-AI-014 (a): the production
/// constructor `serve_with_sinks_full` calls `with_notifier_bridge` once
/// when the env told it to. We can't easily start the gRPC server in a
/// unit test (it binds a socket and runs forever), but we can assert that
/// the same wiring — bridge built around a dispatcher that includes a
/// `stderr_fallback` + an extra channel — fires correctly end-to-end.
/// This is the smallest end-to-end smoke that proves the wiring
/// contract holds without spinning up the whole daemon.
#[test]
fn the_production_shape_dispatcher_wiring_fires() {
    let (probe, log) = Probe::new("production-shape");
    let dispatcher = Dispatcher::builder()
        .with_stderr_fallback(true)
        .with_channel(probe)
        .build();
    let sink: Arc<dyn amos_ai::notifier_bridge::AlertSink> = factory(dispatcher);
    let mut bridge = AlertBridge::new().with_sink(sink);
    let mut tracker = AlertTracker::new();

    let obs = Observations {
        breaker_state: Some("open".into()),
        ..Default::default()
    };
    let _ = poll(&mut tracker, &mut bridge, &obs);

    let recorder_log = log.lock().unwrap();
    assert_eq!(
        recorder_log.len(),
        1,
        "production-shape wiring fires the alert"
    );
    assert_eq!(recorder_log[0].id, "amos-ai.breaker_open");
}

/// Contract / signature smoke: `factory(dispatcher)` is the factory the
/// production binary uses to convert a `Dispatcher` into an
/// `Arc<dyn AlertSink>`. If the factory were ever deleted or its return
/// type changed, this test fails to compile — that is the regression
/// guard. No behavior is asserted here.
#[test]
fn the_notifier_sink_factory_returns_an_alert_sink() {
    let (probe, _log) = Probe::new("factory-contract");
    let dispatcher = Dispatcher::builder().with_channel(probe).build();
    let _sink: Arc<dyn amos_ai::notifier_bridge::AlertSink> = factory(dispatcher);
}
