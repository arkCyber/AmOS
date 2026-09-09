//! Daemon e2e: `Rag` retrieval **survives a daemon restart** via `AMOS_RAG_STATE`.
//!
//! Boots the real `amos_ai::server::serve()` twice against the same durable-state
//! base path with the deterministic mock embedder: the first daemon indexes a
//! passage (which persists the vector snapshot + passage map), is aborted, then a
//! **fresh** daemon boots, re-hydrates that state, and still answers the same
//! self-matching query with the passage text. This proves persistence is real and
//! honest (nothing is fabricated from the file — the vectors + text are what was
//! indexed).

use amos_proto::ai_agent::rag_client::RagClient;
use amos_proto::ai_agent::{RagIndexRequest, RagQueryRequest, RagStatusRequest};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

static SEQ: AtomicU64 = AtomicU64::new(0);

async fn connect(path: &Path) -> Result<RagClient<tonic::transport::Channel>, String> {
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

async fn wait_for_socket(path: &Path) {
    for _ in 0..200 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rag_state_survives_daemon_restart() {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let sock1: PathBuf = std::env::temp_dir().join(format!("amos-ai-ragp-e2e-{seq}-1.sock"));
    let sock2: PathBuf = std::env::temp_dir().join(format!("amos-ai-ragp-e2e-{seq}-2.sock"));
    // AMOS_RAG_STATE is a base path; the daemon writes `<base>.idx` + `<base>.passages.json`.
    let base: PathBuf = std::env::temp_dir().join(format!("amos-ai-ragp-e2e-{seq}-state"));
    let idx_file: PathBuf = {
        let mut s = base.as_os_str().to_owned();
        s.push(".idx");
        PathBuf::from(s)
    };
    let passages_file: PathBuf = {
        let mut s = base.as_os_str().to_owned();
        s.push(".passages.json");
        PathBuf::from(s)
    };
    for f in [&sock1, &sock2, &base, &idx_file, &passages_file] {
        let _ = std::fs::remove_file(f);
    }
    std::env::set_var("AMOS_RAG_EMBEDDER", "mock");
    std::env::set_var("AMOS_RAG_STATE", &base);

    let text = "需要跨重启存留的唯一预算片段".to_string();

    // --- First boot: index one passage. ---
    let s1_path = sock1.clone();
    let server1 = tokio::spawn(async move { amos_ai::server::serve(s1_path).await.unwrap() });
    wait_for_socket(&sock1).await;
    let mut c1 = connect(&sock1).await.expect("connect daemon 1");
    c1.index(RagIndexRequest {
        id: "note:a".into(),
        text: text.clone(),
    })
    .await
    .expect("index");
    assert!(
        idx_file.exists() && passages_file.exists(),
        "index with a state path must persist both files"
    );
    let st = c1
        .status(RagStatusRequest {})
        .await
        .expect("status")
        .into_inner();
    assert_eq!(st.indexed, 1);
    drop(c1);
    server1.abort();

    // --- Second boot: a fresh daemon re-hydrates the same state. ---
    let s2_path = sock2.clone();
    let server2 = tokio::spawn(async move { amos_ai::server::serve(s2_path).await.unwrap() });
    wait_for_socket(&sock2).await;
    let mut c2 = connect(&sock2).await.expect("connect daemon 2");

    let restored = c2
        .status(RagStatusRequest {})
        .await
        .expect("status after restart")
        .into_inner();
    assert_eq!(restored.indexed, 1, "index must survive a daemon restart");

    let q = c2
        .query(RagQueryRequest {
            query: text.clone(),
            top_k: 3,
        })
        .await
        .expect("query after restart")
        .into_inner();
    assert_eq!(q.count, 1);
    assert_eq!(q.hits[0].id, "note:a");
    assert_eq!(q.hits[0].passage, text, "passage text restored from disk");

    // Cleanup.
    for f in [&sock1, &sock2, &base, &idx_file, &passages_file] {
        let _ = std::fs::remove_file(f);
    }
    server2.abort();
}
