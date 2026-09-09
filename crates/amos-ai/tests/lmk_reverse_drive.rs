//! Integration test for the *reverse* half of the container↔host bridge: when
//! the daemon's shared `ResourceGovernor` runs an `observe` tick that reclaims
//! (or freezes) apps, `drive_host_decisions` pushes that decision back into the
//! container — force-stopping the real process for container-managed apps only.
//! Mirrors how `serve()` keeps the SAME proxy/manager/host instances for the beat
//! and the AndroidManager service. (docs/lmk-proxy.md §8)

use std::os::unix::process::ExitStatusExt;
use std::sync::{Arc, Mutex};

use amos_ai::governor::ResourceGovernor;
use amos_ai::governor_service::{drive_host_decisions, GovernorLmkHost};
use amos_android::{
    AndroidManagerService, CommandRunner, EnhancedAndroidManager, LmkProxy, WaydroidRuntime,
};
use amos_applife::AppId;
use amos_power::{BatteryState, Telemetry, Usage};
use amos_proto::android_compat::{
    android_manager_server::AndroidManager, ActivityEvent, ActivityEventRequest, AppLaunchRequest,
    Empty, LmkEventKind,
};
use tokio::sync::broadcast;
use tonic::Request;

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
            stdout: Vec::new(),
            stderr: Vec::new(),
        })
    }
}

fn charging() -> Telemetry {
    Telemetry::new(
        BatteryState::charging(60.0),
        Usage::default(), // screen off
        None,
    )
}

#[tokio::test]
async fn host_reclaim_drives_container_force_stop_for_managed_apps_only() {
    let shared: Arc<Mutex<ResourceGovernor>> = Arc::new(Mutex::new(ResourceGovernor::default()));
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    // Same-instance wiring as serve(): a shared proxy + manager + host bridge.
    let proxy: Arc<Mutex<LmkProxy>> = Arc::new(Mutex::new(LmkProxy::new()));
    let manager: Arc<EnhancedAndroidManager> = Arc::new(EnhancedAndroidManager::new(Arc::new(
        WaydroidRuntime::with_runner(FakeRunner {
            calls: Arc::clone(&calls),
        }),
    )));
    let host: Arc<GovernorLmkHost> = Arc::new(GovernorLmkHost::new(Arc::clone(&shared)));
    let android = AndroidManagerService::with_parts(
        Arc::clone(&manager),
        Arc::clone(&proxy),
        host.clone(), // coerced to Arc<dyn LmkHost>
    );

    // Container launches WeChat (adopted into the host + managed), then hides it.
    android
        .launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();
    android
        .on_activity(Request::new(ActivityEventRequest {
            package_name: "com.tencent.mm".into(),
            event: ActivityEvent::Stop as i32,
            activity_id: String::new(),
        }))
        .await
        .unwrap();

    // A *host-native* background app (NOT container-managed) also present.
    {
        let mut g = shared.lock().unwrap_or_else(|p| p.into_inner());
        g.register_app(AppId::new("notes")).unwrap();
        g.background_app(AppId::new("notes")).unwrap();
    }

    // One governor tick under memory pressure reclaims both LRU background apps.
    let outcome =
        shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .observe(0, charging(), true, false);
    assert!(outcome.reclaimed.contains(&AppId::new("com.tencent.mm")));
    assert!(outcome.reclaimed.contains(&AppId::new("notes")));

    // Reverse drive: only the managed container app (WeChat) is acted on, and
    // the decision is broadcast onto the shared `WatchLmk` channel.
    let (events, _) = broadcast::channel(16);
    let mut rx = events.subscribe();
    drive_host_decisions(&outcome, &host, &proxy, &manager, &events).await;

    // The beat-driven reclaim must surface as a RECLAIMED event for WeChat.
    let evt = rx.recv().await.expect("event broadcast");
    assert_eq!(evt.kind, LmkEventKind::Reclaimed as i32);
    assert_eq!(evt.package_name, "com.tencent.mm");
    assert_eq!(evt.window_id, "waydroid_com.tencent.mm");

    let recorded = calls.lock().unwrap_or_else(|p| p.into_inner()).join("\n");
    assert!(
        recorded.contains("waydroid shell am force-stop com.tencent.mm"),
        "managed container app must be force-stopped, got:\n{recorded}"
    );
    assert!(
        !recorded.contains("am force-stop notes"),
        "host-native app must NOT be force-stopped, got:\n{recorded}"
    );

    // The managed container app is gone from the proxy and no longer tracked.
    let snap = android
        .get_lmk_snapshot(Request::new(Empty {}))
        .await
        .unwrap()
        .into_inner();
    assert!(snap.tasks.is_empty(), "container task must be dropped");
    assert!(host.managed_ids().is_empty(), "managed set must clear");
}
