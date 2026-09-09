//! Rust **callback stubs** for the Kotlin/NDK producer glue (feature `android`).
//!
//! The System UI APK's Kotlin listeners (the `android-glue/` templates, copied
//! into the generated Tauri Android app) hand every real sensor event / camera
//! frame to the AmOS native runtime through the JNI upcalls below:
//!
//! ```text
//! Kotlin SensorGlue.onSensorChanged  ─► Java_..._SensorGlue_recordImu   ─┐
//! Kotlin CameraGlue.onImageAvailable ─► Java_..._CameraGlue_recordFrame ─┤
//!                                                                        ▼
//!                                           GLUE_BUS: LiveSensorProvider
//!                                              (armed from SensorHost.producer())
//! ```
//!
//! Before any event can land, boot must **arm the bus** with the same producer
//! `SensorHost` reads:
//!
//! ```rust,ignore
//! let host = SensorHost::new();            // … also .manage(host) in the app
//! android_glue::arm(host.producer());      // glue writes where the host reads
//! ```
//!
//! The `#[no_mangle]` functions match the `external fun` declarations in
//! `SensorGlue.kt` / `CameraGlue.kt` (package `com.amos.ai.glue`). This module is
//! a **bring-up skeleton**: it compiles under `cargo check --features android`
//! but is only exercised at device time (a real JVM + `tauri android`). Nothing
//! is faked — if the bus isn't armed, a callback is an honest no-op.

use std::sync::{Arc, OnceLock};

use amos_sensor::{
    CameraConfig, CameraId, ImuSample, LiveSensorProvider, PixelFormat, Resolution, Vec3,
};
use jni::objects::JByteArray;

/// The single producer the Kotlin glue writes into. Armed once at boot with
/// [`SensorHost::producer`] so glue samples appear in the host's reads.
static GLUE_BUS: OnceLock<Arc<LiveSensorProvider>> = OnceLock::new();

/// Arm the glue with `bus`. Called exactly once at System UI boot with the same
/// `LiveSensorProvider` the managed `SensorHost` reads.
pub fn arm(bus: Arc<LiveSensorProvider>) -> Result<(), String> {
    GLUE_BUS
        .set(bus)
        .map_err(|_| "android glue bus is already armed".to_string())
}

fn bus() -> Option<&'static Arc<LiveSensorProvider>> {
    GLUE_BUS.get()
}

/// Whether the glue bus is armed (for boot logs / `get_status`).
pub fn is_armed() -> bool {
    bus().is_some()
}

/// Push one fused IMU sample (accel + gyro, body frame) into the bus.
fn push_imu(ts_ms: i64, accel: [f64; 3], gyro: [f64; 3], temperature_c: f32) {
    if let Some(b) = bus() {
        let sample = ImuSample::new(
            ts_ms.max(0) as u64,
            Vec3::new(accel[0], accel[1], accel[2]),
            Vec3::new(gyro[0], gyro[1], gyro[2]),
            temperature_c,
        );
        b.record_imu(sample);
    }
}

/// `SensorGlue.recordImu(tsMs: Long, ax..az, gx..gz, tempC: Float)` — JNI
/// `(JFFFFFFFF)V`.
///
/// # Safety
/// Called by the JVM from a `SensorEventListener` thread; `env`/`this` are the
/// standard JNI instance-method arguments and must be valid for the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_SensorGlue_recordImu(
    _env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    ts_ms: i64,
    ax: f32,
    ay: f32,
    az: f32,
    gx: f32,
    gy: f32,
    gz: f32,
    temp_c: f32,
) {
    push_imu(
        ts_ms,
        [f64::from(ax), f64::from(ay), f64::from(az)],
        [f64::from(gx), f64::from(gy), f64::from(gz)],
        temp_c,
    );
}
/// Decode one NV21/RGBA8 camera frame and push it into the bus (validated by the
/// store). Kept as its own `Result` fn so the `#[no_mangle]` trampoline stays thin.
fn handle_frame(
    env: &jni::JNIEnv<'_>,
    camera_id: i32,
    width: i32,
    height: i32,
    format: i32,
    fps: i32,
    bytes: jni::sys::jbyteArray,
) -> Result<(), String> {
    let bus = bus().ok_or_else(|| "android glue bus not armed".to_string())?;
    // SAFETY: `bytes` is the JVM-supplied jbyteArray argument of this native call
    // and is alive for its duration (standard JNI local-reference rules).
    let arr = unsafe { JByteArray::from_raw(bytes) };
    let frame: Vec<u8> = env.convert_byte_array(&arr).map_err(|e| e.to_string())?;
    let pixel = match format {
        0 => PixelFormat::Rgba8,
        1 => PixelFormat::Nv21,
        other => return Err(format!("unknown glue pixel format code: {other}")),
    };
    if width <= 0 || height <= 0 || fps <= 0 {
        return Err(format!("invalid frame dims {width}x{height}@{fps}"));
    }
    let cfg = CameraConfig {
        id: CameraId(camera_id as u32),
        resolution: Resolution::new(width as u32, height as u32),
        fps: fps as u32,
        format: pixel,
    };
    bus.record_frame(cfg, frame).map_err(|e| e.to_string())
}

/// `CameraGlue.recordFrame(cameraId,width,height,format,fps,bytes)` — JNI
/// `(IIIII[B)V`. `format` code: 0 = RGBA8, 1 = NV21.
///
/// # Safety
/// Called by the JVM from the `ImageReader` callback thread; standard JNI args.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_CameraGlue_recordFrame(
    env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    camera_id: i32,
    width: i32,
    height: i32,
    format: i32,
    fps: i32,
    bytes: jni::sys::jbyteArray,
) {
    if bus().is_none() {
        return; // not armed → honest no-op, never a fabricated frame
    }
    // SAFETY: `env` is the JVM-supplied JNIEnv* of this native call.
    if let Ok(env) = unsafe { jni::JNIEnv::from_raw(env) } {
        let _ = handle_frame(&env, camera_id, width, height, format, fps, bytes);
    }
}

/// `CameraGlue.advertiseCamera(cameraId,width,height,fps)` — JNI `(IIIII)V`. The
/// Kotlin producer reports the NV21 preview config it is about to push, so the
/// host advertises the camera capability (id / size / NV21 format / fps) on the
/// armed bus — matching the design that reads serve a frame only for an advertised
/// camera, and the snapshot's camera list reflects what is really available.
///
/// # Safety
/// Called by the JVM as a registered native method; `env`/`this` are the standard
/// JNI instance-method arguments and must be valid for the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_CameraGlue_advertiseCamera(
    _env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    camera_id: i32,
    width: i32,
    height: i32,
    fps: i32,
) {
    if camera_id < 0 || width <= 0 || height <= 0 || fps <= 0 {
        return;
    }
    if let Some(b) = bus() {
        b.set_cameras(vec![CameraConfig {
            id: CameraId(camera_id as u32),
            resolution: Resolution::new(width as u32, height as u32),
            fps: fps as u32,
            format: PixelFormat::Nv21,
        }]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_sensor::ImuSample;

    // The pure store/push helpers are exercised without a JVM (no device needed);
    // only the `#[no_mangle]` trampolines need a real JNI environment.

    #[test]
    fn imu_store_accepts_and_reads_back() {
        let bus = Arc::new(LiveSensorProvider::new(Vec::new(), 0));
        bus.record_imu(ImuSample::new(
            1,
            Vec3::new(0.0, -9.8, 0.0),
            Vec3::new(0.0, 0.0, 0.0),
            30.0,
        ));
        assert!(bus.imu_store().latest().is_some());
    }

    #[test]
    fn frame_store_validates_and_round_trips_nv21() {
        let bus = Arc::new(LiveSensorProvider::new(Vec::new(), 0));
        let cfg = CameraConfig {
            id: CameraId::REAR,
            resolution: Resolution::new(4, 4),
            fps: 30,
            format: PixelFormat::Nv21,
        };
        assert!(bus.record_frame(cfg, vec![0u8; 24]).is_ok());
        let f = bus.frame_store().latest(CameraId::REAR).unwrap();
        assert_eq!(f.seq, 1);
        assert!(f.payload_is_valid());
        assert!(bus.record_frame(cfg, vec![0u8; 23]).is_err());
    }
}
