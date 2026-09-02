//! End-to-end test of the *bidirectional* `Chat` RPC over a real UDS: the path
//! that voice / multi-turn / cancel interaction flows through. Verifies text
//! prompts stream tokens, audio is acknowledged (ASR not wired yet), and a
//! Cancel closes the stream.

use amos_proto::ai_agent::{
    ai_agent_client::AiAgentClient, client_message::Payload, ClientMessage,
};
use std::path::PathBuf;
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

async fn connect(
    path: &std::path::Path,
) -> Result<AiAgentClient<tonic::transport::Channel>, String> {
    let owned = path.to_owned();
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
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

fn prompt(p: &str) -> ClientMessage {
    ClientMessage {
        payload: Some(Payload::Prompt(p.to_string())),
    }
}

fn cancel() -> ClientMessage {
    ClientMessage {
        payload: Some(Payload::Cancel("stop".to_string())),
    }
}

/// Collect all chunks until the done frame; returns the concatenated reply.
async fn collect_until_done(
    stream: &mut tonic::Streaming<amos_proto::ai_agent::AgentChunk>,
) -> (String, bool) {
    let mut full = String::new();
    let mut done = false;
    while let Ok(Some(chunk)) = stream.message().await {
        if !chunk.token.is_empty() {
            full.push_str(&chunk.token);
        }
        if chunk.done {
            done = true;
            break;
        }
    }
    (full, done)
}

#[tokio::test(flavor = "multi_thread")]
async fn bidi_chat_prompt_streams_tokens_then_done() {
    let path: PathBuf = std::env::temp_dir().join(format!("amos-bidi-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;

    let mut client = connect(&path).await.expect("connect");
    let (tx, rx) = mpsc::channel(64);
    let mut stream = client
        .chat(ReceiverStream::new(rx))
        .await
        .expect("open bidi chat")
        .into_inner();

    tx.send(prompt("你好，Amos")).await.expect("send prompt");
    let (full, done) = collect_until_done(&mut stream).await;
    assert!(done, "stream must terminate with a done frame");
    assert!(!full.is_empty(), "expected a reply");
    assert!(full.contains("Amos"), "reply should reference the prompt");

    server.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn bidi_chat_semantic_intent_returns_ui_card() {
    let path: PathBuf = std::env::temp_dir().join(format!("amos-card-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;

    let mut client = connect(&path).await.expect("connect");
    let (tx, rx) = mpsc::channel(64);
    let mut stream = client
        .chat(ReceiverStream::new(rx))
        .await
        .expect("open bidi chat")
        .into_inner();

    // "播放一首歌" maps to a media intent → a structured UiCard.
    tx.send(prompt("帮我播放一首歌"))
        .await
        .expect("send prompt");

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

    let card = got_card.expect("a UiCard should be attached to the done frame");
    assert_eq!(card.kind, "media", "media intent should yield a media card");
    assert!(
        card.actions.iter().any(|a| a.contains("音乐")),
        "media card offers an action"
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn bidi_chat_audio_is_acknowledged() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-audio-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;

    let mut client = connect(&path).await.expect("connect");
    let (tx, rx) = mpsc::channel(64);
    let mut stream = client
        .chat(ReceiverStream::new(rx))
        .await
        .expect("open bidi chat")
        .into_inner();

    tx.send(ClientMessage {
        payload: Some(Payload::Audio(vec![0u8; 1024])),
    })
    .await
    .expect("send audio frame");

    let (full, done) = collect_until_done(&mut stream).await;
    assert!(done, "audio turn terminates with a done frame");
    assert!(
        full.contains("语音") && full.contains("1024"),
        "audio is acknowledged with an honest note, got: {full:?}"
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn bidi_chat_cancel_closes_stream() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-cancel-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;

    let mut client = connect(&path).await.expect("connect");
    let (tx, rx) = mpsc::channel(64);
    let mut stream = client
        .chat(ReceiverStream::new(rx))
        .await
        .expect("open bidi chat")
        .into_inner();

    // One turn completes, then a Cancel makes the server close the stream.
    tx.send(prompt("hi")).await.expect("send prompt");
    let (_full, done) = collect_until_done(&mut stream).await;
    assert!(done, "first turn completed");

    tx.send(cancel()).await.expect("send cancel");
    // After Cancel the server stops reading; the stream should end.
    assert!(
        stream.message().await.unwrap().is_none(),
        "cancel closes the bidi stream"
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn bidi_chat_cancel_interrupts_mid_generation() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-cancel-mid-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;

    let mut client = connect(&path).await.expect("connect");
    let (tx, rx) = mpsc::channel(64);
    let mut stream = client
        .chat(ReceiverStream::new(rx))
        .await
        .expect("open bidi chat")
        .into_inner();

    // A long prompt keeps generation streaming for a while (each token sleeps
    // ~18ms), so a Cancel sent a short time later arrives mid-generation.
    tx.send(prompt(&"你好".repeat(100)))
        .await
        .expect("send long prompt");

    // Let a few tokens stream, then cancel while still generating.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    tx.send(cancel()).await.expect("send cancel mid-generation");

    // Collect until the stream ends: it must NOT deliver a done frame.
    let mut saw_done = false;
    while let Ok(Some(chunk)) = stream.message().await {
        if chunk.done {
            saw_done = true;
        }
    }
    assert!(
        !saw_done,
        "cancel interrupts generation before the done frame"
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}
