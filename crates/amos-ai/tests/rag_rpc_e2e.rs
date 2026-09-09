//! Daemon e2e: the offline local vector-retrieval `Rag` service over a real UDS.
//!
//! Boots the real `amos_ai::server::serve()` (own test binary so its socket name
//! can't race the other integration tests) with the deterministic mock embedder
//! (`AMOS_RAG_EMBEDDER=mock`), then drives the generated `RagClient`: index a
//! passage, retrieve it back by a self-matching query (deterministic mock ⇒ the
//! stored embedding matches itself exactly), confirm the passage text comes back
//! for citations, then remove it and see it gone. This proves the daemon →
//! System-UI gRPC path the Notes "ask my files" flow will consume.
//!
//! Honest scope: the mock embedder is **not semantic** — this e2e only proves the
//! plumbing (index → embed → top-k → passage), never that "similar text ⇒
//! nearest". Real relevance comes from the Ollama embedding model on device.

use amos_proto::ai_agent::rag_client::RagClient;
use amos_proto::ai_agent::{RagIndexRequest, RagQueryRequest, RagRemoveRequest, RagStatusRequest};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

static SEQ: AtomicU64 = AtomicU64::new(0);

async fn connect(path: &std::path::Path) -> Result<RagClient<tonic::transport::Channel>, String> {
    let owned_path = path.to_owned();
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned_path.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(RagClient::new(channel))
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..200 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rag_index_query_remove_over_uds() {
    // Deterministic offline embedder — never lets an inherited env pick a real
    // model for this e2e.
    std::env::set_var("AMOS_RAG_EMBEDDER", "mock");

    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let path: PathBuf = std::env::temp_dir().join(format!("amos-ai-rag-e2e-{seq}.sock"));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });

    wait_for_socket(&path).await;
    assert!(path.exists(), "daemon socket came up");

    let mut client = connect(&path).await.expect("connect to daemon");

    // Fresh state: empty, mock embedder, dimension unknown.
    let fresh = client
        .status(RagStatusRequest {})
        .await
        .expect("status")
        .into_inner();
    assert_eq!(fresh.indexed, 0);
    assert_eq!(fresh.embedder, "mock");

    // Index one passage, then retrieve it back by a self-matching query.
    let text = "关于 q4 预算的唯一独份会议记录".to_string();
    let idx = client
        .index(RagIndexRequest {
            id: "note:a".into(),
            text: text.clone(),
        })
        .await
        .expect("index")
        .into_inner();
    assert!(idx.indexed);
    assert!(idx.dimension > 0);

    let q = client
        .query(RagQueryRequest {
            query: text.clone(),
            top_k: 0, // default
        })
        .await
        .expect("query")
        .into_inner();
    assert_eq!(q.count, 1, "exactly one hit for a self-matching query");
    assert_eq!(q.hits[0].id, "note:a");
    assert_eq!(
        q.hits[0].passage, text,
        "passage text returned for citations"
    );
    assert!((q.hits[0].score - 1.0).abs() < 1e-6);

    // Status now reflects one indexed passage.
    let after = client
        .status(RagStatusRequest {})
        .await
        .expect("status")
        .into_inner();
    assert_eq!(after.indexed, 1);
    assert_eq!(after.dimension, idx.dimension);

    // Remove → empty again, and a query returns no hits (not an error).
    let rm = client
        .remove(RagRemoveRequest {
            id: "note:a".into(),
        })
        .await
        .expect("remove")
        .into_inner();
    assert!(rm.removed);
    let empty = client
        .status(RagStatusRequest {})
        .await
        .expect("status")
        .into_inner();
    assert_eq!(empty.indexed, 0);
    let q2 = client
        .query(RagQueryRequest {
            query: text,
            top_k: 5,
        })
        .await
        .expect("query ok on empty index")
        .into_inner();
    assert!(q2.hits.is_empty());

    let _ = std::fs::remove_file(&path);
    server.abort();
}
