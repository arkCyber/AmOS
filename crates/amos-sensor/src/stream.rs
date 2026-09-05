//! The **latest-sample streaming bridge** shared by every backend.
//!
//! Camera preview and IMU are *streams*, not getters: Android delivers each new
//! frame / motion sample to a listener (a `SensorEventListener`, an
//! `ImageReader`) on its own thread, and AmOS wants the latest value on demand.
//! This module is that seam — a thread-safe, latest-value store that a producer
//! thread (the device HAL glue, or a host/dev simulator) pushes into and the
//! [`SensorProvider`] reads the newest value from. Counters/rates are `Atomic`;
//! the sample/frame payloads sit behind `Mutex`es (see `docs/sensors.md`).
//!
//! ```text
//!   [ Android SensorManager / Camera2 ImageReader listener ]   [ host/dev feeder ]
//!        │  onSensorChanged / onImageAvailable                        │
//!        └──────────────► ImuLatest / FrameLatest ◄───────────────────┘
//!                                ▲ latest()
//!                        LiveSensorProvider (SensorProvider)
//!                                │
//!                              SensorManager (policy)
//! ```
//!
//! * [`ImuLatest`] — newest [`ImuSample`] only; an out-of-order (stale) push is
//!   dropped, so readers always see the most recent motion.
//! * [`FrameLatest`] — newest validated [`CameraFrame`] per [`CameraId`]; payload
//!   length is checked against the config before a frame is accepted, and the
//!   per-camera `seq` advances monotonically.
//! * [`LiveSensorProvider`] — a `Send + Sync` [`SensorProvider`] over those
//!   stores. This is the read-side the Android backend (`crates/amos-sensor/src/
//!   android.rs`, feature `android`) and any host/device simulator share; a pull
//!   returns the latest value **only once a producer has pushed** — an honest
//!   `Provider("no … yet")` before that, never a fabricated sample.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::{Result, SensorError};
use crate::provider::SensorProvider;
use crate::spec::{CameraConfig, CameraFrame, CameraId, ImuSample};

/// The newest [`ImuSample`] delivered by a producer (any thread).
#[derive(Debug, Default)]
pub struct ImuLatest {
    latest: Mutex<Option<ImuSample>>,
    /// How many pushes have been accepted (kept for diagnostics / tests).
    recorded: AtomicU64,
}

impl ImuLatest {
    pub fn new() -> Self {
        Self::default()
    }

    /// Store `sample` as the latest value. A sample whose timestamp is older than
    /// the current one is **dropped** (out-of-order push) so readers never regress.
    pub fn record(&self, sample: ImuSample) {
        let mut guard = self.latest.lock().unwrap_or_else(|p| p.into_inner());
        let is_newer = guard
            .as_ref()
            .map(|prev| sample.timestamp_ms >= prev.timestamp_ms)
            .unwrap_or(true);
        if is_newer {
            *guard = Some(sample);
            self.recorded.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// The most recent sample, or `None` before the first accepted push.
    pub fn latest(&self) -> Option<ImuSample> {
        *self.latest.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Number of accepted pushes so far.
    pub fn recorded(&self) -> u64 {
        self.recorded.load(Ordering::Relaxed)
    }

    /// Drop the stored sample and reset the counter. Glue calls this on detach so
    /// a later re-attach never serves a stale pre-detach sample as "current".
    pub fn clear(&self) {
        *self.latest.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.recorded.store(0, Ordering::Relaxed);
    }
}

/// The newest validated [`CameraFrame`] per camera id (any producing thread).
#[derive(Debug, Default)]
pub struct FrameLatest {
    frames: Mutex<BTreeMap<CameraId, CameraFrame>>,
}

impl FrameLatest {
    pub fn new() -> Self {
        Self::default()
    }

    /// Validate and store `bytes` as the latest frame of `cfg.id`. The payload
    /// length must match `cfg.frame_len()`; a malformed frame is refused with
    /// [`SensorError::InvalidArguments`]. Each accepted push advances the
    /// per-camera `seq`.
    pub fn record(&self, cfg: CameraConfig, bytes: Vec<u8>) -> Result<()> {
        if !cfg.is_valid() {
            return Err(SensorError::InvalidArguments(format!(
                "camera config is not valid: {cfg:?}"
            )));
        }
        let expected = cfg.frame_len();
        if bytes.len() as u64 != expected {
            return Err(SensorError::InvalidArguments(format!(
                "frame payload {} bytes does not match config length {expected}",
                bytes.len()
            )));
        }
        let mut guard = self.frames.lock().unwrap_or_else(|p| p.into_inner());
        let seq = guard
            .get(&cfg.id)
            .map(|f| f.seq.saturating_add(1))
            .unwrap_or(1);
        guard.insert(
            cfg.id,
            CameraFrame {
                camera: cfg.id,
                seq,
                resolution: cfg.resolution,
                format: cfg.format,
                bytes,
            },
        );
        Ok(())
    }

    /// The most recent frame of `id`, or `None` before the first accepted push.
    pub fn latest(&self, id: CameraId) -> Option<CameraFrame> {
        self.frames
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&id)
            .cloned()
    }

    /// Drop the stored frame of one camera (e.g. on that camera's detach).
    pub fn clear(&self, id: CameraId) {
        self.frames
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
    }

    /// Drop every stored frame (e.g. on full glue detach), so a re-attach never
    /// serves a stale pre-detach frame.
    pub fn clear_all(&self) {
        self.frames
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }
}
/// A `Send + Sync` [`SensorProvider`] backed by the latest-sample stores — the
/// read-side that a device HAL (or host/dev simulator) pushes into.
///
/// GNSS is *not* streamed here (Android exposes it synchronously via
/// `LocationManager`, which `AndroidSensorProvider` calls directly); this
/// provider reports it as disabled/absent.
#[derive(Debug)]
pub struct LiveSensorProvider {
    cameras: std::sync::RwLock<Vec<CameraConfig>>,
    imu_rate_hz: AtomicU64,
    imu: ImuLatest,
    frames: FrameLatest,
}

impl Default for LiveSensorProvider {
    fn default() -> Self {
        Self::new(Vec::new(), 0)
    }
}

impl LiveSensorProvider {
    /// Build over an initial set of camera configs and an IMU report rate (Hz).
    pub fn new(cameras: Vec<CameraConfig>, imu_rate_hz: u32) -> Self {
        Self {
            cameras: std::sync::RwLock::new(cameras),
            imu_rate_hz: AtomicU64::new(u64::from(imu_rate_hz)),
            imu: ImuLatest::new(),
            frames: FrameLatest::new(),
        }
    }

    /// Replace the camera capability list (called once the Android CameraManager
    /// reports what physical cameras are available).
    pub fn set_cameras(&self, cameras: Vec<CameraConfig>) {
        *self.cameras.write().unwrap_or_else(|p| p.into_inner()) = cameras;
    }

    /// The IMU report rate the producer runs at (Hz); `0` = not negotiated yet.
    pub fn set_imu_rate_hz(&self, hz: u32) {
        self.imu_rate_hz.store(u64::from(hz), Ordering::Relaxed);
    }

    /// Producer entry point: store the newest IMU sample (e.g. from an Android
    /// `SensorEventListener` / `ASensorEventQueue`, or a host motion generator).
    pub fn record_imu(&self, sample: ImuSample) {
        self.imu.record(sample);
    }

    /// Producer entry point: store the newest camera frame. The payload is
    /// validated against `cfg` before it is accepted.
    pub fn record_frame(&self, cfg: CameraConfig, bytes: Vec<u8>) -> Result<()> {
        self.frames.record(cfg, bytes)
    }

    /// Share the store with a component that needs to push from another thread
    /// without holding this whole provider (e.g. `AndroidSensorProvider`).
    pub fn imu_store(&self) -> &ImuLatest {
        &self.imu
    }

    /// Share the frame store (see [`Self::imu_store`]).
    pub fn frame_store(&self) -> &FrameLatest {
        &self.frames
    }

    /// Clear every stored sample (IMU + all camera frames); the advertised camera
    /// list is kept. Producers (glue) call this on detach so a later re-attach
    /// never serves stale pre-detach data as current.
    pub fn clear_samples(&self) {
        self.imu.clear();
        self.frames.clear_all();
    }
}

impl SensorProvider for LiveSensorProvider {
    fn name(&self) -> &'static str {
        "live"
    }

    fn camera_configs(&self) -> Vec<CameraConfig> {
        self.cameras
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn camera_capture(&self, id: CameraId) -> Result<CameraFrame> {
        let present = self
            .cameras
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|c| c.id == id);
        if !present {
            return Err(SensorError::CameraNotFound(id));
        }
        self.frames.latest(id).ok_or_else(|| {
            SensorError::Provider(format!(
                "no camera frame received for {id:?} yet (register the Camera2/ImageReader capture)"
            ))
        })
    }

    fn gnss_enabled(&self) -> bool {
        false
    }

    fn gnss_fix(&self) -> Result<Option<crate::spec::GeoFix>> {
        Ok(None)
    }

    fn imu_rate_hz(&self) -> u32 {
        self.imu_rate_hz.load(Ordering::Relaxed) as u32
    }

    fn imu_sample(&self) -> Result<ImuSample> {
        self.imu.latest().ok_or_else(|| {
            SensorError::Provider(
                "no IMU sample received yet (register the SensorManager/SensorEventListener)"
                    .to_string(),
            )
        })
    }
}

/// Convenience alias for sharing a [`LiveSensorProvider`] by [`Arc`].
pub type SharedLiveProvider = Arc<LiveSensorProvider>;
#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::SensorManager;
    use crate::spec::{PixelFormat, Resolution, SensorKind, SensorMode, Vec3};

    fn cam(id: CameraId, w: u32, h: u32, fps: u32, format: PixelFormat) -> CameraConfig {
        CameraConfig {
            id,
            resolution: Resolution::new(w, h),
            fps,
            format,
        }
    }

    fn imu(ts: u64) -> ImuSample {
        ImuSample::new(
            ts,
            Vec3::new(0.0, -9.8, 0.0),
            Vec3::new(0.0, 0.0, 0.0),
            36.5,
        )
    }

    #[test]
    fn imu_latest_returns_none_before_first_push() {
        let s = ImuLatest::new();
        assert_eq!(s.latest(), None);
        assert_eq!(s.recorded(), 0);
    }

    #[test]
    fn imu_latest_overwrites_with_newer_and_drops_stale() {
        let s = ImuLatest::new();
        s.record(imu(10));
        s.record(imu(20));
        assert_eq!(s.latest().unwrap().timestamp_ms, 20);
        assert_eq!(s.recorded(), 2);
        // Stale (older timestamp) is dropped.
        s.record(imu(15));
        assert_eq!(s.latest().unwrap().timestamp_ms, 20);
        assert_eq!(s.recorded(), 2, "stale push must not overwrite");
    }

    #[test]
    fn frame_latest_validates_payload_and_advances_seq() {
        let f = FrameLatest::new();
        let cfg = cam(CameraId::REAR, 4, 4, 30, PixelFormat::Rgba8); // 64 bytes
                                                                     // Wrong length refused.
        assert!(f.record(cfg, vec![0u8; 63]).is_err());
        assert_eq!(f.latest(CameraId::REAR), None);
        // Valid frames stored; seq starts at 1 and advances.
        f.record(cfg, vec![7u8; 64]).unwrap();
        assert_eq!(f.latest(CameraId::REAR).unwrap().seq, 1);
        f.record(cfg, vec![9u8; 64]).unwrap();
        let latest = f.latest(CameraId::REAR).unwrap();
        assert_eq!(latest.seq, 2);
        assert!(latest.payload_is_valid());
        assert!(latest.bytes.iter().all(|b| *b == 9));
    }

    #[test]
    fn live_provider_reads_latest_pushed_through_sensor_manager() {
        let rear = cam(CameraId::REAR, 16, 16, 30, PixelFormat::Rgba8); // 1024 bytes
        let p = Arc::new(LiveSensorProvider::new(vec![rear], 200));
        let m = SensorManager::new(p.clone(), SensorMode::Balanced);

        // Before any producer push: honest error, not a fabricated sample.
        assert!(matches!(m.imu_sample(), Err(SensorError::Provider(_))));
        assert!(matches!(
            m.camera_capture(CameraId::REAR),
            Err(SensorError::Provider(_))
        ));

        p.record_imu(imu(1));
        assert_eq!(m.imu_sample().unwrap().timestamp_ms, 1);
        assert_eq!(m.imu_rate_hz(), 200);

        p.record_frame(rear, vec![1u8; 1024]).unwrap();
        let frame = m.camera_capture(CameraId::REAR).unwrap();
        assert_eq!(frame.seq, 1);
        assert_eq!(frame.resolution, rear.resolution);

        // Camera not in the config list is not found.
        assert!(matches!(
            m.camera_capture(CameraId(9)),
            Err(SensorError::CameraNotFound(CameraId(9)))
        ));
    }

    #[test]
    fn live_provider_is_cross_thread_push_and_read() {
        let rear = cam(CameraId::REAR, 8, 8, 15, PixelFormat::Rgba8); // 256 bytes
        let p = Arc::new(LiveSensorProvider::new(vec![rear], 100));
        let p2 = Arc::clone(&p);
        let writer = std::thread::spawn(move || {
            for i in 1..=5u64 {
                p2.record_imu(imu(i));
                p2.record_frame(rear, vec![i as u8; 256]).unwrap();
            }
        });
        writer.join().unwrap();
        assert_eq!(p.imu_store().latest().unwrap().timestamp_ms, 5);
        assert_eq!(p.frame_store().latest(CameraId::REAR).unwrap().seq, 5);
    }

    #[test]
    fn power_save_gating_still_applies_on_top_of_live_provider() {
        // A 30 FPS camera is above the PowerSave ceiling → the manager refuses at
        // the frame level even though the live provider would serve it in Balanced.
        let hot = cam(CameraId::REAR, 16, 16, 30, PixelFormat::Rgba8);
        let p = Arc::new(LiveSensorProvider::new(vec![hot], 200));
        let m = SensorManager::new(p.clone(), SensorMode::PowerSave);
        assert!(matches!(
            m.camera_capture(CameraId::REAR),
            Err(SensorError::PowerSaveRate {
                kind: SensorKind::Camera,
                ..
            })
        ));
        m.set_mode(SensorMode::Balanced);
        p.record_frame(hot, vec![0u8; 1024]).unwrap();
        assert!(m.camera_capture(CameraId::REAR).is_ok());

        // IMU continuous stream below the save ceiling is fine; above it is refused
        // while PowerSave.
        assert!(m.acquire_stream(SensorKind::Imu, 100).is_ok());
        m.set_mode(SensorMode::PowerSave);
        assert!(matches!(
            m.acquire_stream(SensorKind::Imu, 200),
            Err(SensorError::PowerSaveRate { .. })
        ));
    }

    #[test]
    fn imu_latest_clear_drops_sample_and_counter() {
        let s = ImuLatest::new();
        s.record(imu(10));
        assert!(s.latest().is_some());
        assert_eq!(s.recorded(), 1);
        s.clear();
        assert_eq!(s.latest(), None);
        assert_eq!(s.recorded(), 0);
    }

    #[test]
    fn frame_latest_clear_removes_selected_and_all() {
        let f = FrameLatest::new();
        let cfg = cam(CameraId::REAR, 4, 4, 30, PixelFormat::Rgba8);
        f.record(cfg, vec![7u8; 64]).unwrap();
        f.record(
            cam(CameraId::FRONT, 4, 4, 30, PixelFormat::Rgba8),
            vec![7u8; 64],
        )
        .unwrap();
        assert!(f.latest(CameraId::REAR).is_some());
        assert!(f.latest(CameraId::FRONT).is_some());
        f.clear(CameraId::REAR);
        assert_eq!(f.latest(CameraId::REAR), None);
        assert!(f.latest(CameraId::FRONT).is_some());
        f.clear_all();
        assert_eq!(f.latest(CameraId::FRONT), None);
    }

    #[test]
    fn live_clear_samples_keeps_cameras_but_drops_data() {
        let rear = cam(CameraId::REAR, 4, 4, 30, PixelFormat::Rgba8);
        let p = Arc::new(LiveSensorProvider::new(vec![rear], 200));
        p.record_imu(imu(1));
        p.record_frame(rear, vec![7u8; 64]).unwrap();
        assert!(p.imu_store().latest().is_some());
        assert!(p.frame_store().latest(CameraId::REAR).is_some());

        p.clear_samples();
        assert_eq!(p.imu_store().latest(), None);
        assert_eq!(p.frame_store().latest(CameraId::REAR), None);
        // Cameras stay advertised: a fresh frame can be recorded again.
        assert_eq!(p.camera_configs().len(), 1);
        p.record_frame(rear, vec![7u8; 64]).unwrap();
        assert!(p.frame_store().latest(CameraId::REAR).is_some());
    }
}
