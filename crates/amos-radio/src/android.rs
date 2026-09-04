//! Real Android backend for the radios — **skeleton** (compile-gated `android`).
//!
//! On the no-UI Android base (`docs/no-ui-android.md`) Wi-Fi is owned by the
//! Android `WifiManager` (reachable via `Context#getSystemService("wifi")`) and
//! Bluetooth by `BluetoothManager` → `BluetoothAdapter`. Both are reachable only
//! from a process holding the app/Activity context — i.e. the **System UI APK**
//! (Tauri core), which is why this provider lives beside the System UI and not in
//! the headless daemon.
//!
//! This module is **deliberately a documented skeleton**, not yet the finished
//! on-device integration:
//! * It proves the build/plumbing (`android` feature + optional `jni` dep) and
//!   the real `Context` plumbing, and `cargo check --features android` keeps it
//!   compiling.
//! * Wi-Fi enable/state go through the (pre-API-29) `WifiManager#setWifiEnabled`
//!   / `isWifiEnabled`; Bluetooth through `BluetoothAdapter#enable/disable/
//!   isEnabled`. A device implementation should modernize Wi-Fi to the
//!   `ConnectivityManager` setWiFiEnabled path and gate Bluetooth behind the
//!   `BLUETOOTH_CONNECT` runtime permission.
//! * **Airplane** is modelled as an AmOS-authored bit (the manager turns the real
//!   Wi-Fi/Bluetooth off anyway); on device it should read/toggle the
//!   authoritative `Settings.Global.AIRPLANE_MODE_ON` via `ContentResolver`.
//!
//! Runtime requires a real Android VM (`jni::JavaVM`) plus a `GlobalRef` to the
//! app `Context`. Not runnable on the desktop host.

use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use jni::objects::{GlobalRef, JObject, JValue};
use jni::{JNIEnv, JavaVM};

use crate::error::{RadioError, Result};
use crate::provider::RadioProvider;
use crate::state::RadioSnapshot;

/// `Send + Sync` handle to the Java `android.content.Context` (Application /
/// Activity) used to reach system services.
///
/// A JNI **global** reference is process-wide and safe to use from any thread as
/// long as each use attaches that thread to the VM first — `jni`'s `GlobalRef`
/// isn't auto-`Sync`, so we wrap it and assert the invariant explicitly.
struct AndroidContext(GlobalRef);

// SAFETY: A JNI global ref outlives the creating env and is VM-global. Every
// method on the provider re-attaches the calling thread before touching it, so
// sharing the handle across threads (to satisfy `RadioProvider: Send + Sync`) is
// sound as long as users never pass the raw jobject into a different env without
// attaching. Dropping is handled by `GlobalRef` (detach-on-drop).
unsafe impl Send for AndroidContext {}
// SAFETY: as above — access always happens on an attached thread.
unsafe impl Sync for AndroidContext {}

/// Feature-gated error mapper (keeps call sites terse; no unwraps).
fn jerr(e: jni::errors::Error) -> RadioError {
    RadioError::Provider(e.to_string())
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

/// A real Android provider that plugs into [`crate::RadioManager`] in place of
/// the [`crate::MockRadioProvider`] on device.
pub struct AndroidRadioProvider {
    vm: JavaVM,
    context: AndroidContext,
    /// AmOS-authored airplane bit. Skeleton: on device read/toggle
    /// `Settings.Global.AIRPLANE_MODE_ON` via `ContentResolver`.
    airplane: AtomicBool,
}

impl AndroidRadioProvider {
    /// Construct from a `JavaVM` and a global ref to the app `Context`. `env` is
    /// only used to create the global ref (it must be the creating/attached env).
    pub fn new(
        vm: JavaVM,
        env: &JNIEnv<'_>,
        context: JObject<'_>,
        airplane_on: bool,
    ) -> Result<Self> {
        let context = AndroidContext(env.new_global_ref(context).map_err(jerr)?);
        Ok(Self {
            vm,
            context,
            airplane: AtomicBool::new(airplane_on),
        })
    }

    /// Attach this thread to the VM (auto-detaches when the env drops).
    fn env(&self) -> Result<JNIEnv<'_>> {
        self.vm.attach_current_thread_permanently().map_err(jerr)
    }

    /// Read the real Wi-Fi state via `WifiManager#isWifiEnabled`.
    fn wifi_enabled(&self, env: &mut JNIEnv<'_>) -> Result<bool> {
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = system_service(env, ctx, "wifi")?;
        env.call_method(&mgr, "isWifiEnabled", "()Z", &[])
            .and_then(|v| v.z())
            .map_err(jerr)
    }

    /// Read the real Bluetooth state via `BluetoothAdapter#isEnabled`.
    fn bluetooth_enabled(&self, env: &mut JNIEnv<'_>) -> Result<bool> {
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = system_service(env, ctx, "bluetooth")?;
        let adapter = env
            .call_method(
                &mgr,
                "getAdapter",
                "()Landroid/bluetooth/BluetoothAdapter;",
                &[],
            )
            .and_then(|v| v.l())
            .map_err(jerr)?;
        if adapter.is_null() {
            return Ok(false);
        }
        env.call_method(&adapter, "isEnabled", "()Z", &[])
            .and_then(|v| v.z())
            .map_err(jerr)
    }

    /// Ask `BluetoothAdapter#enable/disable`. Returns the boolean it reported.
    fn bluetooth_set(&self, env: &mut JNIEnv<'_>, on: bool) -> Result<()> {
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = system_service(env, ctx, "bluetooth")?;
        let adapter = env
            .call_method(
                &mgr,
                "getAdapter",
                "()Landroid/bluetooth/BluetoothAdapter;",
                &[],
            )
            .and_then(|v| v.l())
            .map_err(jerr)?;
        if adapter.is_null() {
            return Err(RadioError::Provider(
                "no Bluetooth adapter on this device".to_string(),
            ));
        }
        let method = if on { "enable" } else { "disable" };
        env.call_method(&adapter, method, "()Z", &[])
            .and_then(|v| v.z())
            .map_err(jerr)?;
        Ok(())
    }
}

#[async_trait]
impl RadioProvider for AndroidRadioProvider {
    async fn snapshot(&self) -> Result<RadioSnapshot> {
        let mut env = self.env()?;
        let wifi = self.wifi_enabled(&mut env)?;
        let bluetooth = self.bluetooth_enabled(&mut env)?;
        let airplane = self.airplane.load(Ordering::Relaxed);
        Ok(RadioSnapshot {
            wifi,
            bluetooth,
            airplane,
        })
    }

    async fn set_wifi(&self, on: bool) -> Result<()> {
        let mut env = self.env()?;
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = system_service(&mut env, ctx, "wifi")?;
        env.call_method(&mgr, "setWifiEnabled", "(Z)Z", &[JValue::from(on)])
            .and_then(|v| v.z())
            .map_err(jerr)?;
        Ok(())
    }

    async fn set_bluetooth(&self, on: bool) -> Result<()> {
        let mut env = self.env()?;
        self.bluetooth_set(&mut env, on)
    }

    async fn set_airplane(&self, on: bool) -> Result<()> {
        // Skeleton: AmOS-authored bit; the RadioManager turns the real Wi-Fi /
        // Bluetooth off as part of its Airplane cascade. TODO(on-device): also
        // write Settings.Global.AIRPLANE_MODE_ON via ContentResolver.
        self.airplane.store(on, Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    // No unit tests can run without a real Android VM. Tests for the airplane
    // policy live in `manager.rs` (shared by all providers).
}
