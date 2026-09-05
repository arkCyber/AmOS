//! Rust **glue stubs** bridging the AmOS global clipboard and the Android
//! container's real `ClipboardManager` (feature `android`).
//!
//! Mirrors the `android_glue` bring-up pattern (compile-checked under
//! `--features android`, exercised at device time against the Kotlin templates in
//! `android-glue/`): the Kotlin listeners hand container-side copy events and a
//! bridge object into the native runtime through the JNI upcalls below.
//!
//! ```text
//! Kotlin ClipListener.onTextChanged ─► Java_..._ClipboardGlue_onContainerCopy ─┐
//!                                                                              ▼
//!                                  crate::clipboard::ingest_native_text(...)
//!                                       (bus armed from lib::setup)
//!
//! WebView app copies ─► clipboard_write ─► mirror_to_native ─► AndroidClipboardSink
//!                                          (Rust ─► Java)
//!       Kotlin ClipboardGlue.attach(bridge) ┘
//! ```
//!
//! Two directions are wired:
//!   * **Container ─► Rust**: a copy made *inside* the Android container is
//!     ingested into the shared AmOS clipboard (so a Webview app can paste it).
//!   * **Rust ─► Android**: an `AndroidClipboardSink` (a [`ClipboardNative`])
//!     mirrors AmOS writes onto the container's `ClipboardManager` via a Kotlin
//!     bridge object (`pushTextClipboard(String, long)`), so an app running
//!     inside the container can paste AmOS-side copies.
//!
//! This module only exists on-device. Like `android_glue`, it compiles under
//! `cargo check --features android` but needs a real JVM + the Kotlin glue at
//! runtime. Nothing is faked: until the sink is attached (or the ingest bus is
//! armed) every path is an honest no-op.

use std::sync::{Arc, Mutex, OnceLock};

use crate::clipboard::{self, ClipboardEntry, ClipboardNative};
use jni::objects::{GlobalRef, JObject, JString, JValue};
use jni::sys::{jobject, jstring};
use jni::JavaVM;

/// Installed Rust ─► Android sink (guarded so the sink never panics).
static SINK: OnceLock<Arc<AndroidClipboardSink>> = OnceLock::new();

/// A [`ClipboardNative`] transport that pushes AmOS clipboard writes onto the
/// Android container's `ClipboardManager` through a Kotlin bridge object.
struct AndroidClipboardSink {
    vm: JavaVM,
    /// Global ref to the Kotlin `ClipboardGlue` bridge instance.
    bridge: GlobalRef,
    /// Monotonic counter for cross-process ordering hints.
    seq: Mutex<u64>,
}

impl ClipboardNative for AndroidClipboardSink {
    fn name(&self) -> &'static str {
        "android-container"
    }

    /// Push an outgoing entry's plain text to the container clipboard.
    fn push_out(&self, entry: &ClipboardEntry) -> Result<(), String> {
        let text = entry
            .plain_text()
            .ok_or_else(|| "image-only payload can't mirror to a text clipboard".to_string())?;
        let seq = {
            let mut g = self.seq.lock().map_err(|e| e.to_string())?;
            *g += 1;
            *g
        };

        // Attach the current (Tauri main) thread to the JVM. On Android the main
        // thread is already attached, so this returns a cheap nested guard.
        let mut env = self.vm.attach_current_thread().map_err(|e| e.to_string())?;
        let obj = self.bridge.as_obj();
        let jtext = env.new_string(text).map_err(|e| e.to_string())?;
        let jobj: JObject = jtext.into();
        // Kotlin bridge: `fun pushTextClipboard(text: String, seq: Long)`.
        env.call_method(
            obj,
            "pushTextClipboard",
            "(Ljava/lang/String;J)V",
            &[JValue::Object(&jobj), JValue::Long(seq as i64)],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
}

/// Build + install the sink from the Kotlin-supplied bridge object.
///
/// # Safety
/// `env`/`this` are the standard JNI instance-method arguments of
/// `ClipboardGlue.attach(bridge)` and must be valid for the call; `bridge` is the
/// Kotlin bridge instance (a local ref) and is promoted to a global ref here.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_ClipboardGlue_attach(
    env: *mut jni::sys::JNIEnv,
    _this: jobject,
    bridge: jobject,
) {
    if bridge.is_null() || env.is_null() {
        return; // no bridge yet → honest no-op, sink stays uninstalled
    }
    // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
    if let Ok(env) = unsafe { jni::JNIEnv::from_raw(env) } {
        // SAFETY: `bridge` is a live local ref for the duration of this call.
        let obj = unsafe { JObject::from_raw(bridge) };
        let registered = env.new_global_ref(obj).ok().and_then(|bridge| {
            env.get_java_vm().ok().map(|vm| {
                Arc::new(AndroidClipboardSink {
                    vm,
                    bridge,
                    seq: Mutex::new(0),
                })
            })
        });
        if let Some(sink) = registered {
            // Exactly-once; a redundant re-attach simply keeps the first sink.
            let _ = SINK.set(sink.clone());
            let _ = clipboard::set_native_sink(sink);
        }
    }
}

/// Container ─► Rust: a copy made inside the Android container is ingested into
/// the shared AmOS clipboard. Honest no-op if the ingest bus isn't armed.
///
/// # Safety
/// Standard JNI instance-method args of `ClipboardGlue.onContainerCopy(text)`;
/// `text` is a live java.lang.String local ref for the duration of the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_ClipboardGlue_onContainerCopy(
    env: *mut jni::sys::JNIEnv,
    _this: jobject,
    text: jstring,
) {
    if text.is_null() || env.is_null() {
        return; // no text → nothing to ingest
    }
    // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
    if let Ok(mut env) = unsafe { jni::JNIEnv::from_raw(env) } {
        // Read the Java string into an owned Rust `String` in an inner scope so
        // the JNI borrow ends before the native local ref (`text`) is dropped.
        let rust: Option<String> = {
            // SAFETY: `text` is a live JNI local ref for the duration of this call.
            let s = unsafe { JString::from_raw(text) };
            let out = match env.get_string(&s) {
                Ok(java_str) => Some(java_str.into()),
                Err(_) => None,
            };
            out
        };
        if let Some(rust) = rust {
            // Bus armed at boot from lib::setup → appears as newest clipboard
            // entry, available to foreground Webview apps to paste.
            let _ = clipboard::ingest_native_text("android:container", &rust);
        }
    }
}
