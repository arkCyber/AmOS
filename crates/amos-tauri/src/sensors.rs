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
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

/// The OS daemon socket — the same one `ai_bridge`/`telephony` use (`AMOS_SOCKET`
/// wins, else the platform default, e.g. `/tmp/amos-ai.sock`).
fn socket_path() -> std::path::PathBuf {
    amos_proto::socket::default_socket_path()
}

async fn build_channel() -> Result<tonic::transport::Channel, String> {
    let socket = socket_path();
    let owned = socket.clone();
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| format!("OS daemon unavailable at {socket:?}: {e}"))?;
    Ok(channel)
}

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
#[derive(Clone, Debug, Serialize)]
pub struct SensorGnss {
    pub enabled: bool,
    pub has_fix: bool,
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub accuracy_m: f64,
    pub sats: u32,
    pub fix_mode: String,
}

/// Serializable IMU sample.
#[derive(Clone, Debug, Serialize)]
pub struct SensorImu {
    pub rate_hz: u32,
    pub accel_x: f64,
    pub accel_y: f64,
    pub accel_z: f64,
    pub temp_c: f32,
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
        accuracy_m: g.accuracy_m,
        sats: g.sats_in_view,
        fix_mode: fix_mode_label(g.fix_mode),
    }
}

fn imu_payload(i: &ImuReply) -> SensorImu {
    let acc = i.accel_m_s2.as_ref();
    SensorImu {
        rate_hz: i.rate_hz,
        accel_x: acc.map(|v| v.x).unwrap_or(0.0),
        accel_y: acc.map(|v| v.y).unwrap_or(0.0),
        accel_z: acc.map(|v| v.z).unwrap_or(0.0),
        temp_c: i.temperature_c,
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
#[tauri::command]
pub async fn sensor_set_mode(mode: String) -> Result<String, String> {
    let proto_mode = mode_from_str(&mode)
        .ok_or_else(|| format!("unknown sensor mode '{mode}' (performance|balanced|power_save)"))?;
    let mut client = SensorClient::new(build_channel().await?);
    let reply = client
        .set_mode(SetModeRequest { mode: proto_mode })
        .await
        .map_err(|e| format!("sensor set_mode failed: {e}"))?
        .into_inner();
    Ok(mode_label(reply.mode))
}

/// Ask the daemon to allow a continuous stream (`kind` = camera|gnss|imu).
#[tauri::command]
pub async fn sensor_acquire(kind: String, rate_hz: u32) -> Result<SensorAcquireResult, String> {
    let kind = kind_from_str(&kind)
        .ok_or_else(|| format!("unknown sensor kind '{kind}' (camera|gnss|imu)"))?;
    let mut client = SensorClient::new(build_channel().await?);
    let reply = client
        .acquire_stream(AcquireRequest { kind, rate_hz })
        .await
        .map_err(|e| format!("sensor acquire_stream failed: {e}"))?
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
        assert_eq!(p.sats, 11);
        assert_eq!(p.fix_mode, "3d");
    }

    #[test]
    fn imu_payload_maps_sample_and_handles_absent_accel() {
        use amos_proto::amos_sensor::Vec3;
        let with_accel = ImuReply {
            timestamp_ms: 5,
            accel_m_s2: Some(Vec3 {
                x: 0.1,
                y: -9.8,
                z: 0.2,
            }),
            gyro_rad_s: None,
            temperature_c: 36.5,
            rate_hz: 200,
        };
        let p = imu_payload(&with_accel);
        assert_eq!(p.rate_hz, 200);
        assert_eq!(p.temp_c, 36.5);
        assert_eq!(p.accel_x, 0.1);
        assert_eq!(p.accel_y, -9.8);

        let no_accel = ImuReply {
            accel_m_s2: None,
            ..with_accel
        };
        let p = imu_payload(&no_accel);
        assert_eq!(p.accel_x, 0.0);
        assert_eq!(p.accel_y, 0.0);
        assert_eq!(p.accel_z, 0.0);
    }
}
