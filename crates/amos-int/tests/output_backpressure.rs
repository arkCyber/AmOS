//! A consumer that falls behind must not lose outputs *silently* (REQ-A162, same class as
//! REQ-A161's rollback/`let _ =` findings): the session's output channel is bounded (128),
//! and `Session::emit` used to discard `try_send`'s result — so when the consumer was more
//! than 128 outputs behind, a `SegmentFinal` (the translation the user is waiting for)
//! simply vanished, with no gap marker for the consumer and no line for the operator.
//!
//! Own test binary (its own process): the capturing subscriber is process-wide.
//!
//! Honest scope: this proves the *reporting* + the counter for a full channel, and that the
//! documented "no consumer at all" case stays silent. It does not prove anything about a
//! real UI's drain rate (the consumer here is a `Receiver` nobody reads).

use std::sync::{Arc, Mutex};

use amos_int::event::InterpretationOutput;
use amos_int::{MockPipeline, Session, SessionConfig, SessionEvent};

/// Captures everything the session logs.
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

fn session() -> (Session, tokio::sync::mpsc::Receiver<InterpretationOutput>) {
    Session::new(
        SessionConfig::one_way("en", "zh"),
        Box::new(MockPipeline::new("ignored", "en")),
    )
}

/// Own test binary *and* a single test: the capturing subscriber is process-wide, so a
/// second test in this process would write into the first one's sink and its "no warning"
/// assertion would pass for the wrong reason.
#[tokio::test]
async fn a_lagging_consumer_is_reported_while_no_consumer_stays_silent() {
    let cap = capture_logs();

    // Phase 1: a consumer that never drains ⇒ the bounded channel fills and outputs drop.
    let (mut s, _rx) = session(); // held, never read
    s.start().expect("session starts");
    for i in 0..200 {
        s.handle(SessionEvent::TextSegment(format!("line {i}")))
            .await
            .expect("a collecting session accepts text");
    }
    assert!(
        s.dropped_outputs() > 0,
        "the session must count the outputs it had to drop"
    );
    let reported = cap.text().matches("output dropped").count();
    assert!(
        reported > 0 && cap.text().contains("behind"),
        "a dropped output must be named with its consequence, got:\n{}",
        cap.text()
    );

    // Phase 2: a *closed* channel is not backpressure — nobody ever wanted the output, and
    // the documented headless case must stay silent (and uncounted).
    let dropped_when_closed = {
        let (mut s2, rx) = session();
        s2.start().expect("session starts");
        drop(rx);
        for i in 0..200 {
            let _ = s2
                .handle(SessionEvent::TextSegment(format!("line {i}")))
                .await;
        }
        s2.dropped_outputs()
    };
    assert_eq!(
        dropped_when_closed, 0,
        "a closed channel drops nothing: it was never wanted"
    );
    assert_eq!(
        cap.text().matches("output dropped").count(),
        reported,
        "no consumer is the documented case, not a warning: {}",
        cap.text()
    );
}
