//! The alert seam, end to end (REQ-A444).
//!
//! `Supervisor::with_alert_sink` is the only way a daemon alert can reach an operator, and until
//! this round nothing in the tree called it: `rust-unwired-scan` reported it as "referenced
//! nowhere", the field stayed `None` in every build, and a daemon that exhausted its restart
//! budget produced a P0 that nobody could receive. What *was* tested was the mapping
//! (`DaemonAlert::from_status`, in `alert_sink.rs`); the *wiring* (monitor loop → `fire_alert` →
//! sink) had no test at all — exactly how a seam rots unnoticed. These tests arm a recording
//! sink on a real supervisor and require the alerts to show up.
//!
//! The whole file compiles to nothing in a default build.
#![cfg(feature = "notifier")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use amos_supervisor::{
    shared, AlertSeverity, AlertSink, DaemonAlert, DaemonSpec, DaemonStatus, RestartPolicy,
    Supervisor,
};

/// Records every alert the supervisor fires.
#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<DaemonAlert>>>);

impl Recorder {
    fn seen(&self) -> Vec<(String, AlertSeverity)> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .map(|a| (a.id.clone(), a.severity))
            .collect()
    }
}

impl AlertSink for Recorder {
    fn fire(&self, alert: DaemonAlert) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).push(alert);
    }
}

/// A daemon that exits at once, with a restart budget of `max_restarts` and no backoff, so a
/// whole crash cycle happens in milliseconds.
fn flapper(name: &str, max_restarts: u32) -> DaemonSpec {
    let mut spec = DaemonSpec::simple(name, "sleep", ["0"]);
    spec.restart = RestartPolicy {
        max_restarts,
        backoff_secs: 0,
        backoff_factor: 1,
    };
    spec
}

async fn wait_for_alerts(rec: &Recorder, want: usize) {
    for _ in 0..300 {
        if rec.seen().len() >= want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_for_status(sup: &Supervisor, name: &str) -> Option<DaemonStatus> {
    for _ in 0..300 {
        let s = sup.status(name).await;
        if matches!(
            s,
            Some(DaemonStatus::Crashed { .. }) | Some(DaemonStatus::Stopped)
        ) {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    sup.status(name).await
}

/// The positive case: with a sink armed, a crash-restart cycle and the final exhaustion each
/// produce the alert the mapping promises — once each, in that order. (Two alerts, not five:
/// `Restarting` is one transition to report, not one per backoff tick.)
#[tokio::test(flavor = "multi_thread")]
async fn an_armed_supervisor_reports_a_crash_then_the_exhaustion() {
    let rec = Recorder::default();
    let sup = Supervisor::new().with_alert_sink(shared(rec.clone()));
    sup.start(flapper("flapper", 1)).await.expect("start");

    wait_for_alerts(&rec, 2).await;
    assert_eq!(
        rec.seen(),
        vec![
            ("daemon.flapper.crashed".to_string(), AlertSeverity::P1),
            (
                "daemon.flapper.crash_exhausted".to_string(),
                AlertSeverity::P0,
            ),
        ],
        "one P1 for the restart, then one P0 for the exhausted budget"
    );
    assert!(matches!(
        sup.status("flapper").await,
        Some(DaemonStatus::Crashed { .. })
    ));
    sup.shutdown_all().await;
}

/// The other direction of "one alert per transition that warrants one": an operator-requested
/// stop is **not** an alert. The monitor calls `fire_alert` on the `Stopped` path too, so a sink
/// that received something here would raise a false alarm on every orderly shutdown — worse than
/// silence, because it trains the reader to ignore the channel.
#[tokio::test(flavor = "multi_thread")]
async fn a_clean_stop_is_not_an_alert() {
    let rec = Recorder::default();
    let sup = Supervisor::new().with_alert_sink(shared(rec.clone()));
    sup.start(DaemonSpec::simple("sleeper", "sleep", ["30"]))
        .await
        .expect("start");

    sup.stop("sleeper").await.expect("stop");
    assert!(
        matches!(sup.status("sleeper").await, Some(DaemonStatus::Stopped)),
        "the stop is recorded in the state machine"
    );
    assert!(
        rec.seen().is_empty(),
        "an operator-requested stop must not fire an alert"
    );
    sup.shutdown_all().await;
}

/// A killed-on-purpose crash with the budget already at zero goes straight to `Crashed`, so it
/// must alert **once** — the shape a supervisor-startup failure takes, and the one an operator
/// most needs to see.
#[tokio::test(flavor = "multi_thread")]
async fn an_immediate_exhaustion_is_reported_as_a_p0() {
    let rec = Recorder::default();
    let sup = Supervisor::new().with_alert_sink(shared(rec.clone()));
    sup.start(flapper("doomed", 0)).await.expect("start");

    wait_for_alerts(&rec, 1).await;
    assert_eq!(
        rec.seen(),
        vec![(
            "daemon.doomed.crash_exhausted".to_string(),
            AlertSeverity::P0
        )]
    );
    assert!(matches!(
        wait_for_status(&sup, "doomed").await,
        Some(DaemonStatus::Crashed { .. })
    ));
    sup.shutdown_all().await;
}
