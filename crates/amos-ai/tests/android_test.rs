//! End-to-end test: the shared UDS serves BOTH `AiAgent` and `AndroidManager`.
//! Here we drive the Android-manager client over the real socket and verify the
//! round trip reaches the service (graceful errors, since Waydroid isn't on the
//! host).

use amos_proto::android_compat::{
    android_manager_client::AndroidManagerClient, AppIconRequest, AppLaunchRequest, Empty,
};
use std::path::PathBuf;
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

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
async fn android_manager_reachable_over_shared_uds() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-android-ai-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });

    wait_for_socket(&path).await;
    let mut client = connect(&path).await.expect("connect");

    // GetInstalledApps returns REAL curated apps: on the host the daemon's
    // auto-selected DemoRuntime serves a working app list (no Waydroid needed).
    let list = client
        .get_installed_apps(Empty {})
        .await
        .expect("get_installed_apps")
        .into_inner();
    assert_eq!(list.apps.len(), 4, "demo runtime serves curated apps");
    assert_eq!(list.apps[0].package_name, "com.tencent.mm");

    // LaunchAndroidApp succeeds and returns a window id.
    let launch = client
        .launch_android_app(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        })
        .await
        .expect("launch rpc")
        .into_inner();
    assert!(launch.success, "launch succeeds via demo runtime");
    assert_eq!(launch.window_id, "waydroid_demo_com.tencent.mm");

    // GetAppIcon returns real PNG bytes over the same UDS.
    let icon = client
        .get_app_icon(AppIconRequest {
            package_name: "com.tencent.mm".into(),
        })
        .await
        .expect("icon rpc")
        .into_inner();
    assert!(icon.found, "icon should be found");
    assert_eq!(
        &icon.icon_png[..8],
        &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}
