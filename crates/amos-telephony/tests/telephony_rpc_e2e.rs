//! Headless UDS round-trip for the telephony service: spin up a real tonic
//! server (`TelephonyServer`, mock backend) on a temp Unix Domain Socket and
//! drive it with the generated `TelephonyClient` (Dial → Status → End), exactly
//! like `amos-ai`'s e2e / the `chat_once` example — no GUI, no real telephony.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use amos_proto::amos_telephony::telephony_client::TelephonyClient;
use amos_proto::amos_telephony::{CallIdMsg, DialRequest, EndRequest, StatusRequest};
use amos_telephony::service::mock_server;
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
async fn dial_status_end_over_uds() {
    let path = temp_socket("amos-telephony-e2e");
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

    let mut client = TelephonyClient::new(uds_channel(path.clone()).await);

    let id = client
        .dial(DialRequest {
            number: "13800138000".into(),
            emergency: false,
        })
        .await
        .unwrap()
        .into_inner()
        .id;
    assert!(!id.is_empty(), "dial returns a call id");

    let calls = client
        .status(StatusRequest {})
        .await
        .unwrap()
        .into_inner()
        .calls;
    assert_eq!(calls.len(), 1, "dialed call is live");
    assert_eq!(calls[0].call.as_ref().unwrap().id, id);

    client
        .end(EndRequest {
            call: Some(CallIdMsg { id: id.clone() }),
        })
        .await
        .unwrap();

    let calls = client
        .status(StatusRequest {})
        .await
        .unwrap()
        .into_inner()
        .calls;
    assert!(calls.is_empty(), "ended call is released");

    let _ = std::fs::remove_file(&path);
    handle.abort();
}

#[tokio::test]
async fn emergency_112_over_uds() {
    let path = temp_socket("amos-telephony-e2e-emergency");
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

    let mut client = TelephonyClient::new(uds_channel(path.clone()).await);
    let id = client
        .dial(DialRequest {
            number: "112".into(),
            emergency: false, // number classification still routes to emergency
        })
        .await
        .unwrap()
        .into_inner()
        .id;

    let calls = client
        .status(StatusRequest {})
        .await
        .unwrap()
        .into_inner()
        .calls;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].call.as_ref().unwrap().id, id, "id echoed back");
    assert!(calls[0].emergency, "112 is marked emergency");

    let _ = std::fs::remove_file(&path);
    handle.abort();
}
