//! Real Android power source — feature-gated `android`.
//!
//! Reads instantaneous current from `BatteryManager#getLongProperty(CURRENT_NOW)`
//! (µA) via a process holding the app `Context` (the System UI APK) **and** the
//! *live* terminal voltage from the sticky `ACTION_BATTERY_CHANGED` broadcast
//! (`EXTRA_VOLTAGE`, mV), then converts to milliwatts with the shared, honest
//! [`BatterySample`](crate::power::BatterySample) math (`mW = µA × mV / 1e6`).
//! Both halves of the reading are real, so the mW that a
//! [`ProfileReport`](crate::report::ProfileReport) turns into `est_energy_j`
//! tracks the actual battery under a heavy LLM load instead of a fixed 3700 mV.
//!
//! * The **current** read is real (`BATTERY_PROPERTY_CURRENT_NOW = 2`).
//! * The **voltage** is refreshed each read from the sticky battery broadcast
//!   `EXTRA_VOLTAGE` (no permission needed for that extra); it only falls back to
//!   the constructor's nominal voltage when the broadcast is absent.
//! * When either half cannot be read / reports `<= 0`, the sample is invalid and
//!   [`BatterySample::power_mw`] returns `0.0` — honest "unavailable", never a
//!   fabricated draw.
//!
//! `cargo check -p amos-profiling --features android` keeps it compiling; not
//! runnable on the desktop host (needs a real Android VM + `Context`).

use jni::objects::{GlobalRef, JObject, JValue};
use jni::{JNIEnv, JavaVM};

use crate::power::{BatterySample, PowerSource};

/// `Context.BATTERY_SERVICE` and `BatteryManager.BATTERY_PROPERTY_CURRENT_NOW`.
const BATTERY_SERVICE: &str = "batterymanager";
const PROP_CURRENT_NOW_UA: i32 = 2;
/// `Intent.ACTION_BATTERY_CHANGED` + the `EXTRA_VOLTAGE` (mV) extra on it.
const ACTION_BATTERY_CHANGED: &str = "android.intent.action.BATTERY_CHANGED";
const EXTRA_VOLTAGE: &str = "voltage";
/// Nominal Li-ion voltage (mV) used only when no live reading is available.
pub const DEFAULT_VOLTAGE_MV: i64 = 3700;

/// `Send + Sync` handle to the Java app `Context` (same pattern as the other
/// `android` seams).
struct AndroidContext(GlobalRef);

// SAFETY: a JNI global ref outlives the creating env and is VM-global; every
// method re-attaches the calling thread before touching it.
unsafe impl Send for AndroidContext {}
// SAFETY: access always happens on an attached thread.
unsafe impl Sync for AndroidContext {}

/// `context.getSystemService("batterymanager")` → the service object.
fn battery_manager<'e>(env: &mut JNIEnv<'e>, ctx: &JObject<'e>) -> Result<JObject<'e>, String> {
    let name = env.new_string(BATTERY_SERVICE).map_err(|e| e.to_string())?;
    let out = env
        .call_method(
            ctx,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&name)],
        )
        .map_err(|e| e.to_string())?;
    out.l().map_err(|e| e.to_string())
}

/// Read one `int` extra off the sticky battery intent. `None` when the extra is
/// absent — `getIntExtra(name, i32::MIN)` returns the `i32::MIN` default for a
/// missing extra, so that sentinel is treated as "absent" rather than a value.
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

/// The live battery terminal voltage (mV) from the sticky
/// `ACTION_BATTERY_CHANGED` broadcast, or `None` when it is unavailable.
fn sticky_voltage_mv(env: &mut JNIEnv<'_>, ctx: &JObject<'_>) -> Option<i64> {
    let action = env.new_string(ACTION_BATTERY_CHANGED).ok()?;
    let filter = env
        .new_object(
            "android/content/IntentFilter",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&action)],
        )
        .ok()?;
    // context.registerReceiver(null, filter) -> Intent (sticky battery broadcast).
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
    // EXTRA_VOLTAGE is an int in mV.
    intent_int(env, &intent, EXTRA_VOLTAGE).map(i64::from)
}

/// Real battery power source: live instantaneous current (`CURRENT_NOW`) × live
/// voltage (`EXTRA_VOLTAGE`), with a nominal fallback only for the voltage.
pub struct AndroidBatteryPowerSource {
    vm: JavaVM,
    context: AndroidContext,
    /// Battery terminal voltage in mV used *only* when the live `EXTRA_VOLTAGE`
    /// reading is unavailable (the per-read voltage replaces it on a real device).
    fallback_voltage_mv: i64,
}

impl AndroidBatteryPowerSource {
    /// Construct using the default 3700 mV nominal fallback voltage.
    pub fn new(vm: JavaVM, env: &JNIEnv<'_>, context: JObject<'_>) -> Result<Self, String> {
        Self::with_fallback_voltage_mv(vm, env, context, DEFAULT_VOLTAGE_MV)
    }

    /// Construct with an explicit *fallback* voltage (mV). A live
    /// `EXTRA_VOLTAGE` reading from the sticky broadcast overrides it on each
    /// [`sample`](Self::sample) for accuracy.
    pub fn with_fallback_voltage_mv(
        vm: JavaVM,
        env: &JNIEnv<'_>,
        context: JObject<'_>,
        fallback_voltage_mv: i64,
    ) -> Result<Self, String> {
        let context = AndroidContext(env.new_global_ref(context).map_err(|e| e.to_string())?);
        Ok(Self {
            vm,
            context,
            fallback_voltage_mv,
        })
    }

    /// Compatibility alias kept for callers written against the earlier
    /// constructor that supplied a *fixed* voltage. The argument is now the
    /// fallback used only when no live reading is present.
    pub fn with_voltage_mv(
        vm: JavaVM,
        env: &JNIEnv<'_>,
        context: JObject<'_>,
        voltage_mv: i64,
    ) -> Result<Self, String> {
        Self::with_fallback_voltage_mv(vm, env, context, voltage_mv)
    }

    fn attach(&self) -> Result<JNIEnv<'_>, String> {
        self.vm
            .attach_current_thread_permanently()
            .map_err(|e| e.to_string())
    }

    fn read_current_ua(&self, env: &mut JNIEnv<'_>, mgr: &JObject<'_>) -> Option<i64> {
        let v = env
            .call_method(
                mgr,
                "getLongProperty",
                "(I)J",
                &[JValue::Int(PROP_CURRENT_NOW_UA)],
            )
            .ok()?
            .j()
            .ok()?;
        (v > 0).then_some(v)
    }

    /// One instantaneous battery sample: live `CURRENT_NOW` (µA) × live
    /// `EXTRA_VOLTAGE` (mV). A missing current yields an invalid sample
    /// ([`BatterySample::is_valid`] == `false`) rather than a fake draw; the
    /// live voltage is preferred, with `fallback_voltage_mv` used only when the
    /// sticky broadcast is absent.
    pub fn sample(&self) -> BatterySample {
        let mut env = match self.attach() {
            Ok(e) => e,
            Err(_) => return BatterySample::new(0, 0),
        };
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = match battery_manager(&mut env, ctx) {
            Ok(m) if !m.is_null() => m,
            _ => return BatterySample::new(0, 0),
        };
        let current_ua = match self.read_current_ua(&mut env, &mgr) {
            Some(c) => c,
            None => return BatterySample::new(0, 0),
        };
        // Live voltage when available; nominal fallback otherwise. A broken live
        // read still leaves us with the fallback (better than dropping the sample).
        let voltage_mv = sticky_voltage_mv(&mut env, ctx).unwrap_or(self.fallback_voltage_mv);
        BatterySample::new(current_ua, voltage_mv)
    }

    /// Instantaneous board power in milliwatts, or `0.0` for "unavailable".
    pub fn read_mw(&self) -> f64 {
        self.sample().power_mw()
    }
}

impl PowerSource for AndroidBatteryPowerSource {
    fn name(&self) -> &'static str {
        "android-battery"
    }

    fn average_power_mw(&self) -> f64 {
        self.read_mw()
    }
}
