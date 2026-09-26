//! Tauri <-> device-sensor service bridge.
//!
//! The WebView's settings/diagnostics call `sensor_snapshot` / `sensor_set_mode` /
//! `sensor_acquire`; these open a tonic `SensorClient` over the OS daemon's Unix
//! Domain Socket (the *same* socket that carries `AiAgent` + `AndroidManager` +
//! `Telephony` + `Sensor`), run the unary RPC, and return serializable payloads to
//! the frontend. If the daemon is absent each command fails with a descriptive
//! error (the UI shows a "daemon not connected" state rather than crashing).
//!
//! On a real device the backing `SensorService` is driven by the daemon's mounted
//! backend (mock today, an `AndroidSensorProvider` on device); on desktop this
//! reaches the same service over UDS with the deterministic mock.

use amos_proto::amos_sensor::{
    sensor_client::SensorClient, AcquireRequest, CameraDesc, Empty, GnssReply, ImuReply,
    SensorKind as ProtoKind, SensorMode as ProtoMode, SetModeRequest,
};
use serde::Serialize;

use crate::error::{AmosError, ErrorCode};

async fn build_channel() -> Result<crate::daemon::DaemonChannel, String> {
    crate::daemon::channel().await
}

/// Wire vocabulary for the sensor bridge. The UI i18n layer branches on these;
/// renaming a variant is a wire break.
pub mod codes {
    use crate::error::ErrorCode;
    /// Caller asked for a sensor mode the daemon does not know.
    pub const UNKNOWN_MODE: &str = ErrorCode::SensorsUnknownMode.as_str();
    /// Caller asked for a sensor kind the daemon does not know.
    pub const UNKNOWN_KIND: &str = ErrorCode::SensorsUnknownKind.as_str();
    /// Caller asked for a stream rate outside the supported range.
    pub const RATE_OUT_OF_RANGE: &str = ErrorCode::SensorsRateOutOfRange.as_str();
    /// Any sensor RPC failed (daemon unreachable / rejected).
    pub const RPC_FAILED: &str = ErrorCode::SensorsRpcFailed.as_str();
}

/// Upper bound on a single sensor stream's `rate_hz`.
///
/// Real camera/IMU streams run at 30–200 Hz; 4 KiB-class numbers are a caller
/// bug (or a probe of "what happens if I pass u32::MAX"). The cap is well
/// above any legitimate value but small enough to refuse the pathological one.
pub const MAX_SENSOR_RATE_HZ: u32 = 4_096;

/// Lower bound on a stream's `rate_hz`. Zero is not a meaningful "off" — it
/// asks the daemon to do a div-by-zero in any periodic accounting.
pub const MIN_SENSOR_RATE_HZ: u32 = 1;

/// Serializable one-camera summary (prost structs are not `Serialize`).
#[derive(Clone, Debug, Serialize)]
pub struct SensorCamera {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub format: String,
}

/// Serializable GNSS fix (or "no fix yet").
///
/// `accuracy_m` / `sats` are `Option` because both wires are **zero-sentinel**: the proto's
/// `double accuracy_m` and `uint32 sats_in_view` have no field presence, and the producer
/// writes `0` to mean "not reported". Android's `Location.getAccuracy()` returns `0.0` when
/// the fix carries no accuracy estimate, and `Location` carries no satellite count at all
/// (`amos-sensor/src/android.rs` sets `satellites_in_view: 0` with the comment "0 is honest
/// 'not reported', not a claim of zero sats"). Folding either `0` into a measurement prints
/// `±0m · 0sats` — a precision the receiver never claimed and a satellite count it never
/// had (AEROSPACE P0-3). The sibling `lib/gps.ts::accuracyLabel` already renders that same
/// `0` as `—`, so this mapping is the rule the frontend one field over already follows.
#[derive(Clone, Debug, Serialize)]
pub struct SensorGnss {
    pub enabled: bool,
    pub has_fix: bool,
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub accuracy_m: Option<f64>,
    pub sats: Option<u32>,
    pub fix_mode: String,
}

/// Serializable IMU sample.
///
/// Every field is `Option`: the proto's `accel_m_s2` / `gyro_rad_s` are optional, and a
/// sample that was **not** reported must stay distinguishable from a real measurement.
/// Mapping an absent axis to `0.0` would put a value on the wire that the device never
/// measured (AEROSPACE P0-3 — the same rule `SystemStatus` follows), and `0` is the most
/// misleading substitute available: it reads as "perfectly still". `None` is rendered as
/// `—` by the UI (REQ-A294).
#[derive(Clone, Debug, Serialize)]
pub struct SensorImu {
    /// The negotiated IMU report rate, in Hz — `None` when the producer has not negotiated
    /// one yet (REQ-A1612 / F-SH-821).
    ///
    /// `0` is **not** a rate here: the producer's own vocabulary defines it as "not
    /// negotiated yet" (`amos-sensor`'s `LiveSensorProvider::set_imu_rate_hz` —
    /// "`0` = not negotiated yet", and `AndroidSensorProvider::imu_rate_hz` — "the domain
    /// core treats 0 as \"unknown\""), and [`MIN_SENSOR_RATE_HZ`] states the same thing for
    /// the request direction ("Zero is not a meaningful \"off\""). The proto's `uint32
    /// rate_hz` has **no field presence**, so that "unknown" arrives as `0` — which, left
    /// unfolded, the panel printed as the measurement `@0 Hz`.
    pub rate_hz: Option<u32>,
    pub accel_x: Option<f64>,
    pub accel_y: Option<f64>,
    pub accel_z: Option<f64>,
    /// Angular rate, in rad/s — `None` when the bus reported no gyro sample.
    pub gyro_x: Option<f64>,
    pub gyro_y: Option<f64>,
    pub gyro_z: Option<f64>,
    /// Die temperature, in °C — `None` when the device reported none.
    ///
    /// Like `rate_hz`, the wire's `float temperature_c` has **no field presence**,
    /// so the producer writes `0` to mean "not reported" — and that is the normal
    /// case: the Android glue reads only `TYPE_ACCELEROMETER` / `TYPE_GYROSCOPE`
    /// and has no die-temperature source behind them (`amos-sensor`'s
    /// `ImuSample::temperature_c` carries that fact as an `Option`). Read as
    /// **unknown**, never as a measured `0 °C`; the panel prints `—` for it.
    pub temp_c: Option<f32>,
}

/// One read of every sensor family + the energy mode.
#[derive(Clone, Debug, Serialize)]
pub struct SensorSnapshot {
    pub mode: String,
    pub cameras: Vec<SensorCamera>,
    pub gnss: Option<SensorGnss>,
    pub imu: Option<SensorImu>,
}

/// Outcome of an energy-gated stream acquisition.
#[derive(Clone, Debug, Serialize)]
pub struct SensorAcquireResult {
    pub allowed: bool,
    pub error: String,
}

fn mode_label(mode: i32) -> String {
    match mode {
        m if m == ProtoMode::Performance as i32 => "performance".to_string(),
        m if m == ProtoMode::Balanced as i32 => "balanced".to_string(),
        m if m == ProtoMode::PowerSave as i32 => "power_save".to_string(),
        _ => "unknown".to_string(),
    }
}

fn mode_from_str(mode: &str) -> Option<i32> {
    match mode {
        "performance" => Some(ProtoMode::Performance as i32),
        "balanced" => Some(ProtoMode::Balanced as i32),
        "power_save" => Some(ProtoMode::PowerSave as i32),
        _ => None,
    }
}

fn kind_from_str(kind: &str) -> Option<i32> {
    match kind {
        "camera" => Some(ProtoKind::Camera as i32),
        "gnss" => Some(ProtoKind::Gnss as i32),
        "imu" => Some(ProtoKind::Imu as i32),
        _ => None,
    }
}

fn pixel_format_label(f: i32) -> String {
    match f {
        x if x == amos_proto::amos_sensor::PixelFormat::Rgba8 as i32 => "rgba8".to_string(),
        x if x == amos_proto::amos_sensor::PixelFormat::Nv21 as i32 => "nv21".to_string(),
        _ => "unknown".to_string(),
    }
}

fn fix_mode_label(f: i32) -> String {
    match f {
        x if x == amos_proto::amos_sensor::FixMode::NoFix as i32 => "none".to_string(),
        x if x == amos_proto::amos_sensor::FixMode::TwoDim as i32 => "2d".to_string(),
        x if x == amos_proto::amos_sensor::FixMode::ThreeDim as i32 => "3d".to_string(),
        _ => "unknown".to_string(),
    }
}

fn camera_payload(c: &CameraDesc) -> SensorCamera {
    SensorCamera {
        id: c.id,
        width: c.width,
        height: c.height,
        fps: c.fps,
        format: pixel_format_label(c.format),
    }
}

fn gnss_payload(g: &GnssReply) -> SensorGnss {
    SensorGnss {
        enabled: g.enabled,
        has_fix: g.has_fix,
        latitude_deg: g.latitude_deg,
        longitude_deg: g.longitude_deg,
        // Both wires are zero-sentinel (no field presence): `0` is the producer's
        // "not reported", read as **unknown** rather than as a 0 m accuracy / 0 satellites
        // (see `SensorGnss`). The renderer's `±…` / `…sats` clauses are already gated on
        // `null`, so an unknown field drops out of the fix line instead of being invented.
        accuracy_m: (g.accuracy_m != 0.0).then_some(g.accuracy_m),
        sats: (g.sats_in_view != 0).then_some(g.sats_in_view),
        fix_mode: fix_mode_label(g.fix_mode),
    }
}

fn imu_payload(i: &ImuReply) -> SensorImu {
    let acc = i.accel_m_s2.as_ref();
    let gyro = i.gyro_rad_s.as_ref();
    SensorImu {
        // The wire's `uint32 rate_hz` has no field presence, and the producer writes `0`
        // to mean "not negotiated yet" (see `SensorImu::rate_hz`). So `0` is read as
        // **not reported** rather than as a 0 Hz rate — otherwise a device whose IMU
        // listener has not started prints `@0 Hz`, a fabricated measurement (P0-3).
        rate_hz: (i.rate_hz != 0).then_some(i.rate_hz),
        // Absent stays absent (`None`): the UI prints `—` for it instead of a fabricated
        // `0.0`, which would read as a measurement (REQ-A294 / P0-3).
        accel_x: acc.map(|v| v.x),
        accel_y: acc.map(|v| v.y),
        accel_z: acc.map(|v| v.z),
        gyro_x: gyro.map(|v| v.x),
        gyro_y: gyro.map(|v| v.y),
        gyro_z: gyro.map(|v| v.z),
        // Same zero-sentinel rule as `rate_hz` above: the producer writes `0` for
        // "not reported", and a die temperature nothing measured must not be
        // drawn as a measured `0 °C` (P0-3). The mock/sim providers *do* report
        // one, and it survives this fold.
        temp_c: (i.temperature_c != 0.0).then_some(i.temperature_c),
    }
}

/// Read every sensor family + the energy mode in one call.
///
/// Only a *missing daemon* (channel build) fails the whole call. An individual
/// sensor RPC failing leaves that family as `None`/empty so the UI still shows
/// whatever the device reported (partial tolerance — a camera hiccup must not
/// hide the GNSS/IMU readout).
#[tauri::command]
pub async fn sensor_snapshot() -> Result<SensorSnapshot, String> {
    let mut client = SensorClient::new(build_channel().await?);
    let cameras = client
        .list_cameras(Empty {})
        .await
        .map(|r| {
            r.into_inner()
                .cameras
                .iter()
                .map(camera_payload)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let gnss = client
        .get_gnss(Empty {})
        .await
        .ok()
        .map(|r| gnss_payload(&r.into_inner()));
    let imu = client
        .get_imu(Empty {})
        .await
        .ok()
        .map(|r| imu_payload(&r.into_inner()));
    let mode = match client.get_mode(Empty {}).await {
        Ok(r) => mode_label(r.into_inner().mode),
        Err(_) => "unknown".to_string(),
    };
    Ok(SensorSnapshot {
        mode,
        cameras,
        gnss,
        imu,
    })
}

/// Switch the daemon energy mode (`performance` | `balanced` | `power_save`).
///
/// Returns a typed [`AmosError`] so the UI i18n layer can branch on
/// [`ErrorCode::SensorsUnknownMode`] / [`ErrorCode::SensorsRpcFailed`].
#[tauri::command]
pub async fn sensor_set_mode(mode: String) -> Result<String, AmosError> {
    let proto_mode = mode_from_str(&mode).ok_or_else(|| {
        AmosError::new(
            ErrorCode::SensorsUnknownMode,
            format!("unknown sensor mode '{mode}' (performance|balanced|power_save)"),
        )
    })?;
    let mut client =
        SensorClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::SensorsRpcFailed, codes::RPC_FAILED, e)
        })?);
    let reply = client
        .set_mode(SetModeRequest { mode: proto_mode })
        .await
        .map_err(|e| AmosError::with_cause(ErrorCode::SensorsRpcFailed, codes::RPC_FAILED, e))?
        .into_inner();
    Ok(mode_label(reply.mode))
}

/// Ask the daemon to allow a continuous stream (`kind` = camera|gnss|imu).
///
/// The `rate_hz` argument is bounded by [`MIN_SENSOR_RATE_HZ`] /
/// [`MAX_SENSOR_RATE_HZ`] — out-of-range is refused with a typed error so the
/// caller can render an honest "rate out of range" without parsing the message.
#[tauri::command]
pub async fn sensor_acquire(kind: String, rate_hz: u32) -> Result<SensorAcquireResult, AmosError> {
    let kind = kind_from_str(&kind).ok_or_else(|| {
        AmosError::new(
            ErrorCode::SensorsUnknownKind,
            format!("unknown sensor kind '{kind}' (camera|gnss|imu)"),
        )
    })?;
    if !(MIN_SENSOR_RATE_HZ..=MAX_SENSOR_RATE_HZ).contains(&rate_hz) {
        return Err(AmosError::new(
            ErrorCode::SensorsRateOutOfRange,
            format!("rate_hz {rate_hz} outside [{MIN_SENSOR_RATE_HZ}, {MAX_SENSOR_RATE_HZ}]"),
        ));
    }
    let mut client =
        SensorClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::SensorsRpcFailed, codes::RPC_FAILED, e)
        })?);
    let reply = client
        .acquire_stream(AcquireRequest { kind, rate_hz })
        .await
        .map_err(|e| AmosError::with_cause(ErrorCode::SensorsRpcFailed, codes::RPC_FAILED, e))?
        .into_inner();
    Ok(SensorAcquireResult {
        allowed: reply.allowed,
        error: reply.error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_strings_map_both_ways() {
        for label in ["performance", "balanced", "power_save"] {
            assert_eq!(mode_label(mode_from_str(label).unwrap()), label);
        }
        assert_eq!(mode_from_str("turbo"), None);
        assert_eq!(mode_label(999), "unknown");
    }

    #[test]
    fn kind_strings_map() {
        assert_eq!(kind_from_str("camera"), Some(ProtoKind::Camera as i32));
        assert_eq!(kind_from_str("gnss"), Some(ProtoKind::Gnss as i32));
        assert_eq!(kind_from_str("imu"), Some(ProtoKind::Imu as i32));
        assert_eq!(kind_from_str("barometer"), None);
    }

    #[test]
    fn pixel_and_fix_mode_labels() {
        use amos_proto::amos_sensor::{FixMode, PixelFormat};
        assert_eq!(pixel_format_label(PixelFormat::Rgba8 as i32), "rgba8");
        assert_eq!(pixel_format_label(PixelFormat::Nv21 as i32), "nv21");
        assert_eq!(pixel_format_label(99), "unknown");
        assert_eq!(fix_mode_label(FixMode::ThreeDim as i32), "3d");
        assert_eq!(fix_mode_label(FixMode::TwoDim as i32), "2d");
        assert_eq!(fix_mode_label(FixMode::NoFix as i32), "none");
        assert_eq!(fix_mode_label(99), "unknown");
    }

    #[test]
    fn camera_payload_maps_proto() {
        use amos_proto::amos_sensor::PixelFormat;
        let c = CameraDesc {
            id: 1,
            width: 320,
            height: 240,
            fps: 30,
            format: PixelFormat::Nv21 as i32,
        };
        let p = camera_payload(&c);
        assert_eq!(p.id, 1);
        assert_eq!(p.width, 320);
        assert_eq!(p.height, 240);
        assert_eq!(p.fps, 30);
        assert_eq!(p.format, "nv21");
    }

    #[test]
    fn gnss_payload_maps_fix_fields() {
        use amos_proto::amos_sensor::FixMode;
        let g = GnssReply {
            enabled: true,
            has_fix: true,
            latitude_deg: 31.23,
            longitude_deg: 121.47,
            altitude_m: 10.0,
            accuracy_m: 5.0,
            fix_mode: FixMode::ThreeDim as i32,
            sats_in_view: 11,
            timestamp_ms: 1000,
        };
        let p = gnss_payload(&g);
        assert!(p.enabled && p.has_fix);
        assert_eq!(p.latitude_deg, 31.23);
        assert_eq!(p.sats, Some(11));
        assert_eq!(p.fix_mode, "3d");
    }

    #[test]
    fn an_unreported_accuracy_and_satellite_count_are_unknown_not_0m_and_0sats() {
        use amos_proto::amos_sensor::FixMode;
        // The producer writes `0` for "not reported" on both zero-sentinel wires: Android's
        // `getAccuracy()` returns `0.0` for a fix with no accuracy estimate, and `Location`
        // carries no satellite count (`satellites_in_view: 0`). A surface showing `±0m` /
        // `0sats` would be stating a precision and a count the receiver never gave (P0-3).
        let g = GnssReply {
            enabled: true,
            has_fix: true,
            latitude_deg: 31.23,
            longitude_deg: 121.47,
            altitude_m: 10.0,
            accuracy_m: 0.0,
            fix_mode: FixMode::ThreeDim as i32,
            sats_in_view: 0,
            timestamp_ms: 1000,
        };
        let p = gnss_payload(&g);
        assert_eq!(p.accuracy_m, None);
        assert_eq!(p.sats, None);

        // Positive control: a real fix keeps both readings (the fold must not swallow them).
        let g = GnssReply {
            accuracy_m: 4.2,
            sats_in_view: 9,
            ..g
        };
        let p = gnss_payload(&g);
        assert_eq!(p.accuracy_m, Some(4.2));
        assert_eq!(p.sats, Some(9));
    }

    #[test]
    fn imu_payload_maps_sample_and_keeps_absent_families_unknown() {
        use amos_proto::amos_sensor::Vec3;
        let with_both = ImuReply {
            timestamp_ms: 5,
            accel_m_s2: Some(Vec3 {
                x: 0.1,
                y: -9.8,
                z: 0.2,
            }),
            gyro_rad_s: Some(Vec3 {
                x: 0.005,
                y: 0.001,
                z: -0.003,
            }),
            temperature_c: 36.5,
            rate_hz: 200,
        };
        let p = imu_payload(&with_both);
        assert_eq!(p.rate_hz, Some(200));
        assert_eq!(p.temp_c, Some(36.5));
        assert_eq!(p.accel_x, Some(0.1));
        assert_eq!(p.accel_y, Some(-9.8));
        assert_eq!(p.accel_z, Some(0.2));
        assert_eq!(p.gyro_x, Some(0.005));
        assert_eq!(p.gyro_y, Some(0.001));
        assert_eq!(p.gyro_z, Some(-0.003));

        // Both sensor families are optional on the wire, and an absent one stays **absent**
        // (`None` → the UI prints `—`): substituting `0.0` would put a measurement on the
        // wire that the device never made — and `0` is the most misleading substitute,
        // because it reads as "perfectly still" (REQ-A294 / AEROSPACE P0-3).
        let no_gyro = ImuReply {
            gyro_rad_s: None,
            ..with_both
        };
        let p = imu_payload(&no_gyro);
        assert_eq!(p.gyro_x, None);
        assert_eq!(p.gyro_y, None);
        assert_eq!(p.gyro_z, None);
        // Accelerometer still present (the families are independent).
        assert_eq!(p.accel_x, Some(0.1));

        let no_accel = ImuReply {
            accel_m_s2: None,
            ..with_both
        };
        let p = imu_payload(&no_accel);
        assert_eq!(p.accel_x, None);
        assert_eq!(p.accel_y, None);
        assert_eq!(p.accel_z, None);
        // Gyroscope still present.
        assert_eq!(p.gyro_x, Some(0.005));

        // Both absent: every axis is unknown, nothing is invented — and the *scalar* sample
        // facts that the reply does carry (rate, temperature) are still reported.
        let neither = ImuReply {
            accel_m_s2: None,
            gyro_rad_s: None,
            ..with_both
        };
        let p = imu_payload(&neither);
        assert_eq!(
            [p.accel_x, p.accel_y, p.accel_z, p.gyro_x, p.gyro_y, p.gyro_z],
            [None, None, None, None, None, None]
        );
        assert_eq!(p.rate_hz, Some(200));
        assert_eq!(p.temp_c, Some(36.5));
    }

    /// The wire writes `0` to mean "the IMU rate is not negotiated yet", so it must not
    /// become the measurement `0 Hz` (REQ-A1612 / F-SH-821).
    ///
    /// The producer's own vocabulary is the authority: `LiveSensorProvider::set_imu_rate_hz`
    /// documents "`0` = not negotiated yet" and `MIN_SENSOR_RATE_HZ` says "Zero is not a
    /// meaningful \"off\"". `uint32 rate_hz` has no field presence, so an un-negotiated
    /// device sends `0`, and a raw pass-through put `@0 Hz` on the settings panel — a
    /// fabricated sample rate, read as a measurement (the P0-3 shape this module's doc
    /// already states for the axes). The positive control is the `None`-free case: a real
    /// rate must survive, or "always report unknown" would pass this test too.
    #[test]
    fn an_unnegotiated_imu_rate_is_unknown_not_zero_hz() {
        let base = ImuReply {
            timestamp_ms: 0,
            accel_m_s2: None,
            gyro_rad_s: None,
            temperature_c: 36.5,
            rate_hz: 0,
        };
        assert_eq!(imu_payload(&base).rate_hz, None);

        // …and a negotiated rate is still reported, so the fold is not "always None".
        let negotiated = ImuReply {
            rate_hz: 100,
            ..base
        };
        assert_eq!(imu_payload(&negotiated).rate_hz, Some(100));
    }

    /// The wire writes `0` for "no die temperature" — the **normal** case, since
    /// the Android glue reads only the accelerometer and gyroscope and has no
    /// die-temperature source — so it must not become the measurement `0 °C`. The
    /// same zero-sentinel rule as `rate_hz` above, on the same message.
    ///
    /// The mock/sim providers *do* report a temperature, so the positive control
    /// is a real value surviving the fold (otherwise "always None" would pass).
    #[test]
    fn an_unreported_die_temperature_is_unknown_not_zero_degrees() {
        let base = ImuReply {
            timestamp_ms: 0,
            accel_m_s2: None,
            gyro_rad_s: None,
            temperature_c: 0.0,
            rate_hz: 200,
        };
        assert_eq!(imu_payload(&base).temp_c, None);

        let reported = ImuReply {
            temperature_c: 36.5,
            ..base
        };
        assert_eq!(imu_payload(&reported).temp_c, Some(36.5));
    }

    #[test]
    fn sensor_codes_are_stable_string_keys() {
        assert_eq!(codes::UNKNOWN_MODE, "amos.sensors.unknown_mode");
        assert_eq!(codes::UNKNOWN_KIND, "amos.sensors.unknown_kind");
        assert_eq!(codes::RATE_OUT_OF_RANGE, "amos.sensors.rate_out_of_range");
        assert_eq!(codes::RPC_FAILED, "amos.sensors.rpc_failed");
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn sensor_rate_bounds_are_sane_for_real_streams() {
        // Real streams run 30–200 Hz; the cap is well above that but refuses
        // the u32::MAX probe (a div-by-zero or "what if I pass max" canary).
        // The tripwire is the test itself; the lint is suppressed so the
        // tripwire keeps its "if any of these is wrong the build fails"
        // shape — the assertions are the contract, not the constant values.
        assert!(MIN_SENSOR_RATE_HZ >= 1);
        assert!(MAX_SENSOR_RATE_HZ >= 1000, "real high-rate streams fit");
        assert!(MAX_SENSOR_RATE_HZ < u32::MAX, "pathological max refused");
        // The window is inclusive on both ends.
        assert!((MIN_SENSOR_RATE_HZ..=MAX_SENSOR_RATE_HZ).contains(&30));
        assert!((MIN_SENSOR_RATE_HZ..=MAX_SENSOR_RATE_HZ).contains(&200));
        // Outside the window: refused.
        assert!(!((MIN_SENSOR_RATE_HZ..=MAX_SENSOR_RATE_HZ).contains(&0)));
        assert!(!((MIN_SENSOR_RATE_HZ..=MAX_SENSOR_RATE_HZ).contains(&u32::MAX)));
    }

    #[test]
    fn the_kind_and_mode_strings_cover_every_known_legitimate_value() {
        // The kind/mode enums have a closed set; anything else is an
        // honest "unknown" (the daemon returns `mode=99` for new unrecognised
        // values, never a fake label).
        for label in ["performance", "balanced", "power_save"] {
            assert!(mode_from_str(label).is_some());
        }
        assert_eq!(mode_from_str("turbo"), None);

        for kind in ["camera", "gnss", "imu"] {
            assert!(kind_from_str(kind).is_some());
        }
        assert_eq!(kind_from_str("barometer"), None);
        // And the unknown bit round-trips as "unknown" so the UI never shows
        // a stale label.
        assert_eq!(mode_label(99), "unknown");
    }
}
