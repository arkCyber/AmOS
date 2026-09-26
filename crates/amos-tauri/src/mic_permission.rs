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
//!   * `granted == true` **only** when the OS itself answered "yes" — never a
//!     fabricated "granted".
//!   * `granted == false` is **not** one answer. `state` says which of four it is:
//!     `denied` (the OS answered no), `unreadable` (the read failed — with the
//!     host's own words in `detail`), `timed-out` (the dialog was posted and the OS
//!     had not answered in time), or `host` (no OS-grant concept here). A UI that
//!     renders only the `granted` bit is claiming the user's settings from a read
//!     that may never have happened.
//!
//! The JNI half is compile-gated by the `android` feature and is only ever
//! exercised at device time against the Kotlin template in
//! `android-glue/com/amos/ai/glue/MicPermissionGlue.kt` (mirrors the
//! `clipboard_glue` bring-up pattern).

use serde::Serialize;

/// What **reading** the OS `RECORD_AUDIO` grant can honestly answer.
///
/// The read used to answer one `bool` — `is_granted().unwrap_or(false)`. Four different things
/// therefore arrived as `false`: "the user said no", "the glue's `isGranted()` threw", "the
/// dialog never came back inside `GRANT_TIMEOUT`", and "there is no OS-grant concept here". The
/// UI said one sentence about all four — 「系统未授予麦克风权限（RECORD_AUDIO）」, a claim about
/// the user's own settings — and only the first of them is one.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MicGrantState {
    /// The OS answered: `RECORD_AUDIO` is held right now.
    Granted,
    /// The OS answered: it is not held (the user denied, or never granted it).
    Denied,
    /// **The OS never answered** — the read itself failed (a JNI attach error, a dead VM, a
    /// throwing `isGranted()`). Not a statement about the user's settings.
    Unreadable,
    /// The dialog was posted and the OS had not answered within `GRANT_TIMEOUT`; it may still be
    /// on screen. This is "no answer yet", not "no".
    TimedOut,
    /// There is no OS-grant concept on this host at all (host build, or the Kotlin glue has not
    /// bound yet).
    Host,
}

/// What the caller needs to know about the OS `RECORD_AUDIO` grant.
///
/// * `native` — true only when running inside the Android System UI with the Kotlin
///   `MicPermissionGlue` **bound** (i.e. the OS-grant concept exists here). A bound glue whose
///   read *failed* is still `native: true` with `state: "unreadable"` — the bridge is real, the
///   answer is not.
/// * `granted` — true **only** when the OS answered `state: "granted"`. It is the one bit the
///   existing callers read; a caller that must tell "denied" from "we never got to ask" reads
///   `state`.
/// * `detail` — the host's own words when `state` is `unreadable`, never re-worded here.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct MicPermissionState {
    pub native: bool,
    pub granted: bool,
    pub state: MicGrantState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl MicPermissionState {
    /// Host / not-yet-bound honest state: no native mic-grant concept here.
    pub const fn host() -> Self {
        Self {
            native: false,
            granted: false,
            state: MicGrantState::Host,
            detail: None,
        }
    }

    /// The OS answered "yes".
    pub const fn granted() -> Self {
        Self {
            native: true,
            granted: true,
            state: MicGrantState::Granted,
            detail: None,
        }
    }

    /// The OS answered "no".
    pub const fn denied() -> Self {
        Self {
            native: true,
            granted: false,
            state: MicGrantState::Denied,
            detail: None,
        }
    }

    /// The read itself failed — carrying the host's own words, unedited.
    pub fn unreadable(why: String) -> Self {
        Self {
            native: true,
            granted: false,
            state: MicGrantState::Unreadable,
            detail: Some(why),
        }
    }

    /// The dialog was posted; the OS had not answered in time.
    pub const fn timed_out() -> Self {
        Self {
            native: true,
            granted: false,
            state: MicGrantState::TimedOut,
            detail: None,
        }
    }
}

/// Fold the JNI read's answer. **Pure**, so the fold is host-testable even though the call it
/// folds is `#[cfg(feature = "android")]`.
pub fn state_from_read(reply: Result<bool, String>) -> MicPermissionState {
    match reply {
        Ok(true) => MicPermissionState::granted(),
        Ok(false) => MicPermissionState::denied(),
        Err(why) => MicPermissionState::unreadable(why),
    }
}

/// What the OS answered after the dialog was posted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MicDialogAnswer {
    /// The OS answered.
    Answered(bool),
    /// Nothing came back inside `GRANT_TIMEOUT`.
    TimedOut,
}

/// Fold the request path's two steps — posting the dialog, then the OS's answer. **Pure**, for
/// the same reason as [`state_from_read`]; `post` failing means the dialog never went up at all,
/// which is `unreadable` rather than a denial.
pub fn state_from_request(post: Result<(), String>, answer: MicDialogAnswer) -> MicPermissionState {
    if let Err(why) = post {
        return MicPermissionState::unreadable(why);
    }
    match answer {
        MicDialogAnswer::Answered(true) => MicPermissionState::granted(),
        MicDialogAnswer::Answered(false) => MicPermissionState::denied(),
        MicDialogAnswer::TimedOut => MicPermissionState::timed_out(),
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

    use super::{state_from_read, state_from_request, MicDialogAnswer, MicPermissionState};

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
        // Shared helper: attach with a clean exception state (REQ-A186).
        let mut e = amos_jni::attached(&bridge.vm).map_err(jerr)?;
        f(&mut e)
    }

    /// `MicPermissionGlue.isGranted(): Boolean` through the stored bridge.
    fn is_granted() -> Result<bool, String> {
        let Some(bridge) = GLUE.get() else {
            // Unreachable in practice (`GLUE` is a `OnceLock` and every caller checks
            // `bound()` first, which is the same test) — but if it ever *is* reached, "no glue"
            // is not "the user denied". Answer with the failure, so it reads `unreadable`.
            return Err("MicPermissionGlue is not bound".to_string());
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
            // The requester may have gone (its command timed out) — then the answer has
            // no receiver and *that* is the visible fact (REQ-A187).
            if tx.send(granted).is_err() {
                tracing::debug!(
                    target: "amos::mic",
                    granted,
                    "mic permission reply dropped — the requester is gone"
                );
            }
        }
    }

    /// Dialog-free snapshot of the grant (host / unbound → `native:false`).
    pub fn state() -> MicPermissionState {
        if !bound() {
            return MicPermissionState::host();
        }
        state_from_read(is_granted())
    }

    /// Await an OS grant, posting the dialog only when the grant is not held.
    pub async fn request() -> MicPermissionState {
        if !bound() {
            return MicPermissionState::host();
        }
        // Only a *readable* "yes" short-circuits. A failed read is not a denial: fall
        // through and ask, so the answer is the OS's own — and if the ask fails too, the
        // state is `unreadable` rather than a denial no one established.
        if let Ok(true) = is_granted() {
            return MicPermissionState::granted();
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
        let post = post_request();
        if post.is_err() {
            clear_pending();
            return state_from_request(post, MicDialogAnswer::TimedOut);
        }
        let answer = match tokio::time::timeout(GRANT_TIMEOUT, rx).await {
            Ok(Ok(g)) => MicDialogAnswer::Answered(g),
            _ => MicDialogAnswer::TimedOut,
        };
        // A timeout leaves the token in place; clear it so the next request works.
        clear_pending();
        state_from_request(post, answer)
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
                // Exactly-once; a redundant re-bind simply keeps the first glue. Safe because the
                // Activity is not recreated under us — the generated manifest's `configChanges`
                // is what makes that true, and `scripts/android-glue-mirror.sh` gates it (REQ-A448).
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
        MicPermissionState::host()
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
        MicPermissionState::host()
    }
}

#[cfg(all(test, not(feature = "android")))]
mod tests {
    use super::*;

    /// On a host build there is no OS-grant concept and no Kotlin glue — the
    /// commands must report an honest `native:false`, never a fabricated grant.
    #[test]
    fn host_state_is_none() {
        assert_eq!(mic_permission_state(), MicPermissionState::host());
        assert_eq!(mic_permission_state().state, MicGrantState::Host);
    }

    #[tokio::test]
    async fn host_request_is_none_without_a_dialog() {
        let st = mic_permission_request().await;
        assert!(!st.native);
        assert!(!st.granted);
        assert_eq!(st.state, MicGrantState::Host);
    }

    // ── The fold (REQ-A787 / F-AND-010) ───────────────────────────────────────────────────
    //
    // These are the tests the module could not have before: the fold lived inside
    // `#[cfg(feature = "android")] mod jni`, so on a host build nothing could exercise it, and
    // the only statement about it was the header's prose.

    /// The four answers the one `bool` used to collapse must stay four answers.
    #[test]
    fn the_four_answers_the_read_used_to_fold_together_stay_apart() {
        let granted = state_from_read(Ok(true));
        let denied = state_from_read(Ok(false));
        let unreadable = state_from_read(Err("isGranted threw".to_string()));
        let host = MicPermissionState::host();

        assert_eq!(granted.state, MicGrantState::Granted);
        assert_eq!(denied.state, MicGrantState::Denied);
        assert_eq!(unreadable.state, MicGrantState::Unreadable);
        assert_eq!(host.state, MicGrantState::Host);

        // Pairwise distinct — the point of the whole round.
        let all = [granted, denied, unreadable, host];
        for (i, a) in all.iter().enumerate() {
            for b in all[i + 1..].iter() {
                assert_ne!(a, b, "two of the four read answers are the same value");
            }
        }
    }

    /// A read that failed is **not** a denial, and `detail` carries the host's own words
    /// rather than an invented sentence.
    #[test]
    fn a_read_that_failed_is_never_a_denied() {
        let st = state_from_read(Err("JNI attach failed".to_string()));
        assert_ne!(st.state, MicGrantState::Denied);
        assert_eq!(st.detail.as_deref(), Some("JNI attach failed"));
        // `native` is about the bridge, not the answer: the glue is bound, its answer is missing.
        assert!(st.native);
        // …and the one bit the old callers read is still "not granted", honestly.
        assert!(!st.granted);
    }

    /// Every way the *read* can fail lands on `unreadable` — never on a fact about the user.
    #[test]
    fn every_way_the_read_can_fail_is_unreadable_not_a_fact() {
        let reasons = [
            "MicPermissionGlue is not bound",
            "mic_permission glue: thread attach failed",
            "mic_permission glue: Java exception in isGranted",
        ];
        for why in reasons {
            let st = state_from_read(Err(why.to_string()));
            assert_eq!(st.state, MicGrantState::Unreadable, "{why}");
            assert_ne!(st.state, MicGrantState::Denied, "{why}");
            assert_ne!(st.state, MicGrantState::Granted, "{why}");
            assert_eq!(st.detail.as_deref(), Some(why));
        }
    }

    /// The request path keeps its three answers apart too, including "the dialog never went up"
    /// and "the OS did not answer in time".
    #[test]
    fn the_request_path_keeps_the_dialog_answers_apart() {
        let ok = |a| state_from_request(Ok(()), a);
        assert_eq!(
            ok(MicDialogAnswer::Answered(true)).state,
            MicGrantState::Granted
        );
        assert_eq!(
            ok(MicDialogAnswer::Answered(false)).state,
            MicGrantState::Denied
        );
        assert_eq!(ok(MicDialogAnswer::TimedOut).state, MicGrantState::TimedOut);

        // Posting failed: the dialog never went up. That is not a denial.
        let never_posted =
            state_from_request(Err("request threw".to_string()), MicDialogAnswer::TimedOut);
        assert_eq!(never_posted.state, MicGrantState::Unreadable);
        assert_ne!(never_posted.state, MicGrantState::Denied);
        assert_eq!(never_posted.detail.as_deref(), Some("request threw"));
    }

    /// A timeout is not a denial either: the dialog may still be on screen.
    #[test]
    fn no_answer_in_time_is_not_a_no() {
        let timed_out = state_from_request(Ok(()), MicDialogAnswer::TimedOut);
        assert_eq!(timed_out.state, MicGrantState::TimedOut);
        assert_ne!(timed_out.state, MicGrantState::Denied);
        assert!(!timed_out.granted);
        assert!(timed_out.detail.is_none());
    }

    /// The wire spellings the WebView branches on are the kebab-case ones.
    #[test]
    fn the_wire_spellings_are_the_kebab_case_ones_the_webview_branches_on() {
        for (st, want) in [
            (MicGrantState::Granted, "\"granted\""),
            (MicGrantState::Denied, "\"denied\""),
            (MicGrantState::Unreadable, "\"unreadable\""),
            (MicGrantState::TimedOut, "\"timed-out\""),
            (MicGrantState::Host, "\"host\""),
        ] {
            let json = serde_json::to_string(&st).expect("a unit enum serializes");
            assert_eq!(json, want);
        }
    }
}
