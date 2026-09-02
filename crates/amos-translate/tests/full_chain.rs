//! Full-chain headless smoke test (真机冒烟).
//!
//! Exercises the exact pipeline the System UI 同传 App drives over the Tauri
//! bridge — without needing a display:
//!
//! ```text
//! audio (PCM) → AsrPipeline (amos-asr streaming ASR: Partial/Final)
//!             → GrpcPipeline (amos-translate daemon: translation)
//!             → amos-tts (synthesize the translated text → playable TtsAudio)
//! ```
//!
//! This mirrors `frontend/js/apps/interpreter.js` (AmosInterp.audio → partials
//! → segment_final → 🔊 AmosTts).

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use amos_asr::{AsrPipelineBuilder, MockStreamingRecognizer};
use amos_int::{InterpretationOutput, Pipeline, Session, SessionConfig};
use amos_proto::translate::translator_server::TranslatorServer;
use amos_translate::asr::MockRecognizer;
use amos_translate::grpc_pipeline::GrpcPipeline;
use amos_translate::provider::MockProvider;
use amos_translate::{TranslateConfig, TranslatorService};
use amos_tts::{MockTtsProvider, TtsProvider};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnixListenerStream;

async fn drain(rx: &mut mpsc::Receiver<InterpretationOutput>) -> Vec<InterpretationOutput> {
    let mut v = Vec::new();
    while let Ok(Some(o)) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
        v.push(o);
    }
    v
}

/// Start a deterministic daemon (mock provider + mock ASR) on a UDS.
async fn spawn_daemon(path: &PathBuf) -> tokio::task::JoinHandle<()> {
    let listener = tokio::net::UnixListener::bind(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let svc = TranslatorService::new(
        Arc::new(MockProvider::default()),
        TranslateConfig::default(),
    )
    .with_recognizer(Arc::new(MockRecognizer::default()));
    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(TranslatorServer::new(svc))
            .serve_with_incoming(UnixListenerStream::new(listener))
            .await
            .unwrap();
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn full_chain_audio_partials_translate_tts() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-fullchain-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let daemon = spawn_daemon(&path).await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Compose: local streaming ASR + daemon translation (as the System UI app does).
    let recognizer = MockStreamingRecognizer::new(["你", "好", "，Amos"], 3);
    let translator: Arc<dyn Pipeline> = Arc::new(GrpcPipeline::new(&path, "zh", "en"));
    let pipeline = Box::new(
        AsrPipelineBuilder::new(recognizer, "zh")
            .with_translate(translator)
            .build(),
    );

    let (mut session, mut rx) = Session::new(SessionConfig::one_way("zh", "en"), pipeline);
    session.start().unwrap();

    // "speak": three 10 ms frames drive the recognizer to an endpoint.
    for _ in 0..3 {
        session.feed_audio(&vec![0.0; 160]).await.unwrap();
    }
    session.stop().unwrap();

    let out = drain(&mut rx).await;

    // 1) streaming ASR partials surfaced.
    let partials: Vec<String> = out
        .iter()
        .filter_map(|o| match o {
            InterpretationOutput::Partial(p) => Some(p.text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        partials,
        ["你", "你好", "你好，Amos"],
        "streaming ASR partials"
    );

    // 2) translated final came from the daemon.
    let seg = out
        .iter()
        .find_map(|o| match o {
            InterpretationOutput::SegmentFinal(s) => Some(s.clone()),
            _ => None,
        })
        .expect("translated segment");
    assert_eq!(seg.source_text, "你好，Amos");
    assert!(
        seg.target_text.contains("[译]"),
        "target text is the daemon's translation: {}",
        seg.target_text
    );
    assert_eq!(seg.target_lang.as_str(), "en");

    // 3) synthesize the translation → playable TtsAudio (as 🔊 朗读 does).
    let tts = MockTtsProvider::default();
    let audio = tts
        .synthesize(&seg.target_text, &seg.target_lang)
        .await
        .unwrap();
    assert!(!audio.samples.is_empty(), "TTS produced audio");
    assert_eq!(audio.sample_rate, 16_000);
    assert_eq!(audio.channels, 1);

    eprintln!(
        "\n[full-chain] 说:\n  partials = {partials:?}\n  translated = {:?}\n  tts = {} samples @ {}Hz\n",
        seg.target_text,
        audio.samples.len(),
        audio.sample_rate
    );

    daemon.abort();
    let _ = std::fs::remove_file(&path);
}
