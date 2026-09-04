//! Device-sensor descriptors, sample types and stream configs shared across AmOS.
//!
//! Three hardware families are modelled — the same three the roadmap lists as the
//! missing multimedia / motion surface:
//!
//! * [`CameraId`] / [`CameraConfig`] / [`CameraFrame`] — one or more physical
//!   camera sensors with a chosen resolution / FPS / pixel format.
//! * [`GeoFix`] / [`FixMode`] — a GNSS position lock (satellites, accuracy).
//! * [`ImuSample`] — a fused accelerometer + gyroscope + temperature sample.
//!
//! [`SensorKind`] is the single discriminator used by the provider seam and the
//! energy-policy [`crate::SensorManager`] (PowerSave limits are per-kind). It also
//! carries the stable key strings that a future wire service bus will reuse.

use crate::error::{Result, SensorError};

/// The sensor family a capability / sample / stream belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SensorKind {
    /// A camera (main / front / …). Continuous use is measured in "preview FPS".
    Camera,
    /// The GNSS receiver (GPS / Galileo / GLONASS / BeiDou).
    Gnss,
    /// The inertial measurement unit (accelerometer + gyroscope).
    Imu,
}

impl SensorKind {
    /// Every sensor family AmOS models.
    pub const ALL: [SensorKind; 3] = [SensorKind::Camera, SensorKind::Gnss, SensorKind::Imu];

    /// Stable wire/UI key.
    pub fn key(self) -> &'static str {
        match self {
            SensorKind::Camera => "camera",
            SensorKind::Gnss => "gnss",
            SensorKind::Imu => "imu",
        }
    }

    /// Parse from a key; `None` for unknown strings.
    pub fn from_key(s: &str) -> Option<SensorKind> {
        match s {
            "camera" => Some(SensorKind::Camera),
            "gnss" => Some(SensorKind::Gnss),
            "imu" => Some(SensorKind::Imu),
            _ => None,
        }
    }

    /// Upper bound for a single continuous sampling request, in Hz. A request
    /// above this is refused before the power policy is even consulted — it is a
    /// hardware limit, not an energy choice.
    pub fn hw_max_hz(self) -> u32 {
        match self {
            SensorKind::Camera => CAMERA_HARDWARE_MAX_FPS,
            SensorKind::Gnss => GNSS_HARDWARE_MAX_HZ,
            SensorKind::Imu => IMU_HARDWARE_MAX_HZ,
        }
    }

    /// The ceiling applied to a continuous stream while the device is in
    /// [`crate::SensorMode::PowerSave`]. `0` means "not gated by PowerSave".
    pub fn power_save_max_hz(self) -> u32 {
        match self {
            SensorKind::Camera => CAMERA_SAVE_MAX_FPS,
            SensorKind::Gnss => GNSS_SAVE_MAX_HZ,
            SensorKind::Imu => IMU_SAVE_MAX_HZ,
        }
    }
}

/// A physical camera sensor on the device (`0` = the default rear camera).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CameraId(pub u32);

impl CameraId {
    /// The default (rear) camera.
    pub const REAR: CameraId = CameraId(0);
    /// The front / selfie camera, when present.
    pub const FRONT: CameraId = CameraId(1);
}

/// A camera sensor's output size in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

impl Resolution {
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// Total pixel count, if the size is plausible.
    pub fn pixels(self) -> Option<u64> {
        if self.width == 0 || self.height == 0 {
            return None;
        }
        Some(u64::from(self.width) * u64::from(self.height))
    }
}

/// The raw pixel encoding of a [`CameraFrame`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    /// 4 bytes per pixel: R, G, B, A.
    Rgba8,
    /// Android NV21 (packed 4:2:0 — a `W×H` Y plane + interleaved VU chroma).
    /// Requires even width **and** height; it is the format most Android camera
    /// callbacks hand back by default.
    Nv21,
}

/// A requested camera stream configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CameraConfig {
    pub id: CameraId,
    pub resolution: Resolution,
    /// Target preview FPS.
    pub fps: u32,
    pub format: PixelFormat,
}

impl CameraConfig {
    /// The exact byte length a full frame at this config carries.
    ///
    /// * RGBA8: `width × height × 4`.
    /// * NV21: `width × height × 3 / 2` (both dims even); `0` when a dim is odd,
    ///   which also makes [`CameraConfig::is_valid`] false.
    pub fn frame_len(self) -> u64 {
        match self.format {
            PixelFormat::Rgba8 => {
                let w = u64::from(self.resolution.width);
                let h = u64::from(self.resolution.height);
                w * h * 4
            }
            PixelFormat::Nv21 => {
                if self.resolution.width % 2 != 0 || self.resolution.height % 2 != 0 {
                    return 0;
                }
                let w = u64::from(self.resolution.width);
                let h = u64::from(self.resolution.height);
                w * h * 3 / 2
            }
        }
    }

    /// Whether the numbers are internally consistent (nonzero / even-for-NV21
    /// dims, plausible FPS, sane total byte size).
    pub fn is_valid(&self) -> bool {
        self.resolution.pixels().is_some()
            && self.fps > 0
            && self.fps <= CAMERA_HARDWARE_MAX_FPS
            && self.frame_len() > 0
            && self.frame_len() <= MAX_FRAME_BYTES
    }
}

/// One captured camera frame (raw, uncompressed).
#[derive(Clone, Debug, PartialEq)]
pub struct CameraFrame {
    pub camera: CameraId,
    /// Monotonic frame counter from this camera.
    pub seq: u64,
    pub resolution: Resolution,
    pub format: PixelFormat,
    /// Raw pixel bytes of length [`CameraConfig::frame_len`].
    pub bytes: Vec<u8>,
}

impl CameraFrame {
    /// Whether the payload length matches what `format × resolution` requires.
    pub fn payload_is_valid(&self) -> bool {
        let cfg = CameraConfig {
            id: self.camera,
            resolution: self.resolution,
            fps: 1,
            format: self.format,
        };
        cfg.frame_len() > 0 && cfg.frame_len() == self.bytes.len() as u64
    }
}

/// The dimensional quality of a GNSS position lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FixMode {
    /// No usable lock yet.
    NoFix,
    /// 2-D (horizontal only) lock.
    TwoDim,
    /// 3-D (horizontal + vertical) lock.
    ThreeDim,
}

/// A single GNSS position fix (WGS-84).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GeoFix {
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    /// Meters above the ellipsoid; meaningful when `fix_mode` is 3-D.
    pub altitude_m: f64,
    /// Horizontal position error, meters.
    pub horizontal_accuracy_m: f64,
    pub fix_mode: FixMode,
    pub satellites_in_view: u32,
    /// Device-relative millisecond timestamp.
    pub timestamp_ms: u64,
}

impl GeoFix {
    pub fn is_plausible(&self) -> bool {
        (-90.0..=90.0).contains(&self.latitude_deg)
            && (-180.0..=180.0).contains(&self.longitude_deg)
            && self.horizontal_accuracy_m >= 0.0
            && self.horizontal_accuracy_m.is_finite()
    }
}

/// A 3-axis vector sample (m/s² for acceleration, rad/s for rotation).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    /// Euclidean magnitude (handy for gravity / angular-rate magnitude checks).
    pub fn magnitude(self) -> f64 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }
}

/// One IMU sample: fused accelerometer + gyroscope + die temperature.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImuSample {
    /// Device-relative millisecond timestamp.
    pub timestamp_ms: u64,
    /// Linear acceleration, m/s², body frame.
    pub accel_m_s2: Vec3,
    /// Angular velocity, rad/s, body frame.
    pub gyro_rad_s: Vec3,
    /// Die temperature, °C.
    pub temperature_c: f32,
}

impl ImuSample {
    pub const fn new(
        timestamp_ms: u64,
        accel_m_s2: Vec3,
        gyro_rad_s: Vec3,
        temperature_c: f32,
    ) -> Self {
        Self {
            timestamp_ms,
            accel_m_s2,
            gyro_rad_s,
            temperature_c,
        }
    }
}

/// Whether the device energy / performance mode allows a *continuous* sampling
/// request. Single-shot reads stay permitted in every mode (a one-off sample is
/// negligible); it is the high-rate drains that PowerSave throttles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SensorMode {
    /// Everything up to hardware limits — the LLM / camera / AR workload default.
    Performance,
    /// Default everyday balance: hardware limits still apply, no extra gating.
    #[default]
    Balanced,
    /// Battery-saver: continuous streams above each family's save ceiling are
    /// refused (see [`SensorKind::power_save_max_hz`]).
    PowerSave,
}

impl SensorMode {
    /// Every mode.
    pub const ALL: [SensorMode; 3] = [
        SensorMode::Performance,
        SensorMode::Balanced,
        SensorMode::PowerSave,
    ];

    pub fn key(self) -> &'static str {
        match self {
            SensorMode::Performance => "performance",
            SensorMode::Balanced => "balanced",
            SensorMode::PowerSave => "power_save",
        }
    }

    pub fn from_key(s: &str) -> Option<SensorMode> {
        match s {
            "performance" => Some(SensorMode::Performance),
            "balanced" => Some(SensorMode::Balanced),
            "power_save" => Some(SensorMode::PowerSave),
            _ => None,
        }
    }
}

// ---- sampling ceilings (see [`SensorKind::hw_max_hz`] / [`power_save_max_hz`]) ----
/// Hardware ceiling for a single camera preview request, FPS.
pub const CAMERA_HARDWARE_MAX_FPS: u32 = 240;
/// Ceiling while PowerSave: a higher-FPS preview stream is refused.
pub const CAMERA_SAVE_MAX_FPS: u32 = 15;
/// Hardware ceiling for a continuous GNSS request, Hz.
pub const GNSS_HARDWARE_MAX_HZ: u32 = 10;
/// Ceiling while PowerSave for a continuous GNSS stream, Hz.
pub const GNSS_SAVE_MAX_HZ: u32 = 1;
/// Hardware ceiling for a continuous IMU request, Hz.
pub const IMU_HARDWARE_MAX_HZ: u32 = 1000;
/// Ceiling while PowerSave for a continuous IMU stream, Hz (coarse motion
/// tracking is enough to keep the screen usable).
pub const IMU_SAVE_MAX_HZ: u32 = 25;

/// Upper bound on one decoded frame we will hold (≈ 16 MP RGBA) — a safety rail
/// against a misbehaving provider claiming an absurd allocation.
pub const MAX_FRAME_BYTES: u64 = 64 * 1024 * 1024;

/// Byte length a full frame at `cfg` carries, validated. This lets a frame
/// consumer / service bus pre-allocate exactly the right buffer.
pub fn frame_bytes_len(cfg: CameraConfig) -> Result<usize> {
    if !cfg.is_valid() {
        return Err(SensorError::InvalidArguments(format!(
            "camera config is not valid: {cfg:?}"
        )));
    }
    usize::try_from(cfg.frame_len()).map_err(|_| {
        SensorError::InvalidArguments(format!("frame length {} overflows usize", cfg.frame_len()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensor_kind_keys_round_trip() {
        for k in SensorKind::ALL {
            assert_eq!(SensorKind::from_key(k.key()), Some(k));
        }
        assert_eq!(SensorKind::from_key("barometer"), None);
    }

    #[test]
    fn sensor_kind_energy_ceilings_are_below_hardware() {
        for k in SensorKind::ALL {
            let save = k.power_save_max_hz();
            assert!(save > 0 && save <= k.hw_max_hz(), "{k:?} save ceiling off");
        }
    }

    #[test]
    fn sensor_mode_keys_round_trip_and_default_balanced() {
        assert_eq!(SensorMode::default(), SensorMode::Balanced);
        for m in SensorMode::ALL {
            assert_eq!(SensorMode::from_key(m.key()), Some(m));
        }
        assert_eq!(SensorMode::from_key("turbo"), None);
    }

    #[test]
    fn frame_len_rgba8_matches_w_h_4() {
        let cfg = CameraConfig {
            id: CameraId::REAR,
            resolution: Resolution::new(640, 480),
            fps: 30,
            format: PixelFormat::Rgba8,
        };
        assert_eq!(cfg.frame_len(), 640 * 480 * 4);
        assert_eq!(frame_bytes_len(cfg).unwrap(), 640 * 480 * 4);
    }

    #[test]
    fn nv21_frame_len_and_invalid_odd_dim() {
        let even = CameraConfig {
            id: CameraId::REAR,
            resolution: Resolution::new(4, 4),
            fps: 30,
            format: PixelFormat::Nv21,
        };
        assert_eq!(even.frame_len(), 4 * 4 * 3 / 2);
        assert!(even.is_valid());
        let odd = CameraConfig {
            resolution: Resolution::new(3, 4),
            ..even
        };
        assert_eq!(odd.frame_len(), 0, "NV21 requires even dims");
        assert!(!odd.is_valid());
        assert!(frame_bytes_len(odd).is_err());
    }

    #[test]
    fn camera_frame_payload_check() {
        let cfg = CameraConfig {
            id: CameraId::REAR,
            resolution: Resolution::new(4, 4),
            fps: 30,
            format: PixelFormat::Rgba8,
        };
        let frame = CameraFrame {
            camera: CameraId::REAR,
            seq: 1,
            resolution: cfg.resolution,
            format: cfg.format,
            bytes: vec![0u8; 64],
        };
        assert!(frame.payload_is_valid());
        let mut bad = frame.clone();
        bad.bytes = vec![0u8; 63];
        assert!(!bad.payload_is_valid());
    }

    #[test]
    fn geofix_plausibility_and_vec3_magnitude() {
        let fix = GeoFix {
            latitude_deg: 31.23,
            longitude_deg: 121.47,
            altitude_m: 10.0,
            horizontal_accuracy_m: 5.0,
            fix_mode: FixMode::ThreeDim,
            satellites_in_view: 12,
            timestamp_ms: 1000,
        };
        assert!(fix.is_plausible());
        assert_eq!(Vec3::new(3.0, 4.0, 0.0).magnitude(), 5.0, "3-4-5 triangle");
        let mut bad = fix;
        bad.latitude_deg = 91.0;
        assert!(!bad.is_plausible());
    }
}
