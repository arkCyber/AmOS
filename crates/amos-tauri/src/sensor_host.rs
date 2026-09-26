//! The **System UI sensor assembly point** — a managed, host-testable read side
//! for camera / IMU, independent of the daemon.
//!
//! On the no-UI Android base the real sensor HAL is reachable *from the System UI
//! APK* (it owns the `Context`), not from the headless `amos-ai` daemon. This
//! module is that host surface: a [`SensorHost`] holding an
//! `amos_sensor::LiveSensorProvider` stream bus under a `SensorManager` energy
//! policy. On-device glue (a `SensorEventListener` + `Camera2`/`ImageReader`)
//! pushes each new sample/frame in via the shared bus; the Tauri commands below
//! let the WebView read a snapshot, set the energy mode and drive the same bus
//! for host/dev bring-up.
//!
//! In addition to pull reads ([`SensorHost::snapshot`]) the host is a **real-time
//! push source**: it subscribes to the stream bus's [`StreamChange`] so that every
//! accepted IMU sample / camera frame — from the WebView `record_*` commands, the
//! on-device `android_glue` or a host feeder — is fanned out through an installed
//! notifier. The app wires that notifier to a Tauri `emit(SENSOR_DATA_EVENT, …)`,
//! so the System UI updates a live sensor view without polling (mirroring
//! `telephony-event` / `telemetry-spy-hit` / `clipboard-changed`).
//!
//! ```text
//! [ Android glue / host dev ]   [ WebView sensor_host commands ]
//!    record_imu/record_frame          sensor_host_snapshot …     ◄── subscribe(SENSOR_DATA_EVENT)
//!            │                                  ▲                          │
//!            ▼            StreamChange          │        SensorHostEvent    │
//!      LiveSensorProvider ───────────────► SensorHost ──────────────────────┘
//!      (shared stream bus)                (notifier → Tauri emit)
//! ```
//!
//! Everything is `SensorManager`-free to unit-test: the domain types come from
//! `amos-sensor`, so host `cargo test` covers the whole assembly with no daemon,
//! no device and no Tauri app. The `android` feature adds
//! [`SensorHost::bind_android`], which attaches the real `AndroidSensorProvider`
//! (GNSS via `LocationManager`) to this host — mirroring `radio::from_android`.

use std::sync::{Arc, Mutex};

/// Upper bound on one camera-frame payload from the WebView side.
///
/// Shares the one ceiling the whole camera path agrees on:
/// [`amos_sensor::GLUE_MAX_FRAME_BYTES`] (16 MiB) is also what the Kotlin
/// `SensorGlue.nativeOnCamera` checks *before* its upcall and what
/// `amos_sensor::MAX_FRAME_BYTES` rejects inside the bus. Keeping the three in
/// lock-step means a frame that passes one boundary can never be refused as
/// oversized by another — there is exactly one number to reason about.
/// The inner `bus.record_frame` then checks the payload against the *advertised*
/// camera's expected size, so any mismatch is a second-layer rejection.
pub const MAX_FRAME_BYTES: usize = amos_sensor::GLUE_MAX_FRAME_BYTES;

use amos_sensor::{
    CameraConfig, CameraFrame, CameraId, ImuSample, LiveSensorProvider, PixelFormat, Resolution,
    SensorKind, SensorManager, SensorMode, SensorProvider, StreamChange, Vec3, VitalsSample,
};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Serialisable one-camera capability advertised on this host.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HostCamera {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub format: String,
}

impl From<&CameraConfig> for HostCamera {
    fn from(c: &CameraConfig) -> Self {
        Self {
            id: c.id.0,
            width: c.resolution.width,
            height: c.resolution.height,
            fps: c.fps,
            format: match c.format {
                PixelFormat::Rgba8 => "rgba8".to_string(),
                PixelFormat::Nv21 => "nv21".to_string(),
            },
        }
    }
}

/// Serialisable latest IMU sample (the most recent the glue pushed).
///
/// The acceleration axes are always present — an IMU with no acceleration sample
/// has no sample at all. `gyro_x` / `gyro_y` / `gyro_z` and `temperature_c` are
/// `Option` for the same reason [`HostVitals`]'s two readings are: the domain's
/// rule is that an absent sensor is `null`, **never** a fabricated value.
///
/// * The gyroscope axes were the last fields here folded to a measurement: on a
///   device with no gyroscope (the field S5, `dumpsys sensorservice`: `geomag
///   fusion (no gyro)`) the glue paired a hardcoded `0f, 0f, 0f` onto every
///   accelerometer sample, so this snapshot reported `gyro_x: 0` — "not
///   rotating" — for an angular rate the device cannot measure, while
///   `temperature_c` right beside it was honestly `null`. A gyroscope-less phone
///   now reads `null` (REQ-A1872 / F-SEN-008).
/// * The die temperature has no source on the Android glue that ships (it reads
///   only the accelerometer and gyroscope) and used to be a bare `f32` fed by a
///   hardcoded `25.0` placeholder, which the Live Sensors screen drew as a
///   measured temperature.
///
/// The screen prints `—` for `null`.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HostImu {
    pub timestamp_ms: u64,
    pub accel_x: f64,
    pub accel_y: f64,
    pub accel_z: f64,
    pub gyro_x: Option<f64>,
    pub gyro_y: Option<f64>,
    pub gyro_z: Option<f64>,
    pub temperature_c: Option<f32>,
}

impl From<ImuSample> for HostImu {
    fn from(s: ImuSample) -> Self {
        Self {
            timestamp_ms: s.timestamp_ms,
            accel_x: s.accel_m_s2.x,
            accel_y: s.accel_m_s2.y,
            accel_z: s.accel_m_s2.z,
            gyro_x: s.gyro_rad_s.map(|g| g.x),
            gyro_y: s.gyro_rad_s.map(|g| g.y),
            gyro_z: s.gyro_rad_s.map(|g| g.z),
            temperature_c: s.temperature_c,
        }
    }
}

/// Serialisable latest wellness sample (the most recent the glue pushed).
///
/// Both readings are `Option` on the wire, preserving the domain's rule: an
/// absent sensor is `null`, **never** a fabricated `0` (a `0` would read as a
/// measurement — "no steps today" / "heart stopped"). The Health screen prints
/// `—` for `null`.
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct HostVitals {
    pub timestamp_ms: u64,
    pub steps_total: Option<f64>,
    pub heart_rate_bpm: Option<f64>,
}

impl From<VitalsSample> for HostVitals {
    fn from(s: VitalsSample) -> Self {
        Self {
            timestamp_ms: s.timestamp_ms,
            steps_total: s.steps_total,
            heart_rate_bpm: s.heart_rate_bpm,
        }
    }
}

/// **Why** the snapshot's `gnss` block reads the way it does.
///
/// This vocabulary exists because `has_fix: false` used to be the answer to four
/// different questions, and the UI could only say one thing about all of them. In
/// particular a **failed read** (on a device the usual cause is a missing location
/// grant — `LocationManager#getLastKnownLocation` throws `SecurityException`) was folded
/// into the same `false` as "the receiver has not locked yet", so a phone that had never
/// been granted location showed "searching for a location" forever and nothing on screen
/// ever contradicted it (REQ-A772 / F-SH-228). Each variant here is a sentence the user
/// can act on:
///
/// * `fix` — a fix is present (see the coordinates/accuracy beside it);
/// * `searching` — the receiver is on and enabled, but has not locked yet;
/// * `receiver-off` — the GPS provider is switched off (a setting, not a failure);
/// * `permission-required` — the read **failed** and no location grant is held;
/// * `read-failed` — the read **failed** for some other reason (a real error the UI
///   must not dress up as progress).
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GnssStatus {
    Fix,
    Searching,
    ReceiverOff,
    PermissionRequired,
    ReadFailed,
}

/// Serialisable GNSS fix when a real `LocationManager` is bound (`bind_android`).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HostGnss {
    pub enabled: bool,
    pub has_fix: bool,
    /// Why this block reads the way it does — see [`GnssStatus`]. `has_fix` is derived
    /// from it (never set independently) so the two cannot disagree.
    pub status: GnssStatus,
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub accuracy_m: f64,
}

/// Fold the provider's answer into the snapshot's `gnss` block.
///
/// `read` is the provider's own answer and `granted` says whether the OS location grant is
/// held; the whole point of the function is that **`Err` is not `Ok(None)`**. Kept pure
/// and target-independent so the five-way distinction is pinned by a host test rather than
/// only on a device (`read_gnss` itself is `feature = "android"`).
pub fn host_gnss(
    enabled: bool,
    granted: bool,
    read: Result<Option<amos_sensor::GeoFix>, String>,
) -> HostGnss {
    let fix = read.as_ref().ok().and_then(|o| o.as_ref());
    let status = match (&read, fix) {
        (Ok(Some(_)), Some(_)) => GnssStatus::Fix,
        (Ok(_), _) if !enabled => GnssStatus::ReceiverOff,
        (Ok(_), _) => GnssStatus::Searching,
        // A failed read with no grant is the permission, and that is the fact the user can
        // act on; with a grant it is an honest error. Neither is "still searching".
        (Err(_), _) if !granted => GnssStatus::PermissionRequired,
        (Err(_), _) => GnssStatus::ReadFailed,
    };
    HostGnss {
        enabled,
        has_fix: matches!(status, GnssStatus::Fix),
        status,
        latitude_deg: fix.map(|f| f.latitude_deg).unwrap_or(0.0),
        longitude_deg: fix.map(|f| f.longitude_deg).unwrap_or(0.0),
        accuracy_m: fix.map(|f| f.horizontal_accuracy_m).unwrap_or(0.0),
    }
}

/// The Tauri event the System UI broadcasts to the WebView (via
/// [`SensorHostEvent`]) whenever a producer records a new IMU sample / camera
/// frame on the sensor bus, the energy mode changes, or the glue clears samples.
/// Flat + defensive-shape friendly so the frontend can `listen` without polling.
pub const SENSOR_DATA_EVENT: &str = "sensor-data";

/// Metadata of the newest camera frame. The frame payload bytes are intentionally
/// *never* put on the UI event bus — they stay in the media plane (the event only
/// tells the UI a new preview frame is ready, at what size/format/sequence).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HostFrameMeta {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub seq: u64,
}

impl From<&CameraFrame> for HostFrameMeta {
    fn from(f: &CameraFrame) -> Self {
        Self {
            id: f.camera.0,
            width: f.resolution.width,
            height: f.resolution.height,
            format: pixel_format_str(f.format).to_string(),
            seq: f.seq,
        }
    }
}

/// One real-time sensor change, serialized for the WebView. Exactly one of `imu`
/// / `frame` is set for `kind` `"imu"` / `"camera_frame"`; `"mode"` carries
/// `prev_mode`; `"cleared"` carries no family payload.
#[derive(Clone, Debug, Serialize)]
pub struct SensorHostEvent {
    /// Wall-clock milliseconds (UTC) when the change landed.
    pub ts_ms: u64,
    /// `"imu"` | `"camera_frame"` | `"mode"` | `"cleared"`.
    pub kind: String,
    /// Backend label the sample came from (`"live"`, or `"android"` once bound).
    pub backend: String,
    /// The energy mode in effect for this event.
    pub mode: String,
    /// Set when `kind == "imu"`.
    pub imu: Option<HostImu>,
    /// Set when `kind == "camera_frame"` (metadata only).
    pub frame: Option<HostFrameMeta>,
    /// Set when `kind == "vitals"` (steps / heart rate).
    pub vitals: Option<HostVitals>,
    /// Set when `kind == "mode"` — the mode we left.
    pub prev_mode: Option<String>,
}

fn pixel_format_str(f: PixelFormat) -> &'static str {
    match f {
        PixelFormat::Rgba8 => "rgba8",
        PixelFormat::Nv21 => "nv21",
    }
}

/// A broadcaster invoked with each [`SensorHostEvent`]; installed by the app and
/// testable by swapping in a collector.
pub(crate) type SensorNotifier = Arc<dyn Fn(SensorHostEvent) + Send + Sync>;

/// Shared notifier cell: the bus observer and `set_mode` both fire into it; the
/// app installs a broadcaster (`Tauri emit`) via [`SensorHost::set_notifier`].
struct EventSink {
    inner: Mutex<Option<SensorNotifier>>,
}

impl EventSink {
    fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// Install (replace) the effective broadcaster.
    fn set(&self, f: SensorNotifier) {
        *self.inner.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// Fire `event` into the installed broadcaster, if any (a quiet no-op before
    /// boot installs one — never a fabricated sample).
    fn fire(&self, event: SensorHostEvent) {
        let f = self.inner.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(f) = f {
            f(event);
        }
    }
}

/// **On-device GNSS provider** (feature `android`): built exactly once from the
/// app `Context` the Kotlin `SensorGlue.attachContext(...)` upcall hands over, so
/// `SensorHost`'s snapshot reflects the real `LocationManager` fix. Mirrors
/// `flashlight::device`'s once-per-attach provider static; kept Tauri-free so host
/// builds stay light.
#[cfg(feature = "android")]
mod android_ctx {
    use std::sync::{Arc, OnceLock};

    /// The real GNSS provider installed once at device attach (exactly-once).
    static PROV: OnceLock<Arc<amos_sensor::AndroidSensorProvider>> = OnceLock::new();

    /// Build + store the provider from the Kotlin-supplied `Context`. Idempotent:
    /// first attach wins; `env` is only used to create the provider's global ref.
    pub fn bind(
        vm: jni::JavaVM,
        env: &jni::JNIEnv<'_>,
        context: jni::objects::JObject<'_>,
    ) -> Result<(), String> {
        let provider =
            amos_sensor::AndroidSensorProvider::new(vm, env, context).map_err(|e| e.to_string())?;
        PROV.set(Arc::new(provider))
            .map_err(|_| "sensor provider is already bound".to_string())
    }

    /// The installed provider (`None` before Kotlin attaches). Returns a clone of
    /// the shared `Arc`, so the caller can hand it to `SensorHost` to own.
    pub fn provider() -> Option<Arc<amos_sensor::AndroidSensorProvider>> {
        PROV.get().cloned()
    }

    /// Whether a provider is installed (a previous attach won the slot).
    ///
    /// The registry's **own** state, so the JNI entry can tell the idempotent
    /// re-attach from a genuine bind failure without assuming it from `bind`'s `Err`.
    pub fn is_bound() -> bool {
        PROV.get().is_some()
    }
}

/// JNI entry: `SensorGlue.attachContext(Context)` — an instance `external fun` on
/// the Kotlin `object SensorGlue` — hands the app `Context` to Rust so the host
/// can build the real GNSS provider (`LocationManager`) lazily on first read.
///
/// # Safety
/// `env`/`context` are the JVM-supplied arguments of this native call and are live
/// for its duration; `context` is promoted to a global ref here.
#[cfg(feature = "android")]
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_SensorGlue_attachContext(
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
    if let Ok(env) = env {
        if let Ok(vm) = env.get_java_vm() {
            // The sensor context is what makes GNSS/IMU real; a silent bind failure
            // would leave the snapshot on the mock with no symptom (REQ-A187).
            // `bind` can also answer `Err` for the **idempotent** re-attach (the Kotlin
            // `SensorGlue.attach` runs on every `onStart`, and "first caller wins"),
            // which is not a failure: the provider is installed. The two cases are told
            // apart by the registry's own state, never assumed from the `Err`
            // (REQ-A1865 / F-TEL-049).
            let bound = android_ctx::bind(vm, &env, ctx);
            match crate::real_dial::attach_outcome(bound.is_err(), android_ctx::is_bound()) {
                crate::real_dial::AttachOutcome::Attached => tracing::info!(
                    target: "amos::sensor",
                    "sensor context attached (SensorGlue.attachContext)"
                ),
                crate::real_dial::AttachOutcome::AlreadyBound => tracing::debug!(
                    target: "amos::sensor",
                    "sensor context already bound — re-attach skipped, GNSS/IMU are real"
                ),
                crate::real_dial::AttachOutcome::Failed => tracing::warn!(
                    target: "amos::sensor",
                    error = %bound.err().unwrap_or_default(),
                    "sensor context not bound — GNSS/IMU stay on the mock"
                ),
            }
        }
    }
}

/// JNI entry: `SensorGlue.nativeOnImu(tsMs, ax..az, gx..gz, tempC)` — the
/// **bounded** IMU upcall the Kotlin skeleton makes for a sample it has already
/// validated.
///
/// This is the honest Rust half of the Gap-3 glue seam: it is **not wired to a
/// live bus** in this build, so it returns the typed
/// [`amos_sensor::SensorError::Provider`] from
/// [`amos_sensor::sim::native_on_imu`]. It never fabricates a sample — a JNI
/// callback that silently did nothing is exactly the "no data but looks alive"
/// failure mode the audit forbids (P0-3). The refusal is logged once per call so
/// a device bring-up with the wrong producer is visible rather than silent.
///
/// # Safety
/// `env`/`this` are the standard JNI instance-method arguments and must be valid
/// for the call.
#[cfg(feature = "android")]
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_SensorGlue_nativeOnImu(
    _env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    ts_ms: i64,
    _ax: f32,
    _ay: f32,
    _az: f32,
    _gx: f32,
    _gy: f32,
    _gz: f32,
    _temp_c: f32,
) {
    if let Err(e) = amos_sensor::sim::native_on_imu() {
        tracing::warn!(
            target: "amos::sensor",
            ts_ms,
            error = %e,
            "SensorGlue.nativeOnImu upcall not wired"
        );
    }
}

/// JNI entry: `SensorGlue.nativeOnCamera(cameraId, width, height, format, fps,
/// bytes)` — the **bounded** camera upcall. The `bytes` array length is bounded
/// against [`MAX_FRAME_BYTES`] first (an oversize payload is refused as invalid
/// arguments without touching the pixel data), then the upcall reports the same
/// honest "not wired" typed error. It never stores or returns a frame.
///
/// # Safety
/// `env`/`this` are the standard JNI instance-method arguments and must be valid
/// for the call; `bytes` is a JVM-supplied local reference live for the call.
#[cfg(feature = "android")]
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_SensorGlue_nativeOnCamera(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    camera_id: i32,
    _width: i32,
    _height: i32,
    _format: i32,
    _fps: i32,
    bytes: jni::sys::jbyteArray,
) {
    if env.is_null() || bytes.is_null() {
        return;
    }
    // One `unsafe` block for the whole borrow: `env` is the JVM-supplied JNIEnv*
    // of this native call and `bytes` a live local ref for its duration, so
    // wrapping the array reference is a local, bounded operation. The length is
    // read here and nowhere else; the pixel data is never dereferenced by Rust.
    //
    // SAFETY: both raw handles come from the JVM for this call and stay valid
    // until it returns; neither is stored or sent elsewhere.
    let (env, arr) = {
        // SAFETY: both raw handles are supplied by the JVM for this call and stay
        // valid until it returns; neither is stored or sent anywhere else, and the
        // array's pixel data is never dereferenced by Rust.
        unsafe {
            (
                jni::JNIEnv::from_raw(env),
                jni::objects::JByteArray::from_raw(bytes),
            )
        }
    };
    let Ok(env) = env else {
        return;
    };
    let payload_len = match env.get_array_length(&arr) {
        Ok(n) if n >= 0 => n as usize,
        Ok(_) => return,
        Err(e) => {
            tracing::warn!(
                target: "amos::camera",
                camera_id,
                error = %e,
                "SensorGlue.nativeOnCamera could not read the payload length"
            );
            return;
        }
    };
    if let Err(e) = amos_sensor::sim::native_on_camera(payload_len) {
        tracing::warn!(
            target: "amos::camera",
            camera_id,
            payload_len,
            error = %e,
            "SensorGlue.nativeOnCamera upcall not wired"
        );
    }
}

/// One read of the whole System-UI sensor host.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SensorHostSnapshot {
    pub backend: String,
    pub mode: String,
    pub cameras: Vec<HostCamera>,
    pub gnss: Option<HostGnss>,
    pub imu: Option<HostImu>,
    /// Latest wellness sample (steps / heart rate), absent until a producer pushes.
    #[serde(default)]
    pub vitals: Option<HostVitals>,
    /// Energy-gated "would a continuous `kind`@`hz` stream be granted?" hint.
    pub stream_gate: StreamGate,
    /// Recently completed video clips (metadata only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub video_clips: Vec<HostVideoClip>,
}

/// Whether the requested continuous stream would pass the current mode's gate.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct StreamGate {
    pub kind: String,
    pub hz: u32,
    pub allowed: bool,
    pub reason: String,
}
/// The System UI's own sensor read side: a [`LiveSensorProvider`] stream bus under
/// a [`SensorManager`] energy policy. Producers (device glue or host/dev) push the
/// newest camera frame / IMU sample; reads return the latest value, gated by mode.
pub struct SensorHost {
    manager: Arc<SensorManager>,
    bus: Arc<LiveSensorProvider>,
    /// Real-time broadcaster (see [`SensorHostEvent`]).
    sink: Arc<EventSink>,
    /// When bound on Android (`bind_android`), a real `AndroidSensorProvider`
    /// whose synchronous `LocationManager` GNSS read feeds the snapshot's `gnss`.
    #[cfg(feature = "android")]
    gnss: std::sync::Mutex<Option<Arc<amos_sensor::AndroidSensorProvider>>>,
    /// Ring of recently-recorded video clips (metadata only — bytes live in MediaStore).
    video_clips: std::sync::Mutex<Vec<HostVideoClip>>,
}

impl SensorHost {
    /// A fresh host: no cameras advertised, no samples yet. Glue calls
    /// [`Self::set_cameras`] then [`Self::record_imu`] / [`Self::record_frame`].
    pub fn new() -> Self {
        let bus = Arc::new(LiveSensorProvider::new(Vec::new(), 0));
        let manager = Arc::new(SensorManager::new(bus.clone(), SensorMode::Balanced));
        let sink = Arc::new(EventSink::new());
        let host = Self::build(Arc::clone(&manager), Arc::clone(&bus), Arc::clone(&sink));
        // Observe the shared bus so *every* producer — a WebView `record_*`
        // command, the on-device `android_glue`, a host feeder — that pushes a new
        // sample into the same bus this host reads also fans out to the notifier.
        host.wire_bus_observer();
        host
    }

    /// Register a handler translating each accepted [`StreamChange`] on the shared
    /// bus into a [`SensorHostEvent`] and firing it into the installed notifier
    /// (attaching the current mode + backend label for context). Called once from
    /// [`Self::new`]. The observer holds a `Weak` to the manager so it never forms
    /// a reference cycle with the host.
    fn wire_bus_observer(&self) {
        let sink = Arc::clone(&self.sink);
        let manager = Arc::downgrade(&self.manager);
        self.bus.subscribe(Arc::new(move |change: &StreamChange| {
            let Some(mgr) = manager.upgrade() else {
                return; // host is gone → nothing to notify
            };
            let ts_ms = now_ms();
            let mode = mgr.mode().key().to_string();
            let backend = mgr.provider_name().to_string();
            let event = match change {
                StreamChange::Imu(s) => SensorHostEvent {
                    ts_ms,
                    kind: "imu".to_string(),
                    backend,
                    mode,
                    imu: Some(HostImu::from(*s)),
                    frame: None,
                    vitals: None,
                    prev_mode: None,
                },
                StreamChange::Frame(f) => SensorHostEvent {
                    ts_ms,
                    kind: "camera_frame".to_string(),
                    backend,
                    mode,
                    imu: None,
                    frame: Some(HostFrameMeta::from(f)),
                    vitals: None,
                    prev_mode: None,
                },
                StreamChange::Vitals(v) => SensorHostEvent {
                    ts_ms,
                    kind: "vitals".to_string(),
                    backend,
                    mode,
                    imu: None,
                    frame: None,
                    vitals: Some(HostVitals::from(*v)),
                    prev_mode: None,
                },
                StreamChange::Cleared => SensorHostEvent {
                    ts_ms,
                    kind: "cleared".to_string(),
                    backend,
                    mode,
                    imu: None,
                    frame: None,
                    vitals: None,
                    prev_mode: None,
                },
            };
            sink.fire(event);
        }));
    }

    /// Install (replace) the real-time broadcaster invoked on every sensor change
    /// (accepted IMU / camera frame, energy-mode switch, sample clear). The app
    /// wires this to a Tauri `emit(SENSOR_DATA_EVENT, …)` at boot; until then each
    /// fire is a quiet no-op (never a fabricated event).
    pub fn set_notifier(&self, notifier: SensorNotifier) {
        self.sink.set(notifier);
    }

    /// Fire an app-level event directly (used for mode changes, which the stream
    /// bus itself does not observe).
    fn fire(&self, event: SensorHostEvent) {
        self.sink.fire(event);
    }

    #[cfg(feature = "android")]
    fn build(
        manager: Arc<SensorManager>,
        bus: Arc<LiveSensorProvider>,
        sink: Arc<EventSink>,
    ) -> Self {
        Self {
            manager,
            bus,
            sink,
            gnss: std::sync::Mutex::new(None),
            video_clips: std::sync::Mutex::new(Vec::new()),
        }
    }

    #[cfg(not(feature = "android"))]
    fn build(
        manager: Arc<SensorManager>,
        bus: Arc<LiveSensorProvider>,
        sink: Arc<EventSink>,
    ) -> Self {
        Self {
            manager,
            bus,
            sink,
            video_clips: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Backend label for logs / UI ("live" on this host).
    pub fn backend_label(&self) -> &'static str {
        self.manager.provider_name()
    }

    /// The shared stream bus, so device glue (`android_glue`) can be armed to push
    /// into the *same* producer this host reads.
    pub fn producer(&self) -> Arc<LiveSensorProvider> {
        Arc::clone(&self.bus)
    }

    /// Advertise the cameras the glue can serve (negotiated by a real
    /// `CameraCharacteristics` walk on device; caller-supplied on host/dev).
    pub fn set_cameras(&self, cameras: Vec<CameraConfig>) {
        self.bus.set_cameras(cameras);
    }

    /// Current energy mode.
    pub fn mode(&self) -> SensorMode {
        self.manager.mode()
    }

    /// Switch the energy mode (battery-saver → PowerSave throttling of streams).
    /// Fires a `"mode"` broadcast only when the mode actually changes.
    pub fn set_mode(&self, mode: SensorMode) {
        let prev = self.manager.mode();
        if prev == mode {
            return;
        }
        self.manager.set_mode(mode);
        self.fire(SensorHostEvent {
            ts_ms: now_ms(),
            kind: "mode".to_string(),
            backend: self.manager.provider_name().to_string(),
            mode: mode.key().to_string(),
            imu: None,
            frame: None,
            vitals: None,
            prev_mode: Some(prev.key().to_string()),
        });
    }

    /// Push the newest IMU sample from `[x,y,z]` accel/gyro (WebView / host friendly).
    ///
    /// `gyro` and `temperature_c` are `Option`: a producer that has no gyroscope
    /// (or no die-temperature source) passes `None` and the snapshot reports
    /// `null` for it — the seam does **not** default to `0` (nor to a
    /// room-temperature placeholder). A die temperature or angular rate nothing
    /// measured must stay unknown, and the screen prints `—` for it. This is the
    /// same contract the sibling `sensor_host_record_vitals` command states for
    /// its two scalars.
    pub fn record_imu_values(
        &self,
        accel: [f64; 3],
        gyro: Option<[f64; 3]>,
        temperature_c: Option<f32>,
    ) {
        let sample = ImuSample::new(
            now_ms(),
            Vec3::new(accel[0], accel[1], accel[2]),
            gyro.map(|g| Vec3::new(g[0], g[1], g[2])),
            temperature_c,
        );
        self.bus.record_imu(sample);
    }

    /// Push a whole domain [`ImuSample`] (used by Rust-side glue).
    pub fn record_imu(&self, sample: ImuSample) {
        self.bus.record_imu(sample);
    }

    /// Validate and push the newest camera frame for `camera_id`. The camera must
    /// be advertised (via [`Self::set_cameras`]) and the payload must match the
    /// config length; both are enforced before the frame is accepted, so a frame is
    /// never stored for a camera the host does not serve.
    pub fn record_frame_bytes(
        &self,
        camera_id: u32,
        width: u32,
        height: u32,
        format: &str,
        fps: u32,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        let id = CameraId(camera_id);
        if !self.bus.camera_configs().iter().any(|c| c.id == id) {
            return Err(format!(
                "camera {camera_id} is not advertised on this host; call set_cameras first"
            ));
        }
        let format = parse_format(format)?;
        let cfg = CameraConfig {
            id,
            resolution: Resolution::new(width, height),
            fps,
            format,
        };
        self.bus.record_frame(cfg, bytes).map_err(|e| e.to_string())
    }

    /// The most recent IMU sample, if the glue has pushed one.
    pub fn latest_imu(&self) -> Option<ImuSample> {
        self.bus.imu_store().latest()
    }

    /// Push the newest wellness sample (cumulative steps / heart rate). A reading
    /// passed as `None` is stored as absent — the caller must not substitute a
    /// fabricated `0`.
    pub fn record_vitals(&self, steps_total: Option<f64>, heart_rate_bpm: Option<f64>) {
        self.bus
            .record_vitals(VitalsSample::new(now_ms(), steps_total, heart_rate_bpm));
    }

    /// The most recent wellness sample, if the glue has pushed one.
    pub fn latest_vitals(&self) -> Option<VitalsSample> {
        self.bus.vitals_store().latest()
    }

    /// Record a completed video clip's metadata so the snapshot can surface it.
    pub fn record_video_clip(&self, clip: HostVideoClip) {
        if let Ok(mut guard) = self.video_clips.lock() {
            guard.push(clip);
            // Keep only the most recent 32 clips.
            let len = guard.len();
            if len > 32 {
                guard.drain(..len - 32);
            }
        }
    }

    /// The most recently recorded video clips (newest last).
    pub fn video_clips(&self) -> Vec<HostVideoClip> {
        self.video_clips
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Read the latest sample of every family + the energy mode in one go.
    pub fn snapshot(&self) -> SensorHostSnapshot {
        let cameras = self
            .bus
            .camera_configs()
            .iter()
            .map(HostCamera::from)
            .collect();
        let gnss = self.read_gnss();
        let imu = self.latest_imu().map(HostImu::from);
        let vitals = self.latest_vitals().map(HostVitals::from);
        let gate = self.acquire_gate("imu", 100);
        let video_clips = self.video_clips();
        SensorHostSnapshot {
            backend: self.backend_label().to_string(),
            mode: self.mode().key().to_string(),
            cameras,
            gnss,
            imu,
            vitals,
            stream_gate: gate,
            video_clips,
        }
    }

    /// Ask the energy policy whether a continuous `kind`@`hz` stream would be
    /// granted right now (PowerSave / hardware ceiling), without starting it.
    pub fn acquire_gate(&self, kind: &str, hz: u32) -> StreamGate {
        let k = match SensorKind::from_key(kind) {
            Some(k) => k,
            None => {
                return StreamGate {
                    kind: kind.to_string(),
                    hz,
                    allowed: false,
                    reason: "unknown sensor kind".to_string(),
                };
            }
        };
        match self.manager.acquire_stream(k, hz) {
            Ok(()) => StreamGate {
                kind: kind.to_string(),
                hz,
                allowed: true,
                reason: "granted".to_string(),
            },
            Err(e) => StreamGate {
                kind: kind.to_string(),
                hz,
                allowed: false,
                reason: e.to_string(),
            },
        }
    }

    /// **On-device**: attach a real `AndroidSensorProvider` (built from the System
    /// UI APK's JNI `JavaVM` + `Context`) so the snapshot's `gnss` reflects the real
    /// `LocationManager` fix. Camera/IMU keep flowing through the shared stream bus
    /// (pushed by the glue). Gated behind `feature = "android"` (host has no JVM).
    #[cfg(feature = "android")]
    pub fn bind_android(
        &self,
        vm: jni::JavaVM,
        env: &jni::JNIEnv<'_>,
        context: jni::objects::JObject<'_>,
    ) -> Result<(), String> {
        let provider =
            amos_sensor::AndroidSensorProvider::new(vm, env, context).map_err(|e| e.to_string())?;
        *self.gnss.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(provider));
        Ok(())
    }

    #[cfg(feature = "android")]
    fn read_gnss(&self) -> Option<HostGnss> {
        // First read on device lazily builds the real LocationManager provider from
        // the Kotlin-handled Context (`SensorGlue.attachContext`), so GNSS reflects
        // the true fix without an explicit boot ordering.
        self.ensure_gnss();
        let guard = self.gnss.lock().unwrap_or_else(|p| p.into_inner());
        let provider = guard.as_ref()?;
        let enabled = provider.gnss_enabled();
        // The `Result` is passed through intact: `.ok().flatten()` here is what used to
        // turn a `SecurityException` (no location grant) into `has_fix: false`, i.e. into
        // "still searching" — see `host_gnss`.
        Some(host_gnss(
            enabled,
            crate::location_permission::grant_held(),
            // REQ-A874 / F-SH-282: `host_gnss` reads only `Err(_)` vs `Ok` — it never inspects
            // the error, so the wire type is `String` to keep the seam target-independent. Map
            // the provider's own `SensorError` (which is `Display`) rather than widening the
            // parameter: this call site is `cfg(feature = "android")`, so for 13 hours a type
            // error here compiled nowhere the default-feature gates could see it.
            provider.gnss_fix().map_err(|e| e.to_string()),
        ))
    }

    /// If a Kotlin context has been attached but the real provider is not built yet,
    /// build it once and store it. No-op when already bound / context not present.
    #[cfg(feature = "android")]
    fn ensure_gnss(&self) {
        if self
            .gnss
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
        {
            return;
        }
        // If Kotlin has attached a context but we have not built the provider yet,
        // adopt the shared one now.
        if let Some(provider) = android_ctx::provider() {
            let mut g = self.gnss.lock().unwrap_or_else(|p| p.into_inner());
            if g.is_none() {
                *g = Some(provider);
            }
        }
    }

    #[cfg(not(feature = "android"))]
    fn read_gnss(&self) -> Option<HostGnss> {
        None
    }
}

impl Default for SensorHost {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_format(s: &str) -> Result<PixelFormat, String> {
    match s {
        "rgba8" => Ok(PixelFormat::Rgba8),
        "nv21" => Ok(PixelFormat::Nv21),
        other => Err(format!(
            "unknown pixel format: {other:?} (expected rgba8|nv21)"
        )),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(|_| 0)
}
/// Tauri command: one read of the whole System-UI sensor host.
#[tauri::command]
pub fn sensor_host_snapshot(host: State<'_, SensorHost>) -> SensorHostSnapshot {
    host.snapshot()
}

/// Tauri command: switch the energy mode (`performance`/`balanced`/`power_save`).
#[tauri::command]
pub fn sensor_host_set_mode(host: State<'_, SensorHost>, mode: String) -> Result<String, String> {
    let m = SensorMode::from_key(&mode).ok_or_else(|| {
        format!("unknown sensor mode: {mode:?} (performance|balanced|power_save)")
    })?;
    host.set_mode(m);
    Ok(host.mode().key().to_string())
}

/// Tauri command: push the newest IMU sample (host/dev + glue-harness friendly).
///
/// `gyro` and `temperature_c` are `Option`: a gyroscope-less producer passes
/// `null` for the rate and a die temperature nothing measured is sent as `null`,
/// so both stay unknown — the command does not fill in a plausible default
/// (neither `Vec3::ZERO` nor room temperature).
#[tauri::command]
pub fn sensor_host_record_imu(
    host: State<'_, SensorHost>,
    accel: [f64; 3],
    gyro: Option<[f64; 3]>,
    temperature_c: Option<f32>,
) -> Result<(), String> {
    host.record_imu_values(accel, gyro, temperature_c);
    Ok(())
}

/// Tauri command: push the newest wellness sample (cumulative steps / heart rate).
///
/// Both arguments are `Option`, and a missing reading must be sent as `null` — the
/// seam does **not** default to `0`. A `0` here is a real reading (a still device,
/// a step counter that has not advanced), so coercing an absent reading to `0`
/// would fabricate a measurement. This is also the host-feeder path for the Health
/// screen's live tile on builds without the Android step/heart-rate glue.
#[tauri::command]
pub fn sensor_host_record_vitals(
    host: State<'_, SensorHost>,
    steps_total: Option<f64>,
    heart_rate_bpm: Option<f64>,
) -> Result<(), String> {
    host.record_vitals(steps_total, heart_rate_bpm);
    Ok(())
}

/// Tauri command: validate + push the newest camera frame (NV21/RGBA8 bytes).
///
/// [`MAX_FRAME_BYTES`] bounds the caller's payload at the command seam, so a
/// buggy / malicious WebView producer cannot pour a huge buffer through the
/// bus and exhaust the process heap. The inner `bus.record_frame` then checks
/// the payload against the *advertised* camera config's expected byte count —
/// those two checks together mean: a frame larger than the advertised camera
/// is rejected, and a frame larger than the seam cap is also rejected.
#[tauri::command]
pub fn sensor_host_record_frame(
    host: State<'_, SensorHost>,
    camera_id: u32,
    width: u32,
    height: u32,
    format: String,
    fps: u32,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "camera frame too large: {} bytes (max {MAX_FRAME_BYTES})",
            bytes.len()
        ));
    }
    host.record_frame_bytes(camera_id, width, height, &format, fps, bytes)
}

/// Tauri command: energy gate check for a continuous stream (no side effects).
#[tauri::command]
pub fn sensor_host_acquire(host: State<'_, SensorHost>, kind: String, hz: u32) -> StreamGate {
    host.acquire_gate(&kind, hz)
}

// ─────────────────────────────────────────────────────────────────────────────
//  Video capture accounting
// ─────────────────────────────────────────────────────────────────────────────

/// One finished video clip produced by the host (Kotlin `MediaRecorder` or
/// WebView `MediaRecorder` fallback). Bytes are kept by the caller; the host
/// only tracks metadata for the snapshot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostVideoClip {
    pub clip_id: String,
    pub camera_id: u32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Duration in milliseconds.
    pub duration_ms: u64,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    /// Bytes on disk / in `MediaStore` — informational, not the buffer itself.
    pub size_bytes: u64,
}

/// Push a completed video clip's metadata to the host so future snapshots can
/// surface it. Returns `false` when the clip is rejected (size cap exceeded).
#[tauri::command]
pub fn sensor_host_record_video(
    host: State<'_, SensorHost>,
    clip: HostVideoClip,
) -> Result<bool, String> {
    const MAX_CLIP_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GiB hard cap.
    if clip.size_bytes > MAX_CLIP_BYTES {
        return Err(format!(
            "video clip too large: {} bytes (max {MAX_CLIP_BYTES})",
            clip.size_bytes
        ));
    }
    host.record_video_clip(clip);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_sensor::SensorKind;

    fn cam(id: u32) -> CameraConfig {
        CameraConfig {
            id: CameraId(id),
            resolution: Resolution::new(16, 16),
            fps: 30,
            format: PixelFormat::Rgba8,
        }
    }

    #[test]
    fn fresh_host_has_no_samples_and_reports_live() {
        let h = SensorHost::new();
        assert_eq!(h.backend_label(), "live");
        let snap = h.snapshot();
        assert_eq!(snap.mode, "balanced");
        assert!(snap.cameras.is_empty());
        assert_eq!(snap.imu, None);
        assert_eq!(snap.gnss, None);
    }

    #[test]
    fn record_frame_bytes_rejects_unadvertised_camera() {
        let h = SensorHost::new();
        let err = h
            .record_frame_bytes(7, 16, 16, "rgba8", 30, vec![0u8; 1024])
            .unwrap_err();
        assert!(err.contains("not advertised"), "{err}");
    }

    #[test]
    fn record_and_read_imu_and_frame_round_trip() {
        let h = SensorHost::new();
        h.set_cameras(vec![cam(0), cam(1)]);
        // RGBA8 16x16 = 1024 bytes.
        assert!(h
            .record_frame_bytes(0, 16, 16, "rgba8", 30, vec![9u8; 1024])
            .is_ok());
        // Wrong length is refused.
        assert!(h
            .record_frame_bytes(0, 16, 16, "rgba8", 30, vec![0u8; 512])
            .is_err());
        // Unknown format refused.
        assert!(h
            .record_frame_bytes(0, 16, 16, "yuv", 30, vec![0u8; 1024])
            .is_err());

        h.record_imu_values([0.1, -9.8, 0.2], Some([0.0, 0.0, 0.0]), Some(36.5));
        let snap = h.snapshot();
        assert_eq!(snap.cameras.len(), 2);
        assert_eq!(snap.cameras[0].format, "rgba8");
        let imu = snap.imu.expect("imu pushed");
        assert!((imu.accel_y + 9.8).abs() < 1e-6);
        assert_eq!(imu.temperature_c, Some(36.5));
    }

    /// A die temperature nobody measured stays `None` — the host must not fill
    /// the gap with a plausible default, and the axes must not be lost to it.
    #[test]
    fn an_absent_die_temperature_stays_unknown_on_the_host_wire() {
        let h = SensorHost::new();
        h.record_imu_values([0.1, -9.8, 0.2], Some([0.0, 0.0, 0.0]), None);
        let imu = h.snapshot().imu.expect("imu pushed");
        assert_eq!(imu.temperature_c, None);
        // The sample is otherwise complete — "no die temperature" is not
        // "no sample".
        assert!((imu.accel_y + 9.8).abs() < 1e-6);

        // Positive control: a real reading survives, so "always None" fails.
        h.record_imu_values([0.1, -9.8, 0.2], Some([0.0, 0.0, 0.0]), Some(41.0));
        assert_eq!(h.snapshot().imu.unwrap().temperature_c, Some(41.0));
    }

    /// A gyroscope-less sample serialises its absent angular rate as `null` — the
    /// sibling contract to the die temperature above, and the one
    /// `sensor_host_snapshot` broke on the field S5: it reported `gyro_x: 0` —
    /// the measurement "not rotating" — for a rate the device has no sensor for,
    /// while `temperature_c` beside it was honestly `null` (REQ-A1872 /
    /// F-SEN-008).
    #[test]
    fn a_gyroscope_less_sample_serialises_its_absent_rate_as_null() {
        let h = SensorHost::new();
        h.record_imu_values([0.1, -9.8, 0.2], None, Some(36.5));
        let json = serde_json::to_value(h.snapshot().imu.expect("imu pushed"))
            .expect("HostImu is serialisable");
        assert_eq!(json["gyro_x"], serde_json::Value::Null);
        assert_eq!(json["gyro_y"], serde_json::Value::Null);
        assert_eq!(json["gyro_z"], serde_json::Value::Null);
        // The acceleration survives: "no gyroscope" is not "no sample".
        assert!(
            json["accel_y"]
                .as_f64()
                .is_some_and(|v| (v + 9.8).abs() < 1e-6),
            "the accelerometer reading must not be lost to a missing gyroscope"
        );

        // Positive control: a measured rate serialises as a number, so "always
        // null" cannot pass the assertions above.
        h.record_imu_values([0.1, -9.8, 0.2], Some([0.01, -0.02, 0.03]), Some(36.5));
        let json = serde_json::to_value(h.snapshot().imu.unwrap()).unwrap();
        assert_eq!(json["gyro_x"], serde_json::json!(0.01));
        assert_eq!(json["gyro_z"], serde_json::json!(0.03));
    }

    #[test]
    fn power_save_mode_gates_streams_but_not_single_reads() {
        let h = SensorHost::new();
        // Balanced: a 200 Hz IMU stream is granted.
        assert!(h.acquire_gate("imu", 200).allowed);
        h.set_mode(SensorMode::PowerSave);
        assert!(
            !h.acquire_gate("imu", 200).allowed,
            "above PowerSave ceiling"
        );
        assert!(
            h.acquire_gate("imu", 10).allowed,
            "coarse motion OK in PowerSave"
        );
        assert!(
            !h.acquire_gate("barometer", 1).allowed,
            "unknown kind refused"
        );
        // Unknown mode string is refused at the command seam.
        assert!(SensorMode::from_key("turbo").is_none());
    }

    #[test]
    fn camera_kind_gate_uses_fps() {
        let h = SensorHost::new();
        h.set_cameras(vec![cam(0)]);
        h.set_mode(SensorMode::PowerSave);
        // A 30 FPS camera config > 15 FPS save ceiling → refused for capture.
        assert!(!h.acquire_gate(SensorKind::Camera.key(), 30).allowed);
        assert!(h.acquire_gate(SensorKind::Camera.key(), 15).allowed);
    }

    fn host_with_collector() -> (SensorHost, Arc<Mutex<Vec<SensorHostEvent>>>) {
        let h = SensorHost::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        h.set_notifier(Arc::new(move |e: SensorHostEvent| {
            sink.lock().unwrap_or_else(|g| g.into_inner()).push(e);
        }));
        (h, seen)
    }

    #[test]
    fn accepted_samples_broadcast_live_events() {
        let (h, seen) = host_with_collector();
        h.set_cameras(vec![cam(0)]);
        // A valid 16x16 RGBA8 frame (1024 bytes) → camera_frame event.
        h.record_frame_bytes(0, 16, 16, "rgba8", 30, vec![9u8; 1024])
            .unwrap();
        h.record_imu_values([0.0, -9.8, 0.0], Some([0.0, 0.0, 0.0]), Some(36.5));

        let got = seen.lock().unwrap_or_else(|g| g.into_inner());
        assert_eq!(got.len(), 2, "one frame + one imu event");
        let frame = got
            .iter()
            .find(|e| e.kind == "camera_frame")
            .expect("frame event");
        assert_eq!(frame.backend, "live");
        assert_eq!(frame.frame.as_ref().map(|f| f.id), Some(0));
        assert_eq!(frame.frame.as_ref().map(|f| f.seq), Some(1));
        assert_eq!(
            frame.frame.as_ref().map(|f| f.format.as_str()),
            Some("rgba8")
        );
        let imu = got.iter().find(|e| e.kind == "imu").expect("imu event");
        assert_eq!(imu.mode, "balanced");
        let s = imu.imu.as_ref().expect("imu payload");
        assert!((s.accel_y + 9.8).abs() < 1e-6);
    }

    #[test]
    fn invalid_or_unadvertised_frame_does_not_broadcast() {
        let (h, seen) = host_with_collector();
        h.set_cameras(vec![cam(0)]);
        // Wrong payload length is refused → no event.
        assert!(h
            .record_frame_bytes(0, 16, 16, "rgba8", 30, vec![0u8; 3])
            .is_err());
        // Camera never advertised → refused before the bus → no event.
        assert!(h
            .record_frame_bytes(7, 16, 16, "rgba8", 30, vec![0u8; 1024])
            .is_err());
        assert!(seen.lock().unwrap_or_else(|g| g.into_inner()).is_empty());
    }

    #[test]
    fn mode_change_broadcasts_once_with_prev_mode() {
        let (h, seen) = host_with_collector();
        h.set_mode(SensorMode::PowerSave);
        h.set_mode(SensorMode::PowerSave); // no-op: same mode
        let got = seen.lock().unwrap_or_else(|g| g.into_inner());
        assert_eq!(got.len(), 1, "only a real mode change broadcasts");
        assert_eq!(got[0].kind, "mode");
        assert_eq!(got[0].mode, "power_save");
        assert_eq!(got[0].prev_mode.as_deref(), Some("balanced"));
        assert!(got[0].imu.is_none() && got[0].frame.is_none());
    }

    #[test]
    fn no_notifier_means_quiet_noop() {
        // A fresh host with no installed notifier must not panic when samples land.
        let h = SensorHost::new();
        h.set_cameras(vec![cam(0)]);
        h.record_imu_values([0.0, -9.8, 0.0], Some([0.0, 0.0, 0.0]), Some(30.0));
        h.record_frame_bytes(0, 16, 16, "rgba8", 30, vec![9u8; 1024])
            .unwrap();
        h.set_mode(SensorMode::PowerSave);
    }

    #[test]
    fn frame_ceiling_is_the_one_shared_16_mib_value() {
        // The host command seam and the sensor bus agree on a single ceiling; a
        // divergence here is a silent accept/refuse mismatch. The *third* party
        // named in the doc comment — the Kotlin glue — is text, not Rust, so it
        // is pinned separately by `the_glue_frame_ceiling_is_pinned_to_the_kotlin_source`.
        assert_eq!(MAX_FRAME_BYTES, amos_sensor::GLUE_MAX_FRAME_BYTES);
        assert_eq!(MAX_FRAME_BYTES, 16 << 20);
        assert_eq!(amos_sensor::MAX_FRAME_BYTES, 16 * 1024 * 1024);
        // A payload one byte over that ceiling is refused at the command seam.
        let h = SensorHost::new();
        h.set_cameras(vec![cam(0)]);
        assert!(h
            .record_frame_bytes(0, 16, 16, "rgba8", 30, vec![0u8; MAX_FRAME_BYTES + 1])
            .is_err());
    }

    /// Evaluate the RHS of a Kotlin `val NAME = <int>` declaration from source
    /// text, where the RHS is a product of integer literals (Kotlin writes the
    /// ceiling as `16 * 1024 * 1024`). `_` digit separators and a trailing `//`
    /// comment are tolerated; anything else (calls, references, hex) yields
    /// `None` so the binding fails loudly rather than guessing.
    fn kt_int_product(src: &str, name: &str) -> Option<u64> {
        let needle = format!("val {name} =");
        let rest = &src[src.find(&needle)? + needle.len()..];
        let line = rest.lines().next()?.split("//").next().unwrap_or("").trim();
        let mut product: u64 = 1;
        let mut saw = false;
        for tok in line.split('*') {
            let t = tok.trim().replace('_', "");
            product = product.checked_mul(t.parse().ok()?)?;
            saw = true;
        }
        saw.then_some(product)
    }

    /// Return the source text of the Kotlin function whose signature begins with
    /// `sig` (e.g. `"fun pushImuSample("`), from that point through the brace
    /// that closes its body. `None` when the signature is absent, so a renamed
    /// or deleted function fails loudly. Nested braces — including Kotlin string
    /// templates like `${t.javaClass.simpleName}`, whose `{`/`}` balance — are
    /// counted, not naively truncated at the first `}`.
    fn kt_function_body<'a>(source: &'a str, sig: &str) -> Option<&'a str> {
        let rest = &source[source.find(sig)?..];
        let mut depth = 0usize;
        let mut saw_open = false;
        for (i, ch) in rest.char_indices() {
            match ch {
                '{' => {
                    depth += 1;
                    saw_open = true;
                }
                '}' => {
                    depth -= 1;
                    if saw_open && depth == 0 {
                        return Some(&rest[..=i]);
                    }
                }
                _ => {}
            }
        }
        None
    }

    #[test]
    fn the_glue_frame_ceiling_is_pinned_to_the_kotlin_source() {
        // `SensorGlue.kt` declares `private val MAX_FRAME_BYTES = 16 * 1024 * 1024`
        // and refuses any larger frame *before* the `nativeOnCamera` upcall. That
        // text was bound to nothing: raising it above the Rust ceiling makes Rust
        // refuse an upcall Kotlin already accepted (a wasted rejection), but
        // *lowering* it drops frames Rust would happily take — silently, with the
        // Rust test above still green because it never reads the Kotlin. This test
        // is the missing third leg of `MAX_FRAME_BYTES`.
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/SensorGlue.kt");
        let glue = kt_int_product(KOTLIN, "MAX_FRAME_BYTES")
            .expect("SensorGlue.kt must declare `val MAX_FRAME_BYTES = <int product>`");
        assert_eq!(
            glue as usize, MAX_FRAME_BYTES,
            "SensorGlue.kt MAX_FRAME_BYTES ({glue}) drifted from sensor_host::MAX_FRAME_BYTES ({MAX_FRAME_BYTES})"
        );
    }

    #[test]
    fn the_glue_reports_an_absent_die_temperature_as_nan_not_a_plausible_number() {
        // `SensorGlue.kt` reads only `TYPE_ACCELEROMETER` / `TYPE_GYROSCOPE`, and
        // Android has no die-temperature sensor behind either — so the honest value
        // is "no reading". The glue states that with `Float.NaN`, which the Rust
        // seam (`android_glue::die_temp_c`) decodes to `None`. It used to send a
        // hardcoded `25.0f`: a *plausible* number nothing measured, which is worse
        // than an obvious sentinel because no reader can tell it from a real
        // reading. This pins the Kotlin half so the placeholder cannot come back.
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/SensorGlue.kt");
        // Assert on the *declaration line*, not the whole file: the prose above it is
        // free to name the old `25.0f` it replaced.
        let decl = KOTLIN
            .lines()
            .find(|l| l.contains("NO_DIE_TEMP_C ="))
            .expect("SensorGlue.kt must declare NO_DIE_TEMP_C");
        assert!(
            decl.contains("Float.NaN"),
            "the glue's absent die temperature must be the NaN sentinel, got: {decl}"
        );
        // The old fabricated constant must be gone, not merely shadowed.
        assert!(
            !KOTLIN.contains("DEFAULT_DIE_TEMP_C"),
            "SensorGlue.kt still declares the fabricated DEFAULT_DIE_TEMP_C"
        );
        // Both upcall sites state the sentinel (the accel branch and the gyro branch).
        assert_eq!(
            KOTLIN.matches("NO_DIE_TEMP_C,").count(),
            2,
            "both recordImu call sites must pass NO_DIE_TEMP_C"
        );
    }

    /// The sibling of the die-temperature pin above, for the gyroscope axes.
    ///
    /// `SensorGlue.kt`'s accelerometer branch used to pass a hardcoded zero
    /// triple in the gyro slots, so on a device with no gyroscope (the field S5,
    /// `dumpsys sensorservice`: `geomag fusion (no gyro)`) every sample carried
    /// the measurement "not rotating" onto the wire — while the die temperature
    /// on the same sample was honestly the NaN sentinel. This pins the Kotlin
    /// half so the fabricated zero cannot come back (REQ-A1872 / F-SEN-008).
    ///
    /// This is the compilable red-first for the change: the assertions read the
    /// Kotlin *source text*, so they fail before the glue is edited and pass
    /// after — a type-widening in the Rust seam has no red-first of its own.
    #[test]
    fn the_glue_pairs_an_accel_sample_with_the_last_gyro_not_a_fabricated_zero() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/SensorGlue.kt");
        let accel = kt_function_body(KOTLIN, "Sensor.TYPE_ACCELEROMETER ->")
            .expect("SensorGlue.kt must handle TYPE_ACCELEROMETER");
        // The fabricated zero must be gone from the branch body (the message text
        // quotes the old form, so this asserts on the extracted arm, not the file).
        assert!(
            !accel.contains("0f, 0f, 0f"),
            "the accel branch still fabricates a zero angular rate, got: {accel}"
        );
        // ...replaced by the mirrored gyro readings.
        assert!(
            accel.contains("lastGyroX, lastGyroY, lastGyroZ"),
            "the accel branch must pair the last gyro reading, got: {accel}"
        );
        // The mirrors must start at the NaN "no reading" sentinel, so a
        // gyroscope-less device reports *absent* rather than `0`.
        for f in ["lastGyroX", "lastGyroY", "lastGyroZ"] {
            let decl = KOTLIN
                .lines()
                .find(|l| l.contains(&format!("private var {f} =")))
                .unwrap_or_else(|| panic!("SensorGlue.kt must declare {f}"));
            assert!(
                decl.contains("Float.NaN"),
                "{f} must start at the NaN sentinel, got: {decl}"
            );
        }
        // The gyro branch must set them, or the pairing above is always absent.
        let gyro = kt_function_body(KOTLIN, "Sensor.TYPE_GYROSCOPE ->")
            .expect("SensorGlue.kt must handle TYPE_GYROSCOPE");
        assert!(
            gyro.contains("lastGyroX = event.values[0]"),
            "the gyro branch must mirror its reading, got: {gyro}"
        );
    }

    #[test]
    fn the_glue_optional_temperature_does_not_gate_a_good_imu_sample() {
        // The Rust half of this seam already states the rule, as a test:
        // `android_glue::decode_imu` keeps a sample whose *temperature* is the
        // `NaN` "no reading" sentinel — "a NaN temperature is not grounds to
        // drop a sample with good axes" — and decodes it to `None`.
        //
        // The Kotlin half must agree. `pushImuSample` is the *recommended* entry
        // point ("Prefer [pushImuSample], which validates first") and it takes
        // the die temperature as a parameter the caller is told it may leave
        // absent (`NO_DIE_TEMP_C = Float.NaN`: Android has no die-temperature
        // source behind the accelerometer/gyro). A whole-sample finiteness gate
        // that also tests `tempC` makes the glue's own sentinel un-sendable
        // through the path the file recommends — the honest value is refused
        // before it can reach the seam that knows how to decode it. Only the six
        // motion components may gate the sample.
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/SensorGlue.kt");
        let body = kt_function_body(KOTLIN, "fun pushImuSample(")
            .expect("SensorGlue.kt must declare `fun pushImuSample(`");
        // Each axis must still be gated — otherwise "delete the guard" would
        // pass the assertion below, and a NaN axis (which poisons every derived
        // orientation) would ride through.
        for axis in ["ax", "ay", "az", "gx", "gy", "gz"] {
            assert!(
                body.contains(&format!("isFinite({axis})")),
                "pushImuSample must still refuse a non-finite axis ({axis}); body was:\n{body}"
            );
        }
        // ...but the optional scalar must not.
        assert!(
            !body.contains("isFinite(tempC)"),
            "pushImuSample gates the whole sample on the optional die temperature, \
             so the glue's own `NO_DIE_TEMP_C = Float.NaN` sentinel would be \
             refused through the recommended path; body was:\n{body}"
        );
    }

    /// The glue's wellness registration must be **retryable**, because `attach()` is
    /// the only place it is attempted and it is called more than once per session.
    ///
    /// The step counter needs the `ACTIVITY_RECOGNITION` runtime grant and the heart
    /// rate needs `BODY_SENSORS`; `registerListener` refuses a sensor whose permission
    /// is missing with a `SecurityException`. On a cold start that grant is usually
    /// still *pending* — `MainActivity.onStart` calls `AmosGlue.onStart` before the
    /// dialog is answered — and the retry the glue gets is the **second**
    /// `AmosGlue.onStart`, fired from `onRequestPermissionsResult` once the user taps
    /// Allow. `attach()` used to open with `if (attached) return` and then set
    /// `attached = true` **whatever the wellness registration did**, so that second
    /// call was skipped and the step counter stayed unregistered for the rest of the
    /// session — the Health screen drew no steps until the process was restarted.
    ///
    /// Observed on a S5 / Android 14 (REQ-A1863): the same process logged no
    /// `STEP_COUNTER (0x13)` registration while the grant was pending and **still none
    /// after it was granted**, while a fresh process (the grant now held at boot)
    /// registered 0x13 immediately.
    #[test]
    fn the_glue_retries_its_wellness_registration_on_a_later_attach() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/SensorGlue.kt");
        let attach = kt_function_body(KOTLIN, "fun attach(")
            .expect("SensorGlue.kt must declare `fun attach(`");
        // The latch. An attach pass that short-circuits on `attached` can never retry
        // the wellness registration, which is the whole of the retry hook.
        assert!(
            !attach.contains("if (attached)"),
            "attach() still short-circuits when already attached, so a wellness \
             registration refused before the permission was granted is never \
             retried; attach() body was:\n{attach}"
        );
        // ...and the attempt must really live in `attach()` — the function the second
        // `AmosGlue.onStart` reaches.
        assert!(
            attach.contains("registerWellness("),
            "attach() must attempt the wellness registration; body was:\n{attach}"
        );
        // The registration is its own step so a *later* attach can redo it: an
        // inlined attempt behind the one-shot guard would pass the two checks above
        // while staying unretryable.
        let reg = kt_function_body(KOTLIN, "fun registerWellness(").expect(
            "SensorGlue.kt must declare `fun registerWellness(` — the retryable \
             registration step attach() calls",
        );
        for (flag, sensor) in [
            ("stepCounterRegistered", "TYPE_STEP_COUNTER"),
            ("heartRateRegistered", "TYPE_HEART_RATE"),
        ] {
            assert!(
                reg.contains(sensor),
                "registerWellness must still attempt {sensor}; body was:\n{reg}"
            );
            assert!(
                reg.contains(flag),
                "registerWellness must record the {sensor} outcome in `{flag}`; \
                 body was:\n{reg}"
            );
        }
        // `detach()` unregisters the listeners, so the bookkeeping must be cleared
        // with them — otherwise a re-attach would believe a dead listener is live and
        // skip the one registration path that can bring it back.
        let detach = kt_function_body(KOTLIN, "fun detach(")
            .expect("SensorGlue.kt must declare `fun detach(`");
        for flag in ["stepCounterRegistered", "heartRateRegistered"] {
            assert!(
                detach.contains(&format!("{flag} = false")),
                "detach() must clear `{flag}`: it unregisters the listeners, and a \
                 stale `true` would make the next attach skip the re-registration; \
                 detach() body was:\n{detach}"
            );
        }
    }

    #[test]
    fn the_glue_upcall_half_is_honest_and_never_fabricates() {
        // The Rust half of the Kotlin `nativeOnImu` / `nativeOnCamera` upcalls is
        // not wired in this build: it must refuse with a typed error rather than
        // accept, so a caller can never mistake "no glue" for "data arrived".
        assert!(matches!(
            amos_sensor::sim::native_on_imu(),
            Err(amos_sensor::SensorError::Provider(_))
        ));
        assert!(matches!(
            amos_sensor::sim::native_on_camera(1024),
            Err(amos_sensor::SensorError::Provider(_))
        ));
        // The payload ceiling is enforced *before* the honest refusal.
        assert!(matches!(
            amos_sensor::sim::native_on_camera(MAX_FRAME_BYTES + 1),
            Err(amos_sensor::SensorError::InvalidArguments(_))
        ));

        // A host that never saw a push reports no IMU and no frame — the same
        // honest emptiness, now asserted at the Tauri-facing snapshot.
        let h = SensorHost::new();
        assert_eq!(h.snapshot().imu, None);
        assert!(h.latest_imu().is_none());
    }

    /// A fix is reported as `fix`, with the coordinates carried through unchanged.
    #[test]
    fn a_locked_receiver_reports_fix() {
        let g = host_gnss(true, true, Ok(Some(geo(39.9042, 116.4074, 8.0))));
        assert_eq!(g.status, GnssStatus::Fix);
        assert!(g.has_fix);
        assert_eq!(g.latitude_deg, 39.9042);
        assert_eq!(g.longitude_deg, 116.4074);
        assert_eq!(g.accuracy_m, 8.0);
    }

    /// **The defect this round closes (REQ-A772 / F-SH-228).** A *failed* read with no
    /// location grant is `permission-required`, **not** `searching`: the two used to be
    /// the same `has_fix: false`, which is why a device that had never been granted
    /// location showed a spinner that could not resolve.
    #[test]
    fn a_failed_read_without_a_grant_is_not_searching() {
        let denied = host_gnss(
            true,
            false,
            Err("SecurityException: no location grant".into()),
        );
        assert_eq!(denied.status, GnssStatus::PermissionRequired);
        assert!(!denied.has_fix);
        assert_ne!(denied.status, GnssStatus::Searching);

        // Same read, same failure, but the grant *is* held: that is a real error, and it is
        // still not progress — an error must never be dressed up as "searching".
        let broken = host_gnss(true, true, Err("LocationManager unavailable".into()));
        assert_eq!(broken.status, GnssStatus::ReadFailed);
        assert_ne!(broken.status, GnssStatus::Searching);
        assert_ne!(denied.status, broken.status);
    }

    /// The three *non-failure* no-fix states stay distinct from each other.
    #[test]
    fn the_no_fix_states_are_distinct() {
        // Receiver on, no lock yet.
        assert_eq!(
            host_gnss(true, true, Ok(None)).status,
            GnssStatus::Searching
        );
        // The provider is switched off — a setting, not a failure, and not "denied" either.
        assert_eq!(
            host_gnss(false, true, Ok(None)).status,
            GnssStatus::ReceiverOff
        );
        // A receiver that is off AND ungranted is still reported as off: the setting is the
        // fact the user set, and "off" already explains the missing fix.
        assert_eq!(
            host_gnss(false, false, Ok(None)).status,
            GnssStatus::ReceiverOff
        );
    }

    /// `has_fix` is derived from `status`, so the two can never disagree — for every one of
    /// the five states, in every combination of inputs the fold can see.
    #[test]
    fn has_fix_never_contradicts_status() {
        let reads = [
            Ok(Some(geo(1.0, 2.0, 3.0))),
            Ok(None),
            Err("boom".to_string()),
        ];
        for enabled in [true, false] {
            for granted in [true, false] {
                for read in &reads {
                    let g = host_gnss(enabled, granted, read.clone());
                    assert_eq!(
                        g.has_fix,
                        g.status == GnssStatus::Fix,
                        "has_fix disagreed with status for enabled={enabled} granted={granted}"
                    );
                    // Nothing but a real fix may carry coordinates: an ungranted or failed
                    // read must never leave the previous numbers (or a fabricated 0,0) behind
                    // looking like a place.
                    if g.status != GnssStatus::Fix {
                        assert_eq!(
                            (g.latitude_deg, g.longitude_deg, g.accuracy_m),
                            (0.0, 0.0, 0.0)
                        );
                    }
                }
            }
        }
    }

    /// The wire vocabulary the frontend branches on (`gps.ts`), pinned so a rename on
    /// either side is a red rather than a silently unhandled state.
    #[test]
    fn gnss_status_wire_spellings_are_stable() {
        let all = [
            (GnssStatus::Fix, "fix"),
            (GnssStatus::Searching, "searching"),
            (GnssStatus::ReceiverOff, "receiver-off"),
            (GnssStatus::PermissionRequired, "permission-required"),
            (GnssStatus::ReadFailed, "read-failed"),
        ];
        for (status, wire) in all {
            assert_eq!(
                serde_json::to_value(status).expect("serialisable"),
                serde_json::json!(wire)
            );
        }
    }

    /// A `GeoFix` with only the fields this module reads set.
    fn geo(lat: f64, lon: f64, accuracy_m: f64) -> amos_sensor::GeoFix {
        amos_sensor::GeoFix {
            latitude_deg: lat,
            longitude_deg: lon,
            altitude_m: 0.0,
            horizontal_accuracy_m: accuracy_m,
            fix_mode: amos_sensor::FixMode::ThreeDim,
            satellites_in_view: 9,
            timestamp_ms: 0,
        }
    }
}
