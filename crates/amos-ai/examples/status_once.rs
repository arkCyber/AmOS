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
    println!("running={} model={}", reply.running, reply.model);
    Ok(())
}
