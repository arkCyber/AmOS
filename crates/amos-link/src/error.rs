//! The single error type of the AmOS-Link middleware.
//!
//! Every fallible operation in the crate returns [`Result`]; the variants name the
//! layer that refused, so a caller can tell a *programmer* error (a malformed topic
//! or an unsupported QoS combination) apart from an *environment* one (a transport
//! that went away). Errors are `String`-carrying on purpose: the link layer must be
//! `Clone + Send + Sync 'static` so it can travel through `tonic::Status` and a
//! subscriber's decode loop without allocating a boxed source chain per frame.

use thiserror::Error;

/// Everything AmOS-Link can refuse to do.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LinkError {
    /// A topic (key expression) is empty, too long, or has illegal characters.
    #[error("invalid key expression `{expr}`: {reason}")]
    KeyExpr {
        /// The offending key expression, as supplied by the caller.
        expr: String,
        /// Why it was refused.
        reason: String,
    },

    /// A payload could not be encoded / decoded as a `Message`.
    #[error("codec error: {0}")]
    Codec(String),

    /// A wire frame is not an AmOS-Link `Envelope` (magic, version, length, CRC).
    #[error("frame error: {0}")]
    Frame(String),

    /// The request is well-formed but not something this build implements
    /// (e.g. `DropPolicy::DropOldest` with a queue depth > 1).
    #[error("unsupported: {0}")]
    Unsupported(String),

    /// The underlying transport failed (socket, session, broken link).
    #[error("transport error: {0}")]
    Transport(String),

    /// The far end went away: the subscription/broker/session is closed.
    #[error("link closed: {0}")]
    Closed(String),

    /// A robot command (agent JSON, joint target, gait) was refused.
    #[error("robot command error: {0}")]
    Robot(String),
}

impl LinkError {
    /// Build a [`LinkError::KeyExpr`] from a caller-supplied key expression.
    pub fn key_expr(expr: impl Into<String>, reason: impl Into<String>) -> Self {
        LinkError::KeyExpr {
            expr: expr.into(),
            reason: reason.into(),
        }
    }
}

/// The crate's result alias.
pub type Result<T> = std::result::Result<T, LinkError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_render_the_offending_input() {
        let e = LinkError::key_expr("amos//imu", "empty segment");
        let text = e.to_string();
        assert!(text.contains("amos//imu"), "got: {text}");
        assert!(text.contains("empty segment"), "got: {text}");
    }

    #[test]
    fn errors_are_comparable_and_cloneable() {
        // The control plane funnels these through `tonic::Status`, so `Clone` +
        // value equality matter (two identical refusals must compare equal).
        let a = LinkError::Unsupported("drop_oldest depth 4".to_string());
        let b = a.clone();
        assert_eq!(a, b);
        assert_ne!(a, LinkError::Closed("broker gone".to_string()));
    }
}
