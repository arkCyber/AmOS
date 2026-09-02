//! Headless translate/ASR command-layer e2e: spawn the real amos-translate tonic
//! server in-process (deterministic mock ASR recognizer + mock provider) on a UDS,
//! then call the actual Tauri command bodies `transcribe_audio` and
//! `translate_text` directly — no Tauri app, no GUI/WebView.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use amos_proto::translate::translator_server::TranslatorServer;
use amos_tauri_lib::translate::{transcribe_audio, translate_text};
use amos_translate::asr::MockRecognizer;
use amos_translate::provider::MockProvider;
use amos_translate::{TranslateConfig, TranslatorService};
use tokio_stream::wrappers::UnixListenerStream;

/// Start a real translate daemon (mock ASR + mock provider) on a UDS.
async fn spawn_translate_daemon(path: &PathBuf) -> tokio::task::JoinHandle<()> {
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
async fn transcribe_and_translate_commands_against_real_daemon() {
    let path: PathBuf = std::env::temp_dir().join(format!(
        "amos-tauri-translate-e2e-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::env::set_var("AMOS_TRANSLATE_SOCKET", &path);

    let daemon = spawn_translate_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    // `transcribe_audio` (the exact command body the WebView calls for ASR).
    let tr = transcribe_audio(
        vec![0u8; 160], // PCM chunk
        Some("zh".to_string()),
        None,
    )
    .await
    .expect("transcribe_audio over real daemon");
    assert!(!tr.text.trim().is_empty(), "daemon ASR returned text");

    // `translate_text` (unary text translation over the same daemon).
    let translated = translate_text(
        "hello".to_string(),
        Some("en".to_string()),
        Some("zh".to_string()),
    )
    .await
    .expect("translate_text over real daemon");
    assert_eq!(translated, "[译](en->zh)hello");

    daemon.abort();
    let _ = std::fs::remove_file(&path);
}
