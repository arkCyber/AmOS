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
        Ok(Response::new(ImuReply {
            timestamp_ms: sample.timestamp_ms,
            accel_m_s2: Some(proto_vec3(sample.accel_m_s2)),
            gyro_rad_s: Some(proto_vec3(sample.gyro_rad_s)),
            temperature_c: sample.temperature_c,
            rate_hz: self.manager.imu_rate_hz(),
        }))
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

#[cfg(test)]
mod tests {
    use super::*;

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
