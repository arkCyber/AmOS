//! Error type for the lifecycle manager.

use std::fmt;

/// A lifecycle-operation failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LifecycleError {
    /// The app id is not in the registry (no record to transition / query).
    Unknown(String),
    /// The requested transition is not allowed from the current state.
    InvalidTransition {
        id: String,
        from: String,
        to: String,
    },
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LifecycleError::Unknown(id) => write!(f, "no such process: {id}"),
            LifecycleError::InvalidTransition { id, from, to } => {
                write!(f, "invalid transition for {id}: {from} -> {to}")
            }
        }
    }
}

impl std::error::Error for LifecycleError {}

/// Convenience result alias.
pub type Result<T> = std::result::Result<T, LifecycleError>;
