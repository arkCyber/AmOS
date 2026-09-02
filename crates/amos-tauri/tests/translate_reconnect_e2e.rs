//! Disconnect → fault-injection e2e for the translate command layer.
//!
//! The command bodies (`transcribe_audio` / `translate_text`) build a fresh tonic
//! channel per call over the translate daemon's UDS. This test proves the
//! aerospace-relevant behaviour around a daemon outage:
//!   * a healthy daemon answers,
//!   * when the daemon dies, the *next* call surfaces a clean `Err` (never a
//!     panic or a hang),
//!   * once the daemon restarts on the same socket, a subsequent call recovers —
//!     the caller does not need to be restarted.
//!
//! This is a separate integration-test binary from `translate_command_e2e.rs`
//! because the command bodies read the `AMOS_TRANSLATE_SOCKET` env var, and cargo
//! runs each integration-test binary in its own process (so the env is isolated).

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

const SLEEP: std::time::Duration = std::time::Duration::from_millis(150);
const PCM: &[u8] = &[0u8; 160];

async fn transcribe_once() -> Result<amos_tauri_lib::translate::TranscriptionPayload, String> {
    transcribe_audio(
        PCM.to_vec(),
        Some("zh".to_string()),
        Some("wav".to_string()),
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn daemon_disconnect_is_reported_and_restart_recovers() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-tauri-reconnect-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::env::set_var("AMOS_TRANSLATE_SOCKET", &path);

    // 1) Healthy daemon answers.
    let daemon = spawn_translate_daemon(&path).await;
    tokio::time::sleep(SLEEP).await;
    let healthy = transcribe_once().await.expect("healthy daemon answers");
    assert!(!healthy.text.trim().is_empty(), "ASR returned text");

    // 2) Kill the daemon: the next call must fail cleanly (Err, no panic/hang).
    daemon.abort();
    tokio::time::sleep(SLEEP).await; // let the listener actually close
    let down = transcribe_once().await;
    assert!(
        down.is_err(),
        "unreachable daemon must surface a clean Err (no panic/hang)"
    );

    // 3) Daemon restarts on the same socket; the caller recovers without restart.
    let _ = std::fs::remove_file(&path); // drop the stale socket file
    let daemon2 = spawn_translate_daemon(&path).await;
    tokio::time::sleep(SLEEP).await;
    let recovered = transcribe_once()
        .await
        .expect("recovered after daemon restart");
    assert!(!recovered.text.trim().is_empty());

    // Sanity: text translation also survives a restart.
    let translated = translate_text(
        "hello".to_string(),
        Some("en".to_string()),
        Some("zh".to_string()),
    )
    .await
    .expect("translate_text after restart");
    assert_eq!(translated, "[译](en->zh)hello");

    daemon2.abort();
    let _ = std::fs::remove_file(&path);
}
