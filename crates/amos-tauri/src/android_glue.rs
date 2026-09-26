//! Rust **callback stubs** for the Kotlin/NDK producer glue (feature `android`).
//!
//! The System UI APK's Kotlin listeners (the `android-glue/` templates, copied
//! into the generated Tauri Android app) hand every real sensor event / camera
//! frame to the AmOS native runtime through the JNI upcalls below:
//!
//! ```text
//! Kotlin SensorGlue.onSensorChanged  ─► Java_..._SensorGlue_recordImu    ─┐
//! Kotlin CameraGlue.onImageAvailable ─► Java_..._CameraGlue_recordFrame  ─┤
//! Kotlin SensorGlue.detach           ─► Java_..._SensorGlue_clearSamples ─┤
//!                                                                         ▼
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
    VitalsSample,
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

/// Whether every value in the fused `accel` vector is finite.
///
/// A real `SensorEvent` can report `NaN` when the underlying HAL is in a
/// transient state (a hardware FIFO overrun mid-read, a calibration reset), and
/// the Sensor API deliberately hands the value through unchanged — the caller
/// is responsible for filtering it. **A `NaN`/`±Inf` axis reaching the bus
/// would propagate to every downstream consumer**: a `Vec3` whose x is NaN
/// defeats gravity-normalised orientation. The acceleration vector is the
/// sample's *presence* — there is nowhere to put "absent" — so refusing the
/// whole sample is the conservative answer: the bus keeps its previous value.
///
/// The gyroscope is deliberately **not** part of this check any more; it is an
/// optional vector the domain models as `Option<Vec3>` ([`decode_gyro`]).
/// Refusing the whole sample over it would let a gyroscope-less device (the
/// field S5, `dumpsys sensorservice`: `geomag fusion (no gyro)`) go dark on the
/// *acceleration*, which is a complete measurement without it.
fn finite_accel(accel: [f64; 3]) -> bool {
    accel.iter().all(|v| v.is_finite())
}

/// Decode the glue's gyroscope triple into an optional body-frame rate.
///
/// Android's glue registers a `TYPE_GYROSCOPE` listener only when the platform
/// exposes one, so a device with no gyroscope never produces a rate event; its
/// accelerometer branch states that by sending `Float.NaN` in **all three** gyro
/// slots — the same sentinel [`die_temp_c`] decodes for the optional die
/// temperature and [`reading`] for the wellness scalars. All-NaN therefore means
/// **absent** and reaches the domain as `None`, never as `Vec3::ZERO` (which is
/// the *measurement* "not rotating", the fabricated value `sensor_host_snapshot`
/// used to report — REQ-A1872 / F-SEN-008).
///
/// A triple that is neither all-finite nor all-NaN is a **glitched** HAL read — a
/// partial sentinel is not an encoding — and is refused (`Err`) so the whole
/// sample is dropped rather than a NaN axis propagating downstream.
fn decode_gyro(gyro: [f64; 3]) -> Result<Option<Vec3>, ()> {
    if gyro.iter().all(|v| v.is_finite()) {
        Ok(Some(Vec3::new(gyro[0], gyro[1], gyro[2])))
    } else if gyro.iter().all(|v| v.is_nan()) {
        Ok(None)
    } else {
        Err(())
    }
}

/// Decode the glue's die-temperature scalar — `NaN` (the glue's "no reading"
/// sentinel) means **absent**, and reaches the domain as `None`, never as a
/// fabricated value.
///
/// This is [`reading`]'s rule for the wellness scalars applied to the third
/// scalar the glue hands across this seam. No range check beyond finiteness:
/// unlike a step count or a heart rate, a die temperature has no domain
/// constraint that would make a finite value structurally impossible, so the
/// seam's only job here is to decode the sentinel rather than second-guess the
/// HAL.
fn die_temp_c(v: f32) -> Option<f32> {
    v.is_finite().then_some(v)
}

/// Decode one glue IMU report into a domain sample, or `None` when the
/// acceleration is poisoned or the gyro triple is glitched (see [`finite_accel`]
/// and [`decode_gyro`]).
///
/// Split out from [`push_imu`] so the decoding is exercisable without an armed
/// bus (the bus is a process-global `OnceLock`, so `push_imu` itself cannot be
/// given one from a test).
fn decode_imu(
    ts_ms: i64,
    accel: [f64; 3],
    gyro: [f64; 3],
    temperature_c: f32,
) -> Option<ImuSample> {
    if !finite_accel(accel) {
        return None;
    }
    let gyro = decode_gyro(gyro).ok()?;
    Some(ImuSample::new(
        ts_ms.max(0) as u64,
        Vec3::new(accel[0], accel[1], accel[2]),
        gyro,
        die_temp_c(temperature_c),
    ))
}

/// Push one fused IMU sample (accel + gyro, body frame) into the bus.
fn push_imu(ts_ms: i64, accel: [f64; 3], gyro: [f64; 3], temperature_c: f32) {
    let Some(sample) = decode_imu(ts_ms, accel, gyro, temperature_c) else {
        // A poisoned *accel* axis, or a gyro triple that is neither a full
        // reading nor the all-NaN "no gyroscope" sentinel, would propagate
        // downstream and corrupt orientation — refuse the whole sample so the
        // bus keeps its previous good value. Reported per sample (REQ-A187): a
        // stuck HAL would otherwise be invisible, because the bus would just
        // stop updating.
        tracing::warn!(
            target: "amos::sensors",
            ts_ms,
            "android IMU sample rejected: poisoned acceleration or glitched gyro"
        );
        return;
    };
    if let Some(b) = bus() {
        b.record_imu(sample);
    }
}

/// Decode one glue-reported scalar into a real reading, or `None`.
///
/// The Kotlin glue sends `Float.NaN` for "this value is not available" (no such
/// sensor on the device, or a heart-rate sensor reporting no contact). A `NaN`
/// therefore means **absent**, and must become `None` — never `0`. The range
/// checks are the same refusal the rest of the stack applies: a negative step
/// count or a non-positive heart rate is not a measurement, so it is treated as
/// absent rather than stored as a reading.
fn reading(v: f32, valid: impl Fn(f64) -> bool) -> Option<f64> {
    let v = f64::from(v);
    if v.is_finite() && valid(v) {
        Some(v)
    } else {
        None
    }
}

/// Decode one wellness sample and hand it to `bus`.
///
/// Both scalars decode independently; `NaN` (the glue's "no reading" sentinel)
/// becomes `None`, never `0`. A sample carrying **no** reading is handed to the
/// store rather than dropped at this seam: whether it is worth keeping is the
/// store's decision, and a reading-less sample is exactly how a *retraction* is
/// reported — the heart-rate sensor losing contact is `(steps, NaN)`, or
/// `(NaN, NaN)` on a device with no step counter. Dropping it here would leave the
/// UI drawing the last bpm forever, which is the failure `VitalsLatest::record`
/// exists to prevent.
fn record_vitals_into(bus: &LiveSensorProvider, ts_ms: i64, steps_total: f32, heart_rate_bpm: f32) {
    bus.record_vitals(VitalsSample::new(
        ts_ms.max(0) as u64,
        reading(steps_total, |v| v >= 0.0),
        reading(heart_rate_bpm, |v| v > 0.0),
    ));
}

/// Hand one wellness sample to the armed bus, if any. The store is the authority
/// on whether the sample means anything (see [`record_vitals_into`]).
fn push_vitals(ts_ms: i64, steps_total: f32, heart_rate_bpm: f32) {
    if let Some(b) = bus() {
        record_vitals_into(b, ts_ms, steps_total, heart_rate_bpm);
    }
}

/// `SensorGlue.recordVitals(tsMs: Long, stepsTotal: Float, hrBpm: Float)` — JNI
/// `(JFF)V`. `Float.NaN` in either scalar means "no reading".
///
/// # Safety
/// Called by the JVM from a `SensorEventListener` thread; `env`/`this` are the
/// standard JNI instance-method arguments and must be valid for the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_SensorGlue_recordVitals(
    _env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
    ts_ms: i64,
    steps_total: f32,
    heart_rate_bpm: f32,
) {
    push_vitals(ts_ms, steps_total, heart_rate_bpm);
}

/// Drop every live sample the glue has pushed — IMU, camera frames and vitals.
///
/// The Kotlin `SensorGlue.detach()` calls this on lifecycle teardown
/// (`AmosGlue.onStop`). Without it the shared bus keeps serving the last
/// pre-detach sample as *current*: `SensorHost::snapshot()` answers with a reading no
/// sensor is producing any more, and a later re-attach inherits it. Dropping the
/// samples also announces `StreamChange::Cleared`, the event the WebView feed uses to
/// drop its own last-sample copies (REQ-A1800), which is what `docs/sensors.md` means
/// by 「detach 清空防陈旧回读」. (REQ-A1804 — the clear existed with no producer until
/// this upcall: `StreamChange::Cleared` fired only from tests.)
///
/// The advertised camera list is deliberately kept: it is configuration, not a reading.
fn clear_live_samples() {
    if let Some(b) = bus() {
        b.clear_samples();
    }
}

/// `SensorGlue.clearSamples()` — JNI `()V`. Called from the glue's detach path.
///
/// # Safety
/// Called by the JVM from the glue's lifecycle teardown; `env`/`this` are the
/// standard JNI instance-method arguments and must be valid for the call.
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_SensorGlue_clearSamples(
    _env: *mut jni::sys::JNIEnv,
    _this: jni::sys::jobject,
) {
    clear_live_samples();
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
        // Every frame the host cannot decode used to be dropped **silently**, while the
        // UI kept showing "live view" (the Kotlin producer logs its own encode
        // failures; this is the host half). Reported per frame (REQ-A187).
        if let Err(e) = handle_frame(&env, camera_id, width, height, format, fps, bytes) {
            tracing::warn!(
                target: "amos::camera",
                camera_id,
                error = %e,
                "camera frame dropped by the host"
            );
        }
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
            Some(Vec3::new(0.0, 0.0, 0.0)),
            Some(30.0),
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

    #[test]
    fn finite_accel_accepts_a_normal_resting_reading() {
        // Free-fall in body frame (~9.8 m/s² downward): exactly the shape
        // `SensorEvent` produces at rest.
        assert!(finite_accel([0.0, -9.81, 0.02]));
    }

    #[test]
    fn finite_accel_rejects_nan_or_inf_in_any_axis() {
        // A NaN in any accel axis must reject the whole sample (a partial good
        // reading is still a poisoned reading — the bus keeps its previous
        // value rather than ship a Vec3 with a NaN component downstream).
        assert!(!finite_accel([f64::NAN, -9.81, 0.0]));
        assert!(!finite_accel([0.0, f64::INFINITY, 0.0]));
    }

    /// The glue states "this device has no gyroscope" with `Float.NaN` in all
    /// three slots; that must reach the domain as `None`, **not** as
    /// `Vec3::ZERO`. Zero is the measurement "not rotating", and a gyroscope-less
    /// phone is the field S5 (`dumpsys sensorservice`: `geomag fusion (no
    /// gyro)`), where every accelerometer sample used to carry exactly that
    /// fabricated zero onto the wire (REQ-A1872 / F-SEN-008).
    #[test]
    fn an_all_nan_gyro_triple_is_the_no_gyroscope_sentinel_and_decodes_to_none() {
        assert_eq!(decode_gyro([f64::NAN; 3]), Ok(None));

        // The sample survives without a gyroscope: the acceleration is a
        // complete measurement on its own, and "no gyroscope" must not cost it.
        let s = decode_imu(7, [0.1, -9.8, 0.2], [f64::NAN; 3], f32::NAN)
            .expect("a device with no gyroscope still produces an accelerometer sample");
        assert_eq!(s.gyro_rad_s, None);
        assert!((s.accel_m_s2.y + 9.8).abs() < 1e-12);

        // Positive control: a real rate survives as a value, so "always None"
        // cannot pass the assertion above.
        assert_eq!(
            decode_gyro([0.01, -0.02, 0.03]),
            Ok(Some(Vec3::new(0.01, -0.02, 0.03)))
        );

        // A **partial** sentinel is a glitch, not an encoding: refuse it so a
        // NaN axis cannot reach the bus.
        assert_eq!(decode_gyro([f64::NAN, 0.0, 0.0]), Err(()));
        assert_eq!(decode_gyro([0.0, f64::INFINITY, 0.0]), Err(()));
        assert_eq!(decode_gyro([0.0, f64::NAN, f64::NAN]), Err(()));
        // ...and a glitched gyro triple drops the whole sample.
        assert!(decode_imu(11, [0.0, -9.8, 0.0], [0.0, f64::INFINITY, 0.0], 36.5).is_none());
    }

    /// The glue's "no reading" sentinel is `Float.NaN` — the same one
    /// `SensorGlue` sends for a heart-rate sensor with no contact, and the same
    /// one [`reading`] decodes for the wellness pair. The IMU's die temperature
    /// is the third scalar hand-delivered across this seam, so it must follow
    /// the same rule: absent reaches the domain as `None`, never as a
    /// fabricated value.
    ///
    /// The glue that ships reads only `TYPE_ACCELEROMETER` / `TYPE_GYROSCOPE`;
    /// there is no die-temperature source behind them, so `NaN` is the *normal*
    /// case — and it must not cost the axes anything. A `None` temperature with
    /// a real accel/gyro is a complete, known sample minus one optional reading.
    #[test]
    fn an_absent_die_temperature_decodes_to_none_and_does_not_cost_the_axes() {
        let s = decode_imu(7, [0.1, -9.8, 0.2], [0.0, 0.0, 0.0], f32::NAN)
            .expect("a NaN temperature is not grounds to drop a sample with good axes");
        assert_eq!(s.temperature_c, None);
        // The axes are untouched: the sample is *known*, minus one optional
        // reading. Mapping the sentinel to a value, or refusing the sample,
        // both fail here.
        assert!((s.accel_m_s2.y + 9.8).abs() < 1e-12);
        assert_eq!(s.timestamp_ms, 7);

        // ±Inf is the same "not a reading" fact.
        assert_eq!(
            decode_imu(8, [0.0, -9.8, 0.0], [0.0, 0.0, 0.0], f32::INFINITY)
                .unwrap()
                .temperature_c,
            None
        );

        // Positive control: a real die temperature survives. Without this,
        // "always report None" would pass the assertions above.
        let with_temp = decode_imu(9, [0.0, -9.8, 0.0], [0.0, 0.0, 0.0], 36.5).unwrap();
        assert_eq!(with_temp.temperature_c, Some(36.5));

        // A poisoned axis is still refused outright, temperature or not.
        assert!(decode_imu(10, [f64::NAN, 0.0, 0.0], [0.0, 0.0, 0.0], 36.5).is_none());
        assert!(decode_imu(11, [0.0, -9.8, 0.0], [0.0, f64::INFINITY, 0.0], 36.5).is_none());
    }

    #[test]
    fn push_imu_rejects_nan_sample_and_does_not_record_to_the_bus() {
        // `push_imu` is private but accessible from this `tests` submodule
        // (submodules see the parent module's private items). We assert the
        // **finite-check** property without a bus — the "previous good value"
        // assertion is covered by the device-side run, where the OnceLock'd
        // bus is armed by `lib.rs::setup` and the same property is observed.
        // Here we prove the function returns without panicking on a NaN-laden
        // payload: a panic in the hot motion path would freeze the sensor
        // listener thread and silently stop the live feed.
        push_imu(1, [f64::NAN, 0.0, 0.0], [0.0, 0.0, 0.0], 30.0);
        push_imu(2, [0.0, -9.81, 0.0], [f64::INFINITY, 0.0, 0.0], 30.0);
        push_imu(3, [0.0, -9.81, 0.0], [0.0, 0.0, 0.0], f32::NAN);
        push_imu(4, [0.0, -9.81, 0.0], [0.0, 0.0, 0.0], f32::NEG_INFINITY);
        // A finite sample must succeed (no panic). Without an armed bus it is a
        // quiet no-op — the function must always return without crashing the
        // listener thread.
        push_imu(5, [0.0, -9.81, 0.0], [0.0, 0.0, 0.0], 30.0);
    }

    #[test]
    fn a_lost_heart_rate_reaches_the_store_and_retracts() {
        // A device with a heart-rate sensor and no step counter: a contact reading
        // is `(NaN, bpm)`, and losing contact is `(NaN, NaN)`. The reading-less
        // sample is not a no-op at this seam — it is the only thing that can
        // retract the held bpm, so it must land in the store.
        let bus = Arc::new(LiveSensorProvider::new(Vec::new(), 0));
        record_vitals_into(&bus, 1, f32::NAN, 72.0);
        assert_eq!(
            bus.vitals_store().latest().unwrap().heart_rate_bpm,
            Some(72.0)
        );
        record_vitals_into(&bus, 2, f32::NAN, f32::NAN);
        assert_eq!(
            bus.vitals_store().latest().unwrap().heart_rate_bpm,
            None,
            "the lost reading must be retracted, not held forever"
        );
    }

    #[test]
    fn a_reading_less_sample_with_nothing_to_retract_is_not_stored() {
        // Same all-absent shape, but nothing is held: this is not a measurement, so
        // the store keeps `None` (an empty vitals block must not appear).
        let bus = Arc::new(LiveSensorProvider::new(Vec::new(), 0));
        record_vitals_into(&bus, 1, f32::NAN, f32::NAN);
        assert_eq!(bus.vitals_store().latest(), None);
    }

    #[test]
    fn non_positive_step_and_heart_readings_decode_to_absent() {
        // `NaN` is the wire "no reading"; so are a negative step count and a
        // non-positive heart rate. None of them may become a stored `0`.
        let bus = Arc::new(LiveSensorProvider::new(Vec::new(), 0));
        record_vitals_into(&bus, 1, -3.0, 0.0);
        assert_eq!(bus.vitals_store().latest(), None);
        record_vitals_into(&bus, 2, 100.0, f32::NAN);
        let s = bus.vitals_store().latest().unwrap();
        assert_eq!(s.steps_total, Some(100.0));
        assert_eq!(s.heart_rate_bpm, None);
    }
}
