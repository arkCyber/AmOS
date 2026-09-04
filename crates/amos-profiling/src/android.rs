//! Real Android power source — feature-gated `android`.
//!
//! Reads instantaneous current from `BatteryManager#getLongProperty(CURRENT_NOW)`
//! (µA) via a process holding the app `Context` (the System UI APK) and converts
//! to milliwatts using a voltage. Skeleton honesty, mirroring the repo's device
//! seams:
//! * The **current** read is real (`BATTERY_PROPERTY_CURRENT_NOW = 2`).
//! * **Voltage** is taken from a constructor parameter (default 3700 mV). On a real
//!   device pass the live `BatteryManager.EXTRA_VOLTAGE` (mV) from the
//!   `ACTION_BATTERY_CHANGED` sticky broadcast so `mW = µA × mV / 1e6` is accurate;
//!   wiring that receiver is on-device validation work.
//! * When the property read fails / reports `<= 0` (device unknown), it returns
//!   `0.0` — honest "unavailable", never a fabricated draw.
//!
//! `cargo check -p amos-profiling --features android` keeps it compiling; not
//! runnable on the desktop host (needs a real Android VM + `Context`).

use jni::objects::{GlobalRef, JObject, JValue};
use jni::{JNIEnv, JavaVM};

use crate::power::PowerSource;

/// `Context.BATTERY_SERVICE` and `BatteryManager.BATTERY_PROPERTY_CURRENT_NOW`.
const BATTERY_SERVICE: &str = "batterymanager";
const PROP_CURRENT_NOW_UA: i32 = 2;
/// Nominal Li-ion voltage (mV) when the caller does not supply a live reading.
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

/// Real battery power source reading instantaneous current × voltage.
pub struct AndroidBatteryPowerSource {
    vm: JavaVM,
    context: AndroidContext,
    /// Battery terminal voltage in mV used for the µA → mW conversion.
    voltage_mv: i64,
}

impl AndroidBatteryPowerSource {
    /// Construct using the default 3700 mV nominal voltage.
    pub fn new(vm: JavaVM, env: &JNIEnv<'_>, context: JObject<'_>) -> Result<Self, String> {
        Self::with_voltage_mv(vm, env, context, DEFAULT_VOLTAGE_MV)
    }

    /// Construct with an explicit battery voltage (mV) — pass a live
    /// `EXTRA_VOLTAGE` reading on a real device for accuracy.
    pub fn with_voltage_mv(
        vm: JavaVM,
        env: &JNIEnv<'_>,
        context: JObject<'_>,
        voltage_mv: i64,
    ) -> Result<Self, String> {
        let context = AndroidContext(env.new_global_ref(context).map_err(|e| e.to_string())?);
        Ok(Self {
            vm,
            context,
            voltage_mv,
        })
    }

    fn attach(&self) -> Result<JNIEnv<'_>, String> {
        self.vm
            .attach_current_thread_permanently()
            .map_err(|e| e.to_string())
    }

    /// Instantaneous board power in milliwatts (`current_µA × voltage_mV / 1e6`).
    /// `0.0` means "unavailable / not reading", never a fabricated number.
    pub fn read_mw(&self) -> f64 {
        let mut env = match self.attach() {
            Ok(e) => e,
            Err(_) => return 0.0,
        };
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = match battery_manager(&mut env, ctx) {
            Ok(m) => m,
            Err(_) => return 0.0,
        };
        if mgr.is_null() {
            return 0.0;
        }
        let current_ua: i64 = match env.call_method(
            &mgr,
            "getLongProperty",
            "(I)J",
            &[JValue::Int(PROP_CURRENT_NOW_UA)],
        ) {
            Ok(v) => match v.j() {
                Ok(x) => x,
                Err(_) => return 0.0,
            },
            Err(_) => return 0.0,
        };
        if current_ua <= 0 || self.voltage_mv <= 0 {
            return 0.0;
        }
        (current_ua as f64) * (self.voltage_mv as f64) / 1_000_000.0
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
