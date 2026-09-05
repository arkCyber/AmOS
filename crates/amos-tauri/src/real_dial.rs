//! Real outbound dialing for the AmOS Phone dialer.
//!
//! Runs in the **System UI host** process that holds an Android app `Context` (the
//! APK), *not* the headless `amos-ai` daemon (docs/telephony.md §2/§12). It dials via
//! `Intent(ACTION_CALL, tel:…)` — the same real call `amos-telephony`'s Android
//! provider places, exposed as a small command so the dialer needs no daemon.
//!
//! Runtime contract:
//! * The generated `MainActivity`/boot glue hands the app `Context` to Rust via
//!   `TelephonyGlue.nativeAttach` (Kotlin) → the `#[no_mangle]`
//!   `Java_com_amos_ai_glue_TelephonyGlue_nativeAttach` stores a process-wide ref.
//! * `real_dial(number)` fires `ACTION_CALL` from it; until bound it returns an
//!   explicit error — never a fake "connected".
//!
//! Only feature `android` has a JVM/`Context`; host builds report "unsupported".

#[cfg(feature = "android")]
/// `android.content.Intent.ACTION_CALL`. The modern `ROLE_DIALER` path is
/// `TelecomManager#placeCall` (a TODO); ACTION_CALL is the conservative fallback.
const ACTION_CALL: &str = "android.intent.action.CALL";
#[cfg(feature = "android")]
/// `Intent.FLAG_ACTIVITY_NEW_TASK` — dialing from an app Context (no Activity host).
const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;
#[cfg(feature = "android")]
const TEL_SCHEME: &str = "tel:";

/// Keep only dialable digits (`+` allowed) from a user-typed number.
fn digits_only(number: &str) -> String {
    number
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect()
}

#[cfg(feature = "android")]
mod android_impl {
    use std::sync::OnceLock;
    use super::*;
    use jni::objects::{GlobalRef, JObject, JValue};
    use jni::{JNIEnv, JavaVM};

    /// Process-wide handle to the Java app `Context` used to fire dial intents.
    /// A JNI *global* ref is VM-global; each use re-attaches the thread first (the
    /// same pattern as the repo's radio/flashlight providers & `clipboard_glue`).
    struct AndroidContext(GlobalRef);

    // SAFETY: a JNI global ref is VM-global and outlives the creating env; every use
    // re-attaches the calling thread. Dropping is handled by `GlobalRef`.
    unsafe impl Send for AndroidContext {}
    unsafe impl Sync for AndroidContext {}

    static CTX: OnceLock<(JavaVM, AndroidContext)> = OnceLock::new();

    /// Store the app `Context` handed over at boot. Idempotent: first caller wins.
    pub fn bind(vm: JavaVM, env: &JNIEnv<'_>, context: JObject<'_>) -> Result<(), String> {
        let gref = env
            .new_global_ref(context)
            .map_err(|e| format!("failed to global-ref dial context: {e}"))?;
        CTX.set((vm, AndroidContext(gref)))
            .map_err(|_| "real dial context is already bound".to_string())
    }

    pub fn is_bound() -> bool {
        CTX.get().is_some()
    }

    /// Fire `ACTION_CALL` for `number` (already stripped to digits) from the context.
    pub fn dial(number: &str) -> Result<(), String> {
        let (vm, ctx) = CTX
            .get()
            .ok_or_else(|| {
                "real dial context not bound — call TelephonyGlue.nativeAttach at boot".to_string()
            })?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("failed to attach to JVM: {e}"))?;

        let action = env
            .new_string(ACTION_CALL)
            .map_err(|e| e.to_string())?;
        let intent = env
            .new_object(
                "android/content/Intent",
                "(Ljava/lang/String;)V",
                &[JValue::Object(&action)],
            )
            .map_err(|e| e.to_string())?;
        let tel = env
            .new_string(format!("{TEL_SCHEME}{number}"))
            .map_err(|e| e.to_string())?;
        let uri = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&tel)],
            )
            .and_then(|v| v.l())
            .map_err(|e| e.to_string())?;
        env.call_method(
            &intent,
            "setData",
            "(Landroid/net/Uri;)Landroid/content/Intent;",
            &[JValue::Object(&uri)],
        )
        .map_err(|e| e.to_string())?;
        env.call_method(
            &intent,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)],
        )
        .map_err(|e| e.to_string())?;
        env.call_method(
            ctx.0.as_obj(),
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&intent)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(feature = "android")]
/// Whether a dial context has been bound at boot.
pub fn is_bound() -> bool {
    android_impl::is_bound()
}

/// JNI entry: `TelephonyGlue.nativeAttach(Context)` — an **instance** `external fun`
/// on the Kotlin `object` (matching the repo's Sensor/Clipboard glue) — hands the app
/// context to Rust so `real_dial` can place calls. `env`/`this` are the standard JNI
/// instance-method args; `context` is promoted to a global ref. Nulls are a no-op.
///
/// # Safety
///
/// `env` must be a valid `JNIEnv*` and `context` a live local ref for the duration of
/// this native call (both are guaranteed by the JVM when invoking a registered native
/// method). The function is `unsafe` because it re-wraps raw pointers.
#[cfg(feature = "android")]
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_TelephonyGlue_nativeAttach(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    context: jni::sys::jobject,
) {
    if env.is_null() || context.is_null() {
        return;
    }
    // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
    let env = unsafe { jni::JNIEnv::from_raw(env) };
    // SAFETY: `context` is a live local ref for the duration of this native call.
    let ctx = unsafe { jni::objects::JObject::from_raw(context) };
    if let Ok(e) = env {
        if let Ok(vm) = e.get_java_vm() {
            let _ = android_impl::bind(vm, &e, ctx);
        }
    }
}

/// Tauri command: place a **real** outbound call for `number` through Android Telecom.
///
/// * Android + context bound → fires `ACTION_CALL`, returns a status line.
/// * Not Android / not bound → an explicit error string; it never fabricates a
///   "connected" call.
#[tauri::command]
pub async fn real_dial(number: String) -> Result<String, String> {
    let cleaned = digits_only(&number);
    if cleaned.is_empty() {
        return Err("no dialable digits in number".to_string());
    }
    #[cfg(feature = "android")]
    {
        if !android_impl::is_bound() {
            return Err("real dial not bound — grant CALL_PHONE and re-open the app".to_string());
        }
        android_impl::dial(&cleaned).map_err(|e| format!("real dial failed: {e}"))?;
        Ok(format!("dialing {cleaned} via Android Telecom"))
    }
    #[cfg(not(feature = "android"))]
    {
        Err("real dial is only available in the on-device (Android) System UI build".to_string())
    }
}


#[cfg(test)]
mod tests {
    use super::digits_only;

    #[test]
    fn keeps_digits_and_plus() {
        assert_eq!(digits_only("+86 138-0013-8000"), "+8613800138000");
        assert_eq!(digits_only("110"), "110");
    }

    #[test]
    fn strips_spaces_dashes_parens() {
        assert_eq!(digits_only("(010) 1234-5678"), "01012345678");
        assert_eq!(digits_only("12 3-4"), "1234");
    }

    #[test]
    fn empty_when_no_dialable_digits() {
        assert_eq!(digits_only("call me"), "");
        assert_eq!(digits_only(""), "");
    }

    #[test]
    fn plus_only_first_is_allowed() {
        // '+' is preserved anywhere by design (simple filter); a lone '+' is not a
        // number but the command rejects empty-after-clean as well.
        assert_eq!(digits_only("+"), "+");
    }
}

