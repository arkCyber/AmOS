//! The transport-agnostic embedding seam.
//!
//! The retrieval core never talks to a model server: it consumes already-made
//! vectors. Turning text (a chunk / note body / query) into a vector is this
//! crate's **one outward-facing seam**. The deterministic [`MockEmbedder`] is
//! what makes the whole pipeline host-testable and offline; the *real* embedder
//! for AmOS is an **Ollama `/api/embeddings` model served locally** — that
//! adapter lives in the `amos-ai` daemon crate, which already owns the HTTP
//! client and the `AMOS_OLLAMA_HOST` / local-server lifecycle for its
//! [`OllamaBackend`] chat path (see `docs/vector-db-rag.md`).
//!
//! Implementers only promise: *same text in → same (deterministic) vector out*
//! is NOT required of a real model (they may legitimately be stochastic), but
//! every returned vector must be finite, non-empty, and self-consistent in
//! dimension so [`crate::Vector::new`] can adopt it.

use crate::error::{Result, VectorDbError};

/// Converts one piece of text into an embedding.
///
/// The returned vector must be finite and non-empty; its length becomes the
/// caller's index dimension and must stay constant across calls for one model.
pub trait Embedder {
    /// Embed a single passage. A failure surfaces as an error at the seam, and
    /// the caller chooses whether to degrade (skip + report) or abort.
    fn embed(&self, text: &str) -> Result<Vec<f32>>;
}

// Allow a daemon to hold a dynamically-selected embedder (mock on host, Ollama on
// device) behind `Box<dyn Embedder>` and hand it to a store generic over `E:
// Embedder` without special-casing.
impl<E: Embedder + ?Sized> Embedder for Box<E> {
    fn embed(&self, text: &str) -> Result<Vec<f32>> {
        (**self).embed(text)
    }
}

/// A deterministic, dependency-free embedder for host tests / offline fallback.
///
/// It maps text to a fixed-`dim` vector by mixing a hash of the text with each
/// coordinate index, then bounding each component into `[0, 1)`. This is **not
/// semantic** — it only makes the pipeline (chunk → embed → index → search)
/// runnable and reproducible with zero model, so a headless test can lock the
/// wiring while a real Ollama embedder is a bring-up step.
#[derive(Clone, Debug)]
pub struct MockEmbedder {
    dim: usize,
}

impl MockEmbedder {
    /// Build a mock embedder with a fixed output dimension (`>= 1`).
    pub fn new(dim: usize) -> Result<Self> {
        if dim == 0 {
            return Err(VectorDbError::ZeroDimension);
        }
        Ok(MockEmbedder { dim })
    }

    /// The fixed dimension this embedder emits.
    pub fn dim(&self) -> usize {
        self.dim
    }
}

/// FNV-1a hash of `text` plus a per-coordinate `salt`, for reproducible mock
/// vectors.
fn hash_mix(text: &str, salt: u64) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    // Fold the salt in so different coordinates of the same text differ.
    h ^= salt.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    // final avalanche
    h ^= h >> 33;
    h.wrapping_mul(0xff51_afd7_ed55_8ccd)
}

impl Embedder for MockEmbedder {
    fn embed(&self, text: &str) -> Result<Vec<f32>> {
        if self.dim == 0 {
            return Err(VectorDbError::ZeroDimension);
        }
        let mut out = Vec::with_capacity(self.dim);
        for i in 0..self.dim as u64 {
            let h = hash_mix(text, i);
            // Map the high 24 bits into [0, 1). Always finite by construction.
            out.push(((h >> 40) as f32) / (1u64 << 24) as f32);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_rejects_zero_dim() {
        assert!(MockEmbedder::new(0).is_err());
    }

    #[test]
    fn mock_is_deterministic_and_dim_correct() {
        let e = MockEmbedder::new(8).expect("ok");
        let a = e.embed("hello world").expect("ok");
        let b = e.embed("hello world").expect("ok");
        assert_eq!(a, b);
        assert_eq!(a.len(), 8);
        assert!(a.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn mock_differs_for_diff_text() {
        let e = MockEmbedder::new(16).expect("ok");
        let a = e.embed("alpha").expect("ok");
        let b = e.embed("beta").expect("ok");
        assert_ne!(a, b);
    }

    #[test]
    fn mock_vectors_are_bounded_non_negative() {
        let e = MockEmbedder::new(32).expect("ok");
        let a = e.embed("bounds").expect("ok");
        assert!(a.iter().all(|v| (0.0..1.0).contains(v)));
    }

    #[test]
    fn empty_text_still_yields_finite_vector() {
        let e = MockEmbedder::new(4).expect("ok");
        let a = e.embed("").expect("ok");
        assert_eq!(a.len(), 4);
        assert!(a.iter().all(|v| v.is_finite()));
    }
}
