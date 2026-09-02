//! End-to-end test of the amos RPC pipeline over a real Unix Domain Socket:
//! server (amos-ai) + client (as used by the Tauri bridge).

use amos_proto::ai_agent::{ai_agent_client::AiAgentClient, AgentRequest, StatusRequest};
use std::path::PathBuf;
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

async fn connect(
    path: &std::path::Path,
) -> Result<AiAgentClient<tonic::transport::Channel>, String> {
    let owned_path = path.to_owned();
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned_path.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(AiAgentClient::new(channel))
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..50 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stream_chat_delivers_tokens_then_done() {
    let path: PathBuf = std::env::temp_dir().join(format!("amos-test-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    // Spawn the server on a background task.
    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });

    wait_for_socket(&path).await;
    let mut client = connect(&path).await.expect("connect");

    // Status probe.
    let status = client
        .get_status(StatusRequest {})
        .await
        .expect("get_status")
        .into_inner();
    assert!(status.running);
    assert!(!status.model.is_empty());

    // Streaming chat.
    let mut stream = client
        .stream_chat(AgentRequest {
            session_id: "test-session".into(),
            prompt: "你好，Amos".into(),
            context: Default::default(),
        })
        .await
        .expect("stream_chat")
        .into_inner();

    let mut count = 0usize;
    let mut seen_done = false;
    let mut full = String::new();
    while let Ok(Some(chunk)) = stream.message().await {
        if !chunk.token.is_empty() {
            count += 1;
            full.push_str(&chunk.token);
        }
        if chunk.done {
            seen_done = true;
            break;
        }
    }
    assert!(seen_done, "stream must terminate with a done frame");
    assert!(count > 0, "expected multiple token frames");
    assert!(full.contains("Amos"), "reply should reference the prompt");

    server.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn stream_chat_semantic_intent_returns_ui_card() {
    let path: PathBuf = std::env::temp_dir().join(format!("amos-card-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;

    let mut client = connect(&path).await.expect("connect");

    // "查一下钱包余额" maps to a wallet intent → structured UiCard on the done frame.
    let mut stream = client
        .stream_chat(AgentRequest {
            session_id: "card-session".into(),
            prompt: "查一下钱包余额".into(),
            context: Default::default(),
        })
        .await
        .expect("stream_chat")
        .into_inner();

    let mut got_card = None;
    while let Ok(Some(chunk)) = stream.message().await {
        if let Some(card) = chunk.card {
            if !card.kind.is_empty() {
                got_card = Some(card);
            }
        }
        if chunk.done {
            break;
        }
    }

    let card = got_card.expect("stream_chat should attach a UiCard to the done frame");
    assert_eq!(
        card.kind, "wallet",
        "wallet intent should yield a wallet card"
    );
    assert!(
        card.actions.iter().any(|a| a.contains("设置")),
        "wallet card offers an action"
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}
