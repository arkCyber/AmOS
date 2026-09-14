//! `stream_latest` — the mock device's sensors, and the newest-value semantics a UI needs.
//!
//! Everything is offline: `MockSensorProvider::common()` is a camera + GNSS + IMU device that
//! produces deterministic samples. What is worth watching here is the *store* behaviour — a
//! slow consumer never grows a queue, it just sees the newest frame — which is the rule that
//! keeps a WebView from being flooded by a 60 Hz camera.
//!
//! Usage:
//! ```text
//! cargo run -p amos-sensor --example stream_latest
//! ```

use amos_sensor::stream::{FrameLatest, ImuLatest};
use amos_sensor::{CameraId, MockSensorProvider, SensorProvider};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let device = MockSensorProvider::common();
    println!("provider: {}", device.name());

    // What this device can serve.
    for config in device.camera_configs() {
        println!(
            "camera {:?}: {}x{} @ {}fps, {:?}",
            config.id, config.resolution.width, config.resolution.height, config.fps, config.format
        );
    }
    println!("imu rate: {} Hz", device.imu_rate_hz());

    // Capture advances the sequence number and the payload really changes (no static frame).
    let first = device.camera_capture(CameraId::REAR)?;
    let second = device.camera_capture(CameraId::REAR)?;
    println!(
        "frames: seq {} -> {} ({} bytes each, valid={}, differ={})",
        first.seq,
        second.seq,
        first.bytes.len(),
        second.payload_is_valid(),
        first.bytes != second.bytes
    );

    // A camera id with no such device is an error, not an empty frame.
    match device.camera_capture(CameraId(9)) {
        Ok(frame) => println!(
            "UNEXPECTED: captured from a nonexistent camera (seq {})",
            frame.seq
        ),
        Err(e) => println!("camera 9 refused: {e}"),
    }

    // GNSS and IMU: a fix and a sample, both plausible (the mock does not invent impossible values).
    println!(
        "gnss enabled={} fix={:?}",
        device.gnss_enabled(),
        device
            .gnss_fix()?
            .map(|fix| (fix.latitude_deg, fix.longitude_deg))
    );
    let imu = device.imu_sample()?;
    println!(
        "imu sample |accel|={:.3} m/s² |gyro|={:.3} rad/s temp={:.1}°C finite={}",
        imu.accel_m_s2.magnitude(),
        imu.gyro_rad_s.magnitude(),
        imu.temperature_c,
        imu.temperature_c.is_finite()
    );

    // The latest-value stores: recording many samples keeps exactly one.
    let frames = FrameLatest::new();
    let imu_store = ImuLatest::new();
    for _ in 0..10 {
        let frame = device.camera_capture(CameraId::REAR)?;
        frames.record(
            device
                .camera_configs()
                .into_iter()
                .next()
                .ok_or("no camera")?,
            frame.bytes,
        )?;
        imu_store.record(device.imu_sample()?);
    }
    println!(
        "after 10 captures: frame store holds seq={:?} imu samples recorded={}",
        frames.latest(CameraId::REAR).map(|f| f.seq),
        imu_store.recorded()
    );
    frames.clear(CameraId::REAR);
    imu_store.clear();
    println!(
        "after clear: frame={:?} imu={:?}",
        frames.latest(CameraId::REAR).is_some(),
        imu_store.latest().is_some()
    );
    Ok(())
}
