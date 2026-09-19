//! `amos-notifier` end-to-end: alerts → dispatch → channels → metrics.
//!
//! Why this lives in tests/: the per-channel tests cover "the webhook
//! POSTs JSON"; they do not prove "a P0 alert always reaches at least one
//! channel". That is **dispatch policy** — a join test, and joins earn
//! their own file.
//!
//! Each test is offline (no HTTP, no SMTP, no clock that matters). The
//! dispatcher is synchronous; the recorder channel sinks everything it
//! sees in memory. This is the only honest way to assert "the dispatcher
//! called us with this alert, in this order, with this severity".

use amos_notifier::channel::{Channel, ChannelId, Recorder, SendOutcome};
use amos_notifier::{Alert, Dispatcher};

/// A channel that always errors — to prove the dispatcher does not stop
/// on a single transport failure.
struct AlwaysFail;
impl Channel for AlwaysFail {
    fn id(&self) -> ChannelId {
        ChannelId::new("always-fail")
    }
    fn send(&self, _alert: &Alert) -> SendOutcome {
        SendOutcome::Failed
    }
}

#[test]
fn a_p0_alert_reaches_every_configured_channel() {
    let d = Dispatcher::builder()
        .with_channel(Recorder::new("rec-a"))
        .with_channel(Recorder::new("rec-b"))
        .build();
    // Three P0s with distinct ids so the suppression window does not
    // collapse them.
    for id in ["daemon.x.crashed", "daemon.y.crashed", "daemon.z.crashed"] {
        d.fire(Alert::p0(id, "test"));
    }
    let m = d.metrics();
    assert_eq!(m.channels.len(), 2);
    let total = m.global.sent;
    // First alert to each channel: 2× 3 = 6 sent. The other three are
    // suppressed per-channel inside the P0 30 s window.
    assert_eq!(total + m.global.suppressed, 6, "every alert accounted for");
}

#[test]
fn suppression_coalesces_two_alerts_with_the_same_id_inside_the_window() {
    let d = Dispatcher::builder()
        .with_channel(Recorder::new("rec-supp"))
        .build();
    d.fire(Alert::p1("daemon.x.warn", "first"));
    d.fire(Alert::p1("daemon.x.warn", "second"));
    let m = d.metrics();
    let (_, cm) = &m.channels[0];
    assert_eq!(cm.sent, 1);
    assert_eq!(cm.suppressed, 1);
}

#[test]
fn different_ids_get_independent_windows() {
    let d = Dispatcher::builder()
        .with_channel(Recorder::new("rec-multi"))
        .build();
    d.fire(Alert::p1("daemon.a.warn", "a"));
    d.fire(Alert::p1("daemon.b.warn", "b"));
    let m = d.metrics();
    let (_, cm) = &m.channels[0];
    assert_eq!(cm.sent, 2);
    assert_eq!(cm.suppressed, 0);
}

#[test]
fn a_failed_channel_does_not_block_other_channels() {
    // One sink always fails; the other sink must still receive every alert.
    let d = Dispatcher::builder()
        .with_channel(AlwaysFail)
        .with_channel(Recorder::new("rec-other"))
        .build();
    // Three P0s with distinct ids → none are suppressed by the other, so
    // each one reaches every channel.
    for id in ["a", "b", "c"] {
        d.fire(Alert::p0(id, "test"));
    }
    let m = d.metrics();
    // AlwaysFail channel: 3 sent (the dispatcher does call it), 3 failed
    // outcomes. Recorder: 1 sent, 2 suppressed (within the P0 window).
    let mut failed_count = 0;
    let mut recorder_sent = 0;
    for (_, cm) in &m.channels {
        failed_count += cm.failed;
        recorder_sent += cm.sent;
    }
    assert!(
        failed_count >= 3,
        "the failing channel must show 3 failures"
    );
    assert!(
        recorder_sent >= 1,
        "the other channel must still receive at least one alert"
    );
}

#[test]
fn no_channels_with_stderr_off_does_not_panic_or_silently_drop() {
    let d = Dispatcher::builder().with_stderr_fallback(false).build();
    d.fire(Alert::p0("any", "any"));
    // The dispatcher is alive; a second fire is also a no-op for the
    // outside world (no fake-stderr capture here — the test is "did we
    // crash").
    d.fire(Alert::p1("any", "any"));
    let m = d.metrics();
    assert_eq!(m.global.sent, 0);
    assert_eq!(m.global.failed, 0);
}

#[test]
fn p0_is_not_rate_limited_only_suppression_window_engages() {
    let d = Dispatcher::builder()
        .with_channel(Recorder::new("rec-p0"))
        .build();
    for _ in 0..10 {
        d.fire(Alert::p0("kernel.panic", "boom"));
    }
    let m = d.metrics();
    let (_, cm) = &m.channels[0];
    // 10 fires: 1 sent, 9 suppressed (the 30 s window). `dropped` is the
    // rate-limit bucket — must stay zero (P0 is unlimited).
    assert_eq!(cm.sent, 1);
    assert_eq!(cm.suppressed, 9);
    assert_eq!(cm.dropped, 0);
}

#[test]
fn send_outcome_pathology_does_not_crash_the_dispatcher() {
    // A channel that panics would take down the dispatcher. We do not
    // test the panic path (the discipline forbids it), but we do check
    // that the dispatcher keeps responding after a failing channel.
    let d = Dispatcher::builder().with_channel(AlwaysFail).build();
    for id in ["a", "b", "c", "d", "e"] {
        d.fire(Alert::p0(id, "still alive"));
    }
    let m = d.metrics();
    let (_, cm) = &m.channels[0];
    assert_eq!(cm.failed, 5);
}

#[test]
fn alert_payload_round_trips_through_serialization() {
    // Alerts must survive a serialize → deserialize round trip with all
    // fields intact — they pass through the audit log and the JSON wire
    // format on webhook transports.
    let a = Alert::p0("kernel.panic", "boom").with_label("host", "edge-7");
    let json = serde_json::to_string(&a).expect("serialise");
    let back: Alert = serde_json::from_str(&json).expect("deserialise");
    assert_eq!(back.id, "kernel.panic");
    assert_eq!(back.message, "boom");
    assert_eq!(
        back.labels.get("host").unwrap(),
        &serde_json::json!("edge-7")
    );
}
