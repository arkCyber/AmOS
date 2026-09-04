//! Error type and result alias for the radio domain core.

use crate::state::RadioMode;
use thiserror::Error;

/// Errors surfaced by the radio manager and its providers.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum RadioError {
    /// A non-airplane radio was enabled while Airplane mode is active.
    #[error("airplane mode is on; turn it off before enabling {0:?}")]
    AirplaneActive(RadioMode),

    /// A provider (real or mock) reported a backend failure.
    #[error("radio provider failure: {0}")]
    Provider(String),
}

/// Result alias used throughout the radio core.
pub type Result<T> = std::result::Result<T, RadioError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_is_constructible_and_displayable() {
        let e = RadioError::AirplaneActive(RadioMode::Wifi);
        assert!(e.to_string().contains("airplane"));
        assert!(e.to_string().contains("Wifi"));
        assert_eq!(e, RadioError::AirplaneActive(RadioMode::Wifi));
    }
}
