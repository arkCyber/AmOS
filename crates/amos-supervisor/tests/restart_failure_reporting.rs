//! A supervisor whose recycle run fails must **say so** (REQ-A147, the same class as
//! REQ-A146 in the daemon): `restart_all()` used to discard every per-daemon result, and the
//! monitor discarded the spawn error of an explicit restart, so a daemon could go
//! `Crashed` — i.e. simply stop existing — with no line anywhere explaining why.
//!
//! Own test binary (its own process) because the capturing subscriber is process-wide.
//!
//! Honest scope: this proves the *reporting* of a failed explicit restart and that the
//! expected "not running" case stays silent. It does not exercise the `stop()` timeout
//! branch (that needs a child which survives `SIGKILL`, which a test cannot create).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use amos_supervisor::{DaemonSpec, DaemonStatus, Supervisor};

/// Captures everything the supervisor logs.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap_or_else(|p| p.into_inner())).to_string()
    }
}

struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = CaptureWriter;
    fn make_writer(&'a self) -> Self::Writer {
        CaptureWriter(Arc::clone(&self.0))
    }
}

fn capture_logs() -> Capture {
    let cap = Capture::default();
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .with_writer(cap.clone())
        .try_init();
    cap
}

/// A script that runs once and then deletes itself, so the *next* spawn fails.
fn self_deleting_script(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("amos-sup-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let script = dir.join("ghost.sh");
    std::fs::write(&script, "#!/bin/sh\nrm -f \"$0\"\nexec sleep 30\n").expect("write script");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    script
}

async fn wait_until<F: Fn() -> bool>(what: &str, cond: F) {
    for _ in 0..200 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_that_cannot_spawn_is_reported() {
    let cap = capture_logs();
    let script = self_deleting_script("recycle");
    let sup = Supervisor::new();
    sup.start(DaemonSpec::simple(
        "ghost",
        script.to_str().expect("path"),
        Vec::<String>::new(),
    ))
    .await
    .expect("first start succeeds");

    // The child has to have deleted itself before the recycle can fail.
    wait_until("the script to delete itself", || !script.exists()).await;

    sup.restart_all().await;
    let mut crashed = false;
    for _ in 0..200 {
        if matches!(
            sup.status("ghost").await,
            Some(DaemonStatus::Crashed { .. })
        ) {
            crashed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        crashed,
        "the failed recycle must leave the daemon in `Crashed` (the state is not the issue; \
         the missing line in the log was)"
    );

    let log = cap.text();
    assert!(
        log.contains("ghost") && log.contains("could not spawn"),
        "a failed restart must name the daemon and the reason, got:\n{log}"
    );

    // The expected case must NOT be noise: recycling again (the daemon is crashed now, so
    // its monitor has exited) must not warn — that is the documented `start` case.
    sup.restart_all().await;
    sup.restart_all().await;
    assert_eq!(
        cap.text().matches("restart_all could not signal").count(),
        0,
        "a crashed daemon is the documented `start` case, not a warning"
    );

    sup.shutdown_all().await;
    let _ = std::fs::remove_dir_all(script.parent().expect("parent"));
}
