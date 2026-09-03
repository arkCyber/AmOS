//! `chat_once` — live smoke against a *running* amos-ai daemon.
//!
//! Sends one real `stream_chat` request over the daemon's UDS and prints the
//! token stream until the terminal `done` chunk — proving CLI → daemon →
//! provider (local Ollama / cloud DeepSeek / mock) end to end, no GUI.
//!
//! Usage:
//!   cargo run -p amos-ai --example chat_once -- /tmp/amos-ai.sock "你的问题"

use std::path::PathBuf;

use amos_proto::ai_agent::ai_agent_client::AiAgentClient;
use amos_proto::ai_agent::AgentRequest;
use anyhow::{anyhow, Context, Result};
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

async fn uds_channel(socket: PathBuf) -> Result<tonic::transport::Channel> {
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| anyhow!(e.to_string()))?;
    endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let socket = socket.clone();
            async move {
                let stream = UnixStream::connect(socket).await?;
                Ok::<_, std::io::Error>(TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| anyhow!("daemon not reachable at socket: {e}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let socket = args
        .first()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("usage: chat_once <socket> <prompt>"))?;
    let prompt = args.get(1).context("prompt is required")?.to_string();

    let mut client = AiAgentClient::new(uds_channel(socket).await?);
    let req = AgentRequest {
        session_id: "live-smoke".into(),
        prompt,
        context: Default::default(),
    };
    let mut stream = client
        .stream_chat(tonic::Request::new(req))
        .await
        .map_err(|e| anyhow!("stream_chat failed: {e}"))?
        .into_inner();

    let mut got_done = false;
    while let Ok(Some(chunk)) = stream.message().await {
        if !chunk.token.is_empty() {
            print!("{}", chunk.token);
        }
        if chunk.done {
            got_done = true;
            break;
        }
    }
    println!();
    if !got_done {
        anyhow::bail!("reply stream ended without a done marker");
    }
    Ok(())
}
