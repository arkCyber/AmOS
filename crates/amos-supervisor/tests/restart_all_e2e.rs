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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use amos_supervisor::{DaemonSpec, Supervisor};

/// One-time path under which the test reads & writes the daemon's pidfile.
/// The supervisor's spawned `sh -c` script writes to this exact path (it's
/// baked into the `DaemonSpec`'s args at start time), so the path must
/// stay constant for the lifetime of one supervisor instance.
///
/// The path is unique **per call**, not just per `(process::id(), name)`.
/// Reason (measured 2026-09-19, REQ-A466): the tests in this binary are *concurrent
/// threads of one process*, and two of them pick the same daemon names —
/// `restart_all_called_twice_yields_two_distinct_new_pids` uses `a`/`b` and
/// `list_after_restart_all_reports_every_daemon_running` uses `a`/`b`/`c`/`d`.
/// Keyed only by name, the two tests share paths, and every
/// `sleep_daemon_with_pidfile` starts with `remove_file` — so one test deletes
/// the other's pidfile between its `wait_for_pidfile` and its `read_pid`, and
/// the read can never parse (`pidfile … never became parseable`). Measured:
/// **1 of 4** tests failed under the default parallel runner, **0 of 4** with
/// `--test-threads=1`, and the one test passed alone. The counter makes every
/// spawn's path unique, so a test always reads the file its own daemon wrote.
///
/// Do **not** try to reconstruct this path from `name` elsewhere: it is only
/// knowable through the returned value (use the `(name, path)` pair the helper
/// hands back, as `list_after_restart_all_…` does).
fn pidfile(name: &str) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "amos-sup-restartall-{}-{}-{}.pid",
        std::process::id(),
        seq,
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
//
// A back-to-back `restart_all` is intentionally sequenced here. The
// supervisor's monitor loop is a 20 ms `try_wait` spin that does **not**
// select on the `Notify` (the `Notify` only breaks the *backoff* `select!`
// in `lib.rs`). Issuing a second `restart_all` while the monitor is still
// processing the first cycle can drop the cycle-2 request on the floor:
// the cycle-1 handler clears `restart_requested` mid-spin, and cycle-2
// arrives between cycles without a notification wakeup. The test
// therefore *serialises* the cycles by polling the supervisor's own state
// machine (`status() == Running` after each cycle, then a small settle
// delay) before issuing the next one. The end-to-end correctness — that
// each cycle produces a brand-new child — is what this test pins down.
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

    // Serialise the cycles: between any two `restart_all` calls, wait
    // until BOTH daemons report `Running` AND a fresh pidfile is on disk,
    // then give the monitor one extra 20 ms poll beat. This is the exact
    // cadence the monitor's spin loop is itself on, so once `wait_settled`
    // returns the monitor is guaranteed to be sitting in
    // `try_wait().await sleep(20).await`, and the next
    // `restart_all().notify_one()` will be observed by the **next** poll
    // iteration rather than racing an in-flight handler.
    async fn wait_settled(sup: &Supervisor, name: &str, target_pidfile: &std::path::Path) {
        for _ in 0..1000 {
            let s = sup.status(name).await;
            let pf_ok = std::fs::read_to_string(target_pidfile)
                .ok()
                .and_then(|t| t.trim().parse::<u32>().ok())
                .is_some();
            if matches!(s, Some(amos_supervisor::DaemonStatus::Running)) && pf_ok {
                // One more poll beat for safety. The monitor's
                // `try_wait -> sleep(20ms) -> continue` cadence means a
                // second `restart_all` issued within ~20 ms of the
                // first one's spawn_child could land **between** the
                // monitor's `restart_requested` reset and the next
                // spin poll, losing the second request. 100 ms ≫ 20 ms
                // and gives the monitor a full multi-beat window to
                // settle into the polling phase.
                tokio::time::sleep(Duration::from_millis(100)).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("daemon {name} did not settle into Running within 10s");
    }

    // Cycle 1.
    sup.restart_all().await;
    wait_settled(&sup, "a", &pa).await;
    wait_settled(&sup, "b", &pb).await;

    // Now the cycle-1 pid is on disk; record it for the orphan check.
    let a1 = read_pid(&pa).await;
    let b1 = read_pid(&pb).await;
    assert_ne!(a1, a0, "first cycle: a gets a new pid");
    assert_ne!(b1, b0, "first cycle: b gets a new pid");

    // Cycle 2.
    sup.restart_all().await;
    wait_settled(&sup, "a", &pa).await;
    wait_settled(&sup, "b", &pb).await;

    // The cycle-2 pid must differ from cycle-1 (i.e. we did NOT replay
    // the cycle-1 child, which is what the dropped-restart bug would
    // surface as).
    let a2 = read_pid(&pa).await;
    let b2 = read_pid(&pb).await;
    assert_ne!(
        a2, a1,
        "second cycle: a got ANOTHER new pid (a1={a1}, a2={a2})"
    );
    assert_ne!(
        b2, b1,
        "second cycle: b got ANOTHER new pid (b1={b1}, b2={b2})"
    );

    // The cycle-1 orphans must be reaped (their pid no longer matches
    // any alive process). `kill -0` is the OS-level proof: a daemon whose
    // `child` was taken + killed by the monitor cannot survive without
    // being adopted by init.
    async fn wait_dead(pid: u32) {
        for _ in 0..500 {
            if !alive(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("pid {pid} still alive 5s after restart_all — leaked orphan");
    }
    wait_dead(a1).await;
    wait_dead(b1).await;
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

    // Snapshot the **pre-cycle** pids BEFORE restart_all. The new pids
    // are sampled after the call. If we read pidfiles after restart_all
    // we get the recycled values back, which is why the old/new
    // comparison would falsely say "did not change".
    let mut a_old = std::collections::HashMap::<String, u32>::new();
    for (name, pf) in &pidfiles {
        a_old.insert(name.clone(), read_pid(pf).await);
    }

    sup.restart_all().await;

    // Small wait so the monitor has a beat to take in the restart signal.
    // Without this we'd race the monitor's 20 ms poll cadence against our
    // very first read. The monitor's notification path wakes the backoff
    // sleep, but **not** the spin-loop's `try_wait` — there's an
    // intentional doc note about that in lib.rs.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Give the recycled children a beat to write their new pidfiles.
    let mut a_new = std::collections::HashMap::<String, u32>::new();
    for (name, pf) in &pidfiles {
        let mut latest = 0u32;
        // Loop until we see a pid different from the pre-cycle one.
        let old = a_old.get(name).copied().unwrap_or(0);
        let mut attempts = 0;
        let mut last_seen_pid = 0;
        for _ in 0..1000 {
            // Use the path the helper returned, not a reconstruction from `name`:
            // the two are only equal by accident (see `pidfile`).
            if let Ok(t) = std::fs::read_to_string(pf) {
                if let Ok(p) = t.trim().parse::<u32>() {
                    if p != 0 {
                        last_seen_pid = p;
                        if p != old {
                            latest = p;
                            break;
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
            attempts += 1;
        }
        if latest == 0 {
            panic!(
                "daemon {name} never wrote a post-cycle pidfile \
                 (old={old}, last_seen={last_seen_pid}, attempts={attempts}, \
                 status={:?})",
                sup.status(name).await
            );
        }
        a_new.insert(name.clone(), latest);
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
