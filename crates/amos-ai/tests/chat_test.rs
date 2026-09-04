//! End-to-end test of the *bidirectional* `Chat` RPC over a real UDS: the path
//! that voice / multi-turn / cancel interaction flows through. Verifies text
//! prompts stream tokens, audio is fed through the (mock) ASR to an answered
//! turn, and a Cancel closes the stream.

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

/// Push-to-talk release: signal the recognizer to force-finalize the current
/// utterance instead of waiting for its own endpoint/VAD.
fn audio_end() -> ClientMessage {
    ClientMessage {
        payload: Some(Payload::AudioEnd(true)),
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
        payload: Some(Payload::Audio(vec![0u8; 2560])), // 640 f32 samples → mock endpoint
    })
    .await
    .expect("send audio frame");

    let (full, done) = collect_until_done(&mut stream).await;
    assert!(done, "audio turn terminates with a done frame");
    assert!(
        !full.trim().is_empty(),
        "recognized audio is answered, got: {full:?}"
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}
#[tokio::test(flavor = "multi_thread")]
async fn bidi_chat_audio_end_finalizes_a_short_utterance() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-audio-end-{}.sock", std::process::id()));
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

    // A short utterance (160 f32 samples = 640 bytes) that has NOT reached the
    // recognizer's own endpoint (needs 640 samples) — only the push-to-talk
    // `AudioEnd` release turns it into a recognized turn.
    tx.send(ClientMessage {
        payload: Some(Payload::Audio(vec![0u8; 640])),
    })
    .await
    .expect("send short audio frame");
    tx.send(audio_end()).await.expect("send audio_end");

    let (full, done) = collect_until_done(&mut stream).await;
    assert!(done, "audio_end turn terminates with a done frame");
    assert!(
        full.contains("Amos"),
        "audio_end force-finalizes into an answered turn; got: {full:?}"
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn stray_audio_end_does_not_wedge_and_text_prompt_still_answers() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-audio-end-stray-{}.sock", std::process::id()));
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

    // A stray AudioEnd with no preceding audio must not error or wedge the stream
    // (the recognizer's `finish` simply has nothing real to finalize).
    tx.send(audio_end()).await.expect("send stray audio_end");
    // A real text prompt follows on the same stream and must still be answered.
    tx.send(prompt("ping")).await.expect("send text prompt");

    // Collect turns until one answers the "ping" prompt (the stray AudioEnd may
    // itself produce a (mock) turn first; keep going past it).
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(10));
    tokio::pin!(deadline);
    let mut got_ping = false;
    let mut cur = String::new();
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            msg = stream.message() => match msg {
                Ok(Some(chunk)) => {
                    if !chunk.token.is_empty() { cur.push_str(&chunk.token); }
                    if chunk.done {
                        if cur.contains("ping") {
                            got_ping = true;
                            break;
                        }
                        cur.clear();
                    }
                }
                _ => break,
            },
        }
    }

    server.abort();
    let _ = std::fs::remove_file(&path);
    assert!(
        got_ping,
        "a text prompt sent after a stray AudioEnd must still be answered"
    );
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
