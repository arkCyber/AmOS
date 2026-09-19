//! `status_once` — probe a *running* amos-translate daemon's `get_status` RPC.
//! Usage:
//!   cargo run -p amos-translate --example status_once -- /tmp/amos-translate.sock

use std::path::PathBuf;

use amos_proto::translate::translator_client::TranslatorClient;
use amos_proto::translate::StatusRequest;
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
    let mut client = TranslatorClient::new(uds_channel(socket).await?);
    let reply = client
        .get_status(tonic::Request::new(StatusRequest {}))
        .await
        .map_err(|e| anyhow!("get_status failed: {e}"))?
        .into_inner();
    println!("running={} model={}", reply.running, reply.model);
    Ok(())
}
