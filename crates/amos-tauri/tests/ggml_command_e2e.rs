//! Headless GGML command-layer e2e: run the AI daemon's real local engine
//! (`allama` running a registered GGUF) through the exact RPC core the Tauri AI
//! bridge commands use (`ask_daemon` / unary `stream_chat`). Two assertions in
//! one serialized test (the process env is process-global, so we avoid races):
//!
//!   1. Fallback: `AMOS_BACKEND=ggml` + a missing model → the daemon falls back
//!      to mock tokens (signature `[amos-ai]`), so offline/CI stays green.
//!   2. Real: a registered GGUF + `allama` on PATH → reply must NOT carry the
//!      mock signature, i.e. text truly came from the local engine.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use amos_ai::server::AiAgentService;
use amos_proto::ai_agent::ai_agent_server::AiAgentServer;
use amos_proto::ai_agent::AgentRequest;
use amos_tauri_lib::ai_bridge::{ask_daemon, AiBridge};
use tokio_stream::wrappers::UnixListenerStream;

const MOCK_SIGNATURE: &str = "[amos-ai]";

fn set(k: &str, v: &str) {
    std::env::set_var(k, v);
}

async fn spawn_ai_daemon(path: &Path) -> tokio::task::JoinHandle<()> {
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

async fn one_shot(socket: &Path, model_path: &Path) -> String {
    // Route the bridge client + backend selection for this daemon.
    set("AMOS_SOCKET", &socket.to_string_lossy());
    set("AMOS_BACKEND", "ggml");
    set("AMOS_MODEL_PATH", &model_path.to_string_lossy());
    // allama registry run-name (independent of the model file's directory layout).
    set("AMOS_GGML_MODEL", "qwen2.5");

    let daemon = spawn_ai_daemon(socket).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    let bridge = AiBridge::new();
    let req = AgentRequest {
        session_id: "ggml-e2e".into(),
        prompt: "Reply with the single word: AMOS".into(),
        context: Default::default(),
    };
    let events = ask_daemon(&bridge, req)
        .await
        .expect("stream_chat over ggml daemon");
    let text: String = events.iter().map(|e| e.token.clone()).collect();

    daemon.abort();
    text
}

#[tokio::test(flavor = "multi_thread")]
async fn ggml_command_layer_real_engine_and_mock_fallback() {
    // --- 1) Fallback (always runs, no engine/model required) -------------------
    let bogus: PathBuf = std::env::temp_dir().join("amos-ggml-does-not-exist.gguf");
    let sock_fb: PathBuf =
        std::env::temp_dir().join(format!("amos-tauri-ggml-fb-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&sock_fb);
    let fb = one_shot(&sock_fb, &bogus).await;
    assert!(
        fb.contains(MOCK_SIGNATURE),
        "missing model must fall back to mock tokens (got: {fb:?})"
    );
    let _ = std::fs::remove_file(&sock_fb);

    // --- 2) Real local engine (skips when allama/model absent) -----------------
    let default_model = format!(
        "{}/.allama/models/qwen2.5/qwen2.5:0.5b.gguf",
        std::env::var("HOME").unwrap_or_default()
    );
    let model = std::env::var("AMOS_GGML_E2E_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(&default_model));
    if !model.exists() {
        eprintln!(
            "skip real GGML: no registered qwen2.5 GGUF (set AMOS_GGML_E2E_MODEL to override): {}",
            model.display()
        );
        return;
    }
    let sock_real: PathBuf =
        std::env::temp_dir().join(format!("amos-tauri-ggml-real-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&sock_real);
    let real = one_shot(&sock_real, &model).await;
    let _ = std::fs::remove_file(&sock_real);

    assert!(
        !real.trim().is_empty(),
        "real local engine produced text (got empty)"
    );
    assert!(
        !real.contains(MOCK_SIGNATURE),
        "text must come from the real engine, not the mock fallback (got: {real:?})"
    );
    eprintln!("ggml command-layer real reply: {real}");
}
