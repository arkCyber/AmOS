//! The **System UI sensor assembly point** — a managed, host-testable read side
//! for camera / IMU, independent of the daemon.
//!
//! On the no-UI Android base the real sensor HAL is reachable *from the System UI
//! APK* (it owns the `Context`), not from the headless `amos-ai` daemon. This
//! module is that host surface: a [`SensorHost`] holding an
//! `amos_sensor::LiveSensorProvider` stream bus under a `SensorManager` energy
//! policy. On-device glue (a `SensorEventListener` + `Camera2`/`ImageReader`,
//! landed next round) pushes each new sample/frame in via
//! [`SensorHost::record_imu`] / [`SensorHost::record_frame`]; the Tauri commands
//! below let the WebView read a snapshot, set the energy mode and drive the same
//! bus for host/dev bring-up.
//!
//! ```text
//! [ Android glue / host dev ]   [ WebView sensor_host commands ]
//!    record_imu/record_frame          sensor_host_snapshot …
//!            │                                  ▲
//!            ▼                                  │
//!      SensorHost { bus: LiveSensorProvider · manager: SensorManager }
//! ```
//!
//! Everything is `SensorManager`-free to unit-test: the domain types come from
//! `amos-sensor`, so host `cargo test` covers the whole assembly with no daemon,
//! no device and no Tauri app. The `android` feature adds
//! [`SensorHost::bind_android`], which attaches the real `AndroidSensorProvider`
//! (GNSS via `LocationManager`) to this host — mirroring `radio::from_android`.

use std::sync::Arc;

use amos_sensor::{
    CameraConfig, CameraId, ImuSample, LiveSensorProvider, PixelFormat, Resolution, SensorKind,
    SensorManager, SensorMode, SensorProvider, Vec3,
};
use serde::Serialize;
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
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HostImu {
    pub timestamp_ms: u64,
    pub accel_x: f64,
    pub accel_y: f64,
    pub accel_z: f64,
    pub gyro_x: f64,
    pub gyro_y: f64,
    pub gyro_z: f64,
    pub temperature_c: f32,
}

impl From<ImuSample> for HostImu {
    fn from(s: ImuSample) -> Self {
        Self {
            timestamp_ms: s.timestamp_ms,
            accel_x: s.accel_m_s2.x,
            accel_y: s.accel_m_s2.y,
            accel_z: s.accel_m_s2.z,
            gyro_x: s.gyro_rad_s.x,
            gyro_y: s.gyro_rad_s.y,
            gyro_z: s.gyro_rad_s.z,
            temperature_c: s.temperature_c,
        }
    }
}

/// Serialisable GNSS fix when a real `LocationManager` is bound (`bind_android`).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HostGnss {
    pub enabled: bool,
    pub has_fix: bool,
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub accuracy_m: f64,
}

/// One read of the whole System-UI sensor host.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SensorHostSnapshot {
    pub backend: String,
    pub mode: String,
    pub cameras: Vec<HostCamera>,
    pub gnss: Option<HostGnss>,
    pub imu: Option<HostImu>,
    /// Energy-gated "would a continuous `kind`@`hz` stream be granted?" hint.
    pub stream_gate: StreamGate,
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
    manager: SensorManager,
    bus: Arc<LiveSensorProvider>,
    /// When bound on Android (`bind_android`), a real `AndroidSensorProvider`
    /// whose synchronous `LocationManager` GNSS read feeds the snapshot's `gnss`.
    #[cfg(feature = "android")]
    gnss: std::sync::Mutex<Option<Arc<amos_sensor::AndroidSensorProvider>>>,
}

impl SensorHost {
    /// A fresh host: no cameras advertised, no samples yet. Glue calls
    /// [`Self::set_cameras`] then [`Self::record_imu`] / [`Self::record_frame`].
    pub fn new() -> Self {
        let bus = Arc::new(LiveSensorProvider::new(Vec::new(), 0));
        let manager = SensorManager::new(bus.clone(), SensorMode::Balanced);
        Self::build(manager, bus)
    }

    #[cfg(feature = "android")]
    fn build(manager: SensorManager, bus: Arc<LiveSensorProvider>) -> Self {
        Self {
            manager,
            bus,
            gnss: std::sync::Mutex::new(None),
        }
    }

    #[cfg(not(feature = "android"))]
    fn build(manager: SensorManager, bus: Arc<LiveSensorProvider>) -> Self {
        Self { manager, bus }
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
    pub fn set_mode(&self, mode: SensorMode) {
        self.manager.set_mode(mode);
    }

    /// Push the newest IMU sample from `[x,y,z]` accel/gyro (WebView / host friendly).
    pub fn record_imu_values(&self, accel: [f64; 3], gyro: [f64; 3], temperature_c: f32) {
        let sample = ImuSample::new(
            now_ms(),
            Vec3::new(accel[0], accel[1], accel[2]),
            Vec3::new(gyro[0], gyro[1], gyro[2]),
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
        let gate = self.acquire_gate("imu", 100);
        SensorHostSnapshot {
            backend: self.backend_label().to_string(),
            mode: self.mode().key().to_string(),
            cameras,
            gnss,
            imu,
            stream_gate: gate,
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
        let guard = self.gnss.lock().unwrap_or_else(|p| p.into_inner());
        let provider = guard.as_ref()?;
        let enabled = provider.gnss_enabled();
        let fix = provider.gnss_fix().ok().flatten();
        Some(HostGnss {
            enabled,
            has_fix: fix.is_some(),
            latitude_deg: fix.map(|f| f.latitude_deg).unwrap_or(0.0),
            longitude_deg: fix.map(|f| f.longitude_deg).unwrap_or(0.0),
            accuracy_m: fix.map(|f| f.horizontal_accuracy_m).unwrap_or(0.0),
        })
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
        .unwrap_or(0)
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
#[tauri::command]
pub fn sensor_host_record_imu(
    host: State<'_, SensorHost>,
    accel: [f64; 3],
    gyro: [f64; 3],
    temperature_c: f32,
) -> Result<(), String> {
    host.record_imu_values(accel, gyro, temperature_c);
    Ok(())
}

/// Tauri command: validate + push the newest camera frame (NV21/RGBA8 bytes).
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
    host.record_frame_bytes(camera_id, width, height, &format, fps, bytes)
}

/// Tauri command: energy gate check for a continuous stream (no side effects).
#[tauri::command]
pub fn sensor_host_acquire(host: State<'_, SensorHost>, kind: String, hz: u32) -> StreamGate {
    host.acquire_gate(&kind, hz)
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

        h.record_imu_values([0.1, -9.8, 0.2], [0.0, 0.0, 0.0], 36.5);
        let snap = h.snapshot();
        assert_eq!(snap.cameras.len(), 2);
        assert_eq!(snap.cameras[0].format, "rgba8");
        let imu = snap.imu.expect("imu pushed");
        assert!((imu.accel_y + 9.8).abs() < 1e-6);
        assert!((imu.temperature_c - 36.5).abs() < 1e-6);
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
}
