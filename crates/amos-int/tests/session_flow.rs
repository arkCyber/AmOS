//! Integration test exercising `amos-int` through its public API, as a CLI or
//! Tauri adapter would.

use amos_int::{
    InterpretationOutput, MockPipeline, Session, SessionConfig, SessionEvent, SessionState,
};
use tokio::sync::mpsc;

async fn drain(rx: &mut mpsc::Receiver<InterpretationOutput>) -> Vec<InterpretationOutput> {
    let mut v = Vec::new();
    while let Ok(Some(o)) =
        tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await
    {
        v.push(o);
    }
    v
}

#[tokio::test]
async fn public_api_drives_a_full_session() {
    let cfg = SessionConfig::one_way("auto", "zh").with_tts(true);
    let mut pipeline = MockPipeline::new("こんにちは", "ja");
    pipeline.stream_chunks = 2; // finalize only on the second chunk
    let (mut session, mut rx) = Session::new(cfg, Box::new(pipeline));

    assert_eq!(session.state(), SessionState::Idle);
    session.start().unwrap();
    assert_eq!(session.state(), SessionState::Collecting);

    // Push two audio chunks: the second finalizes and translates.
    session
        .handle(SessionEvent::AudioChunk(vec![0.0; 160]))
        .await
        .unwrap();
    session
        .handle(SessionEvent::AudioChunk(vec![0.0; 160]))
        .await
        .unwrap();

    // Pause, then end.
    session.pause().unwrap();
    assert_eq!(session.state(), SessionState::Paused);
    session.stop().unwrap();
    assert_eq!(session.state(), SessionState::Ended);

    let out = drain(&mut rx).await;
    let segments = out
        .iter()
        .filter_map(|o| match o {
            InterpretationOutput::SegmentFinal(s) => Some(s),
            _ => None,
        })
        .count();
    assert_eq!(segments, 1, "one utterance was translated");
    assert!(
        out.iter()
            .any(|o| matches!(o, InterpretationOutput::TtsRequest(_))),
        "TTS requested for the translated segment"
    );
}
