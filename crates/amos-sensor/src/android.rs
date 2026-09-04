//! Real Android backend for device sensors — feature-gated `android`.
//!
//! On the no-UI Android base (`docs/no-ui-android.md`) the camera (`CameraManager`),
//! GNSS (`LocationManager`) and IMU (`SensorManager`) are OS system services reachable
//! only from a process holding the app `Context` — i.e. the **System UI (Tauri core)
//! APK**, not the headless `amos-ai` daemon (same host decision as `amos-telephony`).
//! This module is that host: it takes a `JavaVM` + a global ref to the app `Context`
//! and implements the [`SensorProvider`] seam for the real HAL.
//!
//! Status — **honest on-device skeleton**, mirroring `amos-telephony/src/android.rs`:
//! * **GNSS is real + synchronous**: `LocationManager#getLastKnownLocation("gps")`
//!   (an `ACCESS_FINE_LOCATION` grant is required at runtime). Returns `Ok(None)`
//!   when the receiver is disabled or has no fix yet.
//! * **Camera + IMU are not wired yet** (they are *streams*, not getters): a live
//!   IMU sample needs a `SensorEventListener` bridge storing the latest sample into
//!   an atomic cache; camera frames need a `CameraDevice` capture session +
//!   `ImageReader`. Until those device-validated bridges land the methods return an
//!   explicit [`SensorError::Provider`] error rather than pretending (same honesty
//!   rule telephony uses for `answer`/`end`/recording).
//!
//! Runtime requires a real Android VM (`jni::JavaVM`) + a `GlobalRef` to the app
//! `Context`; not runnable on the desktop host. `cargo check --features android`
//! keeps it compiling (mirrors `amos-radio` / `amos-telephony`).

use jni::objects::{GlobalRef, JObject, JValue};
use jni::{JNIEnv, JavaVM};

use crate::error::{Result, SensorError};
use crate::provider::SensorProvider;
use crate::spec::{CameraConfig, CameraFrame, CameraId, FixMode, GeoFix, ImuSample};

/// `Context.LOCATION_SERVICE` and the GNSS provider name.
const LOCATION_SERVICE: &str = "location";
const GPS_PROVIDER: &str = "gps";

/// `Send + Sync` handle to the Java app `Context` (Application / Activity) used to
/// reach system services. Same pattern as `amos-radio`/`amos-telephony`.
struct AndroidContext(GlobalRef);

// SAFETY: a JNI global ref outlives the creating env and is VM-global; every method
// re-attaches the calling thread before touching it. Dropping is handled by GlobalRef.
unsafe impl Send for AndroidContext {}
// SAFETY: access always happens on an attached thread.
unsafe impl Sync for AndroidContext {}

/// Feature-gated error mapper (no unwraps in production code).
fn jerr(e: jni::errors::Error) -> SensorError {
    SensorError::Provider(e.to_string())
}

/// `context.getSystemService(name)` → the service object (may be null on absence).
fn system_service<'e>(env: &mut JNIEnv<'e>, ctx: &JObject<'e>, name: &str) -> Result<JObject<'e>> {
    let service = env.new_string(name).map_err(jerr)?;
    let out = env
        .call_method(
            ctx,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&service)],
        )
        .map_err(jerr)?;
    out.l().map_err(jerr)
}

/// The real Android backend behind the `SensorProvider` seam.
pub struct AndroidSensorProvider {
    vm: JavaVM,
    context: AndroidContext,
}

impl AndroidSensorProvider {
    /// Construct from a `JavaVM` + a global ref to the app `Context`. `env` is only
    /// used to create the global ref.
    pub fn new(vm: JavaVM, env: &JNIEnv<'_>, context: JObject<'_>) -> Result<Self> {
        Ok(Self {
            vm,
            context: AndroidContext(env.new_global_ref(context).map_err(jerr)?),
        })
    }

    fn attach(&self) -> Result<JNIEnv<'_>> {
        self.vm.attach_current_thread_permanently().map_err(jerr)
    }

    /// Whether the "gps" provider is currently enabled (`isProviderEnabled`).
    fn gps_enabled(&self) -> bool {
        let mut env = match self.attach() {
            Ok(e) => e,
            Err(_) => return false,
        };
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = match system_service(&mut env, ctx, LOCATION_SERVICE) {
            Ok(m) => m,
            Err(_) => return false,
        };
        if mgr.is_null() {
            return false;
        }
        let provider = match env.new_string(GPS_PROVIDER) {
            Ok(s) => s,
            Err(_) => return false,
        };
        env.call_method(
            &mgr,
            "isProviderEnabled",
            "(Ljava/lang/String;)Z",
            &[JValue::Object(&provider)],
        )
        .and_then(|v| v.z())
        .unwrap_or(false)
    }

    /// Last-known GNSS fix via `LocationManager#getLastKnownLocation("gps")`.
    /// Synchronous and real; `None` when the receiver is off / has no fix yet.
    fn last_known_fix(&self) -> Result<Option<GeoFix>> {
        let mut env = self.attach()?;
        let ctx: &JObject<'_> = self.context.0.as_obj();
        let mgr = system_service(&mut env, ctx, LOCATION_SERVICE)?;
        if mgr.is_null() {
            return Ok(None);
        }
        let provider = env.new_string(GPS_PROVIDER).map_err(jerr)?;
        if !self.gps_enabled() {
            return Ok(None);
        }
        let loc = env
            .call_method(
                &mgr,
                "getLastKnownLocation",
                "(Ljava/lang/String;)Landroid/location/Location;",
                &[JValue::Object(&provider)],
            )
            .map_err(jerr)?
            .l()
            .map_err(jerr)?;
        if loc.is_null() {
            return Ok(None);
        }
        let lat = env
            .call_method(&loc, "getLatitude", "()D", &[])
            .map_err(jerr)?
            .d()
            .map_err(jerr)?;
        let lon = env
            .call_method(&loc, "getLongitude", "()D", &[])
            .map_err(jerr)?
            .d()
            .map_err(jerr)?;
        let alt = env
            .call_method(&loc, "getAltitude", "()D", &[])
            .map_err(jerr)?
            .d()
            .map_err(jerr)?;
        let has_alt = env
            .call_method(&loc, "hasAltitude", "()Z", &[])
            .map_err(jerr)?
            .z()
            .map_err(jerr)?;
        let acc_m = f64::from(
            env.call_method(&loc, "getAccuracy", "()F", &[])
                .map_err(jerr)?
                .f()
                .map_err(jerr)?,
        );
        let ts = env
            .call_method(&loc, "getTime", "()J", &[])
            .map_err(jerr)?
            .j()
            .map_err(jerr)?;
        Ok(Some(GeoFix {
            latitude_deg: lat,
            longitude_deg: lon,
            altitude_m: alt,
            horizontal_accuracy_m: acc_m,
            fix_mode: if has_alt {
                FixMode::ThreeDim
            } else {
                FixMode::TwoDim
            },
            // `Location` carries no satellite count; a GpsStatus listener is the
            // follow-on. 0 is honest "not reported", not a claim of zero sats.
            satellites_in_view: 0,
            timestamp_ms: ts.max(0) as u64,
        }))
    }
}

impl SensorProvider for AndroidSensorProvider {
    fn name(&self) -> &'static str {
        "android"
    }

    fn camera_configs(&self) -> Vec<CameraConfig> {
        // Capability negotiation (supported sizes / FPS / formats) needs
        // `CameraCharacteristics` from a `CameraManager` — device-validated work.
        Vec::new()
    }

    fn camera_capture(&self, _id: CameraId) -> Result<CameraFrame> {
        Err(SensorError::Provider(
            "on-device camera capture requires a CameraDevice/ImageReader bridge \
             (not yet wired)"
                .to_string(),
        ))
    }

    fn gnss_enabled(&self) -> bool {
        self.gps_enabled()
    }

    fn gnss_fix(&self) -> Result<Option<GeoFix>> {
        self.last_known_fix()
    }

    fn imu_rate_hz(&self) -> u32 {
        // A live rate requires a SensorManager listener registration; 0 = not
        // negotiated yet (the domain core treats 0 as "unknown / unconfigured").
        0
    }

    fn imu_sample(&self) -> Result<ImuSample> {
        Err(SensorError::Provider(
            "on-device IMU read requires a SensorEventListener bridge caching the latest \
             sample (not yet wired)"
                .to_string(),
        ))
    }
}
