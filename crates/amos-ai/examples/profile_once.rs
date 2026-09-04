//! `profile_once` — headless smoke of the daemon's rolling inference profile.
//!
//! Sends one short `stream_chat` turn to a *running* amos-ai daemon, then reads
//! `get_status` and prints `StatusReply.profile` (`ProfileMetrics`) plus the
//! engine truth (engine/degraded/asr). Proves decode profiling + TTFT are wired
//! end-to-end without a GUI.
//!
//! Usage:
//!   cargo run -p amos-ai --example profile_once -- /tmp/amos-ai.sock [prompt]

use std::path::PathBuf;

use amos_proto::ai_agent::ai_agent_client::AiAgentClient;
use amos_proto::ai_agent::{AgentRequest, StatusRequest};
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
        .ok_or_else(|| anyhow!("usage: profile_once <socket> [prompt]"))?;
    let prompt = args.get(1).cloned().unwrap_or_else(|| "hello".to_string());

    let mut client = AiAgentClient::new(uds_channel(socket).await?);

    // One short text turn so the daemon records a decode run + TTFT.
    let mut stream = client
        .stream_chat(tonic::Request::new(AgentRequest {
            session_id: "profile-once".into(),
            prompt,
            context: Default::default(),
        }))
        .await
        .context("stream_chat failed")?
        .into_inner();
    let mut done = false;
    while let Ok(Some(chunk)) = stream.message().await {
        if chunk.done {
            done = true;
            break;
        }
    }
    if !done {
        anyhow::bail!("reply stream ended without a done marker");
    }

    let reply = client
        .get_status(tonic::Request::new(StatusRequest {}))
        .await
        .context("get_status failed")?
        .into_inner();
    println!(
        "engine={} engine_model={} degraded={} asr={}",
        reply.engine, reply.engine_model, reply.degraded, reply.asr
    );
    if let Some(p) = reply.profile {
        println!(
            "profile: decode_tokens_per_sec={:.2} ttft_ms={:.2} decode_tokens_total={} decode_runs={}",
            p.decode_tokens_per_sec, p.ttft_ms, p.decode_tokens_total, p.decode_runs
        );
    }
    Ok(())
}
