//! Tauri <-> flashlight/illumination bridge (in-process).
//!
//! The WebView's control-center torch toggle calls `flashlight_status` /
//! `flashlight_set`. Unlike telephony (which round-trips to the headless
//! `amos-ai` daemon), the torch on the no-UI Android base is the rear camera's
//! flash unit owned by Android `CameraManager`, reachable only *from the System
//! UI APK itself* (via JNI/binder). So the provider seam lives here and is driven
//! directly by these commands (same host decision as `radio.rs`).
//!
//! Today a [`MockFlashlightProvider`] backs the bridge, seeded from the durable
//! `amos.flashlight` store so the last on/off survives restarts; every successful
//! set is mirrored back into that store so the cross-window `store-updated` sync
//! keeps working. A real Android provider replaces the Mock under
//! `amos-flashlight`'s `android` feature (docs/flashlight.md).

use std::sync::Arc;

use crate::store::SharedStore;
use amos_flashlight::{
    FlashlightManager, FlashlightProvider, FlashlightState, MockFlashlightProvider,
};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, State};

/// Durable store key that persists the torch state for restart + cross-window
/// sync (distinct from the `amos.settings` preference quick-toggles).
pub const FLASHLIGHT_KEY: &str = "amos.flashlight";

/// Serializable snapshot of the torch (prost-free; plain bools).
#[derive(Clone, Debug, Serialize)]
pub struct FlashlightPayload {
    /// Whether the torch is currently lit.
    pub on: bool,
    /// Whether this device actually has a usable torch (rear camera + flash).
    pub torch_present: bool,
    /// Convenience alias: a torch can be lit only when hardware is present.
    pub available: bool,
}

impl From<FlashlightState> for FlashlightPayload {
    fn from(s: FlashlightState) -> Self {
        Self {
            on: s.on,
            torch_present: s.torch_present,
            available: s.torch_present,
        }
    }
}

/// Managed state: a policy-owning [`FlashlightManager`] over the active provider.
pub struct FlashlightBridge {
    manager: FlashlightManager,
}

impl FlashlightBridge {
    /// Build a bridge backed by [`MockFlashlightProvider`] seeded from `seed`
    /// (the persisted torch state read from `amos.flashlight` at boot).
    pub fn mock_seeded(seed: FlashlightState) -> Self {
        let provider: Arc<dyn FlashlightProvider> = Arc::new(MockFlashlightProvider::new(seed));
        Self {
            manager: FlashlightManager::new(provider),
        }
    }

    /// **On-device**: back the bridge with the real Android provider
    /// ([`amos_flashlight::AndroidFlashlightProvider`]) instead of the Mock.
    ///
    /// `vm`/`env`/`context` come from the System UI APK's JNI environment (its
    /// `JavaVM` + a global ref to the Activity/Application context), plus the id
    /// of the rear camera carrying the torch and whether that camera has a flash
    /// unit. Desktop has no JVM, so this is gated behind the `android` feature
    /// (see docs/flashlight.md); `cargo check --features android` keeps the
    /// wiring compiling.
    #[cfg(feature = "android")]
    pub fn from_android(
        vm: jni::JavaVM,
        env: &jni::JNIEnv<'_>,
        context: jni::objects::JObject<'_>,
        camera_id: String,
        torch_present: bool,
    ) -> Result<Self, String> {
        let provider = amos_flashlight::AndroidFlashlightProvider::new(
            vm,
            env,
            context,
            camera_id,
            torch_present,
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            manager: FlashlightManager::new(Arc::new(provider)),
        })
    }

    /// Wrap an already-constructed provider (Mock or real) into a bridge.
    /// Only the on-device boot path uses it (a pre-built Android provider).
    #[cfg(feature = "android")]
    fn from_provider(provider: Arc<dyn FlashlightProvider>) -> Self {
        Self {
            manager: FlashlightManager::new(provider),
        }
    }
}

/// Choose the bridge used at System UI boot.
///
/// Desktop / CI (no `android` feature): always the [`MockFlashlightProvider`]
/// seeded from the durable store.
///
/// On-device (`android` feature): when the Kotlin `FlashlightGlue` has already
/// handed the Activity `Context` + a resolved torch camera over (via the
/// `Java_com_amos_ai_glue_FlashlightGlue_attach` upcall below), boot backs the
/// bridge with the real [`amos_flashlight::AndroidFlashlightProvider`] instead
/// of the Mock; otherwise it falls back to the Mock so the shell still boots
/// deterministically even when native/Activity attach ordering runs the upcall
/// after `run()` (a device bring-up detail, see docs/flashlight.md §5).
pub fn boot_bridge(seed: FlashlightState) -> FlashlightBridge {
    #[cfg(feature = "android")]
    {
        // Back the managed bridge with a delegating provider that uses the real
        // torch once FlashlightGlue.attach runs (Activity onStart), falling back to
        // the seeded Mock until then. Fixes the boot-ordering bug where a permanent
        // Mock bridge was built before the Kotlin glue could swap in the real device.
        let p: Arc<dyn FlashlightProvider> = Arc::new(device::DelegatingProvider::new(seed));
        FlashlightBridge::from_provider(p)
    }
    #[cfg(not(feature = "android"))]
    FlashlightBridge::mock_seeded(seed)
}

/// On-device: give the device seam an `AppHandle` so OS-driven torch changes are
/// pushed live to the System UI (shared-store `store-updated`). Desktop no-op —
/// the `device` seam is only compiled under the `android` feature.
#[cfg(feature = "android")]
pub fn install_ui_pusher(app: AppHandle) {
    device::install_ui_pusher(app);
}

/// Android device seam (feature `android`): installs the real torch provider
/// handed up from the Kotlin `FlashlightGlue` (Activity `Context` + a resolved
/// rear camera carrying a flash unit). Mirrors the `clipboard_glue`/`android_glue`
/// upcall pattern — compile-checked under `--features android`, exercised at
/// device time.
#[cfg(feature = "android")]
mod device {
    use super::*;
    use jni::objects::JObject;
    use jni::sys::{jboolean, jobject, jstring};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::Manager;

    /// The real torch provider installed once at device attach (exactly-once).
    static DEVICE: OnceLock<Arc<dyn FlashlightProvider>> = OnceLock::new();

    /// Mirror of the hardware fact resolved at attach, so an OS-driven push can
    /// re-emit the full `{on, torch_present}` store value for the UI.
    static TORCH_PRESENT: AtomicBool = AtomicBool::new(false);

    /// Installed once from `lib.rs::setup` (android feature): an `AppHandle` so
    /// OS-driven torch changes can be written to the shared store and broadcast
    /// as `store-updated`, updating the System UI (status bar + any open tile)
    /// live instead of on next panel-open / poll.
    static PUSHER: OnceLock<AppHandle> = OnceLock::new();

    /// A torch provider that uses the **real** hardware once the Kotlin glue attaches
    /// (`FlashlightGlue.attach` → [`DEVICE`]), falling back to the seeded Mock until
    /// then. The managed bridge holds this provider from boot, so a late `attach`
    /// (it runs in the Activity's `onStart`, after Rust's `onCreate`-phase boot) is
    /// picked up by the next `snapshot`/`set_on` — no boot-ordering race that would
    /// leave a permanent Mock in charge.
    pub struct DelegatingProvider {
        fallback: MockFlashlightProvider,
    }

    impl DelegatingProvider {
        /// Build a delegating provider that seeds its fallback Mock with `seed`.
        pub fn new(seed: FlashlightState) -> Self {
            Self {
                fallback: MockFlashlightProvider::new(seed),
            }
        }

        fn real(&self) -> Option<Arc<dyn FlashlightProvider>> {
            DEVICE.get().cloned()
        }
    }

    #[async_trait::async_trait]
    impl FlashlightProvider for DelegatingProvider {
        async fn snapshot(&self) -> amos_flashlight::Result<FlashlightState> {
            match self.real() {
                Some(p) => p.snapshot().await,
                None => self.fallback.snapshot().await,
            }
        }

        async fn set_on(&self, on: bool) -> amos_flashlight::Result<()> {
            match self.real() {
                Some(p) => p.set_on(on).await,
                None => self.fallback.set_on(on).await,
            }
        }

        fn note_external_state(&self, on: bool) {
            match self.real() {
                Some(p) => p.note_external_state(on),
                None => self.fallback.note_external_state(on),
            }
        }
    }

    /// On-device only: hand the seam an `AppHandle` for live UI pushes. Called
    /// once from `lib.rs::setup` (android feature); a second call keeps the first.
    pub fn install_ui_pusher(app: AppHandle) {
        let _ = PUSHER.set(app);
    }

    /// Write the current torch value through the shared store — this persists it
    /// *and* broadcasts `store-updated`, so every window's
    /// `useStoreValue(FLASHLIGHT_KEY)` (the status-bar torch glyph, an open
    /// control-center tile) updates live, no polling. No-op before the pusher is
    /// installed (desktop / boot ordering) — nothing is faked.
    fn push_state_to_ui(on: bool) {
        let Some(app) = PUSHER.get() else {
            return;
        };
        let map = serde_json::json!({
            "on": on,
            "torch_present": TORCH_PRESENT.load(Ordering::Relaxed),
        });
        let Ok(text) = serde_json::to_string(&map) else {
            return;
        };
        // `SharedStore` is managed app state: write + broadcast to all windows.
        let store = app.state::<SharedStore>();
        store.set(app, FLASHLIGHT_KEY, text);
    }

    /// `FlashlightGlue.attach(context, cameraId, hasFlash)` — JNI
    /// `(Landroid/content/Context;Ljava/lang/String;Z)V`.
    ///
    /// # Safety
    /// `env`/`this` are the standard JNI instance-method arguments; `context` is
    /// a live `android.content.Context` and `camera_id` a live `java.lang.String`
    /// local ref, both valid for the duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_FlashlightGlue_attach(
        env: *mut jni::sys::JNIEnv,
        _this: jobject,
        context: jobject,
        camera_id: jstring,
        has_flash: jboolean,
    ) {
        if env.is_null() || context.is_null() || camera_id.is_null() {
            return; // nothing valid yet → honest no-op, the Mock stays active
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
            return;
        };
        let Ok(vm) = env.get_java_vm() else {
            return;
        };
        // SAFETY: `context` is a live local ref for the duration of this call.
        let ctx = unsafe { JObject::from_raw(context) };
        // SAFETY: `camera_id` is a live local ref; read it into an owned String.
        let camera: String = {
            let s = unsafe { jni::objects::JString::from_raw(camera_id) };
            let Ok(text) = env.get_string(&s) else {
                return;
            };
            text.into()
        };
        // Install the provider with the *true* hardware picture: a torch-less
        // device (empty camera id / has_flash=false) reports torch_present=false
        // so the UI disables the tile instead of silently falling back to the
        // desktop Mock, which would claim a torch that does not exist.
        let torch_present = has_flash != 0;
        TORCH_PRESENT.store(torch_present, Ordering::Relaxed);
        if let Ok(provider) =
            amos_flashlight::AndroidFlashlightProvider::new(vm, &env, ctx, camera, torch_present)
        {
            // Exactly-once; a redundant re-attach simply keeps the first provider.
            let _ = DEVICE.set(Arc::new(provider));
        }
    }

    /// Route an OS-driven torch state change to the installed real provider
    /// (no-op when none is installed — the Mock has no OS) and live-push it to
    /// the System UI through the shared store (`store-updated`).
    pub fn note_torch(on: bool) {
        if let Some(provider) = DEVICE.get() {
            provider.note_external_state(on);
        }
        // Live push: the status bar (always visible) and any open control-center
        // tile reflect an OS-driven change immediately, not on next open/poll.
        push_state_to_ui(on);
    }

    /// `FlashlightGlue.onTorchChanged(enabled)` — JNI `(Z)V`. Fired by the
    /// Kotlin `CameraManager.TorchCallback` when the OS changes the torch
    /// (another app toggled, thermal shutdown, capture, …) so `snapshot()`
    /// stays truthful even though the change didn't come from our `set_on`.
    ///
    /// # Safety
    /// `env`/`this` are the standard JNI instance-method arguments and must be
    /// valid for the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_FlashlightGlue_onTorchChanged(
        _env: *mut jni::sys::JNIEnv,
        _this: jobject,
        enabled: jboolean,
    ) {
        note_torch(enabled != 0);
    }
}

/// Parse the persisted torch state out of the durable `amos.flashlight` JSON so
/// the Mock starts where the last session left it. Unknown/corrupt input → the
/// desktop demo default (a torch present but off), so the tile works offline.
pub fn seed_from_settings(settings_json: Option<&str>) -> FlashlightState {
    let mut s = FlashlightState::off_with_torch();
    if let Some(raw) = settings_json {
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(raw) {
            if let Some(b) = obj.get("on").and_then(Value::as_bool) {
                s.on = b;
            }
            if let Some(b) = obj.get("torch_present").and_then(Value::as_bool) {
                s.torch_present = b;
            }
        }
    }
    s
}

/// Mirror the authoritative snapshot back into the `amos.flashlight` store.
/// Uses `SharedStore::set` so the `store-updated` broadcast keeps every window
/// in sync (matching how the frontend's plain quick-toggles already write).
fn persist_flashlight(app: &AppHandle, store: &SharedStore, snap: FlashlightState) {
    let mut map: Map<String, Value> = match store
        .get(FLASHLIGHT_KEY)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
    {
        Some(m) => m,
        None => Map::new(),
    };
    map.insert("on".to_string(), Value::Bool(snap.on));
    map.insert("torch_present".to_string(), Value::Bool(snap.torch_present));
    if let Ok(text) = serde_json::to_string(&Value::Object(map)) {
        store.set(app, FLASHLIGHT_KEY, text);
    }
}

/// Read the current flashlight state.
#[tauri::command]
pub async fn flashlight_status(
    bridge: State<'_, FlashlightBridge>,
) -> Result<FlashlightPayload, String> {
    let snap = bridge.manager.snapshot().await.map_err(|e| e.to_string())?;
    Ok(snap.into())
}

/// Set the torch on/off, enforcing the hardware-presence guard in the domain
/// core, and return the authoritative snapshot.
#[tauri::command]
pub async fn flashlight_set(
    app: AppHandle,
    bridge: State<'_, FlashlightBridge>,
    store: State<'_, SharedStore>,
    enabled: bool,
) -> Result<FlashlightPayload, String> {
    let snap = bridge
        .manager
        .set_on(enabled)
        .await
        .map_err(|e| e.to_string())?;
    persist_flashlight(&app, &store, snap);
    Ok(snap.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_parses_known_torch_bits_only() {
        let s = seed_from_settings(Some(r#"{"on":true,"torch_present":true,"extra":1}"#));
        assert!(s.on);
        assert!(s.torch_present);

        let s = seed_from_settings(Some(r#"{"on":false,"torch_present":false}"#));
        assert!(!s.on);
        assert!(!s.torch_present);
    }

    #[test]
    fn seed_defaults_to_a_present_but_dark_torch_on_absent_or_corrupt() {
        // Desktop demo default: a torch exists (so the tile works) but is off.
        let d = seed_from_settings(None);
        assert!(!d.on);
        assert!(d.torch_present);

        assert_eq!(seed_from_settings(Some("not json")), d);
        assert_eq!(seed_from_settings(Some("[1,2,3]")), d);
    }

    #[test]
    fn payload_round_trips_from_snapshot() {
        let p = FlashlightPayload::from(FlashlightState::on_with_torch());
        assert!(p.on);
        assert!(p.available);

        let p = FlashlightPayload::from(FlashlightState::no_torch());
        assert!(!p.on);
        assert!(!p.available);
    }

    #[tokio::test]
    async fn boot_bridge_uses_the_seeded_mock_without_a_device_provider() {
        // Desktop / CI (and on-device before the Kotlin glue attach lands) boot
        // must always yield a working bridge — the seeded Mock — never panic.
        let seed = FlashlightState::off_with_torch();
        let bridge = boot_bridge(seed);
        let snap = bridge.manager.snapshot().await.unwrap();
        assert!(!snap.on);
        assert!(
            snap.torch_present,
            "desktop demo seed has a torch but is off"
        );
    }
}
