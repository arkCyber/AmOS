//! `amos-vector-db` — the AmOS **offline local vector-retrieval core**.
//!
//! This is the index / retrieve half of the offline-RAG story (functional gap
//! #7, `docs/FUNCTIONAL_GAP_ANALYSIS.md`): once `amos-pdf-parser` has turned a
//! PDF (or a Markdown note body) into [`crate::model`]-independent *chunks*, and
//! an embedder (a seam, e.g. an Ollama `/api/embeddings` model served locally
//! by the `amos-ai` daemon) has turned each chunk into a vector, this crate
//! stores those vectors and answers "which stored chunks are nearest to a
//! query vector?" so a daemon can assemble a retrieval-augmented context.
//!
//! ```text
//!   chunks (pdf-parser) ──embedder──▶ Vector{id, data} ──add/upsert──▶ FlatIndex
//!                                                        (pure, in-memory)
//!   query text ──embedder──▶ query vector ──search(metric, k)──▶ top-k ScoredHit
//!   (deterministic: ties broken by id, so two runs agree regardless of order)
//! ```
//!
//! Design constraints (aerospace-grade baseline, mirrors the other domain-core
//! crates in this workspace):
//!
//! * **Pure and panic-free in production.** `#![forbid(unsafe_code)]`; and under
//!   `not(test)` we `deny(clippy::unwrap_used / expect_used / panic)`. A bad
//!   vector is an [`error`] value, never a crash.
//! * **No native / network in the core.** Vectors are stored and searched in
//!   memory (flat / brute-force). For a personal knowledge base (thousands of
//!   chunks) exact search is the right first step — approximate ANN is only
//!   justified *after* a real-device benchmark says the flat scan is too slow
//!   (see `examples/bench_arm.rs` and `docs/vector-db-rag.md`). Embedding is a
//!   trait (`Embedder`); the core never talks to a server.
//! * **Dimension-checked and finite-only.** A vector added to (or loaded into)
//!   an index must match its dimension; `NaN`/`inf` are rejected so a poisoned
//!   value can never silently corrupt retrieval.
//! * **Deterministic top-k.** Equal-scoring hits are ordered by ascending id, so
//!   two searches (or two index build orders) give identical results.
//! * **Soft, honest degradation.** Searching an empty index returns an empty
//!   result — never a fabricated hit.
//!
//! Modules:
//! * [`error`] — [`error::VectorDbError`] / [`error::Result`].
//! * [`model`] — [`model::Vector`] (finite, non-empty, id-bearing) and
//!   [`model::ScoredHit`].
//! * [`metric`] — cosine / dot-product similarity with dimension checks and a
//!   zero-vector guard.
//! * [`index`] — [`index::FlatIndex`] (add / upsert / remove / deterministic
//!   search / versioned snapshots).
//! * [`embed`] — the transport-agnostic [`embed::Embedder`] seam + deterministic
//!   [`embed::MockEmbedder`] (the Ollama adapter lives in `amos-ai`, which owns
//!   the HTTP client and the local-server lifecycle).
//!
//! Honest boundaries (see `docs/vector-db-rag.md`): exact in-memory search only
//! (no disk index, no ANN, no persistence of the *raw chunk text* — snapshots
//! store vectors + ids, not the passages); embedding quality/dimension and the
//! ARM latency figure are a real-model / real-device measurement, never claimed
//! here. Snapshot format is versioned (`version: 1`) and rejects anything it
//! cannot prove well-formed.

#![forbid(unsafe_code)]
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod embed;
pub mod error;
pub mod index;
pub mod metric;
pub mod model;

pub use embed::{Embedder, MockEmbedder};
pub use error::{Result, VectorDbError};
pub use index::FlatIndex;
pub use metric::Metric;
pub use model::{ScoredHit, Vector};
