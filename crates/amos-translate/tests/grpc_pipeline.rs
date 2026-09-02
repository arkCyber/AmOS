//! End-to-end: drive an `amos_int::Session` through the `GrpcPipeline` against a
//! real (in-process) `amos-translate` daemon. This exercises the full chain
//! audio -> ASR -> translation over gRPC/UDS, no env vars, no races.

use amos_int::{
    InterpretationOutput, Pipeline, Session, SessionConfig, SessionEvent, SessionState,
};
use amos_proto::translate::translator_server::TranslatorServer;
use amos_translate::asr::MockRecognizer;
use amos_translate::grpc_pipeline::GrpcPipeline;
use amos_translate::provider::MockProvider;
use amos_translate::{TranslateConfig, TranslatorService};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnixListenerStream;

async fn drain(rx: &mut mpsc::Receiver<InterpretationOutput>) -> Vec<InterpretationOutput> {
    let mut v = Vec::new();
    while let Ok(Some(o)) =
        tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await
    {
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
async fn audio_through_daemon_produces_translated_segment() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-int-grpc-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let daemon = spawn_daemon(&path).await;
    // Give the listener a moment to accept.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let pipeline = Box::new(GrpcPipeline::new(&path, "auto", "zh"));
    let config = SessionConfig::one_way("auto", "zh");
    let (mut session, mut rx) = Session::new(config, pipeline);

    session.start().unwrap();
    // One PCM chunk -> daemon ASR recognizes -> engine translates -> segment.
    session
        .feed_audio(&vec![0.0; 160])
        .await
        .expect("feed_audio through daemon");
    session.stop().unwrap();

    let out = drain(&mut rx).await;
    let segments: Vec<_> = out
        .iter()
        .filter_map(|o| match o {
            InterpretationOutput::SegmentFinal(s) => Some(s.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        segments.len(),
        1,
        "expected one translated segment from the daemon"
    );
    // Mock ASR returns the fixed transcription; mock provider wraps it.
    assert!(
        segments[0].source_text.contains("语音转写"),
        "source text is the daemon ASR output: {:?}",
        segments[0].source_text
    );
    assert!(
        segments[0].target_text.starts_with("[译]"),
        "target text is the daemon translation: {:?}",
        segments[0].target_text
    );
    assert_eq!(session.state(), SessionState::Ended);

    daemon.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn translate_reconnects_after_daemon_restart() {
    let path: PathBuf = std::env::temp_dir().join(format!(
        "amos-int-grpc-reconnect-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let daemon = spawn_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let pipe = GrpcPipeline::new(&path, "en", "zh");
    let lang = amos_int::Language::new("en");
    let speaker = amos_int::segment::Speaker::default();
    let req = |s: &'static str| {
        pipe.translate(amos_int::pipeline::SourceText {
            text: s,
            lang: &lang,
            speaker: &speaker,
        })
    };

    let r1 = req("hello").await.expect("first translate");
    assert_eq!(r1.target_text, "[译](en->zh)hello");

    // Kill the daemon, then restart it on the same socket.
    daemon.abort();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = std::fs::remove_file(&path);
    let daemon2 = spawn_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // The stale cached channel must be invalidated on failure so this reconnects.
    let r2 = req("hi").await.expect("translate after restart");
    assert_eq!(r2.target_text, "[译](en->zh)hi");

    daemon2.abort();
    let _ = std::fs::remove_file(&path);
}
#[tokio::test(flavor = "multi_thread")]
async fn typed_text_through_daemon_translates() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-int-grpc-text-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let daemon = spawn_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let pipeline = Box::new(GrpcPipeline::new(&path, "en", "zh"));
    let config = SessionConfig::one_way("en", "zh");
    let (mut session, mut rx) = Session::new(config, pipeline);

    session.start().unwrap();
    session
        .handle(SessionEvent::TextSegment("hello".into()))
        .await
        .expect("translate text through daemon");
    session.stop().unwrap();

    let out = drain(&mut rx).await;
    let seg = out
        .iter()
        .find_map(|o| match o {
            InterpretationOutput::SegmentFinal(s) => Some(s.clone()),
            _ => None,
        })
        .expect("expected a segment");
    assert_eq!(seg.source_text, "hello");
    assert_eq!(seg.target_text, "[译](en->zh)hello");

    daemon.abort();
    let _ = std::fs::remove_file(&path);
}

/// interpret-bridge-style lifecycle over a real daemon: a typed segment must
/// produce exactly one SegmentFinal and, after stop, a SessionEnded, in order —
/// the same output sequence the Tauri `interpret-output` event forwards.
#[tokio::test(flavor = "multi_thread")]
async fn interpret_lifecycle_emits_segment_then_ended() {
    let path: PathBuf = std::env::temp_dir().join(format!(
        "amos-int-grpc-lifecycle-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let daemon = spawn_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let pipeline = Box::new(GrpcPipeline::new(&path, "auto", "zh"));
    let config = SessionConfig::one_way("auto", "zh");
    let (mut session, mut rx) = Session::new(config, pipeline);

    session.start().unwrap();
    session
        .handle(SessionEvent::TextSegment("hello".into()))
        .await
        .expect("typed segment through daemon");
    session.stop().unwrap();

    let out = drain(&mut rx).await;
    let tags: Vec<&str> = out
        .iter()
        .filter_map(|o| match o {
            InterpretationOutput::SegmentFinal(_) => Some("segment"),
            InterpretationOutput::SessionEnded { .. } => Some("ended"),
            _ => None,
        })
        .collect();
    let seg_pos = tags
        .iter()
        .position(|k| *k == "segment")
        .expect("a segment was emitted");
    let end_pos = tags
        .iter()
        .position(|k| *k == "ended")
        .expect("session ended after stop");
    assert!(
        seg_pos < end_pos,
        "SegmentFinal must precede SessionEnded: {tags:?}"
    );
    assert_eq!(session.state(), SessionState::Ended);

    daemon.abort();
    let _ = std::fs::remove_file(&path);
}

/// With TTS enabled, a Session driven over the real daemon must emit a
/// `TtsRequest` for the translated segment (the interpret/TTS bridge path).
#[tokio::test(flavor = "multi_thread")]
async fn tts_request_emitted_over_daemon_when_enabled() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-int-grpc-tts-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let daemon = spawn_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let pipeline = Box::new(GrpcPipeline::new(&path, "auto", "zh"));
    let config = SessionConfig::one_way("auto", "zh").with_tts(true);
    let (mut session, mut rx) = Session::new(config, pipeline);

    session.start().unwrap();
    session
        .handle(SessionEvent::TextSegment("hello".into()))
        .await
        .expect("typed segment through daemon");
    session.stop().unwrap();

    let out = drain(&mut rx).await;
    assert!(
        out.iter()
            .any(|o| matches!(o, InterpretationOutput::SegmentFinal(_))),
        "expected a translated segment: {out:?}"
    );
    assert!(
        out.iter()
            .any(|o| matches!(o, InterpretationOutput::TtsRequest(_))),
        "TTS must be requested for the translation when enabled: {out:?}"
    );

    daemon.abort();
    let _ = std::fs::remove_file(&path);
}

/// Aerospace resilience on `GrpcPipeline.translate`: it builds its channel on
/// demand, so a daemon that is initially down must produce a clean `Err` and the
/// SAME `GrpcPipeline` must then recover without re-creation once the daemon
/// comes up on the socket (no poisoned/permanent-failure state).
#[tokio::test(flavor = "multi_thread")]
async fn translate_recovers_when_daemon_comes_up() {
    use amos_int::language::Language;
    use amos_int::pipeline::{Pipeline, SourceText};
    use amos_int::segment::Speaker;

    let path: PathBuf = std::env::temp_dir().join(format!(
        "amos-int-grpc-outage-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let lang = Language::new("en");
    let sp = Speaker::default();
    let mk = |text: &'static str| SourceText {
        text,
        lang: &lang,
        speaker: &sp,
    };

    // Daemon is NOT up yet.
    let pipe = GrpcPipeline::new(&path, Language::new("en"), Language::new("zh"));
    assert!(
        pipe.translate(mk("hello")).await.is_err(),
        "unreachable daemon must surface a clean Err (no hang/panic)"
    );

    // Daemon comes up on the same socket later.
    let daemon = spawn_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let t = pipe
        .translate(mk("world"))
        .await
        .expect("same GrpcPipeline recovers once the daemon is up");
    assert_eq!(t.target_text, "[译](en->zh)world");

    daemon.abort();
    let _ = std::fs::remove_file(&path);
}

