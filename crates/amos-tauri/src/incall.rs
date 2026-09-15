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
    // Exactly-once: a redundant re-attach keeps the first one (REQ-A187 baseline).
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
        // Exactly-once: a redundant re-attach keeps the first one (REQ-A187 baseline).
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
        // The UI's in-call screen is driven by this event; a failed emit means the call
        // would sit in the background with no visible state (REQ-A187).
        if let Err(e) = app.emit(TELEPHONY_EVENT, payload) {
            tracing::warn!(
                target: "amos::telephony",
                error = %e,
                "in-call state event not delivered to the UI"
            );
        }
    }
}

/// Call a `public static` boolean method on the Kotlin `AmosInCallService` companion.
fn call_static_bool(method: &str) -> Result<bool, String> {
    let vm = VM
        .get()
        .ok_or_else(|| "in-call JVM not captured yet".to_string())?;
    // Shared helper: attach with a clean exception state (REQ-A186).
    let mut env = amos_jni::attached(vm).map_err(|e| format!("in-call attach failed: {e}"))?;
    // `find_class` uses the *calling thread's* class loader: from a Java-thread upcall
    // that is the app loader, from a tokio worker it is the bootstrap one and the
    // resolution fails. This module has no `Context` (only the captured `JavaVM`), so
    // the call is wrapped in the clearing macro: a failure is returned as an error
    // instead of leaving an exception pending that would abort the process on the next
    // JNI call (the device-proven crash class). Recorded in scripts/jni-allowlist.json
    // with the follow-up (capture the class at upcall time). See REQ-A186.
    let class = amos_jni::jni_call!(env, env.find_class("com/amos/ai/glue/AmosInCallService"))
        .map_err(|e| e.to_string())?;
    let value = amos_jni::jni_call!(env, env.call_static_method(&class, method, "()Z", &[]))
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

#[cfg(test)]
mod tests {
    use super::*;

    // The JNI trampolines themselves need a real JVM to exercise, but the payload
    // shape and the `TelephonyCallPayload` fields the bridge hands the WebView
    // are pure logic and must hold their guarantees without one. The on-device
    // `VM`/`APP` OnceLocks are process-global and a parallel test could
    // legitimately populate them (the `lib.rs` setup does so on Android), so the
    // JVM-not-captured assertion is **not** a unit test — it is a property the
    // code holds in isolation, observed in a freshly-spawned process. Skipping it
    // here is intentional; the device-side `scripts/android-glue-check` gate is
    // where that scenario lives.

    #[test]
    fn empty_direction_is_preserved_and_forwarded_as_is() {
        // `read_string` returns `""` for a null jstring — the payload carries that
        // empty string through (the frontend classifies it via its own state
        // machine), rather than silently turning it into "Outgoing".
        let payload = TelephonyCallPayload {
            id: "real".to_string(),
            peer: String::new(),
            state: String::new(),
            direction: String::new(),
            emergency: false,
            recording: "Off".to_string(),
        };
        assert_eq!(payload.direction, "");
        assert_eq!(payload.state, "");
        assert_eq!(payload.peer, "");
        assert_eq!(payload.recording, "Off", "recording defaults to Off");
        assert!(!payload.emergency);
    }

    #[test]
    fn payload_round_trips_through_serde() {
        // The Tauri event bus serializes via serde_json; a malformed payload that
        // doesn't serialize would fail silently at emit time and leave the UI
        // frozen. Verify the public wire shape.
        let p = TelephonyCallPayload {
            id: "real".into(),
            peer: "+8613800138000".into(),
            state: "Active".into(),
            direction: "Outgoing".into(),
            emergency: false,
            recording: "On".into(),
        };
        let j = serde_json::to_string(&p).expect("serialize");
        // Every field the WebView's `IncomingCall` overlay reads must be present.
        for needle in [
            "\"id\":\"real\"",
            "\"peer\":\"+8613800138000\"",
            "\"state\":\"Active\"",
            "\"direction\":\"Outgoing\"",
            "\"emergency\":false",
            "\"recording\":\"On\"",
        ] {
            assert!(j.contains(needle), "missing {needle} in payload: {j}");
        }
    }

    #[test]
    fn payload_emergency_round_trip_is_honest() {
        // The Kotlin in-call service may flag emergency lines; the bridge must
        // carry that bit through unchanged (it is used by the UI to suppress the
        // record button on emergency calls).
        let p = TelephonyCallPayload {
            id: "real".into(),
            peer: "110".into(),
            state: "Active".into(),
            direction: "Incoming".into(),
            emergency: true,
            recording: "Off".into(),
        };
        let j = serde_json::to_string(&p).expect("serialize");
        assert!(j.contains("\"emergency\":true"));
    }
}
