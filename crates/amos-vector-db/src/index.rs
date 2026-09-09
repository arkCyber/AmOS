//! [`FlatIndex`] — the in-memory, dimension-checked, exact-search index.
//!
//! Vectors live in a flat `Vec` and retrieval is a linear scan scored with a
//! [`Metric`]. That is deliberate: for a single-user offline knowledge base
//! (thousands of chunks) a flat scan over unit-managed floats is fast and, more
//! importantly, *exact* and trivially correct. An approximate index (HNSW-style)
//! is only warranted after `examples/bench_arm.rs` on the real device shows the
//! flat scan is the bottleneck — never before the measurement.

use std::cmp::Ordering;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Result, VectorDbError};
use crate::metric::{self, Metric};
use crate::model::{ScoredHit, Vector};

/// Current on-disk snapshot format version. Bump + migrate when the layout
/// changes; a mismatched version is rejected as corrupt, never guessed at.
const SNAPSHOT_VERSION: u32 = 1;

/// A stored row inside the index.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Stored {
    id: String,
    data: Vec<f32>,
}

/// The exact-search index. Dimension is fixed at construction; every add /
/// upsert / query is validated against it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FlatIndex {
    /// Embedding length this index accepts.
    dim: usize,
    /// Rows in insertion order (an `upsert` replaces in place).
    rows: Vec<Stored>,
}

impl FlatIndex {
    /// A new empty index over vectors of length `dim` (`>= 1`).
    pub fn new(dim: usize) -> Result<Self> {
        if dim == 0 {
            return Err(VectorDbError::ZeroDimension);
        }
        Ok(FlatIndex {
            dim,
            rows: Vec::new(),
        })
    }

    /// The index's fixed dimension.
    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Number of stored vectors.
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// Whether the index holds no vectors.
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Whether an id is currently indexed.
    pub fn contains(&self, id: &str) -> bool {
        self.rows.iter().any(|r| r.id == id)
    }

    /// Append a vector. Errors on dimension mismatch / a duplicate id (use
    /// [`upsert`](Self::upsert) to replace) — nothing is partially inserted.
    pub fn add(&mut self, vector: Vector) -> Result<()> {
        self.validate_dim(vector.data.len())?;
        if self.contains(&vector.id) {
            return Err(VectorDbError::Invalid(format!(
                "id already indexed: {} (use upsert to replace)",
                vector.id
            )));
        }
        self.rows.push(Stored {
            id: vector.id,
            data: vector.data,
        });
        Ok(())
    }

    /// Insert, or replace any existing row with the same id. Idempotent and
    /// order-stable: re-indexing an edited note overwrites its old vector.
    pub fn upsert(&mut self, vector: Vector) -> Result<()> {
        self.validate_dim(vector.data.len())?;
        if let Some(row) = self.rows.iter_mut().find(|r| r.id == vector.id) {
            row.data = vector.data;
        } else {
            self.rows.push(Stored {
                id: vector.id,
                data: vector.data,
            });
        }
        Ok(())
    }

    /// Remove a row by id. Returns `true` if it was present and removed.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.rows.len();
        self.rows.retain(|r| r.id != id);
        self.rows.len() != before
    }

    /// Rank the stored vectors by `metric` against `query`, returning the top
    /// `k`. An empty index yields an empty result (never a fabricated hit).
    /// Equal scores are ordered by ascending id so results are deterministic
    /// regardless of insertion order.
    pub fn search(&self, query: &[f32], metric: Metric, k: usize) -> Result<Vec<ScoredHit>> {
        self.validate_dim(query.len())?;
        if k == 0 || self.rows.is_empty() {
            return Ok(Vec::new());
        }
        // Validate query finiteness once up front.
        if let Some(&v) = query.iter().find(|v| !v.is_finite()) {
            return Err(VectorDbError::Invalid(format!(
                "query contains a non-finite value: {v}"
            )));
        }

        let mut scored: Vec<(f32, &Stored)> = Vec::with_capacity(self.rows.len());
        for row in &self.rows {
            let s = match metric {
                Metric::Cosine => metric::cosine(query, &row.data)?,
                Metric::Dot => metric::dot(query, &row.data)?,
            };
            scored.push((s, row));
        }
        // Descending by score, ties broken by ascending id.
        scored.sort_by(|(sa, ra), (sb, rb)| {
            let by_score = sb.total_cmp(sa);
            if by_score != Ordering::Equal {
                by_score
            } else {
                ra.id.cmp(&rb.id)
            }
        });

        Ok(scored
            .into_iter()
            .take(k)
            .enumerate()
            .map(|(rank, (score, row))| ScoredHit {
                rank,
                id: row.id.clone(),
                score,
            })
            .collect())
    }

    /// Serialise the index (dimension + rows) as versioned JSON bytes.
    pub fn snapshot_bytes(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(&Snapshot {
            version: SNAPSHOT_VERSION,
            dim: self.dim,
            rows: self.rows.clone(),
        })
        .map_err(|e| VectorDbError::Corrupt(format!("serialisation failed: {e}")))
    }

    /// Deserialise and **validate** a snapshot: version must match, dimension
    /// must be `>= 1`, and every stored row must be non-empty, dimension- and
    /// finite-checked. Anything unprovable is rejected as corrupt — a poisoned
    /// index must never be silently loaded.
    pub fn load_bytes(bytes: &[u8]) -> Result<Self> {
        let snap: Snapshot = serde_json::from_slice(bytes)
            .map_err(|e| VectorDbError::Corrupt(format!("cannot parse snapshot: {e}")))?;
        if snap.version != SNAPSHOT_VERSION {
            return Err(VectorDbError::Corrupt(format!(
                "unsupported snapshot version {} (this build reads {SNAPSHOT_VERSION})",
                snap.version
            )));
        }
        if snap.dim == 0 {
            return Err(VectorDbError::Corrupt(
                "snapshot declares zero dimension".into(),
            ));
        }
        let mut rows = Vec::with_capacity(snap.rows.len());
        for r in snap.rows {
            if r.id.trim().is_empty() {
                return Err(VectorDbError::Corrupt(
                    "snapshot row has an empty id".into(),
                ));
            }
            if r.data.len() != snap.dim {
                return Err(VectorDbError::Corrupt(format!(
                    "snapshot row '{}' has length {}, expected {}",
                    r.id,
                    r.data.len(),
                    snap.dim
                )));
            }
            if let Some(&v) = r.data.iter().find(|v| !v.is_finite()) {
                return Err(VectorDbError::Corrupt(format!(
                    "snapshot row '{}' has a non-finite value: {v}",
                    r.id
                )));
            }
            rows.push(r);
        }
        Ok(FlatIndex {
            dim: snap.dim,
            rows,
        })
    }

    /// Write [`snapshot_bytes`](Self::snapshot_bytes) to a path.
    pub fn save_to(&self, path: impl AsRef<Path>) -> Result<()> {
        std::fs::write(path, self.snapshot_bytes()?)?;
        Ok(())
    }

    /// Load and validate a snapshot from a path.
    pub fn load_from(path: impl AsRef<Path>) -> Result<Self> {
        let bytes = std::fs::read(path)?;
        Self::load_bytes(&bytes)
    }

    /// Shared dimension guard used by add / upsert / search.
    fn validate_dim(&self, got: usize) -> Result<()> {
        if got != self.dim {
            return Err(VectorDbError::DimMismatch {
                expected: self.dim,
                got,
            });
        }
        Ok(())
    }
}

/// On-disk / serialised form of an index.
#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    dim: usize,
    rows: Vec<Stored>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(id: &str, data: Vec<f32>) -> Vector {
        Vector::new(id, data).expect("valid vector")
    }

    #[test]
    fn zero_dim_index_is_rejected() {
        assert!(FlatIndex::new(0).is_err());
    }

    #[test]
    fn add_dimension_mismatch_is_error() {
        let mut idx = FlatIndex::new(2).expect("ok");
        assert!(idx.add(v("a", vec![1.0])).is_err());
        assert!(idx.add(v("a", vec![1.0, 2.0, 3.0])).is_err());
        assert!(idx.is_empty());
    }

    #[test]
    fn add_rejects_duplicate_id() {
        let mut idx = FlatIndex::new(2).expect("ok");
        idx.add(v("a", vec![1.0, 0.0])).expect("ok");
        assert!(idx.add(v("a", vec![0.0, 1.0])).is_err());
        assert_eq!(idx.len(), 1);
    }

    #[test]
    fn upsert_replaces_in_place() {
        let mut idx = FlatIndex::new(2).expect("ok");
        idx.upsert(v("a", vec![1.0, 0.0])).expect("ok");
        idx.upsert(v("a", vec![0.0, 1.0])).expect("ok");
        assert_eq!(idx.len(), 1, "upsert must not duplicate");
        let hits = idx.search(&[0.0, 2.0], Metric::Cosine, 1).expect("ok");
        assert_eq!(hits[0].id, "a");
    }

    #[test]
    fn remove_returns_presence() {
        let mut idx = FlatIndex::new(2).expect("ok");
        idx.add(v("a", vec![1.0, 0.0])).expect("ok");
        assert!(idx.remove("a"));
        assert!(!idx.remove("a"));
        assert!(idx.is_empty());
    }

    #[test]
    fn contains_and_len() {
        let mut idx = FlatIndex::new(2).expect("ok");
        assert!(!idx.contains("a"));
        idx.add(v("a", vec![1.0, 0.0])).expect("ok");
        assert!(idx.contains("a"));
        assert!(!idx.contains("b"));
        assert_eq!(idx.len(), 1);
    }

    #[test]
    fn cosine_finds_nearest() {
        let mut idx = FlatIndex::new(2).expect("ok");
        idx.add(v("far", vec![1.0, 0.0])).expect("ok");
        idx.add(v("near", vec![0.9, 0.1])).expect("ok");
        let hits = idx.search(&[1.0, 0.0], Metric::Cosine, 1).expect("ok");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "far"); // closest to query along x
    }

    #[test]
    fn search_respects_k_and_rank() {
        let mut idx = FlatIndex::new(2).expect("ok");
        idx.add(v("a", vec![1.0, 0.0])).expect("ok");
        idx.add(v("b", vec![0.0, 1.0])).expect("ok");
        idx.add(v("c", vec![-1.0, 0.0])).expect("ok");
        let hits = idx.search(&[1.0, 0.0], Metric::Dot, 2).expect("ok");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].rank, 0);
        assert_eq!(hits[1].rank, 1);
    }

    #[test]
    fn empty_index_search_is_empty() {
        let idx = FlatIndex::new(2).expect("ok");
        let hits = idx.search(&[1.0, 0.0], Metric::Cosine, 5).expect("ok");
        assert!(hits.is_empty());
    }

    #[test]
    fn k_zero_returns_empty() {
        let mut idx = FlatIndex::new(2).expect("ok");
        idx.add(v("a", vec![1.0, 0.0])).expect("ok");
        assert!(idx
            .search(&[1.0, 0.0], Metric::Dot, 0)
            .expect("ok")
            .is_empty());
    }

    #[test]
    fn search_query_dim_mismatch_is_error() {
        let mut idx = FlatIndex::new(2).expect("ok");
        idx.add(v("a", vec![1.0, 0.0])).expect("ok");
        assert!(idx.search(&[1.0], Metric::Cosine, 1).is_err());
    }

    #[test]
    fn search_rejects_non_finite_query() {
        let mut idx = FlatIndex::new(2).expect("ok");
        idx.add(v("a", vec![1.0, 0.0])).expect("ok");
        assert!(idx.search(&[f32::NAN, 0.0], Metric::Cosine, 1).is_err());
    }

    #[test]
    fn search_is_deterministic_across_insertion_order() {
        // Equal-scoring ids must come back in ascending-id order no matter how
        // they were added, so two index builds agree.
        let build = |order: &[&str]| -> Vec<String> {
            let mut idx = FlatIndex::new(2).expect("ok");
            for id in order {
                idx.add(v(id, vec![1.0, 1.0])).expect("ok"); // identical vectors
            }
            idx.search(&[1.0, 1.0], Metric::Cosine, 3)
                .expect("ok")
                .into_iter()
                .map(|h| h.id)
                .collect()
        };
        let a = build(&["z", "m", "a"]);
        let b = build(&["a", "m", "z"]);
        assert_eq!(a, vec!["a", "m", "z"]);
        assert_eq!(a, b);
    }

    #[test]
    fn snapshot_round_trips_bytes() {
        let mut idx = FlatIndex::new(3).expect("ok");
        idx.add(v("x", vec![1.0, 0.0, 0.0])).expect("ok");
        idx.add(v("y", vec![0.0, 1.0, 0.0])).expect("ok");
        let bytes = idx.snapshot_bytes().expect("ok");
        let loaded = FlatIndex::load_bytes(&bytes).expect("ok");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded.dim(), 3);
        let hits = loaded
            .search(&[1.0, 0.0, 0.0], Metric::Cosine, 1)
            .expect("ok");
        assert_eq!(hits[0].id, "x");
    }

    #[test]
    fn load_rejects_wrong_version() {
        // Build a valid snapshot, then corrupt its version digit.
        let idx = FlatIndex::new(2).expect("ok");
        let mut bytes = idx.snapshot_bytes().expect("ok");
        let marker = b"\"version\":";
        let pos = bytes
            .windows(marker.len())
            .position(|w| w == marker)
            .expect("marker present");
        bytes[pos + marker.len()] = b'9';
        assert!(FlatIndex::load_bytes(&bytes).is_err());
    }

    #[test]
    fn load_rejects_dimension_mismatch_rows() {
        let snap = Snapshot {
            version: SNAPSHOT_VERSION,
            dim: 3,
            rows: vec![Stored {
                id: "bad".into(),
                data: vec![1.0, 2.0], // only 2 components
            }],
        };
        let bytes = serde_json::to_vec(&snap).expect("serialise");
        assert!(FlatIndex::load_bytes(&bytes).is_err());
    }

    #[test]
    fn load_rejects_non_finite_row() {
        let snap = Snapshot {
            version: SNAPSHOT_VERSION,
            dim: 2,
            rows: vec![Stored {
                id: "bad".into(),
                data: vec![f32::NAN, 1.0],
            }],
        };
        let bytes = serde_json::to_vec(&snap).expect("serialise");
        assert!(FlatIndex::load_bytes(&bytes).is_err());
    }

    #[test]
    fn load_rejects_garbage() {
        assert!(FlatIndex::load_bytes(b"not a snapshot at all").is_err());
    }

    #[test]
    fn remove_then_reuse_id_allows_readd() {
        let mut idx = FlatIndex::new(2).expect("ok");
        idx.add(v("a", vec![1.0, 0.0])).expect("ok");
        idx.remove("a");
        idx.add(v("a", vec![0.0, 1.0])).expect("ok");
        assert_eq!(idx.len(), 1);
    }
}
