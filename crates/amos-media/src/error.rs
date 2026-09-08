//! Error type and result alias for the media domain core.

use thiserror::Error;

use crate::spec::{AccessKind, StandardDir};

/// Errors surfaced by the media manager and its providers.
///
/// The set is deliberately small and typed so the System UI can react to
/// **authorization** failures (show a permission prompt) distinctly from
/// **availability** failures (nothing there / backend broken) — never collapse
/// them into a silent empty list.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum MediaError {
    /// The requested [`crate::spec::AccessKind`] on a [`StandardDir`] is not
    /// authorized. This is the honest signal the UI maps to a permission
    /// prompt — it is **not** turned into an empty list.
    #[error("media {access:?} on {collection:?} is not authorized")]
    Unauthorized {
        access: AccessKind,
        collection: StandardDir,
    },

    /// A specific item / collection the caller asked for does not exist.
    #[error("media not found: {0}")]
    NotFound(String),

    /// A write exceeds the provider's size ceiling.
    #[error("media write of {bytes} bytes exceeds the ceiling of {max} bytes")]
    TooLarge { bytes: u64, max: u64 },

    /// The arguments to a call were internally inconsistent.
    #[error("invalid arguments: {0}")]
    InvalidArguments(String),

    /// A provider (real or mock) reported a backend failure.
    #[error("media provider failure: {0}")]
    Provider(String),
}

/// Result alias used throughout the media core.
pub type Result<T> = std::result::Result<T, MediaError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_displayable_and_comparable() {
        let e = MediaError::Unauthorized {
            access: AccessKind::Read,
            collection: StandardDir::Camera,
        };
        assert!(e.to_string().contains("not authorized"));
        assert_eq!(
            e,
            MediaError::Unauthorized {
                access: AccessKind::Read,
                collection: StandardDir::Camera,
            }
        );
        assert!(MediaError::NotFound("no file".to_string())
            .to_string()
            .contains("no file"));
        assert!(MediaError::TooLarge { bytes: 9, max: 5 }
            .to_string()
            .contains("ceiling"));
        assert!(MediaError::InvalidArguments("bad".to_string())
            .to_string()
            .contains("invalid arguments"));
        assert!(MediaError::Provider("boom".to_string())
            .to_string()
            .contains("boom"));
    }
}
