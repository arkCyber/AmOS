//! Tauri <-> media/external-storage bridge (in-process).
//!
//! The WebView's Photos/Files/Camera/etc. will call `media_list` / `media_save` /
//! `media_*` grant commands to read and write the standard Android collections
//! (`DCIM/Camera`, `Pictures`, `Download`, `Recordings`, …). Unlike telephony
//! (which round-trips to the headless daemon), media on a real device is owned by
//! Android MediaStore/SAF reachable only *from the System UI APK itself* (via the
//! Kotlin `MediaStoreGlue` + JNI), so the provider seam lives here and is driven
//! directly by these commands (same host decision as `radio.rs` / `flashlight.rs`).
//!
//! Backend selection at boot (`docs/android-storage-unify.md`): default/desktop/CI
//! use the deterministic [`MockMediaProvider`]; setting `AMOS_MEDIA_ROOT=<dir>`
//! selects a real-filesystem [`HostFsProvider`] rooted there (Waydroid / a dev
//! folder / a root context), letting the whole `media_*` chain run end-to-end
//! against real files with no device; on-device `android` would use the real
//! `AndroidMediaProvider` over MediaStore glue (Phase C device, boot wiring is a
//! device bring-up step). The grant model mirrors Android runtime permissions: the
//! grant set is pre-don over **whatever collections the active backend serves** — at
//! boot for the mock/hostfs backend, and again when the device backend attaches
//! ([`sync_grants_for_active_backend`]), because MediaStore serves collections the
//! boot backend does not. This manager-level grant is *not* the authority on device:
//! the Kotlin glue enforces the real `READ_MEDIA_*` permission at the query, so a
//! granted-but-ungranted-by-Android collection is refused downstream, honestly.

use std::env;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use amos_media::{
    AccessKind, Grant, HostFsProvider, MediaItem, MediaKind, MediaManager, MediaProvider,
    MediaReply, MockMediaProvider, Result as MediaResult, StandardDir,
};
use tauri::State;

#[cfg(feature = "android")]
use jni::{objects::JObject, JNIEnv, JavaVM};

/// Epoch-ms now (falls back to 0 on any clock error; only used to seed mocks).
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A [`MediaProvider`] whose real backend can be swapped at runtime.
///
/// `MediaBridge::boot()` runs *before* the Kotlin `MediaStoreGlue` attaches (it is
/// managed at System UI startup), yet on a device we want the real Android backend,
/// not the boot-time mock. This delegating wrapper lets a later device attach swap
/// the inner backend without rebuilding the [`MediaManager`] the commands hold.
struct SwitchableProvider {
    inner: RwLock<Arc<dyn MediaProvider>>,
}

impl SwitchableProvider {
    fn new(initial: Arc<dyn MediaProvider>) -> Self {
        Self {
            inner: RwLock::new(initial),
        }
    }

    /// Swap the active backend (poison-safe: a panicked writer never wedges it).
    fn swap(&self, backend: Arc<dyn MediaProvider>) {
        let mut g = self.inner.write().unwrap_or_else(|p| p.into_inner());
        *g = backend;
    }
}

impl MediaProvider for SwitchableProvider {
    fn name(&self) -> &'static str {
        self.active().name()
    }

    fn available_collections(&self) -> Vec<StandardDir> {
        self.active().available_collections()
    }

    fn list(&self, dir: StandardDir) -> MediaResult<Vec<MediaItem>> {
        self.active().list(dir)
    }

    fn save(
        &self,
        dir: StandardDir,
        kind: MediaKind,
        name: &str,
        data: &[u8],
    ) -> MediaResult<MediaItem> {
        self.active().save(dir, kind, name, data)
    }

    fn save_from_path(
        &self,
        dir: StandardDir,
        kind: MediaKind,
        name: &str,
        src: &std::path::Path,
    ) -> MediaResult<MediaItem> {
        // Must forward, or the wrapper silently downgrades every streaming caller
        // to the trait default (which materialises the whole file in memory) —
        // exactly the allocation the Android backend's override exists to avoid.
        self.active().save_from_path(dir, kind, name, src)
    }

    fn load(&self, item: &MediaItem) -> MediaResult<Vec<u8>> {
        self.active().load(item)
    }
}

impl SwitchableProvider {
    /// The active backend: on-device it is the real Android MediaStore provider
    /// once the Kotlin `MediaStoreGlue` attaches (`device`); otherwise the
    /// swappable inner backend (mock / hostfs) that `MediaBridge::attach` controls.
    fn active(&self) -> Arc<dyn MediaProvider> {
        match self.device() {
            Some(p) => p,
            None => self.inner.read().unwrap_or_else(|p| p.into_inner()).clone(),
        }
    }

    /// The on-device Android provider, when installed (no-op on host).
    fn device(&self) -> Option<Arc<dyn MediaProvider>> {
        #[cfg(feature = "android")]
        {
            device::DEVICE.get().cloned()
        }
        #[cfg(not(feature = "android"))]
        {
            let _ = self;
            None
        }
    }
}

/// Managed state: a policy-owning [`MediaManager`] over a swappable backend.
pub struct MediaBridge {
    manager: Arc<MediaManager>,
    provider: Arc<SwitchableProvider>,
}

/// The live manager, registered by [`MediaBridge::over`] so a backend that becomes
/// active *after* boot can re-apply the grant rule (see
/// [`sync_grants_for_active_backend`]). There is exactly one bridge per process.
static MANAGER: OnceLock<Arc<MediaManager>> = OnceLock::new();

/// Grant read+write on every collection the (already built) provider serves.
fn pre_grant(manager: &MediaManager) {
    for c in manager.available_collections() {
        manager.grant_read(c);
        manager.grant_write(c);
    }
}

/// Re-run the pre-grant rule against the **currently active** backend.
///
/// `pre_grant` runs at boot, over whatever the boot backend served. On a device the real
/// [`amos_media::AndroidMediaProvider`] becomes active *later* — the Kotlin
/// `MediaStoreGlue` attaches over JNI, which holds no reference to the Tauri-managed
/// [`MediaBridge`] — so that path reaches this through the [`MANAGER`] global instead.
///
/// Without it the grant set stays whatever the boot backend happened to serve while
/// [`SwitchableProvider::active`] already answers with the device provider: the boot mock
/// serves four collections, MediaStore serves seven, so `Pictures` / `Movies` / `Music`
/// were refused `not authorized` on a phone that had actually been granted
/// `READ_MEDIA_IMAGES` / `_VIDEO` / `_AUDIO` (REQ-A1899 / F-SH-922). The manager's grant is
/// not the authority on device — the MediaStore glue enforces the real `READ_MEDIA_*`
/// permission at the query — so it must not contradict the provider it sits in front of.
///
/// Idempotent (`MediaManager::grant` dedups), so a re-entrant attach cannot double-grant.
///
/// Its only production caller is the `#[cfg(feature = "android")]` device install, so a
/// host build sees it as unused — the same host-only allowance [`MediaBridge::backend`]
/// carries. The host test `activating_a_wider_backend_grants_the_collections_it_adds`
/// exercises the rule itself, so it cannot drift unnoticed.
#[cfg_attr(not(feature = "android"), allow(dead_code))]
pub(crate) fn sync_grants_for_active_backend() {
    if let Some(manager) = MANAGER.get() {
        pre_grant(manager);
    }
}

impl MediaBridge {
    /// Build a bridge over an initial backend, wrapped in a swappable provider.
    fn over(initial: Arc<dyn MediaProvider>) -> Self {
        let provider = Arc::new(SwitchableProvider::new(initial));
        let backend: Arc<dyn MediaProvider> = provider.clone();
        let manager = Arc::new(MediaManager::new(backend));
        pre_grant(&manager);
        // Register the one bridge's manager for the device attach path. First wins; a
        // second bridge (never built in production) leaves the registered one alone.
        let _ = MANAGER.set(manager.clone());
        Self { manager, provider }
    }

    /// Choose + build the boot backend: a real filesystem rooted at
    /// `AMOS_MEDIA_ROOT` when set (Waydroid / dev / root), else the deterministic
    /// mock. Read + write are pre-granted on whatever collections the backend
    /// serves so the UI is usable immediately. On a device the Kotlin glue later
    /// installs the real Android backend (`device::install`), which re-runs that
    /// same rule over the collections **it** serves ([`sync_grants_for_active_backend`]).
    pub fn boot() -> Self {
        match env::var("AMOS_MEDIA_ROOT") {
            Ok(root) if !root.trim().is_empty() => Self::hostfs(PathBuf::from(root)),
            _ => Self::mock(),
        }
    }

    /// Backed by the deterministic mock (desktop/CI default).
    pub fn mock() -> Self {
        Self::over(Arc::new(MockMediaProvider::seeded(now_ms())))
    }

    /// Backed by a real-filesystem [`HostFsProvider`] rooted at `base`
    /// (`/storage/emulated/0` on a Waydroid/root context, or any dev folder).
    pub fn hostfs(base: PathBuf) -> Self {
        Self::over(Arc::new(HostFsProvider::new(base)))
    }

    /// Swap in the real active backend (e.g. the Android MediaStore provider the
    /// Kotlin glue built) and pre-grant whatever collections it serves. Used by
    /// the device bring-up path — harmless (a no-op style swap) on host.
    pub fn attach(&self, backend: Arc<dyn MediaProvider>) {
        self.provider.swap(backend);
        pre_grant(&self.manager);
    }

    /// The live backend handle — the same object the commands write through, so a
    /// holder stays correct across [`Self::attach`]. The WebMan download sink takes
    /// one so a download that completes *after* the Android glue attaches still
    /// lands in MediaStore rather than in the boot-time mock.
    ///
    /// Its only production caller is the `#[cfg(feature = "android")]` sink wiring
    /// in `lib.rs`, and host builds use `DirSink` (which never touches a provider)
    /// — hence the host-only `dead_code` allowance. The host test
    /// `backend_handle_sees_a_later_attach` keeps it exercised in the default
    /// build, so it cannot drift unnoticed.
    #[cfg_attr(not(feature = "android"), allow(dead_code))]
    pub(crate) fn backend(&self) -> Arc<dyn MediaProvider> {
        self.provider.clone()
    }

    /// Access to the underlying manager (used by the commands below, and by the
    /// `amos-media://` protocol handler in `lib.rs`).
    pub(crate) fn manager(&self) -> &MediaManager {
        &self.manager
    }
}

/// Build the Android MediaStore backend from the System UI's JVM + the Kotlin
/// `MediaStoreGlue` instance, ready to hand to [`MediaBridge::attach`].
///
/// # Safety
/// Only compiled for the on-device System UI (`feature android`); the `env`/`glue`
/// are the standard JNI arguments of a native attach call on the main thread.
#[cfg(feature = "android")]
pub fn android_backend(
    vm: JavaVM,
    env: &JNIEnv<'_>,
    glue: JObject<'_>,
) -> std::result::Result<Arc<dyn MediaProvider>, String> {
    use amos_media::AndroidMediaProvider;
    AndroidMediaProvider::new(vm, env, glue)
        .map(|p| -> Arc<dyn MediaProvider> { Arc::new(p) })
        .map_err(|e| e.to_string())
}

/// On-device MediaStore attach (feature `android`): the Kotlin `MediaStoreGlue`
/// instance (which owns the ContentResolver) is handed to Rust over JNI, wrapped
/// in a real [`amos_media::AndroidMediaProvider`], and installed into a process
/// global the [`SwitchableProvider`] consults — mirroring the `flashlight` device
/// seam. Compile-checked under `--features android`; exercised at device time.
#[cfg(feature = "android")]
mod device {
    use super::*;
    use jni::objects::JObject;
    use jni::sys::jobject;
    use std::sync::OnceLock;

    /// The real Android MediaStore provider, installed exactly-once at attach.
    pub(crate) static DEVICE: OnceLock<Arc<dyn MediaProvider>> = OnceLock::new();

    /// Wrap the Kotlin glue instance in an Android provider and install it.
    ///
    /// Uses [`android_backend`] so the Kotlin-glue → provider conversion has one
    /// implementation shared with the documented attach seam; this path adds the
    /// exactly-once process-global install *and* re-applies the grant rule, because
    /// the backend that just became active (MediaStore) serves collections the boot
    /// backend did not ([`sync_grants_for_active_backend`]).
    fn install(vm: JavaVM, env: &JNIEnv<'_>, glue: JObject<'_>) {
        if let Ok(p) = android_backend(vm, env, glue) {
            // First attach wins (exactly-once). Safe because the Activity is not recreated under
            // us — the generated manifest's `configChanges` is what makes that true, and
            // `scripts/android-glue-mirror.sh` now gates it (REQ-A448).
            if DEVICE.set(p).is_ok() {
                // The device provider is now what `SwitchableProvider::active` answers with, so
                // re-don the grant set over the collections *it* serves (REQ-A1899 / F-SH-922).
                sync_grants_for_active_backend();
            }
        }
    }

    /// `MediaStoreGlue.attach()` — JNI `(JNIEnv*, jobject)`; `this` is the Kotlin
    /// `MediaStoreGlue` instance holding the app Context / ContentResolver.
    ///
    /// # Safety
    /// `env`/`this` are the standard JNI arguments of a native call on the main
    /// thread; `this` is valid for the duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_MediaStoreGlue_attach(
        env: *mut jni::sys::JNIEnv,
        this: jobject,
    ) {
        if env.is_null() || this.is_null() {
            return; // nothing valid → honest no-op (mock stays active)
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        let Ok(env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
            return;
        };
        let Ok(vm) = env.get_java_vm() else {
            return;
        };
        // SAFETY: `this` is a live local ref for the duration of this call.
        let glue = unsafe { JObject::from_raw(this) };
        install(vm, &env, glue);
    }
}

// ---- Command cores -----------------------------------------------------------
// Each `#[tauri::command]` below is a one-line delegate to a `cmd_*` core over the
// manager, so the exact command behaviour + error-string mapping is unit-testable
// headlessly (a `State` can't be built without a running app / tauri test harness).

/// Core of `media_provider_name`.
fn cmd_provider_name(m: &MediaManager) -> String {
    m.provider_name().to_string()
}

/// Core of `media_available_collections`.
fn cmd_available_collections(m: &MediaManager) -> Vec<StandardDir> {
    m.available_collections()
}

/// Core of `media_grants`.
fn cmd_grants(m: &MediaManager) -> Vec<Grant> {
    m.grants()
}

/// Core of `media_grant_read`.
fn cmd_grant_read(m: &MediaManager, collection: StandardDir) {
    m.grant_read(collection);
}

/// Core of `media_grant_write`.
fn cmd_grant_write(m: &MediaManager, collection: StandardDir) {
    m.grant_write(collection);
}

/// Core of `media_revoke`.
fn cmd_revoke(m: &MediaManager, access: AccessKind, collection: StandardDir) {
    m.revoke(access, collection);
}

/// Core of `media_list` — error string is what the WebView sees on denial.
fn cmd_list(m: &MediaManager, collection: StandardDir) -> Result<Vec<MediaItem>, String> {
    m.list(collection).map_err(|e| e.to_string())
}

/// Core of `media_save`.
fn cmd_save(
    m: &MediaManager,
    collection: StandardDir,
    kind: MediaKind,
    name: String,
    data: Vec<u8>,
) -> Result<MediaItem, String> {
    m.save(collection, kind, &name, &data)
        .map_err(|e| e.to_string())
}

/// Core of `media_load`.
fn cmd_load(m: &MediaManager, item: MediaItem) -> Result<Vec<u8>, String> {
    m.load(&item).map_err(|e| e.to_string())
}

/// Core of `media_read_range`.
fn cmd_read_range(
    m: &MediaManager,
    item: MediaItem,
    offset: u64,
    len: u64,
) -> Result<Vec<u8>, String> {
    m.read_range(&item, offset, len).map_err(|e| e.to_string())
}

/// The underlying backend's name (for logs / settings).
#[tauri::command]
pub fn media_provider_name(state: State<'_, MediaBridge>) -> String {
    cmd_provider_name(state.manager())
}

/// The standard collections this backend can serve (for building permission UI).
#[tauri::command]
pub fn media_available_collections(state: State<'_, MediaBridge>) -> Vec<StandardDir> {
    cmd_available_collections(state.manager())
}

/// Current grant set (for a settings / privacy screen).
#[tauri::command]
pub fn media_grants(state: State<'_, MediaBridge>) -> Vec<Grant> {
    cmd_grants(state.manager())
}

/// Authorize reading `collection` (mirrors a granted `READ_MEDIA_*`).
#[tauri::command]
pub fn media_grant_read(state: State<'_, MediaBridge>, collection: StandardDir) {
    cmd_grant_read(state.manager(), collection);
}

/// Authorize writing into `collection` (mirrors MediaStore insert consent).
#[tauri::command]
pub fn media_grant_write(state: State<'_, MediaBridge>, collection: StandardDir) {
    cmd_grant_write(state.manager(), collection);
}

/// Revoke `access` on `collection`.
#[tauri::command]
pub fn media_revoke(state: State<'_, MediaBridge>, access: AccessKind, collection: StandardDir) {
    cmd_revoke(state.manager(), access, collection);
}

/// List the media in `collection`. Unauthorized → a descriptive error string the
/// UI maps to a permission prompt (never a silent empty list).
#[tauri::command]
pub fn media_list(
    state: State<'_, MediaBridge>,
    collection: StandardDir,
) -> Result<Vec<MediaItem>, String> {
    cmd_list(state.manager(), collection)
}

/// Persist `data` as `name` in `collection`; returns the created item.
#[tauri::command]
pub fn media_save(
    state: State<'_, MediaBridge>,
    collection: StandardDir,
    kind: MediaKind,
    name: String,
    data: Vec<u8>,
) -> Result<MediaItem, String> {
    cmd_save(state.manager(), collection, kind, name, data)
}

/// Read back the bytes of a previously-saved `item` (for rendering a real
/// thumbnail / opening a file). Unauthorized → descriptive error string.
#[tauri::command]
pub fn media_load(state: State<'_, MediaBridge>, item: MediaItem) -> Result<Vec<u8>, String> {
    cmd_load(state.manager(), item)
}

/// Read a bounded byte window of an `item` (`offset`/`len`) — the streaming
/// counterpart of `media_load`, obeying the same read grant. A caller that needs
/// a large file reads it in windows instead of materialising the whole item; the
/// bytes actually available are returned (a short/empty read is not an error).
#[tauri::command]
pub fn media_read_range(
    state: State<'_, MediaBridge>,
    item: MediaItem,
    offset: u64,
    len: u64,
) -> Result<Vec<u8>, String> {
    cmd_read_range(state.manager(), item, offset, len)
}
/// Turn a [`MediaReply`] into the `http::Response` the protocol handler returns.
///
/// Pure, so every status/header combination is pinned without a WebView — the same split
/// `appstore::protocol_response` uses for bundles. The headers are the ones RFC 7233 makes
/// load-bearing for a streaming client: `Accept-Ranges: bytes` on **every** reply (without
/// it a player will not seek, and re-fetches from byte 0 instead), `Content-Range` on `206`
/// **and** `416` (mandatory there), and `Content-Type` only when a body is served.
///
/// A refusal carries its reason in `X-Amos-Media-Refusal` for host-side diagnostics; the
/// body stays empty, because "this did not work" must never look like a zero-byte success.
pub fn protocol_response(reply: MediaReply) -> tauri::http::Response<Vec<u8>> {
    let mut builder = tauri::http::Response::builder().status(reply.status);
    if !reply.content_type.is_empty() {
        builder = builder.header("Content-Type", header_safe(&reply.content_type));
    }
    if let Some(content_range) = reply.content_range.as_deref() {
        builder = builder.header("Content-Range", header_safe(content_range));
    }
    if reply.accept_ranges {
        builder = builder.header("Accept-Ranges", "bytes");
    }
    if !reply.reason.is_empty() {
        builder = builder.header("X-Amos-Media-Refusal", header_safe(&reply.reason));
    }
    match builder.body(reply.bytes) {
        Ok(response) => response,
        Err(e) => {
            // Only reachable if a header value survived `header_safe` and was still
            // malformed. A protocol handler runs on the WebView's own thread, so this
            // must return a response rather than panic.
            tracing::warn!(
                target: "amos::media",
                error = %e,
                "{} response could not be built",
                amos_media::SCHEME
            );
            let mut fallback = tauri::http::Response::new(Vec::new());
            *fallback.status_mut() = tauri::http::StatusCode::INTERNAL_SERVER_ERROR;
            fallback
        }
    }
}

/// A header value an HTTP response can actually carry.
///
/// The reason is a **provider's** error string (`MediaError::Provider`), i.e. text this
/// crate does not control, and two of its properties are measured facts about
/// `http::HeaderValue` (probed in this module's tests, not assumed):
///
/// * **non-ASCII is accepted** as obs-text — so without this function the refusal header
///   would carry raw UTF-8 bytes to the WebView, an encoding this crate has no reason to
///   hand out and cannot verify there;
/// * **a control character is rejected**, and a rejected value does not panic — it makes
///   `Response::builder(..).body(..)` return `Err("failed to parse header value")`, which
///   drops the whole reply into the 500 fallback *and loses the reason*. A provider whose
///   error text spans two lines would therefore delete exactly the diagnostic that says
///   what went wrong.
///
/// So this is not cosmetic: non-printable bytes become `?` and the value is bounded, which
/// keeps *a* truthful reason — in ASCII — rather than none.
fn header_safe(raw: &str) -> String {
    const MAX_HEADER_CHARS: usize = 300;
    raw.chars()
        .take(MAX_HEADER_CHARS)
        .map(|c| {
            if c.is_ascii_graphic() || c == ' ' {
                c
            } else {
                '?'
            }
        })
        .collect()
}

/// Core of `media_stream_url`.
///
/// Two gates, both the ones `media_load` already applies, because a URL is a **read
/// capability**: the item must appear in the manager's authorized listing for its own
/// collection (so a revoked grant, a wrong collection, or an id that was never listed
/// answers `None` — never a URL that would 403/404 later), and the URL itself is spelled by
/// `amos_media::media_url` (one emitter, shared with the parser that serves it).
fn cmd_stream_url(m: &MediaManager, item: &MediaItem) -> Option<String> {
    let listed = m
        .list(item.collection)
        .ok()?
        .iter()
        .any(|i| i.id == item.id && i.collection == item.collection);
    if !listed {
        return None;
    }
    amos_media::media_url(&amos_media::base_url(), item.collection, &item.id)
}

/// The platform-correct `amos-media://` URL for an item's bytes (docs/media-player.md §8).
///
/// This is what lets a media element **stream** an item that is too large to buffer: the
/// element asks the host with `Range:` and the protocol handler answers bounded `206`
/// windows. `None` means "the host cannot serve this" (no listing entry, no read grant) —
/// the caller keeps its own honest refusal for that case rather than rendering an element
/// whose `src` would fail.
#[tauri::command]
pub fn media_stream_url(state: State<'_, MediaBridge>, item: MediaItem) -> Option<String> {
    cmd_stream_url(state.manager(), &item)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bridge on the deterministic mock (the boot default).
    fn bridge() -> MediaBridge {
        MediaBridge::mock()
    }

    /// The backend handle the WebMan download sink is given must be the **live**
    /// object, so a download that finishes after the Android glue swaps the backend
    /// in still reaches MediaStore instead of the boot-time mock. A handle taken
    /// before `attach` has to see the swap.
    ///
    /// The stand-in backend has a *different* name than the mock on purpose: a
    /// stale snapshot and the live handle would otherwise both answer "mock" and
    /// the assertion would hold either way.
    #[test]
    fn backend_handle_sees_a_later_attach() {
        struct Named(&'static str);
        impl MediaProvider for Named {
            fn name(&self) -> &'static str {
                self.0
            }
            fn available_collections(&self) -> Vec<StandardDir> {
                vec![StandardDir::Download]
            }
            fn list(&self, _dir: StandardDir) -> MediaResult<Vec<MediaItem>> {
                Ok(Vec::new())
            }
            fn save(
                &self,
                _dir: StandardDir,
                _kind: MediaKind,
                _name: &str,
                _data: &[u8],
            ) -> MediaResult<MediaItem> {
                Err(amos_media::MediaError::Provider("stub".to_string()))
            }
            fn load(&self, _item: &MediaItem) -> MediaResult<Vec<u8>> {
                Err(amos_media::MediaError::Provider("stub".to_string()))
            }
        }

        let b = bridge();
        let handle = b.backend();
        assert_eq!(handle.name(), "mock");

        b.attach(Arc::new(Named("attached")));
        // A snapshot taken before the swap would still say "mock".
        assert_eq!(handle.name(), "attached");
    }

    #[test]
    fn boot_uses_the_mock_and_serves_seeded_collections() {
        let b = bridge();
        assert_eq!(b.manager().provider_name(), "mock");
        let avail = b.manager().available_collections();
        assert!(avail.contains(&StandardDir::Camera));
        assert!(avail.contains(&StandardDir::Download));
        // Host boot pre-grants read+write on every available collection.
        for c in avail {
            assert!(b.manager().is_granted(AccessKind::Read, c));
            assert!(b.manager().is_granted(AccessKind::Write, c));
        }
    }

    #[test]
    fn granted_reads_yield_items_and_save_round_trips() {
        let b = bridge();
        let items = b.manager().list(StandardDir::Camera).unwrap();
        assert!(!items.is_empty());
        assert!(items.iter().all(|i| i.collection == StandardDir::Camera));

        // media_save path: valid write returns an item visible in a later list.
        let saved = b
            .manager()
            .save(
                StandardDir::Camera,
                MediaKind::Image,
                "IMG_bridge.jpg",
                &[1, 2, 3],
            )
            .unwrap();
        assert_eq!(saved.name, "IMG_bridge.jpg");
        assert!(b
            .manager()
            .list(StandardDir::Camera)
            .unwrap()
            .iter()
            .any(|i| i.id == saved.id));
    }

    #[test]
    fn unauthorized_and_invalid_writes_map_to_descriptive_strings() {
        // A fresh manager with no grants → list/save are honest errors, and their
        // to_string() carries a message the UI can surface (no silent empty).
        let provider: Arc<dyn MediaProvider> = Arc::new(MockMediaProvider::seeded(0));
        let m = MediaManager::new(provider);
        assert!(m.list(StandardDir::Camera).is_err());
        let list_err = m.list(StandardDir::Camera).unwrap_err().to_string();
        assert!(list_err.contains("not authorized"), "got: {list_err}");

        let save_err = m
            .save(StandardDir::Camera, MediaKind::Image, "x.jpg", b"x")
            .unwrap_err()
            .to_string();
        assert!(save_err.contains("not authorized"), "got: {save_err}");
    }

    #[test]
    fn revoke_blocks_subsequent_list() {
        let b = bridge();
        assert!(b.manager().list(StandardDir::Camera).is_ok());
        b.manager().revoke(AccessKind::Read, StandardDir::Camera);
        assert!(b.manager().list(StandardDir::Camera).is_err());
        assert!(matches!(
            b.manager().list(StandardDir::Camera),
            Err(amos_media::MediaError::Unauthorized { .. })
        ));
    }

    #[test]
    fn load_round_trips_saved_bytes_and_seeded_load_is_an_error() {
        let b = bridge();
        // Save then load returns the exact payload.
        let saved = b
            .manager()
            .save(
                StandardDir::Camera,
                MediaKind::Image,
                "IMG_load.jpg",
                &[7, 8, 9],
            )
            .unwrap();
        assert_eq!(b.manager().load(&saved).unwrap(), vec![7, 8, 9]);

        // A seeded (no-content) item loads as a descriptive Provider error — the
        // bridge surfaces it as a non-empty string the UI can show.
        let cam = b.manager().list(StandardDir::Camera).unwrap();
        let seeded = cam.iter().find(|i| i.id.starts_with("mock-seed-")).unwrap();
        let err = b.manager().load(seeded).unwrap_err().to_string();
        assert!(err.contains("holds no content"), "got: {err}");
    }

    #[test]
    fn hostfs_backed_bridge_lists_real_files_and_loads_them() {
        // Build a tiny real tree under a temp dir and drive it through the same
        // manager the commands use → end-to-end host validation (no device).
        let base =
            std::env::temp_dir().join(format!("amos-tauri-media-hostfs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("DCIM/Camera")).unwrap();
        std::fs::write(base.join("DCIM/Camera/IMG_real.jpg"), b"\xff\xd8\xff\xe0").unwrap();

        let b = MediaBridge::hostfs(base.clone());
        assert_eq!(b.manager().provider_name(), "hostfs");
        // Available collections come from what actually exists on disk.
        assert!(b
            .manager()
            .available_collections()
            .contains(&StandardDir::Camera));

        let items = b.manager().list(StandardDir::Camera).unwrap();
        assert_eq!(items.len(), 1);
        let it = &items[0];
        assert_eq!(it.name, "IMG_real.jpg");
        assert_eq!(it.size_bytes, Some(4));
        assert!(it.uri.ends_with("DCIM/Camera/IMG_real.jpg"));
        // Real bytes come back through load (no fabricated content).
        assert_eq!(b.manager().load(it).unwrap(), b"\xff\xd8\xff\xe0");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn hostfs_bridge_classifies_and_streams_real_media() {
        // A real (tiny) media tree, driven through the exact manager the
        // `media_*` commands use. `ID3` is a real MP3 header; the length-prefixed
        // `ftyp` box is a real MP4 header.
        let base =
            std::env::temp_dir().join(format!("amos-tauri-media-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("Music")).unwrap();
        std::fs::create_dir_all(base.join("Movies")).unwrap();
        std::fs::write(
            base.join("Music/晨光.mp3"),
            b"ID3\x03\x00\x00\x00\x00\x00\x00",
        )
        .unwrap();
        let mut mp4: Vec<u8> = vec![0, 0, 0, 24];
        mp4.extend_from_slice(b"ftypmp42");
        mp4.extend_from_slice(&[0, 0, 0, 0]);
        std::fs::write(base.join("Movies/星河.mp4"), &mp4).unwrap();
        // A non-media file must never be mistaken for playable media.
        std::fs::write(base.join("Music/readme.txt"), b"hello").unwrap();

        let b = MediaBridge::hostfs(base.clone());
        let m = b.manager();

        // The bridge reports each real file's true kind + MIME (name inference).
        let music = cmd_list(m, StandardDir::Music).unwrap();
        let mp3 = music.iter().find(|i| i.name == "晨光.mp3").expect("mp3");
        assert_eq!(mp3.kind, MediaKind::Audio);
        assert_eq!(mp3.mime.as_deref(), Some("audio/mpeg"));
        let txt = music.iter().find(|i| i.name == "readme.txt").expect("txt");
        assert_eq!(txt.kind, MediaKind::File);
        assert_eq!(txt.mime.as_deref(), Some("text/plain"));

        let movies = cmd_list(m, StandardDir::Movies).unwrap();
        let vid = movies.first().expect("video");
        assert_eq!(vid.kind, MediaKind::Video);
        assert_eq!(vid.mime.as_deref(), Some("video/mp4"));

        // A browser-style first request reads the `ftyp` box through the very
        // command core a streaming transport would call.
        assert_eq!(
            cmd_read_range(m, vid.clone(), 4, 4).unwrap(),
            b"ftyp".to_vec()
        );
        // Whole-item load and the ranged read agree byte for byte.
        assert_eq!(cmd_load(m, vid.clone()).unwrap(), mp4);
        let total = vid.size_bytes.unwrap_or(0);
        assert_eq!(cmd_read_range(m, vid.clone(), 0, total).unwrap(), mp4);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn boot_honours_amos_media_root_and_serves_real_media() {
        // The exact startup path `lib.rs` uses: setting AMOS_MEDIA_ROOT turns
        // boot into a real-filesystem backend (Waydroid / dev folder / root
        // context). AMOS_MEDIA_ROOT is process-global, but `boot()` has no other
        // caller in the test binary, so this is its only reader.
        let base = std::env::temp_dir().join(format!("amos-tauri-boot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("Music")).unwrap();
        std::fs::write(
            base.join("Music/晨光.mp3"),
            b"ID3\x03\x00\x00\x00\x00\x00\x00",
        )
        .unwrap();

        let prev = std::env::var("AMOS_MEDIA_ROOT").ok();
        std::env::set_var("AMOS_MEDIA_ROOT", &base);
        let b = MediaBridge::boot();
        match prev {
            Some(v) => std::env::set_var("AMOS_MEDIA_ROOT", v),
            None => std::env::remove_var("AMOS_MEDIA_ROOT"),
        }

        assert_eq!(b.manager().provider_name(), "hostfs");
        // Boot pre-grants the collections the backend serves, so a real file is
        // immediately listable/readable — i.e. the UI can play it right away.
        let music = cmd_list(b.manager(), StandardDir::Music).unwrap();
        assert_eq!(music.len(), 1);
        assert_eq!(music[0].kind, MediaKind::Audio);
        assert_eq!(music[0].mime.as_deref(), Some("audio/mpeg"));
        assert_eq!(
            b.manager().load(&music[0]).unwrap(),
            b"ID3\x03\x00\x00\x00\x00\x00\x00"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn attach_swaps_the_runtime_backend_without_rebuilding_the_manager() {
        // boot() starts on mock; the device glue later swaps in the real backend.
        let b = bridge();
        assert_eq!(b.manager().provider_name(), "mock");

        // Build a hostfs backend rooted at a tiny real tree and attach it.
        let base =
            std::env::temp_dir().join(format!("amos-tauri-media-attach-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("DCIM/Camera")).unwrap();
        std::fs::write(base.join("DCIM/Camera/attached.jpg"), b"\x01\x02").unwrap();

        let backend: Arc<dyn MediaProvider> = Arc::new(HostFsProvider::new(base.clone()));
        b.attach(backend);

        // The SAME manager now reads through the swapped backend.
        assert_eq!(b.manager().provider_name(), "hostfs");
        let items = b.manager().list(StandardDir::Camera).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "attached.jpg");
        assert_eq!(b.manager().load(&items[0]).unwrap(), b"\x01\x02");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn switchable_backend_is_safe_under_concurrent_attach_and_reads() {
        // attach() swaps the inner backend behind a RwLock; hammer it from a
        // writer while readers list concurrently — no panic, always self-consistent.
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc as A;

        let base =
            std::env::temp_dir().join(format!("amos-tauri-media-swap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("DCIM/Camera")).unwrap();
        std::fs::write(base.join("DCIM/Camera/swap.jpg"), b"\x01").unwrap();

        let bridge = A::new(bridge());
        let hostfs: Arc<dyn MediaProvider> = A::new(HostFsProvider::new(base.clone()));
        let mock: Arc<dyn MediaProvider> = A::new(MockMediaProvider::seeded(1));

        let stop = A::new(AtomicBool::new(false));

        // Writer: flip between the two backends rapidly.
        let writer_stop = A::clone(&stop);
        let writer_bridge = A::clone(&bridge);
        let writer_host = Arc::clone(&hostfs);
        let writer_mock = Arc::clone(&mock);
        let writer = std::thread::spawn(move || {
            for i in 0..500 {
                let backend = if i % 2 == 0 {
                    Arc::clone(&writer_host)
                } else {
                    Arc::clone(&writer_mock)
                };
                writer_bridge.attach(backend);
            }
            writer_stop.store(true, Ordering::SeqCst);
        });

        // Readers: keep listing while the writer flips the backend.
        let mut readers = Vec::new();
        for _ in 0..3 {
            let reader_bridge = A::clone(&bridge);
            let reader_stop = A::clone(&stop);
            readers.push(std::thread::spawn(move || {
                while !reader_stop.load(Ordering::SeqCst) {
                    let items = reader_bridge
                        .manager()
                        .list(StandardDir::Camera)
                        .expect("concurrent list must not fail");
                    // Whichever backend is active, every item belongs to Camera.
                    assert!(items.iter().all(|i| i.collection == StandardDir::Camera));
                }
            }));
        }
        writer.join().expect("writer must not panic");
        for r in readers {
            r.join().expect("reader must not panic");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- per-command core tests (exact bodies of media_* commands) ----

    #[test]
    fn command_cores_smoke() {
        let b = bridge(); // mock, boot-like (camera/etc. granted)
        let m = b.manager();

        // provider_name / available_collections / grants
        assert_eq!(cmd_provider_name(m), "mock");
        assert!(cmd_available_collections(m).contains(&StandardDir::Camera));
        assert!(!cmd_grants(m).is_empty());

        // list returns items on a granted collection
        let items = cmd_list(m, StandardDir::Camera).expect("granted list ok");
        assert!(!items.is_empty());

        // save + load round-trip through the exact command error mapping
        let saved = cmd_save(
            m,
            StandardDir::Camera,
            MediaKind::Image,
            "c.jpg".into(),
            b"\x01\x02".to_vec(),
        )
        .expect("granted save ok");
        assert_eq!(cmd_load(m, saved.clone()).unwrap(), b"\x01\x02".to_vec());

        // revoke read → media_list surfaces a descriptive denial string
        cmd_revoke(m, AccessKind::Read, StandardDir::Camera);
        let denied = cmd_list(m, StandardDir::Camera).unwrap_err();
        assert!(denied.contains("not authorized"), "got: {denied}");

        // grant_read/grant_write re-enable (idempotent cores)
        cmd_grant_read(m, StandardDir::Camera);
        cmd_grant_write(m, StandardDir::Download);
        assert!(cmd_list(m, StandardDir::Camera).is_ok());
    }

    #[test]
    fn command_cores_deny_without_any_grant() {
        // A bridge whose manager has no grants → every list/save is a denial.
        let provider: Arc<dyn MediaProvider> = Arc::new(MockMediaProvider::seeded(0));
        let m = MediaManager::new(provider);
        assert!(cmd_list(&m, StandardDir::Camera)
            .unwrap_err()
            .contains("not authorized"));
        assert!(cmd_save(
            &m,
            StandardDir::Camera,
            MediaKind::Image,
            "x.jpg".into(),
            b"x".to_vec()
        )
        .unwrap_err()
        .contains("not authorized"));
    }

    #[test]
    fn command_core_load_reports_missing_content_for_seeded_items() {
        let b = bridge();
        let m = b.manager();
        let seeded = cmd_list(m, StandardDir::Camera)
            .unwrap()
            .into_iter()
            .find(|i| i.id.starts_with("mock-seed-"))
            .expect("seeded camera item");
        let err = cmd_load(m, seeded).unwrap_err();
        assert!(err.contains("holds no content"), "got: {err}");
    }

    #[test]
    fn command_core_read_range_windows_and_is_gated() {
        let b = bridge(); // mock, boot-like (read+write granted)
        let m = b.manager();
        let saved = cmd_save(
            m,
            StandardDir::Download,
            MediaKind::File,
            "r.bin".into(),
            b"0123456789".to_vec(),
        )
        .expect("granted save ok");

        // A windowed read returns exactly the requested slice (short at EOF).
        assert_eq!(
            cmd_read_range(m, saved.clone(), 2, 3).unwrap(),
            b"234".to_vec()
        );
        assert_eq!(
            cmd_read_range(m, saved.clone(), 8, 100).unwrap(),
            b"89".to_vec()
        );
        assert!(cmd_read_range(m, saved.clone(), 99, 4).unwrap().is_empty());

        // A seeded item holds no bytes → the honest provider error.
        let seeded = cmd_list(m, StandardDir::Camera)
            .unwrap()
            .into_iter()
            .find(|i| i.id.starts_with("mock-seed-"))
            .expect("seeded camera item");
        assert!(cmd_read_range(m, seeded, 0, 4)
            .unwrap_err()
            .contains("holds no content"));

        // The streaming path obeys the same read grant as load.
        cmd_revoke(m, AccessKind::Read, StandardDir::Download);
        assert!(cmd_read_range(m, saved, 0, 4)
            .unwrap_err()
            .contains("not authorized"));
    }

    /// The reply → HTTP mapping is what a `<video>` element actually sees, so every
    /// load-bearing header is pinned here rather than "somewhere in the WebView".
    #[test]
    fn protocol_response_carries_the_headers_a_streaming_player_needs() {
        // A ranged window: `206` + `Content-Range` + the type + `Accept-Ranges`.
        let partial = protocol_response(MediaReply {
            status: 206,
            content_type: "video/mp4".to_string(),
            content_range: Some("bytes 0-4095/99999".to_string()),
            accept_ranges: true,
            bytes: vec![1, 2, 3],
            reason: String::new(),
        });
        assert_eq!(partial.status(), 206);
        assert_eq!(partial.headers().get("Content-Type").unwrap(), "video/mp4");
        assert_eq!(
            partial.headers().get("Content-Range").unwrap(),
            "bytes 0-4095/99999"
        );
        assert_eq!(partial.headers().get("Accept-Ranges").unwrap(), "bytes");
        assert!(partial.headers().get("X-Amos-Media-Refusal").is_none());
        assert_eq!(partial.body().as_slice(), &[1, 2, 3]);

        // A whole-item `200` carries no `Content-Range` (there is no range to describe)…
        let whole = protocol_response(MediaReply {
            status: 200,
            content_type: "audio/mpeg".to_string(),
            content_range: None,
            accept_ranges: true,
            bytes: vec![9, 9],
            reason: String::new(),
        });
        assert_eq!(whole.status(), 200);
        assert!(whole.headers().get("Content-Range").is_none());
        assert_eq!(whole.headers().get("Accept-Ranges").unwrap(), "bytes");

        // …and a refusal is an empty body with its reason in a header: never a 0-byte
        // `200` that a player would treat as an unreadable file.
        let refused = protocol_response(MediaReply {
            status: 413,
            content_type: String::new(),
            content_range: None,
            accept_ranges: true,
            bytes: Vec::new(),
            reason: "999 bytes exceeds the 4-byte response bound".to_string(),
        });
        assert_eq!(refused.status(), 413);
        assert!(refused.body().is_empty());
        assert!(refused.headers().get("Content-Type").is_none());
        assert_eq!(
            refused.headers().get("X-Amos-Media-Refusal").unwrap(),
            "999 bytes exceeds the 4-byte response bound"
        );

        // `416` must still carry `Content-Range: bytes */total` (RFC 7233 §4.4).
        let unsatisfiable = protocol_response(MediaReply {
            status: 416,
            content_type: String::new(),
            content_range: Some("bytes */100".to_string()),
            accept_ranges: true,
            bytes: Vec::new(),
            reason: "bytes=99999- is not satisfiable for a 100-byte item".to_string(),
        });
        assert_eq!(
            unsatisfiable.headers().get("Content-Range").unwrap(),
            "bytes */100"
        );
    }

    /// A provider's error text is not ours to trust into a header: `HeaderValue` takes
    /// printable ASCII only, so a backend that reports a UTF-8 path must still produce a
    /// refusal *with a reason* instead of falling into the 500 fallback.
    #[test]
    fn header_safe_keeps_a_refusal_reason_that_is_not_ascii() {
        assert_eq!(header_safe("plain /tmp/a.mp4"), "plain /tmp/a.mp4");
        assert_eq!(header_safe("读不到 /tÿ"), "??? /t?");
        assert_eq!(header_safe("a\nb"), "a?b");
        // Bounded, so a provider cannot turn a refusal into a huge response header.
        assert_eq!(header_safe(&"x".repeat(400)).chars().count(), 300);

        let reply = protocol_response(MediaReply {
            status: 500,
            content_type: String::new(),
            content_range: None,
            accept_ranges: true,
            bytes: Vec::new(),
            reason: "provider: 无法读取 /media/影片.mp4".to_string(),
        });
        assert_eq!(reply.status(), 500);
        assert_eq!(
            reply.headers().get("X-Amos-Media-Refusal").unwrap(),
            "provider: ???? /media/??.mp4"
        );
    }

    /// TEMPORARY PROBE — the rules `header_safe` exists for, measured rather than assumed.
    ///
    /// Kept as a **permanent** test (it is the justification written in `header_safe`'s own
    /// doc comment): if a future `http` bump changes any of these three answers, the reason
    /// this function exists changes with it.
    #[test]
    fn the_header_rules_header_safe_is_written_against() {
        // 1. Non-ASCII is accepted (obs-text) — sanitising is about not shipping raw UTF-8
        //    into a header, not about being *allowed* to.
        assert!(tauri::http::HeaderValue::from_str("provider: 读不到").is_ok());
        // 2. A control character is rejected…
        assert!(tauri::http::HeaderValue::from_str("a\nb").is_err());
        // 3. …and the rejection is not a panic: the *body* call returns an error, so the
        //    whole reply would degrade to the headerless 500 fallback (reason lost).
        let built = std::panic::catch_unwind(|| {
            tauri::http::Response::builder()
                .header("X-T", "a\nb")
                .body(Vec::<u8>::new())
        });
        assert!(
            matches!(built, Ok(Err(_))),
            "a rejected header value must surface as Err, not as a panic"
        );

        // …which is why a two-line provider error still reaches the client as a refusal
        // *with a reason* instead of a reason-less 500.
        let reply = protocol_response(MediaReply {
            status: 500,
            content_type: String::new(),
            content_range: None,
            accept_ranges: true,
            bytes: Vec::new(),
            reason: "provider: read failed\n(ENOENT)".to_string(),
        });
        assert_eq!(reply.status(), 500);
        assert_eq!(
            reply.headers().get("X-Amos-Media-Refusal").unwrap(),
            "provider: read failed?(ENOENT)"
        );
    }

    /// `media_stream_url` is a **read capability**, so it is gated exactly like `load`:
    /// listed + granted, else `None` (the caller keeps its own honest refusal). And the URL
    /// it hands out is the one the protocol handler can actually serve.
    #[test]
    fn command_core_stream_url_is_gated_by_the_listing_and_the_grant() {
        let b = bridge();
        let m = b.manager();
        let saved = cmd_save(
            m,
            StandardDir::Download,
            MediaKind::File,
            "movie.mp4".to_string(),
            vec![0u8; 8],
        )
        .unwrap();

        let url = cmd_stream_url(m, &saved).expect("a listed, granted item has a URL");
        assert_eq!(
            url,
            format!("{}download/{}", amos_media::base_url_for(false), saved.id)
        );
        // The URL the host hands out is one the host can serve: the same collection+id come
        // back out of the parser the protocol handler itself uses.
        assert_eq!(
            amos_media::parse_uri(&url).unwrap(),
            (StandardDir::Download, saved.id.clone())
        );

        // An id that is not in the listing: no URL, rather than a 404 later.
        let mut ghost = saved.clone();
        ghost.id = "mock-999999".to_string();
        assert_eq!(cmd_stream_url(m, &ghost), None);

        // The item claimed under a collection it does not live in: no URL.
        let mut misfiled = saved.clone();
        misfiled.collection = StandardDir::Camera;
        assert_eq!(cmd_stream_url(m, &misfiled), None);

        // A revoked read grant revokes the URL in the same instant.
        cmd_revoke(m, AccessKind::Read, StandardDir::Download);
        assert_eq!(cmd_stream_url(m, &saved), None);
    }

    // ---- Kotlin glue contract -------------------------------------------------

    /// The Rust source of a function, from the first `{` after `marker` to its matching
    /// `}` — declared `fn` name matching only (a call site has no `{`). Line comments are
    /// stripped so a call named only in the prose beside it cannot stand in for the call.
    fn rust_fn_body(src: &str, marker: &str) -> String {
        let start = src
            .find(marker)
            .unwrap_or_else(|| panic!("media.rs no longer has `{marker}`"));
        let rest = &src[start..];
        let open = rest.find('{').expect("the declaration has no body");
        let mut depth = 0usize;
        let mut end = rest.len().saturating_sub(1);
        for (i, ch) in rest[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        rest[open..=end]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// A backend that serves **more** collections than the boot mock — the shape the
    /// on-device MediaStore provider has relative to the boot-time mock.
    struct WideProvider;
    impl MediaProvider for WideProvider {
        fn name(&self) -> &'static str {
            "wide"
        }
        fn available_collections(&self) -> Vec<StandardDir> {
            vec![StandardDir::Download, StandardDir::Music]
        }
        fn list(&self, _dir: StandardDir) -> MediaResult<Vec<MediaItem>> {
            Ok(Vec::new())
        }
        fn save(
            &self,
            _dir: StandardDir,
            _kind: MediaKind,
            _name: &str,
            _data: &[u8],
        ) -> MediaResult<MediaItem> {
            Err(amos_media::MediaError::Provider("stub".to_string()))
        }
        fn load(&self, _item: &MediaItem) -> MediaResult<Vec<u8>> {
            Err(amos_media::MediaError::Provider("stub".to_string()))
        }
    }

    /// The **rule** the device attach re-runs: once a backend is active, every collection
    /// *it* serves is granted, including ones the previous backend did not serve. The
    /// device attach is a JNI static with no bridge handle, so `MediaBridge::attach` is the
    /// host twin of that sequence; this is its positive control.
    #[test]
    fn activating_a_wider_backend_grants_the_collections_it_adds() {
        let b = bridge(); // the mock: no Music
        assert!(
            !b.manager().is_granted(AccessKind::Read, StandardDir::Music),
            "the mock must not already serve Music, or this control proves nothing"
        );
        b.attach(Arc::new(WideProvider));
        assert!(
            b.manager().is_granted(AccessKind::Read, StandardDir::Music)
                && b.manager()
                    .is_granted(AccessKind::Write, StandardDir::Music),
            "activating a backend must grant every collection it serves (REQ-A1899 / F-SH-922)"
        );
    }

    /// The on-device attach must **re-don** the grant set over the backend it activates.
    ///
    /// The Kotlin `MediaStoreGlue` makes `SwitchableProvider::active` answer with the
    /// Android provider, whose collections the boot backend never served; a grant set left
    /// at the boot snapshot refuses `Pictures` / `Movies` / `Music` on a phone that did
    /// grant `READ_MEDIA_IMAGES` / `_VIDEO` / `_AUDIO` (REQ-A1899 / F-SH-922). Pinned at the
    /// source because the seam is a JNI static with no bridge handle and cannot run on the
    /// host. Ordering is part of the contract: re-granting *before* the install would grant
    /// nothing new, because `active` would still answer with the boot backend.
    #[test]
    fn the_device_attach_re_grants_the_backend_it_activates() {
        let body = rust_fn_body(include_str!("media.rs"), "fn install(");
        let set_at = body
            .find("DEVICE.set(")
            .expect("`install` must install the device provider");
        let sync_at = body.find("sync_grants_for_active_backend(").expect(
            "the device attach must re-run the grant rule over the backend it just made \
             active (REQ-A1899 / F-SH-922)",
        );
        assert!(
            set_at < sync_at,
            "the re-grant must follow the install, or it grants nothing new"
        );
    }

    /// The slice of Kotlin source from `marker` up to the next blank line — one
    /// function, in `MediaStoreGlue.kt`'s blank-line-separated style.
    fn kt_block<'a>(src: &'a str, marker: &str) -> &'a str {
        let start = src
            .find(marker)
            .unwrap_or_else(|| panic!("MediaStoreGlue.kt no longer has `{marker}`"));
        let rest = &src[start..];
        match rest.find("\n\n") {
            Some(end) => &rest[..end],
            None => rest,
        }
    }

    /// `"foo"` (a Kotlin string literal) → `Some("foo")`; anything else → `None`.
    fn kt_str(tok: &str) -> Option<String> {
        let t = tok.trim();
        (t.len() >= 2 && t.starts_with('"') && t.ends_with('"'))
            .then(|| t[1..t.len() - 1].to_string())
    }

    /// The `"key" -> "value"` arms of a Kotlin `when` block (single-line, one arm
    /// per line — the style in `MediaStoreGlue.kt`). The `else` arm is keyed
    /// `"else"`; an arm whose value is not a string literal (e.g. `else -> null`)
    /// is skipped.
    fn kt_when_arms(block: &str) -> std::collections::HashMap<String, String> {
        let mut arms = std::collections::HashMap::new();
        for line in block.lines() {
            let t = line.trim();
            let Some(arrow) = t.find("-> ") else { continue };
            let (lhs, rhs) = (t[..arrow].trim(), t[arrow + 3..].trim());
            let Some(value) = kt_str(rhs) else { continue };
            let key = if lhs == "else" {
                "else".to_string()
            } else {
                match kt_str(lhs) {
                    Some(k) => k,
                    None => continue,
                }
            };
            arms.insert(key, value);
        }
        arms
    }

    /// The device MediaStore backend and its Kotlin glue share three tables that
    /// live **once** in Rust (`StandardDir::{default_kind, canonical_path}` and
    /// `mapping::read_permissions`) and are hand-copied into `MediaStoreGlue.kt`.
    /// Nothing bound the two sides — the glue is Kotlin (compiled only on the
    /// Android/JDK path) and `jni-contract-scan` binds JNI member names, not these
    /// literal tables — and the drift was already live: `kindFor("music")` fell
    /// through to `"image"` while `StandardDir::Music.default_kind()` was `File`,
    /// so one `Music/` file was typed differently on a device and under `HostFs`,
    /// silently (both are legal wire tags, so serde accepts either). (REQ-A727 /
    /// F-SH-185.)
    #[test]
    fn the_glue_collection_tables_are_pinned_to_the_rust_spec() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/MediaStoreGlue.kt");

        // The collections the device backend can enumerate. `Root` is virtual —
        // the glue's `collectionUri` has no "root" arm — so it is excluded.
        let dirs: Vec<StandardDir> = StandardDir::all()
            .iter()
            .copied()
            .filter(|d| *d != StandardDir::Root)
            .collect();
        assert!(dirs.len() >= 7, "the collection census shrank: {dirs:?}");

        // 1. collection -> kind. `kindFor` leans on its `else` arm for the photo
        //    collections, so an unlisted tag resolves to that arm.
        let kind_arms = kt_when_arms(kt_block(KOTLIN, "fun kindFor("));
        let else_kind = kind_arms
            .get("else")
            .expect("MediaStoreGlue.kindFor lost its else arm")
            .clone();
        assert!(
            kind_arms.len() >= 3,
            "the kindFor arm scan found too few arms: {kind_arms:?}"
        );
        for d in &dirs {
            let tag = d.tag();
            let got = kind_arms
                .get(tag)
                .cloned()
                .unwrap_or_else(|| else_kind.clone());
            assert_eq!(
                got,
                d.default_kind().as_str(),
                "MediaStoreGlue.kindFor({tag:?}) disagrees with StandardDir::default_kind"
            );
        }

        // 2. collection -> MediaStore RELATIVE_PATH (the Rust path + the trailing
        //    "/" MediaStore uses).
        let path_arms = kt_when_arms(kt_block(KOTLIN, "fun relativePathFor("));
        assert!(
            path_arms.len() >= 7,
            "the relativePathFor arm scan found too few arms: {path_arms:?}"
        );
        for d in &dirs {
            let tag = d.tag();
            let want = format!("{}/", d.canonical_path());
            assert_eq!(
                path_arms.get(tag),
                Some(&want),
                "MediaStoreGlue.relativePathFor({tag:?}) disagrees with StandardDir::canonical_path"
            );
        }

        // 3. read permissions, both ways: the glue must request exactly what
        //    `read_permissions` names on the modern and legacy API levels.
        let mut expected: Vec<String> = amos_media::mapping::read_permissions(33)
            .iter()
            .chain(amos_media::mapping::read_permissions(28).iter())
            .map(|s| (*s).to_string())
            .collect();
        expected.sort();
        expected.dedup();
        assert_eq!(
            expected.len(),
            4,
            "read_permissions no longer names 4 distinct permissions"
        );
        let mut glue: Vec<String> = Vec::new();
        let mut rest: &str = KOTLIN;
        while let Some(i) = rest.find("\"android.permission.READ") {
            let after = &rest[i..]; // at the opening quote
            let Some(close) = after[1..].find('"') else {
                break;
            };
            glue.push(after[1..1 + close].to_string());
            rest = &after[1 + close + 1..];
        }
        glue.sort();
        glue.dedup();
        assert_eq!(
            glue, expected,
            "MediaStoreGlue's read permissions drifted from mapping::read_permissions"
        );
    }
}
