//! `rag_once` — headless smoke against a *running* amos-ai daemon's mounted
//! `Rag` service (offline local vector retrieval, mock embedder) over the shared
//! UDS.
//!
//! Reads the current index status, indexes one passage under `note:a`, retrieves
//! it back with a self-matching query (deterministic mock ⇒ the stored embedding
//! matches itself, so the passage + score come back), then removes it and reads
//! status again. This is the real-device "index → query" proof for the offline
//! RAG path that needs no Ollama/model.
//!
//! Usage:
//!   cargo run -p amos-ai --example rag_once -- /data/local/tmp/amos-ai.sock

use std::path::PathBuf;

use amos_proto::ai_agent::rag_client::RagClient;
use amos_proto::ai_agent::{RagIndexRequest, RagQueryRequest, RagRemoveRequest, RagStatusRequest};
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
    let target = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow!("usage: rag_once <socket-path | http://host:port>"))?;

    let rag = if target.contains("://") {
        // TCP loopback mode (used when SELinux blocks a shell UDS bind):
        // AMOS_TCP_ADDR makes the daemon serve plaintext h2c on that address.
        let channel = Endpoint::try_from(target)
            .map_err(|e| anyhow!("bad http endpoint: {e}"))?
            .connect()
            .await
            .map_err(|e| anyhow!("daemon not reachable at tcp endpoint: {e}"))?;
        RagClient::new(channel)
    } else {
        RagClient::new(uds_channel(PathBuf::from(&target)).await?)
    };
    let mut rag = rag;

    let before = rag.status(RagStatusRequest {}).await?.into_inner();
    println!(
        "before: indexed={} dim={} embedder={}",
        before.indexed, before.dimension, before.embedder
    );

    let text = "设备真机离线检索的独份预算正文".to_string();
    let idx = rag
        .index(RagIndexRequest {
            id: "note:a".into(),
            text: text.clone(),
        })
        .await?
        .into_inner();
    println!("indexed note:a dim={}", idx.dimension);

    let q = rag
        .query(RagQueryRequest {
            query: text,
            top_k: 3,
        })
        .await?
        .into_inner();
    println!("query hits={}", q.hits.len());
    for h in &q.hits {
        println!(
            "  hit id={} score={:.6} passage_len={}",
            h.id,
            h.score,
            h.passage.len()
        );
    }
    if let Some(first) = q.hits.first() {
        println!("  top id={} passage='{}'", first.id, first.passage);
    }

    let removed = rag
        .remove(RagRemoveRequest {
            id: "note:a".into(),
        })
        .await?
        .into_inner();
    println!("remove note:a removed={}", removed.removed);

    let after = rag.status(RagStatusRequest {}).await?.into_inner();
    println!(
        "after: indexed={} dim={} embedder={}",
        after.indexed, after.dimension, after.embedder
    );
    Ok(())
}
