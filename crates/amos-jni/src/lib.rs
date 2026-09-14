//! Shared JNI plumbing for AmOS's Android providers (REQ-A186).
//!
//! Why this crate exists: the System UI APK runs Rust provider code that talks to
//! Android through JNI, and **one failed JNI call can kill the process** on the next
//! call if the exception it left behind is not cleared. That is not a theory — a
//! device round proved it (REQ-A185): `AndroidRadioProvider::snapshot` read the
//! hotspot on a tokio worker thread, `JNIEnv::find_class` failed with
//! `ClassNotFoundException` (that thread's class loader is the bootstrap one), and the
//! following `NewStringUTF` aborted the app under CheckJNI:
//!
//! ```text
//! JNI DETECTED ERROR IN APPLICATION: JNI NewStringUTF called with pending exception
//! java.lang.ClassNotFoundException: Didn't find class "com.amos.ai.glue.TetheringGlue"
//!   … → SIGABRT
//! ```
//!
//! Measured across the workspace at that time: **15 modules, 52 JNI call sites, and
//! the exception was cleared in exactly one place**. So the two rules live here, once:
//!
//!   1. [`attached`] / [`with_env`] — every `JNIEnv` a provider uses comes from here,
//!      and the thread's exception state is cleared **on entry and after a failure**,
//!      so a refusal in one operation cannot poison the next one.
//!   2. [`resolve_class`] — a glue class is resolved through the **app's** class
//!      loader (`Context#getClassLoader`) and cached as a global ref, because
//!      `JNIEnv::find_class` uses the *calling thread's* loader (bootstrap on a tokio
//!      worker ⇒ `ClassNotFoundException`).
//!
//! For the remaining in-operation case (a failure followed by more JNI calls on the
//! same thread) the [`jni_call!`] macro clears immediately after each call, which is
//! what `amos-radio` does at every site.
//!
//! Honest boundary: nothing here can be unit-tested without a JVM, so the guarantees
//! are "clears at these points" plus the `android` features still compiling; the
//! device is the only place the behaviour is observed (see `docs/android-glue.md`).

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use jni::objects::{GlobalRef, JObject, JValue};
use jni::{JNIEnv, JavaVM};

/// The error type the providers use: a plain message, cheap to map into their own.
pub type Result<T> = std::result::Result<T, String>;

/// Drop any exception the JVM left pending on this thread.
///
/// A pending exception makes the *next* JNI call abort the whole process (CheckJNI),
/// so this runs before a JNI sequence and again after a failed one.
pub fn clear_pending(env: &JNIEnv<'_>) {
    if env.exception_check().unwrap_or(false) {
        // Not discarded: if clearing itself fails the VM is in trouble and the next
        // JNI call on this thread will abort — that must be visible, not swallowed
        // (the discard gate found this line, REQ-A186).
        if let Err(e) = env.exception_clear() {
            tracing::warn!(
                target: "amos::jni",
                error = %e,
                "could not clear a pending JNI exception — the next JNI call on this thread may abort"
            );
        }
    }
}

/// Attach the current thread and **start from a clean exception state**.
///
/// This replaces `JavaVM::attach_current_thread*` at every provider call site: an
/// earlier operation on the same (pooled) thread may have left an exception pending,
/// and the first JNI call here would otherwise abort the app.
///
/// Returns the crate's own error so callers keep using their existing mapping
/// (`map_err(jerr)` / `map_err(|e| e.to_string())`).
pub fn attached(vm: &JavaVM) -> jni::errors::Result<JNIEnv<'_>> {
    let env = vm.attach_current_thread_permanently()?;
    clear_pending(&env);
    Ok(env)
}

/// Run one JNI operation on a freshly attached, clean thread; leave it clean on
/// failure too (so the next operation cannot inherit the exception).
pub fn with_env<T>(vm: &JavaVM, f: impl FnOnce(&mut JNIEnv<'_>) -> Result<T>) -> Result<T> {
    let mut env = attached(vm).map_err(|e| e.to_string())?;
    let out = f(&mut env);
    if out.is_err() {
        clear_pending(&env);
    }
    out
}

/// Called by [`jni_call!`] after a failed call so the macro's expansion stays small.
///
/// A trait rather than a plain function so the macro accepts **either** an owned
/// `JNIEnv` or a `&JNIEnv` (call sites have both shapes).
pub trait ClearAfterFailure {
    /// Clear the thread's pending exception when `failed`.
    fn clear_after(&self, failed: bool);
}

impl ClearAfterFailure for JNIEnv<'_> {
    fn clear_after(&self, failed: bool) {
        if failed {
            clear_pending(self);
        }
    }
}

impl ClearAfterFailure for &JNIEnv<'_> {
    fn clear_after(&self, failed: bool) {
        if failed {
            clear_pending(self);
        }
    }
}

impl ClearAfterFailure for &mut JNIEnv<'_> {
    fn clear_after(&self, failed: bool) {
        if failed {
            clear_pending(self);
        }
    }
}

/// Run a JNI call and clear the pending exception when it fails.
///
/// A macro (not a function) because the `jni` wrappers take `&mut self`: the call is
/// expanded as its own statement, releasing that borrow before the shared-borrow
/// exception check — which a function taking both as arguments cannot express.
#[macro_export]
macro_rules! jni_call {
    ($env:expr, $call:expr $(,)?) => {{
        let r = $call;
        $crate::ClearAfterFailure::clear_after(&$env, r.is_err());
        r
    }};
}

/// Resolve a glue class through the **app's** class loader and keep a global ref.
///
/// `dotted` is the Java name (`com.amos.ai.glue.TetheringGlue`). Returns `None` when
/// the loader is unavailable or the class is absent — callers then report an honest
/// error instead of issuing a call that would fail (and, before this crate, poison
/// the thread). Resolve at attach time (a Java thread) and reuse from anywhere.
pub fn resolve_class(
    env: &mut JNIEnv<'_>,
    context: &JObject<'_>,
    dotted: &str,
) -> Option<GlobalRef> {
    let loader = jni_call!(
        env,
        env.call_method(context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
    )
    .ok()?
    .l()
    .ok()?;
    let jname = jni_call!(env, env.new_string(dotted)).ok()?;
    let class = jni_call!(
        env,
        env.call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&jname)],
        )
    )
    .ok()?
    .l()
    .ok()?;
    if class.is_null() {
        return None;
    }
    jni_call!(env, env.new_global_ref(class)).ok()
}
