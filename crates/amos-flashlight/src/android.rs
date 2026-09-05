//! Real Android backend for the flashlight (compile-gated `android`).
//!
//! On the no-UI Android base (`docs/no-ui-android.md`) the illumination torch is
//! the rear camera's flash unit, driven through the Android `CameraManager`
//! (`context.getSystemService("camera")`) — reachable only from a process holding
//! the app/Activity context, i.e. the **System UI APK** (Tauri core), which is
//! why this provider lives beside the System UI and not in the headless daemon
//! (same host decision as `amos-radio` / `amos-sensor`).
//!
//! Behaviour (honest, no faking):
//! * `set_on(true)`/`set_on(false)` issue the real `CameraManager#setTorchMode`
//!   (API 23+) call. A `CameraAccessException` (camera owned by another client,
//!   thermal, low battery) or `NoSuchMethodError` (device < API 23) surfaces as
//!   [`FlashlightError::Provider`] — we never pretend the light is on.
//! * `on` is the last **successful** `setTorchMode` request **plus** any state
//!   the OS pushed via [`FlashlightProvider::note_external_state`] (a
//!   `CameraManager.TorchCallback` upcall: another app toggled, thermal
//!   shutdown, capture, …). There is no public `CameraManager#getTorchMode`, so
//!   the mirror stays truthful by combining our requests with OS callbacks.
//! * `torch_present` is the hardware fact the System UI glue resolved from
//!   `CameraCharacteristics#FLASH_INFO_AVAILABLE` at bind time.
//!
//! Runtime requires a real Android VM (`jni::JavaVM`) plus a `GlobalRef` to the
//! app `Context`. Not runnable on the desktop host; `cargo check --features
//! android` keeps it compiling.

use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use jni::objects::{GlobalRef, JObject, JValue};
use jni::{JNIEnv, JavaVM};

use crate::error::{FlashlightError, Result};
use crate::provider::FlashlightProvider;
use crate::state::FlashlightState;

/// `Context.CAMERA_SERVICE` id used with `getSystemService`.
const CAMERA_SERVICE: &str = "camera";

/// `Send + Sync` handle to the Java `android.content.Context` (Application /
/// Activity) used to reach system services.
///
/// A JNI **global** reference is process-wide and safe to use from any thread as
/// long as each use attaches that thread to the VM first — `jni`'s `GlobalRef`
/// isn't auto-`Sync`, so we wrap it and assert the invariant explicitly.
struct AndroidContext(GlobalRef);

// SAFETY: A JNI global ref outlives the creating env and is VM-global. Every
// method on the provider re-attaches the calling thread before touching it, so
// sharing the handle across threads (to satisfy `FlashlightProvider: Send + Sync`)
// is sound as long as users never pass the raw jobject into a different env
// without attaching. Dropping is handled by `GlobalRef` (detach-on-drop).
unsafe impl Send for AndroidContext {}
// SAFETY: as above — access always happens on an attached thread.
unsafe impl Sync for AndroidContext {}

/// Feature-gated error mapper (keeps call sites terse; no unwraps).
fn jerr(e: jni::errors::Error) -> FlashlightError {
    FlashlightError::Provider(e.to_string())
}

/// Look up `context.getSystemService(name)` and hand back the service object.
fn system_service<'e>(env: &mut JNIEnv<'e>, ctx: &JObject<'e>, name: &str) -> Result<JObject<'e>> {
    let svc = env.new_string(name).map_err(jerr)?;
    let out = env
        .call_method(
            ctx,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&svc)],
        )
        .map_err(jerr)?;
    out.l().map_err(jerr)
}

/// A real Android provider that plugs into [`crate::FlashlightManager`] in place
/// of the [`crate::MockFlashlightProvider`] on device.
pub struct AndroidFlashlightProvider {
    vm: JavaVM,
    context: AndroidContext,
    /// Id of the rear camera whose flash unit is driven as the torch
    /// (e.g. `"0"`). Resolved by the System UI glue from `CameraCharacteristics
    /// #FLASH_INFO_AVAILABLE`.
    camera_id: String,
    /// AmOS-authored bits (skeleton, seeded at construction).
    /// `torch_present` mirrors whether the resolved camera actually has a flash
    /// unit; `on` mirrors the last *successful* `setTorchMode` request.
    torch_present: AtomicBool,
    on: AtomicBool,
}

impl AndroidFlashlightProvider {
    /// Construct from a `JavaVM` + a global ref to the app `Context`, plus the
    /// id of the rear camera that carries the torch flash. `env` is only used to
    /// create the global ref (it must be the creating/attached env).
    ///
    /// `torch_present` is the hardware fact the glue resolved (does `camera_id`
    /// have `FLASH_INFO_AVAILABLE` == true?). `on` is the initial AmOS mirror of
    /// torch state (start `false`).
    pub fn new(
        vm: JavaVM,
        env: &JNIEnv<'_>,
        context: JObject<'_>,
        camera_id: String,
        torch_present: bool,
    ) -> Result<Self> {
        let context = AndroidContext(env.new_global_ref(context).map_err(jerr)?);
        Ok(Self {
            vm,
            context,
            camera_id,
            torch_present: AtomicBool::new(torch_present),
            on: AtomicBool::new(false),
        })
    }

    /// Attach this thread to the VM (auto-detaches when the env drops). Matches
    /// `amos-radio`/`amos-telephony`: calls arrive on a bounded tokio worker
    /// pool, so the permanently-attached threads cannot grow unbounded.
    fn env(&self) -> Result<JNIEnv<'_>> {
        self.vm.attach_current_thread_permanently().map_err(jerr)
    }

    /// Drive `CameraManager#setTorchMode(cameraId, on)`. Throws (→ Provider
    /// error) when the camera is owned by another client, or the device is too
    /// hot / the battery too low.
    fn set_torch_mode(&self, env: &mut JNIEnv<'_>, on: bool) -> Result<()> {
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let camera = system_service(env, ctx, CAMERA_SERVICE)?;
        let camera_id = env.new_string(&self.camera_id).map_err(jerr)?;
        env.call_method(
            &camera,
            "setTorchMode",
            "(Ljava/lang/String;Z)V",
            &[JValue::Object(&camera_id), JValue::from(on)],
        )
        .map_err(jerr)?;
        Ok(())
    }
}

#[async_trait]
impl FlashlightProvider for AndroidFlashlightProvider {
    async fn snapshot(&self) -> Result<FlashlightState> {
        Ok(FlashlightState {
            on: self.on.load(Ordering::Relaxed),
            torch_present: self.torch_present.load(Ordering::Relaxed),
        })
    }

    async fn set_on(&self, on: bool) -> Result<()> {
        let mut env = self.env()?;
        self.set_torch_mode(&mut env, on)?;
        // Only reflect the state once the OS accepted the request, so the mirror
        // never lies about the light being on.
        self.on.store(on, Ordering::Relaxed);
        Ok(())
    }

    fn note_external_state(&self, on: bool) {
        // Reflect an OS-driven change (TorchCallback: thermal shutdown, another
        // app toggling, capture, …) into the mirror so `snapshot()` stays true
        // even though the change did not originate from our `set_on`.
        self.on.store(on, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    // No unit tests can run without a real Android VM. Tests for the torch
    // policy (hardware-presence guard) live in `manager.rs` (shared by all
    // providers).
}
