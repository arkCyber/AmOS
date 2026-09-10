//! Error type for the SMS domain (small, `Send + Sync`, honest).

use thiserror::Error;

/// An SMS operation failure. `Unavailable` means no real provider is configured
/// (host/offline); `Failed` is a genuine send/read error; `Invalid` is a corrupt
/// or impossible payload that must never be silently accepted.
#[derive(Debug, Error, Clone, PartialEq)]
pub enum SmsError {
    #[error("SMS provider unavailable: {0}")]
    Unavailable(String),
    #[error("SMS operation failed: {0}")]
    Failed(String),
    #[error("invalid SMS payload: {0}")]
    Invalid(String),
}
