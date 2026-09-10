//! Error type for the SMS domain (small, `Send + Sync`, honest).

use thiserror::Error;

/// An SMS operation failure. `Unavailable` means no real provider is configured
/// (host/offline); `PermissionDenied` means the platform refused the read/send
/// for lack of a runtime permission (the UI must say so — it is *not* an empty
/// inbox); `Failed` is a genuine read/send error; `Invalid` is a corrupt or
/// impossible payload/request that must never be silently accepted.
#[derive(Debug, Error, Clone, PartialEq)]
pub enum SmsError {
    #[error("SMS provider unavailable: {0}")]
    Unavailable(String),
    #[error("SMS permission denied: {0}")]
    PermissionDenied(String),
    #[error("SMS operation failed: {0}")]
    Failed(String),
    #[error("invalid SMS payload: {0}")]
    Invalid(String),
}

impl SmsError {
    /// Stable machine-readable kind, used by the wire/UI to branch without
    /// parsing human text.
    pub fn kind(&self) -> &'static str {
        match self {
            SmsError::Unavailable(_) => "unavailable",
            SmsError::PermissionDenied(_) => "permission",
            SmsError::Failed(_) => "failed",
            SmsError::Invalid(_) => "invalid",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_are_stable_and_distinct() {
        assert_eq!(SmsError::Unavailable("x".into()).kind(), "unavailable");
        assert_eq!(SmsError::PermissionDenied("x".into()).kind(), "permission");
        assert_eq!(SmsError::Failed("x".into()).kind(), "failed");
        assert_eq!(SmsError::Invalid("x".into()).kind(), "invalid");
    }
}
