//! [`SensorManager`]: drives a [`SensorProvider`] and enforces the energy policy.
//!
//! The provider is deliberately a dumb read register (see [`crate::provider`]);
//! the policy that keeps on-device inference + sensors from draining the battery
//! lives here, so it is unit-testable and identical across Mock and a future real
//! backend:
//!
//! * **Single-shot reads are always allowed.** A one-off camera frame / GNSS fix
//!   / IMU sample costs almost nothing; AmOS never refuses a pull.
//! * **Continuous sampling is energy-gated.** An app *declares* a continuous
//!   stream (`acquire_stream`) with a desired rate. In
//!   [`SensorMode::PowerSave`] any stream above that family's save ceiling is
//!   refused ([`SensorError::PowerSaveRate`]); a rate above the **hardware**
//!   ceiling is refused in every mode ([`SensorError::TooFast`]).
//! * Camera capture mirrors the same idea for preview: while PowerSave, a camera
//!   whose config demands a higher FPS than the save ceiling is refused at the
//!   frame level too (the app must open a lower-FPS preview).

use std::sync::Arc;

use crate::error::{Result, SensorError};
use crate::provider::SensorProvider;
use crate::spec::{CameraConfig, CameraFrame, CameraId, GeoFix, ImuSample, SensorKind, SensorMode};

/// A policy-owning handle over one [`SensorProvider`].
pub struct SensorManager {
    provider: Arc<dyn SensorProvider>,
    mode: std::sync::Mutex<SensorMode>,
}

impl SensorManager {
    /// Wrap a provider (Mock today; a real Android HAL backend later).
    pub fn new(provider: Arc<dyn SensorProvider>, mode: SensorMode) -> Self {
        Self {
            provider,
            mode: std::sync::Mutex::new(mode),
        }
    }

    /// The current energy / performance mode.
    pub fn mode(&self) -> SensorMode {
        let m = self.mode.lock().unwrap_or_else(|p| p.into_inner());
        *m
    }

    /// Switch the energy mode (how the System UI reflects a battery-saver toggle).
    pub fn set_mode(&self, mode: SensorMode) {
        let mut m = self.mode.lock().unwrap_or_else(|p| p.into_inner());
        *m = mode;
    }

    /// Name of the underlying backend.
    pub fn provider_name(&self) -> &'static str {
        self.provider.name()
    }

    /// Every camera the device can serve.
    pub fn camera_configs(&self) -> Vec<CameraConfig> {
        self.provider.camera_configs()
    }

    /// Capture one frame from a camera, gated by the PowerSave preview ceiling.
    pub fn camera_capture(&self, id: CameraId) -> Result<CameraFrame> {
        let cfg = self
            .provider
            .camera_configs()
            .into_iter()
            .find(|c| c.id == id)
            .ok_or(SensorError::CameraNotFound(id))?;
        if self.mode() == SensorMode::PowerSave && cfg.fps > SensorKind::Camera.power_save_max_hz()
        {
            return Err(SensorError::PowerSaveRate {
                kind: SensorKind::Camera,
                requested_hz: cfg.fps,
                max_hz: SensorKind::Camera.power_save_max_hz(),
            });
        }
        self.provider.camera_capture(id)
    }

    /// Whether a GNSS receiver is present and enabled.
    pub fn gnss_enabled(&self) -> bool {
        self.provider.gnss_enabled()
    }

    /// Latest GNSS fix (`None` before the first lock). Single reads are always
    /// allowed regardless of mode.
    pub fn gnss_fix(&self) -> Result<Option<GeoFix>> {
        self.provider.gnss_fix()
    }

    /// Native IMU report rate in Hz.
    pub fn imu_rate_hz(&self) -> u32 {
        self.provider.imu_rate_hz()
    }

    /// Read the latest IMU sample (always allowed).
    pub fn imu_sample(&self) -> Result<ImuSample> {
        self.provider.imu_sample()
    }

    /// Declare intent to sample `kind` continuously at `rate_hz`. This is the
    /// gate that protects the battery: PowerSave throttles continuous streams to
    /// each family's save ceiling, and the hardware ceiling always applies.
    pub fn acquire_stream(&self, kind: SensorKind, rate_hz: u32) -> Result<()> {
        if rate_hz == 0 {
            return Err(SensorError::InvalidArguments(format!(
                "cannot acquire a {kind:?} stream at 0 Hz"
            )));
        }
        let hw = kind.hw_max_hz();
        if rate_hz > hw {
            return Err(SensorError::TooFast {
                kind,
                requested_hz: rate_hz,
                max_hz: hw,
            });
        }
        let mode = self.mode();
        if mode == SensorMode::PowerSave {
            let save = kind.power_save_max_hz();
            if save > 0 && rate_hz > save {
                return Err(SensorError::PowerSaveRate {
                    kind,
                    requested_hz: rate_hz,
                    max_hz: save,
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::MockSensorProvider;
    use crate::spec::{PixelFormat, Resolution};

    fn manager(mode: SensorMode) -> SensorManager {
        SensorManager::new(Arc::new(MockSensorProvider::common()), mode)
    }

    #[test]
    fn mode_default_and_switch_round_trip() {
        let m = manager(SensorMode::Balanced);
        assert_eq!(m.mode(), SensorMode::Balanced);
        m.set_mode(SensorMode::PowerSave);
        assert_eq!(m.mode(), SensorMode::PowerSave);
    }

    #[test]
    fn single_shot_reads_always_allowed_in_power_save() {
        let m = manager(SensorMode::PowerSave);
        assert!(m.gnss_fix().is_ok());
        assert!(m.imu_sample().is_ok());
    }

    #[test]
    fn power_save_refuses_high_fps_camera_preview() {
        let m = manager(SensorMode::Balanced);
        // common() rear camera is 30 FPS → fine in Balanced.
        assert!(m.camera_capture(CameraId::REAR).is_ok());
        m.set_mode(SensorMode::PowerSave);
        let err = m.camera_capture(CameraId::REAR).unwrap_err();
        assert!(
            matches!(
                err,
                SensorError::PowerSaveRate {
                    kind: SensorKind::Camera,
                    ..
                }
            ),
            "{err}"
        );
        // Re-enter Balanced and the same camera unlocks again.
        m.set_mode(SensorMode::Balanced);
        assert!(m.camera_capture(CameraId::REAR).is_ok());
    }

    #[test]
    fn power_save_throttles_continuous_imu_stream() {
        let m = manager(SensorMode::Balanced);
        // 200 Hz IMU continuous is fine in Balanced…
        assert!(m.acquire_stream(SensorKind::Imu, 200).is_ok());
        m.set_mode(SensorMode::PowerSave);
        // …but refused above the 25 Hz save ceiling.
        let err = m.acquire_stream(SensorKind::Imu, 200).unwrap_err();
        assert!(
            matches!(
                err,
                SensorError::PowerSaveRate {
                    kind: SensorKind::Imu,
                    ..
                }
            ),
            "{err}"
        );
        // A coarse 10 Hz motion stream is still allowed in PowerSave.
        assert!(m.acquire_stream(SensorKind::Imu, 10).is_ok());
    }

    #[test]
    fn power_save_throttles_continuous_gnss_stream() {
        let m = manager(SensorMode::PowerSave);
        let err = m.acquire_stream(SensorKind::Gnss, 5).unwrap_err();
        assert!(
            matches!(
                err,
                SensorError::PowerSaveRate {
                    kind: SensorKind::Gnss,
                    ..
                }
            ),
            "{err}"
        );
        assert!(m.acquire_stream(SensorKind::Gnss, 1).is_ok());
    }

    #[test]
    fn hardware_ceiling_applies_in_every_mode() {
        for mode in SensorMode::ALL {
            let m = manager(mode);
            let err = m.acquire_stream(SensorKind::Imu, 5000).unwrap_err();
            assert!(matches!(err, SensorError::TooFast { .. }), "{mode:?} {err}");
        }
    }

    #[test]
    fn zero_rate_is_rejected() {
        let m = manager(SensorMode::Balanced);
        assert!(m.acquire_stream(SensorKind::Gnss, 0).is_err());
    }

    #[test]
    fn missing_camera_surfaces_camera_not_found() {
        let m = manager(SensorMode::Balanced);
        assert!(matches!(
            m.camera_capture(CameraId(77)),
            Err(SensorError::CameraNotFound(CameraId(77)))
        ));
    }

    #[test]
    fn power_save_allows_camera_exactly_at_ceiling() {
        // A 15 FPS camera config is exactly at the ceiling → allowed in PowerSave.
        let cfg = CameraConfig {
            id: CameraId(3),
            resolution: Resolution::new(640, 480),
            fps: 15,
            format: PixelFormat::Rgba8,
        };
        let provider = MockSensorProvider::new(vec![cfg], 200, false);
        let m = SensorManager::new(Arc::new(provider), SensorMode::PowerSave);
        assert!(m.camera_capture(CameraId(3)).is_ok());
    }
}
