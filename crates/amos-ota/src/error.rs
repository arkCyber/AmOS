//! The one error type for the OTA domain core.

use std::fmt;

/// An OTA domain error. Every variant names *what* was rejected, never a bare
/// "invalid input", so a caller (or a log) can tell a malformed remote manifest
/// from a local state-machine misuse.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum OtaError {
    /// A version string did not parse as `MAJOR.MINOR.PATCH[-pre][+build]`.
    #[error("invalid version: {0}")]
    InvalidVersion(String),
    /// A hex field was not the expected length or contained a non-hex character.
    #[error("invalid hex: {0}")]
    InvalidHex(String),
    /// A configured signing key could not be decoded into a public key — the
    /// hex was well-formed but not a point on the curve, or the wrong length.
    /// Distinct from [`OtaError::InvalidHex`]: the *input* was syntactically
    /// fine, it just is not a usable key, and the operator should be told which.
    #[error("invalid signing key: {0}")]
    InvalidKey(String),
    /// A manifest or package was structurally unusable: an empty package URI, a
    /// size of `0` or over the accepted ceiling, an empty signature key id or
    /// rollout salt…
    ///
    /// Note what is **not** here: an *empty* package list. `Manifest::new` accepts
    /// one, and a reachable source offering nothing on a channel is the honest
    /// `Ok(None)` — "nothing offered" — which the policy folds to `UpToDate`. It is
    /// not a malformed manifest that needs an error name.
    #[error("invalid manifest: {0}")]
    InvalidManifest(String),
    /// The state machine was asked for a transition it does not allow.
    #[error("illegal install transition {from} -> {to}: {reason}")]
    Transition {
        from: String,
        to: String,
        reason: String,
    },
    /// A provider (network/cache seam) failed. The message is the provider's own.
    #[error("update provider error: {0}")]
    Provider(String),
}

impl OtaError {
    /// Convenience constructor for [`OtaError::Provider`].
    pub fn provider(msg: impl fmt::Display) -> Self {
        OtaError::Provider(msg.to_string())
    }
}

/// `Result` alias for the OTA domain core.
pub type Result<T> = std::result::Result<T, OtaError>;
