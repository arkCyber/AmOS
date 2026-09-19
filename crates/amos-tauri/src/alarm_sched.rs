//! Tauri host bridge for native exact alarms (§9 ③, docs/native-alarm-bridge.md).
//!
//! Owns one process-wide [`ExactAlarmClock`] and exposes three commands the
//! WebView calls so alarm "ring at this absolute wall-clock instant" decisions
//! live in native code (not throttlable JS timers):
//!
//! * `scheduler_alarm_register { id, atMs } -> AlarmArmed { id, atMs, device }`
//! * `scheduler_alarm_cancel { id } -> AlarmCanceled { id, wasRegistered, device }`
//! * `scheduler_alarm_poll { nowMs? } -> { due: [id, …] }`  (fires due alarms once)
//!
//! The **device binding is no longer a seam** (REQ-A369; before it, this header said it "stays a
//! caller/device seam" and nothing called it — a real device round measured `dumpsys alarm` empty
//! while the WebView saw the registration succeed, so a sleeping phone was never woken: F-TAU-007).
//! Under the `android` feature this module holds the Kotlin `AlarmGlue` — a `JavaVM` plus a
//! `GlobalRef` to the app `Context`, handed up by `AlarmGlue.bind` from `MainActivity.onStart` —
//! and calls `AlarmGlue.schedule` / `AlarmGlue.cancel`, i.e.
//! `AlarmManager#setExactAndAllowWhileIdle(RTC_WAKEUP, …)` plus an `AlarmReceiver` that brings the
//! System UI forward at that instant.
//!
//! Every call answers with what the **OS** did ([`DeviceOutcome`]): a registration that only
//! reached the ledger is *not* "the alarm will ring", and the three ways the platform can refuse
//! (exact alarms disallowed, no `AlarmManager`, `SecurityException`) are distinct states rather
//! than one `false`. A host without `AlarmManager` answers `host_only` instead of pretending.
//! While the process is alive, a poll thread can still sleep until `next_at`, then `poll`.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use amos_scheduler::exact::ExactAlarmClock;
use amos_scheduler::JobId;
use serde::Serialize;
use tauri::State;

/// Maximum bytes in a scheduler alarm `id` the WebView hands in via
/// `scheduler_alarm_register` / `_cancel`.
///
/// Real alarm ids are user-facing labels (`"wakeup"`, `"medication-8h"`,
/// ≤32 chars). 256 B mirrors `MAX_MAIL_NAME_BYTES` — well above any legitimate
/// label and tight enough that a paste-sized caller cannot inflate the
/// ledger's id set.
pub const MAX_ALARM_ID_BYTES: usize = 256;

/// Maximum number of *distinct* alarms the ledger will hold.
///
/// `MAX_ALARM_ID_BYTES` bounds one id; nothing bounded **how many** ids a caller could register,
/// and `scheduler_alarm_register` is callable from the WebView — so a frontend loop (or a
/// hostile script in the same origin) could grow the map without limit (REQ-A374). A real alarm
/// list is dozens of entries (`CHAT_MSG_CAP` / `MAX_IME_SESSIONS` in this repo are the same
/// "bounded on purpose" shape), so 256 is generous while keeping the ledger's memory a constant.
///
/// Re-registering an **existing** id (the daily alarm's re-arm, or an edit) is unaffected: the
/// cap counts distinct ids, not calls.
pub const MAX_ALARM_ENTRIES: usize = 256;

/// Wall-clock epoch (ms) now, never panicking / never negative.
fn now_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis().min(u64::MAX as u128) as u64,
        Err(_) => 0,
    }
}

/// Process-shared exact-alarm ledger the three commands operate on.
pub struct AlarmSchedState {
    inner: Mutex<ExactAlarmClock>,
}

impl Default for AlarmSchedState {
    fn default() -> Self {
        Self::new()
    }
}

impl AlarmSchedState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ExactAlarmClock::new()),
        }
    }

    /// Schedule (or reschedule) a one-shot alarm at an absolute epoch ms.
    pub fn register(&self, id: String, at_ms: u64) {
        self.lock().register(JobId::new(id), at_ms);
    }

    /// Cancel a pending alarm; returns whether it was present.
    pub fn cancel(&self, id: &str) -> bool {
        self.lock().cancel(&JobId::new(id))
    }

    /// Fire & return the ids whose time has arrived by `now`.
    pub fn poll(&self, now: u64) -> Vec<String> {
        self.lock()
            .due(now)
            .into_iter()
            .map(|id| id.as_str().to_owned())
            .collect()
    }

    /// Earliest future wake instant (feeds an OS exact-wake / poll sleep).
    pub fn next_at(&self, now: u64) -> Option<u64> {
        self.lock().next_at(now)
    }

    /// How many distinct alarms are outstanding (the ledger's size, for the entry cap).
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// Whether the ledger is empty (the companion `len` needs, and what "no alarms armed"
    /// reads as at the call sites).
    pub fn is_empty(&self) -> bool {
        self.lock().len() == 0
    }

    /// Whether this id is already registered (re-registration must be allowed at capacity).
    pub fn contains(&self, id: &str) -> bool {
        self.lock().contains(&JobId::new(id.to_string()))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ExactAlarmClock> {
        // Poison-recover: a panicked writer must never deadlock the commands.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// What the **OS half** of an alarm registration actually did.
///
/// `scheduler_alarm_register` used to answer `Ok(())` after writing the in-process ledger
/// only — true while our process is alive, and a lie exactly when an alarm matters: a
/// dozing phone or a killed process (measured on a real device in REQ-A362: the WebView's
/// call resolved with no error while `dumpsys alarm` was empty). The outcome is a typed
/// fact now, so the UI can say "this alarm will not wake the phone" instead of implying
/// that it will.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "detail")]
pub enum DeviceOutcome {
    /// This host has no `AlarmManager` at all (desktop / CI): the ledger is all there is.
    HostOnly,
    /// The OS accepted an exact alarm (`setExactAndAllowWhileIdle`).
    Scheduled,
    /// The OS cancelled it (the glue always answers this; the OS cancel is idempotent).
    Cancelled,
    /// Exact alarms are not allowed for this app (API 31+) — the alarm will not wake it.
    Disallowed,
    /// The Kotlin glue has not been attached yet (boot ordering) — nothing could be called.
    Unattached,
    /// No `AlarmManager` service on this device.
    Unavailable,
    /// `setExact…` threw `SecurityException` despite the permission check.
    Denied,
    /// The glue's own words when they are none of the above — surfaced verbatim, never rounded up.
    Unknown(String),
}

/// Map one `AlarmGlue.STATUS_*` string onto the typed outcome.
///
/// Pure, and pinned on **both** sides: the Kotlin constants (`AlarmGlue.kt`) spell these
/// words and `device_outcome_from_status_parses_the_glue_status_words` fails if one side
/// drifts. An unrecognised string becomes `Unknown(…)` — the honest answer, because a
/// status we cannot classify tells us nothing about whether the phone will wake.
pub fn device_outcome_from_status(status: &str) -> DeviceOutcome {
    match status {
        "scheduled" => DeviceOutcome::Scheduled,
        "cancelled" => DeviceOutcome::Cancelled,
        "disallowed" => DeviceOutcome::Disallowed,
        "unavailable" => DeviceOutcome::Unavailable,
        "denied" => DeviceOutcome::Denied,
        "" => DeviceOutcome::Unknown("the glue answered with an empty status".to_string()),
        other => DeviceOutcome::Unknown(other.to_string()),
    }
}

/// Answer to `scheduler_alarm_register`: what the ledger holds **and** what the OS did.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmArmed {
    pub id: String,
    pub at_ms: u64,
    /// `HostOnly` on desktop; on a device one of the refusal states above when it did not
    /// reach the platform. Never rounded up to "scheduled".
    pub device: DeviceOutcome,
}

/// Answer to `scheduler_alarm_cancel`: whether the ledger still held it (the old return
/// value) **and** what the OS binding did.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmCanceled {
    pub id: String,
    pub was_registered: bool,
    pub device: DeviceOutcome,
}

/// Serializable poll answer (ids as plain strings for the JS bridge).
#[derive(Clone, Debug, Serialize)]
pub struct AlarmPoll {
    pub due: Vec<String>,
}

/// Register a one-shot exact alarm at `atMs` (absolute epoch ms).
///
/// The ledger is written first (the in-process path keeps working even when the OS
/// binding is unavailable), then the **device** half is attempted and reported: on
/// Android the Kotlin `AlarmGlue.schedule` is called through JNI, on the desktop there
/// is no `AlarmManager` and the answer says so (`host_only`) instead of pretending.
#[tauri::command]
pub fn scheduler_alarm_register(
    state: State<'_, AlarmSchedState>,
    id: String,
    at_ms: u64,
) -> Result<AlarmArmed, String> {
    check_alarm_id(&id)?;
    check_alarm_capacity(&state, &id)?;
    state.register(id.clone(), at_ms);
    let device = arm_device(&id, at_ms);
    Ok(AlarmArmed { id, at_ms, device })
}

/// Cancel a pending alarm: the ledger answer (`was_registered`, the old return value)
/// plus what the OS binding did — a cancelled alarm that is still armed in
/// `AlarmManager` would ring a phone the user switched off.
#[tauri::command]
pub fn scheduler_alarm_cancel(
    state: State<'_, AlarmSchedState>,
    id: String,
) -> Result<AlarmCanceled, String> {
    check_alarm_id(&id)?;
    let was_registered = state.cancel(&id);
    let device = cancel_device(&id);
    Ok(AlarmCanceled {
        id,
        was_registered,
        device,
    })
}

/// Open this device's per-app **Alarms & reminders** screen so the user can grant exact alarms.
///
/// The companion of the `disallowed` state: a banner that says "the OS has not allowed exact
/// alarms" without a way to fix it is a dead end (REQ-A373). Returns whether a screen was
/// actually started — the Kotlin glue refuses when no foreground Activity is attached (the
/// Android 10+ background-activity-start rules would drop it silently), and this host has no such
/// screen at all, so both cases are honest errors rather than a `true` that opened nothing.
#[tauri::command]
pub fn scheduler_alarm_open_settings() -> Result<bool, String> {
    open_device_settings()
}

/// Device half of [`scheduler_alarm_open_settings`].
#[cfg(feature = "android")]
fn open_device_settings() -> Result<bool, String> {
    android::open_settings()
}

/// Desktop / CI: there is no `AlarmManager`, so there is no "Alarms & reminders" screen either.
#[cfg(not(feature = "android"))]
fn open_device_settings() -> Result<bool, String> {
    Err("this host has no exact-alarm settings screen (no AlarmManager); the in-app alarms ring from the WebView notifier".to_string())
}

#[cfg(feature = "android")]
pub(crate) fn arm_device(id: &str, at_ms: u64) -> DeviceOutcome {
    android::schedule(id, at_ms)
}

/// Desktop / CI: there is no `AlarmManager` here, and saying so is the answer.
#[cfg(not(feature = "android"))]
pub(crate) fn arm_device(_id: &str, _at_ms: u64) -> DeviceOutcome {
    DeviceOutcome::HostOnly
}

/// Hand one cancellation to the OS exact-wake binding (feature `android`).
#[cfg(feature = "android")]
pub(crate) fn cancel_device(id: &str) -> DeviceOutcome {
    android::cancel(id)
}

/// Desktop / CI: nothing to cancel outside the ledger.
#[cfg(not(feature = "android"))]
pub(crate) fn cancel_device(_id: &str) -> DeviceOutcome {
    DeviceOutcome::HostOnly
}

/// Bound the ledger's **size**, not just its keys (REQ-A374).
///
/// The command is WebView-callable, so an unbounded map is a caller-controlled memory growth path
/// — the same class this repo bounds everywhere else (`CHAT_MSG_CAP`, `MAX_IME_SESSIONS`,
/// `FrameCap`). The cap counts **distinct ids**: re-registering an existing id (a daily alarm's
/// re-arm, an edit, the sensor-style idempotent callers) keeps working at capacity, which is the
/// case that must never fail.
fn check_alarm_capacity(state: &AlarmSchedState, id: &str) -> Result<(), String> {
    if state.contains(id) || state.len() < MAX_ALARM_ENTRIES {
        return Ok(());
    }
    Err(format!(
        "scheduler alarm capacity reached: {MAX_ALARM_ENTRIES} entries (re-registering an existing id still works; cancel the ones you no longer need)"
    ))
}

/// Bound a scheduler alarm id at the command seam so the ledger keys never
/// spill into multi-megabyte strings (a paste-sized id would inflate the
/// `next_at` lookup every poll). Refused ids are honest errors — the caller
/// learns why the registration is rejected instead of silently dropping it.
fn check_alarm_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ALARM_ID_BYTES {
        return Err(format!(
            "scheduler alarm id invalid: {} bytes (max {MAX_ALARM_ID_BYTES})",
            id.len()
        ));
    }
    if id.chars().any(|c| c.is_control() || c == '\0') {
        return Err("scheduler alarm id contains control characters".to_string());
    }
    Ok(())
}

/// Fire & return the ids due by `nowMs` (defaults to the host wall clock).
#[tauri::command]
pub fn scheduler_alarm_poll(
    state: State<'_, AlarmSchedState>,
    now_ms: Option<u64>,
) -> Result<AlarmPoll, String> {
    let now = match now_ms {
        Some(v) => v,
        // `now_ms` here is the Option param (it shadows the module fn of the
        // same name), so call the free fn via its full path to avoid E0618.
        None => crate::alarm_sched::now_ms(),
    };
    Ok(AlarmPoll {
        due: state.poll(now),
    })
}

/// On-device half (feature `android`): the Kotlin `AlarmGlue` binding.
///
/// The shape is the one `crates/amos-flashlight/src/android.rs` established for this repo:
/// hold the process `JavaVM` plus a `GlobalRef` to the app `Context` (handed up by the Kotlin
/// glue from `MainActivity.onStart`), and re-attach the calling thread for every call.
/// Before REQ-A369 this module did not exist, so `scheduler_alarm_register` only ever wrote
/// the in-process ledger: a sleeping phone was never woken (F-TAU-007, measured on device).
#[cfg(feature = "android")]
mod android {
    use super::DeviceOutcome;
    use jni::objects::{GlobalRef, JObject, JValue, JValueOwned};
    use jni::sys::jobject;
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;

    /// The glue class Rust calls. The package identity behind this string is checked by
    /// `scripts/android-glue-mirror.sh` against `tauri.conf.json`'s identifier.
    const GLUE_CLASS: &str = "com/amos/ai/glue/AlarmGlue";

    /// `JavaVM` + a global ref to the Application `Context` the Kotlin glue handed up.
    struct Binding {
        vm: JavaVM,
        context: GlobalRef,
    }

    // SAFETY: a JNI global reference is VM-global and outlives the env that created it; every
    // use re-attaches the calling thread first (`amos_jni::attached`), which is the invariant
    // this assertion states. Same shape as `amos-flashlight`'s `AndroidContext`.
    unsafe impl Send for Binding {}
    // SAFETY: as above — access always happens on an attached thread.
    unsafe impl Sync for Binding {}

    static BINDING: OnceLock<Binding> = OnceLock::new();

    /// Install the binding once. A second attach (a recreated Activity, a rotation) keeps the
    /// first `Context` — it is the Application context and does not go stale.
    fn install(env: &mut JNIEnv<'_>, context: JObject<'_>) -> Result<(), String> {
        let vm = env.get_java_vm().map_err(|e| e.to_string())?;
        let context = env.new_global_ref(&context).map_err(|e| e.to_string())?;
        match BINDING.set(Binding { vm, context }) {
            Ok(()) => Ok(()),
            Err(_) => Err("the alarm binding was already attached".to_string()),
        }
    }

    /// Read the glue's `java.lang.String` answer (one `STATUS_*` word).
    fn status_string(env: &mut JNIEnv<'_>, value: JValueOwned<'_>) -> Result<String, String> {
        let obj = match value {
            JValueOwned::Object(o) => o,
            _ => return Err("the glue answered with a non-object".to_string()),
        };
        if obj.is_null() {
            return Err("the glue answered with null".to_string());
        }
        env.get_string((&obj).into())
            .map(|s| s.into())
            .map_err(|e| format!("the glue's answer was not a string: {e}"))
    }

    /// `AlarmGlue.openExactAlarmSettings()` → whether a screen was started.
    ///
    /// Refuses (`Err`) when the binding is missing — including the case where the Kotlin glue is
    /// attached but no foreground Activity is, which the glue itself reports as `false`.
    pub(super) fn open_settings() -> Result<bool, String> {
        let Some(binding) = BINDING.get() else {
            return Err(
                "the alarm binding is not attached yet (no Activity has run onStart)".to_string(),
            );
        };
        let mut env = amos_jni::attached(&binding.vm).map_err(|e| e.to_string())?;
        let args: [JValue<'_, '_>; 0] = [];
        match env.call_static_method(GLUE_CLASS, "openExactAlarmSettings", "()Z", &args) {
            Ok(value) => value
                .z()
                .map_err(|e| format!("the glue's answer was not a boolean: {e}")),
            Err(e) => {
                clear_pending(&env);
                Err(format!("AlarmGlue.openExactAlarmSettings threw: {e}"))
            }
        }
    }

    /// Clear a pending Java exception left by a failed call, so it cannot escape into the IPC
    /// return path (REQ-A376: a `NoSuchMethodError` — the missing `@JvmStatic` — was surfaced by the
    /// JVM as "Java exception was raised during method invocation" *and* the call failed, instead of
    /// coming back as an honest `DeviceOutcome::Unknown`). `amos_jni::clear_pending` is the repo's
    /// helper for exactly this, and the other JNI call sites already follow the rule.
    fn clear_pending(env: &JNIEnv<'_>) {
        amos_jni::clear_pending(env);
    }

    /// `AlarmGlue.schedule(context, id, atMs)` → one `STATUS_*` word.
    pub(super) fn schedule(id: &str, at_ms: u64) -> DeviceOutcome {
        let Some(binding) = BINDING.get() else {
            return DeviceOutcome::Unattached;
        };
        let mut env = match amos_jni::attached(&binding.vm) {
            Ok(env) => env,
            Err(e) => return DeviceOutcome::Unknown(format!("jni attach failed: {e}")),
        };
        let jid = match env.new_string(id) {
            Ok(s) => s,
            Err(e) => {
                clear_pending(&env);
                return DeviceOutcome::Unknown(format!("could not build the id string: {e}"));
            }
        };
        let ms = match i64::try_from(at_ms) {
            Ok(v) => v,
            Err(_) => {
                return DeviceOutcome::Unknown("atMs does not fit the glue's jlong".to_string());
            }
        };
        let args = [
            JValue::Object(binding.context.as_obj()),
            JValue::Object(&jid),
            JValue::Long(ms),
        ];
        let sig = "(Landroid/content/Context;Ljava/lang/String;J)Ljava/lang/String;";
        match env.call_static_method(GLUE_CLASS, "schedule", sig, &args) {
            Ok(value) => match status_string(&mut env, value) {
                Ok(status) => super::device_outcome_from_status(&status),
                Err(reason) => DeviceOutcome::Unknown(reason),
            },
            Err(e) => {
                clear_pending(&env);
                DeviceOutcome::Unknown(format!("AlarmGlue.schedule threw: {e}"))
            }
        }
    }

    /// `AlarmGlue.cancel(context, id)` → one `STATUS_*` word.
    pub(super) fn cancel(id: &str) -> DeviceOutcome {
        let Some(binding) = BINDING.get() else {
            return DeviceOutcome::Unattached;
        };
        let mut env = match amos_jni::attached(&binding.vm) {
            Ok(env) => env,
            Err(e) => return DeviceOutcome::Unknown(format!("jni attach failed: {e}")),
        };
        let jid = match env.new_string(id) {
            Ok(s) => s,
            Err(e) => {
                clear_pending(&env);
                return DeviceOutcome::Unknown(format!("could not build the id string: {e}"));
            }
        };
        let args = [
            JValue::Object(binding.context.as_obj()),
            JValue::Object(&jid),
        ];
        let sig = "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;";
        match env.call_static_method(GLUE_CLASS, "cancel", sig, &args) {
            Ok(value) => match status_string(&mut env, value) {
                Ok(status) => super::device_outcome_from_status(&status),
                Err(reason) => DeviceOutcome::Unknown(reason),
            },
            Err(e) => {
                clear_pending(&env);
                DeviceOutcome::Unknown(format!("AlarmGlue.cancel threw: {e}"))
            }
        }
    }

    /// `AlarmGlue.bind(context)` → `Java_com_amos_ai_glue_AlarmGlue_attachContext`.
    ///
    /// # Safety
    /// `env`/`_this` are the standard JNI static-method arguments; `context` is a live
    /// `android.content.Context` local ref, valid for the duration of this call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_AlarmGlue_attachContext(
        env: *mut jni::sys::JNIEnv,
        _this: jobject,
        context: jobject,
    ) {
        if env.is_null() || context.is_null() {
            return; // nothing valid yet: an honest no-op, the ledger stays the only path
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        let Ok(mut env) = (unsafe { JNIEnv::from_raw(env) }) else {
            return;
        };
        // SAFETY: `context` is a live local ref for the duration of this call.
        let context = unsafe { JObject::from_raw(context) };
        match install(&mut env, context) {
            Ok(()) => tracing::info!("alarm binding attached (AlarmGlue.attachContext)"),
            // A second attach is the normal re-entry (Activity recreated); anything else must
            // be visible in logcat rather than silently missing.
            Err(reason) => tracing::debug!("alarm binding attach skipped: {reason}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AlarmSchedState {
        AlarmSchedState::new()
    }

    #[test]
    fn register_poll_fires_once_and_cancel_removes() {
        let s = state();
        s.register("wake".into(), 1_000);
        assert!(s.cancel("wake")); // removed before it fires
        assert!(!s.cancel("wake"));

        s.register("wake".into(), 1_000);
        s.register("later".into(), 2_000);
        assert_eq!(s.poll(999), Vec::<String>::new());
        assert_eq!(s.poll(1_000), vec!["wake".to_string()]);
        // Not re-fired on a later poll.
        assert_eq!(s.poll(9_999), vec!["later".to_string()]);
        assert!(s.poll(9_999).is_empty());
    }

    #[test]
    fn next_at_feeds_a_wake_time() {
        let s = state();
        assert_eq!(s.next_at(0), None);
        s.register("a".into(), 500);
        s.register("b".into(), 1_000);
        assert_eq!(s.next_at(0), Some(500));
        assert_eq!(s.next_at(600), Some(1_000));
        assert_eq!(s.next_at(5_000), None);
    }

    #[test]
    fn re_register_reschedules_a_daily_alarm() {
        let s = state();
        s.register("daily".into(), 86_400_000);
        assert_eq!(s.poll(86_400_000), vec!["daily".to_string()]);
        // The caller re-arms the next day.
        s.register("daily".into(), 2 * 86_400_000);
        assert_eq!(s.next_at(86_400_001), Some(2 * 86_400_000));
    }

    /// REQ-A374: the ledger's *size* is bounded, and the case that must never break is the
    /// re-registration of an existing id (a daily alarm's re-arm runs into a full list).
    #[test]
    fn the_ledger_refuses_a_new_id_at_capacity_but_always_allows_a_re_register() {
        let s = state();
        // Fill exactly to the cap.
        for i in 0..MAX_ALARM_ENTRIES {
            let id = format!("alarm:{i}");
            check_alarm_capacity(&s, &id).expect("room left");
            s.register(id, 1_000 + i as u64);
        }
        assert_eq!(s.len(), MAX_ALARM_ENTRIES);
        // A *new* id is refused, and the message names the limit and the way out.
        let err = check_alarm_capacity(&s, "alarm:one-too-many").expect_err("at capacity");
        assert!(err.contains("capacity reached"), "{err}");
        assert!(err.contains(&MAX_ALARM_ENTRIES.to_string()), "{err}");
        assert!(
            err.contains("re-registering an existing id still works"),
            "{err}"
        );
        // …and nothing was added by the refusal.
        assert_eq!(s.len(), MAX_ALARM_ENTRIES);
        // The daily re-arm of an id that is *already* there still goes through.
        check_alarm_capacity(&s, "alarm:0").expect("re-registering is allowed at capacity");
        s.register("alarm:0".to_string(), 9_999);
        assert_eq!(s.len(), MAX_ALARM_ENTRIES);
        // Cancelling makes room again — the documented way out.
        assert!(s.cancel("alarm:0"));
        check_alarm_capacity(&s, "alarm:one-too-many").expect("room after a cancel");
    }

    /// The glue's status words are the Kotlin↔Rust contract: `AlarmGlue.kt` spells them,
    /// `device_outcome_from_status` maps them, and a drift on either side would silently turn a
    /// refusal into "unknown" — or a refusal into a success, which is the bug being fixed.
    #[test]
    fn device_outcome_from_status_parses_the_glue_status_words() {
        assert_eq!(
            device_outcome_from_status("scheduled"),
            DeviceOutcome::Scheduled
        );
        assert_eq!(
            device_outcome_from_status("cancelled"),
            DeviceOutcome::Cancelled
        );
        assert_eq!(
            device_outcome_from_status("disallowed"),
            DeviceOutcome::Disallowed
        );
        assert_eq!(
            device_outcome_from_status("unavailable"),
            DeviceOutcome::Unavailable
        );
        assert_eq!(device_outcome_from_status("denied"), DeviceOutcome::Denied);
        // An empty or unknown word is *not* rounded up.
        assert_eq!(
            device_outcome_from_status(""),
            DeviceOutcome::Unknown("the glue answered with an empty status".to_string())
        );
        assert_eq!(
            device_outcome_from_status("something-new"),
            DeviceOutcome::Unknown("something-new".to_string())
        );
        // The confusion this whole change exists to prevent.
        assert_ne!(
            device_outcome_from_status("disallowed"),
            DeviceOutcome::Scheduled
        );
    }

    /// Desktop / CI: there is no device binding, and the host says so instead of implying it
    /// armed an OS alarm (the shape REQ-A362 measured as "resolve OK, `dumpsys alarm` empty").
    #[cfg(not(feature = "android"))]
    #[test]
    fn a_host_reports_host_only_for_both_directions() {
        assert_eq!(arm_device("wake", 1_000), DeviceOutcome::HostOnly);
        assert_eq!(cancel_device("wake"), DeviceOutcome::HostOnly);
    }

    /// Desktop / CI: asking for the "Alarms & reminders" screen is an honest error, not a `true`
    /// that opened nothing — the same rule the device half follows when no Activity is attached.
    #[cfg(not(feature = "android"))]
    #[test]
    fn a_host_cannot_open_an_exact_alarm_settings_screen() {
        let err = open_device_settings().expect_err("a host has no exact-alarm settings screen");
        assert!(err.contains("no exact-alarm settings screen"), "{err}");
    }

    /// The reply is what the WebView reads: a tagged device state, the id and the instant.
    #[test]
    fn the_armed_answer_carries_the_device_state_it_observed() {
        let armed = AlarmArmed {
            id: "wake".to_string(),
            at_ms: 1_000,
            device: DeviceOutcome::Disallowed,
        };
        let json = serde_json::to_value(&armed).expect("AlarmArmed serialises");
        assert_eq!(json["id"], "wake");
        // camelCase, because the WebView's own alarm model says `atMs` (`lib/alarmCore.ts`).
        assert_eq!(json["atMs"], 1_000);
        assert_eq!(json["device"]["state"], "disallowed");
        // A refusal must not be serialisable as a bare `true`.
        assert!(json["device"].is_object());
    }

    /// reaching the ledger; a paste-sized id would inflate `next_at` and `poll`
    /// lookups for the lifetime of the alarm.
    #[test]
    fn check_alarm_id_accepts_real_ids_and_rejects_oversized() {
        for ok in [
            "wake",
            "medication-8h",
            "x".repeat(MAX_ALARM_ID_BYTES).as_str(),
        ] {
            assert!(check_alarm_id(ok).is_ok(), "{ok:?} is a real id");
        }
        assert!(check_alarm_id("").is_err(), "empty id is refused");
        let huge = "x".repeat(MAX_ALARM_ID_BYTES + 1);
        assert!(check_alarm_id(&huge).is_err(), "oversized id is refused");
        assert!(check_alarm_id("wake\0").is_err(), "NUL is refused");
        assert!(check_alarm_id("wake\n").is_err(), "newline is refused");
    }
}
