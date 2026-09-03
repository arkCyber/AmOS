//! The high-level [`AppStore`] engine that a CLI or Tauri bridge drives.
//!
//! It wraps any [`StoreProvider`] (the *source* of apps) plus a local registry
//! of what is installed, and enforces the package-manager rules:
//!
//! * **download → verify → install**: a package is fetched from the provider,
//!   checked against the manifest's sha256, and only a verified payload is
//!   recorded as installed. A checksum mismatch is a hard refusal.
//! * **upgrade only**: an already-installed app must go up in version, never
//!   silently down or duplicate.
//! * **durable registry**: the installed set can be persisted to a JSON file
//!   ([`open`](Self::open) / [`save_file`](Self::save_file)) so installs survive
//!   restarts — mirroring how `amos-mail`'s mock persists its mailbox store.
//!
//! The engine itself performs no network I/O; all downloads go through the
//! provider seam. By default it records the *verified manifest snapshot* rather
//! than touching disk — but when given a web-install dir
//! ([`with_web_install_dir`](AppStore::with_web_install_dir)) a `tar.gz`
//! web-bundle is also unpacked to `<dir>/<id>/` so the app is runnable on disk.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Result, StoreError};
use crate::model::{AppManifest, AppStatus, Checksum, InstalledApp, PackageFormat};
use crate::StoreProvider;

/// The local record of everything installed, keyed by app id. `BTreeMap` keeps
/// listings deterministic; derives `serde` so it can be snapshotted to disk.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Registry {
    apps: BTreeMap<String, InstalledApp>,
}

/// Engine over a [`StoreProvider`]. The provider owns the network side; this
/// struct owns the device side (what is installed) behind a mutex so calls are
/// safe to run concurrently.
pub struct AppStore<P: StoreProvider> {
    provider: P,
    installed: Arc<Mutex<Registry>>,
    /// When set, installing a `tar.gz` web-bundle also unpacks it under this
    /// directory (`<dir>/<id>/`), so an installed app is runnable on disk.
    web_install: Option<PathBuf>,
}

/// Current unix-epoch seconds (used to stamp installs).
fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl<P: StoreProvider> AppStore<P> {
    /// Wrap a provider with an empty, ephemeral registry.
    pub fn new(provider: P) -> Self {
        Self {
            provider,
            installed: Arc::new(Mutex::new(Registry::default())),
            web_install: None,
        }
    }

    /// Wrap a provider and load a previously-persisted registry from `path`
    /// (an empty registry when the file does not exist). Use [`save_file`] to
    /// write it back after mutations.
    pub fn open(provider: P, path: &Path) -> Result<Self> {
        let registry = if path.exists() {
            let bytes = std::fs::read(path)
                .map_err(|e| StoreError::Provider(format!("read {path:?}: {e}")))?;
            serde_json::from_slice(&bytes)
                .map_err(|e| StoreError::Provider(format!("parse {path:?}: {e}")))?
        } else {
            Registry::default()
        };
        Ok(Self {
            provider,
            installed: Arc::new(Mutex::new(registry)),
            web_install: None,
        })
    }

    /// Set the directory under which `tar.gz` web-bundles are unpacked on
    /// install (`<dir>/<id>/`). Returns `self` for chaining after `new`/`open`.
    pub fn with_web_install_dir(mut self, dir: PathBuf) -> Self {
        self.web_install = Some(dir);
        self
    }

    /// The configured web-bundle install root, if any.
    pub fn web_install_dir(&self) -> Option<&Path> {
        self.web_install.as_deref()
    }

    /// When a web-install dir is set and the package is a `tar.gz` web-bundle,
    /// unpack it to disk. Fails (and cleans up) instead of recording an app
    /// whose bundle can't actually be installed.
    fn install_bundle(&self, manifest: &AppManifest, bytes: &[u8]) -> Result<()> {
        let Some(dir) = &self.web_install else {
            return Ok(());
        };
        if manifest.package.format != PackageFormat::TarGz {
            return Ok(());
        }
        let installer = crate::webinstall::WebInstaller::new(dir.clone());
        match installer.install(manifest, bytes) {
            Ok(_) => Ok(()),
            Err(e) => {
                let _ = installer.uninstall(&manifest.id);
                Err(e)
            }
        }
    }

    /// Persist the current installed registry to `path` as pretty JSON.
    pub fn save_file(&self, path: &Path) -> Result<()> {
        let registry = self
            .installed
            .lock()
            .map_err(|_| StoreError::Provider("registry poisoned".into()))?;
        let bytes = serde_json::to_vec_pretty(&*registry)
            .map_err(|e| StoreError::Provider(format!("serialize: {e}")))?;
        std::fs::write(path, bytes)
            .map_err(|e| StoreError::Provider(format!("write {path:?}: {e}")))?;
        Ok(())
    }

    /// Backend display name (e.g. `"mock-store"`).
    pub fn provider_name(&self) -> &'static str {
        self.provider.name()
    }

    /// Every app the store publishes, sorted by id for stable listings.
    pub async fn catalog(&self) -> Result<Vec<AppManifest>> {
        let mut cat = self.provider.catalog().await?;
        cat.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(cat)
    }

    /// The apps currently installed, sorted by id.
    pub fn installed(&self) -> Result<Vec<InstalledApp>> {
        Ok(self
            .installed
            .lock()
            .map_err(|_| StoreError::Provider("registry poisoned".into()))?
            .apps
            .values()
            .cloned()
            .collect())
    }

    /// Whether `id` is installed.
    pub fn is_installed(&self, id: &str) -> Result<bool> {
        Ok(self
            .installed
            .lock()
            .map_err(|_| StoreError::Provider("registry poisoned".into()))?
            .apps
            .contains_key(id))
    }

    /// Ids of installed apps that have a newer release in the catalog.
    pub async fn updatable(&self) -> Result<Vec<String>> {
        let installed = self.installed()?;
        let latest: BTreeMap<String, crate::model::Version> = self
            .provider
            .catalog()
            .await?
            .into_iter()
            .map(|m| (m.id, m.version))
            .collect();
        let mut out = Vec::new();
        for app in installed {
            if let Some(latest) = latest.get(app.id()) {
                if latest > app.version() {
                    out.push(app.id().to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// The single catalog entry for `id`, if the store still publishes it.
    pub async fn find(&self, id: &str) -> Result<Option<AppManifest>> {
        let cat = self.provider.catalog().await?;
        Ok(cat.into_iter().find(|m| m.id == id))
    }

    /// Search the catalog by id / name / summary / author / category
    /// (case-insensitive substring), sorted by id. An empty query returns the
    /// whole catalog — mirroring `amos-mail`'s search semantics.
    pub async fn search(&self, query: &str) -> Result<Vec<AppManifest>> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return self.catalog().await;
        }
        let cat = self.provider.catalog().await?;
        let mut out: Vec<_> = cat
            .into_iter()
            .filter(|m| {
                m.id.to_lowercase().contains(&needle)
                    || m.name.to_lowercase().contains(&needle)
                    || m.summary.to_lowercase().contains(&needle)
                    || m.author.to_lowercase().contains(&needle)
                    || m.category.as_str().contains(&needle)
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    /// Install the catalog's current release of `id`.
    ///
    /// Fetches the package through the provider, verifies it against the
    /// manifest's sha256 (refusing on mismatch), and records the verified
    /// manifest as installed. Fails with [`StoreError::AlreadyInstalled`] if
    /// the app is already present — use [`upgrade`](Self::upgrade) to move to
    /// a newer release.
    pub async fn install(&self, id: &str) -> Result<InstalledApp> {
        let manifest = self.resolve_catalog(id).await?;
        check_publisher(&manifest)?;
        if self.is_installed(id)? {
            return Err(StoreError::AlreadyInstalled {
                id: id.to_string(),
                version: self
                    .installed
                    .lock()
                    .map_err(|_| StoreError::Provider("registry poisoned".into()))?
                    .apps
                    .get(id)
                    .map(|a| a.version().to_string())
                    .unwrap_or_default(),
            });
        }
        let bytes = self.provider.fetch_package(&manifest).await?;
        verify_bytes(id, &manifest, &bytes)?;
        self.install_bundle(&manifest, &bytes)?;
        self.record(manifest)
    }

    /// Upgrade `id` to the catalog's newest release (no-op when already current).
    pub async fn upgrade(&self, id: &str) -> Result<InstalledApp> {
        let current = self
            .installed
            .lock()
            .map_err(|_| StoreError::Provider("registry poisoned".into()))?
            .apps
            .get(id)
            .cloned()
            .ok_or_else(|| StoreError::NotInstalled { id: id.to_string() })?;
        let latest = self.resolve_catalog(id).await?;
        check_publisher(&latest)?;
        if latest.version <= *current.version() {
            return Err(StoreError::NoUpdate {
                id: id.to_string(),
                version: current.version().to_string(),
            });
        }
        let bytes = self.provider.fetch_package(&latest).await?;
        verify_bytes(id, &latest, &bytes)?;
        self.install_bundle(&latest, &bytes)?;
        self.record(latest)
    }

    /// Remove `id` from the installed registry (and its unpacked bundle, if any).
    pub fn uninstall(&self, id: &str) -> Result<()> {
        {
            let mut registry = self
                .installed
                .lock()
                .map_err(|_| StoreError::Provider("registry poisoned".into()))?;
            if registry.apps.remove(id).is_none() {
                return Err(StoreError::NotInstalled { id: id.to_string() });
            }
        }
        if let Some(dir) = &self.web_install {
            let _ = crate::webinstall::WebInstaller::new(dir.clone()).uninstall(id);
        }
        Ok(())
    }

    /// The lifecycle state of `id` (Available / Installed / Updatable).
    pub async fn status(&self, id: &str) -> Result<AppStatus> {
        let installed = self
            .installed
            .lock()
            .map_err(|_| StoreError::Provider("registry poisoned".into()))?
            .apps
            .get(id)
            .cloned();
        let cataloged = self.resolve_catalog(id).await.ok();

        let Some(app) = installed else {
            return match cataloged {
                Some(_) => Ok(AppStatus::Available),
                None => Err(StoreError::UnknownApp { id: id.to_string() }),
            };
        };
        let current = app.version().to_string();
        match cataloged {
            Some(latest) if latest.version > *app.version() => Ok(AppStatus::Updatable {
                installed: current,
                latest: latest.version.to_string(),
            }),
            _ => Ok(AppStatus::Installed { version: current }),
        }
    }

    /// Find the manifest `id` currently publishes in the catalog.
    async fn resolve_catalog(&self, id: &str) -> Result<AppManifest> {
        let cat = self.provider.catalog().await?;
        cat.into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| StoreError::UnknownApp { id: id.to_string() })
    }

    /// Record a verified manifest as installed (replacing any previous entry,
    /// which is how an upgrade lands). Stamps the install time.
    fn record(&self, manifest: AppManifest) -> Result<InstalledApp> {
        let app = InstalledApp {
            installed_at: now_epoch(),
            manifest,
        };
        let mut registry = self
            .installed
            .lock()
            .map_err(|_| StoreError::Provider("registry poisoned".into()))?;
        registry.apps.insert(app.id().to_string(), app.clone());
        Ok(app)
    }
}

/// Enforce the integrity contract: when the manifest declares a checksum, the
/// downloaded bytes must match it or the install is refused.
fn verify_bytes(id: &str, manifest: &AppManifest, bytes: &[u8]) -> Result<()> {
    let Some(expected) = &manifest.package.sha256 else {
        return Ok(()); // no digest declared → trusted source, nothing to check
    };
    if expected.verify(bytes) {
        Ok(())
    } else {
        Err(StoreError::ChecksumMismatch {
            id: id.to_string(),
            expected: expected.value.clone(),
            actual: Checksum::sha256_hex(bytes),
        })
    }
}

/// When a manifest claims a developer signature, it must verify against its own
/// content — a broken/mismatched signature is refused even before download.
/// (Unsigned manifests pass; requiring signatures is a store policy, not the
/// engine's.)
fn check_publisher(manifest: &AppManifest) -> Result<()> {
    if manifest.is_signed() && !crate::sign::verify_manifest_signature(manifest) {
        return Err(StoreError::BadPublisherSignature {
            id: manifest.id.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AppCategory, AppStatus, PackageFormat, PackageRef};
    use crate::provider::MockStoreProvider;

    fn app(id: &str, name: &str, ver: &str) -> AppManifest {
        AppManifest {
            id: id.into(),
            name: name.into(),
            summary: "demo app".into(),
            description: String::new(),
            author: "Amos Team".into(),
            version: crate::model::Version::parse(ver).unwrap(),
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

    /// A provider with two healthy apps at v1.0.0.
    fn seeded_provider() -> MockStoreProvider {
        let p = MockStoreProvider::new();
        p.add(app("org.amos.a", "Alpha", "1.0.0"), b"alpha bytes".to_vec())
            .unwrap();
        p.add(app("org.amos.b", "Beta", "1.0.0"), b"beta bytes".to_vec())
            .unwrap();
        p
    }

    #[tokio::test]
    async fn install_downloads_verifies_and_records() {
        let provider = seeded_provider();
        let store = AppStore::new(provider);

        let catalog = store.catalog().await.unwrap();
        assert_eq!(catalog.len(), 2);
        assert_eq!(catalog[0].id, "org.amos.a", "catalog sorted by id");

        let installed = store.install("org.amos.a").await.unwrap();
        assert_eq!(installed.id(), "org.amos.a");
        assert_eq!(installed.version().to_string(), "1.0.0");

        assert!(store.is_installed("org.amos.a").unwrap());
        assert_eq!(store.installed().unwrap().len(), 1);
        assert_eq!(
            store.status("org.amos.a").await.unwrap(),
            AppStatus::Installed {
                version: "1.0.0".into()
            }
        );
    }

    #[tokio::test]
    async fn install_refuses_tampered_bytes_with_checksum_mismatch() {
        let p = MockStoreProvider::new();
        let mut evil = app("org.amos.evil", "Evil", "1.0.0");
        // Declare a digest that will NOT match the bytes we ship.
        evil.package.sha256 = Some(Checksum::sha256("a".repeat(64)).unwrap());
        p.add_broken(evil, b"payload".to_vec()).unwrap();

        let store = AppStore::new(p);
        let err = store.install("org.amos.evil").await.unwrap_err();
        assert!(
            matches!(err, StoreError::ChecksumMismatch { .. }),
            "tampered payload must be refused: {err}"
        );
        assert!(
            !store.is_installed("org.amos.evil").unwrap(),
            "nothing recorded after a refused install"
        );
    }

    #[tokio::test]
    async fn install_unknown_double_and_missing_are_clean_errors() {
        let store = AppStore::new(seeded_provider());

        // Not in catalog.
        assert!(matches!(
            store.install("org.amos.ghost").await.unwrap_err(),
            StoreError::UnknownApp { .. }
        ));
        // Status of an unknown app is also an error.
        assert!(matches!(
            store.status("org.amos.ghost").await.unwrap_err(),
            StoreError::UnknownApp { .. }
        ));

        // Available before install.
        assert_eq!(
            store.status("org.amos.a").await.unwrap(),
            AppStatus::Available
        );

        store.install("org.amos.a").await.unwrap();
        // Double install is refused.
        assert!(matches!(
            store.install("org.amos.a").await.unwrap_err(),
            StoreError::AlreadyInstalled { .. }
        ));
    }

    #[tokio::test]
    async fn upgrade_moves_to_newer_release_only() {
        let provider = seeded_provider();
        let keep = provider.clone(); // allows publishing new releases later
        let store = AppStore::new(provider);
        store.install("org.amos.a").await.unwrap();

        // No newer release yet → nothing updatable, upgrade is a no-op error.
        assert!(store.updatable().await.unwrap().is_empty());
        assert!(matches!(
            store.upgrade("org.amos.a").await.unwrap_err(),
            StoreError::NoUpdate { .. }
        ));
        assert_eq!(
            store.status("org.amos.a").await.unwrap(),
            AppStatus::Installed {
                version: "1.0.0".into()
            }
        );

        // Publish v1.1.0 of the same app (catalog updates while it is installed).
        keep.add(
            app("org.amos.a", "Alpha", "1.1.0"),
            b"alpha v2 bytes".to_vec(),
        )
        .unwrap();

        assert_eq!(
            store.updatable().await.unwrap(),
            vec!["org.amos.a".to_string()]
        );
        assert_eq!(
            store.status("org.amos.a").await.unwrap(),
            AppStatus::Updatable {
                installed: "1.0.0".into(),
                latest: "1.1.0".into()
            }
        );

        let upgraded = store.upgrade("org.amos.a").await.unwrap();
        assert_eq!(upgraded.version().to_string(), "1.1.0");
        assert_eq!(
            store.status("org.amos.a").await.unwrap(),
            AppStatus::Installed {
                version: "1.1.0".into()
            }
        );
        assert!(store.updatable().await.unwrap().is_empty());

        // Second upgrade has nothing to do.
        assert!(matches!(
            store.upgrade("org.amos.a").await.unwrap_err(),
            StoreError::NoUpdate { .. }
        ));
    }

    #[tokio::test]
    async fn upgrade_of_uninstalled_app_is_rejected() {
        let store = AppStore::new(seeded_provider());
        assert!(matches!(
            store.upgrade("org.amos.a").await.unwrap_err(),
            StoreError::NotInstalled { .. }
        ));
    }

    #[tokio::test]
    async fn uninstall_removes_and_double_uninstall_errors() {
        let store = AppStore::new(seeded_provider());
        store.install("org.amos.a").await.unwrap();
        store.uninstall("org.amos.a").unwrap();
        assert!(!store.is_installed("org.amos.a").unwrap());
        // Back to Available (still in catalog) after uninstall.
        assert_eq!(
            store.status("org.amos.a").await.unwrap(),
            AppStatus::Available
        );

        // Uninstalling an app that isn't there is an error.
        assert!(matches!(
            store.uninstall("org.amos.a").unwrap_err(),
            StoreError::NotInstalled { .. }
        ));
    }

    #[tokio::test]
    async fn registry_persists_across_app_store_instances() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "amos-appstore-registry-{}-{nonce}.json",
            std::process::id()
        ));

        // Install on an open-backed store and persist.
        let provider = seeded_provider();
        let store = AppStore::open(provider.clone(), &path).unwrap();
        store.install("org.amos.a").await.unwrap();
        store.install("org.amos.b").await.unwrap();
        store.save_file(&path).unwrap();

        // A fresh engine over the same path (and a fresh provider clone) sees them.
        let again = AppStore::open(provider, &path).unwrap();
        let ids: Vec<String> = again
            .installed()
            .unwrap()
            .iter()
            .map(|a| a.id().to_string())
            .collect();
        assert_eq!(
            ids,
            vec!["org.amos.a".to_string(), "org.amos.b".to_string()]
        );

        // Uninstall on the reloaded engine, save, reopen → change persisted.
        again.uninstall("org.amos.a").unwrap();
        again.save_file(&path).unwrap();
        let third = AppStore::open(seeded_provider(), &path).unwrap();
        assert_eq!(third.installed().unwrap().len(), 1);
        assert_eq!(third.installed().unwrap()[0].id(), "org.amos.b");

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn find_returns_single_catalog_entry_or_none() {
        let store = AppStore::new(seeded_provider());
        let found = store.find("org.amos.a").await.unwrap();
        assert_eq!(found.unwrap().name, "Alpha");
        assert!(store.find("org.amos.ghost").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn search_matches_fields_case_insensitive_sorted() {
        let store = AppStore::new(seeded_provider());
        // By display name (case-insensitive).
        let hits = store.search("Alpha").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "org.amos.a");

        // By id fragment → both, sorted by id.
        let hits = store.search("org.amos").await.unwrap();
        let ids: Vec<_> = hits.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["org.amos.a", "org.amos.b"]);

        // By author substring.
        assert_eq!(store.search("amos team").await.unwrap().len(), 2);

        // Empty query → whole catalog; no match → empty.
        assert_eq!(store.search("").await.unwrap().len(), 2);
        assert!(store.search("zzz-not-here").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn publisher_signed_manifests_install_but_broken_ones_are_refused() {
        use crate::{sign_manifest, Checksum, DeveloperKey};

        let key = DeveloperKey::from_seed([11u8; 32]);
        // A developer signs a manifest that already carries its package digest
        // (mirrors the real publish flow; `add` restamps the same digest, so the
        // signature stays valid).
        let pkg_good = b"g bytes".to_vec();
        let pkg_bad = b"b bytes".to_vec();
        let cs_good = Checksum::sha256(Checksum::sha256_hex(&pkg_good)).unwrap();
        let cs_bad = Checksum::sha256(Checksum::sha256_hex(&pkg_bad)).unwrap();

        let mut m_good = app("org.amos.signedok", "Signed", "1.0.0");
        m_good.package.sha256 = Some(cs_good);
        let good = sign_manifest(&key, m_good).unwrap();

        let mut m_bad = app("org.amos.signedbad", "Signed", "1.0.0");
        m_bad.package.sha256 = Some(cs_bad);
        // A signed manifest that was tampered with after signing.
        let mut broken = sign_manifest(&key, m_bad).unwrap();
        broken.name = "tampered after signing".into();

        let p = MockStoreProvider::new();
        p.add(good, pkg_good).unwrap();
        p.add(broken, pkg_bad).unwrap();
        let store = AppStore::new(p);

        // A valid signature verifies and the install proceeds (sha256 too).
        store.install("org.amos.signedok").await.unwrap();
        assert!(store.is_installed("org.amos.signedok").unwrap());

        // A manifest whose content no longer matches its signature is refused.
        let err = store.install("org.amos.signedbad").await.unwrap_err();
        assert!(
            matches!(err, StoreError::BadPublisherSignature { .. }),
            "tampered signed manifest must be refused: {err}"
        );
        assert!(!store.is_installed("org.amos.signedbad").unwrap());
    }

    fn web_bundle_gz() -> Vec<u8> {
        fn gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            {
                let mut ar = tar::Builder::new(&mut gz);
                for (name, data) in entries {
                    let mut h = tar::Header::new_gnu();
                    h.set_entry_type(tar::EntryType::file());
                    h.set_size(data.len() as u64);
                    h.set_mode(0o644);
                    h.set_cksum();
                    ar.append_data(&mut h, name, *data).unwrap();
                }
                ar.finish().unwrap();
            }
            gz.finish().unwrap()
        }
        gz(&[
            (
                "amos-app.json",
                b"{\"id\":\"org.amos.web\",\"name\":\"Web\",\"start\":\"index.html\"}",
            ),
            ("index.html", b"<html>hi</html>"),
            ("assets/app.js", b"console.log(1)"),
        ])
    }

    fn temp_root(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "amos-appstore-web-{tag}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[tokio::test]
    async fn web_bundle_install_unpacks_to_disk_and_uninstalls_clean() {
        let root = temp_root("install");
        let p = MockStoreProvider::new();
        p.add(app("org.amos.web", "Web", "1.0.0"), web_bundle_gz())
            .unwrap();

        let store = AppStore::new(p).with_web_install_dir(root.clone());
        store.install("org.amos.web").await.unwrap();
        assert!(store.is_installed("org.amos.web").unwrap());

        // The verified bundle was actually unpacked under <root>/<id>/.
        let dir = root.join("org.amos.web");
        assert!(dir.join("index.html").is_file());
        assert!(dir.join("amos-app.json").is_file());
        assert!(dir.join("manifest.json").is_file());

        store.uninstall("org.amos.web").unwrap();
        assert!(!store.is_installed("org.amos.web").unwrap());
        assert!(!dir.exists(), "uninstall removes the unpacked bundle");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn broken_bundle_is_rejected_and_not_recorded() {
        let root = temp_root("broken");
        let p = MockStoreProvider::new();
        // A TarGz manifest whose payload is NOT a real gzip web-bundle.
        p.add(
            app("org.amos.broken", "Broken", "1.0.0"),
            b"not a tar.gz".to_vec(),
        )
        .unwrap();

        let store = AppStore::new(p).with_web_install_dir(root.clone());
        let err = store.install("org.amos.broken").await.unwrap_err();
        assert!(matches!(err, StoreError::Provider(_)), "{err}");
        assert!(!store.is_installed("org.amos.broken").unwrap());
        // Failed install must not leave a partial bundle behind.
        assert!(!root.join("org.amos.broken").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
