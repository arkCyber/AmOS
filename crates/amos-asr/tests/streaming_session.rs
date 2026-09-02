//! End-to-end: stream PCM into an `amos_int::Session` backed by the
//! `AsrPipeline` (streaming ASR + translate delegate), verifying partials and a
//! translated final segment — the exact "speech streams into a session" flow.

use amos_asr::{AsrPipelineBuilder, MockStreamingRecognizer};
use amos_int::{InterpretationOutput, MockPipeline, Session, SessionConfig};
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
async fn streaming_asr_feeds_partials_and_translated_final() {
    // Recognizer: 3 words, endpoint after 3 (one partial per 160-sample frame).
    let recognizer = MockStreamingRecognizer::new(["你", "好", "，Amos"], 3);
    // Translate delegate: the deterministic amos-int mock.
    let translator = std::sync::Arc::new(MockPipeline::new("ignored", "zh"));
    let pipeline = Box::new(
        AsrPipelineBuilder::new(recognizer, "zh")
            .with_translate(translator)
            .build(),
    );

    let config = SessionConfig::one_way("auto", "zh"); // tts off
    let (mut session, mut rx) = Session::new(config, pipeline);
    session.start().unwrap();

    // Three 10 ms frames drive the recognizer to an endpoint.
    for _ in 0..3 {
        session.feed_audio(&vec![0.0; 160]).await.unwrap();
    }
    session.stop().unwrap();

    let out = drain(&mut rx).await;

    // Partial recognition events were surfaced.
    let partials: Vec<_> = out
        .iter()
        .filter_map(|o| match o {
            InterpretationOutput::Partial(p) => Some(p.text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(partials, ["你", "你好", "你好，Amos"]);

    // The final utterance was translated through the delegate.
    let seg = out
        .iter()
        .find_map(|o| match o {
            InterpretationOutput::SegmentFinal(s) => Some(s.clone()),
            _ => None,
        })
        .expect("expected a translated segment");
    assert_eq!(seg.source_text, "你好，Amos");
    assert_eq!(seg.target_text, "[zh] 你好，Amos");
}
