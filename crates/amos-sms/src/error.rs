//! Error type for the SMS domain (small, `Send + Sync`, honest).

use thiserror::Error;

/// An SMS operation failure. `Unavailable` means no real provider is configured
/// (host/offline); `PermissionDenied` means the platform refused the read/send
/// for lack of a runtime permission (the UI must say so — it is *not* an empty
/// inbox); `Failed` is a genuine read/send error; `Invalid` is a corrupt or
/// impossible payload/request that must never be silently accepted.
///
/// `TimedOut` is deliberately **not** `Failed`: nothing refused the operation —
/// the caller simply stopped waiting before the platform named a verdict. For a
/// send that is an *absent* verdict, not a negative one: the message may still go
/// out, so a caller must be able to keep the two apart (REQ-A1759/F-TEL-045).
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
    #[error("SMS provider timed out: {0}")]
    TimedOut(String),
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
            SmsError::TimedOut(_) => "timeout",
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
        // An absent verdict is its own kind — folding it into "failed" is the
        // defect this variant exists to prevent, so it must not share a key with
        // the refusal kind (REQ-A1759/F-TEL-045).
        assert_eq!(SmsError::TimedOut("x".into()).kind(), "timeout");
        assert_ne!(
            SmsError::TimedOut("x".into()).kind(),
            SmsError::Failed("x".into()).kind()
        );
    }
}
