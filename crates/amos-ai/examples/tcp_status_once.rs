//! `tcp_status_once` — probe a *running* amos-ai daemon over **loopback TCP**.
//!
//! Exercises the `AMOS_TCP_ADDR` transport (see `crates/amos-ai/src/server.rs`
//! `resolve_tcp_addr`) used for on-device / host-target split debugging without a
//! Unix socket. Usage:
//!   cargo run -p amos-ai --example tcp_status_once -- [host:port]
//! (defaults to 127.0.0.1:8787)

use amos_proto::ai_agent::ai_agent_client::AiAgentClient;
use amos_proto::ai_agent::StatusRequest;
use anyhow::{anyhow, Result};
use tonic::transport::Endpoint;

#[tokio::main]
async fn main() -> Result<()> {
    let addr = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1:8787".to_string());

    // gRPC (h2c) over plain TCP — no TLS, no UDS.
    let endpoint = Endpoint::try_from(format!("http://{addr}"))
        .map_err(|e| anyhow!("bad endpoint {addr}: {e}"))?
        .connect_timeout(std::time::Duration::from_secs(3));
    let channel = endpoint
        .connect()
        .await
        .map_err(|e| anyhow!("daemon not reachable at tcp {addr}: {e}"))?;

    let mut client = AiAgentClient::new(channel);
    let reply = client
        .get_status(tonic::Request::new(StatusRequest {}))
        .await
        .map_err(|e| anyhow!("get_status failed: {e}"))?
        .into_inner();
    println!(
        "running={} engine={} engine_model={} degraded={} asr={} accel={}",
        reply.running,
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
    Ok(())
}
