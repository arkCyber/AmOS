//! The ordinary ending — the restart budget runs out — must leave a line (REQ-A444).
//!
//! The monitor logged each *restart* (`daemon exited; restarting in …`) and both spawn-failure
//! crashes log an error, but the branch that handles "the budget is used up" printed nothing at
//! all: the only record of "this daemon is gone for good" was the P0 alert, and until REQ-A444
//! no sink was ever armed — so in a default build a daemon simply stopped existing, silently,
//! while the operator watched its restarts go by.
//!
//! Own test binary: the capturing subscriber is process-wide, so a second test in the same
//! process would get no subscriber at all.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use amos_supervisor::{DaemonSpec, RestartPolicy, Supervisor};

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

#[tokio::test(flavor = "multi_thread")]
async fn an_exhausted_restart_budget_is_reported() {
    let cap = Capture::default();
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .with_writer(cap.clone())
        .try_init();

    let mut spec = DaemonSpec::simple("gone", "false", Vec::<String>::new());
    spec.restart = RestartPolicy {
        max_restarts: 0,
        backoff_secs: 0,
        backoff_factor: 1,
    };
    let sup = Supervisor::new();
    sup.start(spec).await.expect("start");

    for _ in 0..200 {
        if cap.text().contains("exhausted its restart budget") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let text = cap.text();
    assert!(
        text.contains("exhausted its restart budget"),
        "the give-up transition must leave a line, got: {text}"
    );
    assert!(
        text.contains("daemon=gone"),
        "the line must name the daemon, got: {text}"
    );
    sup.shutdown_all().await;
}
