//! **Location native-grant seam** for the real `LocationManager` GNSS read.
//!
//! `SensorHost` reads the device fix through
//! `LocationManager#getLastKnownLocation("gps")` (`amos-sensor/src/android.rs`), and
//! that call is protected by a **dangerous** (runtime) permission. The WebView
//! `navigator.geolocation` path has its own prompt (the generated
//! `RustWebChromeClient`), but a **native** read triggers no dialog at all: with the
//! grant missing it simply throws `SecurityException`, which `SensorHost::read_gnss`
//! used to fold into `has_fix: false` — i.e. the screen said "searching for a
//! location" forever while the truth was "location was never granted" (REQ-A772 /
//! F-SH-228). This module adds a **JS-awaitable, location-only** request that does
//! not go through the WebView:
//!
//! ```text
//! WebView  ─► location_permission_request (async Tauri cmd)      location_permission_state
//!               │  [no grant?]                                         │
//!               ▼                                                      ▼
//!          Rust: store a oneshot Sender ─► Kotlin LocationPermissionGlue.request()
//!               │                          Kotlin posts
//!               │     ActivityCompat.requestPermissions(activity, [FINE, COARSE], REQ_LOCATION)
//!               ▼
//!   MainActivity.onRequestPermissionsResult ─► PermissionWire REQ_LOCATION
//!               │                                 └► LocationPermissionGlue.onLocationResult()
//!               ▼                                        │  (Kotlin external, reads the live grant)
//!   Java_..._LocationPermissionGlue_onResult(level) ──► resolve the pending oneshot ──► command returns
//! ```
//!
//! Honesty rules (this module is compiled on **every** target, not just Android):
//!   * `native == false` on a host build or before the Kotlin
//!     `LocationPermissionGlue` binds — the OS-grant concept does not exist there, so
//!     a UI never pretends a request happened.
//!   * the level is **three-state**, never a boolean: Android 12+ lets the user answer
//!     "approximate", and [`LocationGrant::Coarse`] is a real fix that is *not* the
//!     precise one. A boolean would have reported the approximate grant as "granted"
//!     and the UI would then have promised an accuracy the receiver never offered.
//!   * `None` when the user denied, the dialog never resolved, or no Android VM is
//!     present — never a fabricated grant.
//!
//! The JNI half is compile-gated by the `android` feature and is only ever
//! exercised at device time against the Kotlin template in
//! `android-glue/com/amos/ai/glue/LocationPermissionGlue.kt` (mirrors the
//! `mic_permission` bring-up pattern).

use serde::Serialize;

/// What the OS location grant currently is.
///
/// Three states, because Android 12+ lets the user grant **approximate** location:
/// the UI must be able to tell "precise fix" from "approximate fix" from "no fix",
/// and folding the middle one into either end would make it lie.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocationGrant {
    /// No location permission (or no Android VM to ask).
    None,
    /// `ACCESS_COARSE_LOCATION` only — a real fix, but approximate.
    Coarse,
    /// `ACCESS_FINE_LOCATION` — the precise providers.
    Fine,
}

impl LocationGrant {
    /// The wire spelling the frontend keys off (mirrors `vocabMirror`-style tables).
    pub const fn as_str(self) -> &'static str {
        match self {
            LocationGrant::None => "none",
            LocationGrant::Coarse => "coarse",
            LocationGrant::Fine => "fine",
        }
    }

    /// Whether any location call can succeed with this grant.
    pub const fn is_granted(self) -> bool {
        !matches!(self, LocationGrant::None)
    }
}

/// What the caller needs to know about the OS location grant.
///
/// * `native` — true only when running inside the Android System UI with the Kotlin
///   `LocationPermissionGlue` bound (i.e. the OS-grant concept exists here).
/// * `grant` — the level currently held.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct LocationPermissionState {
    pub native: bool,
    pub grant: LocationGrant,
}

impl LocationPermissionState {
    /// Host / not-yet-bound honest state: no native location-grant concept.
    pub const fn none() -> Self {
        Self {
            native: false,
            grant: LocationGrant::None,
        }
    }
}

/// Map the Kotlin `GRANT_*` level onto the typed grant.
///
/// Anything that is not the two known levels is [`LocationGrant::None`]: an
/// unrecognised integer from a drifted glue must not be read as a grant (the same
/// rule `vocabMirror` enforces for every other cross-language vocabulary).
pub const fn grant_from_level(level: i32) -> LocationGrant {
    match level {
        2 => LocationGrant::Fine,
        1 => LocationGrant::Coarse,
        _ => LocationGrant::None,
    }
}

#[cfg(feature = "android")]
mod jni {
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use jni::objects::{GlobalRef, JObject};
    use jni::sys::{jint, jobject};
    use jni::JavaVM;
    use tokio::sync::oneshot;

    use super::{grant_from_level, LocationGrant, LocationPermissionState};

    /// How long to wait for the OS location dialog before reporting `none` (the user
    /// may have let it time out or hit "don't ask").
    const GRANT_TIMEOUT: Duration = Duration::from_secs(30);

    /// Kotlin `LocationPermissionGlue` bridge (a global ref, safe from any attached
    /// thread; each use re-attaches the thread).
    struct LocationBridge {
        vm: JavaVM,
        glue: GlobalRef,
    }
    // SAFETY: a JNI global ref is VM-global and outlives the creating env; every
    // use re-attaches the calling thread before touching it.
    unsafe impl Send for LocationBridge {}
    // SAFETY: as above — access always happens on an attached thread.
    unsafe impl Sync for LocationBridge {}

    /// The one installed glue. `OnceLock` + redundant re-bind keeps the first.
    static GLUE: OnceLock<std::sync::Arc<LocationBridge>> = OnceLock::new();

    /// A pending grant that a `location_permission_request` is awaiting.
    static PENDING: Mutex<Option<oneshot::Sender<LocationGrant>>> = Mutex::new(None);

    fn jerr(e: jni::errors::Error) -> String {
        format!("location_permission glue: {e}")
    }

    /// True when the Kotlin glue is bound (an Android System UI is live).
    fn bound() -> bool {
        GLUE.get().is_some()
    }

    /// Attach this thread to the VM (auto-detaches when the guard drops). Mirrors
    /// `mic_permission`/`incall`: Tauri command threads are short-lived, so a nested
    /// attach guard is preferred over a permanent attach here.
    fn with_env<T>(
        bridge: &LocationBridge,
        f: impl FnOnce(&mut jni::JNIEnv<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        // Shared helper: attach with a clean exception state (REQ-A186).
        let mut e = amos_jni::attached(&bridge.vm).map_err(jerr)?;
        f(&mut e)
    }

    /// `LocationPermissionGlue.grantLevel(): Int` through the stored bridge.
    fn grant_level() -> Result<LocationGrant, String> {
        let Some(bridge) = GLUE.get() else {
            return Ok(LocationGrant::None);
        };
        with_env(bridge, |e| {
            let v = e
                .call_method(bridge.glue.as_obj(), "grantLevel", "()I", &[])
                .map_err(jerr)?;
            let level = v.i().map_err(jerr)?;
            Ok(grant_from_level(level))
        })
    }

    /// Tell the Kotlin glue to post the OS location request (returns immediately; the
    /// dialog resolves later via [`on_result`]).
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

    /// Resolve a pending `location_permission_request` from the Kotlin upcall.
    fn resolve(grant: LocationGrant) {
        let Ok(mut pending) = PENDING.lock() else {
            return;
        };
        if let Some(tx) = pending.take() {
            // The requester may have gone (its command timed out) — then the answer has
            // no receiver and *that* is the visible fact (REQ-A187).
            if tx.send(grant).is_err() {
                tracing::debug!(
                    target: "amos::location",
                    grant = grant.as_str(),
                    "location permission reply dropped — the requester is gone"
                );
            }
        }
    }

    /// Whether any location grant is held — the host-visible helper `sensor_host` uses to
    /// tell a **failed** GNSS read (usually the missing grant) apart from "not locked yet".
    pub fn grant_held() -> bool {
        grant_level().map(|g| g.is_granted()).unwrap_or(false)
    }

    /// Dialog-free snapshot of the grant (host / unbound → `native:false`).
    pub fn state() -> LocationPermissionState {
        if !bound() {
            return LocationPermissionState::none();
        }
        LocationPermissionState {
            native: true,
            grant: grant_level().unwrap_or(LocationGrant::None),
        }
    }

    /// Await an OS grant, posting the dialog only when no grant is held.
    pub async fn request() -> LocationPermissionState {
        if !bound() {
            return LocationPermissionState::none();
        }
        let held = grant_level().unwrap_or(LocationGrant::None);
        if held.is_granted() {
            return LocationPermissionState {
                native: true,
                grant: held,
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
        let grant = match tokio::time::timeout(GRANT_TIMEOUT, rx).await {
            Ok(Ok(g)) => g,
            _ => LocationGrant::None,
        };
        // A timeout leaves the token in place; clear it so the next request works.
        clear_pending();
        LocationPermissionState {
            native: true,
            grant,
        }
    }

    /// `LocationPermissionGlue.bind()` — keep the Kotlin singleton so Rust can drive
    /// `grantLevel()` / `request()`.
    ///
    /// # Safety
    /// Standard JNI instance-method args: `this` is the live `LocationPermissionGlue`
    /// object for the duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_LocationPermissionGlue_bind(
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
                    .map(|vm| std::sync::Arc::new(LocationBridge { vm, glue }))
            });
            if let Some(bridge) = registered {
                // Exactly-once; a redundant re-bind simply keeps the first glue. Safe because the
                // Activity is not recreated under us — the generated manifest's `configChanges`
                // is what makes that true, and `scripts/android-glue-mirror.sh` gates it (REQ-A448).
                let _ = GLUE.set(bridge);
            }
        }
    }

    /// `LocationPermissionGlue.onResult(level)` — resolve the pending request.
    ///
    /// # Safety
    /// Standard JNI instance-method args: `this` is the live `LocationPermissionGlue`
    /// object for the duration of the call; `level` is a `jint` `GRANT_*` value.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_LocationPermissionGlue_onResult(
        _env: *mut jni::sys::JNIEnv,
        _this: jobject,
        level: jint,
    ) {
        resolve(grant_from_level(level));
    }
}

/// Whether **any** location grant is currently held (i.e. anything above `none`).
///
/// Host / unbound → `false`: there is no OS-grant concept here, and reporting `true`
/// would make a failed read look explained. Consumed by
/// [`crate::sensor_host::read_gnss`] to keep a permission denial out of "still searching"
/// (REQ-A772 / F-SH-228).
pub fn grant_held() -> bool {
    #[cfg(feature = "android")]
    {
        jni::grant_held()
    }
    #[cfg(not(feature = "android"))]
    {
        false
    }
}

/// Dialog-free snapshot of the location grant. Host / unbound → `native:false`.
#[tauri::command]
pub fn location_permission_state() -> LocationPermissionState {
    #[cfg(feature = "android")]
    {
        jni::state()
    }
    #[cfg(not(feature = "android"))]
    {
        LocationPermissionState::none()
    }
}

/// JS-awaitable: ensure the OS location grant for the native `LocationManager` read,
/// posting the dialog only when no grant is held. Host → `native:false` immediately.
#[tauri::command]
pub async fn location_permission_request() -> LocationPermissionState {
    #[cfg(feature = "android")]
    {
        jni::request().await
    }
    #[cfg(not(feature = "android"))]
    {
        LocationPermissionState::none()
    }
}

#[cfg(all(test, not(feature = "android")))]
mod tests {
    use super::*;

    /// On a host build there is no OS-grant concept and no Kotlin glue — the
    /// commands must report an honest `native:false`, never a fabricated grant.
    #[test]
    fn host_state_is_none() {
        assert_eq!(location_permission_state(), LocationPermissionState::none());
    }

    #[tokio::test]
    async fn host_request_is_none_without_a_dialog() {
        let st = location_permission_request().await;
        assert!(!st.native);
        assert_eq!(st.grant, LocationGrant::None);
    }

    /// The three levels must map one-to-one; an unrecognised integer is **not** a grant.
    #[test]
    fn levels_map_onto_the_three_states() {
        assert_eq!(grant_from_level(0), LocationGrant::None);
        assert_eq!(grant_from_level(1), LocationGrant::Coarse);
        assert_eq!(grant_from_level(2), LocationGrant::Fine);
    }

    /// A drifted glue answering with something this build does not know must not be
    /// read as permission — the whole point of the seam is to never overstate a grant.
    #[test]
    fn an_unknown_level_is_not_a_grant() {
        for level in [-1, 3, 4, i32::MAX, i32::MIN] {
            assert_eq!(
                grant_from_level(level),
                LocationGrant::None,
                "level {level} must not be read as a grant"
            );
            assert!(!grant_from_level(level).is_granted());
        }
    }

    /// "Approximate" is granted but is not the precise grant — a boolean could not say
    /// this, and the UI needs it to avoid promising a precision nobody offered.
    #[test]
    fn coarse_is_granted_but_not_fine() {
        assert!(LocationGrant::Coarse.is_granted());
        assert!(LocationGrant::Fine.is_granted());
        assert!(!LocationGrant::None.is_granted());
        assert_ne!(LocationGrant::Coarse, LocationGrant::Fine);
    }

    /// The wire spellings the frontend keys off.
    #[test]
    fn wire_spellings_are_stable() {
        assert_eq!(LocationGrant::None.as_str(), "none");
        assert_eq!(LocationGrant::Coarse.as_str(), "coarse");
        assert_eq!(LocationGrant::Fine.as_str(), "fine");
    }

    /// The serialised shape is what the TS `LocationPermissionState` mirrors: a
    /// kebab-case `grant` string, not an integer.
    #[test]
    fn serialises_grant_as_a_kebab_case_string() {
        let st = LocationPermissionState {
            native: true,
            grant: LocationGrant::Coarse,
        };
        let json = serde_json::to_value(st).expect("serialisable");
        assert_eq!(json["native"], serde_json::json!(true));
        assert_eq!(json["grant"], serde_json::json!("coarse"));
    }
}
