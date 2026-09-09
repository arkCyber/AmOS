//! **`RECORD_AUDIO` native-grant seam** for the always-on AAudio device mic.
//!
//! The JS reach path (`device_mic_start`, `DeviceMicButton`) opens the native mic
//! through `amos_audio::PlatformMic`, but a native AAudio capture needs the OS
//! **`RECORD_AUDIO`** runtime grant, which the repo currently only requests
//! bundled with `CAMERA` (the WebView `getUserMedia` path). This module adds a
//! **JS-awaitable, mic-only** request that does not go through `getUserMedia`:
//!
//! ```text
//! WebView  ─► mic_permission_request (async Tauri cmd)          mic_permission_state
//!               │  [not granted?]                                      │
//!               ▼                                                      ▼
//!          Rust: store a oneshot Sender ─► Kotlin MicPermissionGlue.request()
//!               │                          Kotlin posts
//!               │     ActivityCompat.requestPermissions(activity, [RECORD_AUDIO], REQ_MIC)
//!               ▼
//!   MainActivity.onRequestPermissionsResult ─► PermissionWire REQ_MIC ─► MicPermissionGlue.onResult(g)
//!               │                                        │  (Kotlin external)
//!               ▼                                        ▼
//!   Java_..._MicPermissionGlue_onResult(g)  ───► resolve the pending oneshot ──► command returns
//! ```
//!
//! Honesty rules (this module is compiled on **every** target, not just Android):
//!   * `native == false` on a host build or before the Kotlin `MicPermissionGlue`
//!     binds — the OS-grant concept does not exist there, so a UI never pretends a
//!     request happened.
//!   * `granted == false` when the user denied, the dialog never resolved, or no
//!     Android VM is present — never a fabricated "granted".
//!
//! The JNI half is compile-gated by the `android` feature and is only ever
//! exercised at device time against the Kotlin template in
//! `android-glue/com/amos/ai/glue/MicPermissionGlue.kt` (mirrors the
//! `clipboard_glue` bring-up pattern).

use serde::Serialize;

/// What the caller needs to know about the OS `RECORD_AUDIO` grant.
///
/// * `native` — true only when running inside the Android System UI with the
///   Kotlin `MicPermissionGlue` bound (i.e. the OS-grant concept exists here).
/// * `granted` — true only when `RECORD_AUDIO` is currently held.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct MicPermissionState {
    pub native: bool,
    pub granted: bool,
}

impl MicPermissionState {
    /// Host / not-yet-bound honest state: no native mic-grant concept.
    pub const fn none() -> Self {
        Self {
            native: false,
            granted: false,
        }
    }
}

#[cfg(feature = "android")]
mod jni {
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use jni::objects::{GlobalRef, JObject};
    use jni::sys::{jboolean, jobject};
    use jni::JavaVM;
    use tokio::sync::oneshot;

    use super::MicPermissionState;

    /// How long to wait for the OS `RECORD_AUDIO` dialog before reporting
    /// `granted: false` (the user may have let it time out or hit "don't ask").
    const GRANT_TIMEOUT: Duration = Duration::from_secs(30);

    /// Kotlin `MicPermissionGlue` bridge (a global ref, safe from any attached
    /// thread; each use re-attaches the thread).
    struct MicBridge {
        vm: JavaVM,
        glue: GlobalRef,
    }
    // SAFETY: a JNI global ref is VM-global and outlives the creating env; every
    // use re-attaches the calling thread before touching it.
    unsafe impl Send for MicBridge {}
    // SAFETY: as above — access always happens on an attached thread.
    unsafe impl Sync for MicBridge {}

    /// The one installed glue. `OnceLock` + redundant re-bind keeps the first.
    static GLUE: OnceLock<std::sync::Arc<MicBridge>> = OnceLock::new();

    /// A pending grant that a `mic_permission_request` is awaiting.
    static PENDING: Mutex<Option<oneshot::Sender<bool>>> = Mutex::new(None);

    fn jerr(e: jni::errors::Error) -> String {
        format!("mic_permission glue: {e}")
    }

    /// True when the Kotlin glue is bound (an Android System UI is live).
    fn bound() -> bool {
        GLUE.get().is_some()
    }

    /// Attach this thread to the VM (auto-detaches when the guard drops). Mirrors
    /// `incall`/`clipboard_glue`: Tauri command threads are short-lived, so a
    /// nested attach guard is preferred over a permanent attach here.
    fn with_env<T>(
        bridge: &MicBridge,
        f: impl FnOnce(&mut jni::JNIEnv<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut e = bridge.vm.attach_current_thread().map_err(jerr)?;
        f(&mut e)
    }

    /// `MicPermissionGlue.isGranted(): Boolean` through the stored bridge.
    fn is_granted() -> Result<bool, String> {
        let Some(bridge) = GLUE.get() else {
            return Ok(false);
        };
        with_env(bridge, |e| {
            let v = e
                .call_method(bridge.glue.as_obj(), "isGranted", "()Z", &[])
                .map_err(jerr)?;
            let granted = v.z().map_err(jerr)?;
            Ok(granted)
        })
    }

    /// Tell the Kotlin glue to post the OS `RECORD_AUDIO` request (returns
    /// immediately; the dialog resolves later via [`on_result`]).
    fn post_request() -> Result<(), String> {
        let Some(bridge) = GLUE.get() else {
            return Ok(());
        };
        with_env(bridge, |e| {
            e.call_method(bridge.glue.as_obj(), "request", "()V", &[])
                .map(|_| ())
                .map_err(jerr)
        })
    }

    /// Clear any outstanding request token (used on the error / timeout path).
    fn clear_pending() {
        let Ok(mut pending) = PENDING.lock() else {
            return;
        };
        *pending = None;
    }

    /// Resolve a pending `mic_permission_request` from the Kotlin upcall.
    fn resolve(granted: bool) {
        let Ok(mut pending) = PENDING.lock() else {
            return;
        };
        if let Some(tx) = pending.take() {
            let _ = tx.send(granted);
        }
    }

    /// Dialog-free snapshot of the grant (host / unbound → `native:false`).
    pub fn state() -> MicPermissionState {
        if !bound() {
            return MicPermissionState::none();
        }
        MicPermissionState {
            native: true,
            granted: is_granted().unwrap_or(false),
        }
    }

    /// Await an OS grant, posting the dialog only when the grant is not held.
    pub async fn request() -> MicPermissionState {
        if !bound() {
            return MicPermissionState::none();
        }
        if is_granted().unwrap_or(false) {
            return MicPermissionState {
                native: true,
                granted: true,
            };
        }
        // Exactly one outstanding request at a time.
        let rx = {
            let Ok(mut pending) = PENDING.lock() else {
                return state();
            };
            if pending.is_some() {
                return state(); // another request is already awaiting the dialog
            }
            let (tx, rx) = oneshot::channel();
            *pending = Some(tx);
            rx
        };
        if post_request().is_err() {
            clear_pending();
            return state();
        }
        let granted = match tokio::time::timeout(GRANT_TIMEOUT, rx).await {
            Ok(Ok(g)) => g,
            _ => false,
        };
        // A timeout leaves the token in place; clear it so the next request works.
        clear_pending();
        MicPermissionState {
            native: true,
            granted,
        }
    }

    /// `MicPermissionGlue.bind()` — keep the Kotlin singleton so Rust can drive
    /// `isGranted()` / `request()`.
    ///
    /// # Safety
    /// Standard JNI instance-method args: `this` is the live `MicPermissionGlue`
    /// object for the duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_MicPermissionGlue_bind(
        env: *mut jni::sys::JNIEnv,
        this: jobject,
    ) {
        if this.is_null() || env.is_null() {
            return; // nothing to bind yet → honest no-op
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        if let Ok(env) = unsafe { jni::JNIEnv::from_raw(env) } {
            // SAFETY: `this` is a live JNI local ref for the duration of the call.
            let obj = unsafe { JObject::from_raw(this) };
            let registered = env.new_global_ref(obj).ok().and_then(|glue| {
                env.get_java_vm()
                    .ok()
                    .map(|vm| std::sync::Arc::new(MicBridge { vm, glue }))
            });
            if let Some(bridge) = registered {
                // Exactly-once; a redundant re-bind simply keeps the first glue.
                let _ = GLUE.set(bridge);
            }
        }
    }

    /// `MicPermissionGlue.onResult(granted)` — resolve the pending request.
    ///
    /// # Safety
    /// Standard JNI instance-method args: `this` is the live `MicPermissionGlue`
    /// object for the duration of the call; `granted` is a `jboolean`.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_MicPermissionGlue_onResult(
        _env: *mut jni::sys::JNIEnv,
        _this: jobject,
        granted: jboolean,
    ) {
        resolve(granted != 0);
    }
}

/// Dialog-free snapshot of the `RECORD_AUDIO` grant. Host / unbound → `native:false`.
#[tauri::command]
pub fn mic_permission_state() -> MicPermissionState {
    #[cfg(feature = "android")]
    {
        jni::state()
    }
    #[cfg(not(feature = "android"))]
    {
        MicPermissionState::none()
    }
}

/// JS-awaitable: ensure `RECORD_AUDIO` for the native AAudio mic, posting the OS
/// dialog only when it is not already held. Host → `native:false` immediately.
#[tauri::command]
pub async fn mic_permission_request() -> MicPermissionState {
    #[cfg(feature = "android")]
    {
        jni::request().await
    }
    #[cfg(not(feature = "android"))]
    {
        MicPermissionState::none()
    }
}

#[cfg(all(test, not(feature = "android")))]
mod tests {
    use super::*;

    /// On a host build there is no OS-grant concept and no Kotlin glue — the
    /// commands must report an honest `native:false`, never a fabricated grant.
    #[test]
    fn host_state_is_none() {
        assert_eq!(mic_permission_state(), MicPermissionState::none());
    }

    #[tokio::test]
    async fn host_request_is_none_without_a_dialog() {
        let st = mic_permission_request().await;
        assert!(!st.native);
        assert!(!st.granted);
    }
}
