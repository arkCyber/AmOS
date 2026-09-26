//! `sensor_once` — headless smoke against a *running* amos-ai daemon's mounted
//! `SensorService` (the domain SensorManager + mock provider exposed over the
//! shared UDS).
//!
//! Lists cameras, captures one frame's metadata, reads the GNSS fix + IMU sample,
//! and prints the current energy mode. Read-only (never flips PowerSave).
//!
//! Usage:
//!   cargo run -p amos-ai --example sensor_once -- /tmp/amos-ai.sock

use std::path::PathBuf;

use amos_proto::amos_sensor::sensor_client::SensorClient;
use amos_proto::amos_sensor::Empty;
use anyhow::{anyhow, Result};
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

async fn uds_channel(socket: PathBuf) -> Result<tonic::transport::Channel> {
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| anyhow!(e.to_string()))?;
    endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let socket = socket.clone();
            async move {
                let stream = UnixStream::connect(socket).await?;
                Ok::<_, std::io::Error>(TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| anyhow!("daemon not reachable at socket: {e}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let socket = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("usage: sensor_once <socket>"))?;

    let mut client = SensorClient::new(uds_channel(socket).await?);

    let mode = client.get_mode(Empty {}).await?.into_inner().mode;
    println!("sensor mode: {mode}");

    let cameras = client.list_cameras(Empty {}).await?.into_inner().cameras;
    println!("cameras: {}", cameras.len());
    for c in &cameras {
        println!(
            "  camera id={} {}x{} @{}fps format={}",
            c.id, c.width, c.height, c.fps, c.format
        );
    }
    if let Some(first) = cameras.first() {
        let frame = client
            .capture_camera(amos_proto::amos_sensor::CameraCaptureRequest { id: first.id })
            .await?
            .into_inner();
        println!(
            "  capture seq={} {}x{} payload_len={}",
            frame.seq, frame.width, frame.height, frame.payload_len
        );
    }

    let gnss = client.get_gnss(Empty {}).await?.into_inner();
    if gnss.has_fix {
        println!(
            "gnss: lat={} lon={} acc={}m sats={} (fix mode {})",
            gnss.latitude_deg,
            gnss.longitude_deg,
            gnss.accuracy_m,
            gnss.sats_in_view,
            gnss.fix_mode
        );
    } else {
        println!("gnss: enabled={} no fix yet", gnss.enabled);
    }

    // An absent field prints `—`, never a folded `0`: a gyroscope-less device
    // sends no `gyro_rad_s` at all, and `(0.00,0.00,0.00) rad/s` would read as
    // the measurement "not rotating" — the same fold this probe is used to
    // diagnose (REQ-A1872 / F-SEN-008). `rate_hz` and `temperature_c` are the
    // message's zero-sentinels for "not reported" and are printed the same way.
    let imu = client.get_imu(Empty {}).await?.into_inner();
    println!(
        "imu: @{}Hz acc={} m/s² gyro={} rad/s temp={}°C",
        if imu.rate_hz == 0 {
            "—".to_string()
        } else {
            imu.rate_hz.to_string()
        },
        imu.accel_m_s2
            .as_ref()
            .map(|v| format!("{:.2},{:.2},{:.2}", v.x, v.y, v.z))
            .unwrap_or_else(|| "—".to_string()),
        imu.gyro_rad_s
            .as_ref()
            .map(|v| format!("{:.2},{:.2},{:.2}", v.x, v.y, v.z))
            .unwrap_or_else(|| "—".to_string()),
        if imu.temperature_c == 0.0 {
            "—".to_string()
        } else {
            format!("{:.1}", imu.temperature_c)
        }
    );
    Ok(())
}
