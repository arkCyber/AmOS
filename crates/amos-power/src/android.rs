//! Real Android battery / thermal telemetry source — feature-gated `android`.
//!
//! On the no-UI Android base (`docs/no-ui-android.md`) the battery/thermal state
//! lives behind the `BatteryManager` system service, reachable only from a process
//! holding the app `Context` — i.e. the **System UI (Tauri core) APK**. This module
//! is that host: it takes a `JavaVM` + a global ref to the app `Context`, reads the
//! **sticky `ACTION_BATTERY_CHANGED` intent** (`level`/`scale`/`status`/
//! `temperature`) and folds it into an [`amos_power::Telemetry`] snapshot that a
//! System-UI energy/governor ticker feeds to [`EnergyGovernor`](crate::EnergyGovernor).
//!
//! Status — **honest on-device skeleton**, mirroring the repo's other `android.rs`
//! seams (`amos-radio` / `amos-telephony` / `amos-profiling`):
//! * level (%), charging flag and temperature (°C) are read for real from the
//!   sticky battery broadcast (no permission needed for these extras);
//! * instantaneous board **power (mW)** is *not* on the sticky intent — pair this
//!   with [`amos_profiling::android::AndroidBatteryPowerSource`] (`CURRENT_NOW`) if
//!   a live draw is wanted;
//! * a failed / absent reading yields `BatteryState::default()` (unknown) — honest,
//!   never a fabricated charge.
//!
//! Runtime requires a real Android VM (`jni::JavaVM`) + a `GlobalRef` to the app
//! `Context`. Not runnable on the desktop host; `cargo check -p amos-power
//! --features android` keeps it compiling.

use jni::objects::{GlobalRef, JObject, JValue};
use jni::{JNIEnv, JavaVM};

use crate::types::{BatteryState, Telemetry, Usage};

// `Intent.ACTION_BATTERY_CHANGED` + its well-known extras.
const ACTION_BATTERY_CHANGED: &str = "android.intent.action.BATTERY_CHANGED";
const EXTRA_STATUS: &str = "status";
const EXTRA_LEVEL: &str = "level";
const EXTRA_SCALE: &str = "scale";
const EXTRA_TEMPERATURE: &str = "temperature";
/// `BatteryManager.BATTERY_STATUS_CHARGING` / `BATTERY_STATUS_FULL`.
const STATUS_CHARGING: i32 = 2;
const STATUS_FULL: i32 = 5;

/// `Send + Sync` handle to the Java `android.content.Context` used to read the
/// battery broadcast (same pattern as the other `android.rs` seams).
struct AndroidContext(GlobalRef);

// SAFETY: a JNI global ref outlives the creating env and is VM-global; every method
// re-attaches the calling thread before touching it. Dropping is handled by GlobalRef.
unsafe impl Send for AndroidContext {}
// SAFETY: access always happens on an attached thread.
unsafe impl Sync for AndroidContext {}

/// Samples the device battery/thermal state from `BatteryManager`'s sticky intent
/// and produces an [`amos_power::Telemetry`] for the energy governor.
pub struct AndroidBatteryTelemetry {
    vm: JavaVM,
    context: AndroidContext,
    /// Foreground/background usage reported by the caller (screen / workload).
    usage: Usage,
}

impl AndroidBatteryTelemetry {
    /// Construct from a `JavaVM` + a global ref to the app `Context`, sampling
    /// with the given `usage`.
    pub fn new(
        vm: JavaVM,
        env: &JNIEnv<'_>,
        context: JObject<'_>,
        usage: Usage,
    ) -> Result<Self, String> {
        let context = AndroidContext(env.new_global_ref(context).map_err(|e| e.to_string())?);
        Ok(Self { vm, context, usage })
    }

    fn attach(&self) -> Result<JNIEnv<'_>, String> {
        self.vm
            .attach_current_thread_permanently()
            .map_err(|e| e.to_string())
    }

    /// One telemetry snapshot from the real battery state. A failure reading the
    /// sticky broadcast yields the conservative default (unknown), never a fake
    /// charge; `power_mw` stays `None` (pair a `PowerSource` for live draw).
    pub fn snapshot(&self) -> Telemetry {
        let mut env = match self.attach() {
            Ok(e) => e,
            Err(_) => return self.default_telemetry(),
        };
        let ctx: &JObject<'_> = self.context.0.as_obj();
        match sticky_battery(&mut env, ctx) {
            Some(b) => Telemetry::new(b, self.usage, None),
            None => self.default_telemetry(),
        }
    }

    fn default_telemetry(&self) -> Telemetry {
        Telemetry::new(BatteryState::default(), self.usage, None)
    }
}

/// Read the sticky `ACTION_BATTERY_CHANGED` intent and map it to a [`BatteryState`].
/// `None` when the broadcast cannot be obtained (no battery / not on Android).
fn sticky_battery(env: &mut JNIEnv<'_>, ctx: &JObject<'_>) -> Option<BatteryState> {
    let action = env.new_string(ACTION_BATTERY_CHANGED).ok()?;
    let filter = env
        .new_object(
            "android/content/IntentFilter",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&action)],
        )
        .ok()?;
    // context.registerReceiver(null, filter) -> Intent (sticky battery broadcast)
    let intent = env
        .call_method(
            ctx,
            "registerReceiver",
            "(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;)Landroid/content/Intent;",
            &[JValue::Object(&JObject::null()), JValue::Object(&filter)],
        )
        .ok()?
        .l()
        .ok()?;
    if intent.is_null() {
        return None;
    }
    let level = intent_int(env, &intent, EXTRA_LEVEL)?;
    let scale = intent_int(env, &intent, EXTRA_SCALE)?;
    let status = intent_int(env, &intent, EXTRA_STATUS).unwrap_or(0);
    let temperature_tenths = intent_int(env, &intent, EXTRA_TEMPERATURE);
    let level_pct = if scale > 0 {
        Some(100.0 * f64::from(level) / f64::from(scale))
    } else {
        None
    };
    let temperature_c = temperature_tenths
        .filter(|t| (-600..=900).contains(t))
        .map(|t| f64::from(t) / 10.0);
    Some(BatteryState {
        level_pct,
        charging: status == STATUS_CHARGING || status == STATUS_FULL,
        temperature_c,
    })
}

/// Read one `int` extra off the sticky battery intent. `None` when the extra is
/// absent — `getIntExtra(name, i32::MIN)` returns the `i32::MIN` default for a
/// missing extra, so that sentinel is treated as "absent" rather than a real value.
fn intent_int(env: &mut JNIEnv<'_>, intent: &JObject<'_>, key: &str) -> Option<i32> {
    let name = env.new_string(key).ok()?;
    let v = env
        .call_method(
            intent,
            "getIntExtra",
            "(Ljava/lang/String;I)I",
            &[JValue::Object(&name), JValue::Int(i32::MIN)],
        )
        .ok()?
        .i()
        .ok()?;
    (v != i32::MIN).then_some(v)
}

#[cfg(test)]
mod tests {
    // No unit tests can run without a real Android VM; the energy-policy rules this
    // feeds are tested in `policy.rs` / `governor` (shared by every battery source).
}
