//! End-to-end test for the `alerts` + `notifier_bridge` chain.
//!
//! This file is the integration counterpart to the unit tests in
//! `alerts.rs` and `notifier_bridge.rs`. The unit tests verify the
//! `AlertTracker` and the `AlertBridge` separately; here we wire them
//! together the way the daemon does on its status-poll loop and check
//! the **combined** behavior:
//!
//! * `alerts::evaluate` produces a derived list (no inventions);
//! * `notifier_bridge::observe` only fires on **transitions**;
//! * a real `Severity::Error` becomes a `P0`;
//! * a real `Severity::Warn` becomes a `P1`;
//! * a "recurrence after clear" goes through appear → clear → appear
//!   instead of being suppressed by the notifier's window.
//!
//! The test uses a `Capture` sink from `notifier_bridge::tests`'s playbook
//! so it does not need `amos-notifier` (this file is part of the daemon's
//! default build, where `notifier` is off).
//!
//! This is a sibling test, not the feature-gated `notifier_sink` path —
//! see `notifier_sink::tests::the_bridge_severity_to_p0_p1_mapping_*`
//! for the wiring through `amos-notifier`.

use std::sync::Mutex;

use amos_ai::alerts::{ActiveAlert, AlertTracker, Observations, Severity};
use amos_ai::notifier_bridge::{Alert, AlertBridge, AlertSink, severity_to_p_level};

#[derive(Default, Debug)]
struct Capture {
    fired: Mutex<Vec<Alert>>,
}

impl AlertSink for Capture {
    fn fire(&self, alert: Alert) {
        self.fired.lock().unwrap().push(alert);
    }
}

/// Drive the chain by hand: take an `Observations` snapshot, run
/// `AlertTracker::evaluate`, hand the active alerts to `AlertBridge::observe`.
/// This is the exact shape the status-poll loop will use.
fn poll(tracker: &mut AlertTracker, bridge: &mut AlertBridge, obs: &Observations) {
    let alerts = tracker.evaluate(obs, std::time::Instant::now());
    let _ = bridge.observe(&alerts);
}

#[test]
fn a_healthy_daemon_produces_no_fires_through_the_bridge() {
    let mut tracker = AlertTracker::new();
    let capture = std::sync::Arc::new(Capture::default());
    let mut bridge = AlertBridge::new().with_sink(capture.clone());

    // 10 polls, every one with a healthy snapshot. The tracker stays
    // empty, the bridge stays silent — the notifier never gets a page.
    let obs = Observations {
        breaker_state: Some("closed".into()),
        ..Default::default()
    };
    for _ in 0..10 {
        poll(&mut tracker, &mut bridge, &obs);
    }
    assert!(capture.fired.lock().unwrap().is_empty());
}

#[test]
fn the_open_breaker_paging_chain_emits_one_p0_on_appear() {
    let mut tracker = AlertTracker::new();
    let capture = std::sync::Arc::new(Capture::default());
    let mut bridge = AlertBridge::new().with_sink(capture.clone());

    // Healthy first poll: nothing.
    poll(
        &mut tracker,
        &mut bridge,
        &Observations {
            breaker_state: Some("closed".into()),
            ..Default::default()
        },
    );
    // The breaker trips: tracker reports `breaker_open` (Error).
    // Bridge: it's an appear ⇒ one P0 fires.
    poll(
        &mut tracker,
        &mut bridge,
        &Observations {
            breaker_state: Some("open".into()),
            ..Default::default()
        },
    );
    let log = capture.fired.lock().unwrap();
    assert_eq!(log.len(), 1, "open breaker → one P0");
    assert_eq!(log[0].id, "amos-ai.breaker_open");
    assert_eq!(log[0].severity, Severity::Error);
    assert_eq!(severity_to_p_level(log[0].severity), "P0");
}

#[test]
fn a_recovered_breaker_fires_a_resolution_alert() {
    let mut tracker = AlertTracker::new();
    let capture = std::sync::Arc::new(Capture::default());
    let mut bridge = AlertBridge::new().with_sink(capture.clone());

    // Open.
    poll(
        &mut tracker,
        &mut bridge,
        &Observations {
            breaker_state: Some("open".into()),
            ..Default::default()
        },
    );
    // Stay open for a few polls — no re-fires (the notifier's suppression
    // window is the cross-channel side; the bridge is the single-fire gate).
    for _ in 0..3 {
        poll(
            &mut tracker,
            &mut bridge,
            &Observations {
                breaker_state: Some("open".into()),
                ..Default::default()
            },
        );
    }
    // Closed again: a `breaker_open.cleared` fires so the operator's
    // timeline reads "P0 at 12:01 → resolved at 12:14".
    poll(
        &mut tracker,
        &mut bridge,
        &Observations {
            breaker_state: Some("closed".into()),
            ..Default::default()
        },
    );

    let log = capture.fired.lock().unwrap();
    assert_eq!(log.len(), 2, "appear + clear, no re-fires on stable state");
    assert_eq!(log[0].id, "amos-ai.breaker_open");
    assert_eq!(log[0].severity, Severity::Error);
    assert_eq!(log[1].id, "amos-ai.breaker_open.cleared");
    assert_eq!(log[1].severity, Severity::Warn);
}

#[test]
fn multiple_independent_breaches_each_page_once() {
    let mut tracker = AlertTracker::new();
    let capture = std::sync::Arc::new(Capture::default());
    let mut bridge = AlertBridge::new().with_sink(capture.clone());

    // Two independent breaches in one snapshot:
    //   * breaker open (Error → P0)
    //   * log trail incomplete (Error → P0)
    // Both should page once on appearance.
    poll(
        &mut tracker,
        &mut bridge,
        &Observations {
            breaker_state: Some("open".into()),
            log_lost_bytes: 17,
            log_write_failures: 1,
            ..Default::default()
        },
    );

    let log = capture.fired.lock().unwrap();
    assert_eq!(log.len(), 2, "two distinct ids = two P0 pages");
    let mut ids: Vec<&str> = log.iter().map(|a| a.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, vec!["amos-ai.breaker_open", "amos-ai.log_trail_incomplete"]);
    for a in log.iter() {
        assert_eq!(severity_to_p_level(a.severity), "P0");
    }
}

#[test]
fn mixed_severity_breaches_each_go_to_their_own_p_level() {
    let mut tracker = AlertTracker::new();
    let capture = std::sync::Arc::new(Capture::default());
    let mut bridge = AlertBridge::new().with_sink(capture.clone());

    // Error + Warn in one snapshot: two fires, two distinct P-levels.
    poll(
        &mut tracker,
        &mut bridge,
        &Observations {
            breaker_state: Some("open".into()),         // Error → P0
            degraded: true,                            // Warn → P1
            ..Default::default()
        },
    );

    let log = capture.fired.lock().unwrap();
    assert_eq!(log.len(), 2);
    let by_id = |id: &str| log.iter().find(|a| a.id == id).cloned();
    let breaker = by_id("amos-ai.breaker_open").unwrap();
    let degraded = by_id("amos-ai.engine_degraded").unwrap();
    assert_eq!(severity_to_p_level(breaker.severity), "P0");
    assert_eq!(severity_to_p_level(degraded.severity), "P1");
}

#[test]
fn a_recurrence_after_clear_p_ages_again() {
    let mut tracker = AlertTracker::new();
    let capture = std::sync::Arc::new(Capture::default());
    let mut bridge = AlertBridge::new().with_sink(capture.clone());

    // Open, closed, open again. The third open is a new transition, not a
    // re-fire of the first P0.
    let open = Observations {
        breaker_state: Some("open".into()),
        ..Default::default()
    };
    let closed = Observations {
        breaker_state: Some("closed".into()),
        ..Default::default()
    };
    poll(&mut tracker, &mut bridge, &open);
    poll(&mut tracker, &mut bridge, &closed);
    poll(&mut tracker, &mut bridge, &open);

    let log = capture.fired.lock().unwrap();
    assert_eq!(
        log.len(),
        3,
        "appear + clear + appear = three fires (no suppression across clear)"
    );
    assert_eq!(log[0].id, "amos-ai.breaker_open");
    assert_eq!(log[1].id, "amos-ai.breaker_open.cleared");
    assert_eq!(log[2].id, "amos-ai.breaker_open");
}

#[test]
fn the_active_alert_carries_the_real_numbers_in_its_detail() {
    // The bridge fires whatever `ActiveAlert::detail` already carries; this
    // test pins that contract so a future change to `alerts.rs` does not
    // silently degrade the operator-visible string.
    let mut tracker = AlertTracker::new();
    let capture = std::sync::Arc::new(Capture::default());
    let mut bridge = AlertBridge::new().with_sink(capture.clone());

    poll(
        &mut tracker,
        &mut bridge,
        &Observations {
            log_lost_bytes: 999,
            log_write_failures: 7,
            ..Default::default()
        },
    );
    let log = capture.fired.lock().unwrap();
    assert_eq!(log.len(), 1);
    assert!(
        log[0].message.contains("999"),
        "detail must carry the real number, not a vague sentence"
    );
    assert!(log[0].message.contains("7"));
}

/// Direct API smoke that does not need the daemon's full state — proves
/// the bridge can be constructed empty and evolve into a useful thing.
#[test]
fn the_bridge_is_useful_with_zero_alerts() {
    let mut bridge = AlertBridge::default();
    let alerts: Vec<ActiveAlert> = Vec::new();
    assert_eq!(bridge.observe(&alerts), 0, "empty in, empty out");
    assert_eq!(bridge.active_count(), 0);
}
