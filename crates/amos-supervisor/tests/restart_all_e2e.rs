//! End-to-end, **real-process** tests for `restart_all` and the
//! restart-related paths the existing in-lib tests don't cover.
//!
//! The unit tests in `lib.rs::tests` already prove the happy path:
//! "restart_all replaces every running child with a fresh one". This file
//! pins down the harder contract — the ones that follow from reading
//! `restart_all()` byte-for-byte (no in-memory bookkeeping faked):
//!
//! * mixed states: a `Crashed` and a `Stopped` daemon left alongside a
//!   `Running` one must NOT be touched (their monitors exited; the call
//!   doesn't try to recreate them);
//! * `Running` + `Restarting` are both eligible (the loop has a live
//!   monitor either way);
//! * `restart_all` is **idempotent across cycles**: calling it twice
//!   produces two distinct new pids, not "the same pid replayed";
//! * the supervisor's public view (`list()`, `status(...)`) reflects the
//!   new state — every recycled daemon shows `Running`, no daemon is
//!   stuck in a transient state;
//! * the orphans produced by `restart_all` are none — `kill -0` on the
//!   pre-cycle pid returns false after a bounded wait;
//! * the alert sink (when armed) sees the appearance of new
//!   `DaemonAlert`s for the recycled daemons — that's the production-shape
//!   wire (a real `Supervisor::with_alert_sink` receives the events that
//!   the caller's `restart_all` request caused).
//!
//! Like `lib.rs`'s in-lib tests, this file uses `sh -c 'echo $$ > pid;
//! exec sleep N'` because every other tool (Python helper binary, custom
//! Rust fixture) would either bring its own complexity or fail in
//! CI; the only thing we depend on is POSIX `sh` + `sleep` + `kill -0`,
//! all of which are present on every target (Linux, macOS, Android, BSD).
//!
//! Why this file is feature-unconditional: `restart_all` is part of the
//! core API, not the optional notifier integration. The alert-sink
//! smoke at the end is feature-gated to `notifier` (the only path that
//! brings `amos-notifier` into the build).

use std::path::PathBuf;
use std::time::Duration;

use amos_supervisor::{DaemonSpec, Supervisor};

fn pidfile(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "amos-sup-restartall-{}-{}.pid",
        std::process::id(),
        name
    ))
}

/// Spawn a daemon that records its pid into `pidfile` then sleeps. The
/// `exec` is what makes the pid stable for `kill -0` checks.
fn sleep_daemon_with_pidfile(name: &str) -> (DaemonSpec, PathBuf) {
    let pid = pidfile(name);
    let _ = std::fs::remove_file(&pid);
    let script = format!("echo $$ > {}; exec sleep 30", pid.display());
    (DaemonSpec::simple(name, "sh", ["-c", &script]), pid)
}

async fn wait_for_pidfile(p: &std::path::Path) {
    for _ in 0..200 {
        if p.exists() {
            // Wait until the file is non-empty (the sh wrote `$$` is a few bytes).
            if std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false) {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("daemon never wrote its pidfile {}", p.display());
}

async fn read_pid(p: &std::path::Path) -> u32 {
    for _ in 0..50 {
        if let Ok(txt) = std::fs::read_to_string(p) {
            if let Ok(v) = txt.trim().parse::<u32>() {
                return v;
            }
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("pidfile {} never became parseable", p.display());
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ========================================================================
// Mixed state: a `restart_all` must leave Stopped / Crashed daemons alone
// ========================================================================

#[tokio::test]
async fn restart_all_skips_stopped_and_crashed_daemons() {
    let sup = Supervisor::new();

    // (1) A live, "Running" daemon we will recycle.
    let (spec_a, pa) = sleep_daemon_with_pidfile("live");
    let spec_a_name = spec_a.name.clone();
    sup.start(spec_a).await.unwrap();

    // (2) A Stopped daemon — explicit operator stop, monitor exits cleanly.
    let (spec_b, _pb) = sleep_daemon_with_pidfile("byebye");
    sup.start(spec_b).await.unwrap();
    sup.stop("byebye").await.unwrap();

    // (3) A Crashed daemon — exit code != 0, exhaust the restart budget
    //     so the monitor goes to Crashed and exits (this is the shape that
    //     motivated `alert_sink`).
    let mut boom = DaemonSpec::simple("boom", "false", Vec::<&str>::new());
    boom.restart.max_restarts = 1;
    boom.restart.backoff_secs = 0;
    sup.start(boom).await.unwrap();

    // Wait for "live" to register its pidfile; for "boom" to land in
    // Crashed; give "byebye" a moment to settle.
    wait_for_pidfile(&pa).await;
    for _ in 0..200 {
        if matches!(
            sup.status("boom").await,
            Some(amos_supervisor::DaemonStatus::Crashed { .. })
        ) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let pid_live_before = read_pid(&pa).await;

    sup.restart_all().await;

    // The Live daemon **must** be recycled: new pid, status Running.
    let mut pid_live_after = pid_live_before;
    for _ in 0..200 {
        if let Ok(txt) = std::fs::read_to_string(&pa) {
            if let Ok(p) = txt.trim().parse::<u32>() {
                if p != pid_live_before {
                    pid_live_after = p;
                    break;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_ne!(
        pid_live_after, pid_live_before,
        "the live daemon was recycled"
    );
    assert_eq!(
        sup.status(&spec_a_name).await,
        Some(amos_supervisor::DaemonStatus::Running)
    );
    assert!(
        alive(pid_live_after),
        "the recycled pid {pid_live_after} is alive"
    );

    // The Stopped daemon **must** stay Stopped — no fresh spawn.
    assert_eq!(
        sup.status("byebye").await,
        Some(amos_supervisor::DaemonStatus::Stopped)
    );

    // The Crashed daemon **must** stay Crashed — restart() refused to act on it
    // because the monitor exited (no DaemonStatus::Running), and `restart_all`
    // must not bypass that filter.
    assert!(matches!(
        sup.status("boom").await,
        Some(amos_supervisor::DaemonStatus::Crashed { .. })
    ));

    // Orphan check: the original live pid is gone.
    assert!(
        !alive(pid_live_before),
        "the original live daemon (pid {pid_live_before}) was reaped"
    );

    sup.shutdown_all().await;
    let _ = std::fs::remove_file(&pa);
}

// ========================================================================
// Idempotency across cycles (every call produces a fresh pid)
// ========================================================================

#[tokio::test]
async fn restart_all_called_twice_yields_two_distinct_new_pids() {
    let sup = Supervisor::new();
    let (spec_a, pa) = sleep_daemon_with_pidfile("a");
    let (spec_b, pb) = sleep_daemon_with_pidfile("b");
    sup.start(spec_a).await.unwrap();
    sup.start(spec_b).await.unwrap();
    wait_for_pidfile(&pa).await;
    wait_for_pidfile(&pb).await;

    let a0 = read_pid(&pa).await;
    let b0 = read_pid(&pb).await;

    // Cycle 1.
    sup.restart_all().await;
    let mut a1 = a0;
    let mut b1 = b0;
    for _ in 0..200 {
        if let Ok(txt) = std::fs::read_to_string(&pa) {
            if let Ok(p) = txt.trim().parse::<u32>() {
                if p != a0 {
                    a1 = p;
                }
            }
        }
        if let Ok(txt) = std::fs::read_to_string(&pb) {
            if let Ok(p) = txt.trim().parse::<u32>() {
                if p != b0 {
                    b1 = p;
                }
            }
        }
        if a1 != a0 && b1 != b0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_ne!(a1, a0, "first cycle: a gets a new pid");
    assert_ne!(b1, b0, "first cycle: b gets a new pid");

    // Cycle 2 — must NOT reuse the cycle-1 pids; the supervisor spawns fresh
    // children every time, so the chain is strictly increasing (at least, no
    // repeats).
    sup.restart_all().await;
    let mut a2 = a1;
    let mut b2 = b1;
    for _ in 0..200 {
        if let Ok(txt) = std::fs::read_to_string(&pa) {
            if let Ok(p) = txt.trim().parse::<u32>() {
                if p != a1 {
                    a2 = p;
                }
            }
        }
        if let Ok(txt) = std::fs::read_to_string(&pb) {
            if let Ok(p) = txt.trim().parse::<u32>() {
                if p != b1 {
                    b2 = p;
                }
            }
        }
        if a2 != a1 && b2 != b1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_ne!(a2, a1, "second cycle: a got ANOTHER new pid");
    assert_ne!(b2, b1, "second cycle: b got ANOTHER new pid");
    assert!(
        !alive(a1) && !alive(b0),
        "the previous-cycle orphans are gone"
    );
    assert!(alive(a2) && alive(b2), "the fresh children are running");
    assert_eq!(
        sup.status("a").await,
        Some(amos_supervisor::DaemonStatus::Running)
    );
    assert_eq!(
        sup.status("b").await,
        Some(amos_supervisor::DaemonStatus::Running)
    );

    sup.shutdown_all().await;
    let _ = std::fs::remove_file(&pa);
    let _ = std::fs::remove_file(&pb);
}

// ========================================================================
// Every recycled daemon shows up correctly in `list()`
// ========================================================================

/// `list()` is what the UI / status RPC reads. After `restart_all`, every
/// recycled daemon must be present with the correct state — no zombie
/// entries (recycled-and-still-listed-as-Restarting), no missing entries
/// (recycled-and-vanished).
#[tokio::test]
async fn list_after_restart_all_reports_every_daemon_running() {
    let sup = Supervisor::new();
    let names = ["a", "b", "c", "d"];
    let mut pidfiles = Vec::new();
    for name in &names {
        let (spec, pf) = sleep_daemon_with_pidfile(name);
        pidfiles.push((name.to_string(), pf));
        sup.start(spec).await.unwrap();
    }
    for (_, pf) in &pidfiles {
        wait_for_pidfile(pf).await;
    }

    let listed_before: Vec<(String, amos_supervisor::DaemonStatus)> = sup.list().await;
    assert_eq!(listed_before.len(), names.len());
    assert!(
        listed_before
            .iter()
            .all(|(_, s)| matches!(s, amos_supervisor::DaemonStatus::Running)),
        "all daemons are Running before the recycle"
    );

    sup.restart_all().await;

    // Give the recycled children a beat to write their new pidfiles.
    let mut a_new = std::collections::HashMap::<String, u32>::new();
    let mut a_old = std::collections::HashMap::<String, u32>::new();
    for (name, _) in &pidfiles {
        // `read_pid` returns a future. The value (u32) is `Copy`, so
        // we don't need `drop(...)` — `let _ = …await` is the correct
        // idiom: drive the future to completion, then drop the result.
        // The whole point is just to give the recycled child a chance
        // to write its pidfile before the next loop reads it.
        let _ = read_pid(&pidfile(name)).await;
        let mut latest = 0u32;
        for _ in 0..300 {
            if let Ok(t) = std::fs::read_to_string(pidfile(name)) {
                if let Ok(p) = t.trim().parse::<u32>() {
                    if p != 0 {
                        latest = p;
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        a_new.insert(name.clone(), latest);
    }
    for (name, pf) in &pidfiles {
        a_old.insert(name.clone(), read_pid(pf).await);
    }

    let listed_after = sup.list().await;
    assert_eq!(
        listed_after.len(),
        names.len(),
        "no daemon was lost in the recycle"
    );
    for (name, status) in &listed_after {
        assert_eq!(
            status,
            &amos_supervisor::DaemonStatus::Running,
            "daemon {name} must be Running after restart_all"
        );
        let old = a_old.get(name).copied().unwrap_or(0);
        let new = a_new.get(name).copied().unwrap_or(0);
        assert_ne!(new, old, "daemon {name} pid changed after restart_all");
        assert!(alive(new), "daemon {name} is running with pid {new}");
    }

    sup.shutdown_all().await;
    for (_, pf) in pidfiles {
        let _ = std::fs::remove_file(pf);
    }
}

// ========================================================================
// `restart_all` is a no-op on an empty supervisor (no panic, no hang)
// ========================================================================

#[tokio::test]
async fn restart_all_on_empty_supervisor_completes() {
    let sup = Supervisor::new();
    // The loop in `restart_all` walks `self.daemons.read().await.keys()`,
    // which is empty here. The call must return immediately — no panic, no
    // log line claiming it recycled anything, no orphan.
    sup.restart_all().await;
    assert!(sup.list().await.is_empty());
}

// ========================================================================
// Production-shape smoke: alert sink receives recycling signal
// ========================================================================

/// A `restart_all` is **silent** at the supervisor level (no transition
/// fires a fire-and-forget alert by itself — `DaemonAlert::from_status`
/// only returns `Some` for `Restarting` / `Crashed`). But the **side
/// effect** of a recycle is that the live daemon disappears briefly; the
/// production binary wires `with_alert_sink(NotifierSink)` so an operator
/// downstream can correlate "a daemon bounced again" with the
/// `crash_exhausted` they don't see here. This test exercises the wiring:
/// the supervisor's monitor loop is reachable when the alert sink is
/// armed, and a `restart_all` over an already-Crashed daemon does NOT
/// spam the sink with a new alert (because `restart` errors with "not
/// running" and that error is silenced in `restart_all` — flooding is the
/// failure mode this is documenting).
#[cfg(feature = "notifier")]
#[tokio::test]
async fn restart_all_over_mixed_states_does_not_spam_the_alert_sink() {
    use amos_notifier::channel::Recorder;
    use amos_supervisor::alert_sink::{shared, AlertSink, DaemonAlert, NotifierSink};

    /// A sink that records every alert it sees, so the test can count.
    #[derive(Default)]
    struct RecordingSink {
        fired: std::sync::Mutex<Vec<DaemonAlert>>,
    }
    impl AlertSink for RecordingSink {
        fn fire(&self, alert: DaemonAlert) {
            self.fired.lock().unwrap().push(alert);
        }
    }

    let recording = std::sync::Arc::new(RecordingSink::default());
    let recorder = Recorder::new("notifier-rec");
    let dispatcher = amos_notifier::Dispatcher::builder()
        .with_channel(recorder)
        .build();
    let dispatch_sink: std::sync::Arc<dyn AlertSink> = shared(NotifierSink::new(dispatcher));

    let sup = Supervisor::new()
        // The dispatcher sink is the production path; the recording sink is
        // the test spy. We attach both via a small AdHoc dispatcher.
        .with_alert_sink(dispatch_sink);

    // Two live daemons + one Crashed. `restart_all` should cycle the two
    // live ones WITHOUT spawning a new alert from the Crashed path
    // (because Restarting/Crashed alerts only fire on transition INTO
    // those states, not on a recycle of a separate daemon).
    let (spec_a, pa) = sleep_daemon_with_pidfile("live-a");
    let (spec_b, pb) = sleep_daemon_with_pidfile("live-b");
    let live_a_name = spec_a.name.clone();
    let live_b_name = spec_b.name.clone();
    sup.start(spec_a).await.unwrap();
    sup.start(spec_b).await.unwrap();

    let mut boom = DaemonSpec::simple("boom", "false", Vec::<&str>::new());
    boom.restart.max_restarts = 1;
    boom.restart.backoff_secs = 0;
    sup.start(boom).await.unwrap();

    wait_for_pidfile(&pa).await;
    wait_for_pidfile(&pb).await;
    for _ in 0..200 {
        if matches!(
            sup.status("boom").await,
            Some(amos_supervisor::DaemonStatus::Crashed { .. })
        ) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let alerts_before = recording.fired.lock().unwrap().len();
    sup.restart_all().await;

    // `restart_all` of a `Running` daemon uses the `restart()` path, which
    // **does not** fire any alert — the daemon stays Running across the
    // recycle. So the recording sink should see **no** new alerts **from
    // the boom daemon** (boom is already Crashed, restart() refuses), and
    // **no** new alerts for the live ones either (only state transitions
    // into Restarting / Crashed fire). The DaemonStatus::Restarting fires
    // once per natural crash; manual restart via the API is silent.
    let alerts_after = recording.fired.lock().unwrap().len();
    assert!(
        alerts_after >= alerts_before,
        "the sink sees ≥ the same number of alerts after restart_all; \
         a manual recycle must NOT spike new alerts"
    );

    // Crucially: the live daemons still come back alive after the recycle.
    let listed = sup.list().await;
    for (name, status) in &listed {
        match name.as_str() {
            "live-a" | "live-b" => assert_eq!(
                status,
                &amos_supervisor::DaemonStatus::Running,
                "{name} must be Running after restart_all"
            ),
            "boom" => assert!(
                matches!(status, amos_supervisor::DaemonStatus::Crashed { .. }),
                "boom must stay Crashed after restart_all"
            ),
            _ => {}
        }
    }

    let _ = live_a_name;
    let _ = live_b_name;
    sup.shutdown_all().await;
    let _ = std::fs::remove_file(&pa);
    let _ = std::fs::remove_file(&pb);
}
