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
//! * The dialed number is filtered to `+` and ASCII digits, bounded at
//!   [`MAX_DIAL_CHARS`] characters (E.164 + headroom), and the resulting `tel:…`
//!   string is the **only** payload handed to the platform — anything that
//!   survives those two gates is what Telecom actually tries to place.
//!
//! Only feature `android` has a JVM/`Context`; host builds report "unsupported".

use serde::Serialize;

#[cfg(feature = "android")]
/// `android.content.Intent.ACTION_CALL` — fires Telecom's outgoing call flow.
///
/// # Why ACTION_CALL (not `TelecomManager#placeCall`)
///
/// `TelecomManager#placeCall(Uri, Bundle)` is the **modern** dialer entry point
/// (introduced in API 23, refined in API 26). It is, however, marked
/// `@SystemApi` until API 26 (`carriesSystemPermission` = system/dialer-only) and
/// is only callable by the system **default phone app** (RoleManager.ROLE_DIALER)
/// in 28+. AmOS is not pre-installed as a default dialer — the user grants that
/// role themselves — so on a fresh install `placeCall` returns `null` and the
/// call is silently dropped. ACTION_CALL is the public-API path that requires
/// only the `CALL_PHONE` runtime permission, fits a non-preloaded System-UI APK,
/// and is exactly what `amos-telephony`'s Android provider uses for the same
/// reason.
///
/// **Note (REQ-A1222):** this intent is *not* only reached when AmOS is not the
/// default dialer. `placeOutgoingCall` (`lib/phone.ts`) fires it whenever the daemon
/// did not answer, whatever the role — and when AmOS **does** hold ROLE_DIALER, Telecom
/// resolves the call straight back into our own `AmosInCallService`, so the caller must
/// adopt that call (fixed id `real`, see `incall.rs`) instead of assuming another
/// dialer owns it. The earlier wording here asserted the opposite and is what let a
/// live outgoing call end up with no in-call surface at all.
///
/// # API reality check
///
/// The exact `Intent(ACTION_CALL, tel:…)` shape below was confirmed against
/// the `android.jar` shipped with `compileSdk = 34`: no signature|privileged
/// permission is required, and the platform resolves the call through Telecom
/// (so a default dialer that the user has chosen still gets to render its own
/// in-call UI — this does **not** bypass it).
const ACTION_CALL: &str = "android.intent.action.CALL";
#[cfg(feature = "android")]
/// `Intent.FLAG_ACTIVITY_NEW_TASK` — dialing from an app Context (no Activity host).
const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;
#[cfg(feature = "android")]
const TEL_SCHEME: &str = "tel:";

/// Whether AmOS is the device's **default phone app** (`RoleManager.ROLE_DIALER`), and
/// whether a request for that role can be delivered right now.
///
/// The field names and the three-valued shape are deliberately the ones
/// `BlocklistStatusOut` uses for the sibling ROLE_CALL_SCREENING
/// (`crates/amos-tauri/src/blocklist.rs`): the UI branches on exactly the same
/// "held / askable / neither" triple, so the two role surfaces cannot drift apart.
///
/// `role_held` is the **platform's** answer (`RoleManager#isRoleHeld` on API 29+,
/// `TelecomManager#defaultDialerPackage` below it) — *not* "an InCallService happens to
/// be bound", which is `crate::incall::is_default_dialer_bound` and answers `false`
/// between calls on a correctly configured phone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DialerRoleStatus {
    /// This build/device can hold the role at all (Android + a telephony feature).
    pub role_supported: bool,
    /// AmOS currently **is** the default phone app, per the platform.
    pub role_held: bool,
    /// A role request can be delivered (the native glue is bound), so the UI may offer
    /// the button. `false` means "we could not ask" — never a verdict.
    pub role_requestable: bool,
}

impl DialerRoleStatus {
    /// "We could not ask": no glue, no JVM, a desktop build. All three fields `false`,
    /// so the UI says "unsupported / not ready" instead of claiming the role is unheld.
    pub fn unsupported() -> Self {
        Self {
            role_supported: false,
            role_held: false,
            role_requestable: false,
        }
    }
}

/// Fold the three Kotlin probes into a [`DialerRoleStatus`].
///
/// Pure, so every arm is unit-tested without a JVM. The rules:
/// * `supported: Err` (no JNI, no glue) or an honest `false` → all three `false`: a device
///   that cannot hold the role has no requestable state either.
/// * `held: Err` collapses to `false` — deliberately **not** promoted into a device claim.
///   The UI gates on `role_requestable` before rendering anything, and `false` here is the
///   safe direction (it offers the grant, never asserts one).
/// * `role_requestable` requires `supported && ready`: offering a button whose request
///   cannot be delivered is the dishonest-success shape `BlocklistGlue` records.
pub fn dialer_role_status_from(
    supported: Result<bool, String>,
    held: Result<bool, String>,
    ready: Result<bool, String>,
) -> DialerRoleStatus {
    let supported = match supported {
        Ok(supported) => supported,
        Err(_) => return DialerRoleStatus::unsupported(),
    };
    DialerRoleStatus {
        role_supported: supported,
        role_held: held.unwrap_or(false),
        role_requestable: supported && ready.unwrap_or(false),
    }
}

/// Keep only dialable digits (`+` allowed) from a user-typed number.
fn digits_only(number: &str) -> String {
    number
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect()
}

/// Maximum dialable characters the host will hand to the platform.
///
/// E.164 caps international numbers at 15 digits + an optional leading `+` (16
/// chars total). Domestic numbers and emergency shorts (`110`/`112`/`911`/`*#06#`)
/// fit comfortably under that ceiling; the 32 here is a hard **platform-bound**
/// guard against an absurd input that would either overflow the Intent extras
/// buffer or trigger Telecom's own "not a phone number" path with a confusing
/// generic error. Anything beyond this is refused at the command seam with an
/// honest reason, before the JVM is ever touched.
pub const MAX_DIAL_CHARS: usize = 32;

/// What one boot **attach** attempt means, shared by the two JNI entries that store a
/// process-wide `Context` (`real_dial::android_impl`, `sensor_host::android_ctx`).
///
/// The Kotlin glue calls its `nativeAttach` / `attachContext` on *every* `onStart`, so
/// after the first the slot is already filled. Both binds are documented idempotent —
/// "first caller wins" — and the Application `Context` the first caller stored is the
/// one every later caller needs, so a taken slot is **success**, not a failure.
#[derive(Debug, PartialEq, Eq)]
#[cfg(any(feature = "android", test))]
pub(crate) enum AttachOutcome {
    /// A fresh `Context` was installed by this attempt.
    Attached,
    /// A `Context` was already installed: an idempotent re-attach, nothing to report.
    AlreadyBound,
    /// The bind genuinely failed and nothing is installed — the **only** case in which
    /// the "stays on the mock" sentence is true.
    Failed,
}

/// Classify one boot-attach attempt: `bind_failed` is the bind call's `Err`, and
/// `bound_after` is the registry state read *after* the attempt.
///
/// Pure and JNI-free, so the rule is pinned by the default host test run — the JNI
/// entries that use it cannot run without a JVM. [`AttachOutcome::AlreadyBound`] exists
/// because the two entries used to fold **every** `Err` into one warning,
/// `"… not bound — … stay on the mock"`; the only non-genuine `Err` they can get is
/// precisely the taken slot, which the bind itself reports as
/// `Err("… is already bound")`. On every boot after the first the log therefore denied
/// its own `error=` field: `"real dial context not bound — dialing stays on the mock"`
/// printed beside `error=real dial context is already bound` (device-observed on the
/// S5 / API 34). The newest sibling that binds this way
/// (`alarm_sched::android::install` → `tracing::debug!("alarm binding attach skipped: …")`)
/// already treats it as a benign skip.
#[cfg(any(feature = "android", test))]
pub(crate) fn attach_outcome(bind_failed: bool, bound_after: bool) -> AttachOutcome {
    match (bind_failed, bound_after) {
        (false, _) => AttachOutcome::Attached,
        // A taken slot is success, not failure: this is the idempotent re-attach.
        (true, true) => AttachOutcome::AlreadyBound,
        (true, false) => AttachOutcome::Failed,
    }
}

/// `pub(crate)` because `TelephonyGlue` is one Kotlin object answering questions
/// for more than one Rust module: the dialer-role probes here, and
/// `crate::cellular`'s signal-strength probes. The class resolution below is the
/// load-bearing part (a Tauri command runs on a tokio worker whose own class
/// loader cannot see the app's classes), so it is shared rather than copied.
#[cfg(feature = "android")]
pub(crate) mod android_impl {
    use super::*;
    use jni::objects::{GlobalRef, JObject, JValue};
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;

    /// Process-wide handle to the Java app `Context` used to fire dial intents.
    /// A JNI *global* ref is VM-global; each use re-attaches the thread first (the
    /// same pattern as the repo's radio/flashlight providers & `clipboard_glue`).
    struct AndroidContext(GlobalRef);

    // SAFETY: a JNI global ref is VM-global and outlives the creating env; every use
    // re-attaches the calling thread. Dropping is handled by `GlobalRef`.
    unsafe impl Send for AndroidContext {}
    // SAFETY: `Sync` is what lets the process-wide `OnceLock<(JavaVM, AndroidContext)>`
    // be shared by any thread. That is sound because JNI guarantees thread safety for a
    // global ref as long as the calling thread is attached (which `with_env` does before
    // every use) — no thread ever touches another thread's JNI env or local refs.
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
        let (vm, ctx) = CTX.get().ok_or_else(|| {
            "real dial context not bound — call TelephonyGlue.nativeAttach at boot".to_string()
        })?;
        // Shared helper: attach with a clean exception state (REQ-A186).
        let mut env =
            amos_jni::attached(vm).map_err(|e| format!("failed to attach to JVM: {e}"))?;

        let action = env.new_string(ACTION_CALL).map_err(|e| e.to_string())?;
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

    /// Resolve `com.amos.ai.glue.TelephonyGlue` through the **stored Context's** class loader.
    ///
    /// Not `env.find_class`: that uses the *calling thread's* loader, and a Tauri command runs
    /// on a tokio worker whose loader is the bootstrap one, where the app class does not exist.
    /// `BlocklistGlue` / `incall` record that as an allowlisted limitation (they only ever ask
    /// from a Java upcall thread); here the question is asked from a command, so the app loader
    /// is fetched from the `Context` we already hold and the failure mode never arises.
    fn glue_class<'a>(env: &mut JNIEnv<'a>) -> Result<jni::objects::JClass<'a>, String> {
        let (_, ctx) = CTX
            .get()
            .ok_or_else(|| "dialer role: no app context bound".to_string())?;
        let loader = amos_jni::jni_call!(
            env,
            env.call_method(
                ctx.0.as_obj(),
                "getClassLoader",
                "()Ljava/lang/ClassLoader;",
                &[],
            )
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("dialer role: no class loader: {e}"))?;
        let name = env
            .new_string("com.amos.ai.glue.TelephonyGlue")
            .map_err(|e| e.to_string())?;
        let class = amos_jni::jni_call!(
            env,
            env.call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&name)],
            )
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("dialer role: TelephonyGlue not resolvable: {e}"))?;
        // SAFETY: `class` is the live local reference `loadClass` just returned (a
        // `java.lang.Class` that is valid for the rest of this native call), and `JClass`
        // is the same `jobject` wrapper — the re-wrap only restates what the reference
        // already is through the type system, tying it to `env`'s lifetime `'a`.
        Ok(unsafe { jni::objects::JClass::from_raw(class.as_raw()) })
    }

    /// Whether the runtime `CALL_PHONE` grant is held, per the Kotlin glue.
    ///
    /// `Err` means the question could not be asked at all (no glue, a JNI failure) — the
    /// caller must **not** read that as "granted" (REQ-A1626).
    pub fn call_permission_granted() -> Result<bool, String> {
        call_static_bool("callPermissionGrantedBound")
    }

    /// Call a `public static` boolean method on the Kotlin `TelephonyGlue` object.
    pub(crate) fn call_static_bool(method: &str) -> Result<bool, String> {
        let (vm, _) = CTX
            .get()
            .ok_or_else(|| "dialer role: TelephonyGlue was never bound".to_string())?;
        // Shared helper: attach with a clean exception state (REQ-A186).
        let mut env = amos_jni::attached(vm).map_err(|e| format!("dialer role attach: {e}"))?;
        let class = glue_class(&mut env)?;
        let value = amos_jni::jni_call!(env, env.call_static_method(&class, method, "()Z", &[]))
            .map_err(|e| format!("dialer role: {method} failed: {e}"))?;
        value.z().map_err(|e| e.to_string())
    }

    /// Call a `public static int` method on the Kotlin `TelephonyGlue` object —
    /// the sibling of [`call_static_bool`] for the cellular signal level.
    pub(crate) fn call_static_int(method: &str) -> Result<i32, String> {
        let (vm, _) = CTX
            .get()
            .ok_or_else(|| "telephony glue: not bound".to_string())?;
        // Shared helper: attach with a clean exception state (REQ-A186).
        let mut env = amos_jni::attached(vm).map_err(|e| format!("telephony glue attach: {e}"))?;
        let class = glue_class(&mut env)?;
        let value = amos_jni::jni_call!(env, env.call_static_method(&class, method, "()I", &[]))
            .map_err(|e| format!("telephony glue: {method} failed: {e}"))?;
        value.i().map_err(|e| e.to_string())
    }

    /// (supported, held, ready) from the Kotlin glue, or `Err` when there is no glue at all.
    pub fn role_probe() -> (bool, bool, bool) {
        use super::dialer_role_status_from;
        let status = dialer_role_status_from(
            call_static_bool("dialerRoleSupportedBound"),
            call_static_bool("dialerRoleHeldBound"),
            call_static_bool("dialerRoleReady"),
        );
        (
            status.role_supported,
            status.role_held,
            status.role_requestable,
        )
    }

    /// Post the system ROLE_DIALER dialog from the glue.
    pub fn request_role() -> Result<bool, String> {
        call_static_bool("requestDialerRoleBound")
    }
}

#[cfg(feature = "android")]
/// Device: ask the bound Kotlin glue.
pub fn dialer_role_probe() -> DialerRoleStatus {
    let (supported, held, requestable) = android_impl::role_probe();
    DialerRoleStatus {
        role_supported: supported,
        role_held: held,
        role_requestable: requestable,
    }
}

/// Host default: there is no Android default-phone-app role (and no glue to reach).
///
/// Reported honestly as "unsupported" rather than pretending the feature exists, so the
/// desktop UI says so instead of rendering a dead button. Spelled through the fold, like
/// `blocklist`'s twin, so the desktop answer and the device answer cannot drift apart.
#[cfg(not(feature = "android"))]
pub fn dialer_role_probe() -> DialerRoleStatus {
    let absent = Err("the default phone app role is only available on Android".to_string());
    dialer_role_status_from(absent.clone(), absent.clone(), absent)
}

#[cfg(feature = "android")]
/// Device: post the dialog through the glue.
pub fn request_dialer_role() -> Result<bool, String> {
    android_impl::request_role()
}

/// Host default: refuse rather than silently do nothing.
#[cfg(not(feature = "android"))]
pub fn request_dialer_role() -> Result<bool, String> {
    Err("the default phone app role is only available on Android".to_string())
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
            // The dial context is what makes ACTION_CALL real; a silent bind failure
            // would leave "real dialing" on the mock with no symptom (REQ-A187).
            // `bind` can also answer `Err` for the **idempotent** re-attach (the Kotlin
            // glue calls this on every `onStart`, and "first caller wins"), which is not
            // a failure: the context is bound. The two cases are told apart by the
            // registry's own state, never assumed from the `Err` (REQ-A1865 / F-TEL-049).
            let bound = android_impl::bind(vm, &e, ctx);
            match attach_outcome(bound.is_err(), android_impl::is_bound()) {
                AttachOutcome::Attached => tracing::info!(
                    target: "amos::telephony",
                    "dial context attached (TelephonyGlue.nativeAttach)"
                ),
                AttachOutcome::AlreadyBound => tracing::debug!(
                    target: "amos::telephony",
                    "dial context already bound — re-attach skipped, dialing is real"
                ),
                AttachOutcome::Failed => tracing::warn!(
                    target: "amos::telephony",
                    error = %bound.err().unwrap_or_default(),
                    "real dial context not bound — dialing stays on the mock"
                ),
            }
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
    // Bound the dial string at the command seam — never let a 4 KiB paste reach
    // the platform's Intent parsing path, where the error message would be a
    // generic "could not dial" rather than the truthful "too long".
    if cleaned.len() > MAX_DIAL_CHARS {
        return Err(format!(
            "number too long: {} chars (max {MAX_DIAL_CHARS})",
            cleaned.len()
        ));
    }
    #[cfg(feature = "android")]
    {
        // Refuse from the same fold the status command reports, so the two can never
        // disagree on *why*. Firing `ACTION_CALL` without the grant throws a
        // `SecurityException` whose message is a generic platform string; the caller
        // never learns it is the permission (REQ-A1626).
        let status = real_dial_status_from(
            true,
            android_impl::is_bound(),
            android_impl::call_permission_granted(),
        );
        if !status.available {
            return Err(status.reason);
        }
        android_impl::dial(&cleaned).map_err(|e| format!("real dial failed: {e}"))?;
        Ok(format!("dialing {cleaned} via Android Telecom"))
    }
    #[cfg(not(feature = "android"))]
    {
        Err("real dial is only available in the on-device (Android) System UI build".to_string())
    }
}

/// Whether this host can place a **real** call through the platform telephony stack.
///
/// Two distinct facts, deliberately not folded into one flag:
/// * `on_device` — this build is an on-device (Android) System UI build that *can* dial.
///   False on a desktop host, which has no telephony stack at all.
/// * `available` — a real call can be fired *right now* (on-device, the dial context bound
///   at boot, **and** the caller holding the `CALL_PHONE` grant). False on a device whose
///   context is missing or whose caller has not granted `CALL_PHONE`.
///
/// The distinction is what keeps a desktop demo honest without letting a real phone fake
/// a call: a caller that could not place a real call on a device (`on_device && !available`)
/// must report failure rather than fall back to an in-process simulation, while a desktop
/// host may use the simulation because there is no alternative there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RealDialStatus {
    /// This build could place a real call at all (on-device System UI build).
    pub on_device: bool,
    /// A real call can be fired right now.
    pub available: bool,
    /// Why `available` is false, in the host's own words ("" when available).
    pub reason: String,
}

/// Fold the three facts into a [`RealDialStatus`]. Pure, so every arm is unit-tested.
///
/// `granted` is the `CALL_PHONE` answer from the platform, and it is a `Result` on
/// purpose: `bind` is **unconditional** at boot, so a phone whose user denied the
/// permission still has a bound context. Folding only `bound` (the shape before
/// REQ-A1626) reported `available: true` with an empty reason on exactly that phone,
/// and a caller reading it would route the dial into an `ACTION_CALL` the platform
/// rejects — while the honest sentence ("grant CALL_PHONE") was unreachable. An `Err`
/// (the question could not be asked) is **not** folded into `true` for the same reason.
pub fn real_dial_status_from(
    on_device: bool,
    bound: bool,
    granted: Result<bool, String>,
) -> RealDialStatus {
    if !on_device {
        return RealDialStatus {
            on_device: false,
            available: false,
            reason: "real dial is only available in the on-device (Android) System UI build"
                .to_string(),
        };
    }
    if !bound {
        return RealDialStatus {
            on_device: true,
            available: false,
            reason: "real dial context not bound — grant CALL_PHONE and re-open the app"
                .to_string(),
        };
    }
    match granted {
        Ok(true) => RealDialStatus {
            on_device: true,
            available: true,
            reason: String::new(),
        },
        Ok(false) => RealDialStatus {
            on_device: true,
            available: false,
            reason: "CALL_PHONE not granted — allow the phone permission to place real calls"
                .to_string(),
        },
        Err(e) => RealDialStatus {
            on_device: true,
            available: false,
            reason: format!("could not read the CALL_PHONE grant: {e}"),
        },
    }
}

/// Tauri command: can this host place a real call right now, and if not, why not?
///
/// Cheap (two JNI booleans on device, no I/O), so the dialer may ask it on the dial path.
#[tauri::command]
pub fn telephony_real_dial_status() -> RealDialStatus {
    #[cfg(feature = "android")]
    {
        return real_dial_status_from(
            true,
            android_impl::is_bound(),
            android_impl::call_permission_granted(),
        );
    }
    #[cfg(not(feature = "android"))]
    {
        real_dial_status_from(false, false, Ok(false))
    }
}

/// Tauri command: is AmOS the device's default phone app, and can it be asked to become it?
///
/// Cheap and I/O-free beyond three JNI booleans, so the Phone screen may poll it on mount —
/// the same contract `blocklist_status` has (its sibling for ROLE_CALL_SCREENING).
///
/// This answers the **device** question the whole real in-call bridge hangs off
/// (`incall.rs`'s answer / hang-up / mute / speaker / hold / DTMF / recording each refuse
/// with "AmOS is not the default phone app"), so a user who is not the dialer can be told
/// so *and* offered the grant, instead of meeting that refusal with no remedy.
#[tauri::command]
pub fn telephony_default_dialer_status() -> DialerRoleStatus {
    dialer_role_probe()
}

/// Tauri command: post the system dialog that grants ROLE_DIALER (foreground, user-initiated).
///
/// Returns `true` when the dialog was posted **or** the role is already held — never "the
/// user accepted", which only a later [`telephony_default_dialer_status`] read can answer.
#[tauri::command]
pub fn telephony_request_default_dialer() -> Result<bool, String> {
    request_dialer_role()
}

#[cfg(test)]
mod tests {
    use super::{digits_only, MAX_DIAL_CHARS};

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

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn max_dial_chars_constant_covers_e164_plus_emergency_shorts() {
        // 16 chars fits E.164 (`+8613800138000`); the constant must be >= that
        // or genuine international calls get refused at the seam.
        assert!(MAX_DIAL_CHARS >= 16, "MAX_DIAL_CHARS must cover E.164");
        // It must also leave room for legacy short codes like `*#06#` (5 chars).
        assert!(MAX_DIAL_CHARS >= 5);
    }

    #[test]
    fn digits_only_passes_a_max_plus_buffer_unchanged() {
        // 16-char E.164-style number survives the cleaner unchanged.
        let s = "+8613800138000";
        assert_eq!(digits_only(s), s);
        assert!(digits_only(s).len() <= MAX_DIAL_CHARS);
    }

    #[test]
    fn digit_filter_preserves_a_5kb_paste_for_upper_layer_to_reject() {
        // `digits_only` is a pure filter — it must NOT cap its output (the
        // command's `> MAX_DIAL_CHARS` check is what refuses oversized inputs);
        // a filter that silently truncated would change meaning.
        let huge = "1".repeat(5000);
        assert_eq!(digits_only(&huge).len(), 5000);
    }

    // ---- ROLE_DIALER status fold (REQ-A1180) ------------------------------------

    use super::{dialer_role_status_from, DialerRoleStatus};

    fn ok(v: bool) -> Result<bool, String> {
        Ok(v)
    }

    fn no() -> Result<bool, String> {
        Err("no JNI".to_string())
    }

    #[test]
    fn a_held_role_reads_held_and_askable() {
        let s = dialer_role_status_from(ok(true), ok(true), ok(true));
        assert_eq!(
            s,
            DialerRoleStatus {
                role_supported: true,
                role_held: true,
                role_requestable: true,
            }
        );
    }

    #[test]
    fn an_unheld_role_is_askable_but_not_held() {
        // The state the button is for: supported, not held, the glue is there.
        let s = dialer_role_status_from(ok(true), ok(false), ok(true));
        assert!(s.role_supported && !s.role_held && s.role_requestable);
    }

    #[test]
    fn an_unsupported_device_reports_neither_held_nor_askable() {
        // A tablet: the role cannot be granted, so no button may be offered.
        let s = dialer_role_status_from(ok(false), ok(false), ok(true));
        assert_eq!(s, DialerRoleStatus::unsupported());
    }

    #[test]
    fn an_unreachable_probe_reports_unsupported_rather_than_a_verdict() {
        // The NEGATIVE CONTROL for "we could not ask": if a `supported` failure were
        // promoted to `true` (or `held` to `true`), this is the test that reddens. A
        // desktop build / an unbound glue must never claim the role is held.
        let s = dialer_role_status_from(no(), no(), no());
        assert!(!s.role_supported && !s.role_held && !s.role_requestable);
    }

    #[test]
    fn a_held_probe_that_errors_collapses_to_unheld_not_to_held() {
        // `held: Err` lands on `false` — the safe direction (offer the grant, never
        // assert one). Rounding it up to `true` would hide the remedy.
        let s = dialer_role_status_from(ok(true), no(), ok(true));
        assert!(s.role_supported && !s.role_held && s.role_requestable);
    }

    #[test]
    fn a_request_is_never_askable_without_a_deliverable_bridge() {
        // `supported` but the glue is not bound: offering the button would be the
        // dishonest-success shape (`BlocklistGlue` §"role dialog from app context").
        let s = dialer_role_status_from(ok(true), ok(false), ok(false));
        assert!(s.role_supported && !s.role_requestable);
    }

    // ---- real-dial capability (REQ-A1319, REQ-A1626) -----------------------------

    use super::real_dial_status_from;

    #[test]
    fn a_bound_granted_device_reports_a_real_dial_path() {
        let s = real_dial_status_from(true, true, ok(true));
        assert!(s.on_device && s.available && s.reason.is_empty());
    }

    #[test]
    fn a_bound_device_without_the_call_grant_is_not_available() {
        // REQ-A1626, the load-bearing case: `bind` is unconditional at boot, so a phone
        // whose user denied CALL_PHONE still has a bound context. Before this, `available`
        // was `true` with an empty reason on exactly that phone — the dialer routed the
        // call into an `ACTION_CALL` the platform rejects, and the remedy ("grant
        // CALL_PHONE") could never be spoken. The reason must name the permission.
        let s = real_dial_status_from(true, true, ok(false));
        assert!(s.on_device && !s.available);
        assert!(
            s.reason.contains("CALL_PHONE"),
            "the refusal must name the missing grant, got {:?}",
            s.reason
        );
    }

    #[test]
    fn an_unreadable_call_grant_is_not_folded_into_available() {
        // The NEGATIVE CONTROL for the fold: an `Err` from the platform probe is "we could
        // not ask", never "granted". Folding it into `true` is precisely the shape this
        // round removes, and this is the test that reddens if it comes back.
        let s = real_dial_status_from(true, true, no());
        assert!(s.on_device && !s.available);
        assert!(!s.reason.is_empty(), "a refusal must carry why");
    }

    #[test]
    fn a_device_with_no_bound_context_is_on_device_but_not_available() {
        // The load-bearing case: on a phone with no bound context, `on_device` is true
        // and `available` is false — the caller must NOT fall back to a simulation.
        let s = real_dial_status_from(true, false, ok(false));
        assert!(s.on_device && !s.available);
        assert!(!s.reason.is_empty(), "a refusal must carry why");
    }

    #[test]
    fn a_desktop_host_is_neither_on_device_nor_available() {
        let s = real_dial_status_from(false, false, ok(false));
        assert!(!s.on_device && !s.available);
    }

    #[test]
    fn a_bound_context_on_a_non_android_build_still_reports_not_on_device() {
        // The negative control for the fold: `bound` can never promote a desktop host
        // into "on device", which is what would let a desktop accept a simulated call
        // as if the platform had placed it.
        let s = real_dial_status_from(false, true, ok(true));
        assert!(!s.on_device && !s.available);
    }

    /// The pure fold above is only half the fix: the *reason* the audit found unreachable
    /// is emitted from the platform probe, and the command must actually ask for it
    /// (REQ-A1626). The `android` branch does not compile in this host test build, so the
    /// wiring is pinned from the source — the same shape `sms.rs::sms_send_reports_a_real_verdict_not_an_ok_flag`
    /// uses for its Kotlin seam.
    #[test]
    fn the_call_grant_probe_is_wired_into_the_command_and_the_kotlin_glue() {
        const SRC: &str = include_str!("real_dial.rs");
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/TelephonyGlue.kt");

        // Rust asks the platform through a `public static boolean` on `TelephonyGlue`…
        assert!(
            SRC.contains("call_static_bool(\"callPermissionGrantedBound\")"),
            "the host must ask Kotlin whether CALL_PHONE is held"
        );
        // …and the dial command feeds that probe into the fold it reports *and refuses
        // from*, so a rewrite back to a constant (`Ok(true)`) — the defect `real_dial`
        // shipped — reddens. The needle is the whole multi-line call plus the refusal
        // that follows it: a lone `call_permission_granted(),` also appears in the status
        // command above, so asserting on the token alone would stay green under exactly
        // that perturbation. It is built with `concat!` on purpose — a single literal
        // would appear in this file's own bytes and satisfy itself.
        let wired_into_the_dial_command = concat!(
            "let status = real_dial_status_from(",
            "\n            true,",
            "\n            android_impl::is_bound(),",
            "\n            android_impl::call_permission_granted(),",
            "\n        );",
            "\n        if !status.available {",
        );
        assert!(
            SRC.contains(wired_into_the_dial_command),
            "the dial command must fold the platform's grant, not assume one"
        );
        // …whose Kotlin entry point must be `@JvmStatic` (a static JNI call cannot find
        // an instance method) and must genuinely read the runtime permission.
        assert!(
            GLUE.contains("@JvmStatic\n    fun callPermissionGrantedBound(): Boolean"),
            "callPermissionGrantedBound must be a @JvmStatic member"
        );
        assert!(
            GLUE.contains("checkSelfPermission(ctx, Manifest.permission.CALL_PHONE)"),
            "the probe must read the CALL_PHONE grant, not a proxy for it"
        );
        // The dial command refuses from the *same* fold it reports, so the status and the
        // refusal can never disagree on why, and a denied phone never fires ACTION_CALL.
        assert!(
            SRC.contains("if !status.available {") && SRC.contains("return Err(status.reason);"),
            "real_dial must refuse with the fold's own reason rather than dialing anyway"
        );
    }

    // ---- boot-attach outcome (REQ-A1865 / F-TEL-049) -----------------------------

    use super::{attach_outcome, AttachOutcome};

    #[test]
    fn an_already_bound_attach_is_not_a_failure() {
        // The device log, verbatim (S5 / API 34): `"real dial context not bound —
        // dialing stays on the mock"` printed beside `error=real dial context is already
        // bound`. The `Err` there is the idempotent re-attach — the Kotlin glue calls
        // `nativeAttach`/`attachContext` on **every** `onStart` — which is success, and
        // the context is bound. Reporting it as the failure made the sentence deny its
        // own `error=` field on every boot after the first.
        assert_eq!(attach_outcome(true, true), AttachOutcome::AlreadyBound);
    }

    #[test]
    fn a_bind_that_left_nothing_installed_is_the_only_failure() {
        // Positive control for the arm above: the "stays on the mock" warning may fire
        // ONLY when the attempt failed *and* the registry is still empty. Without this,
        // "never warn" would pass the test above and a genuinely dead bind would go
        // unreported.
        assert_eq!(attach_outcome(true, false), AttachOutcome::Failed);
    }

    #[test]
    fn a_successful_bind_reports_attached() {
        assert_eq!(attach_outcome(false, false), AttachOutcome::Attached);
        assert_eq!(attach_outcome(false, true), AttachOutcome::Attached);
    }

    /// The pure fold is only half the fix: the defect lived in the two JNI entries, whose
    /// `#[cfg(feature = "android")]` bodies do not compile in this host test build, so the
    /// wiring is pinned from the source (the shape `the_call_grant_probe_is_wired_into_the_command_and_the_kotlin_glue`
    /// uses above). Each entry must feed its `bind` result through `attach_outcome` rather
    /// than re-folding every `Err` into the warning.
    ///
    /// The needles are built with `concat!` on purpose — a single literal would appear in
    /// this file's own bytes (or, for the sensor entry, be assertable against its own
    /// source) and satisfy itself.
    #[test]
    fn both_boot_attach_entries_classify_their_bind_result() {
        const DIAL: &str = include_str!("real_dial.rs");
        const SENSOR: &str = include_str!("sensor_host.rs");

        let dial_wired =
            concat!("match attach_outcome(bound.is_err(), ", "android_impl::is_bound())");
        assert!(
            DIAL.contains(dial_wired),
            "TelephonyGlue.nativeAttach must classify its bind result, not warn on every Err"
        );
        let sensor_wired = concat!(
            "match crate::real_dial::attach_outcome(bound.is_err(), ",
            "android_ctx::is_bound())"
        );
        assert!(
            SENSOR.contains(sensor_wired),
            "SensorGlue.attachContext must classify its bind result, not warn on every Err"
        );
        // ...and the always-bound `is_bound()` sibling must exist for the sensor registry,
        // or the classification would have no honest second argument.
        assert!(
            SENSOR.contains("pub fn is_bound() -> bool {"),
            "android_ctx must expose the registry state the entry classifies against"
        );
    }
}
