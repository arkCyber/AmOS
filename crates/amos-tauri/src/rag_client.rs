//! Tauri <-> daemon offline local vector retrieval (`Rag` service) bridge.
//!
//! The Svelte Notes/Ai "ask my files" surface calls these commands; each opens a
//! `RagClient` over the OS daemon's Unix Domain Socket (same socket as
//! `AiAgent`/`Sensor`/`PrivacyService`/`NetGuardService`), runs the RPC, and
//! returns a serializable mirror (prost types don't impl `Serialize`). The
//! **daemon is the single authority**: it owns the embedder (mock on host,
//! Ollama on device), the vector index, and the durable state. If the daemon is
//! absent the commands fail with a descriptive error — the UI shows "notes search
//! offline", never a fabricated hit.
//!
//! Mirrors the `netguard` / `privacy_client` bridge shape. Wire contract:
//! `proto/ai_agent.proto` `service Rag`; `rag_query` `top_k` is `0 => default`,
//! the daemon caps it.

use amos_proto::ai_agent::rag_client::RagClient;
use amos_proto::ai_agent::{
    RagHit, RagIndexRequest, RagQueryReply, RagQueryRequest, RagRemoveRequest, RagStatusReply,
    RagStatusRequest,
};
use serde::Serialize;

async fn build_channel() -> Result<crate::daemon::DaemonChannel, String> {
    crate::daemon::channel().await
}

/// Serializable mirror of one daemon `RagStatusReply`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RagStatusOut {
    pub indexed: u64,
    pub dimension: u32,
    /// "mock" (host/offline) | "ollama" (real local model) — honest backend label.
    pub embedder: String,
}

/// Serializable mirror of one daemon `RagHit`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RagHitOut {
    pub id: String,
    pub score: f64,
    /// Indexed text for this id (for citations / building a context prompt).
    pub passage: String,
}

/// Serializable mirror of a daemon `RagQueryReply`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RagQueryOut {
    pub hits: Vec<RagHitOut>,
    pub count: u32,
}

/// Serializable mirror of a daemon `RagIndexReply`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RagIndexOut {
    pub indexed: bool,
    pub dimension: u32,
}

/// Serializable mirror of a daemon `RagRemoveReply`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RagRemoveOut {
    pub removed: bool,
}

/// Map a daemon `RagStatusReply` onto its serializable mirror (pure; unit-tested).
fn to_status(r: &RagStatusReply) -> RagStatusOut {
    RagStatusOut {
        indexed: r.indexed,
        dimension: r.dimension,
        embedder: r.embedder.clone(),
    }
}

/// Map a daemon `RagHit` onto its serializable mirror (pure; unit-tested).
fn to_hit(r: &RagHit) -> RagHitOut {
    RagHitOut {
        id: r.id.clone(),
        score: r.score,
        passage: r.passage.clone(),
    }
}

/// Map a daemon `RagQueryReply` onto its serializable mirror (pure; unit-tested).
fn to_query(r: &RagQueryReply) -> RagQueryOut {
    RagQueryOut {
        hits: r.hits.iter().map(to_hit).collect(),
        count: r.count,
    }
}

/// Index (or re-index on edit) a passage under an id in the daemon.
#[tauri::command]
pub async fn rag_index(id: String, text: String) -> Result<RagIndexOut, String> {
    let mut client = RagClient::new(build_channel().await?);
    let reply = client
        .index(RagIndexRequest { id, text })
        .await
        .map_err(|e| format!("notes-index failed: {e}"))?
        .into_inner();
    Ok(RagIndexOut {
        indexed: reply.indexed,
        dimension: reply.dimension,
    })
}

/// Drop an indexed passage from retrieval in the daemon.
#[tauri::command]
pub async fn rag_remove(id: String) -> Result<RagRemoveOut, String> {
    let mut client = RagClient::new(build_channel().await?);
    let reply = client
        .remove(RagRemoveRequest { id })
        .await
        .map_err(|e| format!("notes-index remove failed: {e}"))?
        .into_inner();
    Ok(RagRemoveOut {
        removed: reply.removed,
    })
}

/// Retrieve the nearest indexed passages to `query` (embed + top-k in the daemon).
#[tauri::command]
pub async fn rag_query(query: String, top_k: u32) -> Result<RagQueryOut, String> {
    let mut client = RagClient::new(build_channel().await?);
    let reply = client
        .query(RagQueryRequest { query, top_k })
        .await
        .map_err(|e| format!("notes search failed: {e}"))?
        .into_inner();
    Ok(to_query(&reply))
}

/// Read the daemon's current index size / dimension / honest embedder label.
#[tauri::command]
pub async fn rag_status() -> Result<RagStatusOut, String> {
    let mut client = RagClient::new(build_channel().await?);
    let reply = client
        .status(RagStatusRequest {})
        .await
        .map_err(|e| format!("notes-index status failed: {e}"))?
        .into_inner();
    Ok(to_status(&reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_status_verbatim() {
        let s = to_status(&RagStatusReply {
            indexed: 7,
            dimension: 384,
            embedder: "mock".into(),
        });
        assert_eq!(s.indexed, 7);
        assert_eq!(s.dimension, 384);
        assert_eq!(s.embedder, "mock");
    }

    #[test]
    fn maps_query_hits_with_passages() {
        let q = to_query(&RagQueryReply {
            hits: vec![RagHit {
                id: "note:a".into(),
                score: 0.91,
                passage: "预算正文".into(),
            }],
            count: 1,
        });
        assert_eq!(q.count, 1);
        assert_eq!(q.hits.len(), 1);
        assert_eq!(q.hits[0].id, "note:a");
        assert!((q.hits[0].score - 0.91).abs() < 1e-9);
        assert_eq!(q.hits[0].passage, "预算正文");
    }

    #[test]
    fn maps_index_and_remove_replies() {
        let idx = RagIndexOut {
            indexed: true,
            dimension: 8,
        };
        assert!(idx.indexed);
        assert_eq!(idx.dimension, 8);
        assert!(RagRemoveOut { removed: true }.removed);
    }
}
