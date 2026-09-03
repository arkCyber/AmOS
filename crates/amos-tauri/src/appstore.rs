//! Tauri <-> app-store bridge.
//!
//! Exposes the app-store engine to the WebView. The managed [`StoreBridge`]
//! wraps an [`amos_appstore::AppStore`] over a **type-erased**
//! [`StoreProvider`](amos_appstore::StoreProvider), so a future "App Store"
//! System-UI page can browse the catalog and install / update / uninstall apps.
//! The provider is chosen at boot:
//!
//! * default — the deterministic offline [`MockStoreProvider`] demo catalog
//!   (**zero network**), or
//! * when `AMOS_APPSTORE_CATALOG` is set *and* the bridge is built with
//!   `--features appstore-live` — a real [`HttpStoreProvider`] (remote catalog +
//!   package downloads). Without that feature the env var is ignored (demo
//!   catalog) so the default UI build stays offline.
//!
//! Commands are async and take `&self` — the engine owns its installed-registry
//! behind a mutex, so concurrent calls are safe.
//!
//! # Persistence
//!
//! When the `AMOS_APPSTORE_REGISTRY` env var points at a file, [`StoreBridge`]
//! loads it (or starts empty) and writes it back after every mutating command
//! (`install` / `upgrade` / `uninstall`), so installs survive app restarts.
//! Without it the installed-registry is ephemeral.

use std::path::{Path, PathBuf};

use amos_appstore::{
    AppCategory, AppManifest, AppStatus, AppStore, InstalledApp, MockStoreProvider, PackageFormat,
    PackageRef, StoreProvider, Version,
};
use base64::Engine as _;
use serde::Serialize;
use tauri::State;

#[cfg(feature = "appstore-live")]
use amos_appstore::HttpStoreProvider;

/// Managed app-store engine state.
pub struct StoreBridge {
    store: AppStore<Box<dyn StoreProvider>>,
    /// Optional registry path (from `$AMOS_APPSTORE_REGISTRY`). When `None` the
    /// installed-registry is ephemeral.
    path: Option<PathBuf>,
}

/// Directory under which installed `tar.gz` web-bundles are unpacked, from
/// `$AMOS_APPSTORE_INSTALL_DIR` (`None` when unset → bundles aren't materialized).
fn web_install_dir() -> Option<PathBuf> {
    std::env::var("AMOS_APPSTORE_INSTALL_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Attach the configured web-install dir (if any) to a freshly-built store.
fn apply_web_dir(store: AppStore<Box<dyn StoreProvider>>) -> AppStore<Box<dyn StoreProvider>> {
    match web_install_dir() {
        Some(dir) => store.with_web_install_dir(dir),
        None => store,
    }
}

/// The store backend for this process: a real HTTP catalog when
/// `AMOS_APPSTORE_CATALOG` is set and the bridge is built `live`, otherwise the
/// offline demo catalog.
fn provider() -> Box<dyn StoreProvider> {
    #[cfg(feature = "appstore-live")]
    {
        if let Some(url) = std::env::var("AMOS_APPSTORE_CATALOG")
            .ok()
            .filter(|s| !s.is_empty())
        {
            tracing::info!("appstore: using remote HTTP catalog {url}");
            return Box::new(HttpStoreProvider::new(url));
        }
    }
    Box::new(seeded_provider())
}

/// The offline demo catalog shipped with the System UI (deterministic seed).
fn seeded_provider() -> MockStoreProvider {
    let p = MockStoreProvider::new();
    // Each `seed` is additive; a bad manifest is logged and skipped, never a panic.
    seed(
        &p,
        "org.amos.pomodoro",
        "Pomodoro",
        "A focus timer for the Amos home screen.",
        AppCategory::Tools,
        Version::new(1, 2, 0),
        b"pomodoro: package bytes",
    );
    seed(
        &p,
        "org.amos.morse",
        "Morse",
        "Send and decode Morse messages.",
        AppCategory::Communication,
        Version::new(2, 0, 0),
        b"morse: package bytes",
    );
    seed(
        &p,
        "org.amos.maze",
        "Maze",
        "A tiny endless maze runner.",
        AppCategory::Games,
        Version::new(0, 9, 0),
        b"maze: package bytes",
    );
    p
}

/// Register one demo app in the provider (stamps the real digest of `bytes`).
fn seed(
    p: &MockStoreProvider,
    id: &str,
    name: &str,
    summary: &str,
    category: AppCategory,
    version: Version,
    bytes: &[u8],
) {
    let mf = AppManifest {
        id: id.into(),
        name: name.into(),
        summary: summary.into(),
        description: String::new(),
        author: "Amos Labs".into(),
        version,
        category,
        homepage: String::new(),
        icon_url: String::new(),
        package: PackageRef {
            format: PackageFormat::TarGz,
            url: format!("https://cdn.amos.local/{id}.tgz"),
            sha256: None, // `add` stamps the real digest from `bytes`
            size_bytes: None,
        },
        publisher: None,
    };
    if let Err(e) = p.add(mf, bytes.to_vec()) {
        tracing::warn!("appstore demo seed for {id} rejected: {e}");
    }
}

impl StoreBridge {
    /// Build a bridge. Honors `$AMOS_APPSTORE_REGISTRY`: when set, the installed
    /// registry is loaded (or created) from that file and persists across app
    /// restarts; otherwise an ephemeral registry is used.
    pub fn new() -> Self {
        match std::env::var("AMOS_APPSTORE_REGISTRY")
            .ok()
            .filter(|s| !s.is_empty())
        {
            Some(p) => Self::from_store(Path::new(&p)),
            None => Self::ephemeral(),
        }
    }

    /// An in-memory installed registry over the boot-selected provider (default
    /// path: the offline demo catalog, unless `AMOS_APPSTORE_CATALOG` + a live
    /// build point at a remote catalog).
    pub fn ephemeral() -> Self {
        Self {
            store: apply_web_dir(AppStore::new(provider())),
            path: None,
        }
    }

    /// Load (or create) the installed registry at `path` over the boot-selected
    /// provider. If the file is unreadable/corrupt, start empty and warn — the
    /// next successful write rewrites a clean snapshot.
    pub fn from_store(path: &Path) -> Self {
        match AppStore::open(provider(), path) {
            Ok(store) => Self {
                store: apply_web_dir(store),
                path: Some(path.to_path_buf()),
            },
            Err(e) => {
                tracing::warn!(
                    "appstore registry {} unreadable: {e}; starting empty",
                    path.display()
                );
                Self {
                    store: apply_web_dir(AppStore::new(provider())),
                    path: Some(path.to_path_buf()),
                }
            }
        }
    }

    /// Best-effort: write the installed registry to disk when a path is set.
    fn persist_best_effort(&self) {
        if let Some(p) = &self.path {
            if let Err(e) = self.store.save_file(p) {
                tracing::warn!("failed to persist appstore registry {}: {e}", p.display());
            }
        }
    }
}

impl Default for StoreBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// The full store catalog (what a "Browse" view shows), sorted by id.
#[tauri::command]
pub async fn appstore_catalog(state: State<'_, StoreBridge>) -> Result<Vec<AppManifest>, String> {
    state.store.catalog().await.map_err(|e| e.to_string())
}

/// Search the catalog (id/name/summary/author/category, case-insensitive).
#[tauri::command]
pub async fn appstore_search(
    state: State<'_, StoreBridge>,
    query: String,
) -> Result<Vec<AppManifest>, String> {
    state.store.search(&query).await.map_err(|e| e.to_string())
}

/// One catalog entry, if still published.
#[tauri::command]
pub async fn appstore_find(
    state: State<'_, StoreBridge>,
    id: String,
) -> Result<Option<AppManifest>, String> {
    state.store.find(&id).await.map_err(|e| e.to_string())
}

/// The apps currently installed.
#[tauri::command]
pub async fn appstore_installed(
    state: State<'_, StoreBridge>,
) -> Result<Vec<InstalledApp>, String> {
    state.store.installed().map_err(|e| e.to_string())
}

/// Ids of installed apps that have a newer release in the catalog.
#[tauri::command]
pub async fn appstore_updatable(state: State<'_, StoreBridge>) -> Result<Vec<String>, String> {
    state.store.updatable().await.map_err(|e| e.to_string())
}

/// Lifecycle state of one app (Available / Installed / Updatable).
#[tauri::command]
pub async fn appstore_status(
    state: State<'_, StoreBridge>,
    id: String,
) -> Result<AppStatus, String> {
    state.store.status(&id).await.map_err(|e| e.to_string())
}

/// Download → verify → install the catalog's release of `id`.
#[tauri::command]
pub async fn appstore_install(
    state: State<'_, StoreBridge>,
    id: String,
) -> Result<InstalledApp, String> {
    let app = state.store.install(&id).await.map_err(|e| e.to_string())?;
    state.persist_best_effort();
    Ok(app)
}

/// Upgrade `id` to the catalog's newest release.
#[tauri::command]
pub async fn appstore_upgrade(
    state: State<'_, StoreBridge>,
    id: String,
) -> Result<InstalledApp, String> {
    let app = state.store.upgrade(&id).await.map_err(|e| e.to_string())?;
    state.persist_best_effort();
    Ok(app)
}

/// Uninstall `id`.
#[tauri::command]
pub async fn appstore_uninstall(state: State<'_, StoreBridge>, id: String) -> Result<(), String> {
    state.store.uninstall(&id).map_err(|e| e.to_string())?;
    state.persist_best_effort();
    Ok(())
}

/// One resource of an installed web-bundle, for the host to render. Bytes come
/// back base64 + MIME (no custom protocol required).
#[derive(Clone, Serialize)]
pub struct BundleResource {
    pub mime: String,
    pub nosniff: bool,
    pub base64: String,
}

/// Read a resource out of an installed web-bundle at `<root>/<id>/`. Free of
/// Tauri so it can be unit-tested headlessly; path is sanitised by
/// `amos_appstore::resolve_request` (refuses `..` / escapes).
pub fn read_bundle_resource(root: &Path, id: &str, path: &str) -> Result<BundleResource, String> {
    let dir = root.join(id);
    let file = amos_appstore::resolve_request(&dir, path).map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&file.path).map_err(|e| e.to_string())?;
    Ok(BundleResource {
        mime: file.content_type.to_string(),
        nosniff: file.nosniff,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// Serve one resource of an installed web-bundle to the WebView (base64 + MIME).
#[tauri::command]
pub fn appstore_bundle_resource(
    state: State<'_, StoreBridge>,
    id: String,
    path: String,
) -> Result<BundleResource, String> {
    let root = state
        .store
        .web_install_dir()
        .ok_or_else(|| "no web install dir (set AMOS_APPSTORE_INSTALL_DIR)".to_string())?;
    read_bundle_resource(root, &id, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_appstore::AppStatus;

    #[tokio::test]
    async fn demo_catalog_is_browsable_and_searchable() {
        let b = StoreBridge::ephemeral();

        // Catalog sorted by id: maze < morse < pomodoro.
        let cat = b.store.catalog().await.unwrap();
        let ids: Vec<_> = cat.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["org.amos.maze", "org.amos.morse", "org.amos.pomodoro"]
        );

        // Search by summary word.
        let hits = b.store.search("focus").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "org.amos.pomodoro");

        // Single lookup.
        let found = b.store.find("org.amos.maze").await.unwrap();
        assert_eq!(found.unwrap().category, AppCategory::Games);

        // Not installed yet.
        assert_eq!(
            b.store.status("org.amos.pomodoro").await.unwrap(),
            AppStatus::Available
        );
    }

    #[tokio::test]
    async fn install_status_and_uninstall_round_trip() {
        let b = StoreBridge::ephemeral();

        let installed = b.store.install("org.amos.pomodoro").await.unwrap();
        assert_eq!(installed.version().to_string(), "1.2.0");
        assert_eq!(b.store.installed().unwrap().len(), 1);

        // A second install is refused.
        let err = b.store.install("org.amos.pomodoro").await.unwrap_err();
        assert!(err.to_string().contains("already installed"), "{err}");

        // Status now Installed; nothing updatable (demo catalog is current).
        assert_eq!(
            b.store.status("org.amos.pomodoro").await.unwrap(),
            AppStatus::Installed {
                version: "1.2.0".into()
            }
        );
        assert!(b.store.updatable().await.unwrap().is_empty());

        b.store.uninstall("org.amos.pomodoro").unwrap();
        assert!(b.store.installed().unwrap().is_empty());
        assert_eq!(
            b.store.status("org.amos.pomodoro").await.unwrap(),
            AppStatus::Available
        );
    }

    #[tokio::test]
    async fn registry_persists_across_bridges() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "amos-appstore-tauri-bridge-{}-{nonce}.json",
            std::process::id()
        ));

        // Install on a store-backed bridge and persist.
        let b = StoreBridge::from_store(&path);
        b.store.install("org.amos.pomodoro").await.unwrap();
        b.persist_best_effort();

        // A fresh bridge over the same path sees the install (cross-restart).
        let again = StoreBridge::from_store(&path);
        assert!(again.store.is_installed("org.amos.pomodoro").unwrap());

        // Uninstall + persist + reopen → empty.
        again.store.uninstall("org.amos.pomodoro").unwrap();
        again.persist_best_effort();
        let third = StoreBridge::from_store(&path);
        assert!(third.store.installed().unwrap().is_empty());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_bundle_resource_serves_files_and_refuses_escapes() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "amos-appstore-bundle-res-{}-{nonce}",
            std::process::id()
        ));
        let dir = root.join("org.amos.web");
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        let html = b"<html>hi</html>";
        std::fs::write(dir.join("index.html"), html).unwrap();
        std::fs::write(dir.join("assets/app.js"), b"console.log(1)").unwrap();

        let res = read_bundle_resource(&root, "org.amos.web", "index.html").unwrap();
        assert_eq!(res.mime, "text/html; charset=utf-8");
        assert!(res.nosniff);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&res.base64)
            .unwrap();
        assert_eq!(decoded, html, "base64 round-trips the file bytes");

        let js = read_bundle_resource(&root, "org.amos.web", "assets/app.js").unwrap();
        assert_eq!(js.mime, "text/javascript; charset=utf-8");

        // Traversal / missing are clean errors.
        assert!(read_bundle_resource(&root, "org.amos.web", "../secret").is_err());
        assert!(read_bundle_resource(&root, "org.amos.web", "nope.js").is_err());
        assert!(read_bundle_resource(&root, "not-installed", "index.html").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}
