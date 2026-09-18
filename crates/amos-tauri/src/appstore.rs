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
use serde::Serialize;
use tauri::State;

use crate::error::{AmosError, ErrorCode};

/// Maximum bytes in an appstore app id handed in by the WebView.
///
/// The id is appended to `<install-root>/` to form the on-disk install directory,
/// so any caller-supplied id is also a **path segment** (and ".." / absolute paths
/// would escape the install root). The same `AppManifest::valid_id` rule that
/// gates installs is enforced here at the command seam — installs use the same
/// validator internally, but `appstore_uninstall` and `appstore_upgrade` accept a
/// bare id and previously had no equivalent guard.
pub const MAX_APPSTORE_ID_BYTES: usize = 128;

/// Upper bound on the `appstore_search` query string.
///
/// Real queries are 1–3 keywords (`"pomodoro"`, `"note markdown"`); 256 B is
/// comfortably above any plausible value and tight enough that a paste-sized
/// caller cannot inflate the catalog RPC.
pub const MAX_APPSTORE_QUERY_BYTES: usize = 256;

/// Result type used by every appstore Tauri command.
///
/// Replaces the previous `Result<_, String>` — the UI now receives an
/// [`AmosError`] envelope instead of a raw string, so it can show a translated
/// error message rather than silently swallowing a Tauri internal error.
pub type AppStoreResult<T> = Result<T, AmosError>;

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

/// The directory holding the system **PWA index** (`apps/*.toml` + `icons/`),
/// from `$AMOS_PWA_INDEX_DIR`.
///
/// `None` means "this build ships no index directory": `amos-app://index/apps.json`
/// then answers from the manifests embedded in the build
/// (`amos_appstore::pwa::BUILTIN_MANIFESTS`, empty today — see `docs/pwa-index.md`),
/// and the icon paths have nothing to serve.
pub fn pwa_index_dir() -> Option<PathBuf> {
    std::env::var(amos_appstore::pwa::INDEX_DIR_ENV)
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// One installed app as the device-care policy needs it.
///
/// `size_bytes` is `None` when the manifest declares no package size — the UI
/// must show "unknown", never a fabricated `0 B`.
///
/// `system` is authoritative only on a device (from `PackageManager`'s
/// `ApplicationInfo.FLAG_SYSTEM`); the host store registry only ever holds
/// user-installed bundles, so it reports `false`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InstalledEntry {
    pub id: String,
    pub name: String,
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub system: bool,
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
    /// The directory installed web-bundles are unpacked under
    /// (`$AMOS_APPSTORE_INSTALL_DIR`), if configured. The `amos-app://` handler
    /// needs it to route a `amos-app://<app-id>/…` request.
    pub fn web_install_dir(&self) -> Option<&Path> {
        self.store.web_install_dir()
    }

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

    /// The display name of an installed app, if it is installed.
    ///
    /// Inspection API on the bridge registry. The device-care policy path needs the
    /// **whole** inventory (one `UninstallGuard` verdict per entry) and goes through
    /// [`Self::installed_inventory`], so this single-name lookup has no
    /// in-workspace caller today (recorded in `docs/rust-unwired-audit.md`).
    pub fn installed_name(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self
            .installed_inventory()?
            .into_iter()
            .find(|e| e.id == id)
            .map(|e| e.name))
    }

    /// The installed inventory as device-care needs it, **sorted by id**.
    ///
    /// This is the *bridge-owned* policy input: the WebView never supplies it, so
    /// the policy preview (`devcare_apps`) and the enforcement
    /// (`devcare_uninstall`) cannot disagree, and a UI cannot talk the policy into
    /// treating a package as removable. A device build fills the same shape from
    /// `PackageManager` (where `system` is known).
    pub fn installed_inventory(&self) -> Result<Vec<InstalledEntry>, String> {
        let mut items: Vec<InstalledEntry> = self
            .store
            .installed()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|a| InstalledEntry {
                id: a.manifest.id,
                name: a.manifest.name,
                size_bytes: a.manifest.package.size_bytes,
                // The store registry holds user-installed bundles only.
                system: false,
            })
            .collect();
        items.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(items)
    }

    /// Uninstall one app by id and persist the registry.
    ///
    /// On the **host** this is the removal path the device-care policy command
    /// ends up in: `StoreBridge` is the [`PackageSource`] when no device backend
    /// is attached (`devcare::uninstall_with_policy`). On a **device** that policy
    /// path goes through the Android backend's `PackageManager` intent instead,
    /// never here. `appstore_uninstall` remains for the store's own UI.
    ///
    /// [`PackageSource`]: crate::devcare::PackageSource
    pub fn uninstall_by_id(&self, id: &str) -> Result<(), String> {
        self.store.uninstall(id).map_err(|e| e.to_string())?;
        self.persist_best_effort();
        Ok(())
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
    // Bound the query at the seam — a paste-sized caller would inflate every
    // search round-trip to the catalog.
    if query.len() > MAX_APPSTORE_QUERY_BYTES {
        return Err(format!(
            "appstore search query too long: {} bytes (max {MAX_APPSTORE_QUERY_BYTES})",
            query.len()
        ));
    }
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
) -> AppStoreResult<AppStatus> {
    validate_appstore_id(&id)?;
    state.store.status(&id).await.map_err(|e| {
        AmosError::with_cause(
            ErrorCode::AppStoreRpcFailed,
            format!("status failed for {id}: {e}"),
            e,
        )
    })
}

/// Download → verify → install the catalog's release of `id`.
#[tauri::command]
pub async fn appstore_install(
    state: State<'_, StoreBridge>,
    id: String,
) -> AppStoreResult<InstalledApp> {
    validate_appstore_id(&id)?;
    let app = state.store.install(&id).await.map_err(|e| {
        AmosError::with_cause(
            ErrorCode::AppStoreInstallFailed,
            format!("install failed for {id}: {e}"),
            e,
        )
    })?;
    state.persist_best_effort();
    Ok(app)
}

/// Upgrade `id` to the catalog's newest release.
#[tauri::command]
pub async fn appstore_upgrade(
    state: State<'_, StoreBridge>,
    id: String,
) -> AppStoreResult<InstalledApp> {
    validate_appstore_id(&id)?;
    let app = state.store.upgrade(&id).await.map_err(|e| {
        AmosError::with_cause(
            ErrorCode::AppStoreUpgradeFailed,
            format!("upgrade failed for {id}: {e}"),
            e,
        )
    })?;
    state.persist_best_effort();
    Ok(app)
}

/// Uninstall `id`.
#[tauri::command]
pub async fn appstore_uninstall(state: State<'_, StoreBridge>, id: String) -> AppStoreResult<()> {
    validate_appstore_id(&id)?;
    state.store.uninstall(&id).map_err(|e| {
        AmosError::with_cause(
            ErrorCode::AppStoreUninstallFailed,
            format!("uninstall failed for {id}: {e}"),
            e,
        )
    })?;
    state.persist_best_effort();
    Ok(())
}

/// Validate the caller-supplied app id at the command seam and refuse path-segment
/// metacharacters (`..` / `/` / `\`) so an id cannot escape `<install-root>/`.
/// Mirrors the same `valid_id` rule the install/upgrade paths use internally —
/// exposes it here so a UI bug cannot slip an unvalidated id to the on-disk
/// `dir_for(id)` join in `webinstall`.
///
/// Returns `Ok(())` on success; [`AppStoreResult`] on failure so callers can
/// use `?` without wrapping.
fn validate_appstore_id(id: &str) -> AppStoreResult<()> {
    if id.is_empty() {
        return Err(AmosError::new(
            ErrorCode::AppStoreIdEmpty,
            "appstore id is empty",
        ));
    }
    if id.len() > MAX_APPSTORE_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::AppStoreIdTooLong,
            format!(
                "appstore id too long: {} bytes (max {})",
                id.len(),
                MAX_APPSTORE_ID_BYTES
            ),
        ));
    }
    if id.contains('/')
        || id.contains('\\')
        || id.contains('\0')
        || id == "."
        || id == ".."
        || id.starts_with("../")
        || id.contains("/../")
        || id.ends_with("/..")
    {
        return Err(AmosError::new(
            ErrorCode::AppStoreIdInvalid,
            format!("appstore id is not a valid id: {id:?}"),
        ));
    }
    Ok(())
}

/// One `amos-app://` response, shaped for the custom-protocol handler.
///
/// Tauri-free on purpose: the handler in `lib.rs` only turns this into an
/// `http::Response`, so every decision here (status, MIME, `nosniff`, and
/// whether the body may be read cross-origin) is unit-testable without a WebView.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolReply {
    pub status: u16,
    pub content_type: String,
    pub nosniff: bool,
    pub body: Vec<u8>,
    /// The `Content-Security-Policy` to send, if any.
    ///
    /// This is where a hosted bundle's egress promise is actually enforced: the
    /// policy is a **response header of that bundle's own document**, so it
    /// constrains the bundle and nothing else (the shell's policy cannot, because
    /// a CSP is per document and a bundle is a separate document at its own
    /// origin). See `amos_appstore::pwa::bundle_csp`.
    pub csp: Option<String>,
    /// Whether this response is **public**: only the system PWA index is, so only
    /// it may carry `Access-Control-Allow-Origin: *`. An installed app's bundle is
    /// readable by that app's own page (same origin) and by nothing else — a
    /// wildcard there would let one sandboxed app `fetch` another app's files.
    pub public: bool,
}

/// Answer one `amos-app://<host>/<path>` request.
///
/// A refusal is a `404` carrying the reason as text. That is deliberate: the
/// requester is the app's own WebView, and an unexplained empty 404 is exactly
/// how "the gateway is wired wrong" gets misread as "that app does not exist".
pub fn serve_protocol_uri(
    install_root: Option<&Path>,
    index_dir: Option<&Path>,
    uri: &str,
) -> ProtocolReply {
    let public = amos_appstore::is_index_uri(uri);
    match amos_appstore::serve_uri(install_root, index_dir, uri) {
        Ok(served) => ProtocolReply {
            status: 200,
            content_type: served.content_type.to_string(),
            nosniff: served.nosniff,
            body: served.bytes,
            csp: served.csp,
            public,
        },
        Err(e) => {
            tracing::warn!(
                target: "amos::appstore",
                uri,
                error = %e,
                "amos-app:// request refused"
            );
            ProtocolReply {
                status: 404,
                content_type: "text/plain; charset=utf-8".to_string(),
                nosniff: true,
                body: format!("{e}\n").into_bytes(),
                // A refusal is a text document with nothing to load; the same
                // lock-down as the index applies.
                csp: Some(amos_appstore::index_csp()),
                public,
            }
        }
    }
}

/// Turn a [`ProtocolReply`] into the `http::Response` the protocol handler
/// returns.
///
/// `X-Content-Type-Options: nosniff` is always set (so a third-party bundle can
/// never be sniffed into HTML/JS), and `Access-Control-Allow-Origin: *` **only**
/// for the public index — see [`ProtocolReply::public`].
pub fn protocol_response(reply: ProtocolReply) -> tauri::http::Response<Vec<u8>> {
    let mut builder = tauri::http::Response::builder()
        .status(reply.status)
        .header("Content-Type", reply.content_type);
    if reply.nosniff {
        builder = builder.header("X-Content-Type-Options", "nosniff");
    }
    if let Some(csp) = reply.csp {
        // The header that makes a bundle's declared egress a promise — see
        // `ProtocolReply::csp`. Sent with `Content-Security-Policy` (not
        // `-Report-Only`): this is a policy, not a suggestion.
        builder = builder.header("Content-Security-Policy", csp);
    }
    if reply.public {
        builder = builder.header("Access-Control-Allow-Origin", "*");
    }
    match builder.body(reply.body) {
        Ok(response) => response,
        Err(e) => {
            // Only reachable if one of the constant headers above were malformed.
            // A protocol handler runs on the WebView's own thread, so this must
            // still return a response rather than panic.
            tracing::warn!(
                target: "amos::appstore",
                error = %e,
                "amos-app:// response could not be built"
            );
            let mut fallback = tauri::http::Response::new(Vec::new());
            *fallback.status_mut() = tauri::http::StatusCode::INTERNAL_SERVER_ERROR;
            fallback
        }
    }
}

/// **TEMP PROBE — REMOVE AFTER VERIFYING REQ-A171.**
///
/// Prints WebView CSP violations (and two boot markers) to stderr so the shell's
/// `Content-Security-Policy` can be checked **without a human watching devtools**:
/// a violation is otherwise only visible in the WebView console, which nothing
/// outside the window can read.
#[tauri::command]
pub fn csp_probe(report: String) {
    // Bound the report at the command seam: an empty / paste-sized `report`
    // would either be silently dropped by the shell's stderr buffer (a real
    // CSP violation report itself is < 1 KiB) or flood the diagnostic log.
    const MAX_CSP_REPORT_BYTES: usize = 16 << 10;
    if report.is_empty() {
        return;
    }
    let preview = if report.len() > MAX_CSP_REPORT_BYTES {
        // We deliberately keep the head of the violation — the violated-directive
        // / blocked-uri fields live in the first bytes; truncating there keeps
        // the diagnostic signal while bounding the log volume.
        let mut end = MAX_CSP_REPORT_BYTES;
        while !report.is_char_boundary(end) {
            end -= 1;
        }
        format!(
            "{}… <truncated {} bytes>",
            &report[..end],
            report.len() - end
        )
    } else {
        report
    };
    eprintln!("[csp-probe] {preview}");
}

/// The base URL the WebView must use to reach the PWA index on **this** platform
/// (`amos-app://index` on macOS/iOS/Linux, `http://amos-app.index` on
/// Windows/Android).
///
/// The knowledge lives in Rust because it is a fact about the WebView engine, not
/// about the UI: Windows/Android have no native custom-protocol support, so wry
/// maps `{scheme}://{host}` to `http://{scheme}.{host}` there. A frontend that
/// assembled the URL itself would be **dead on Android** — and the failure would
/// present as "the index is empty", not as a wrong URL. See `docs/pwa-index.md` §1.
#[tauri::command]
pub fn pwa_index_url() -> String {
    amos_appstore::index_base_url()
}

/// Where an installed web-bundle's entry document lives, as the WebView must
/// address it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BundleEntry {
    /// Platform-correct **absolute** URL of the bundle's entry document.
    pub url: String,
    /// The entry file inside the bundle (its `amos-app.json`'s `start`).
    pub start: String,
}

/// Resolve an installed web-bundle's entry URL, at the app's **own origin**.
///
/// Tauri-free so the whole decision is unit-testable:
/// * the id must be a valid app slug (so `..` can never select a directory),
/// * the bundle must actually be installed **and** carry a served entry
///   (`read_bundle_meta` refuses a traversal `start` or a missing file) — a
///   "runnable" URL is never handed out for something that cannot be served,
/// * the URL is built from [`amos_appstore::protocol_base_url`], so the
///   Windows/Android `http://amos-app.<id>` form is the host's business and never
///   a literal in the UI.
pub fn read_bundle_entry(root: &Path, id: &str) -> Result<BundleEntry, String> {
    if !amos_appstore::is_valid_app_id(id) {
        return Err(format!("invalid app id {id:?}"));
    }
    if amos_appstore::is_reserved_netloc(id) {
        // Refused *before* any filesystem work: this app could be installed and
        // still be unreachable, because the protocol routes its netloc to the PWA
        // index. A URL here would be a plausible-looking answer that cannot work.
        return Err(format!(
            "app id {id:?} is the protocol's reserved netloc ({netloc} addresses the PWA \
             index, not an app), so an installed bundle under it could never be reached",
            netloc = amos_appstore::INDEX_NETLOC
        ));
    }
    let meta = amos_appstore::read_bundle_meta(&root.join(id)).map_err(|e| e.to_string())?;
    let base = amos_appstore::protocol_base_url(id);
    Ok(BundleEntry {
        url: amos_appstore::protocol_url(&base, &meta.start),
        start: meta.start,
    })
}

/// The entry URL of an installed web-bundle. Errors (rather than returning a
/// blank URL) when this build has no install directory, when the app is not
/// installed, or when its bundle has no servable entry — the UI then says which.
#[tauri::command]
pub fn appstore_bundle_entry(
    state: State<'_, StoreBridge>,
    id: String,
) -> Result<BundleEntry, String> {
    let root = state
        .store
        .web_install_dir()
        .ok_or_else(|| "no web install dir (set AMOS_APPSTORE_INSTALL_DIR)".to_string())?;
    read_bundle_entry(root, &id)
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
    fn the_protocol_seam_refuses_bad_netlocs_escapes_and_unknown_apps() {
        // The *production* seam: this is the function the Tauri handler calls for
        // every `amos-app://` request, so these refusals are the ones that matter
        // (an equivalent test used to go through the removed base64 read path).
        let root = std::env::temp_dir().join(format!("amos-proto-seam-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        write_bundle(
            &root,
            "org.amos.web",
            "index.html",
            &["index.html", "assets/app.js"],
        );

        for uri in [
            "http://org.amos.web/",              // wrong scheme
            "amos-app://../secret",              // non-slug netloc
            "amos-app://A b/",                   // …with a space
            "amos-app://org.amos.web/../../etc", // climbs out of the bundle
            "amos-app://org.amos.web/nope.js",   // missing file
            "amos-app://not.installed/",         // not installed
        ] {
            let reply = serve_protocol_uri(Some(&root), None, uri);
            assert_eq!(reply.status, 404, "{uri} must be refused");
        }

        // …and a real asset is served, with the bundle's policy attached.
        let ok = serve_protocol_uri(Some(&root), None, "amos-app://org.amos.web/assets/app.js");
        assert_eq!(ok.status, 200);
        assert_eq!(ok.content_type, "text/javascript; charset=utf-8");
        assert!(ok.nosniff);
        assert!(ok.csp.is_some(), "a bundle response carries its own policy");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A real bundle directory as the installer produces it: `<root>/<id>/…`.
    fn write_bundle(root: &std::path::Path, id: &str, start: &str, files: &[&str]) {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("amos-app.json"),
            format!(r#"{{"id":"{id}","name":"Web","start":"{start}"}}"#),
        )
        .unwrap();
        for f in files {
            let p = dir.join(f);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, b"<html></html>").unwrap();
        }
    }

    #[test]
    fn a_bundle_entry_url_is_the_apps_own_origin() {
        let root = std::env::temp_dir().join(format!("amos-entry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        write_bundle(
            &root,
            "org.amos.web",
            "index.html",
            &["index.html", "app.js"],
        );

        let entry = read_bundle_entry(&root, "org.amos.web").unwrap();
        assert_eq!(entry.start, "index.html");
        // The origin is the app's **own** id, not the index's, and the platform
        // form comes from Rust — this is what makes the iframe same-origin with
        // its own assets.
        let expected = if cfg!(any(windows, target_os = "android")) {
            "http://amos-app.org.amos.web/index.html"
        } else {
            "amos-app://org.amos.web/index.html"
        };
        assert_eq!(entry.url, expected);

        // A non-default `start` is honoured (the host must not assume index.html).
        write_bundle(&root, "org.amos.other", "home.html", &["home.html"]);
        assert_eq!(
            read_bundle_entry(&root, "org.amos.other").unwrap().start,
            "home.html"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bundle_entry_is_refused_for_anything_not_servable() {
        let root = std::env::temp_dir().join(format!("amos-entry-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // Not a valid slug — so `..` can never become a directory under the root.
        assert!(read_bundle_entry(&root, "../secret").is_err());
        assert!(read_bundle_entry(&root, "Has Space").is_err());
        // Not installed at all.
        assert!(read_bundle_entry(&root, "org.amos.absent").is_err());

        // Installed but with no `amos-app.json` → not a web bundle.
        std::fs::create_dir_all(root.join("org.amos.nometa")).unwrap();
        let err = read_bundle_entry(&root, "org.amos.nometa").unwrap_err();
        assert!(err.contains("amos-app.json"), "{err}");

        // A `start` that escapes the bundle is refused by `read_bundle_meta`.
        write_bundle(&root, "org.amos.escape", "../../etc/passwd", &[]);
        assert!(read_bundle_entry(&root, "org.amos.escape").is_err());

        // A `start` that does not exist is refused rather than handed out as a URL.
        write_bundle(&root, "org.amos.missing", "nope.html", &["index.html"]);
        let err = read_bundle_entry(&root, "org.amos.missing").unwrap_err();
        assert!(err.contains("not found"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_reserved_netloc_can_never_be_handed_out_as_a_bundle() {
        // `index` is the protocol's **reserved** netloc: `serve_uri` routes every
        // `amos-app://index/…` request to the PWA index *before* it looks in the
        // install root. So a bundle filed under `<root>/index/` is unreachable —
        // and handing out a URL for it would be a plausible-looking answer that can
        // never work (the user would see the index gateway's 404 text inside an
        // "app" frame). `index` IS a valid app slug, so nothing else catches it.
        let root = std::env::temp_dir().join(format!("amos-entry-res-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        write_bundle(&root, "index", "index.html", &["index.html"]);

        let err = read_bundle_entry(&root, "index").expect_err("reserved netloc");
        assert!(err.contains("reserved"), "the error must say why: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn every_response_carries_a_policy_a_bundle_declares_and_the_index_never_runs() {
        // The last link in the chain: the policy the store computed must actually
        // reach the WebView as a header. A `ServedBundle.csp` that nothing sets as
        // a header would make the whole `allowed_domains` story decorative.
        let root = std::env::temp_dir().join(format!("amos-csp-hdr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("org.amos.web");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("amos-app.json"),
            br#"{"id":"org.amos.web","name":"Web","start":"index.html","allowed_domains":["api.example.com"]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("index.html"), b"<html></html>").unwrap();

        let bundle = protocol_response(serve_protocol_uri(
            Some(&root),
            None,
            "amos-app://org.amos.web/",
        ));
        let csp = bundle
            .headers()
            .get("Content-Security-Policy")
            .expect("a bundle document carries its policy")
            .to_str()
            .unwrap();
        assert!(
            csp.contains("connect-src 'self' https://api.example.com"),
            "{csp}"
        );
        assert!(csp.contains("script-src 'self'"), "{csp}");

        // The index namespace is data, not a document: nothing there may run, even
        // if a caller framed it.
        let index = protocol_response(serve_protocol_uri(
            Some(&root),
            None,
            "amos-app://index/apps.json",
        ));
        let csp = index
            .headers()
            .get("Content-Security-Policy")
            .expect("the index is locked down too")
            .to_str()
            .unwrap();
        assert!(csp.contains("default-src 'none'"), "{csp}");
        // …and a refusal is not a loophole either.
        let refused = protocol_response(serve_protocol_uri(Some(&root), None, "amos-app://nope/"));
        assert_eq!(refused.status(), 404);
        assert!(refused.headers().get("Content-Security-Policy").is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_index_url_command_matches_the_platform() {
        // The UI never assembles this by hand — it asks. Pin the value so a
        // hard-coded scheme in the frontend could never silently "work on my Mac".
        let expected = if cfg!(any(windows, target_os = "android")) {
            "http://amos-app.index"
        } else {
            "amos-app://index"
        };
        assert_eq!(pwa_index_url(), expected);
        assert_eq!(
            amos_appstore::index_document_url(&pwa_index_url()),
            format!("{expected}/apps.json")
        );
    }

    /// The reference `amos-app.toml`, as the index tests use it.
    ///
    /// Note the domain: a **bare host**, because `allowed_domains` is validated against
    /// the matcher that actually enforces it — a bare host already covers its
    /// subdomains, and the `*.host` form (which that matcher has no wildcard for, so it
    /// could never match) is refused.
    const INDEX_MANIFEST: &str = "[app]\n\
        id = \"org.amos.demo.odds\"\n\
        name = \"Open Odds\"\n\
        version = \"1.0.0\"\n\
        [display]\n\
        url = \"https://odds.example.org\"\n\
        [permissions.network]\n\
        allowed_domains = [\"odds.example.org\"]\n";

    /// A unique index dir with one manifest in it.
    fn temp_index(tag: &str) -> std::path::PathBuf {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("amos-tauri-pwa-{tag}-{}-{seq}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("apps")).unwrap();
        std::fs::write(dir.join("apps/org.amos.demo.odds.toml"), INDEX_MANIFEST).unwrap();
        dir
    }

    #[test]
    fn the_index_reply_is_public_and_its_refusals_carry_a_reason() {
        let dir = temp_index("index");

        let reply = serve_protocol_uri(None, Some(&dir), "amos-app://index/apps.json");
        assert_eq!(reply.status, 200);
        assert_eq!(reply.content_type, "application/json; charset=utf-8");
        assert!(reply.nosniff);
        assert!(
            reply.public,
            "the index is public, so it may be read cross-origin"
        );
        assert!(String::from_utf8_lossy(&reply.body).contains("org.amos.demo.odds"));

        // The response the handler would return: nosniff always, and the
        // wildcard only because the index is public.
        let response = protocol_response(reply);
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers().get("X-Content-Type-Options").unwrap(),
            "nosniff"
        );
        assert_eq!(
            response
                .headers()
                .get("Access-Control-Allow-Origin")
                .unwrap(),
            "*"
        );

        // A refusal is a 404 whose body says *why* — "the gateway is misconfigured"
        // must never be indistinguishable from "that app does not exist".
        let refused = serve_protocol_uri(Some(&dir), Some(&dir), "amos-app://index/etc/passwd");
        assert_eq!(refused.status, 404);
        assert!(String::from_utf8_lossy(&refused.body).contains("is not served"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bundle_reply_is_not_public() {
        let html = b"<!doctype html><h1>bundle</h1>".to_vec();

        // The bundle layout `WebInstaller` produces (`<root>/<id>/index.html`),
        // written directly: this test is about the *response shape*, and building
        // a tar.gz here would only add a dependency to prove nothing new.
        let root =
            std::env::temp_dir().join(format!("amos-tauri-pwa-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("org.amos.web");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), &html).unwrap();
        std::fs::write(
            dir.join("amos-app.json"),
            br#"{"id":"org.amos.web","name":"Web","start":"index.html"}"#,
        )
        .unwrap();

        let reply = serve_protocol_uri(Some(&root), None, "amos-app://org.amos.web/");
        assert_eq!(reply.status, 200);
        assert!(
            !reply.public,
            "one app's bundle is not another app's business"
        );
        assert_eq!(reply.body, html);

        let response = protocol_response(reply);
        assert_eq!(
            response.headers().get("X-Content-Type-Options").unwrap(),
            "nosniff"
        );
        assert!(
            response
                .headers()
                .get("Access-Control-Allow-Origin")
                .is_none(),
            "a bundle must not be readable cross-origin"
        );

        // No install root at all: an app request names the missing knob.
        let no_root = serve_protocol_uri(None, None, "amos-app://org.amos.web/");
        assert_eq!(no_root.status, 404);
        assert!(String::from_utf8_lossy(&no_root.body).contains("AMOS_APPSTORE_INSTALL_DIR"));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The `validate_appstore_id` seam is the single place that decides whether an
    /// id may proceed to the on-disk `dir_for(id)` join. The unit tests below
    /// pin down what is (and is not) acceptable, so a future relaxation is a
    /// conscious change rather than a silent drift toward "anything goes".
    #[test]
    fn validate_appstore_id_accepts_well_formed_ids() {
        for ok in [
            "org.amos.pomodoro",
            "a",
            "a-b_c.d",
            "com.example.My_App-1",
            "x".repeat(MAX_APPSTORE_ID_BYTES).as_str(),
        ] {
            assert!(
                validate_appstore_id(ok).is_ok(),
                "legitimate id {ok:?} should be accepted"
            );
        }
    }

    #[test]
    fn validate_appstore_id_rejects_path_traversal() {
        // Without this refusal, `dir_for(id)` would escape the install root.
        for evil in [
            "..",
            "../etc",
            "../etc/passwd",
            "..\\etc\\passwd",
            "../../../root/.ssh",
            "a/b",
            "a\\b",
            "/etc",
            "good/../bad",
            "good/..",
            "good/../bad/x",
        ] {
            assert!(
                validate_appstore_id(evil).is_err(),
                "path-traversal-shaped id {evil:?} must be refused"
            );
        }
    }

    #[test]
    fn validate_appstore_id_rejects_empty_and_oversized() {
        assert!(
            validate_appstore_id("").is_err(),
            "empty id must be refused"
        );
        let huge = "x".repeat(MAX_APPSTORE_ID_BYTES + 1);
        assert!(
            validate_appstore_id(&huge).is_err(),
            "id past MAX_APPSTORE_ID_BYTES must be refused"
        );
        assert!(validate_appstore_id("x\0y").is_err(), "NUL must be refused");
    }

    /// REQ-A268 follow-up: the mutation commands (`appstore_install` /
    /// `appstore_upgrade` / `appstore_uninstall`) must reject at the seam with
    /// a **typed** `AmosError`, not a plain `String` — that way the JS layer's
    /// `bridgeDiag()` sees a `code` and the UI can render a translated
    /// explanation instead of silently swallowing a Tauri internal error into
    /// `null`. Three pinned samples cover the three failure surfaces.
    #[test]
    fn validate_appstore_id_returns_typed_amose_errors() {
        let e = validate_appstore_id("").unwrap_err();
        assert_eq!(e.code(), "amos.appstore.id_empty");

        let huge = "x".repeat(MAX_APPSTORE_ID_BYTES + 1);
        let e = validate_appstore_id(&huge).unwrap_err();
        assert_eq!(e.code(), "amos.appstore.id_too_long");

        let e = validate_appstore_id("../etc/passwd").unwrap_err();
        assert_eq!(e.code(), "amos.appstore.id_invalid");
    }
}
