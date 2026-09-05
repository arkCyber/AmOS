//! Real Android backend for device sensors — feature-gated `android`.
//!
//! On the no-UI Android base (`docs/no-ui-android.md`) the camera (`CameraManager`),
//! GNSS (`LocationManager`) and IMU (`SensorManager`) are OS system services reachable
//! only from a process holding the app `Context` — i.e. the **System UI (Tauri core)
//! APK**, not the headless `amos-ai` daemon (same host decision as `amos-telephony`).
//! This module is that host: it takes a `JavaVM` + a global ref to the app `Context`
//! and implements the [`SensorProvider`] seam for the real HAL.
//!
//! Status — **honest on-device backend** (mirroring `amos-telephony/src/android.rs`):
//! * **GNSS is real + synchronous**: `LocationManager#getLastKnownLocation("gps")`
//!   (an `ACCESS_FINE_LOCATION` grant is required at runtime). Returns `Ok(None)`
//!   when the receiver is disabled or has no fix yet.
//! * **Camera + IMU are wired through the live latest-sample bridge**
//!   (`crate::stream`): the reads below return the newest value the on-device glue
//!   has pushed. The glue is the *producer*: a `SensorManager` + `SensorEventListener`
//!   (IMU) and a `Camera2` `CameraDevice` capture session + `ImageReader` (frame)
//!   registered by the System UI APK, each calling [`AndroidSensorProvider::record_imu`]
//!   / [`AndroidSensorProvider::record_frame`] (or `set_cameras`/`set_imu_rate_hz`)
//!   from its listener thread. Until the glue pushes, a pull returns an explicit
//!   [`SensorError::Provider`] — never a fabricated sample. (Same honesty rule
//!   telephony uses for `answer`/`end`/recording.)
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
    /// Live camera/IMU read-side: a device `SensorManager` / `Camera2` glue (see
    /// `docs/sensors.md`) pushes each new sample/frame in via [`Self::record_imu`]
    /// / [`Self::record_frame`]; the reads below return the latest value.
    live: crate::stream::LiveSensorProvider,
}

impl AndroidSensorProvider {
    /// Construct from a `JavaVM` + a global ref to the app `Context`. `env` is only
    /// used to create the global ref. GNSS becomes live immediately; camera / IMU
    /// are live once [`Self::set_cameras`] + the sensor glue start pushing.
    pub fn new(vm: JavaVM, env: &JNIEnv<'_>, context: JObject<'_>) -> Result<Self> {
        Ok(Self {
            vm,
            context: AndroidContext(env.new_global_ref(context).map_err(jerr)?),
            live: crate::stream::LiveSensorProvider::default(),
        })
    }

    /// Advertise the physical cameras (from `CameraManager.getCameraIdList` +
    /// `CameraCharacteristics`) so the manager can negotiate / gate them.
    pub fn set_cameras(&self, cameras: Vec<CameraConfig>) {
        self.live.set_cameras(cameras);
    }

    /// Report the IMU sampling rate a registered listener is running at.
    pub fn set_imu_rate_hz(&self, hz: u32) {
        self.live.set_imu_rate_hz(hz);
    }

    /// Producer entry: a `SensorEventListener`/`ASensorEventQueue` glue stores the
    /// newest IMU sample here (called from the sensor thread).
    pub fn record_imu(&self, sample: ImuSample) {
        self.live.record_imu(sample);
    }

    /// Producer entry: a `Camera2`/`ImageReader` glue stores the newest frame here
    /// (called from the image thread). The payload is validated against `cfg`.
    pub fn record_frame(&self, cfg: CameraConfig, bytes: Vec<u8>) -> Result<()> {
        self.live.record_frame(cfg, bytes)
    }

    /// The latest-sample stores, so glue running on its own thread can push without
    /// holding the whole provider.
    pub fn imu_store(&self) -> &crate::stream::ImuLatest {
        self.live.imu_store()
    }

    /// The latest-frame stores (see [`Self::imu_store`]).
    pub fn frame_store(&self) -> &crate::stream::FrameLatest {
        self.live.frame_store()
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
        // Capabilities come from a `CameraManager` glue calling `set_cameras`
        // once it has negotiated `CameraCharacteristics` (device step). Before
        // that, no camera is advertised — honest, not a guessed capability.
        self.live.camera_configs()
    }

    fn camera_capture(&self, id: CameraId) -> Result<CameraFrame> {
        // Returns the newest frame the Camera2/ImageReader glue pushed (via
        // `record_frame`); `CameraNotFound` when `id` isn't advertised, and an
        // explicit `Provider` error before the first frame — never a fake frame.
        self.live.camera_capture(id)
    }

    fn gnss_enabled(&self) -> bool {
        self.gps_enabled()
    }

    fn gnss_fix(&self) -> Result<Option<GeoFix>> {
        self.last_known_fix()
    }

    fn imu_rate_hz(&self) -> u32 {
        // Set by the sensor glue via `set_imu_rate_hz` once a listener is live;
        // 0 = not negotiated yet (the domain core treats 0 as "unknown").
        self.live.imu_rate_hz()
    }

    fn imu_sample(&self) -> Result<ImuSample> {
        // Returns the newest sample a SensorManager/SensorEventListener glue pushed
        // (via `record_imu`); an explicit `Provider` error before the first one.
        self.live.imu_sample()
    }
}
