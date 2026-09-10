//! Error type for the blocklist domain (small, `Send + Sync`, honest).

use thiserror::Error;

/// Why a rule (or a whole blocklist payload) was rejected.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum BlocklistError {
    /// The pattern is not a usable number (blank, non-digits, too short for a
    /// prefix rule, …).
    #[error("invalid blocklist pattern: {0}")]
    InvalidPattern(String),
    /// A stored/loaded payload could not be trusted (corrupt or over the cap).
    #[error("invalid blocklist payload: {0}")]
    InvalidPayload(String),
}

impl BlocklistError {
    /// Stable machine-readable kind (mirrors `SmsError::kind`).
    pub fn kind(&self) -> &'static str {
        match self {
            BlocklistError::InvalidPattern(_) => "invalid-pattern",
            BlocklistError::InvalidPayload(_) => "invalid-payload",
        }
    }
}
