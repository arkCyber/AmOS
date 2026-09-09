//! gRPC `Rag` service exposing the daemon's offline local vector retrieval over
//! the shared UDS (proto `ai_agent.proto`, `service Rag`).
//!
//! Follows the `netguard_service` / `governor_service` pattern: the service holds
//! a small shared [`RagEngine`] (an embedder + a [`RagStore`] + an in-memory
//! passage map) and maps each unary RPC onto the `amos-vector-db` + `crate::rag`
//! domain, so the System UI / Notes can *index* passages and *retrieve* the
//! nearest ids to a query.
//!
//! Honest model (matches the workspace): the default host embedder is the
//! deterministic `MockEmbedder` (offline, no model — retrieval is only *plumbing*,
//! never claimed semantic). Setting `AMOS_RAG_EMBEDDER=ollama` selects the real
//! local `/api/embeddings` adapter; an unreachable/broken model is a surfaced
//! error, never a silent mock. Passages + vectors are in-memory unless
//! `AMOS_RAG_STATE` names a durable base path, in which case every Index/Remove
//! atomically persists both and a restart re-hydrates them (see `docs/vector-db-rag.md`).
//! "Retrieve-then-answer" is composed by the caller:
//! `Rag.Query` (ids + passage text for citations) then `AiAgent.StreamChat` with
//! that context dropped into the prompt.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use amos_proto::ai_agent::rag_server::{Rag, RagServer};
use amos_proto::ai_agent::{
    RagHit, RagIndexReply, RagIndexRequest, RagQueryReply, RagQueryRequest, RagRemoveReply,
    RagRemoveRequest, RagStatusReply, RagStatusRequest,
};
use amos_vector_db::{Embedder, MockEmbedder, VectorDbError};
use serde::{Deserialize, Serialize};
use tonic::{Request, Response, Status};

use crate::rag::{OllamaEmbedder, RagStore};

/// Env var selecting the embedder backend: `mock` (default, offline) or `ollama`.
const EMBEDDER_ENV: &str = "AMOS_RAG_EMBEDDER";
/// Env var naming the Ollama embedding model (used when embedder = `ollama`).
const EMBED_MODEL_ENV: &str = "AMOS_RAG_EMBED_MODEL";
/// Env var for the Mock embedder's fixed dimension (host/CI only).
const MOCK_DIM_ENV: &str = "AMOS_RAG_DIM";
/// Ollama host (shared with the chat backend). Default: `http://localhost:11434`.
const OLLAMA_HOST_ENV: &str = "AMOS_OLLAMA_HOST";
/// Env var naming a durable-state **base** path. When set, every Index/Remove
/// persists the vector snapshot to `<base>.idx` and the passage map to
/// `<base>.passages.json` (atomically); on boot the daemon re-hydrates both so an
/// index survives a restart. Absent => pure in-memory (fresh each boot).
const STATE_ENV: &str = "AMOS_RAG_STATE";
/// Default mock dimension (host/CI); device uses a real model's dimension.
const DEFAULT_DIM: usize = 384;
/// Version tag for the persisted passages file.
const PASSAGES_VERSION: u32 = 1;
/// Daemon-side top-k cap: even if a client asks for more, we never exceed this
/// (bounds the context the caller may paste into a chat prompt).
const MAX_TOP_K: usize = 8;

/// Two sibling files derived from one `AMOS_RAG_STATE` base path.
struct Persist {
    idx: PathBuf,
    passages: PathBuf,
}

impl Persist {
    /// A `<base>.idx` / `<base>.passages.json` pair from the env base (if any).
    fn from_env() -> Option<Persist> {
        std::env::var(STATE_ENV)
            .ok()
            .filter(|s| !s.is_empty())
            .map(|base| Persist {
                idx: sibling(Path::new(&base), ".idx"),
                passages: sibling(Path::new(&base), ".passages.json"),
            })
    }
}

/// Shared state behind the RPC: an embedder + retrieval index + the passage text
/// for each id (needed to return citations / assemble a context) + optional
/// durable persistence.
struct RagEngine {
    store: RagStore<Box<dyn Embedder + Send>>,
    passages: BTreeMap<String, String>,
    persist: Option<Persist>,
}

impl RagEngine {
    /// A fresh, in-memory engine (no persistence unless `persist` is given).
    fn new(embedder: Box<dyn Embedder + Send>, persist: Option<Persist>) -> Self {
        RagEngine {
            store: RagStore::new(embedder),
            passages: BTreeMap::new(),
            persist,
        }
    }

    /// Embed + index (or re-index on edit) `text` under `id`, then persist.
    /// Returns the vector dimension after this ingest.
    fn ingest(&mut self, id: String, text: String) -> amos_vector_db::Result<u32> {
        self.store.ingest(id.clone(), &text)?;
        let dim = self.store.dim().unwrap_or(0);
        self.passages.insert(id, text);
        self.persist_best_effort();
        Ok(dim as u32)
    }

    /// Drop an id from retrieval, then persist. `true` if it was present.
    fn remove(&mut self, id: &str) -> bool {
        self.passages.remove(id);
        let removed = self.store.remove(id);
        self.persist_best_effort();
        removed
    }

    /// Retrieve the nearest `k` ids to `query`, attaching each id's stored text.
    fn query(&self, query: &str, k: usize) -> amos_vector_db::Result<Vec<RagHit>> {
        let hits = self.store.retrieve(query, k)?;
        Ok(hits
            .into_iter()
            .map(|h| RagHit {
                id: h.id.clone(),
                score: f64::from(h.score),
                passage: self.passages.get(&h.id).cloned().unwrap_or_default(),
            })
            .collect())
    }

    fn len(&self) -> usize {
        self.store.len()
    }

    fn dim(&self) -> u32 {
        self.store.dim().unwrap_or(0) as u32
    }

    /// Write the vector snapshot + passages to their sibling files. Best-effort:
    /// a persistence failure is logged, never a crash, never a fabricated success.
    fn persist_best_effort(&self) {
        let Some(p) = &self.persist else { return };
        if let Err(e) = self.store.persist_to(&p.idx) {
            tracing::warn!(err = %e, "rag vector snapshot save failed");
        }
        if let Err(e) = write_passages(&p.passages, &self.passages) {
            tracing::warn!(err = %e, "rag passages save failed");
        }
    }
}

/// The tonic `Rag` implementation wrapping shared engine state + the honest
/// embedder label reported to callers.
pub struct RagSvc {
    engine: Arc<Mutex<RagEngine>>,
    /// "mock" (host/offline) or "ollama" (real local model) — never invented.
    label: &'static str,
}

impl RagSvc {
    /// Build a configured service from the environment (see module consts): pick
    /// the embedder, and when `AMOS_RAG_STATE` is set re-hydrate any previously
    /// persisted index + passages so retrieval survives a daemon restart.
    pub fn from_env() -> anyhow::Result<Self> {
        let persist = Persist::from_env();
        let label = label_from_env();
        let make_embedder = || embedder_from_env().map_err(anyhow::Error::msg);
        let engine = match persist.as_ref() {
            Some(p) if p.idx.exists() => {
                match RagStore::<Box<dyn Embedder + Send>>::load(make_embedder()?, &p.idx) {
                    Ok(store) => RagEngine {
                        store,
                        passages: load_passages(&p.passages),
                        persist,
                    },
                    Err(e) => {
                        tracing::warn!(err = %e, "rag state unreadable; starting fresh");
                        RagEngine::new(make_embedder()?, persist)
                    }
                }
            }
            _ => RagEngine::new(make_embedder()?, persist),
        };
        Ok(RagSvc {
            engine: Arc::new(Mutex::new(engine)),
            label,
        })
    }

    /// A test/demo instance over a deterministic mock embedder of `dim` (no persistence).
    #[cfg(test)]
    fn with_mock(dim: usize) -> anyhow::Result<Self> {
        let m = MockEmbedder::new(dim).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(RagSvc {
            engine: Arc::new(Mutex::new(RagEngine::new(
                Box::new(m) as Box<dyn Embedder + Send>,
                None,
            ))),
            label: "mock",
        })
    }

    /// Normalise a client-requested top-k to `[1, MAX_TOP_K]`; 0 => default 5.
    fn top_k(raw: u32) -> usize {
        let k = if raw == 0 { 5 } else { raw as usize };
        k.clamp(1, MAX_TOP_K)
    }
}

#[tonic::async_trait]
impl Rag for RagSvc {
    async fn index(
        &self,
        request: Request<RagIndexRequest>,
    ) -> Result<Response<RagIndexReply>, Status> {
        let req = request.into_inner();
        let engine = Arc::clone(&self.engine);
        let reply = tokio::task::spawn_blocking(move || {
            lock(&engine)
                .ingest(req.id, req.text)
                .map(|dimension| RagIndexReply {
                    indexed: true,
                    dimension,
                })
                .map_err(rag_status)
        })
        .await
        .map_err(join_status)?;
        Ok(Response::new(reply?))
    }

    async fn remove(
        &self,
        request: Request<RagRemoveRequest>,
    ) -> Result<Response<RagRemoveReply>, Status> {
        let req = request.into_inner();
        let engine = Arc::clone(&self.engine);
        let removed = tokio::task::spawn_blocking(move || lock(&engine).remove(&req.id))
            .await
            .map_err(join_status)?;
        Ok(Response::new(RagRemoveReply { removed }))
    }

    async fn query(
        &self,
        request: Request<RagQueryRequest>,
    ) -> Result<Response<RagQueryReply>, Status> {
        let req = request.into_inner();
        let k = Self::top_k(req.top_k);
        let engine = Arc::clone(&self.engine);
        let reply = tokio::task::spawn_blocking(move || {
            lock(&engine).query(&req.query, k).map_err(rag_status)
        })
        .await
        .map_err(join_status)?;
        let hits = reply?;
        let count = hits.len() as u32;
        Ok(Response::new(RagQueryReply { hits, count }))
    }

    async fn status(
        &self,
        _request: Request<RagStatusRequest>,
    ) -> Result<Response<RagStatusReply>, Status> {
        let engine = lock(&self.engine);
        Ok(Response::new(RagStatusReply {
            indexed: engine.len() as u64,
            dimension: engine.dim(),
            embedder: self.label.to_string(),
        }))
    }
}

/// Build the tonic server wrapper around a freshly bootstrapped service.
pub fn server(svc: RagSvc) -> RagServer<RagSvc> {
    RagServer::new(svc)
}

/// Map a domain error onto a tonic internal status (never a crash).
fn rag_status(e: VectorDbError) -> Status {
    Status::internal(e.to_string())
}

/// Map a blocking-worker join error onto a tonic status.
fn join_status(e: tokio::task::JoinError) -> Status {
    Status::internal(format!("rag worker join: {e}"))
}

/// Lock a `Mutex`, recovering from poison instead of panicking (P0-1 gate).
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Parse the embedder-choice env and build it. `mock` (default) → a fixed-dim
/// `MockEmbedder`; `ollama` → the real local `/api/embeddings` adapter. An
/// invalid dimension / backend is an honest error (never a panic).
fn embedder_from_env() -> Result<Box<dyn Embedder + Send>, String> {
    let which = std::env::var(EMBEDDER_ENV).unwrap_or_default();
    match which.as_str() {
        "ollama" => {
            let host =
                std::env::var(OLLAMA_HOST_ENV).unwrap_or_else(|_| "http://localhost:11434".into());
            let model = std::env::var(EMBED_MODEL_ENV).unwrap_or_else(|_| "bge-m3".into());
            Ok(Box::new(OllamaEmbedder::new(host, model)) as Box<dyn Embedder + Send>)
        }
        _ => {
            let dim = std::env::var(MOCK_DIM_ENV)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(DEFAULT_DIM)
                .max(1);
            let m = MockEmbedder::new(dim).map_err(|e| e.to_string())?;
            Ok(Box::new(m) as Box<dyn Embedder + Send>)
        }
    }
}

/// The honest embedder label reported by `Status` (`"mock"` | `"ollama"`).
fn label_from_env() -> &'static str {
    if std::env::var(EMBEDDER_ENV).as_deref() == Ok("ollama") {
        "ollama"
    } else {
        "mock"
    }
}

/// Load the persisted passage map — empty on missing / corrupt (never a crash).
fn load_passages(path: &Path) -> BTreeMap<String, String> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PassagesFile>(&bytes).ok())
        .map(|f| f.passages)
        .unwrap_or_default()
}

/// Versioned on-disk form of the passage map.
#[derive(Serialize, Deserialize)]
struct PassagesFile {
    version: u32,
    passages: BTreeMap<String, String>,
}

/// Atomically write the passage map to `path`.
fn write_passages(path: &Path, passages: &BTreeMap<String, String>) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&PassagesFile {
        version: PASSAGES_VERSION,
        passages: passages.clone(),
    })
    .map_err(std::io::Error::other)?;
    atomic_write(path, &bytes)
}

/// `<base>` + `suffix` as a new path (used for the `.idx` / `.passages.json` pair).
fn sibling(base: &Path, suffix: &str) -> PathBuf {
    let mut s = base.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Write to a temp sibling then rename (a crash mid-write never leaves a
/// truncated state file).
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = sibling(path, ".tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn index_reports_dimension_and_status_label() {
        let svc = RagSvc::with_mock(8).expect("mock svc");
        let rep = svc
            .index(Request::new(RagIndexRequest {
                id: "a".into(),
                text: "一段内容".into(),
            }))
            .await
            .expect("index")
            .into_inner();
        assert!(rep.indexed);
        assert_eq!(rep.dimension, 8);
        let st = svc
            .status(Request::new(RagStatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        assert_eq!(st.indexed, 1);
        assert_eq!(st.dimension, 8);
        assert_eq!(st.embedder, "mock");
    }

    #[tokio::test]
    async fn query_self_match_returns_passage_and_remove_drops() {
        let svc = RagSvc::with_mock(8).expect("mock svc");
        svc.index(Request::new(RagIndexRequest {
            id: "a".into(),
            text: "预算报告正文".into(),
        }))
        .await
        .expect("index a");
        // Deterministic mock → a query equal to the stored text embeds identically.
        let q = svc
            .query(Request::new(RagQueryRequest {
                query: "预算报告正文".into(),
                top_k: 3,
            }))
            .await
            .expect("query")
            .into_inner();
        assert_eq!(q.count, 1);
        assert_eq!(q.hits[0].id, "a");
        assert_eq!(q.hits[0].passage, "预算报告正文");
        assert!((q.hits[0].score - 1.0).abs() < 1e-6);

        let removed = svc
            .remove(Request::new(RagRemoveRequest { id: "a".into() }))
            .await
            .expect("remove")
            .into_inner();
        assert!(removed.removed);
        let st = svc
            .status(Request::new(RagStatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        assert_eq!(st.indexed, 0);
    }

    #[tokio::test]
    async fn query_top_k_is_capped_by_daemon() {
        let svc = RagSvc::with_mock(4).expect("mock svc");
        for i in 0..12 {
            svc.index(Request::new(RagIndexRequest {
                id: format!("n{i}"),
                text: format!("内容 {i}"),
            }))
            .await
            .expect("index");
        }
        let q = svc
            .query(Request::new(RagQueryRequest {
                query: "内容".into(),
                top_k: 1_000_000, // ask for far more than the cap
            }))
            .await
            .expect("query")
            .into_inner();
        assert!(q.count <= MAX_TOP_K as u32, "daemon must cap top-k");
        assert_eq!(q.hits.len(), q.count as usize);
    }

    #[tokio::test]
    async fn empty_index_query_returns_no_hits_not_error() {
        let svc = RagSvc::with_mock(4).expect("mock svc");
        let q = svc
            .query(Request::new(RagQueryRequest {
                query: "anything".into(),
                top_k: 5,
            }))
            .await
            .expect("query ok on empty index")
            .into_inner();
        assert!(q.hits.is_empty());
        assert_eq!(q.count, 0);
    }

    #[tokio::test]
    async fn reindexing_an_id_upserts_in_place() {
        let svc = RagSvc::with_mock(8).expect("mock svc");
        svc.index(Request::new(RagIndexRequest {
            id: "a".into(),
            text: "买牛奶".into(),
        }))
        .await
        .expect("index v1");
        svc.index(Request::new(RagIndexRequest {
            id: "a".into(),
            text: "明天开产品会".into(),
        }))
        .await
        .expect("index v2");
        let st = svc
            .status(Request::new(RagStatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        assert_eq!(st.indexed, 1, "an edit must not duplicate the id");
        let q = svc
            .query(Request::new(RagQueryRequest {
                query: "明天开产品会".into(),
                top_k: 3,
            }))
            .await
            .expect("query")
            .into_inner();
        assert_eq!(q.hits[0].id, "a");
        assert_eq!(q.hits[0].passage, "明天开产品会");
    }

    fn tmp_path(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("amos-rag-{tag}-{n}-{}.json", std::process::id()))
    }

    #[test]
    fn sibling_appends_suffix() {
        assert_eq!(
            sibling(Path::new("/tmp/rag-base"), ".idx"),
            PathBuf::from("/tmp/rag-base.idx")
        );
        assert_eq!(
            sibling(Path::new("/tmp/rag-base"), ".passages.json"),
            PathBuf::from("/tmp/rag-base.passages.json")
        );
    }

    #[test]
    fn passages_roundtrip_atomically_and_degrade_on_corrupt() {
        let path = tmp_path("passages");
        let _ = std::fs::remove_file(&path);
        let mut map = BTreeMap::new();
        map.insert("note:a".to_string(), "预算正文".to_string());
        map.insert("note:b".to_string(), "会议纪要".to_string());
        write_passages(&path, &map).expect("write");
        // Atomic write leaves no temp sibling behind.
        assert!(!sibling(&path, ".tmp").exists());
        assert_eq!(load_passages(&path), map, "round-trips the passage map");

        // Missing file → empty (never a crash).
        let _ = std::fs::remove_file(&path);
        assert!(load_passages(&path).is_empty());

        // Corrupt file → empty (never a crash) — an index can start fresh.
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load_passages(&path).is_empty());

        let _ = std::fs::remove_file(&path);
    }
}
