//! The [`StoreProvider`] seam and a deterministic in-memory
//! [`MockStoreProvider`].
//!
//! Every store backend — the offline mock today, a real HTTP catalog +
//! package CDN tomorrow — goes behind [`StoreProvider`]. Callers (a future
//! CLI / Tauri bridge via [`crate::client::AppStore`]) only ever talk to this
//! trait, so swapping the source of catalog + package bytes is invisible to
//! the install/upgrade logic.
//!
//! The provider is *only* the read source (catalog + package bytes). The local
//! notion of "what is installed" is owned by the [`AppStore`](crate::client::AppStore)
//! engine, so network state and device state stay cleanly separated.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{Result, StoreError};
use crate::model::{AppManifest, Checksum};

/// A pluggable source of apps: what is available (the catalog) and the raw
/// bytes of any published package.
#[async_trait]
pub trait StoreProvider: Send + Sync {
    /// Backend display name, e.g. `"mock-store"` or, later, `"catalog+https://…"`.
    fn name(&self) -> &'static str;

    /// The full list of apps this backend currently publishes (the catalog).
    async fn catalog(&self) -> Result<Vec<AppManifest>>;

    /// Download the raw bytes of the package for `manifest`. The engine will
    /// verify the bytes against `manifest.package.sha256` before installing;
    /// the provider is trusted only to *fetch*, never to decide integrity.
    async fn fetch_package(&self, manifest: &AppManifest) -> Result<Vec<u8>>;
}

// ---------------------------------------------------------------------------
// MockStoreProvider
// ---------------------------------------------------------------------------

/// The mock's backing state, shared behind a mutex so the provider is
/// `Send + Sync` while each async call can read the same catalog.
#[derive(Clone, Default)]
struct State {
    /// Published manifests, in insertion order.
    catalog: Vec<AppManifest>,
    /// Raw package bytes keyed by app id (one artifact per id).
    packages: HashMap<String, Vec<u8>>,
}

/// Deterministic [`StoreProvider`] with an in-memory catalog and canned package
/// bytes.
///
/// Suitable for unit tests and offline demos. Apps are registered with
/// [`add`](Self::add) (which *recomputes* the manifest's sha256 from the bytes,
/// so the integrity invariant always holds) or [`add_broken`](Self::add_broken)
/// (which keeps the manifest's declared digest so tests can exercise the
/// checksum-mismatch refusal path).
#[derive(Clone, Default)]
pub struct MockStoreProvider {
    state: Arc<Mutex<State>>,
}

impl MockStoreProvider {
    /// An empty provider with no catalog entries.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `manifest` + `bytes`, stamping `bytes`' real sha256 into the
    /// manifest's package so a subsequent install always verifies. Registering
    /// an id again replaces its manifest and bytes (how a catalog ships a newer
    /// version of the same app). A poorly-formed manifest is refused.
    pub fn add(&self, manifest: AppManifest, bytes: Vec<u8>) -> Result<()> {
        let mut manifest = manifest;
        manifest.validate()?;
        manifest.package.sha256 = Some(Checksum::sha256(Checksum::sha256_hex(&bytes))?);
        self.insert(manifest, bytes)
    }

    /// Register `manifest` + `bytes` *without* reconciling the digest, so a
    /// declared-but-wrong sha256 stays wrong. Test-only aid for proving the
    /// engine refuses tampered / mismatched downloads.
    pub fn add_broken(&self, manifest: AppManifest, bytes: Vec<u8>) -> Result<()> {
        manifest.validate()?;
        self.insert(manifest, bytes)
    }

    fn insert(&self, manifest: AppManifest, bytes: Vec<u8>) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| StoreError::Provider("mock store poisoned".into()))?;
        if let Some(existing) = state.catalog.iter_mut().find(|m| m.id == manifest.id) {
            *existing = manifest.clone();
        } else {
            state.catalog.push(manifest.clone());
        }
        state.packages.insert(manifest.id, bytes);
        Ok(())
    }
}

#[async_trait]
impl StoreProvider for MockStoreProvider {
    fn name(&self) -> &'static str {
        "mock-store"
    }

    async fn catalog(&self) -> Result<Vec<AppManifest>> {
        self.state
            .lock()
            .map(|s| s.catalog.clone())
            .map_err(|_| StoreError::Provider("mock store poisoned".into()))
    }

    async fn fetch_package(&self, manifest: &AppManifest) -> Result<Vec<u8>> {
        let state = self
            .state
            .lock()
            .map_err(|_| StoreError::Provider("mock store poisoned".into()))?;
        state.packages.get(&manifest.id).cloned().ok_or_else(|| {
            StoreError::Provider(format!("no package bytes for app {}", manifest.id))
        })
    }
}

/// Blanket impl so a boxed provider can stand anywhere a concrete one can — the
/// seam that lets a bridge hold `AppStore<Box<dyn StoreProvider>>` and swap the
/// offline mock for a live HTTP backend at runtime with no engine changes.
#[async_trait]
impl StoreProvider for Box<dyn StoreProvider> {
    fn name(&self) -> &'static str {
        (**self).name()
    }

    async fn catalog(&self) -> Result<Vec<AppManifest>> {
        (**self).catalog().await
    }

    async fn fetch_package(&self, manifest: &AppManifest) -> Result<Vec<u8>> {
        (**self).fetch_package(manifest).await
    }
}

/// The on-disk shape of a mock catalog: a list of manifests (JSON). Kept here
/// so the mock can round-trip a published catalog through a file (mirrors how
/// `amos-mail`'s mock persists its store).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MockCatalog {
    /// Backend display name echoed back on load.
    pub name: String,
    pub apps: Vec<AppManifest>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AppCategory, PackageFormat, PackageRef, Version};

    fn app(id: &str, name: &str, ver: &str) -> AppManifest {
        AppManifest {
            id: id.into(),
            name: name.into(),
            summary: "demo app".into(),
            description: String::new(),
            author: "Amos Team".into(),
            version: Version::parse(ver).unwrap(),
            category: AppCategory::Tools,
            homepage: String::new(),
            icon_url: String::new(),
            package: PackageRef {
                format: PackageFormat::TarGz,
                url: format!("https://cdn.example.com/{id}.tgz"),
                sha256: None,
                size_bytes: None,
            },
            publisher: None,
        }
    }

    #[tokio::test]
    async fn add_stamps_real_checksum_and_catalog_roundtrips() {
        let p = MockStoreProvider::new();
        p.add(app("org.amos.one", "One", "1.0.0"), b"payload one".to_vec())
            .unwrap();
        p.add(app("org.amos.two", "Two", "2.0.0"), b"payload two".to_vec())
            .unwrap();

        let cat = p.catalog().await.unwrap();
        assert_eq!(cat.len(), 2);
        // The manifest shipped by the catalog now carries a verifiable digest.
        let cs = cat[0].package.sha256.as_ref().unwrap();
        assert!(cs.verify(b"payload one"), "stamped digest matches bytes");
    }

    #[tokio::test]
    async fn replacing_an_id_upgrades_the_catalog_entry() {
        let p = MockStoreProvider::new();
        p.add(app("org.amos.x", "X", "1.0.0"), b"v1 bytes".to_vec())
            .unwrap();
        p.add(app("org.amos.x", "X", "1.1.0"), b"v2 bytes".to_vec())
            .unwrap();

        let cat = p.catalog().await.unwrap();
        assert_eq!(cat.len(), 1, "same id collapses to one catalog entry");
        assert_eq!(cat[0].version.to_string(), "1.1.0", "latest wins");
        let bytes = p.fetch_package(&cat[0]).await.unwrap();
        assert_eq!(bytes, b"v2 bytes");
    }

    #[tokio::test]
    async fn add_rejects_invalid_manifest_and_fetch_unknown_is_clean_error() {
        let p = MockStoreProvider::new();
        let mut bad = app("Has Space", "Bad", "1.0.0");
        assert!(p.add(bad.clone(), b"x".to_vec()).is_err());

        // A manifest never registered has no bytes → Provider error, not panic.
        bad.id = "org.amos.never".into();
        let err = p.fetch_package(&bad).await.unwrap_err();
        assert!(matches!(err, StoreError::Provider(_)));
    }

    #[tokio::test]
    async fn add_broken_keeps_declared_wrong_digest() {
        let p = MockStoreProvider::new();
        let mut m = app("org.amos.broken", "Broken", "1.0.0");
        m.package.sha256 = Some(Checksum::sha256("a".repeat(64)).unwrap()); // not the real digest
        p.add_broken(m.clone(), b"real bytes".to_vec()).unwrap();

        let cat = p.catalog().await.unwrap();
        let declared = cat[0].package.sha256.as_ref().unwrap();
        assert!(
            !declared.verify(b"real bytes"),
            "broken entry must NOT match its own bytes"
        );
    }

    #[test]
    fn mock_catalog_json_roundtrips_the_publish_shape() {
        // The on-disk catalog contract: name + list of manifests. Round-tripping
        // through JSON keeps the wire shape pinned (mirrors docs/appstore.md §4.5).
        let cat = MockCatalog {
            name: "mock-store".into(),
            apps: vec![
                app("org.amos.one", "One", "1.0.0"),
                app("org.amos.two", "Two", "2.0.0"),
            ],
        };
        let json = serde_json::to_string_pretty(&cat).unwrap();
        let back: MockCatalog = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "mock-store");
        assert_eq!(back.apps.len(), 2);
        assert_eq!(back.apps[0].id, "org.amos.one");
        assert_eq!(back.apps[1].version.to_string(), "2.0.0");
        assert_eq!(
            back.apps[0].category,
            crate::model::AppCategory::Tools,
            "manifest fields survive the JSON round-trip"
        );
    }
    #[tokio::test]
    async fn boxed_provider_delegates_like_its_concrete_impl() {
        let inner = MockStoreProvider::new();
        inner
            .add(
                app("org.amos.boxed", "Boxed", "1.0.0"),
                b"box bytes".to_vec(),
            )
            .unwrap();
        let p: Box<dyn StoreProvider> = Box::new(inner);

        let cat = p.catalog().await.unwrap();
        assert_eq!(cat.len(), 1);
        assert_eq!(cat[0].id, "org.amos.boxed");
        let bytes = p.fetch_package(&cat[0]).await.unwrap();
        assert_eq!(bytes, b"box bytes");
    }
}
