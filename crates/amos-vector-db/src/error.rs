//! Error type for the local vector-retrieval core.
//!
//! The core never panics: anything the caller can get wrong (wrong dimension, a
//! corrupt snapshot, an un-routable embedder call) is a [`VectorDbError`] value.
//! Degradation is never silent.

use std::fmt;

/// Errors produced by the retrieval core.
#[derive(Debug)]
pub enum VectorDbError {
    /// A filesystem operation (snapshot save/load via a path) failed.
    Io(std::io::Error),
    /// A vector's length did not match the index dimension it was given to.
    DimMismatch { expected: usize, got: usize },
    /// The index was asked to do something without a meaningful dimension.
    ZeroDimension,
    /// A vector was empty, contained `NaN`/`inf`, or had an empty id.
    Invalid(String),
    /// A snapshot could not be parsed or did not pass well-formedness checks.
    Corrupt(String),
    /// An embedder backend reported a failure (produced at the seam).
    Embed(String),
}

impl fmt::Display for VectorDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VectorDbError::Io(e) => write!(f, "vector index I/O error: {e}"),
            VectorDbError::DimMismatch { expected, got } => {
                write!(
                    f,
                    "vector dimension mismatch: index is {expected}, got {got}"
                )
            }
            VectorDbError::ZeroDimension => write!(f, "a vector index dimension must be >= 1"),
            VectorDbError::Invalid(msg) => write!(f, "invalid vector: {msg}"),
            VectorDbError::Corrupt(msg) => write!(f, "corrupt index snapshot: {msg}"),
            VectorDbError::Embed(msg) => write!(f, "embedder failed: {msg}"),
        }
    }
}

impl std::error::Error for VectorDbError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            VectorDbError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for VectorDbError {
    fn from(e: std::io::Error) -> Self {
        VectorDbError::Io(e)
    }
}

/// Convenience alias used across the crate.
pub type Result<T> = std::result::Result<T, VectorDbError>;
