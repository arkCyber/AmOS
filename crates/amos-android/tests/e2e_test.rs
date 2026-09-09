//! End-to-end test: serve `AndroidManagerService` over a real Unix Domain
//! Socket and drive it through the tonic client (no Waydroid needed — the
//! controller uses a fake command runner).

use amos_android::{CommandRunner, WaydroidRuntime};
use amos_proto::android_compat::{
    android_manager_client::AndroidManagerClient, ActivityEvent, ActivityEventRequest,
    AppLaunchRequest, Empty, HostAction, HostActionRequest, LmkRequest, MemoryPressure,
};
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::net::UnixStream;
use tokio_stream::wrappers::UnixListenerStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

/// Fake runner that records every command (program + args) so the test can
/// assert the container-side `am force-stop` was really issued by an LMK kill.
struct FakeRunner {
    calls: Arc<Mutex<Vec<String>>>,
}
impl CommandRunner for FakeRunner {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
        let mut line = program.to_string();
        for a in args {
            line.push(' ');
            line.push_str(a);
        }
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(line);
        Ok(std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: b"package:com.tencent.mm\npackage:com.taobao.taobao\n".to_vec(),
            stderr: Vec::new(),
        })
    }
}

/// Render the recorded command lines into one newline-joined string (stable).
fn calls_joined(calls: &Arc<Mutex<Vec<String>>>) -> String {
    calls.lock().unwrap_or_else(|p| p.into_inner()).join("\n")
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

    // Shared recorder so we can assert the container commands issued by launch
    // and by the LMK `Kill` round.
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let runtime: Arc<dyn amos_android::AndroidRuntime> =
        Arc::new(WaydroidRuntime::with_runner(FakeRunner {
            calls: Arc::clone(&calls),
        }));
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

    // The LMK-proxy adopted the launched app; push a lifecycle event and read it
    // back over the same socket, then reclaim it under critical memory pressure.
    let stop = client
        .on_activity(ActivityEventRequest {
            package_name: "com.tencent.mm".into(),
            event: ActivityEvent::Stop as i32,
            activity_id: String::new(),
        })
        .await
        .expect("on_activity")
        .into_inner();
    assert_eq!(stop.state_key, "background");

    let snap = client
        .get_lmk_snapshot(Empty {})
        .await
        .expect("get_lmk_snapshot")
        .into_inner();
    assert_eq!(snap.tasks.len(), 1);
    assert_eq!(snap.tasks[0].package_name, "com.tencent.mm");
    assert_eq!(snap.tasks[0].state_key, "background");
    assert_eq!(snap.background_count, 1);

    let lmk = client
        .trigger_lmk(LmkRequest {
            pressure: MemoryPressure::Critical as i32,
            budget: 5,
        })
        .await
        .expect("trigger_lmk")
        .into_inner();
    assert_eq!(lmk.victims.len(), 1);
    assert_eq!(lmk.victims[0].package_name, "com.tencent.mm");
    assert!(lmk.victims[0].killed);
    assert_eq!(lmk.victims[0].window_id, "waydroid_com.tencent.mm");

    let empty = client
        .get_lmk_snapshot(Empty {})
        .await
        .expect("get_lmk_snapshot")
        .into_inner();
    assert!(empty.tasks.is_empty());

    // The `Kill` decision must have been physically acted on in the container:
    // launch issued `waydroid app launch` and the LMK kill issued
    // `waydroid shell am force-stop <package>` on the same recorded runner.
    let recorded = calls_joined(&calls);
    assert!(
        recorded.contains("waydroid shell am force-stop com.tencent.mm"),
        "expected an am force-stop for the reclaimed app, got:\n{recorded}"
    );
    assert!(
        recorded.contains("waydroid app launch com.tencent.mm"),
        "expected an app launch to be recorded, got:\n{recorded}"
    );

    // A *host-driven* reclaim pushed over the wire (reverse half) also drops the
    // container task and issues a real force-stop on the same runner.
    client
        .launch_android_app(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        })
        .await
        .expect("relaunch")
        .into_inner();
    client
        .apply_host_decision(HostActionRequest {
            package_name: "com.tencent.mm".into(),
            action: HostAction::Reclaim as i32,
        })
        .await
        .expect("apply_host_decision");
    let after = client
        .get_lmk_snapshot(Empty {})
        .await
        .expect("get_lmk_snapshot")
        .into_inner();
    assert!(
        after.tasks.is_empty(),
        "host-driven reclaim must drop the task"
    );
    let recorded2 = calls_joined(&calls);
    assert!(
        recorded2
            .matches("waydroid shell am force-stop com.tencent.mm")
            .count()
            >= 2,
        "expected a second am force-stop from the host-driven reclaim, got:\n{recorded2}"
    );

    // Server-streaming `WatchLmk`: subscribe, then a host-driven reclaim must
    // arrive as a RECLAIMED event carrying the `legacy` surface window_id.
    client
        .launch_android_app(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        })
        .await
        .expect("relaunch for watch")
        .into_inner();
    let mut watch = client
        .watch_lmk(Empty {})
        .await
        .expect("open watch")
        .into_inner();
    client
        .apply_host_decision(HostActionRequest {
            package_name: "com.tencent.mm".into(),
            action: HostAction::Reclaim as i32,
        })
        .await
        .expect("apply_host_decision");
    let evt = tokio::time::timeout(std::time::Duration::from_millis(500), watch.message())
        .await
        .expect("timeout waiting for lmk event")
        .expect("watch stream error")
        .expect("watch stream ended without an event");
    assert_eq!(evt.kind, 1, "RECLAIMED (proto enum value)");
    assert_eq!(evt.package_name, "com.tencent.mm");
    assert_eq!(evt.window_id, "waydroid_com.tencent.mm");

    server.abort();
    let _ = std::fs::remove_file(&path);
}
