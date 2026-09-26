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
use serde_json::Value;
use tauri::{AppHandle, State};

/// Durable store key that persists the torch state for restart + cross-window
/// sync (distinct from the `amos.settings` preference quick-toggles).
pub const FLASHLIGHT_KEY: &str = "amos.flashlight";

/// The other user of AmOS's rear camera: the live NV21 preview `AmosGlue.onStart`
/// opens at *every* foreground (`CameraGlue.attach`). The torch is the same camera
/// device's flash unit, and Android grants only one client at a time — with the
/// preview holding it, `CameraManager#setTorchMode` is refused ("torch mode of
/// camera 0 is not available because camera is in use"), so a torch request has to
/// take the sensor from AmOS's own preview and give it back (REQ-A1891 /
/// FMEA F-AND-021).
///
/// Best-effort by contract: the caller must not treat a failure here as fatal, and
/// the authoritative verdict stays the torch call's own answer.
pub trait PreviewYield: Send + Sync {
    /// Release the preview's hold on the camera device, if it has one.
    ///
    /// `Ok(true)` means a hold **was** taken and [`resume`](Self::resume) owes the
    /// sensor back; `Ok(false)` means the preview was not the holder. The caller
    /// needs that distinction to decide whether a torch refusal is even eligible
    /// for a retry (see [`torch_yielding_the_preview`]).
    fn suspend(&self) -> Result<bool, String>;
    /// Give the sensor back, if [`suspend`](Self::suspend) took it. Idempotent.
    fn resume(&self) -> Result<(), String>;
}

/// How many times a torch request is re-issued after the preview gave up the
/// sensor, and the pause between attempts.
///
/// `CameraGlue.teardown()` publishes the release **asynchronously**: it clears its
/// own `camera` field (so `isCapturing()` reads `false` at once) and then posts
/// `camera.close()` onto its `amos-camera` handler thread. Between those two
/// moments the platform still counts AmOS as the holder — device log (S5, Android
/// 14): `AmosGlue: camera attached: id=0 640x480` at `.411`, and five milliseconds
/// later `E CameraService: setTorchMode: torch mode of camera 0 is not available
/// because camera is in use`. There is no accessor for "the device is really
/// free", so the only honest observation of it is the platform's own answer to the
/// torch request: re-ask, bounded, and report the last word (REQ-A1891 /
/// FMEA F-AND-021).
///
/// The budget is measured, not guessed — and measured twice, because the release
/// is not a fixed latency. On the S5 with the preview holding camera 0
/// (2026-09-26, logcat 12:47:10): refused at `.559`, teardown begins `.560`,
/// `CameraProviderManager: torch status is now AVAILABLE_OFF` at `.697`, and
/// `CameraService: disconnect: Disconnected client for camera 0` at `.701` — the
/// device freed the torch in **~140 ms**. A later boot measured the same hand-over
/// at **~266 ms** (18:08:17: refused `.070`, retries every ~28 ms, `AVAILABLE_OFF`
/// `.320`, `disconnect: Disconnected client for camera 0` `.336`), where the earlier
/// `8 × 25 ms ≈ 200 ms` budget expired ~41 ms **before** the platform let go and the
/// torch was refused for good; the immediately following run on the now-warm stack
/// released in **~195 ms** and lit on the sixth ask. So the worst case is what the
/// budget must beat, and a `8 × 25 ms` budget sitting on top of a 195–266 ms spread
/// is a coin flip. `16 × 25 ms ≈ 400 ms` covers ~1.5× the worst observed release.
/// The attempts are spaced, so the wait is a bounded blocking sleep on a worker
/// thread, not a busy loop, and only a request that actually took the sensor pays it.
const YIELD_SETTLE_TRIES: u32 = 16;
/// The pause between those attempts. Gated with the device seam: the host compiles
/// the sequence (and its tests pass a recording no-op `settle`), but only the
/// Android provider actually sleeps, so an ungated constant is dead code there.
#[cfg(feature = "android")]
const YIELD_SETTLE_STEP: std::time::Duration = std::time::Duration::from_millis(25);

/// Run one torch request with the preview stepped out of the sensor's way.
///
/// The ordering is the whole content: `suspend` **before** the torch is asked for
/// (asking first is the defect — the platform then refuses for a reason the user
/// cannot act on), and `resume` afterwards unless the torch is actually holding the
/// sensor. A torch left lit keeps it; an extinguished or refused request frees it.
///
/// A refusal that follows a real hand-over is provisional, not final: the platform
/// may still be unwinding the preview's release (see [`YIELD_SETTLE_TRIES`]), so the
/// request is re-asked a bounded number of times (pausing via `settle`) and the
/// **last** answer is returned. A refusal with nothing yielded is final on the first
/// try — a torch turned down by thermal shutdown or a dead battery is not going to
/// change because we waited.
///
/// `suspend`/`resume` failures are dropped rather than propagated: when the preview
/// is not the holder (it was refused at boot, or the camera app owns the sensor)
/// there is nothing to take, and blaming the preview for a torch that was refused
/// for its own reason (thermal, low battery, no flash unit) would replace the
/// platform's real answer with a wrong one. Dropped is not silent: a failure from
/// either is logged here, so a release that never took effect is visible as *the
/// preview could not be stepped out*, not only as the platform's "camera is in use"
/// — which names the symptom, never the cause.
///
/// The error type belongs to the caller: a real provider's `FlashlightError` is
/// returned unchanged. Re-wrapping it in a second `FlashlightError::Provider` here
/// printed its prefix twice ("flashlight provider failure: flashlight provider
/// failure: …"), so the UI carried the wrapper's wording instead of the cause.
pub fn torch_yielding_the_preview<Y, D, W, E>(
    preview: &Y,
    on: bool,
    mut drive: D,
    mut settle: W,
) -> Result<(), E>
where
    Y: PreviewYield,
    D: FnMut(bool) -> Result<(), E>,
    W: FnMut(),
{
    let yielded = if on {
        match preview.suspend() {
            Ok(took) => took,
            Err(e) => {
                tracing::warn!(
                    "the preview could not be stepped out before the torch request: {e}"
                );
                false
            }
        }
    } else {
        false
    };
    let mut verdict = drive(on);
    if yielded {
        for _ in 0..YIELD_SETTLE_TRIES {
            if verdict.is_ok() {
                break;
            }
            settle();
            verdict = drive(on);
        }
    }
    // Give the sensor back when the torch lost it (an extinguished torch frees it
    // unconditionally) or when we took it and the torch did not keep it. A refusal
    // with nothing yielded leaves the preview exactly where it was, so `resume` is
    // not owed — and not called, which keeps the recorded order honest.
    if !on || (yielded && verdict.is_err()) {
        if let Err(e) = preview.resume() {
            tracing::warn!("the preview could not be resumed after the torch request: {e}");
        }
    }
    verdict
}

/// Upper bound on the persisted `amos.flashlight` JSON value (bytes).
///
/// Real values are two booleans (~32 B); 4 KiB is generous defence-in-depth —
/// `store::MAX_STORE_VALUE_BYTES` is 256 KiB and reserved for screenshots in
/// notification previews; this torch key would never legitimately carry that
/// much, so a megabyte-class payload is refused before the merge step (the
/// earlier path silently kept the old `on`/`torch_present` in place and
/// *appended* new keys to the corrupt value, turning a poisoned write into a
/// poisoned read on the next boot).
pub const MAX_FLASHLIGHT_VALUE_BYTES: usize = 4 * 1024;

/// Wire vocabulary for the flashlight / torch module. The UI i18n layer
/// branches on these; renaming a variant is a wire break.
pub mod codes {
    use crate::error::ErrorCode;
    /// The stored `amos.flashlight` value is neither missing nor a JSON object;
    /// the next write replaces it from scratch (the corruption is logged
    /// **before** the overwrite, so a forensic read of the log shows what was
    /// lost).
    pub const STORED_SHAPE_INVALID: &str = ErrorCode::FlashlightStoredShapeInvalid.as_str();
    /// Torch request reached the provider, but the device did not confirm the
    /// change (Android: `setTorchMode` returned false / silent failure).
    pub const PROVIDER_UNCONFIRMED: &str = ErrorCode::FlashlightProviderUnconfirmed.as_str();
}

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

    /// `CameraGlue.attach`'s own defaults, i.e. the preview the boot path opens
    /// (`AmosGlue.onStart` → `CameraGlue.attach(applicationContext)`).
    const PREVIEW_CAMERA: i32 = 0;
    const PREVIEW_W: i32 = 640;
    const PREVIEW_H: i32 = 480;

    /// The Kotlin `object CameraGlue` — a singleton, so the JVM method is an
    /// *instance* method reached through the static `INSTANCE` field.
    const CAMERA_GLUE_CLASS: &str = "com.amos.ai.glue.CameraGlue";
    const CAMERA_GLUE_INSTANCE: &str = "Lcom/amos/ai/glue/CameraGlue;";

    /// AmOS's own rear-camera preview, as the torch path sees it.
    struct CameraGluePreview {
        /// Set only when *we* took the sensor, so a `resume` for a preview we never
        /// suspended — the common case, where nothing was holding the camera — cannot
        /// start a preview the user did not have.
        suspended: AtomicBool,
    }

    impl CameraGluePreview {
        fn new() -> Self {
            Self {
                suspended: AtomicBool::new(false),
            }
        }
    }

    /// `CameraGlue.INSTANCE`, resolved through the **app's** loader either way.
    ///
    /// `find_class`/`call_static_method(<&str>)` use the *calling thread's* loader,
    /// which on a tokio worker (every `async` Tauri command) is the bootstrap one and
    /// cannot see `com.amos.ai.glue.*` — the `ClassNotFoundException` measured as
    /// REQ-A1866. [`crate::ble::android_jni::glue_class`] goes through the Context.
    fn camera_glue_instance<'local>(
        env: &mut jni::JNIEnv<'local>,
        ctx: &jni::objects::GlobalRef,
    ) -> Result<jni::objects::JObject<'local>, String> {
        let class = crate::ble::android_jni::glue_class(env, ctx, CAMERA_GLUE_CLASS)?;
        let class: &jni::objects::JClass<'_> = class.as_obj().into();
        amos_jni::jni_call!(
            env,
            env.get_static_field(class, "INSTANCE", CAMERA_GLUE_INSTANCE)
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())
    }

    impl PreviewYield for CameraGluePreview {
        fn suspend(&self) -> Result<bool, String> {
            // Ask first, take second: a preview that is not capturing must not be
            // "resumed" later, or turning the torch off would *start* a camera the
            // user never had open.
            let took = crate::ble::android_jni::with_context_result(|ctx, env| {
                let glue = camera_glue_instance(env, ctx)?;
                let capturing =
                    amos_jni::jni_call!(env, env.call_method(&glue, "isCapturing", "()Z", &[]))
                        .map_err(|e| e.to_string())?
                        .z()
                        .map_err(|e| e.to_string())?;
                if !capturing {
                    return Ok(false);
                }
                amos_jni::jni_call!(env, env.call_method(&glue, "detach", "()V", &[]))
                    .map_err(|e| e.to_string())?;
                Ok(true)
            })?;
            if took {
                self.suspended.store(true, Ordering::Relaxed);
            }
            Ok(took)
        }

        fn resume(&self) -> Result<(), String> {
            if !self.suspended.swap(false, Ordering::Relaxed) {
                return Ok(()); // we never took the sensor — nothing to give back
            }
            crate::ble::android_jni::with_context_result(|ctx, env| {
                let glue = camera_glue_instance(env, ctx)?;
                // The JVM signature carries all four parameters: `CameraGlue.attach`
                // has Kotlin defaults but no `@JvmOverloads`, so only the full method
                // exists on the class.
                amos_jni::jni_call!(
                    env,
                    env.call_method(
                        &glue,
                        "attach",
                        "(Landroid/content/Context;III)V",
                        &[
                            jni::objects::JValue::Object(ctx.as_obj()),
                            jni::objects::JValue::Int(PREVIEW_CAMERA),
                            jni::objects::JValue::Int(PREVIEW_W),
                            jni::objects::JValue::Int(PREVIEW_H),
                        ],
                    )
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
        }
    }

    /// The provider installed on device: the real
    /// [`amos_flashlight::AndroidFlashlightProvider`] with AmOS's own preview stepped
    /// out of the sensor's way for each request. See [`torch_yielding_the_preview`].
    struct YieldingProvider {
        /// Behind an `Arc` because a request runs on a `spawn_blocking` worker, which
        /// needs an owned handle rather than a borrow of `self`.
        inner: Arc<amos_flashlight::AndroidFlashlightProvider>,
        preview: Arc<CameraGluePreview>,
    }

    #[async_trait::async_trait]
    impl FlashlightProvider for YieldingProvider {
        async fn snapshot(&self) -> amos_flashlight::Result<FlashlightState> {
            self.inner.snapshot().await
        }

        async fn set_on(&self, on: bool) -> amos_flashlight::Result<()> {
            // The yield is genuinely blocking work: `set_on_blocking` is a synchronous
            // JNI `setTorchMode`, and the pause between retries is a `std::thread::sleep`.
            // Run straight on the runtime it would hold a tokio worker for the whole
            // settle window (`YIELD_SETTLE_TRIES` × `YIELD_SETTLE_STEP`), queueing
            // unrelated requests behind a torch toggle — so the pair is handed to
            // `spawn_blocking`, whose closure the `blocking-in-async-scan` gate requires
            // this call to sit inside.
            let inner = Arc::clone(&self.inner);
            let preview = Arc::clone(&self.preview);
            tokio::task::spawn_blocking(move || {
                torch_yielding_the_preview(
                    preview.as_ref(),
                    on,
                    |on| inner.set_on_blocking(on),
                    || std::thread::sleep(YIELD_SETTLE_STEP),
                )
            })
            .await
            .map_err(|e| {
                amos_flashlight::FlashlightError::Provider(format!(
                    "the torch request could not be joined: {e}"
                ))
            })?
        }

        fn note_external_state(&self, on: bool) {
            self.inner.note_external_state(on);
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
            // Exactly-once; a redundant re-attach simply keeps the first provider. Safe because
            // the Activity is not recreated under us — the generated manifest's `configChanges`
            // is what makes that true, and `scripts/android-glue-mirror.sh` gates it (REQ-A448).
            //
            // Wrapped, not bare: `AmosGlue.onStart` opens the same camera as a live preview at
            // every foreground, and Android refuses `setTorchMode` while any client owns the
            // device — so a bare provider reports "camera in use" for a camera AmOS itself is
            // holding. `YieldingProvider` releases that preview around each request.
            let _ = DEVICE.set(Arc::new(YieldingProvider {
                inner: Arc::new(provider),
                preview: Arc::new(CameraGluePreview::new()),
            }));
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
///
/// A stored value larger than [`MAX_FLASHLIGHT_VALUE_BYTES`] is refused — the
/// write path cannot keep a megabyte JSON object healthy, and the cost of
/// silently accepting it (boot-time parse failure, slow `set` per keystroke)
/// outweighs the cost of logging the refusal and falling back to a clean
/// write.
fn persist_flashlight(app: &AppHandle, store: &SharedStore, snap: FlashlightState) {
    // `FlashlightPayload` is two `bool`s — serialisation is total. A failure
    // here would mean the serde data model itself broke, which is a programmer
    // bug, not a runtime one; log and bail (the previous snapshot is still in
    // the store, so the next press will simply retry).
    let raw = match serde_json::to_string(&FlashlightPayload::from(snap)) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(
                target: "amos::flashlight",
                error = %e,
                code = codes::STORED_SHAPE_INVALID,
                "FlashlightPayload failed to serialise — torch state NOT mirrored to the store"
            );
            return;
        }
    };
    if raw.len() > MAX_FLASHLIGHT_VALUE_BYTES {
        tracing::warn!(
            target: "amos::flashlight",
            key = FLASHLIGHT_KEY,
            bytes = raw.len(),
            limit = MAX_FLASHLIGHT_VALUE_BYTES,
            code = codes::STORED_SHAPE_INVALID,
            "refusing to persist an oversized torch value — staying with the previous snapshot"
        );
        return;
    }
    let (mut map, unusable) = crate::store::object_for_merge(store, FLASHLIGHT_KEY);
    if unusable {
        // The stored value is not a JSON object, so nothing in it can be preserved: the write
        // below replaces it. Saying so is the difference between "rewritten" and "lost".
        tracing::warn!(
            target: "amos::flashlight",
            key = FLASHLIGHT_KEY,
            code = codes::STORED_SHAPE_INVALID,
            "stored flashlight state is not a JSON object — rewriting it from scratch"
        );
    }
    map.insert("on".to_string(), Value::Bool(snap.on));
    map.insert("torch_present".to_string(), Value::Bool(snap.torch_present));
    let text = match serde_json::to_string(&Value::Object(map)) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(
                target: "amos::flashlight",
                error = %e,
                code = codes::STORED_SHAPE_INVALID,
                "merged flashlight JSON failed to serialise — torch state NOT mirrored"
            );
            return;
        }
    };
    if text.len() > MAX_FLASHLIGHT_VALUE_BYTES {
        // The merge step can grow the value past the cap (e.g. the stored
        // shape was *valid* JSON but loaded with extra keys we never asked
        // for). Refuse rather than silently push the limit.
        tracing::warn!(
            target: "amos::flashlight",
            key = FLASHLIGHT_KEY,
            bytes = text.len(),
            limit = MAX_FLASHLIGHT_VALUE_BYTES,
            code = codes::STORED_SHAPE_INVALID,
            "merged torch value exceeds the size cap — keeping the previous shape"
        );
        return;
    }
    store.set(app, FLASHLIGHT_KEY, text);
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
    let (snap, confirmed) = bridge
        .manager
        .set_on_checked(enabled)
        .await
        .map_err(|e| e.to_string())?;
    if !confirmed {
        // The provider accepted the write but the resulting authoritative state
        // disagrees with the request (a silent failure: an OS TorchCallback raced
        // us, a driver dropped the write, or a fallback backend served a request
        // the real hardware never saw). This is exactly what the declared
        // `provider_unconfirmed` wire code names — emit it so the signal has a
        // producing path instead of being a dead constant.
        tracing::warn!(
            target: "amos::flashlight",
            code = codes::PROVIDER_UNCONFIRMED,
            requested = enabled,
            actual = snap.on,
            "torch request reached the provider but the device did not confirm the change"
        );
    }
    persist_flashlight(&app, &store, snap);
    Ok(snap.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a recorded preview answers: `Took` (= `Ok(true)`, the sensor is now
    /// ours to give back), `Idle` (= `Ok(false)`, we were never the holder) or
    /// `Unreachable`.
    #[derive(Clone, Copy, PartialEq)]
    enum PreviewAnswer {
        Took,
        Idle,
        Unreachable,
    }

    /// A [`PreviewYield`] that records the order of its calls, so the two things the
    /// torch path must get right — *when* the sensor changes hands, and *whether* a
    /// refusal is worth re-asking — are pinned without a device.
    struct RecordingPreview {
        log: std::sync::Mutex<Vec<&'static str>>,
        answer: PreviewAnswer,
    }

    impl RecordingPreview {
        fn new(answer: PreviewAnswer) -> Self {
            Self {
                log: std::sync::Mutex::new(Vec::new()),
                answer,
            }
        }

        fn log(&self) -> Vec<&'static str> {
            self.log.lock().unwrap().clone()
        }

        fn count(&self, what: &str) -> usize {
            self.log().into_iter().filter(|s| *s == what).count()
        }
    }

    impl PreviewYield for RecordingPreview {
        fn suspend(&self) -> Result<bool, String> {
            self.log.lock().unwrap().push("suspend");
            match self.answer {
                PreviewAnswer::Took => Ok(true),
                PreviewAnswer::Idle => Ok(false),
                PreviewAnswer::Unreachable => {
                    Err("CameraGlue is not on the app's class loader".to_string())
                }
            }
        }

        fn resume(&self) -> Result<(), String> {
            self.log.lock().unwrap().push("resume");
            Ok(())
        }
    }

    /// A torch call that records itself and refuses the first `refusals` attempts,
    /// lighting on the next one. `usize::MAX` refuses for the whole run.
    fn torch_call<'a>(
        log: &'a std::sync::Mutex<Vec<&'static str>>,
        refusals: usize,
    ) -> impl FnMut(bool) -> Result<(), String> + 'a {
        let mut left = refusals;
        move |_on| {
            log.lock().unwrap().push("torch");
            if left > 0 {
                left -= 1;
                Err("camera is in use".to_string())
            } else {
                Ok(())
            }
        }
    }

    /// A pause that records itself, so the retry count is observable.
    fn settle<'a>(log: &'a std::sync::Mutex<Vec<&'static str>>) -> impl FnMut() + 'a {
        move || log.lock().unwrap().push("settle")
    }

    #[test]
    fn a_torch_request_releases_the_preview_before_it_is_asked() {
        // The ordering is the fix: asking the torch first is what the platform
        // refuses ("camera is in use"), for a reason the user cannot act on.
        // REQ-A1891 / F-AND-021.
        let preview = RecordingPreview::new(PreviewAnswer::Took);
        let out = torch_yielding_the_preview(
            &preview,
            true,
            torch_call(&preview.log, 0),
            settle(&preview.log),
        );
        assert!(out.is_ok());
        assert_eq!(preview.log(), vec!["suspend", "torch"]);
    }

    #[test]
    fn a_lit_torch_keeps_the_sensor_from_the_preview() {
        // Resuming here would hand the camera back to the preview and put the torch
        // out — the two users cannot both hold it, and the torch is the one the user
        // just asked for.
        let preview = RecordingPreview::new(PreviewAnswer::Took);
        let out = torch_yielding_the_preview(
            &preview,
            true,
            torch_call(&preview.log, 0),
            settle(&preview.log),
        );
        assert!(out.is_ok());
        assert!(!preview.log().contains(&"resume"));
    }

    #[test]
    fn a_torch_refused_after_the_hand_over_is_re_asked_until_it_lights() {
        // The preview's release is asynchronous (`CameraGlue.teardown` posts
        // `camera.close()` to its own thread and returns), so the platform can refuse
        // a request that is already valid. The device log shows exactly this: the
        // preview attached at `.411` and `setTorchMode` was refused at `.416`. The
        // refusal after a real hand-over is therefore re-asked — here twice — and the
        // torch ends up lit, with the sensor kept.
        let preview = RecordingPreview::new(PreviewAnswer::Took);
        let out = torch_yielding_the_preview(
            &preview,
            true,
            torch_call(&preview.log, 2),
            settle(&preview.log),
        );
        assert!(out.is_ok());
        assert_eq!(
            preview.log(),
            vec!["suspend", "torch", "settle", "torch", "settle", "torch"]
        );
        assert_eq!(preview.count("settle"), 2);
        assert!(!preview.log().contains(&"resume"));
    }

    #[test]
    fn a_torch_refused_without_the_preview_holding_it_is_asked_once() {
        // The other half of the rule: the preview was *not* the holder, so the
        // platform's refusal is final — thermal shutdown, a dead battery or a device
        // with no flash unit is not going to change because we waited. No pauses, one
        // ask.
        let preview = RecordingPreview::new(PreviewAnswer::Idle);
        let out = torch_yielding_the_preview(
            &preview,
            true,
            torch_call(&preview.log, usize::MAX),
            settle(&preview.log),
        );
        assert_eq!(out.unwrap_err(), "camera is in use");
        assert_eq!(preview.log(), vec!["suspend", "torch"]);
        assert_eq!(preview.count("settle"), 0);
    }

    #[test]
    fn a_refused_torch_gives_the_preview_its_sensor_back() {
        // The torch never lit, so nothing is holding the camera: leaving the preview
        // suspended would cost the user the preview *and* the light. The retries are
        // bounded, so the worst case is a bounded wait, not a hang.
        let preview = RecordingPreview::new(PreviewAnswer::Took);
        let out = torch_yielding_the_preview(
            &preview,
            true,
            torch_call(&preview.log, usize::MAX),
            settle(&preview.log),
        );
        assert_eq!(out.unwrap_err(), "camera is in use");
        assert_eq!(preview.count("torch"), 1 + YIELD_SETTLE_TRIES as usize);
        assert_eq!(preview.count("settle"), YIELD_SETTLE_TRIES as usize);
        assert_eq!(preview.log().first(), Some(&"suspend"));
        assert_eq!(preview.log().last(), Some(&"resume"));
    }

    #[test]
    fn extinguishing_the_torch_resumes_the_preview_without_suspending_it() {
        // The mirror of the arm above, on the ordinary path: the torch was never
        // holding the sensor, so there is nothing to take — only to give back.
        let preview = RecordingPreview::new(PreviewAnswer::Took);
        let out = torch_yielding_the_preview(
            &preview,
            false,
            torch_call(&preview.log, 0),
            settle(&preview.log),
        );
        assert!(out.is_ok());
        assert_eq!(preview.log(), vec!["torch", "resume"]);
    }

    #[test]
    fn an_unreachable_preview_does_not_veto_the_torch() {
        // Best-effort by contract: when the preview is not the holder (refused at
        // boot, or another app owns the sensor) there is nothing to release, and the
        // torch's own verdict must still be what the user sees.
        let preview = RecordingPreview::new(PreviewAnswer::Unreachable);
        let out = torch_yielding_the_preview(
            &preview,
            true,
            torch_call(&preview.log, 0),
            settle(&preview.log),
        );
        assert!(out.is_ok());
        assert_eq!(preview.log(), vec!["suspend", "torch"]);
    }

    #[test]
    fn a_provider_error_reaches_the_caller_without_a_second_wrapper() {
        // The seam must hand the caller's *own* error back. The pre-fix `set_on`
        // stringified the provider's already-formatted error and re-wrapped it in a
        // second `Provider`, so the UI showed the prefix twice — measured on the S5
        // as `flashlight provider failure: flashlight provider failure: Java
        // exception was thrown` — naming the wrapper instead of the cause. The drive
        // here yields the real domain error, the same one `set_on` returns.
        let preview = RecordingPreview::new(PreviewAnswer::Took);
        let out: Result<(), amos_flashlight::FlashlightError> = torch_yielding_the_preview(
            &preview,
            true,
            |_on| {
                Err(amos_flashlight::FlashlightError::Provider(
                    "Java exception was thrown".to_string(),
                ))
            },
            settle(&preview.log),
        );
        let msg = out.unwrap_err().to_string();
        assert_eq!(
            msg,
            "flashlight provider failure: Java exception was thrown"
        );
        assert_eq!(
            msg.matches("flashlight provider failure").count(),
            1,
            "the seam must not wrap the caller's error a second time"
        );
    }

    #[test]
    fn the_torch_request_hands_its_blocking_work_to_a_worker() {
        // `set_on` is `async` but the work it drives is synchronous: a JNI
        // `setTorchMode`, plus a `std::thread::sleep` pause between retries. Run
        // inline it holds a tokio worker for the whole settle window
        // (`YIELD_SETTLE_TRIES` × `YIELD_SETTLE_STEP`) and queues unrelated requests
        // behind a torch toggle — the shape `blocking-in-async-scan` flags. The seam
        // is only load-bearing if the pause sits *inside* the closure handed to
        // `spawn_blocking`, so pin that in the provider's own body. REQ-A1907.
        let src = include_str!("flashlight.rs");
        let impl_body = src
            .split("impl FlashlightProvider for YieldingProvider")
            .nth(1)
            .expect("the device provider's impl");
        let set_on = impl_body
            .split("async fn set_on")
            .nth(1)
            .expect("the device provider's set_on");
        let offload = set_on
            .find("spawn_blocking(")
            .expect("the blocking work is handed to a worker");
        // Anchor on the *call*, not the bare path: the comment above the closure
        // spells `std::thread::sleep` too, and a bare `find` would pin the prose.
        let pause = set_on
            .find("std::thread::sleep(YIELD_SETTLE_STEP)")
            .expect("the settle pause is still there");
        assert!(
            offload < pause,
            "the settle pause must run inside the spawn_blocking closure, not on the runtime"
        );
    }

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

    #[test]
    fn flashlight_codes_are_stable_string_keys() {
        // The wire vocabulary is the i18n layer's contract; this pins it.
        assert_eq!(
            codes::STORED_SHAPE_INVALID,
            "amos.flashlight.stored_shape_invalid"
        );
        assert_eq!(
            codes::PROVIDER_UNCONFIRMED,
            "amos.flashlight.provider_unconfirmed"
        );
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn the_flashlight_size_cap_is_well_under_the_general_store_cap() {
        // Real values are ~32 B; the cap is small but generous, AND it is
        // deliberately much smaller than `store::MAX_STORE_VALUE_BYTES` (256
        // KiB) so an oversized payload is refused BEFORE it can pollute the
        // boot-time JSON parse. The tripwire is the test itself; the lint is
        // suppressed so the tripwire keeps its "if this is wrong the build
        // fails" shape.
        assert!(
            MAX_FLASHLIGHT_VALUE_BYTES <= 4096,
            "the torch key has no legitimate use for a 256 KiB value: got {MAX_FLASHLIGHT_VALUE_BYTES}"
        );
    }

    #[test]
    fn the_flashlight_payload_size_stays_well_below_the_cap() {
        // The serialised payload is a small known shape; if a future change
        // grows it past the cap, the `persist_flashlight` refusal path is the
        // only thing keeping the boot-time parse healthy. This is the tripwire.
        let payload = FlashlightPayload::from(FlashlightState::on_with_torch());
        let text = serde_json::to_string(&payload).unwrap();
        assert!(
            text.len() < MAX_FLASHLIGHT_VALUE_BYTES,
            "real payload {bytes} B is over the cap {cap} B",
            bytes = text.len(),
            cap = MAX_FLASHLIGHT_VALUE_BYTES
        );
    }
}
