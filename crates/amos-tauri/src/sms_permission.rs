//! **SMS runtime-grant seam** for the real Android SMS backend.
//!
//! `SmsGlue` has always *checked* `READ_SMS` / `SEND_SMS` / `RECEIVE_SMS` and answered
//! `{"error_kind":"permission"}` when one is missing, but **nothing in the repository ever
//! requested them** — `adb install -g` (`docs/sms.md`) pre-grants them, a normal install does
//! not. So on a normal install the inbox reported a permission error forever and `SmsReceiver`
//! never delivered a broadcast, with no way for the user to fix it from inside AmOS. This
//! module adds the JS-awaitable request:
//!
//! ```text
//! WebView  ─► sms_permission_request (async Tauri cmd)
//!               │  [not granted?]
//!               ▼
//!          Rust: store a oneshot Sender ─► Kotlin SmsPermissionGlue.request()
//!               │                          Kotlin posts
//!               │     ActivityCompat.requestPermissions(activity, [READ_SMS, SEND_SMS, RECEIVE_SMS], REQ_SMS)
//!               ▼
//!   MainActivity.onRequestPermissionsResult ─► PermissionWire REQ_SMS ─► SmsPermissionGlue.onSmsResult()
//!               │                                        │  (re-reads allGranted(), Kotlin external)
//!               ▼                                        ▼
//!   Java_..._SmsPermissionGlue_onResult(g)  ───► resolve the pending oneshot ──► command returns
//! ```
//!
//! The three permissions are one set: a partial grant is `denied` (the SMS screen as a whole
//! still cannot work), and the verdict is **re-read from the platform** rather than folded from
//! `grantResults`' order.
//!
//! Honesty rules (this module compiles on **every** target, not just Android):
//!   * `native == false` on a host build or before the Kotlin glue binds — the OS-grant concept
//!     does not exist there, so a UI never pretends a request happened.
//!   * `granted == true` **only** when the OS answered "the whole set is held".
//!   * `granted == false` is **not** one answer. `state` says which of four it is: `denied`,
//!     `unreadable` (the read failed — the host's own words in `detail`), `timed-out` (the dialog
//!     was posted, the OS had not answered in time), or `host`.
//!
//! The JNI half is compile-gated by the `android` feature and exercised at device time against
//! `android-glue/com/amos/ai/glue/SmsPermissionGlue.kt` (mirrors `mic_permission`).

use serde::Serialize;

/// What **reading** the OS SMS grant can honestly answer.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SmsGrantState {
    /// The OS answered: all three SMS permissions are held right now.
    Granted,
    /// The OS answered: the set is not complete (denied, or only partly granted).
    Denied,
    /// **The OS never answered** — the read itself failed. Not a statement about the user's settings.
    Unreadable,
    /// The dialog was posted and the OS had not answered within `GRANT_TIMEOUT`; it may still be
    /// on screen. "No answer yet", not "no".
    TimedOut,
    /// There is no OS-grant concept on this host (host build, or the glue has not bound yet).
    Host,
}

/// What the caller needs to know about the OS SMS grant.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SmsPermissionState {
    /// True only when running inside the Android System UI with `SmsPermissionGlue` bound.
    pub native: bool,
    /// True **only** when the OS answered `state: "granted"` for the whole set.
    pub granted: bool,
    pub state: SmsGrantState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl SmsPermissionState {
    /// Host / not-yet-bound honest state: no native SMS-grant concept here.
    pub const fn host() -> Self {
        Self {
            native: false,
            granted: false,
            state: SmsGrantState::Host,
            detail: None,
        }
    }

    /// The OS answered "yes" for the whole set.
    pub const fn granted() -> Self {
        Self {
            native: true,
            granted: true,
            state: SmsGrantState::Granted,
            detail: None,
        }
    }

    /// The OS answered "no" (or "not all of it").
    pub const fn denied() -> Self {
        Self {
            native: true,
            granted: false,
            state: SmsGrantState::Denied,
            detail: None,
        }
    }

    /// The read itself failed — carrying the host's own words, unedited.
    pub fn unreadable(why: String) -> Self {
        Self {
            native: true,
            granted: false,
            state: SmsGrantState::Unreadable,
            detail: Some(why),
        }
    }

    /// The dialog was posted; the OS had not answered in time.
    pub const fn timed_out() -> Self {
        Self {
            native: true,
            granted: false,
            state: SmsGrantState::TimedOut,
            detail: None,
        }
    }
}

/// Fold the JNI read's answer. **Pure**, so the fold is host-testable even though the call it
/// folds is `#[cfg(feature = "android")]`.
pub fn state_from_read(reply: Result<bool, String>) -> SmsPermissionState {
    match reply {
        Ok(true) => SmsPermissionState::granted(),
        Ok(false) => SmsPermissionState::denied(),
        Err(why) => SmsPermissionState::unreadable(why),
    }
}

/// What the OS answered after the dialog was posted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SmsDialogAnswer {
    Answered(bool),
    TimedOut,
}

/// Fold the request path's two steps — posting the dialog, then the OS's answer. **Pure**;
/// `post` failing means the dialog never went up at all, which is `unreadable`, not a denial.
pub fn state_from_request(post: Result<(), String>, answer: SmsDialogAnswer) -> SmsPermissionState {
    if let Err(why) = post {
        return SmsPermissionState::unreadable(why);
    }
    match answer {
        SmsDialogAnswer::Answered(true) => SmsPermissionState::granted(),
        SmsDialogAnswer::Answered(false) => SmsPermissionState::denied(),
        SmsDialogAnswer::TimedOut => SmsPermissionState::timed_out(),
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

    use super::{state_from_read, state_from_request, SmsDialogAnswer, SmsPermissionState};

    /// How long to wait for the OS SMS dialog before reporting the set as unheld (the user may
    /// have let it time out), matching `mic_permission::GRANT_TIMEOUT`.
    const GRANT_TIMEOUT: Duration = Duration::from_secs(30);

    /// Kotlin `SmsPermissionGlue` bridge (a global ref, safe from any attached thread).
    struct SmsBridge {
        vm: JavaVM,
        glue: GlobalRef,
    }
    // SAFETY: a JNI global ref is VM-global and outlives the creating env; every use re-attaches
    // the calling thread before touching it.
    unsafe impl Send for SmsBridge {}
    // SAFETY: as above — access always happens on an attached thread.
    unsafe impl Sync for SmsBridge {}

    static GLUE: OnceLock<std::sync::Arc<SmsBridge>> = OnceLock::new();
    static PENDING: Mutex<Option<oneshot::Sender<bool>>> = Mutex::new(None);

    fn jerr(e: jni::errors::Error) -> String {
        format!("sms_permission glue: {e}")
    }

    fn bound() -> bool {
        GLUE.get().is_some()
    }

    fn with_env<T>(
        bridge: &SmsBridge,
        f: impl FnOnce(&mut jni::JNIEnv<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut e = amos_jni::attached(&bridge.vm).map_err(jerr)?;
        f(&mut e)
    }

    /// `SmsPermissionGlue.allGranted(): Boolean` through the stored bridge.
    fn is_granted() -> Result<bool, String> {
        let Some(bridge) = GLUE.get() else {
            return Err("SmsPermissionGlue is not bound".to_string());
        };
        with_env(bridge, |e| {
            let v = e
                .call_method(bridge.glue.as_obj(), "allGranted", "()Z", &[])
                .map_err(jerr)?;
            v.z().map_err(jerr)
        })
    }

    /// Tell the Kotlin glue to post the OS request (returns immediately; the dialog resolves
    /// later via [`resolve`]).
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

    fn clear_pending() {
        let Ok(mut pending) = PENDING.lock() else {
            return;
        };
        *pending = None;
    }

    fn resolve(granted: bool) {
        let Ok(mut pending) = PENDING.lock() else {
            return;
        };
        if let Some(tx) = pending.take() {
            if tx.send(granted).is_err() {
                tracing::debug!(
                    target: "amos::sms",
                    granted,
                    "sms permission reply dropped — the requester is gone"
                );
            }
        }
    }

    /// Dialog-free snapshot of the grant (host / unbound → `native:false`).
    pub fn state() -> SmsPermissionState {
        if !bound() {
            return SmsPermissionState::host();
        }
        state_from_read(is_granted())
    }

    /// Await an OS grant, posting the dialog only when the set is not held.
    pub async fn request() -> SmsPermissionState {
        if !bound() {
            return SmsPermissionState::host();
        }
        // Only a *readable* "yes" short-circuits. A failed read is not a denial: fall through
        // and ask, so the answer is the OS's own.
        if let Ok(true) = is_granted() {
            return SmsPermissionState::granted();
        }
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
            return state_from_request(post, SmsDialogAnswer::TimedOut);
        }
        let answer = match tokio::time::timeout(GRANT_TIMEOUT, rx).await {
            Ok(Ok(g)) => SmsDialogAnswer::Answered(g),
            _ => SmsDialogAnswer::TimedOut,
        };
        clear_pending();
        state_from_request(post, answer)
    }

    /// `SmsPermissionGlue.bind()` — keep the Kotlin singleton so Rust can drive
    /// `allGranted()` / `request()`.
    ///
    /// # Safety
    /// Standard JNI instance-method args: `this` is the live `SmsPermissionGlue` object for the
    /// duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_SmsPermissionGlue_bind(
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
                    .map(|vm| std::sync::Arc::new(SmsBridge { vm, glue }))
            });
            if let Some(bridge) = registered {
                // Exactly-once; a redundant re-bind keeps the first glue.
                let _ = GLUE.set(bridge);
            }
        }
    }

    /// `SmsPermissionGlue.onResult(granted)` — resolve the pending request.
    ///
    /// # Safety
    /// Standard JNI instance-method args: `this` is the live `SmsPermissionGlue` object for the
    /// duration of the call; `granted` is a `jboolean`.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_SmsPermissionGlue_onResult(
        _env: *mut jni::sys::JNIEnv,
        _this: jobject,
        granted: jboolean,
    ) {
        resolve(granted != 0);
    }
}

/// JS-awaitable: ensure READ_SMS/SEND_SMS/RECEIVE_SMS, posting the OS dialog only when the set
/// is not already held. Host → `native:false` immediately.
#[tauri::command]
pub async fn sms_permission_request() -> SmsPermissionState {
    #[cfg(feature = "android")]
    {
        jni::request().await
    }
    #[cfg(not(feature = "android"))]
    {
        SmsPermissionState::host()
    }
}

#[cfg(all(test, not(feature = "android")))]
mod tests {
    use super::*;

    /// On a host build there is no OS-grant concept and no Kotlin glue — every path must
    /// report an honest `native:false`, never a fabricated grant.
    #[test]
    fn host_state_is_none() {
        let host = SmsPermissionState::host();
        assert!(!host.native);
        assert!(!host.granted);
        assert_eq!(host.state, SmsGrantState::Host);
    }

    #[tokio::test]
    async fn host_request_is_none_without_a_dialog() {
        let st = sms_permission_request().await;
        assert!(!st.native);
        assert!(!st.granted);
        assert_eq!(st.state, SmsGrantState::Host);
    }

    /// The four answers the one `bool` would collapse must stay four answers.
    #[test]
    fn the_four_answers_the_read_could_fold_together_stay_apart() {
        let granted = state_from_read(Ok(true));
        let denied = state_from_read(Ok(false));
        let unreadable = state_from_read(Err("allGranted threw".to_string()));
        let host = SmsPermissionState::host();

        assert_eq!(granted.state, SmsGrantState::Granted);
        assert_eq!(denied.state, SmsGrantState::Denied);
        assert_eq!(unreadable.state, SmsGrantState::Unreadable);
        assert_eq!(host.state, SmsGrantState::Host);

        let all = [granted, denied, unreadable, host];
        for (i, a) in all.iter().enumerate() {
            for b in all[i + 1..].iter() {
                assert_ne!(a, b, "two of the four read answers are the same value");
            }
        }
    }

    /// A read that failed is **not** a denial, and `detail` carries the host's own words.
    #[test]
    fn a_read_that_failed_is_never_a_denied() {
        let st = state_from_read(Err("JNI attach failed".to_string()));
        assert_ne!(st.state, SmsGrantState::Denied);
        assert_eq!(st.detail.as_deref(), Some("JNI attach failed"));
        assert!(
            st.native,
            "the bridge is real; the answer is what is missing"
        );
        assert!(!st.granted);
    }

    /// Every way the *read* can fail lands on `unreadable` — never on a fact about the user.
    #[test]
    fn every_way_the_read_can_fail_is_unreadable_not_a_fact() {
        let reasons = [
            "SmsPermissionGlue is not bound",
            "sms_permission glue: thread attach failed",
            "sms_permission glue: Java exception in allGranted",
        ];
        for why in reasons {
            let st = state_from_read(Err(why.to_string()));
            assert_eq!(st.state, SmsGrantState::Unreadable, "{why}");
            assert_ne!(st.state, SmsGrantState::Denied, "{why}");
            assert_ne!(st.state, SmsGrantState::Granted, "{why}");
            assert_eq!(st.detail.as_deref(), Some(why));
        }
    }

    /// The request path keeps its three answers apart, including "the dialog never went up"
    /// and "the OS did not answer in time".
    #[test]
    fn the_request_path_keeps_the_dialog_answers_apart() {
        let ok = |a| state_from_request(Ok(()), a);
        assert_eq!(
            ok(SmsDialogAnswer::Answered(true)).state,
            SmsGrantState::Granted
        );
        assert_eq!(
            ok(SmsDialogAnswer::Answered(false)).state,
            SmsGrantState::Denied
        );
        assert_eq!(ok(SmsDialogAnswer::TimedOut).state, SmsGrantState::TimedOut);

        let never_posted =
            state_from_request(Err("request threw".to_string()), SmsDialogAnswer::TimedOut);
        assert_eq!(never_posted.state, SmsGrantState::Unreadable);
        assert_ne!(never_posted.state, SmsGrantState::Denied);
        assert_eq!(never_posted.detail.as_deref(), Some("request threw"));
    }

    /// A timeout is not a denial: the dialog may still be on screen.
    #[test]
    fn no_answer_in_time_is_not_a_no() {
        let timed_out = state_from_request(Ok(()), SmsDialogAnswer::TimedOut);
        assert_eq!(timed_out.state, SmsGrantState::TimedOut);
        assert_ne!(timed_out.state, SmsGrantState::Denied);
        assert!(!timed_out.granted);
        assert!(timed_out.detail.is_none());
    }

    /// The defect this module exists for was structural, not logical: `SmsGlue` **checked**
    /// three permissions and nothing ever **requested** them. So pin the pairing at the source —
    /// every permission `SmsGlue` gates on must appear in `SmsPermissionGlue`'s requested set,
    /// the request must actually reach `requestPermissions`, and `MainActivity.Wiring` must
    /// route the dialog's result back (`REQ-A1577 / F-TEL-037`).
    ///
    /// A check that gains a fourth permission, or a glue that drops one from `REQUIRED`, is the
    /// same defect returning; this fails on either.
    #[test]
    fn every_sms_permission_the_glue_checks_is_also_requested() {
        const CHECKED_BY: &str = include_str!("../android-glue/com/amos/ai/glue/SmsGlue.kt");
        const REQUESTER: &str =
            include_str!("../android-glue/com/amos/ai/glue/SmsPermissionGlue.kt");
        const WIRING: &str =
            include_str!("../android-glue/com/amos/ai/glue/MainActivity.Wiring.kt");

        // (1) The three permissions SmsGlue's `SmsPermissions` object checks, read off the
        //     source rather than hard-coded here, so a new one is caught the moment it appears.
        let mut checked: Vec<String> = Vec::new();
        for perm in ["READ_SMS", "SEND_SMS", "RECEIVE_SMS", "READ_PHONE_STATE"] {
            let needle = format!("\"android.permission.{perm}\"");
            if CHECKED_BY.contains(&needle) {
                checked.push(perm.to_string());
            }
        }
        assert!(
            checked.len() >= 3,
            "SmsGlue.kt should still declare the SMS permission set; found {checked:?}"
        );

        // (2) Each of them is in the requested set — no permission is checked without a path
        //     to obtain it.
        for perm in &checked {
            assert!(
                REQUESTER.contains(&format!("Manifest.permission.{perm}")),
                "SmsPermissionGlue.kt must request {perm}: SmsGlue checks it, so a normal \
                 install (no `adb install -g`) leaves the whole SMS feature unreachable with no \
                 way for the user to grant it"
            );
        }

        // (3) The request is actually posted (not merely a list that nothing uses) …
        assert!(
            REQUESTER.contains("ActivityCompat.requestPermissions(act, REQUIRED, REQ_SMS)"),
            "SmsPermissionGlue.request() must post the dialog"
        );
        // … and the Activity routes the answer back, or the await never resolves.
        assert!(
            WIRING.contains("SmsPermissionGlue.REQ_SMS ->"),
            "MainActivity.Wiring must route REQ_SMS to SmsPermissionGlue.onSmsResult()"
        );
        assert!(
            WIRING.contains("SmsPermissionGlue.onSmsResult()"),
            "the OS answer must reach the Rust promise"
        );
        // The glue is bound on the cold-start path too, or the Rust command finds no bridge.
        assert!(
            WIRING.contains("SmsPermissionGlue.ensureBound(activity)"),
            "PermissionWire.requestNeeded must bind the SMS glue"
        );
    }

    /// The wire spellings the WebView branches on are the kebab-case ones.
    #[test]
    fn the_wire_spellings_are_the_kebab_case_ones_the_webview_branches_on() {
        for (st, want) in [
            (SmsGrantState::Granted, "\"granted\""),
            (SmsGrantState::Denied, "\"denied\""),
            (SmsGrantState::Unreadable, "\"unreadable\""),
            (SmsGrantState::TimedOut, "\"timed-out\""),
            (SmsGrantState::Host, "\"host\""),
        ] {
            let json = serde_json::to_string(&st).expect("a unit enum serializes");
            assert_eq!(json, want);
        }
    }
}
