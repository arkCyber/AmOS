//! Error type shared across the crate.

use thiserror::Error as ThisError;

/// Errors produced while fetching a remote time, applying it to the clock, or
/// persisting clock state.
#[derive(Debug, Clone, PartialEq, Eq, ThisError)]
pub enum Error {
    /// A time source failed or produced nothing usable (network down, no server…).
    #[error("time source failed: {0}")]
    Source(String),

    /// A remote time fell outside the accepted absolute epoch window. This guards
    /// against a broken server or garbage response moving the clock to nonsense.
    #[error("implausible remote time (epoch seconds {0})")]
    Implausible(u64),

    /// Reading or writing the persisted clock state failed.
    #[error("clock state io error: {0}")]
    Io(String),
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;
