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
//! device bring-up step). The grant model mirrors Android runtime permissions:
//! host pre-grants the provider's available collections so the UI is usable
//! offline; on-device grants follow the user's `READ_MEDIA_*` / MediaStore consent.

use std::env;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use amos_media::{
    AccessKind, Grant, HostFsProvider, MediaItem, MediaKind, MediaManager, MediaProvider,
    MockMediaProvider, Result as MediaResult, StandardDir,
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
    manager: MediaManager,
    provider: Arc<SwitchableProvider>,
}

/// Grant read+write on every collection the (already built) provider serves.
fn pre_grant(manager: &MediaManager) {
    for c in manager.available_collections() {
        manager.grant_read(c);
        manager.grant_write(c);
    }
}

impl MediaBridge {
    /// Build a bridge over an initial backend, wrapped in a swappable provider.
    fn over(initial: Arc<dyn MediaProvider>) -> Self {
        let provider = Arc::new(SwitchableProvider::new(initial));
        let backend: Arc<dyn MediaProvider> = provider.clone();
        let manager = MediaManager::new(backend);
        pre_grant(&manager);
        Self { manager, provider }
    }

    /// Choose + build the boot backend: a real filesystem rooted at
    /// `AMOS_MEDIA_ROOT` when set (Waydroid / dev / root), else the deterministic
    /// mock. Read + write are pre-granted on whatever collections the backend
    /// serves so the UI is usable immediately. On a device the Kotlin glue later
    /// swaps in the real Android backend via [`Self::attach`].
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

    /// Access to the underlying manager (used by the commands below).
    fn manager(&self) -> &MediaManager {
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
    fn install(vm: JavaVM, env: &JNIEnv<'_>, glue: JObject<'_>) {
        use amos_media::AndroidMediaProvider;
        if let Ok(p) = AndroidMediaProvider::new(vm, env, glue) {
            let _ = DEVICE.set(Arc::new(p)); // first attach wins (exactly-once)
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
#[cfg(test)]
mod tests {
    use super::*;

    /// A bridge on the deterministic mock (the boot default).
    fn bridge() -> MediaBridge {
        MediaBridge::mock()
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
}
