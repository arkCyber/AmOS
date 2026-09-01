//! System-level test: a single UDS connection drives BOTH gRPC services that
//! `amos-ai` serves — the AI agent (server-streaming tokens) and the Android
//! manager (list / launch / icon). This proves the "one daemon, one socket,
//! every capability" production property end-to-end.

use amos_proto::ai_agent::{ai_agent_client::AiAgentClient, AgentRequest};
use amos_proto::android_compat::{
    android_manager_client::AndroidManagerClient, AppIconRequest, AppLaunchRequest, Empty,
};
use std::path::PathBuf;
use tokio::net::UnixStream;
use tonic::transport::{Channel, Endpoint, Uri};
use tower::service_fn;

async fn connect(path: &std::path::Path) -> Result<Channel, String> {
    let owned = path.to_owned();
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| e.to_string())
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..50 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn one_socket_serves_ai_and_android() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-system-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;

    // ONE channel shared by both clients.
    let channel = connect(&path).await.expect("connect");
    let mut ai = AiAgentClient::new(channel.clone());
    let mut android = AndroidManagerClient::new(channel);

    // AI: stream tokens until the done frame.
    let mut stream = ai
        .stream_chat(AgentRequest {
            session_id: "system".into(),
            prompt: "你好".into(),
            context: Default::default(),
        })
        .await
        .expect("ai stream")
        .into_inner();
    let mut done = false;
    let mut toks = 0;
    while let Ok(Some(chunk)) = stream.message().await {
        if !chunk.token.is_empty() {
            toks += 1;
        }
        if chunk.done {
            done = true;
            break;
        }
    }
    assert!(done, "ai stream terminated with done frame");
    assert!(toks > 0, "ai stream produced tokens");

    // Android: list, launch, icon — all on the same socket.
    let list = android
        .get_installed_apps(Empty {})
        .await
        .expect("android list")
        .into_inner();
    assert_eq!(list.apps.len(), 4);
    let launch = android
        .launch_android_app(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        })
        .await
        .expect("android launch")
        .into_inner();
    assert!(launch.success);
    let icon = android
        .get_app_icon(AppIconRequest {
            package_name: "com.tencent.mm".into(),
        })
        .await
        .expect("android icon")
        .into_inner();
    assert!(icon.found);
    assert_eq!(
        &icon.icon_png[..8],
        &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}
