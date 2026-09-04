//! `status_once` — probe a *running* amos-ai daemon's unary `get_status` RPC.
//!
//! A cheap liveness/readiness check (no generation). Usage:
//!   cargo run -p amos-ai --example status_once -- /tmp/amos-ai.sock

use std::path::PathBuf;

use amos_proto::ai_agent::ai_agent_client::AiAgentClient;
use amos_proto::ai_agent::StatusRequest;
use anyhow::{anyhow, Result};
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
    let socket = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("usage: status_once <socket>"))?;
    let mut client = AiAgentClient::new(uds_channel(socket).await?);
    let reply = client
        .get_status(tonic::Request::new(StatusRequest {}))
        .await
        .map_err(|e| anyhow!("get_status failed: {e}"))?
        .into_inner();
    println!(
        "running={} model={} engine={} engine_model={} degraded={} asr={} accel={}",
        reply.running,
        reply.model,
        reply.engine,
        reply.engine_model,
        reply.degraded,
        reply.asr,
        if reply.accelerator.is_empty() {
            "none"
        } else {
            reply.accelerator.as_str()
        }
    );
    if let Some(p) = reply.profile {
        println!(
            "profile: decode_tokens_per_sec={:.2} ttft_ms={:.2} decode_tokens_total={} decode_runs={}",
            p.decode_tokens_per_sec, p.ttft_ms, p.decode_tokens_total, p.decode_runs
        );
    }
    if let Some(e) = reply.energy {
        println!(
            "energy: mode={} reason={} cap_inference={} throttle_background={} ticks={}",
            e.sensor_mode, e.reason, e.cap_inference, e.throttle_background, e.ticks
        );
    }
    if let Some(g) = reply.governor {
        println!(
            "governor: mode={} reason={} cap_inference={} throttle_background={} ticks={}",
            g.sensor_mode, g.reason, g.cap_inference, g.throttle_background, g.ticks
        );
    }
    Ok(())
}
