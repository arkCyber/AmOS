//! Headless AI command-layer e2e: drive the exact RPC core the Tauri AI bridge
//! commands use (`get_status` + `ask_ai_agent`'s unary `stream_chat`) against a
//! real `amos-ai` tonic server on a UDS — no Tauri app, no GUI/WebView.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use amos_ai::server::AiAgentService;
use amos_proto::ai_agent::ai_agent_server::AiAgentServer;
use amos_proto::ai_agent::AgentRequest;
use amos_tauri_lib::ai_bridge::{ask_daemon, fetch_status, AiBridge};
use tokio_stream::wrappers::UnixListenerStream;

/// Start a real AI daemon (mock backend, deterministic, no env dependence) on a UDS.
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

#[tokio::test(flavor = "multi_thread")]
async fn ai_bridge_status_and_chat_roundtrip_real_daemon() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-tauri-ai-e2e-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    // Point the bridge's UDS client at this daemon (resolved from env on connect).
    std::env::set_var("AMOS_SOCKET", &path);
    std::env::set_var("AMOS_BACKEND", "mock");

    let daemon = spawn_ai_daemon(&path).await;
    // Give the listener a moment to accept.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    let bridge = AiBridge::new();

    // get_status (the exact body of the `get_status` command).
    let status = fetch_status(&bridge)
        .await
        .expect("get_status over real daemon");
    assert!(status.running, "daemon reports running");
    assert!(status.uptime_seconds >= 0);

    // ask_ai_agent's RPC core: unary stream_chat over the same daemon.
    let req = AgentRequest {
        session_id: "e2e".into(),
        prompt: "ping".into(),
        context: Default::default(),
    };
    let events = ask_daemon(&bridge, req)
        .await
        .expect("stream_chat over real daemon");
    assert!(!events.is_empty(), "daemon returned reply frames");
    let text: String = events.iter().map(|e| e.token.clone()).collect();
    assert!(!text.trim().is_empty(), "reply carried tokens");
    assert!(
        events.last().is_some_and(|e| e.done),
        "reply stream ends with a done marker"
    );

    daemon.abort();
    let _ = std::fs::remove_file(&path);
}
