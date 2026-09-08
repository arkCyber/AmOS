//! Real Android [`ClipboardProvider`] for the **guest side** (feature `android`).
//!
//! Compile-checked under `cargo check --features android` (no JNI host stack is
//! pulled in on desktop/CI because `jni` is an optional dep and this module is
//! `#[cfg(feature = "android")]`). At runtime it needs a live Android VM + a Kotlin
//! bridge object (a guest process that owns a `Context` + `ClipboardManager`) that
//! is handed in through the [`attach`] JNI upcall — exactly like the System UI's
//! `clipboard_glue.rs`. Nothing is faked: until a bridge is attached the provider
//! cannot be constructed (methods error / report `None` rather than fabricate).
//!
//! The matching Kotlin bridge (device bring-up glue, symbol-aligned with the upcalls
//! below) lives at `crates/amos-clipboard/android-glue/com/amos/ai/glue/AndroidClipboardGlue.kt`.
//!
//! The bridge object must expose, on the Kotlin side:
//!   * `fun primaryText(): String?`         — current primary clip text
//!   * `fun pushText(text: String)`         — set the primary clip (plain text)
//!
//! It must also forward ClipboardManager changes back as the native upcall
//! [`on_clipboard_changed`], which routes to the change sink installed via
//! [`ClipboardProvider::set_change_listener`].

use std::sync::{Arc, Mutex, OnceLock};

use jni::objects::{GlobalRef, JObject, JString, JValue};
use jni::sys::{jobject, jstring};
use jni::JavaVM;

use crate::provider::{ChangeSink, ClipboardProvider};

/// Installed change sink (the agent's listener), routed to by the Kotlin-side
/// change upcall. Absent until [`ClipboardProvider::set_change_listener`] is called.
static CHANGE_SINK: OnceLock<Mutex<Option<ChangeSink>>> = OnceLock::new();

fn change_sink() -> &'static Mutex<Option<ChangeSink>> {
    CHANGE_SINK.get_or_init(|| Mutex::new(None))
}

/// The constructed provider, installed once by [`attach`] so Kotlin-side upcalls
/// can reach it if needed.
static INSTANCE: OnceLock<Arc<AndroidClipboardProvider>> = OnceLock::new();

/// Real guest-side [`ClipboardProvider`] over a Kotlin bridge object.
pub struct AndroidClipboardProvider {
    vm: JavaVM,
    bridge: GlobalRef,
}

impl ClipboardProvider for AndroidClipboardProvider {
    fn name(&self) -> &'static str {
        "android-guest"
    }

    fn primary_text(&self) -> Option<String> {
        let mut env = self.vm.attach_current_thread().ok()?;
        let obj = self.bridge.as_obj();
        // Kotlin bridge: `fun primaryText(): String?`.
        let result = env
            .call_method(obj, "primaryText", "()Ljava/lang/String;", &[])
            .ok()?;
        let jobj = result.l().ok()?;
        if jobj.is_null() {
            return None; // bridge returned null -> no primary text
        }
        // SAFETY: `jobj` is a live java.lang.String local ref returned by the call.
        let s = unsafe { JString::from_raw(jobj.into_raw() as jstring) };
        env.get_string(&s).ok().map(Into::into)
    }

    fn set_primary_text(&self, text: &str) -> Result<(), String> {
        let mut env = self.vm.attach_current_thread().map_err(|e| e.to_string())?;
        let obj = self.bridge.as_obj();
        let jtext = env.new_string(text).map_err(|e| e.to_string())?;
        let jobj: JObject = jtext.into();
        // Kotlin bridge: `fun pushText(text: String)`.
        env.call_method(
            obj,
            "pushText",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&jobj)],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    fn set_change_listener(&self, listener: Option<ChangeSink>) -> Result<(), String> {
        let mut guard = change_sink().lock().map_err(|e| e.to_string())?;
        *guard = listener;
        Ok(())
    }
}

/// Build + install the provider from the Kotlin-supplied bridge object.
///
/// # Safety
/// `env`/`this` are the standard JNI instance-method arguments of the Kotlin
/// `attach(bridge)` and must be valid for the call; `bridge` is a live local ref.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AndroidClipboardGlue_attach(
    env: *mut jni::sys::JNIEnv,
    _this: jobject,
    bridge: jobject,
) {
    if bridge.is_null() || env.is_null() {
        return; // no bridge yet -> honest no-op, provider stays uninstalled
    }
    // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
    let Ok(env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
        return;
    };
    // SAFETY: `bridge` is a live local ref for the duration of this call.
    let obj = unsafe { JObject::from_raw(bridge) };
    let provider = env
        .new_global_ref(obj)
        .ok()
        .and_then(|bridge| {
            env.get_java_vm()
                .ok()
                .map(|vm| AndroidClipboardProvider { vm, bridge })
        })
        .map(Arc::new);
    if let Some(provider) = provider {
        // Exactly-once; a redundant re-attach simply keeps the first provider.
        let _ = INSTANCE.set(provider);
    }
}

/// Forward a Kotlin-side clipboard change into the installed change sink.
///
/// # Safety
/// Standard JNI instance-method args of the Kotlin `onClipboardChanged(text)`;
/// `text` is a live java.lang.String local ref for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AndroidClipboardGlue_onClipboardChanged(
    env: *mut jni::sys::JNIEnv,
    _this: jobject,
    text: jstring,
) {
    if text.is_null() || env.is_null() {
        return;
    }
    // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
    let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
        return;
    };
    // SAFETY: `text` is a live JNI local ref for the duration of this call.
    let s = unsafe { JString::from_raw(text) };
    let rust: String = match env.get_string(&s) {
        Ok(java_str) => java_str.into(),
        Err(_) => return,
    };
    let sink = change_sink().lock().ok().and_then(|g| g.clone());
    if let Some(sink) = sink {
        sink(&rust);
    }
}
