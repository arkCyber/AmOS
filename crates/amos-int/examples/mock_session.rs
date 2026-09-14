//! `mock_session` — a whole interpretation session on the mock pipeline.
//!
//! `MockPipeline` makes every session rule deterministic in tests, so the *state machine*
//! is observable with no model, no daemon and no microphone: a streaming partial that is
//! not translated, the final that is, the TTS request it produces, segment numbering, and
//! a clean end with its `EndReason`.
//!
//! Usage:
//! ```text
//! cargo run -p amos-int --example mock_session
//! ```

use amos_int::{InterpretationOutput, MockPipeline, Session, SessionConfig, SessionEvent};
use tokio::sync::mpsc;

/// Render and drain everything the session emitted so far.
fn drain(rx: &mut mpsc::Receiver<InterpretationOutput>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(o) = rx.try_recv() {
        out.push(match o {
            InterpretationOutput::StateChanged(s) => format!("state -> {s:?}"),
            InterpretationOutput::Partial(p) => {
                format!("partial {:?} (stable {:?})", p.text, p.stable)
            }
            InterpretationOutput::UtteranceRecognized { id, text, lang } => {
                format!("recognized #{id} {text:?} [{lang}]")
            }
            InterpretationOutput::SegmentFinal(s) => {
                format!("#{} {}  ->  {}", s.id, s.source_text, s.target_text)
            }
            InterpretationOutput::LanguageDetected(l) => format!("language detected: {l}"),
            InterpretationOutput::TtsRequest(r) => {
                format!("tts request #{} {:?} [{}]", r.segment_id, r.text, r.lang)
            }
            InterpretationOutput::SessionEnded { reason } => format!("session ended: {reason:?}"),
            InterpretationOutput::Error { message } => format!("error: {message}"),
        });
    }
    out
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = SessionConfig::one_way("en", "zh").with_tts(true);
    let pipeline = Box::new(MockPipeline::new("你好，世界", "en"));
    let (mut session, mut rx) = Session::new(config, pipeline);

    println!("session {} starts in {:?}", session.id(), session.state());
    session.start()?;
    for line in drain(&mut rx) {
        println!("  {line}");
    }

    // One audio chunk: the mock recognizer emits a partial, then the final.
    session
        .handle(SessionEvent::AudioChunk(vec![0.0f32; 160]))
        .await?;
    println!("after one 10 ms frame:");
    for line in drain(&mut rx) {
        println!("  {line}");
    }

    // A typed line bypasses ASR and goes straight to translation (same session).
    session
        .handle(SessionEvent::TextSegment("good morning".into()))
        .await?;
    println!("after a typed line:");
    for line in drain(&mut rx) {
        println!("  {line}");
    }

    session.stop()?;
    for line in drain(&mut rx) {
        println!("  {line}");
    }
    println!("final state: {:?}", session.state());
    Ok(())
}
