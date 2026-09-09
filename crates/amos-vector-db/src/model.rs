//! Data model for a stored vector and a retrieval hit.
//!
//! A vector is deliberately minimal: an [`id`](Vector::id) (how the consumer
//! maps back to a chunk / note / PDF page) plus a finite, non-empty float
//! vector. The *dimension* is owned by the index, not the vector, so the same
//! model can feed any embedder.

use serde::{Deserialize, Serialize};

use crate::error::{Result, VectorDbError};

/// One indexed passage (the embedder output for a chunk).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Vector {
    /// Stable identity the consumer maps back to a chunk (e.g. a note id +
    /// chunk index, or a PDF path + page). Must be non-empty.
    pub id: String,
    /// The embedding. Must be non-empty and contain only finite values; its
    /// length is validated against the index dimension on [`crate::FlatIndex`].
    pub data: Vec<f32>,
}

impl Vector {
    /// Validate and wrap an embedding: non-empty id, non-empty data, and every
    /// component finite. Anything else is an [`error`](crate::error) — never a
    /// silent `NaN` that could poison retrieval.
    pub fn new(id: impl Into<String>, data: Vec<f32>) -> Result<Self> {
        let id = id.into();
        if id.trim().is_empty() {
            return Err(VectorDbError::Invalid("vector id must be non-empty".into()));
        }
        if data.is_empty() {
            return Err(VectorDbError::Invalid(
                "vector data must be non-empty".into(),
            ));
        }
        if let Some(&v) = data.iter().find(|v| !v.is_finite()) {
            return Err(VectorDbError::Invalid(format!(
                "vector data contains a non-finite value: {v}"
            )));
        }
        Ok(Vector { id, data })
    }
}

/// One retrieval result: which id matched and how strongly.
#[derive(Clone, Debug, PartialEq)]
pub struct ScoredHit {
    /// Index position (0-based) of the hit, in the returned order.
    pub rank: usize,
    /// The stored vector's id.
    pub id: String,
    /// Similarity score: higher is more relevant. Meaning depends on the
    /// [`Metric`](crate::Metric) used (cosine is in `[-1, 1]`; dot is unbounded).
    pub score: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_new_rejects_empty_id() {
        assert!(Vector::new("   ", vec![0.0]).is_err());
        assert!(Vector::new("", vec![0.0]).is_err());
    }

    #[test]
    fn vector_new_rejects_empty_data() {
        assert!(Vector::new("a", vec![]).is_err());
    }

    #[test]
    fn vector_new_rejects_non_finite() {
        assert!(Vector::new("a", vec![f32::NAN]).is_err());
        assert!(Vector::new("a", vec![f32::INFINITY]).is_err());
        assert!(Vector::new("a", vec![1.0, f32::NEG_INFINITY]).is_err());
    }

    #[test]
    fn vector_new_accepts_valid() {
        let v = Vector::new("a", vec![0.5, -1.0, 0.0]).expect("valid");
        assert_eq!(v.id, "a");
        assert_eq!(v.data.len(), 3);
    }
}
