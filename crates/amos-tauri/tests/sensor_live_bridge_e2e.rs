//! Integration test for the **sensor live bridge** at the crate boundary
//! (Gap 3).
//!
//! The Kotlin glue and the host share one bus: `SensorHost::producer()` returns
//! exactly the `Arc<LiveSensorProvider>` the glue/receiver writes into, and the
//! host's `snapshot()` reads from it. This test drives that seam the way an
//! external producer does — obtain the producer, push frames + IMU into it — and
//! asserts the host's snapshot reflects the latest values, with **no device and
//! no Tauri app**.
//!
//! (The `#[cfg(feature = "android")]` JNI trampolines themselves need a real JVM
//! and are exercised only at device time; what is proven here is the Rust-side
//! bridge they feed.)

use std::sync::{Arc, Mutex};

use amos_sensor::{CameraConfig, CameraId, ImuSample, PixelFormat, Resolution, Vec3, VitalsSample};
use amos_tauri_lib::sensor_host::{SensorHost, SensorHostEvent};

fn cam(id: CameraId, w: u32, h: u32) -> CameraConfig {
    CameraConfig {
        id,
        resolution: Resolution::new(w, h),
        fps: 30,
        format: PixelFormat::Rgba8,
    }
}

#[test]
fn a_producer_pushing_through_the_shared_bus_shows_up_in_the_host_snapshot() {
    let host = SensorHost::new();
    host.set_cameras(vec![cam(CameraId::REAR, 16, 16)]);

    // The producer the glue is armed with is the very bus the host reads.
    let bus = host.producer();

    // Push a frame exactly as the Kotlin ImageReader half would: raw RGBA8 bytes
    // of the advertised length.
    let cfg = cam(CameraId::REAR, 16, 16);
    bus.record_frame(cfg, vec![0x7Fu8; cfg.frame_len() as usize])
        .expect("advertised camera, correct length");
    bus.record_imu(ImuSample::new(
        1_234,
        Vec3::new(0.0, -9.8, 0.0),
        Some(Vec3::new(0.0, 0.0, 0.1)),
        Some(35.0),
    ));

    let snap = host.snapshot();
    assert_eq!(snap.backend, "live");
    assert_eq!(snap.cameras.len(), 1);
    assert_eq!(snap.cameras[0].id, CameraId::REAR.0);
    assert_eq!(snap.cameras[0].width, 16);

    let imu = snap.imu.expect("the pushed IMU sample is the latest");
    assert_eq!(imu.timestamp_ms, 1_234);
    assert!((imu.accel_y + 9.8).abs() < 1e-9);
    assert_eq!(imu.temperature_c, Some(35.0));

    // The most recent sample is what the host read-back returns too.
    let latest = host.latest_imu().expect("sample present");
    assert_eq!(latest.timestamp_ms, 1_234);
}

/// The detach contract `docs/sensors.md` states (「detach 清空防陈旧回读」): when the glue
/// detaches, the shared bus drops every sample and announces the drop, so neither the host
/// snapshot nor the WebView feed keeps presenting a pre-detach reading as current.
///
/// This is the Rust half of `AmosGlue.onStop → SensorGlue.detach → clearSamples` (the Kotlin
/// trampoline itself needs a real JVM and is exercised only at device time). Before the glue
/// called it (REQ-A1804), the clear the bus already implemented had **no producer**:
/// `StreamChange::Cleared` fired only from tests, and the live card's `clears` counter was
/// structurally 0.
#[test]
fn a_producer_detach_clears_every_live_sample_and_announces_it() {
    let host = SensorHost::new();
    host.set_cameras(vec![cam(CameraId::REAR, 16, 16)]);

    let seen: Arc<Mutex<Vec<SensorHostEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    host.set_notifier(Arc::new(move |ev| {
        sink.lock().expect("event collector").push(ev)
    }));

    let bus = host.producer();
    let cfg = cam(CameraId::REAR, 16, 16);
    bus.record_frame(cfg, vec![0x7Fu8; cfg.frame_len() as usize])
        .expect("advertised camera, correct length");
    bus.record_imu(ImuSample::new(
        1,
        Vec3::new(0.0, -9.8, 0.0),
        Some(Vec3::new(0.0, 0.0, 0.1)),
        Some(35.0),
    ));
    bus.record_vitals(VitalsSample::new(1, Some(4_200.0), Some(72.0)));

    let before = host.snapshot();
    assert!(before.imu.is_some(), "the pushed IMU sample is current");
    assert_eq!(
        before.vitals.map(|v| v.steps_total),
        Some(Some(4_200.0)),
        "the pushed wellness pair is current"
    );

    // Exactly what `SensorGlue.detach()` now reaches through the `clearSamples` upcall.
    bus.clear_samples();

    let after = host.snapshot();
    assert_eq!(
        after.imu, None,
        "a detached producer's IMU sample is not current"
    );
    assert_eq!(after.vitals, None, "…nor its wellness pair");
    // Camera capability is configuration, not a reading — the advertised list is kept.
    assert_eq!(
        after.cameras.len(),
        1,
        "the advertised cameras survive the clear"
    );

    // And the drop is announced, so the WebView's own last-sample copies go too (REQ-A1800).
    let events = seen.lock().expect("event collector");
    let cleared: Vec<&SensorHostEvent> = events.iter().filter(|e| e.kind == "cleared").collect();
    assert_eq!(cleared.len(), 1, "one clear, one announcement");
    assert!(cleared[0].imu.is_none() && cleared[0].frame.is_none() && cleared[0].vitals.is_none());
}

#[test]
fn an_oversize_frame_is_refused_before_it_reaches_the_host() {
    let host = SensorHost::new();
    host.set_cameras(vec![cam(CameraId::REAR, 16, 16)]);
    let bus = host.producer();

    // A payload past the 16 MiB ceiling can never be a valid frame for a 16×16
    // camera. The bus refuses it (length mismatch against the advertised config)
    // and the host keeps reporting no frame — it never fabricates a downscaled
    // or zeroed substitute.
    let cfg = cam(CameraId::REAR, 16, 16);
    assert!(bus
        .record_frame(cfg, vec![0u8; amos_sensor::GLUE_MAX_FRAME_BYTES + 1])
        .is_err());

    let snap = host.snapshot();
    assert_eq!(snap.imu, None);
    assert!(host.latest_imu().is_none());
}
