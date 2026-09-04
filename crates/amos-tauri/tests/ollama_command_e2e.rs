//! Headless Ollama command-layer e2e: run the AI daemon's **real local Ollama
//! engine** through the exact RPC core the Tauri AI bridge commands use
//! (`ask_daemon` / unary `stream_chat`).
//!
//! This is the regression gate that proves the daemon serves *real* tokens when
//! an Ollama server + model is available — i.e. that `AMOS_BACKEND=ollama` no
//! longer degrades to the deterministic mock unless Ollama is genuinely absent.
//!
//! * Skipped gracefully when no reachable Ollama reports an installed model.
//! * When it does run, the reply must NOT carry the mock signature `[amos-ai]`.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use amos_ai::server::AiAgentService;
use amos_proto::ai_agent::ai_agent_server::AiAgentServer;
use amos_proto::ai_agent::AgentRequest;
use amos_tauri_lib::ai_bridge::{ask_daemon, AiBridge};
use tokio_stream::wrappers::UnixListenerStream;

const MOCK_SIGNATURE: &str = "[amos-ai]";

/// The chat model to gate against, from `AMOS_OLLAMA_E2E_MODEL`. Empty when the
/// operator has not opted in — the gate then skips (CI / offline machines stay
/// green). Pass a real chat model id (and, if your Ollama's `/v1` is token-gated,
/// export `AMOS_OLLAMA_API_KEY`) to actually exercise real inference.
fn e2e_model() -> Option<String> {
    match std::env::var("AMOS_OLLAMA_E2E_MODEL") {
        Ok(m) if !m.trim().is_empty() => Some(m),
        _ => None,
    }
}

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

#[tokio::test(flavor = "multi_thread")]
async fn ollama_command_layer_streams_real_tokens_when_server_present() {
    let Some(model) = e2e_model() else {
        eprintln!(
            "skip real-Ollama gate: set AMOS_OLLAMA_E2E_MODEL to a chat model id \
             (e.g. AMOS_OLLAMA_E2E_MODEL=qwen2.5) to run it"
        );
        return;
    };
    let host =
        std::env::var("AMOS_OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".to_string());

    let socket: PathBuf = std::env::temp_dir().join(format!(
        "amos-tauri-ollama-real-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&socket);

    set("AMOS_SOCKET", &socket.to_string_lossy());
    set("AMOS_BACKEND", "ollama");
    set("AMOS_OLLAMA_HOST", &host);
    set("AMOS_MODEL", &model);

    let daemon = spawn_ai_daemon(&socket).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    let bridge = AiBridge::new();
    let req = AgentRequest {
        session_id: "ollama-e2e".into(),
        prompt: "Reply with the single word: AMOS".into(),
        context: Default::default(),
    };
    let events = ask_daemon(&bridge, req)
        .await
        .expect("stream_chat over ollama daemon");
    let text: String = events.iter().map(|e| e.token.clone()).collect();
    let finished = events.iter().any(|e| e.done);

    daemon.abort();
    let _ = std::fs::remove_file(&socket);

    assert!(
        finished,
        "ollama turn must end with a done frame; got text: {text:?}"
    );
    assert!(
        !text.trim().is_empty(),
        "real Ollama engine produced text (got empty)"
    );
    assert!(
        !text.contains(MOCK_SIGNATURE),
        "text must come from the real Ollama engine, not the mock fallback (got: {text:?})"
    );
    eprintln!("ollama command-layer real reply (model={model}): {text}");
}
