//! Headless UDS round-trip for the sensor service: spin up a real tonic server
//! (`SensorServer`, mock backend) on a temp Unix Domain Socket and drive it with
//! the generated `SensorClient` — ListCameras → CaptureCamera → GetGnss → GetImu
//! → SetMode(PowerSave) → AcquireStream gate → GetMode. No GUI, no real device.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use amos_proto::amos_sensor::sensor_client::SensorClient;
use amos_proto::amos_sensor::{
    AcquireRequest, CameraCaptureRequest, Empty, SensorKind as ProtoKind, SensorMode as ProtoMode,
    SetModeRequest,
};
use amos_sensor::service::mock_server;
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;
use tokio_stream::wrappers::UnixListenerStream;
use tonic::transport::{Endpoint, Server, Uri};
use tower::service_fn;

async fn uds_channel(path: PathBuf) -> tonic::transport::Channel {
    let endpoint = Endpoint::try_from("http://[::1]:50051").unwrap();
    endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let socket = path.clone();
            async move {
                let stream = UnixStream::connect(socket).await?;
                Ok::<_, std::io::Error>(TokioIo::new(stream))
            }
        }))
        .await
        .unwrap()
}

fn temp_socket(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("{name}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    path
}

#[tokio::test]
async fn sensor_rpc_over_uds_round_trips() {
    let path = temp_socket("amos-sensor-e2e");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();

    let server = mock_server();
    let handle = tokio::spawn(async move {
        Server::builder()
            .add_service(server)
            .serve_with_incoming(UnixListenerStream::new(listener))
            .await
            .unwrap();
    });

    let mut client = SensorClient::new(uds_channel(path.clone()).await);

    // List cameras → the common mock reports rear (640x480) + front (320x240).
    let cameras = client.list_cameras(Empty {}).await.unwrap().into_inner();
    assert_eq!(cameras.cameras.len(), 2);
    assert!(cameras
        .cameras
        .iter()
        .any(|c| c.width == 640 && c.height == 480));

    // Capture frame metadata (seq advances monotonically).
    let cap = client
        .capture_camera(CameraCaptureRequest { id: 0 })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(cap.seq, 0);
    let cap2 = client
        .capture_camera(CameraCaptureRequest { id: 0 })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(cap2.seq, 1, "seq advances per capture");
    assert_eq!(cap.payload_len, cap2.payload_len);

    // GNSS fix present + plausible; IMU sample carries a rate.
    let gnss = client.get_gnss(Empty {}).await.unwrap().into_inner();
    assert!(gnss.enabled && gnss.has_fix);
    assert!(gnss.latitude_deg > 0.0);
    let imu = client.get_imu(Empty {}).await.unwrap().into_inner();
    assert_eq!(imu.rate_hz, 200);

    // Energy policy over the wire: Balanced allows a 200 Hz IMU stream…
    let ok = client
        .acquire_stream(AcquireRequest {
            kind: ProtoKind::Imu as i32,
            rate_hz: 200,
        })
        .await
        .unwrap()
        .into_inner();
    assert!(ok.allowed, "Balanced allows 200 Hz IMU");

    // …PowerSave refuses it and reports the new mode.
    let reply = client
        .set_mode(SetModeRequest {
            mode: ProtoMode::PowerSave as i32,
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(reply.mode, ProtoMode::PowerSave as i32);

    let denied = client
        .acquire_stream(AcquireRequest {
            kind: ProtoKind::Imu as i32,
            rate_hz: 200,
        })
        .await
        .unwrap()
        .into_inner();
    assert!(!denied.allowed, "PowerSave denies 200 Hz IMU");
    assert!(!denied.error.is_empty());

    let mode = client.get_mode(Empty {}).await.unwrap().into_inner();
    assert_eq!(mode.mode, ProtoMode::PowerSave as i32);

    let _ = std::fs::remove_file(&path);
    handle.abort();
}
