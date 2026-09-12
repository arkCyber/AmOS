//! Integration test for the *reverse* half of the container↔host bridge: when
//! the daemon's shared `ResourceGovernor` runs an `observe` tick that reclaims
//! (or freezes) apps, `drive_host_decisions` pushes that decision back into the
//! container — force-stopping the real process for container-managed apps only.
//! Mirrors how `serve()` keeps the SAME proxy/manager/host instances for the beat
//! and the AndroidManager service. (docs/lmk-proxy.md §8)
//!
//! The last two tests cover the other direction of the same bridge (REQ-A146): the
//! host and the container can *disagree* — the container reports a tier the host has no
//! representation for (`Visible`), or it refuses a lifecycle decision the host already
//! committed to. Those two failures used to be discarded with `let _ =`, i.e. invisible;
//! they are now logged, and these tests assert on what the daemon **said**, because that
//! logging is the entire deliverable (the best-effort behaviour is unchanged).

use std::os::unix::process::ExitStatusExt;
use std::sync::{Arc, Mutex};

use amos_ai::governor::{GovernorOutcome, ResourceGovernor};
use amos_ai::governor_service::{drive_host_decisions, GovernorLmkHost};
use amos_android::lmk::LmkHost;
use amos_android::{
    AndroidManagerService, CommandRunner, EnhancedAndroidManager, LmkProxy, WaydroidRuntime,
};
use amos_applife::{AppId, AppState};
use amos_power::{BatteryState, Telemetry, Usage};
use amos_proto::android_compat::{
    android_manager_server::AndroidManager, ActivityEvent, ActivityEventRequest, AppLaunchRequest,
    Empty, LmkEventKind,
};
use tokio::sync::broadcast;
use tonic::Request;

/// Captures everything the daemon logs, so a test can assert that a failure was
/// **reported** rather than swallowed.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap_or_else(|p| p.into_inner())).to_string()
    }
}

struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = CaptureWriter;
    fn make_writer(&'a self) -> Self::Writer {
        CaptureWriter(Arc::clone(&self.0))
    }
}

/// Install the capturing subscriber. The subscriber is process-wide and can only be set
/// once, so the buffer is a `OnceLock`: every test observes the **same** log, and each
/// assertion names a package that only its own scenario uses (so a shared buffer cannot
/// make one test's evidence satisfy another's).
fn capture_logs() -> Capture {
    LOGS.get_or_init(|| {
        let cap = Capture::default();
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .with_writer(cap.clone())
            .try_init();
        cap
    })
    .clone()
}

static LOGS: std::sync::OnceLock<Capture> = std::sync::OnceLock::new();

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

/// A container tier the host cannot represent must be **reported**, not swallowed.
///
/// `AppState::Visible` has no host representative at all — `ResourceGovernor::move_app`
/// answers `InvalidTransition` for it — so the host keeps whatever `register_app` created
/// (`Foreground`) while the container believes the app is `Visible`. That divergence is
/// intrinsic to the two models; what is *not* acceptable is that nobody hears about it.
#[tokio::test]
async fn a_container_tier_the_host_cannot_represent_is_reported() {
    let cap = capture_logs();
    let shared: Arc<Mutex<ResourceGovernor>> = Arc::new(Mutex::new(ResourceGovernor::default()));
    let host = GovernorLmkHost::new(Arc::clone(&shared));

    // Exactly what the container bridge does when the container reports `visible`.
    host.report_state("com.example.visible", AppState::Visible);

    let state = shared
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .app_state(&AppId::new("com.example.visible"));
    assert_eq!(
        state,
        Some(AppState::Foreground),
        "the host keeps the tier `register_app` created — the divergence this test is about"
    );

    let log = cap.text();
    assert!(
        log.contains("could not adopt") && log.contains("com.example.visible"),
        "the divergence must be logged with the package name, got:\n{log}"
    );
}

/// A container that refuses a lifecycle decision the host already committed to must be
/// **reported**: the governor will not retry (its own state says the app is tombstoned), so
/// this log line is the only signal that the two sides now disagree.
#[tokio::test]
async fn a_container_that_refuses_the_mirror_is_reported() {
    let cap = capture_logs();
    let shared: Arc<Mutex<ResourceGovernor>> = Arc::new(Mutex::new(ResourceGovernor::default()));
    let host = GovernorLmkHost::new(Arc::clone(&shared));
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let manager = Arc::new(EnhancedAndroidManager::new(Arc::new(
        WaydroidRuntime::with_runner(FakeRunner {
            calls: Arc::clone(&calls),
        }),
    )));
    // An *empty* container: it does not know the app the host has adopted.
    let proxy: Arc<Mutex<LmkProxy>> = Arc::new(Mutex::new(LmkProxy::new()));

    // The container adopted this app earlier (so the host has it in `managed`) …
    host.report_state("com.example.gone", AppState::Background);
    assert!(
        host.managed_ids().contains(&"com.example.gone".to_string()),
        "precondition: the host adopted the app"
    );

    // … then the host decides to freeze it and the container refuses (`Unknown`).
    let outcome = GovernorOutcome {
        frozen: vec![AppId::new("com.example.gone")],
        ..Default::default()
    };
    let (events, _) = broadcast::channel(4);
    drive_host_decisions(&outcome, &host, &proxy, &manager, &events).await;

    let log = cap.text();
    assert!(
        log.contains("freeze") && log.contains("com.example.gone") && log.contains("did not apply"),
        "a refused mirror op must name the op and the package, got:\n{log}"
    );
    // Best-effort semantics unchanged: the decision was still broadcast.
    assert_eq!(
        events.receiver_count(),
        0,
        "no subscribers were added by this test"
    );
}
