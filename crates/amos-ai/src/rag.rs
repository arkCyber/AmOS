//! Daemon-side RAG wiring: a real local embedder + a retrieval store.
//!
//! `amos-vector-db` is deliberately transport-free: it stores and searches
//! vectors but never talks to a model. The missing link between "chunks/notes"
//! and that index is *embedding text into vectors* — the one outward seam. This
//! module owns the real adapter for AmOS: **Ollama's `/api/embeddings`**, served
//! locally (the same `AMOS_OLLAMA_HOST` the chat `OllamaBackend` uses), plus a
//! [`RagStore`] that folds an embedder + a `FlatIndex` into "ingest note →
//! retrieve top-k" a daemon can drive.
//!
//! Honesty model (matches the workspace): the *default* embedder path is the
//! deterministic `MockEmbedder` (offline, host-testable). An explicitly-configured
//! `OllamaEmbedder` that cannot reach a model is a surfaced error — never a
//! silent mock pretending to embed. Every vector returned here is validated
//! (finite, non-empty, dimension-locked) by `amos-vector-db` before it enters an
//! index, so a broken model cannot poison retrieval.
//!
//! Blocking note: `ureq` HTTP is blocking, so in an async server context the
//! daemon must call the `Embedder` (and thus `RagStore::ingest`/`retrieve`) from
//! `tokio::task::spawn_blocking`, exactly as the existing inference layer does
//! for its blocking Ollama calls.

use std::path::{Path, PathBuf};
use std::time::Duration;

use amos_vector_db::{Embedder, FlatIndex, Metric, ScoredHit, Vector, VectorDbError};

/// Ollama embeddings endpoint for a host (trims a trailing `/`).
pub fn embeddings_endpoint(host: &str) -> String {
    format!("{}/api/embeddings", host.trim_end_matches('/'))
}

/// Parse an Ollama `/api/embeddings` response body into a validated vector.
///
/// Rejects (never silently accepts) a missing / non-array / empty `embedding`,
/// a non-numeric element, or any non-finite value — the same honesty contract as
/// [`Vector::new`].
pub fn parse_embedding(payload: &str) -> amos_vector_db::Result<Vec<f32>> {
    let v: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| VectorDbError::Embed(format!("unparseable /api/embeddings payload: {e}")))?;
    let arr = v
        .get("embedding")
        .and_then(|x| x.as_array())
        .ok_or_else(|| {
            VectorDbError::Embed("no 'embedding' array in /api/embeddings response".into())
        })?;
    let mut out = Vec::with_capacity(arr.len());
    for el in arr {
        let f = el
            .as_f64()
            .ok_or_else(|| VectorDbError::Embed("embedding element is not a number".into()))?
            as f32;
        if !f.is_finite() {
            return Err(VectorDbError::Embed(
                "embedding contains a non-finite value".into(),
            ));
        }
        out.push(f);
    }
    if out.is_empty() {
        return Err(VectorDbError::Embed("embedding is empty".into()));
    }
    Ok(out)
}

/// A real local embedder backed by an Ollama `/api/embeddings` model.
///
/// Keyless by default; an optional bearer can be attached for token-gated
/// gateways. The request is **blocking** (see module docs) and errors are
/// surfaced as [`VectorDbError::Embed`] — never a fake vector.
pub struct OllamaEmbedder {
    host: String,
    model: String,
    bearer: Option<String>,
}

impl OllamaEmbedder {
    /// Create an embedder for a host (e.g. `http://localhost:11434`) and an
    /// embedding model (e.g. `bge-m3`, `nomic-embed-text`).
    pub fn new(host: String, model: String) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            model,
            bearer: None,
        }
    }

    /// Attach a bearer token for authenticated / token-gated endpoints.
    pub fn with_bearer(mut self, bearer: Option<String>) -> Self {
        self.bearer = bearer;
        self
    }

    /// Blocking POST to `/api/embeddings`. Public so an async caller can run it
    /// from `spawn_blocking` without holding the whole trait open.
    pub fn embed_blocking(&self, text: &str) -> amos_vector_db::Result<Vec<f32>> {
        let url = embeddings_endpoint(&self.host);
        let body = serde_json::json!({ "model": self.model, "prompt": text });
        let mut req = ureq::post(&url)
            .timeout(Duration::from_secs(30))
            .set("Content-Type", "application/json");
        if let Some(b) = &self.bearer {
            req = req.set("Authorization", &format!("Bearer {b}"));
        }
        let resp = req
            .send_string(&body.to_string())
            .map_err(|e| VectorDbError::Embed(format!("Ollama /api/embeddings error: {e}")))?;
        let payload = resp
            .into_string()
            .map_err(|e| VectorDbError::Embed(format!("read /api/embeddings body: {e}")))?;
        parse_embedding(&payload)
    }
}

impl Embedder for OllamaEmbedder {
    fn embed(&self, text: &str) -> amos_vector_db::Result<Vec<f32>> {
        self.embed_blocking(text)
    }
}

/// An embedder + a `FlatIndex` folded into a small offline retrieval store a
/// daemon can drive: ingest a note/chunk under an id, then ask "which stored
/// ids are nearest to this query?".
///
/// The index is created **lazily** from the first embedding's length, so a real
/// embedder whose dimension is only discovered at runtime works naturally. A
/// later embed whose dimension differs is a hard [`VectorDbError::DimMismatch`]
/// (the daemon must surface "re-index required"), never a silent mix.
pub struct RagStore<E: Embedder> {
    embedder: E,
    idx: Option<FlatIndex>,
    path: Option<PathBuf>,
}

impl<E: Embedder> RagStore<E> {
    /// A new empty store over `embedder`.
    pub fn new(embedder: E) -> Self {
        RagStore {
            embedder,
            idx: None,
            path: None,
        }
    }

    /// Remember a snapshot path for later [`persist`](Self::persist).
    pub fn set_snapshot_path(&mut self, path: PathBuf) {
        self.path = Some(path);
    }

    /// Embed `text` and index it under `id` (insert, or replace if present).
    pub fn ingest(&mut self, id: impl Into<String>, text: &str) -> amos_vector_db::Result<()> {
        let data = self.embedder.embed(text)?;
        let v = Vector::new(id, data)?;
        match self.idx.as_mut() {
            None => {
                let dim = v.data.len();
                let mut idx = FlatIndex::new(dim)?;
                idx.upsert(v)?;
                self.idx = Some(idx);
            }
            Some(idx) => idx.upsert(v)?,
        }
        Ok(())
    }

    /// Drop a stored id from future retrieval. `true` if it was present.
    pub fn remove(&mut self, id: &str) -> bool {
        match self.idx.as_mut() {
            Some(idx) => idx.remove(id),
            None => false,
        }
    }

    /// Rank stored ids against `query`, returning the top `k`. An empty store
    /// returns an empty result (never a fabricated hit).
    pub fn retrieve(&self, query: &str, k: usize) -> amos_vector_db::Result<Vec<ScoredHit>> {
        let Some(idx) = self.idx.as_ref() else {
            return Ok(Vec::new());
        };
        let data = self.embedder.embed(query)?;
        idx.search(&data, Metric::Cosine, k)
    }

    /// Number of indexed ids.
    pub fn len(&self) -> usize {
        self.idx.as_ref().map_or(0, FlatIndex::len)
    }

    /// Whether nothing is indexed yet.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether `id` is currently indexed.
    pub fn contains(&self, id: &str) -> bool {
        self.idx.as_ref().is_some_and(|idx| idx.contains(id))
    }

    /// Current vector dimension (`None` until the first ingest).
    pub fn dim(&self) -> Option<usize> {
        self.idx.as_ref().map(FlatIndex::dim)
    }

    /// Persist the current index to `path`. Errors honestly if nothing has been
    /// ingested (no dimension to snapshot) or the path is unwritable.
    pub fn persist_to(&self, path: impl AsRef<Path>) -> amos_vector_db::Result<()> {
        let idx = self.idx.as_ref().ok_or_else(|| {
            VectorDbError::Invalid("cannot persist: nothing ingested (dimension unknown)".into())
        })?;
        idx.save_to(path)
    }

    /// Persist to the path set with [`set_snapshot_path`](Self::set_snapshot_path).
    pub fn persist(&self) -> amos_vector_db::Result<()> {
        let path = self.path.as_ref().ok_or_else(|| {
            VectorDbError::Invalid("no snapshot path set (use set_snapshot_path)".into())
        })?;
        self.persist_to(path)
    }

    /// Rebuild a store from a snapshot file, reusing `embedder` for future
    /// queries. The snapshot's dimension is authoritative.
    pub fn load(embedder: E, path: impl AsRef<Path>) -> amos_vector_db::Result<Self> {
        let idx = FlatIndex::load_from(path)?;
        Ok(RagStore {
            embedder,
            idx: Some(idx),
            path: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_vector_db::MockEmbedder;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::{Arc, Mutex};

    /// A tiny one-shot blocking HTTP server for Ollama transport tests. Reads
    /// the request head + body, records the head, and replies with `body`.
    fn spawn_http_server(
        status_line: &'static str,
        body: &'static str,
    ) -> (SocketAddr, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(String::new()));
        let cap = captured.clone();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let _ = sock.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let mut head_len = 0usize;
            while buf.len() < (1 << 16) {
                let n = sock.read(&mut tmp).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                let lower = String::from_utf8_lossy(&buf).to_ascii_lowercase();
                if let Some(p) = lower.find("\r\n\r\n") {
                    head_len = p + 4;
                    break;
                }
                if let Some(p) = lower.find("\n\n") {
                    head_len = p + 2;
                    break;
                }
            }
            let head = String::from_utf8_lossy(&buf).to_string();
            *cap.lock().unwrap() = head;
            // Drain the request body so closing the socket never RSTs the client.
            let mut len = 0usize;
            for l in String::from_utf8_lossy(&buf).to_ascii_lowercase().lines() {
                if let Some(v) = l.strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let have = buf.len().saturating_sub(head_len);
            if len > have {
                let mut rest = vec![0u8; len - have];
                let _ = sock.read_exact(&mut rest);
            }
            let resp = format!(
                "HTTP/1.1 {status_line}\r\nContent-Length: {clen}\r\nConnection: close\r\n\r\n{body}",
                clen = body.len()
            );
            let _ = sock.write_all(resp.as_bytes());
            let _ = sock.flush();
        });
        (addr, captured)
    }

    fn mock8() -> MockEmbedder {
        MockEmbedder::new(8).expect("mock dim")
    }

    // ---- parse_embedding (pure, no network) ----

    #[test]
    fn parse_valid_embedding() {
        let v = parse_embedding(r#"{"embedding":[0.1,0.2,0.3]}"#).expect("valid");
        assert_eq!(v, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn parse_missing_embedding_field() {
        assert!(parse_embedding(r#"{"other":[]}"#).is_err());
    }

    #[test]
    fn parse_empty_embedding() {
        assert!(parse_embedding(r#"{"embedding":[]}"#).is_err());
    }

    #[test]
    fn parse_non_numeric_element() {
        assert!(parse_embedding(r#"{"embedding":[0.1,"x"]}"#).is_err());
    }

    #[test]
    fn parse_non_finite_rejected() {
        // 1e400 overflows f64 to infinity in serde_json → must be rejected.
        assert!(parse_embedding(r#"{"embedding":[0.1,1e400]}"#).is_err());
    }

    #[test]
    fn parse_garbage_rejected() {
        assert!(parse_embedding("not json").is_err());
    }

    #[test]
    fn endpoint_trims_trailing_slash() {
        assert_eq!(
            embeddings_endpoint("http://h:1/"),
            "http://h:1/api/embeddings"
        );
    }

    // ---- OllamaEmbedder (real transport, local one-shot server) ----

    #[test]
    fn ollama_embedder_round_trip() {
        let (addr, _cap) = spawn_http_server("200 OK", r#"{"embedding":[0.1,0.2,0.3]}"#);
        let emb = OllamaEmbedder::new(format!("http://{addr}"), "bge-m3".into());
        let v = emb.embed("hello").expect("embed ok");
        assert_eq!(v.len(), 3);
        assert!((v[0] - 0.1).abs() < 1e-6);
    }

    #[test]
    fn ollama_embedder_sends_bearer_when_configured() {
        let (addr, cap) = spawn_http_server("200 OK", r#"{"embedding":[0.5]}"#);
        let emb = OllamaEmbedder::new(format!("http://{addr}"), "bge-m3".into())
            .with_bearer(Some("sk-test".into()));
        emb.embed("hi").expect("embed ok");
        let head = cap.lock().unwrap().clone();
        assert!(head.contains("Authorization: Bearer sk-test"));
    }

    #[test]
    fn ollama_embedder_keyless_by_default() {
        let (addr, cap) = spawn_http_server("200 OK", r#"{"embedding":[0.5]}"#);
        let emb = OllamaEmbedder::new(format!("http://{addr}"), "bge-m3".into());
        emb.embed("hi").expect("embed ok");
        let head = cap.lock().unwrap().clone();
        assert!(!head.to_lowercase().contains("authorization"));
    }

    #[test]
    fn ollama_embedder_http_error_is_err() {
        let (addr, _) = spawn_http_server("500 Internal Server Error", "boom");
        let emb = OllamaEmbedder::new(format!("http://{addr}"), "bge-m3".into());
        assert!(emb.embed("hi").is_err());
    }

    #[test]
    fn ollama_embedder_bad_payload_is_err() {
        let (addr, _) = spawn_http_server("200 OK", r#"{"embedding":["nope"]}"#);
        let emb = OllamaEmbedder::new(format!("http://{addr}"), "bge-m3".into());
        assert!(emb.embed("hi").is_err());
    }

    #[test]
    fn ollama_embedder_unreachable_fails_fast() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let emb = OllamaEmbedder::new(format!("http://{addr}"), "bge-m3".into());
        assert!(emb.embed("hi").is_err());
    }

    // ---- RagStore (offline, deterministic MockEmbedder) ----

    #[test]
    fn ragstore_ingest_then_retrieve_matches_self() {
        let mut store = RagStore::new(mock8());
        store
            .ingest("note:a", "关于 q4 预算的会议记录")
            .expect("ingest a");
        store.ingest("note:b", "食堂菜单").expect("ingest b");
        assert_eq!(store.len(), 2);
        assert_eq!(store.dim(), Some(8));
        // The query re-embeds deterministically → matches its own stored vector.
        let hits = store.retrieve("关于 q4 预算的会议记录", 1).expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "note:a");
        assert!((hits[0].score - 1.0).abs() < 1e-5);
    }

    #[test]
    fn ragstore_edit_upserts_in_place() {
        let mut store = RagStore::new(mock8());
        store.ingest("note:todo", "买牛奶").expect("add");
        store.ingest("note:todo", "明天十点开产品会").expect("edit");
        assert_eq!(store.len(), 1, "an edit must not duplicate the row");
        let fresh = store.retrieve("明天十点开产品会", 1).expect("search");
        assert_eq!(fresh[0].id, "note:todo");
        assert!((fresh[0].score - 1.0).abs() < 1e-5);
        let stale = store.retrieve("买牛奶", 1).expect("search");
        assert_eq!(stale[0].id, "note:todo");
        assert!(
            stale[0].score < 0.9999,
            "stale content must not match exactly"
        );
    }

    #[test]
    fn ragstore_remove_drops() {
        let mut store = RagStore::new(mock8());
        store.ingest("a", "x").expect("add a");
        store.ingest("b", "y").expect("add b");
        assert!(store.remove("a"));
        assert!(!store.remove("a"));
        assert_eq!(store.len(), 1);
        assert!(!store.contains("a"));
        assert!(store.contains("b"));
    }

    #[test]
    fn ragstore_empty_is_empty_and_retrieve_empty() {
        let store = RagStore::new(mock8());
        assert!(store.is_empty());
        assert_eq!(store.dim(), None);
        assert!(store.retrieve("anything", 5).expect("ok").is_empty());
    }

    #[test]
    fn ragstore_persist_reload_round_trip() {
        let path = std::env::temp_dir().join(format!("amos-rag-{}.idx", std::process::id()));
        let mut store = RagStore::new(mock8());
        store.ingest("a", "唯一持久化内容").expect("ingest");
        store.persist_to(&path).expect("persist");
        let reloaded = RagStore::load(mock8(), &path).expect("load");
        let _ = std::fs::remove_file(&path);
        assert_eq!(reloaded.len(), 1);
        let hits = reloaded.retrieve("唯一持久化内容", 1).expect("search");
        assert_eq!(hits[0].id, "a");
    }

    #[test]
    fn ragstore_persist_empty_is_honest_error() {
        let store = RagStore::new(mock8());
        assert!(store
            .persist_to("/tmp/definitely-not-writable-amos")
            .is_err());
    }

    #[test]
    fn ragstore_rejects_empty_id() {
        let mut store = RagStore::new(mock8());
        assert!(store.ingest("", "some content").is_err());
    }

    #[test]
    fn ragstore_accepts_ollama_embedder_type() {
        // Compile-time + wiring check: OllamaEmbedder is a valid RagStore embedder.
        let store = RagStore::new(OllamaEmbedder::new("http://127.0.0.1:1".into(), "m".into()));
        assert!(store.is_empty());
        assert!(store.dim().is_none());
    }
}
