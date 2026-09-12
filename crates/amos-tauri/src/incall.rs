//! Real in-call host → WebView bridge (feature `android`).
//!
//! When AmOS is the device's **default phone app (ROLE_DIALER)**, Android binds our
//! `AmosInCallService` (Kotlin, `gen/android/.../glue/AmosInCallService.kt`), which
//! observes every real Telecom `Call`. This module is the Rust side of that bridge:
//!
//! * Kotlin pushes each real call-state change up via the `nativeState` JNI upcall →
//!   we re-emit it as the existing `telephony-event` (`TelephonyCallPayload`), so the
//!   current WebView incoming-call overlay / in-call screen renders the *real* call.
//! * The WebView's answer / hang-up (`telephony_answer` / `telephony_end`) are routed
//!   here when the in-call service is actually bound → we call the Kotlin static
//!   `answerActive()` / `hangUpActive()` on the real call; otherwise `telephony.rs`
//!   falls back to the daemon (mock/demo) path.
//!
//! Honest boundary: this only functions once the user has made AmOS the default phone
//! app (so Android binds `AmosInCallService`). Until then these are no-ops that report
//! "not the default dialer" and the daemon path remains.

use std::sync::OnceLock;

use jni::objects::JString;
use jni::sys::{jobject, jstring};
use jni::{JNIEnv, JavaVM};
use tauri::{AppHandle, Emitter};

use crate::telephony::{TelephonyCallPayload, TELEPHONY_EVENT};

/// The process `AppHandle`, set once from `lib.rs::setup` so a JNI-threaded upcall can
/// emit a WebView event. Mirrors `flashlight::install_ui_pusher`.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// The daemon/process `JavaVM`, captured on the first upcall so `telephony_answer` /
/// `telephony_end` can attach and call the Kotlin control statics.
static VM: OnceLock<JavaVM> = OnceLock::new();

/// Whether an in-call service instance is currently bound (i.e. we are the active
/// default-dialer and Android handed us a live Telecom call).
pub fn is_default_dialer_bound() -> bool {
    // Ask the Kotlin side whether its service instance is alive.
    call_static_bool("isServiceBound").unwrap_or(false)
}

/// Hand the seam an `AppHandle` (from `lib.rs::setup`) for live WebView pushes.
pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

fn read_string(env: &mut JNIEnv<'_>, s: jstring) -> String {
    if s.is_null() {
        return String::new();
    }
    // SAFETY: `s` is a live java.lang.String local ref for the duration of the call.
    let j = unsafe { JString::from_raw(s) };
    env.get_string(&j).map(|x| x.into()).unwrap_or_default()
}

/// `AmosInCallService.nativeState(direction, state, peer)` — the Kotlin in-call service
/// pushes every real Telecom call-state change here; we forward it to the WebView as
/// `telephony-event` (same payload the daemon Watch emits, so the existing IncomingCall
/// / in-call UI just works for real calls).
///
/// # Safety
/// `env`/`this` are the standard JNI instance-method args; the `jstring`s are live
/// local refs valid for the duration of the call.
#[cfg(feature = "android")]
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AmosInCallService_nativeState(
    env: *mut jni::sys::JNIEnv,
    _this: jobject,
    direction: jstring,
    state: jstring,
    peer: jstring,
) {
    // SAFETY: called from the Java glue with the real `JNIEnv*` of this (already
    // attached) thread; `from_raw` only wraps it for the duration of this function, and
    // the pointer is never used after the env value is dropped. A null/garbage env is
    // rejected by the `Ok(...)` check instead of being dereferenced.
    let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
        return;
    };
    if let Ok(vm) = env.get_java_vm() {
        let _ = VM.set(vm);
    }
    let direction = read_string(&mut env, direction);
    let state = read_string(&mut env, state);
    let peer = read_string(&mut env, peer);
    if let Some(app) = APP.get() {
        let payload = TelephonyCallPayload {
            id: "real".to_string(),
            peer,
            state,
            direction,
            emergency: false,
            recording: "Off".to_string(),
        };
        let _ = app.emit(TELEPHONY_EVENT, payload);
    }
}

/// Call a `public static` boolean method on the Kotlin `AmosInCallService` companion.
fn call_static_bool(method: &str) -> Result<bool, String> {
    let vm = VM
        .get()
        .ok_or_else(|| "in-call JVM not captured yet".to_string())?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("in-call attach failed: {e}"))?;
    let class = env
        .find_class("com/amos/ai/glue/AmosInCallService")
        .map_err(|e| e.to_string())?;
    let value = env
        .call_static_method(&class, method, "()Z", &[])
        .map_err(|e| e.to_string())?;
    value.z().map_err(|e| e.to_string())
}

/// Answer the real ringing call. `true` = a bound in-call service answered it.
pub fn real_answer() -> Result<bool, String> {
    call_static_bool("answerActive")
}

/// Hang up the real active call. `true` = a bound in-call service ended it.
pub fn real_hang_up() -> Result<bool, String> {
    call_static_bool("hangUpActive")
}
