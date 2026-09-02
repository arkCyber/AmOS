//! End-to-end integration test of the Hermes-Rust agent backend.
//!
//! Spawns the real `amos-ai` daemon with `AMOS_BACKEND=hermes` pointing at a
//! lightweight mock that faithfully reproduces Hermes-Rust's OpenAI-compatible
//! `/v1/chat/completions` SSE format (native `{"type":"token"}` frames + a
//! terminal OpenAI delta). Verifies:
//!   * text prompts stream token-by-token (deduplicated, no echo of the delta),
//!   * a semantic card intent returns a `UiCard` without hitting the backend.

use amos_proto::ai_agent::{
    ai_agent_client::AiAgentClient, client_message::Payload, ClientMessage,
};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
    // Under parallel `make test` the spawned amos-ai binary can be slow to bind
    // (large binary, CPU contention), so wait generously and verify it is
    // actually connectable rather than just that the file exists.
    for _ in 0..150 {
        if UnixStream::connect(path).await.is_ok() {
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

/// A minimal HTTP server that answers `POST /v1/chat/completions` with
/// Hermes-Rust-style SSE frames (native token events + a terminal OpenAI delta).
/// Used when `HERMES_E2E_URL` is not set (deterministic in CI).
fn spawn_mock_hermes() -> std::net::SocketAddr {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            // Handle each connection in its own task so the daemon's `/health`
            // probe and the chat POST never serialize or race on one thread.
            while let Ok((sock, _)) = listener.accept().await {
                tokio::spawn(serve_conn(sock));
            }
        });
    });
    addr
}

/// Serve one client connection. `GET /health` gets a plain 200 (cheap,
/// connection-close); the chat POST gets the SSE token stream.
async fn serve_conn(mut sock: tokio::net::TcpStream) {
    // Read the full request (headers + Content-Length body) so we never respond
    // while the client is still sending — a premature reply corrupts the
    // exchange and shows up as an intermittent empty stream.
    let Some(req) = read_request(&mut sock).await else {
        return;
    };
    let is_chat = req.contains("/v1/chat/completions");

    if is_chat {
        let mut out = String::from(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        );
        for f in [
            "data: {\"type\":\"thinking\",\"content\":\"...\"}\n\n",
            "data: {\"type\":\"token\",\"content\":\"你\"}\n\n",
            "data: {\"type\":\"token\",\"content\":\"好\"}\n\n",
            "data: {\"type\":\"token\",\"content\":\"，Amos\"}\n\n",
            "data: {\"type\":\"done\",\"content\":\"你好，Amos\"}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好，Amos\"}}]}\n\n",
            "data: [DONE]\n\n",
        ] {
            out.push_str(f);
        }
        let _ = sock.write_all(out.as_bytes()).await;
    } else {
        // Health / model probe: a tiny JSON body.
        let body = "{\"status\":\"ok\"}";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let _ = sock.write_all(resp.as_bytes()).await;
    }
    let _ = sock.shutdown().await;
}

/// Read a full HTTP request (headers + body per `Content-Length`), or `None` on
/// a closed/errored connection.
async fn read_request(sock: &mut tokio::net::TcpStream) -> Option<String> {
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    // Read until the header terminator is present.
    let header_end = loop {
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(idx) = find_header_end(&buf) {
            break idx;
        }
    };
    let content_length = parse_content_length(&buf[..header_end]);
    let body_start = header_end + 4;
    let mut body_received = buf.len().saturating_sub(body_start);
    while body_received < content_length {
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        body_received += n;
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Index just past the `\r\n\r\n` that ends the request headers, if present.
fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Parse `Content-Length` from the request header block.
fn parse_content_length(headers: &[u8]) -> usize {
    std::str::from_utf8(headers)
        .ok()
        .and_then(|h| {
            h.lines().find_map(|l| {
                let l = l.trim();
                let (name, value) = l.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod mock_helpers {
    use super::*;

    #[test]
    fn finds_header_end() {
        let req = b"POST /v1/chat/completions HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello";
        assert_eq!(
            find_header_end(req),
            Some(b"POST /v1/chat/completions HTTP/1.1\r\nContent-Length: 5\r\n\r\n".len() - 4)
        );
        assert_eq!(find_header_end(b"no delimiter here"), None);
    }

    #[test]
    fn parses_content_length() {
        let headers = b"POST / HTTP/1.1\r\nContent-Length: 123\r\nHost: x";
        assert_eq!(parse_content_length(headers), 123);
        assert_eq!(parse_content_length(b"POST / HTTP/1.1\r\nHost: x"), 0);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn hermes_backend_streams_tokens_and_semantic_cards() {
    // Prefer a real Hermes-Rust daemon when `HERMES_E2E_URL` is set; otherwise
    // fall back to the deterministic mock (used by `cargo test` / CI).
    let real = std::env::var("HERMES_E2E_URL")
        .ok()
        .filter(|s| !s.is_empty());
    let endpoint = real
        .clone()
        .unwrap_or_else(|| format!("http://{}", spawn_mock_hermes()));

    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-hermes-e2e-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    // Spawn the real amos-ai daemon configured to use the Hermes backend.
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_amos-ai"))
        .env("AMOS_BACKEND", "hermes")
        .env("AMOS_HERMES_ENDPOINT", &endpoint)
        .env("AMOS_MODEL", "hermes-rust")
        .env("AMOS_SOCKET", &path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn amos-ai");
    wait_for_socket(&path).await;

    let mut client = connect(&path).await.expect("connect");
    let (tx, rx) = mpsc::channel(64);
    let mut stream = client
        .chat(ReceiverStream::new(rx))
        .await
        .expect("open bidi chat")
        .into_inner();

    // 1) Plain text prompt → the Hermes backend streams tokens (deduplicated).
    tx.send(prompt("你好")).await.expect("send text prompt");
    let mut text = String::new();
    let mut saw_done = false;
    let mut saw_card = false;
    while let Ok(Some(chunk)) = stream.message().await {
        text.push_str(&chunk.token);
        if let Some(card) = chunk.card {
            if !card.kind.is_empty() {
                saw_card = true;
            }
        }
        if chunk.done {
            saw_done = true;
            break;
        }
    }
    assert!(saw_done, "stream should terminate with a done frame");
    if real.is_none() {
        assert_eq!(
            text, "你好，Amos",
            "tokens streamed and deduplicated (no delta echo)"
        );
    } else {
        assert!(
            !text.is_empty(),
            "real Hermes-Rust should return some tokens"
        );
        eprintln!("[hermes-e2e] real reply: {text}");
    }
    assert!(!saw_card, "plain text prompt should not produce a card");

    // 2) Semantic intent → a card is returned without hitting the backend.
    tx.send(prompt("帮我播放一首歌"))
        .await
        .expect("send card prompt");
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
    let card = got_card.expect("semantic intent should return a UiCard");
    assert_eq!(card.kind, "media", "media intent yields a media card");

    child.kill().await.ok();
    let _ = std::fs::remove_file(&path);
}
