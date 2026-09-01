//! End-to-end test: serve `AndroidManagerService` over a real Unix Domain
//! Socket and drive it through the tonic client (no Waydroid needed — the
//! controller uses a fake command runner).

use amos_android::{CommandRunner, WaydroidRuntime};
use amos_proto::android_compat::{
    android_manager_client::AndroidManagerClient, AppLaunchRequest, Empty,
};
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::UnixStream;
use tokio_stream::wrappers::UnixListenerStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

struct FakeRunner;
impl CommandRunner for FakeRunner {
    fn run(&self, _program: &str, _args: &[&str]) -> std::io::Result<std::process::Output> {
        Ok(std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: b"package:com.tencent.mm\npackage:com.taobao.taobao\n".to_vec(),
            stderr: Vec::new(),
        })
    }
}

async fn connect(
    path: &std::path::Path,
) -> Result<AndroidManagerClient<tonic::transport::Channel>, String> {
    let owned = path.to_owned();
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
        .map_err(|e| e.to_string())?;
    Ok(AndroidManagerClient::new(channel))
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
async fn android_manager_rpc_over_uds() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-android-e2e-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let runtime: Arc<dyn amos_android::AndroidRuntime> =
        Arc::new(WaydroidRuntime::with_runner(FakeRunner));
    let server = tokio::spawn({
        let path = path.clone();
        async move {
            let listener = tokio::net::UnixListener::bind(&path).unwrap();
            let incoming = UnixListenerStream::new(listener);
            tonic::transport::Server::builder()
                .add_service(amos_android::service::server(runtime))
                .serve_with_incoming(incoming)
                .await
                .unwrap();
        }
    });

    wait_for_socket(&path).await;
    let mut client = connect(&path).await.expect("connect");

    let list = client
        .get_installed_apps(Empty {})
        .await
        .expect("get_installed_apps")
        .into_inner();
    assert_eq!(list.apps.len(), 2, "two apps parsed over the wire");
    assert_eq!(list.apps[0].package_name, "com.tencent.mm");

    let launch = client
        .launch_android_app(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        })
        .await
        .expect("launch")
        .into_inner();
    assert!(launch.success);
    assert_eq!(launch.window_id, "waydroid_com.tencent.mm");

    server.abort();
    let _ = std::fs::remove_file(&path);
}
