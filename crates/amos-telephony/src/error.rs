//! Error type and result alias for the telephony domain core.

use crate::session::CallState;
use thiserror::Error;

/// Errors surfaced by the telephony core engine and its providers.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum TelephonyError {
    /// A raw dial string could not be parsed as a phone number.
    #[error("invalid phone number: {0:?}")]
    InvalidNumber(String),

    /// A dial was requested for a number that is not a recognized emergency
    /// number, but went through the emergency-only path.
    #[error("{0:?} is not a recognized emergency number")]
    NotEmergency(String),

    /// No carrier / SIM is available to place this (regular) call.
    #[error("no carrier/SIM available for this call")]
    NoCarrier,

    /// A call id was used that the provider does not know about.
    #[error("call {0:?} not found")]
    UnknownCall(String),

    /// Call recording was requested but the domain refuses it (wrong call state,
    /// already/not recording, or an emergency line that must never be recorded).
    #[error("call recording forbidden: {0}")]
    RecordingForbidden(&'static str),

    /// The requested operation is not legal in the call's current state.
    #[error("illegal transition: call cannot {event} from {from:?}")]
    IllegalState {
        from: CallState,
        event: &'static str,
    },

    /// A provider (real or mock) reported a backend failure.
    #[error("provider failure: {0}")]
    Provider(String),
}

/// Result alias used throughout the telephony core.
pub type Result<T> = std::result::Result<T, TelephonyError>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::CallState;

    #[test]
    fn error_is_constructible_and_displayable() {
        let e = TelephonyError::IllegalState {
            from: CallState::Ended,
            event: "answer",
        };
        assert!(e.to_string().contains("answer"));
        assert!(e.to_string().contains("Ended"));
    }
}
