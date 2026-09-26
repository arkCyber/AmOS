//! A **host-side deterministic producer** for the camera / IMU live path.
//!
//! The real producer is the System UI APK's Kotlin glue (`SensorGlue.kt`): an
//! `ImageReader`/`Camera2` capture session and a `SensorEventListener` push each
//! new frame / motion sample into the shared [`LiveSensorProvider`] bus. That
//! glue only exists on a device, which leaves the *whole* live read path
//! (validated frame store, monotonic per-camera `seq`, stale-IMU dropping,
//! energy gating, `SensorHost` fan-out) untestable on a host.
//!
//! This module is the missing half of the test story: a **deterministic
//! simulator** that generates the two producer inputs — a checkerboard camera
//! pattern and a smooth sinusoidal motion — as pure functions of their inputs,
//! so the same `t_ms` / `phase` always yields byte-identical output. Nothing
//! here is random and nothing here is a device claim: a simulator frame is
//! *produced by a test harness*, never presented as a device measurement.
//!
//! The wellness pair (steps / heart rate) is driven the same way through
//! [`SimHarness::push_vitals`]; it has no generator of its own because the whole
//! point of a vitals sample is that either field may be *absent*, and a caller
//! states that directly rather than having it synthesised.
//!
//! ```text
//!   checkerboard(cfg, phase) ─┐
//!   deterministic_motion(t)  ─┴─► SimHarness ─► LiveSensorProvider ─► SensorManager
//!                       (drops counted)          (the real bus)
//! ```
//!
//! # Honest boundary
//!
//! [`native_on_camera`] / [`native_on_imu`] are the Rust half of the Kotlin
//! `SensorGlue.nativeOnCamera` / `nativeOnImu` upcalls. They are **not wired**:
//! the JNI trampolines that call them *are* registered (see
//! `crates/amos-tauri/src/sensor_host.rs`, feature `android`), but no producer is
//! glued to them — the System UI's live path goes through `SensorGlue.recordImu`
//! / `CameraGlue.recordFrame` instead (`crates/amos-tauri/src/android_glue.rs`),
//! and Kotlin never calls `nativeOnImu` / `nativeOnCamera`. So they return a
//! typed [`SensorError::Provider`] — never a fabricated frame or sample. That is
//! the same rule `crates/amos-sensor/src/android.rs` follows for a bus no
//! producer has pushed into yet.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::error::{Result, SensorError};
use crate::provider::SensorProvider;
use crate::spec::{CameraConfig, CameraId, ImuSample, PixelFormat, Vec3, VitalsSample};
use crate::stream::{LiveSensorProvider, SharedLiveProvider};

/// Upper bound on one camera-frame payload crossing the glue seam.
///
/// The Kotlin `SensorGlue.nativeOnCamera` checks this **before** the upcall, and
/// [`SimHarness::push_frame`] checks it again here, so a runaway or hostile
/// producer cannot pour an unbounded buffer through the JNI seam. 16 MiB is a
/// 4 MP RGBA frame (or a ~11 MP NV21 frame) — far above any preview the System
/// UI negotiates, far below "size of the process heap".
pub const GLUE_MAX_FRAME_BYTES: usize = 16 << 20;

/// Simulated die temperature (°C) — a constant, so a simulated sample is fully
/// reproducible. Unlike the Android glue, the *simulator* does have a temperature
/// to report (nothing here is a device claim — see the module doc), so it states
/// one rather than `None`.
const SIM_TEMP_C: f32 = 36.5;
/// Peak sinusoidal acceleration of the simulated motion (m/s²).
const MOTION_ACCEL_M_S2: f64 = 2.0;
/// Peak sinusoidal angular rate of the simulated motion (rad/s).
const MOTION_GYRO_RAD_S: f64 = 0.1;
/// Frequency of the simulated motion (Hz).
const MOTION_HZ: f64 = 0.5;
/// Standard gravity (m/s²).
const GRAVITY_M_S2: f64 = 9.806_65;
/// Checker cell size as a fraction of the smaller frame dimension.
const CHECKER_CELLS_PER_EDGE: u32 = 8;

/// A deterministic checkerboard frame for `cfg`, shifted by `phase`.
///
/// * RGBA8 → white `#FFFFFFFF` / black `#000000FF` squares.
/// * NV21 → luma 235 / 16 squares with a neutral (128) chroma plane.
///
/// The result length is exactly [`CameraConfig::frame_len`], so it round-trips
/// through [`crate::stream::FrameLatest::record`]'s length validation. `phase`
/// shifts the pattern by one cell per unit, which is what makes consecutive
/// frames *distinguishable* without making the function non-deterministic.
pub fn checkerboard(cfg: CameraConfig, phase: u64) -> Result<Vec<u8>> {
    if !cfg.is_valid() {
        return Err(SensorError::InvalidArguments(format!(
            "camera config is not valid: {cfg:?}"
        )));
    }
    let w = cfg.resolution.width as usize;
    let h = cfg.resolution.height as usize;
    let cell = u64::from(
        (cfg.resolution.width.min(cfg.resolution.height) / CHECKER_CELLS_PER_EDGE).max(1),
    );
    let lit =
        |x: usize, y: usize| -> bool { ((x as u64 / cell) + (y as u64 / cell) + phase) % 2 == 0 };

    let len = usize::try_from(cfg.frame_len()).map_err(|_| {
        SensorError::InvalidArguments(format!(
            "frame length {} overflows usize for {cfg:?}",
            cfg.frame_len()
        ))
    })?;
    let mut out = vec![0u8; len];
    match cfg.format {
        PixelFormat::Rgba8 => {
            for y in 0..h {
                for x in 0..w {
                    let v = if lit(x, y) { 0xFF } else { 0x00 };
                    let i = (y * w + x) * 4;
                    out[i] = v;
                    out[i + 1] = v;
                    out[i + 2] = v;
                    out[i + 3] = 0xFF;
                }
            }
        }
        PixelFormat::Nv21 => {
            for y in 0..h {
                for x in 0..w {
                    out[y * w + x] = if lit(x, y) { 235 } else { 16 };
                }
            }
            // Neutral chroma: V/U = 128 is "no colour", the honest filler for a
            // luma-only test pattern.
            for b in out[w * h..].iter_mut() {
                *b = 128;
            }
        }
    }
    Ok(out)
}

/// A deterministic IMU sample for device-relative time `t_ms`.
///
/// Pure: the same `t_ms` always yields the same sample (bit for bit), which is
/// what lets a test assert a sequence rather than "something happened". Gravity
/// sits on `-y` in the device body frame (`+y` accel here because the sensor
/// reports reaction force), with a 0.5 Hz sinusoid on x/z.
pub fn deterministic_motion(t_ms: u64) -> ImuSample {
    let t = t_ms as f64 / 1000.0;
    let omega = std::f64::consts::TAU * MOTION_HZ;
    let (sin, cos) = (omega * t).sin_cos();
    ImuSample::new(
        t_ms,
        Vec3::new(
            sin * MOTION_ACCEL_M_S2,
            GRAVITY_M_S2,
            cos * MOTION_ACCEL_M_S2,
        ),
        Some(Vec3::new(
            cos * MOTION_GYRO_RAD_S,
            sin * MOTION_GYRO_RAD_S,
            MOTION_GYRO_RAD_S / 2.0,
        )),
        Some(SIM_TEMP_C),
    )
}

/// A deterministic producer over a real [`LiveSensorProvider`].
///
/// This is a *test/bring-up* harness, not a device backend: it owns the same
/// latest-sample bus the Android glue pushes into, and it counts what the bus
/// accepted vs refused. The counters are the point — a producer that silently
/// drops frames is a failure mode (F-SEN-001/002), so it is measured rather than
/// assumed.
pub struct SimHarness {
    provider: SharedLiveProvider,
    frames_accepted: AtomicU64,
    frames_dropped: AtomicU64,
    imu_accepted: AtomicU64,
    imu_stale_dropped: AtomicU64,
    vitals_announced: AtomicU64,
    vitals_ignored: AtomicU64,
}

impl std::fmt::Debug for SimHarness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SimHarness")
            .field("frames_accepted", &self.frames_accepted)
            .field("frames_dropped", &self.frames_dropped)
            .field("imu_accepted", &self.imu_accepted)
            .field("imu_stale_dropped", &self.imu_stale_dropped)
            .field("vitals_announced", &self.vitals_announced)
            .field("vitals_ignored", &self.vitals_ignored)
            .finish_non_exhaustive()
    }
}

impl SimHarness {
    /// A harness advertising `cameras` and reporting `imu_rate_hz`.
    pub fn new(cameras: Vec<CameraConfig>, imu_rate_hz: u32) -> Self {
        Self {
            provider: Arc::new(LiveSensorProvider::new(cameras, imu_rate_hz)),
            frames_accepted: AtomicU64::new(0),
            frames_dropped: AtomicU64::new(0),
            imu_accepted: AtomicU64::new(0),
            imu_stale_dropped: AtomicU64::new(0),
            vitals_announced: AtomicU64::new(0),
            vitals_ignored: AtomicU64::new(0),
        }
    }

    /// The shared bus a reader (`SensorManager` / `SensorHost`) reads from.
    pub fn provider(&self) -> SharedLiveProvider {
        Arc::clone(&self.provider)
    }

    /// The advertised cameras (a copy — the provider owns the list).
    pub fn cameras(&self) -> Vec<CameraConfig> {
        self.provider.camera_configs()
    }

    /// The latest `seq` accepted for `id`, or `None` before the first frame.
    pub fn seq_of(&self, id: CameraId) -> Option<u64> {
        self.provider.frame_store().latest(id).map(|f| f.seq)
    }

    /// Push one IMU sample. Returns whether the bus **accepted** it: a sample
    /// whose timestamp is older than the current one is dropped as stale (so a
    /// reader never regresses), mirroring `ImuLatest::record`.
    pub fn push_imu(&self, sample: ImuSample) -> bool {
        let accepted = match self.provider.imu_store().latest() {
            Some(prev) => sample.timestamp_ms >= prev.timestamp_ms,
            None => true,
        };
        if accepted {
            self.provider.record_imu(sample);
            self.imu_accepted.fetch_add(1, Ordering::Relaxed);
        } else {
            self.imu_stale_dropped.fetch_add(1, Ordering::Relaxed);
        }
        accepted
    }

    /// Push one wellness sample (cumulative steps / heart rate). Returns whether
    /// the bus **announced** it — the store announces only a material change, so
    /// an identical re-push (or a reading-less sample with nothing to retract) is
    /// counted in [`Self::vitals_ignored`] rather than silently vanishing.
    pub fn push_vitals(&self, sample: VitalsSample) -> bool {
        // Ask the store, rather than re-deriving its material-change rule here: the
        // store is the one authority on what counts as a change (see
        // `VitalsLatest::record`), and a second copy of that rule would drift.
        let before = self.provider.vitals_store().recorded();
        self.provider.record_vitals(sample);
        let announced = self.provider.vitals_store().recorded() > before;
        if announced {
            self.vitals_announced.fetch_add(1, Ordering::Relaxed);
        } else {
            self.vitals_ignored.fetch_add(1, Ordering::Relaxed);
        }
        announced
    }

    /// Push one camera frame for `cfg`. The payload must not exceed
    /// [`GLUE_MAX_FRAME_BYTES`] **and** must be exactly `cfg.frame_len()` bytes
    /// (the bus's own check). A refusal is counted in
    /// [`Self::frames_dropped`] — a drop that left no counter would be the
    /// silent failure this seam exists to make visible.
    pub fn push_frame(&self, cfg: CameraConfig, bytes: Vec<u8>) -> Result<u64> {
        if bytes.len() > GLUE_MAX_FRAME_BYTES {
            self.frames_dropped.fetch_add(1, Ordering::Relaxed);
            return Err(SensorError::InvalidArguments(format!(
                "camera frame payload {} bytes exceeds the {GLUE_MAX_FRAME_BYTES} byte ceiling",
                bytes.len()
            )));
        }
        if let Err(e) = self.provider.record_frame(cfg, bytes) {
            self.frames_dropped.fetch_add(1, Ordering::Relaxed);
            return Err(e);
        }
        self.frames_accepted.fetch_add(1, Ordering::Relaxed);
        Ok(self.seq_of(cfg.id).unwrap_or(0))
    }

    /// Generate + push one checkerboard frame of `cfg` for `phase`.
    pub fn next_frame(&self, cfg: CameraConfig, phase: u64) -> Result<u64> {
        let bytes = checkerboard(cfg, phase)?;
        self.push_frame(cfg, bytes)
    }

    /// Advance the simulation to `t_ms`: one motion sample plus one frame per
    /// advertised camera. Returns the frame `seq`s in advertised order.
    pub fn step(&self, t_ms: u64) -> Result<Vec<u64>> {
        self.push_imu(deterministic_motion(t_ms));
        let mut seqs = Vec::new();
        for cfg in self.cameras() {
            seqs.push(self.next_frame(cfg, t_ms)?);
        }
        Ok(seqs)
    }

    /// Frames accepted by the bus so far.
    pub fn frames_accepted(&self) -> u64 {
        self.frames_accepted.load(Ordering::Relaxed)
    }

    /// Frames refused (oversize or length mismatch).
    pub fn frames_dropped(&self) -> u64 {
        self.frames_dropped.load(Ordering::Relaxed)
    }

    /// IMU samples accepted by the bus so far.
    pub fn imu_accepted(&self) -> u64 {
        self.imu_accepted.load(Ordering::Relaxed)
    }

    /// IMU samples dropped as stale (out-of-order push).
    pub fn imu_stale_dropped(&self) -> u64 {
        self.imu_stale_dropped.load(Ordering::Relaxed)
    }

    /// Wellness pushes the bus announced (a material change).
    pub fn vitals_announced(&self) -> u64 {
        self.vitals_announced.load(Ordering::Relaxed)
    }

    /// Wellness pushes the bus ignored (unchanged, stale, or carrying no reading
    /// with nothing to retract).
    pub fn vitals_ignored(&self) -> u64 {
        self.vitals_ignored.load(Ordering::Relaxed)
    }
}

/// Rust half of the Kotlin `SensorGlue.nativeOnImu(sample)` upcall.
///
/// **Not wired.** No producer is glued to this upcall, so it always returns a
/// typed [`SensorError::Provider`] and a caller can never mistake "no glue" for
/// "a sample arrived". See the module docs for why this seam is not the live one.
pub fn native_on_imu() -> Result<()> {
    Err(SensorError::Provider(
        "SensorGlue.nativeOnImu is not wired on this build: the System UI APK's SensorEventListener \
         producer has not been attached to a live bus (device bring-up step; see docs/sensors.md)"
            .to_string(),
    ))
}

/// Rust half of the Kotlin `SensorGlue.nativeOnCamera(camera, bytes)` upcall.
///
/// The `payload_len` is bounded by [`GLUE_MAX_FRAME_BYTES`] first (an oversize
/// payload is refused as invalid arguments), then the upcall reports the same
/// honest "not wired" [`SensorError::Provider`] as [`native_on_imu`]. It never
/// stores or returns a frame.
pub fn native_on_camera(payload_len: usize) -> Result<()> {
    if payload_len > GLUE_MAX_FRAME_BYTES {
        return Err(SensorError::InvalidArguments(format!(
            "camera frame payload {payload_len} bytes exceeds the {GLUE_MAX_FRAME_BYTES} byte ceiling"
        )));
    }
    Err(SensorError::Provider(
        "SensorGlue.nativeOnCamera is not wired on this build: the System UI APK's Camera2/ImageReader \
         producer has not been attached to a live bus (device bring-up step; see docs/sensors.md)"
            .to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{Resolution, SensorKind, SensorMode};
    use crate::SensorManager;

    fn cam(id: CameraId, w: u32, h: u32, fps: u32, format: PixelFormat) -> CameraConfig {
        CameraConfig {
            id,
            resolution: Resolution::new(w, h),
            fps,
            format,
        }
    }

    #[test]
    fn checkerboard_is_deterministic_and_the_right_length() {
        let cfg = cam(CameraId::REAR, 8, 8, 30, PixelFormat::Rgba8); // 256 bytes
        let a = checkerboard(cfg, 0).unwrap();
        let b = checkerboard(cfg, 0).unwrap();
        assert_eq!(a, b, "same phase must be byte-identical");
        assert_eq!(a.len(), cfg.frame_len() as usize);
        // The alpha channel is always opaque; luma is only black or white.
        for px in a.chunks_exact(4) {
            assert_eq!(px[3], 0xFF);
            assert!(px[0] == 0x00 || px[0] == 0xFF);
        }
        // A phase shift changes the pattern (frames must be distinguishable).
        assert_ne!(a, checkerboard(cfg, 1).unwrap());

        // NV21 uses the documented 4:2:0 length and a neutral chroma plane.
        let nv = cam(CameraId::REAR, 8, 8, 30, PixelFormat::Nv21);
        let bytes = checkerboard(nv, 0).unwrap();
        assert_eq!(bytes.len(), 8 * 8 * 3 / 2);
        assert!(bytes[8 * 8..].iter().all(|b| *b == 128));
        assert!(bytes[..8 * 8].iter().all(|b| *b == 16 || *b == 235));
    }

    #[test]
    fn checkerboard_refuses_an_invalid_config() {
        let odd = cam(CameraId::REAR, 3, 4, 30, PixelFormat::Nv21);
        assert!(matches!(
            checkerboard(odd, 0),
            Err(SensorError::InvalidArguments(_))
        ));
    }

    #[test]
    fn deterministic_motion_is_a_pure_function_of_time() {
        let a = deterministic_motion(1_000);
        let b = deterministic_motion(1_000);
        assert_eq!(a, b);
        assert_ne!(a, deterministic_motion(1_500));
        // Gravity is on the body-frame y axis and the temperature is the constant.
        assert!((a.accel_m_s2.y - GRAVITY_M_S2).abs() < 1e-12);
        assert_eq!(a.temperature_c, Some(SIM_TEMP_C));
        // The simulated device has a gyroscope, so its rate is present and finite.
        assert!(a.accel_m_s2.x.is_finite());
        assert!(a.gyro_rad_s.expect("the sim models a gyro").z.is_finite());
        assert_eq!(a.timestamp_ms, 1_000);
    }

    #[test]
    fn harness_advances_frames_seq_in_order_and_matches_the_imu_rate() {
        let rear = cam(CameraId::REAR, 16, 16, 30, PixelFormat::Rgba8); // 1024 B
        let front = cam(CameraId::FRONT, 16, 16, 30, PixelFormat::Rgba8);
        let h = SimHarness::new(vec![rear, front], 200);
        h.provider().set_imu_rate_hz(200);
        // `LiveSensorProvider::new` already carries the rate.
        assert_eq!(h.provider().imu_rate_hz(), 200);

        for i in 0..5u64 {
            h.step(i * 10).unwrap();
        }
        assert_eq!(h.seq_of(CameraId::REAR), Some(5));
        assert_eq!(h.seq_of(CameraId::FRONT), Some(5));
        assert_eq!(h.frames_accepted(), 10, "one frame per camera per step");
        assert_eq!(h.frames_dropped(), 0);
        assert_eq!(h.imu_accepted(), 5);
        assert_eq!(h.imu_stale_dropped(), 0);
    }

    #[test]
    fn harness_counts_oversize_and_mismatched_frames_as_drops() {
        let rear = cam(CameraId::REAR, 16, 16, 30, PixelFormat::Rgba8); // 1024 B
        let h = SimHarness::new(vec![rear], 100);

        // Oversize is refused at the glue ceiling before the bus ever sees it.
        let oversize = vec![0u8; GLUE_MAX_FRAME_BYTES + 1];
        assert!(matches!(
            h.push_frame(rear, oversize),
            Err(SensorError::InvalidArguments(_))
        ));
        assert_eq!(h.frames_dropped(), 1);
        assert_eq!(h.frames_accepted(), 0);

        // A wrong-length payload is refused by the bus and also counted.
        assert!(h.push_frame(rear, vec![0u8; 64]).is_err());
        assert_eq!(h.frames_dropped(), 2);

        // The honest error is preserved: no frame was stored for a refused push.
        assert_eq!(h.seq_of(CameraId::REAR), None);
    }

    #[test]
    fn harness_counts_stale_imu_pushes_as_drops() {
        let h = SimHarness::new(vec![], 100);
        assert!(h.push_imu(deterministic_motion(10)));
        assert!(!h.push_imu(deterministic_motion(5)), "older is stale");
        assert_eq!(h.imu_accepted(), 1);
        assert_eq!(h.imu_stale_dropped(), 1);
        assert_eq!(
            h.provider().imu_store().latest().map(|s| s.timestamp_ms),
            Some(10)
        );
    }

    #[test]
    fn harness_drives_the_vitals_stream_including_a_retraction() {
        let h = SimHarness::new(vec![], 100);

        // A reading is announced…
        assert!(h.push_vitals(VitalsSample::new(1, Some(100.0), None)));
        // …an identical re-push is not (but is still counted, not silently lost).
        assert!(!h.push_vitals(VitalsSample::new(2, Some(100.0), None)));
        assert_eq!(h.vitals_announced(), 1);
        assert_eq!(h.vitals_ignored(), 1);

        // Steps advance → a change.
        assert!(h.push_vitals(VitalsSample::new(3, Some(140.0), None)));
        // A reading-less push is a real change while a reading is held: it retracts.
        assert!(h.push_vitals(VitalsSample::new(4, None, None)));
        assert_eq!(
            h.provider().vitals_store().latest().unwrap().steps_total,
            None
        );
        // With nothing left to retract it is not a measurement → ignored.
        assert!(!h.push_vitals(VitalsSample::new(5, None, None)));

        assert_eq!(h.vitals_announced(), 3);
        assert_eq!(h.vitals_ignored(), 2);
    }

    #[test]
    fn harness_drives_a_manager_without_any_device() {
        let rear = cam(CameraId::REAR, 16, 16, 30, PixelFormat::Rgba8);
        let h = SimHarness::new(vec![rear], 200);
        let m = SensorManager::new(h.provider(), SensorMode::Balanced);
        assert_eq!(m.imu_rate_hz(), 200);
        assert_eq!(m.camera_configs().len(), 1);

        h.step(0).unwrap();
        assert_eq!(m.imu_sample().unwrap().timestamp_ms, 0);
        assert_eq!(m.camera_capture(CameraId::REAR).unwrap().seq, 1);
        // PowerSave still gates the 30 FPS config on top of the live bus.
        m.set_mode(SensorMode::PowerSave);
        assert!(matches!(
            m.acquire_stream(SensorKind::Camera, 30),
            Err(SensorError::PowerSaveRate { .. })
        ));
    }

    #[test]
    fn the_glue_upcalls_stay_honest_and_bound_the_payload() {
        // Not wired → a typed Provider error, never a fabricated sample/frame.
        assert!(matches!(native_on_imu(), Err(SensorError::Provider(_))));
        assert!(matches!(
            native_on_camera(1024),
            Err(SensorError::Provider(_))
        ));
        // The payload ceiling is still enforced first.
        assert!(matches!(
            native_on_camera(GLUE_MAX_FRAME_BYTES + 1),
            Err(SensorError::InvalidArguments(_))
        ));
    }
}
