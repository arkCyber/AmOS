//! Error type and result alias for the app-store engine.

use thiserror::Error;

/// Errors surfaced by the app-store core engine / providers.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum StoreError {
    /// An [`crate::model::AppManifest`] id failed validation. Ids are how the
    /// ecosystem addresses an app, so they are constrained to a safe slug.
    #[error("invalid app id {0:?}: must match [a-z0-9]+([._-][a-z0-9]+)*")]
    InvalidAppId(String),

    /// A version string could not be parsed as `major.minor.patch[-pre]`.
    #[error("invalid version string: {0:?}")]
    InvalidVersion(String),

    /// A [`crate::model::Checksum`] value is malformed for its algorithm.
    #[error("invalid {algorithm} checksum: {value:?}")]
    InvalidChecksum {
        algorithm: &'static str,
        value: String,
    },

    /// An install was requested for an id the catalog does not publish.
    #[error("app {id:?} is not in the catalog")]
    UnknownApp { id: String },

    /// An uninstall / upgrade was requested for an app that is not installed.
    #[error("app {id:?} is not installed")]
    NotInstalled { id: String },

    /// An install was requested but the app is already present (any version);
    /// use [`crate::client::AppStore::upgrade`] to move to a newer release.
    #[error("app {id:?} is already installed at version {version}")]
    AlreadyInstalled { id: String, version: String },

    /// An upgrade was requested but the catalog has no newer version.
    #[error("app {id:?} has no update available (already at {version})")]
    NoUpdate { id: String, version: String },

    /// The downloaded package did not match the manifest's expected checksum,
    /// so the install was refused. A mismatch means a corrupt or tampered
    /// payload — never proceed on a mismatch.
    #[error("checksum mismatch for app {id:?}: expected {expected}, got {actual}")]
    ChecksumMismatch {
        id: String,
        expected: String,
        actual: String,
    },

    /// The manifest carried a developer (publisher) signature that does not
    /// verify against the manifest's own content — refused, since the signed
    /// identity can't be trusted for a corrupted payload.
    #[error("app {id:?} has an invalid publisher signature")]
    BadPublisherSignature { id: String },

    /// Any failure coming from the pluggable backend (catalog fetch, package
    /// download, store persistence). Message text carries the backend detail.
    #[error("{0}")]
    Provider(String),
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, StoreError>;
