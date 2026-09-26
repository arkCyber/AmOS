//! The fetch seam: where a manifest and a package image come from.
//!
//! The core never touches the network. It talks to an [`UpdateProvider`], whose
//! only real implementation in this crate is [`MockUpdateProvider`] — a
//! deterministic in-memory source for tests, the CLI and offline demos. A
//! deployment implements the trait over its CDN/HTTP client exactly as
//! `amos-appstore` implements its store seam.
//!
//! The trait is **synchronous** on purpose: it keeps the domain core free of a
//! runtime and fully offline-testable, and a caller that lives in an async
//! runtime is free to wrap its implementation in `spawn_blocking` (the same
//! shape `amos-timesync` uses for its blocking SNTP client). What the trait must
//! not do is *hide* a failure: an unreachable source returns `Err`, it never
//! invents an empty manifest, because "no manifest" and "up to date" must stay
//! distinguishable.

use std::collections::BTreeMap;

use crate::error::{OtaError, Result};
use crate::spec::{Channel, Manifest, UpdatePackage};

/// A source of update manifests and package bytes.
pub trait UpdateProvider: Send + Sync {
    /// The manifest currently offered on `channel`, or `None` if the source
    /// holds nothing for it. `Err` means the source could not be reached — a
    /// caller must not treat it as "up to date".
    fn fetch_manifest(&self, channel: Channel) -> Result<Option<Manifest>>;

    /// The bytes of `package`. Implementations must return the whole image; a
    /// short read must be reported as an `Err`, never as a truncated `Ok`, so
    /// the install machine's `Truncated` path is a *provider bug* and not the
    /// normal way to detect a short download.
    fn fetch_package(&self, package: &UpdatePackage) -> Result<Vec<u8>>;
}

/// A deterministic in-memory provider. Manifests are keyed by channel and
/// packages by URI; a URI with no registered payload is a provider error, not
/// an empty image.
#[derive(Clone, Debug, Default)]
pub struct MockUpdateProvider {
    manifests: BTreeMap<Channel, Manifest>,
    payloads: BTreeMap<String, Vec<u8>>,
    unreachable: bool,
}

impl MockUpdateProvider {
    /// An empty provider (nothing offered, nothing reachable-but-empty).
    pub fn new() -> MockUpdateProvider {
        MockUpdateProvider::default()
    }

    /// Offer `manifest` on `channel` (builder form).
    pub fn with_manifest(mut self, channel: Channel, manifest: Manifest) -> MockUpdateProvider {
        self.manifests.insert(channel, manifest);
        self
    }

    /// Register the bytes served for `uri` (builder form).
    pub fn with_payload(mut self, uri: impl Into<String>, bytes: Vec<u8>) -> MockUpdateProvider {
        self.payloads.insert(uri.into(), bytes);
        self
    }

    /// Register the bytes that a package's URI will serve.
    pub fn with_package(mut self, package: &UpdatePackage, bytes: Vec<u8>) -> MockUpdateProvider {
        self.payloads.insert(package.uri().to_string(), bytes);
        self
    }

    /// Make every fetch fail with a provider error, to exercise the
    /// unreachable-source path (as opposed to an empty-but-reachable source).
    pub fn set_unreachable(&mut self, unreachable: bool) {
        self.unreachable = unreachable;
    }
}

impl UpdateProvider for MockUpdateProvider {
    fn fetch_manifest(&self, channel: Channel) -> Result<Option<Manifest>> {
        if self.unreachable {
            return Err(OtaError::provider("mock source is marked unreachable"));
        }
        Ok(self.manifests.get(&channel).cloned())
    }

    fn fetch_package(&self, package: &UpdatePackage) -> Result<Vec<u8>> {
        if self.unreachable {
            return Err(OtaError::provider("mock source is marked unreachable"));
        }
        self.payloads
            .get(package.uri())
            .cloned()
            .ok_or_else(|| OtaError::provider(format!("no mock payload for {}", package.uri())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::UpdatePackage;
    use crate::version::Version;

    fn pkg() -> UpdatePackage {
        UpdatePackage::new(
            Version::parse("1.1.0").unwrap(),
            Channel::Stable,
            "https://cdn/1.1.0.img",
            "a".repeat(64),
            3,
        )
        .unwrap()
    }

    #[test]
    fn serves_registered_manifest_and_payload() {
        let p = pkg();
        let m = Manifest::new(vec![p.clone()], None).unwrap();
        let provider = MockUpdateProvider::new()
            .with_manifest(Channel::Stable, m.clone())
            .with_package(&p, b"img".to_vec());
        assert_eq!(provider.fetch_manifest(Channel::Stable).unwrap(), Some(m));
        assert_eq!(provider.fetch_package(&p).unwrap(), b"img".to_vec());
        // A channel with nothing registered is an honest `None`.
        assert_eq!(provider.fetch_manifest(Channel::Beta).unwrap(), None);
    }

    #[test]
    fn missing_payload_is_an_error_not_empty() {
        let provider = MockUpdateProvider::new();
        assert!(provider.fetch_package(&pkg()).is_err());
    }

    #[test]
    fn unreachable_is_an_error() {
        let mut provider = MockUpdateProvider::new();
        provider.set_unreachable(true);
        assert!(provider.fetch_manifest(Channel::Stable).is_err());
        assert!(provider.fetch_package(&pkg()).is_err());
    }
}
