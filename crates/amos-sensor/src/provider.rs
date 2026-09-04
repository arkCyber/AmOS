//! Provider seams and a deterministic mock.
//!
//! The [`SensorProvider`] is the single point where the domain core talks to the
//! device's physical sensor HALs (Camera2 / `SensorManager` / `LocationManager`).
//! Like the radio/telephony cores, the provider is a deliberately **dumb read
//! register**: it answers capabilities and returns the latest camera frame /
//! GNSS fix / IMU sample. All *policy* (which continuous stream is allowed in a
//! given energy mode) lives in [`crate::SensorManager`], never here.
//!
//! For P0/P1 we ship a deterministic [`MockSensorProvider`]; the real Android
//! Camera2 / Gnss / SensorManager HAL backend replaces it behind the (future)
//! `android` seam — see `docs/sensors.md`. The method set is deliberately small
//! and synchronous (a single-shot pull per call), mirroring `amos-audio`'s `read`.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use crate::error::{Result, SensorError};
use crate::spec::{
    CameraConfig, CameraFrame, CameraId, FixMode, GeoFix, ImuSample, PixelFormat, Resolution, Vec3,
};

/// The external seam to the device sensor hardware.
///
/// Implementations must be [`Send`] + [`Sync`]; the trait is deliberately
/// synchronous so a single pull per call is cheap and easy to mock/test.
pub trait SensorProvider: Send + Sync {
    /// A short human-readable name of the backend (for logs).
    fn name(&self) -> &'static str;

    /// Every camera stream configuration this device can serve.
    fn camera_configs(&self) -> Vec<CameraConfig>;

    /// Capture one frame from `id`. Returns [`SensorError::CameraNotFound`] when
    /// no such physical camera exists.
    fn camera_capture(&self, id: CameraId) -> Result<CameraFrame>;

    /// Whether a GNSS receiver is present and enabled.
    fn gnss_enabled(&self) -> bool;

    /// The most recent position fix; `None` when no lock has been acquired yet.
    fn gnss_fix(&self) -> Result<Option<GeoFix>>;

    /// The native IMU report rate in Hz (how often the driver pushes samples).
    fn imu_rate_hz(&self) -> u32;

    /// Read the latest IMU sample.
    fn imu_sample(&self) -> Result<ImuSample>;
}

/// Deterministic, in-memory [`SensorProvider`] for tests, demos and CI.
///
/// All state lives behind a mutex so the same instance is safely shareable. Each
/// read is reproducible from a monotonic internal clock, which makes tests
/// assertable (two freshly-created mocks yield identical first samples) while
/// still exercising the real call shape. Single reads never error; requesting a
/// camera that is not present does.
pub struct MockSensorProvider {
    cameras: Vec<CameraConfig>,
    imu_rate_hz: u32,
    gnss_enabled: bool,
    state: Mutex<MockState>,
}

struct MockState {
    /// Symbolic millisecond clock, advanced per IMU/GNSS read.
    clock_ms: u64,
    camera_seq: BTreeMap<CameraId, u64>,
    /// Number of GNSS reads so far (drives the drifting fix).
    gnss_reads: u64,
}

impl MockSensorProvider {
    /// Build a provider serving exactly `cameras`, at IMU rate `imu_rate_hz`.
    pub fn new(cameras: Vec<CameraConfig>, imu_rate_hz: u32, gnss_enabled: bool) -> Self {
        Self {
            cameras,
            imu_rate_hz,
            gnss_enabled,
            state: Mutex::new(MockState {
                clock_ms: 0,
                camera_seq: BTreeMap::new(),
                gnss_reads: 0,
            }),
        }
    }

    /// A small, common device: rear + front camera (30 FPS), GNSS on, 200 Hz IMU.
    pub fn common() -> Self {
        let mk = |id: CameraId, resolution: Resolution| CameraConfig {
            id,
            resolution,
            fps: 30,
            format: PixelFormat::Rgba8,
        };
        Self::new(
            vec![
                mk(CameraId::REAR, Resolution::new(640, 480)),
                mk(CameraId::FRONT, Resolution::new(320, 240)),
            ],
            200,
            true,
        )
    }

    /// A provider with no cameras and no GNSS (a pure-IMU device).
    pub fn no_gnss() -> Self {
        Self::new(vec![], 200, false)
    }

    /// Deterministic frame pixel for a given sequence + index (independent of
    /// wall time, so it is assertable across runs).
    fn sample_byte(seq: u64, i: u64) -> u8 {
        ((seq.wrapping_mul(31)).wrapping_add(i)) as u8
    }

    /// Lock the internal state, recovering from a poisoned mutex without
    /// panicking (a test panic must never poison the shared provider for the
    /// rest of the process).
    fn lock_state(&self) -> MutexGuard<'_, MockState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Default for MockSensorProvider {
    fn default() -> Self {
        Self::common()
    }
}

impl SensorProvider for MockSensorProvider {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn camera_configs(&self) -> Vec<CameraConfig> {
        self.cameras.clone()
    }

    fn camera_capture(&self, id: CameraId) -> Result<CameraFrame> {
        let cfg = self
            .cameras
            .iter()
            .find(|c| c.id == id)
            .copied()
            .ok_or(SensorError::CameraNotFound(id))?;
        let len = usize::try_from(cfg.frame_len()).map_err(|_| {
            SensorError::Provider(format!("frame length {} overflows usize", cfg.frame_len()))
        })?;
        let mut g = self.lock_state();
        let seq = g.camera_seq.entry(id).and_modify(|s| *s += 1).or_insert(0);
        let seq = *seq;
        let bytes = (0..len).map(|i| Self::sample_byte(seq, i as u64)).collect();
        Ok(CameraFrame {
            camera: id,
            seq,
            resolution: cfg.resolution,
            format: cfg.format,
            bytes,
        })
    }

    fn gnss_enabled(&self) -> bool {
        self.gnss_enabled
    }

    fn gnss_fix(&self) -> Result<Option<GeoFix>> {
        if !self.gnss_enabled {
            return Ok(None);
        }
        let mut g = self.lock_state();
        g.clock_ms += 1000; // 1 s of simulated GNSS time
        g.gnss_reads += 1;
        let step = g.gnss_reads;
        // Drift slowly south-east so successive fixes are distinct but bounded.
        let fix = GeoFix {
            latitude_deg: 31.2300 - (step % 10) as f64 * 1e-5,
            longitude_deg: 121.4700 + (step % 10) as f64 * 1e-5,
            altitude_m: 10.0,
            horizontal_accuracy_m: 3.0,
            fix_mode: FixMode::ThreeDim,
            satellites_in_view: 11,
            timestamp_ms: g.clock_ms,
        };
        Ok(Some(fix))
    }

    fn imu_rate_hz(&self) -> u32 {
        self.imu_rate_hz
    }

    fn imu_sample(&self) -> Result<ImuSample> {
        let mut g = self.lock_state();
        // Simulated cadence → ~5 ms per sample at 200 Hz.
        g.clock_ms += 1000 / u64::from(self.imu_rate_hz).max(1);
        let t = g.clock_ms;
        let a = t % 1000;
        Ok(ImuSample::new(
            t,
            Vec3::new(a as f64 * 0.001, -9.8 + (t % 100) as f64 * 0.001, 0.0),
            Vec3::new((t % 50) as f64 * 0.01, 0.0, 0.0),
            36.5,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_fresh_mocks_are_deterministic() {
        let a = MockSensorProvider::common();
        let b = MockSensorProvider::common();
        assert_eq!(a.imu_sample().unwrap(), b.imu_sample().unwrap());
        assert_eq!(a.gnss_fix().unwrap(), b.gnss_fix().unwrap());
    }

    #[test]
    fn camera_frames_advance_seq_and_stay_valid() {
        let p = MockSensorProvider::common();
        let first = p.camera_capture(CameraId::REAR).unwrap();
        let second = p.camera_capture(CameraId::REAR).unwrap();
        assert_eq!(first.seq, 0);
        assert_eq!(second.seq, 1);
        assert!(first.payload_is_valid());
        assert_eq!(first.bytes.len(), second.bytes.len());
        assert_ne!(first.bytes, second.bytes, "frames differ per sequence");
    }

    #[test]
    fn unknown_camera_is_not_found() {
        let p = MockSensorProvider::common();
        assert_eq!(
            p.camera_capture(CameraId(99)),
            Err(SensorError::CameraNotFound(CameraId(99)))
        );
    }

    #[test]
    fn gnss_can_be_absent() {
        let p = MockSensorProvider::no_gnss();
        assert!(!p.gnss_enabled());
        assert_eq!(p.gnss_fix().unwrap(), None);
    }

    #[test]
    fn imu_rate_is_reported_and_samples_advance() {
        let p = MockSensorProvider::common();
        assert_eq!(p.imu_rate_hz(), 200);
        let s1 = p.imu_sample().unwrap();
        let s2 = p.imu_sample().unwrap();
        assert!(s2.timestamp_ms > s1.timestamp_ms);
        assert!(s2.accel_m_s2.y < 0.0, "gravity reads negative on y");
    }
}
