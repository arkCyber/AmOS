//! Integration tests for the **live latest-sample bridge** (Gap 3 / TODO 3.3).
//!
//! These drive the *public* seam exactly the way the System UI's Android glue
//! does — push frames / IMU samples into a `LiveSensorProvider`, read them back
//! through a `SensorManager` — but on the host, via the deterministic
//! [`SimHarness`]. No device, no JVM: the point is that the read path itself
//! (seq ordering, payload-length validation, drop accounting, honest errors) is
//! exercised here rather than only on hardware.
//!
//! Covered:
//! * `live_provider_records_and_reads_frames_in_order`
//! * payload-length validation: an oversize / wrong-length frame is refused,
//!   counted as a drop, and leaves the previous good frame in place;
//! * a refused push never fabricates a frame (honest `Provider` error before any
//!   frame has arrived).

use amos_sensor::{
    CameraConfig, CameraId, ImuSample, PixelFormat, Resolution, SensorError, SensorManager,
    SensorMode, SimHarness, Vec3, GLUE_MAX_FRAME_BYTES,
};

fn cam(id: CameraId, w: u32, h: u32, fps: u32, format: PixelFormat) -> CameraConfig {
    CameraConfig {
        id,
        resolution: Resolution::new(w, h),
        fps,
        format,
    }
}

#[test]
fn live_provider_records_and_reads_frames_in_order() {
    // Two advertised cameras; a reader must see each camera's own monotonic seq.
    let rear = cam(CameraId::REAR, 32, 32, 30, PixelFormat::Rgba8); // 4096 B
    let front = cam(CameraId::FRONT, 32, 24, 30, PixelFormat::Rgba8); // 3072 B
    let h = SimHarness::new(vec![rear, front], 100);
    let m = SensorManager::new(h.provider(), SensorMode::Balanced);

    for i in 0..4u64 {
        let seqs = h.step(i * 20).unwrap();
        assert_eq!(seqs, vec![i + 1, i + 1], "one frame per camera per step");
    }

    // The manager reads the latest accepted frame for each camera, in order.
    let r = m.camera_capture(CameraId::REAR).unwrap();
    let f = m.camera_capture(CameraId::FRONT).unwrap();
    assert_eq!(r.seq, 4);
    assert_eq!(f.seq, 4);
    assert_eq!(r.camera, CameraId::REAR);
    assert_eq!(f.camera, CameraId::FRONT);
    assert_eq!(r.bytes.len(), rear.frame_len() as usize);
    assert_eq!(f.bytes.len(), front.frame_len() as usize);
    // The frames are the deterministic checkerboard, not random noise.
    assert_eq!(r.bytes, amos_sensor::checkerboard(rear, 60).unwrap());

    // The last IMU sample the manager returns is the last one pushed.
    assert_eq!(m.imu_sample().unwrap().timestamp_ms, 60);
    assert_eq!(h.frames_accepted(), 8);
    assert_eq!(h.frames_dropped(), 0);
}

#[test]
fn oversize_and_wrong_length_frames_are_refused_counted_and_do_not_disturb_the_good_frame() {
    let rear = cam(CameraId::REAR, 32, 32, 30, PixelFormat::Rgba8);
    let h = SimHarness::new(vec![rear], 100);
    let m = SensorManager::new(h.provider(), SensorMode::Balanced);

    // One good frame: the baseline a refused push must not clobber.
    h.next_frame(rear, 0).unwrap();
    let good = m.camera_capture(CameraId::REAR).unwrap();
    assert_eq!(good.seq, 1);
    let good_bytes = good.bytes.clone();

    // A payload over the glue ceiling is refused before the bus, and counted.
    let oversize = vec![0u8; GLUE_MAX_FRAME_BYTES + 1];
    assert!(matches!(
        h.push_frame(rear, oversize),
        Err(SensorError::InvalidArguments(_))
    ));
    assert_eq!(h.frames_dropped(), 1);

    // A payload that does not match `frame_len()` is refused by the bus.
    assert!(h.push_frame(rear, vec![0u8; 64]).is_err());
    assert_eq!(h.frames_dropped(), 2);
    assert_eq!(h.frames_accepted(), 1);

    // The last good frame is still there, unchanged, at the same seq — a drop
    // must never silently regress or replace the live value.
    let still = m.camera_capture(CameraId::REAR).unwrap();
    assert_eq!(still.seq, 1);
    assert_eq!(still.bytes, good_bytes);
}

#[test]
fn reads_before_any_push_are_an_honest_provider_error_never_a_fabricated_frame() {
    let rear = cam(CameraId::REAR, 16, 16, 30, PixelFormat::Rgba8);
    let h = SimHarness::new(vec![rear], 100);
    let m = SensorManager::new(h.provider(), SensorMode::Balanced);

    // The camera is advertised, but no frame has been produced: the read must
    // say so rather than hand back zeros (0 is the most misleading substitute).
    match m.camera_capture(CameraId::REAR) {
        Err(SensorError::Provider(msg)) => assert!(msg.contains("no camera frame")),
        other => panic!("expected a Provider error, got {other:?}"),
    }
    match m.imu_sample() {
        Err(SensorError::Provider(msg)) => assert!(msg.contains("no IMU sample")),
        other => panic!("expected a Provider error, got {other:?}"),
    }

    // An un-advertised camera is a distinct, typed failure.
    assert!(matches!(
        m.camera_capture(CameraId::FRONT),
        Err(SensorError::CameraNotFound(_))
    ));
}

#[test]
fn imu_drops_out_of_order_pushes_so_reads_never_regress() {
    let h = SimHarness::new(vec![], 100);
    assert!(h.push_imu(ImuSample::new(
        50,
        Vec3::new(0.0, 9.8, 0.0),
        Some(Vec3::new(0.0, 0.0, 0.0)),
        Some(36.5)
    )));
    // An older sample is stale and must not replace the newer one.
    assert!(!h.push_imu(ImuSample::new(
        10,
        Vec3::new(0.0, -9.8, 0.0),
        Some(Vec3::new(0.0, 0.0, 0.0)),
        Some(36.5)
    )));
    let m = SensorManager::new(h.provider(), SensorMode::Balanced);
    assert_eq!(m.imu_sample().unwrap().timestamp_ms, 50);
    assert_eq!(h.imu_accepted(), 1);
    assert_eq!(h.imu_stale_dropped(), 1);
}
