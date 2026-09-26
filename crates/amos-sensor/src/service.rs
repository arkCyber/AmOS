//! gRPC `SensorService` exposing the amos-sensor domain core over the shared UDS.
//!
//! Mirrors the `amos-telephony` service pattern: the service struct holds a
//! [`SensorManager`] (provider + energy policy) and maps tonic RPCs onto the
//! domain core, converting domain errors to gRPC [`Status`]. For P1 the backing
//! provider is the deterministic [`MockSensorProvider`]; a real Android
//! Camera2 / Gnss / SensorManager HAL backend swaps it in later. Contract:
//! `proto/sensor.proto` + `docs/sensors.md`.

use std::sync::Arc;

use amos_proto::amos_sensor::{
    sensor_server::{Sensor, SensorServer},
    AcquireReply, AcquireRequest, CameraCaptureReply, CameraCaptureRequest, CameraDesc, CameraList,
    Empty, FixMode as ProtoFixMode, GnssReply, ImuReply, ModeReply,
    PixelFormat as ProtoPixelFormat, SensorKind as ProtoSensorKind, SensorMode as ProtoSensorMode,
    SetModeRequest, Vec3 as ProtoVec3,
};
use tonic::{Request, Response, Status};

use crate::error::SensorError;
use crate::manager::SensorManager;
use crate::provider::MockSensorProvider;
use crate::spec::{CameraId, FixMode, GeoFix, PixelFormat, SensorKind, SensorMode};

/// gRPC service wiring the sensor domain core to the wire contract.
pub struct SensorService {
    manager: SensorManager,
}

impl SensorService {
    /// Wrap an arbitrary manager (Mock today; a real-HAL manager later).
    pub fn new(manager: SensorManager) -> Self {
        Self { manager }
    }

    /// Default P1 backend: the deterministic common mock in [`SensorMode::Balanced`].
    pub fn with_mock() -> Self {
        Self::new(SensorManager::new(
            Arc::new(MockSensorProvider::common()),
            SensorMode::Balanced,
        ))
    }

    pub fn manager(&self) -> &SensorManager {
        &self.manager
    }
}

/// A ready-to-mount [`SensorServer`] backed by the deterministic mock.
pub fn mock_server() -> SensorServer<SensorService> {
    SensorServer::new(SensorService::with_mock())
}

/// A ready-to-mount [`SensorServer`] around a caller-provided manager.
pub fn server(manager: SensorManager) -> SensorServer<SensorService> {
    SensorServer::new(SensorService::new(manager))
}

#[tonic::async_trait]
impl Sensor for SensorService {
    async fn list_cameras(&self, _request: Request<Empty>) -> Result<Response<CameraList>, Status> {
        let cameras = self
            .manager
            .camera_configs()
            .into_iter()
            .map(|c| CameraDesc {
                id: c.id.0,
                width: c.resolution.width,
                height: c.resolution.height,
                fps: c.fps,
                format: proto_pixel_format(c.format),
            })
            .collect();
        Ok(Response::new(CameraList { cameras }))
    }

    async fn capture_camera(
        &self,
        request: Request<CameraCaptureRequest>,
    ) -> Result<Response<CameraCaptureReply>, Status> {
        let id = CameraId(request.into_inner().id);
        let frame = self.manager.camera_capture(id).map_err(err_status)?;
        Ok(Response::new(CameraCaptureReply {
            id: frame.camera.0,
            seq: frame.seq,
            width: frame.resolution.width,
            height: frame.resolution.height,
            format: proto_pixel_format(frame.format),
            payload_len: frame.bytes.len() as u64,
        }))
    }

    async fn get_gnss(&self, _request: Request<Empty>) -> Result<Response<GnssReply>, Status> {
        let enabled = self.manager.gnss_enabled();
        let fix = self.manager.gnss_fix().map_err(err_status)?;
        let reply = match fix {
            Some(f) => gnss_reply(enabled, Some(&f)),
            None => gnss_reply(enabled, None),
        };
        Ok(Response::new(reply))
    }

    async fn get_imu(&self, _request: Request<Empty>) -> Result<Response<ImuReply>, Status> {
        let sample = self.manager.imu_sample().map_err(err_status)?;
        Ok(Response::new(imu_reply(
            &sample,
            self.manager.imu_rate_hz(),
        )))
    }

    async fn get_mode(&self, _request: Request<Empty>) -> Result<Response<ModeReply>, Status> {
        Ok(Response::new(ModeReply {
            mode: proto_sensor_mode(self.manager.mode()),
        }))
    }

    async fn set_mode(
        &self,
        request: Request<SetModeRequest>,
    ) -> Result<Response<ModeReply>, Status> {
        let mode = domain_sensor_mode(request.into_inner().mode)
            .ok_or_else(|| Status::invalid_argument("unknown sensor mode"))?;
        self.manager.set_mode(mode);
        Ok(Response::new(ModeReply {
            mode: proto_sensor_mode(mode),
        }))
    }

    async fn acquire_stream(
        &self,
        request: Request<AcquireRequest>,
    ) -> Result<Response<AcquireReply>, Status> {
        let req = request.into_inner();
        let kind = match domain_sensor_kind(req.kind) {
            Some(k) => k,
            None => {
                return Ok(Response::new(AcquireReply {
                    allowed: false,
                    error: "unknown sensor kind".to_string(),
                }))
            }
        };
        match self.manager.acquire_stream(kind, req.rate_hz) {
            Ok(()) => Ok(Response::new(AcquireReply {
                allowed: true,
                error: String::new(),
            })),
            Err(e) => Ok(Response::new(AcquireReply {
                allowed: false,
                error: e.to_string(),
            })),
        }
    }
}
/// Map a domain [`SensorError`] to a gRPC [`Status`].
fn err_status(e: SensorError) -> Status {
    match e {
        SensorError::CameraNotFound(_) => Status::not_found(e.to_string()),
        SensorError::InvalidArguments(_) => Status::invalid_argument(e.to_string()),
        other => Status::internal(other.to_string()),
    }
}

fn proto_sensor_mode(m: SensorMode) -> i32 {
    match m {
        SensorMode::Performance => ProtoSensorMode::Performance as i32,
        SensorMode::Balanced => ProtoSensorMode::Balanced as i32,
        SensorMode::PowerSave => ProtoSensorMode::PowerSave as i32,
    }
}

fn domain_sensor_mode(v: i32) -> Option<SensorMode> {
    match v {
        x if x == ProtoSensorMode::Performance as i32 => Some(SensorMode::Performance),
        x if x == ProtoSensorMode::Balanced as i32 => Some(SensorMode::Balanced),
        x if x == ProtoSensorMode::PowerSave as i32 => Some(SensorMode::PowerSave),
        _ => None,
    }
}

fn domain_sensor_kind(v: i32) -> Option<SensorKind> {
    match v {
        x if x == ProtoSensorKind::Camera as i32 => Some(SensorKind::Camera),
        x if x == ProtoSensorKind::Gnss as i32 => Some(SensorKind::Gnss),
        x if x == ProtoSensorKind::Imu as i32 => Some(SensorKind::Imu),
        _ => None,
    }
}

fn proto_pixel_format(f: PixelFormat) -> i32 {
    match f {
        PixelFormat::Rgba8 => ProtoPixelFormat::Rgba8 as i32,
        PixelFormat::Nv21 => ProtoPixelFormat::Nv21 as i32,
    }
}

fn proto_fix_mode(f: FixMode) -> i32 {
    match f {
        FixMode::NoFix => ProtoFixMode::NoFix as i32,
        FixMode::TwoDim => ProtoFixMode::TwoDim as i32,
        FixMode::ThreeDim => ProtoFixMode::ThreeDim as i32,
    }
}

fn proto_vec3(v: crate::spec::Vec3) -> ProtoVec3 {
    ProtoVec3 {
        x: v.x,
        y: v.y,
        z: v.z,
    }
}

fn gnss_reply(enabled: bool, fix: Option<&GeoFix>) -> GnssReply {
    match fix {
        Some(f) => GnssReply {
            enabled,
            has_fix: true,
            latitude_deg: f.latitude_deg,
            longitude_deg: f.longitude_deg,
            altitude_m: f.altitude_m,
            accuracy_m: f.horizontal_accuracy_m,
            fix_mode: proto_fix_mode(f.fix_mode),
            sats_in_view: f.satellites_in_view,
            timestamp_ms: f.timestamp_ms,
        },
        None => GnssReply {
            enabled,
            has_fix: false,
            latitude_deg: 0.0,
            longitude_deg: 0.0,
            altitude_m: 0.0,
            accuracy_m: 0.0,
            fix_mode: ProtoFixMode::NoFix as i32,
            sats_in_view: 0,
            timestamp_ms: 0,
        },
    }
}

/// Map one domain IMU sample onto the wire reply. Pure, so the sentinel rule
/// below is testable without a running service (the sibling [`gnss_reply`] is
/// split out for the same reason).
fn imu_reply(sample: &crate::spec::ImuSample, rate_hz: u32) -> ImuReply {
    ImuReply {
        timestamp_ms: sample.timestamp_ms,
        accel_m_s2: Some(proto_vec3(sample.accel_m_s2)),
        // The proto's `gyro_rad_s` is a message field, so it *has* presence —
        // unlike `temperature_c` below, absence needs no sentinel here. A device
        // with no gyroscope (the field S5) leaves this `None`, and the consumer
        // reads `null`; writing `Some(Vec3::ZERO)` in its place would put a
        // measurement on the wire — "not rotating" — for a rate nothing measured.
        gyro_rad_s: sample.gyro_rad_s.map(proto_vec3),
        // `float temperature_c` has no field presence, so an absent die
        // temperature — a device with no source for one, the Android glue's
        // normal case — cannot be expressed as a missing field. It goes out as the
        // zero-sentinel this message family already uses for "not reported"
        // (`rate_hz`, and GNSS's `accuracy_m` / `sats_in_view`), and the Tauri seam
        // reads `0` back as **unknown**, never as a measured `0 °C`.
        temperature_c: sample.temperature_c.unwrap_or(0.0),
        rate_hz,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_die_temperature_goes_on_the_wire_as_the_zero_sentinel() {
        let base = crate::spec::ImuSample::new(
            7,
            crate::spec::Vec3::new(0.1, -9.8, 0.2),
            Some(crate::spec::Vec3::new(0.0, 0.0, 0.0)),
            None,
        );
        // `None` is "no source for a die temperature" — the wire's only way to say
        // that is the family's zero-sentinel, and the Tauri seam reads it back as
        // unknown. It must **not** become a fabricated plausible number.
        assert_eq!(imu_reply(&base, 200).temperature_c, 0.0);
        // A real reading survives the round trip (positive control).
        let measured = crate::spec::ImuSample {
            temperature_c: Some(36.5),
            ..base
        };
        assert_eq!(imu_reply(&measured, 200).temperature_c, 36.5);
    }

    /// A device with no gyroscope leaves `gyro_rad_s` `None`, and the wire must
    /// carry that as a **missing field** — not as `Some(Vec3::ZERO)`, which is the
    /// measurement "not rotating". The proto field is a message, so absence is
    /// representable; folding it to zero is a choice, and the wrong one
    /// (REQ-A1872 / F-SEN-008: the field S5 has no gyroscope).
    #[test]
    fn an_absent_gyroscope_goes_on_the_wire_as_a_missing_field_not_a_zero_vec() {
        let no_gyro =
            crate::spec::ImuSample::new(7, crate::spec::Vec3::new(0.1, -9.8, 0.2), None, None);
        assert_eq!(
            imu_reply(&no_gyro, 200).gyro_rad_s,
            None,
            "a gyroscope-less device must not report a zero angular rate"
        );
        // Positive control: a real gyro reading survives the round trip as a value.
        let with_gyro = crate::spec::ImuSample {
            gyro_rad_s: Some(crate::spec::Vec3::new(0.01, -0.02, 0.03)),
            ..no_gyro
        };
        let g = imu_reply(&with_gyro, 200)
            .gyro_rad_s
            .expect("a measured gyro reading must be present on the wire");
        assert_eq!((g.x, g.y, g.z), (0.01, -0.02, 0.03));
    }

    #[test]
    fn mode_round_trips_via_wire_values() {
        for m in [
            SensorMode::Performance,
            SensorMode::Balanced,
            SensorMode::PowerSave,
        ] {
            let wire = proto_sensor_mode(m);
            assert_eq!(domain_sensor_mode(wire), Some(m));
        }
        assert_eq!(domain_sensor_mode(999), None);
    }

    #[test]
    fn unknown_kind_is_rejected() {
        assert_eq!(domain_sensor_kind(999), None);
        assert_eq!(
            domain_sensor_kind(ProtoSensorKind::Imu as i32),
            Some(SensorKind::Imu)
        );
    }

    #[test]
    fn mock_service_reports_common_cameras() {
        let service = SensorService::with_mock();
        let cameras = service.manager().camera_configs();
        assert_eq!(cameras.len(), 2, "common mock has rear + front");
    }
}
