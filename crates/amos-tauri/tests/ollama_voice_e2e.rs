//! Headless e2e: **resident voice audio answered by the real Ollama engine**.
//!
//! Mirrors `assistant_voice_e2e.rs` but drives the daemon's inference backend
//! with `AMOS_BACKEND=ollama` instead of the mock. This is the gate that proves
//! the full product loop — mic PCM → bidi `Payload::Audio` → on-device ASR
//! (deterministic mock recognizer here) → **real local model reply** — is closed
//! and not silently degrading to mock tokens.
//!
//! Skipped gracefully when no reachable Ollama reports an installed model.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use amos_ai::server::AiAgentService;
use amos_audio::mock::SineMic;
use amos_audio::spec::encode_f32_le;
use amos_audio::AudioCapture;
use amos_proto::ai_agent::ai_agent_server::AiAgentServer;
use amos_tauri_lib::ai_bridge::AiBridge;
use amos_tauri_lib::assistant_voice::{VoiceEvent, VoiceLink};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnixListenerStream;

const MOCK_SIGNATURE: &str = "[amos-ai]";

/// The chat model to gate against, from `AMOS_OLLAMA_E2E_MODEL`. Skipped when
/// unset (CI / offline machines stay green). Export `AMOS_OLLAMA_API_KEY` if
/// your Ollama's `/v1` is token-gated.
fn e2e_model() -> Option<String> {
    match std::env::var("AMOS_OLLAMA_E2E_MODEL") {
        Ok(m) if !m.trim().is_empty() => Some(m),
        _ => None,
    }
}

async fn spawn_ai_daemon(path: &PathBuf) -> tokio::task::JoinHandle<()> {
    let listener = tokio::net::UnixListener::bind(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let svc = AiAgentService::new().await;
    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(AiAgentServer::new(svc))
            .serve_with_incoming(UnixListenerStream::new(listener))
            .await
            .unwrap();
    })
}

async fn wait_for_event(
    rx: &mut mpsc::Receiver<VoiceEvent>,
    what: impl Fn(&VoiceEvent) -> bool,
) -> Option<VoiceEvent> {
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(90));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return None,
            ev = rx.recv() => match ev {
                Some(e) if what(&e) => return Some(e),
                Some(_) => continue,
                None => return None,
            },
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn resident_voice_audio_is_answered_by_real_ollama() {
    let Some(model) = e2e_model() else {
        eprintln!(
            "skip real-Ollama voice gate: set AMOS_OLLAMA_E2E_MODEL to a chat model id \
             to run it (CI / offline machines skip)"
        );
        return;
    };
    let host =
        std::env::var("AMOS_OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".to_string());

    let path: PathBuf = std::env::temp_dir().join(format!(
        "amos-tauri-ollama-voice-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);

    std::env::set_var("AMOS_SOCKET", &path);
    std::env::set_var("AMOS_BACKEND", "ollama");
    std::env::set_var("AMOS_OLLAMA_HOST", &host);
    std::env::set_var("AMOS_MODEL", &model);
    // ASR recognizer stays the deterministic mock (no sherpa feature needed);
    // the point of this gate is the *inference* engine being real.
    std::env::remove_var("AMOS_ASR_BACKEND");

    let daemon = spawn_ai_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let bridge = AiBridge::new();

    // A 16 kHz mic burst long enough (>=640 samples) for the mock recognizer's
    // own endpoint, so the daemon finalizes "你好，Amos" and asks Ollama.
    let mut mic = SineMic::new(16_000, 440.0).with_total_samples(4_800); // 0.3 s
    let mut wire = Vec::new();
    let mut buf = [0.0f32; 480];
    loop {
        let n = mic.read(&mut buf).expect("mock mic read");
        if n == 0 {
            break;
        }
        wire.extend_from_slice(&encode_f32_le(&buf[..n]));
    }
    assert!(
        wire.len() / 4 >= 640,
        "utterance long enough: {}",
        wire.len() / 4
    );

    let (ev_tx, mut ev_rx) = mpsc::channel(64);
    let emit = move |e: VoiceEvent| {
        let _ = ev_tx.try_send(e);
    };
    let link = VoiceLink::open(&bridge, "ollama-voice".into(), emit)
        .await
        .expect("open voice chat stream");

    wait_for_event(&mut ev_rx, |e| matches!(e, VoiceEvent::Listening { .. }))
        .await
        .expect("stream reports listening");
    link.feed_bytes(wire).await.expect("feed audio frame");

    let done = wait_for_event(&mut ev_rx, |e| matches!(e, VoiceEvent::TurnDone { .. }))
        .await
        .expect("an answered turn arrives (voice -> real Ollama)");
    let text = match done {
        VoiceEvent::TurnDone { text, .. } => text,
        _ => unreachable!("matched TurnDone"),
    };

    link.stop().await;
    daemon.abort();
    let _ = std::fs::remove_file(&path);

    assert!(
        !text.trim().is_empty(),
        "voice turn must be answered by the real engine (got empty)"
    );
    assert!(
        !text.contains(MOCK_SIGNATURE),
        "reply must come from the real Ollama engine, not the mock fallback (got: {text:?})"
    );
    eprintln!("ollama voice reply (model={model}): {text}");
}
