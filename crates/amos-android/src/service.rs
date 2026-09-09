//! gRPC `AndroidManager` service backed by an [`EnhancedAndroidManager`], which
//! wraps the underlying [`AndroidRuntime`] with operation timeouts and an LRU
//! icon cache so the Tauri core gets a robust, bounded-memory surface.

use std::pin::Pin;
use std::sync::{Arc, Mutex};

use amos_applife::AppState;
use amos_proto::android_compat::{
    android_manager_server::{AndroidManager, AndroidManagerServer},
    ActivityEvent, ActivityEventRequest, ActivityEventResponse, AppIconRequest, AppIconResponse,
    AppLaunchRequest, AppLaunchResponse, AppListResponse, Empty, HostAction as ProtoHostAction,
    HostActionRequest, LmkEvent, LmkEventKind, LmkRequest, LmkResponse, LmkSnapshot, LmkTask,
    LmkVictim, MemoryPressure as ProtoPressure,
};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status};

use crate::lmk::{
    host_state, ActivityState, HostAction, LmkError, LmkHost, LmkProxy, MemoryPressure, NoopLmkHost,
};
use crate::manager::EnhancedAndroidManager;
use crate::runtime::AndroidRuntime;

/// gRPC service exposing the Android-compat layer to the Tauri core.
///
/// All calls flow through [`EnhancedAndroidManager`], so every operation has a
/// configurable timeout and icon fetches are cached (LRU) rather than hitting
/// the container every time.
pub struct AndroidManagerService {
    manager: Arc<EnhancedAndroidManager>,
    /// The container Activity/Task lifecycle + LMK-proxy authority (shared so
    /// RPCs and the in-crate launch path drive the *same* instance).
    lmk: Arc<Mutex<LmkProxy>>,
    /// Host resource-governor bridge (no-op when not wired into a daemon).
    host: Arc<dyn LmkHost>,
    /// Broadcast of container LMK decisions (the `WatchLmk` fan-out). Best-effort:
    /// a slow/late subscriber just misses events and re-syncs via `GetLmkSnapshot`.
    events: broadcast::Sender<LmkEvent>,
}

/// Default capacity of the `WatchLmk` event broadcast.
const LMK_EVENT_BUFFER: usize = 128;

impl AndroidManagerService {
    /// A fresh best-effort LMK event channel.
    fn fresh_events() -> broadcast::Sender<LmkEvent> {
        broadcast::channel(LMK_EVENT_BUFFER).0
    }

    /// Build a service around an enhanced manager (timeouts + icon cache).
    pub fn with_manager(manager: Arc<EnhancedAndroidManager>) -> Self {
        Self::with_manager_and_host(manager, Arc::new(NoopLmkHost))
    }

    /// Build with an externally provided host governor bridge (see
    /// [`crate::lmk::LmkHost`]) — used by the daemon to keep the container and
    /// host registries coherent.
    pub fn with_manager_and_host(
        manager: Arc<EnhancedAndroidManager>,
        host: Arc<dyn LmkHost>,
    ) -> Self {
        Self {
            manager,
            lmk: Arc::new(Mutex::new(LmkProxy::new())),
            host,
            events: Self::fresh_events(),
        }
    }

    /// Build from explicitly shared parts — the manager, the LMK-proxy and the
    /// host bridge are all provided by the caller (the daemon), which keeps the
    /// *same* instances for its own governor beat to drive bidirectionally.
    pub fn with_parts(
        manager: Arc<EnhancedAndroidManager>,
        lmk: Arc<Mutex<LmkProxy>>,
        host: Arc<dyn LmkHost>,
    ) -> Self {
        Self::with_parts_and_events(manager, lmk, host, Self::fresh_events())
    }

    /// Build from explicitly shared parts **plus** a caller-owned LMK event
    /// channel (so the daemon's governor beat and the service share one `WatchLmk`
    /// fan-out — the beat feeds `RECLAIMED`/`FROZEN`/`THAWED` the same way).
    pub fn with_parts_and_events(
        manager: Arc<EnhancedAndroidManager>,
        lmk: Arc<Mutex<LmkProxy>>,
        host: Arc<dyn LmkHost>,
        events: broadcast::Sender<LmkEvent>,
    ) -> Self {
        Self {
            manager,
            lmk,
            host,
            events,
        }
    }

    /// A clone of the `WatchLmk` event sender (the daemon beat uses it too).
    pub fn events(&self) -> broadcast::Sender<LmkEvent> {
        self.events.clone()
    }

    /// Broadcast one LMK decision to every `WatchLmk` subscriber (best effort).
    fn emit_event(&self, package_name: &str, window_id: Option<String>, kind: LmkEventKind) {
        let _ = self.events.send(LmkEvent {
            package_name: package_name.to_string(),
            window_id: window_id.unwrap_or_default(),
            kind: kind as i32,
        });
    }

    /// The `window_id` currently bound to a task (for `WatchLmk` events).
    fn task_window(&self, package_name: &str) -> Option<String> {
        self.lmk
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .window_id(package_name)
    }

    /// Whether the proxy still tracks `package_name` (its task/surface is up).
    fn task_tracked(&self, package_name: &str) -> bool {
        self.lmk
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(package_name)
    }

    /// Apply a *host* governor decision back to the container (reverse half of
    /// the bridge): `Freeze`/`Thaw` mirror the container task tier; `Reclaim`
    /// force-stops the container process and drops the task. The **actual**
    /// resulting container state is then reflected back up to the host bridge
    /// (`report_host_state` / `report_host_killed`), so a host that drives the
    /// container over the wire (e.g. `ApplyHostDecision` RPC) without having
    /// acted on its own registry first stays in sync. Best effort — failures are
    /// logged upstream and never panic.
    pub async fn apply_host_action(&self, package_name: &str, action: HostAction) {
        match action {
            HostAction::Freeze => {
                let st = self
                    .lmk
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .freeze(package_name);
                // Report what actually happened (e.g. the container may refuse to
                // freeze a protected task → stays non-Cached on the host too).
                if let Ok(st) = st {
                    self.report_host_state(package_name, st);
                }
                self.emit_event(
                    package_name,
                    self.task_window(package_name),
                    LmkEventKind::Frozen,
                );
            }
            HostAction::Thaw => {
                let st = self
                    .lmk
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .thaw(package_name);
                if let Ok(st) = st {
                    self.report_host_state(package_name, st);
                }
                self.emit_event(
                    package_name,
                    self.task_window(package_name),
                    LmkEventKind::Thawed,
                );
            }
            HostAction::Reclaim => {
                let window = self.task_window(package_name);
                let _ = self.manager.force_stop_app(package_name).await;
                let _ = self
                    .lmk
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .destroy(package_name);
                self.report_host_killed(package_name);
                self.emit_event(package_name, window, LmkEventKind::Reclaimed);
            }
        }
    }

    /// Convenience: wrap a raw runtime in the default enhanced manager.
    pub fn with_runtime(runtime: Arc<dyn AndroidRuntime>) -> Self {
        Self::with_manager(Arc::new(EnhancedAndroidManager::new(runtime)))
    }

    /// Convenience with a host governor bridge (default enhanced manager).
    pub fn with_runtime_and_host(runtime: Arc<dyn AndroidRuntime>, host: Arc<dyn LmkHost>) -> Self {
        Self::with_manager_and_host(Arc::new(EnhancedAndroidManager::new(runtime)), host)
    }

    /// Report a container importance tier up to the host bridge (host-state
    /// mapped). A no-op when no bridge is installed.
    fn report_host_state(&self, package_name: &str, state: AppState) {
        self.host.report_state(package_name, host_state(state));
    }

    /// Report a container LMK kill up to the host bridge (no-op when unset).
    fn report_host_killed(&self, package_name: &str) {
        self.host.report_killed(package_name);
    }
}

#[tonic::async_trait]
impl AndroidManager for AndroidManagerService {
    type WatchLmkStream = Pin<Box<dyn Stream<Item = Result<LmkEvent, Status>> + Send + 'static>>;

    async fn launch_android_app(
        &self,
        request: Request<AppLaunchRequest>,
    ) -> Result<Response<AppLaunchResponse>, Status> {
        let package_name = request.into_inner().package_name;
        Ok(Response::new(
            match self.manager.launch_app(&package_name).await {
                Ok(window_id) => {
                    // Adopt the launched app into the LMK-proxy as a resumed task so
                    // its lifecycle is managed under AmOS control (not the container's
                    // silent lmkd), and reflect the new foreground tier up to the host
                    // governor bridge (if installed).
                    let state = self
                        .lmk
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .launch(&package_name, Some(window_id.clone()));
                    if let Ok(state) = state {
                        self.report_host_state(&package_name, state);
                    }
                    AppLaunchResponse {
                        success: true,
                        window_id,
                        error: String::new(),
                    }
                }
                Err(error) => AppLaunchResponse {
                    success: false,
                    window_id: String::new(),
                    error: error.to_string(),
                },
            },
        ))
    }

    async fn get_installed_apps(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<AppListResponse>, Status> {
        match self.manager.list_apps().await {
            Ok(apps) => Ok(Response::new(AppListResponse { apps })),
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn get_app_icon(
        &self,
        request: Request<AppIconRequest>,
    ) -> Result<Response<AppIconResponse>, Status> {
        let package_name = request.into_inner().package_name;
        Ok(Response::new(
            match self.manager.get_icon(&package_name).await {
                Ok(Some(png)) => AppIconResponse {
                    icon_png: png,
                    found: true,
                },
                // Icon not found / fetch timeout are non-fatal by design.
                Ok(None) | Err(_) => AppIconResponse {
                    icon_png: Vec::new(),
                    found: false,
                },
            },
        ))
    }

    async fn on_activity(
        &self,
        request: Request<ActivityEventRequest>,
    ) -> Result<Response<ActivityEventResponse>, Status> {
        let req = request.into_inner();
        let event = ActivityEvent::try_from(req.event)
            .map_err(|_| Status::invalid_argument("unknown activity event"))?;
        if event == ActivityEvent::Unspecified {
            return Err(Status::invalid_argument("unspecified activity event"));
        }
        // Capture the surface before a Destroy may tear the task down.
        let window = self.task_window(&req.package_name);
        let state = dispatch_activity(&self.lmk, &req.package_name, &req.activity_id, event)
            .map_err(|e| lmk_status(&e))?;
        // Reflect the container tier up to the host governor bridge (mapped:
        // container `Visible` → host `Foreground`).
        self.report_host_state(&req.package_name, state);
        // Emit `Destroyed` only when the task is actually gone (its last activity
        // finished). Under per-activity folding a sub-activity `Destroy` that
        // leaves siblings alive keeps the task + its `legacy` surface.
        if event == ActivityEvent::Destroy && !self.task_tracked(&req.package_name) {
            self.emit_event(&req.package_name, window, LmkEventKind::Destroyed);
        }
        Ok(Response::new(ActivityEventResponse {
            state_key: state.key().to_string(),
        }))
    }

    async fn get_lmk_snapshot(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<LmkSnapshot>, Status> {
        let p = self.lmk.lock().unwrap_or_else(|poison| poison.into_inner());
        let snap = p.snapshot();
        let (cached_count, background_count) = p.tier_counts();
        let tasks = snap
            .into_iter()
            .map(|t| LmkTask {
                package_name: t.package_name,
                window_id: t.window_id.unwrap_or_default(),
                state_key: t.state.key().to_string(),
            })
            .collect();
        Ok(Response::new(LmkSnapshot {
            tasks,
            cached_count: cached_count as u64,
            background_count: background_count as u64,
        }))
    }

    async fn trigger_lmk(
        &self,
        request: Request<LmkRequest>,
    ) -> Result<Response<LmkResponse>, Status> {
        let req = request.into_inner();
        let pressure = pressure_from_proto_i32(req.pressure)
            .ok_or_else(|| Status::invalid_argument("unspecified memory pressure"))?;
        let budget = usize::try_from(req.budget).unwrap_or(usize::MAX);

        // Decide + apply in the proxy, then drop the lock before the (potentially
        // blocking) container stop below so other lifecycle RPCs stay responsive.
        let decision = {
            let mut p = self.lmk.lock().unwrap_or_else(|poison| poison.into_inner());
            p.apply(pressure, budget)
        };

        // Physically kill every `Kill` victim in the container (`am force-stop`)
        // and mirror the round to the host governor bridge: a `Kill` drops the
        // app from the host (no saved state); a freeze keeps the surface but
        // moves it to the host `Cached` tombstone. All best effort.
        for victim in &decision.victims {
            match victim.action {
                crate::lmk::LmkAction::Kill => {
                    let _ = self.manager.force_stop_app(&victim.package_name).await;
                    self.report_host_killed(&victim.package_name);
                    self.emit_event(
                        &victim.package_name,
                        victim.window_id.clone(),
                        LmkEventKind::Reclaimed,
                    );
                }
                crate::lmk::LmkAction::Freeze => {
                    self.report_host_state(&victim.package_name, AppState::Cached);
                    self.emit_event(
                        &victim.package_name,
                        victim.window_id.clone(),
                        LmkEventKind::Frozen,
                    );
                }
            }
        }

        let victims = decision
            .victims
            .into_iter()
            .map(|v| LmkVictim {
                package_name: v.package_name,
                window_id: v.window_id.unwrap_or_default(),
                killed: v.action == crate::lmk::LmkAction::Kill,
            })
            .collect();
        Ok(Response::new(LmkResponse { victims }))
    }

    async fn apply_host_decision(
        &self,
        request: Request<HostActionRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        let action = host_action_from_proto_i32(req.action)
            .ok_or_else(|| Status::invalid_argument("unspecified host action"))?;
        // Reverse half of the bridge over the wire: apply the host decision to the
        // container (best effort; failures are logged, never fatal).
        self.apply_host_action(&req.package_name, action).await;
        Ok(Response::new(Empty {}))
    }

    async fn watch_lmk(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<Self::WatchLmkStream>, Status> {
        // Best-effort broadcast feed: a late/lagging subscriber just misses events
        // and re-syncs via GetLmkSnapshot. BroadcastStream ends the stream on a
        // lag/close (map to a terminal Status) so the client reconnects.
        let rx = self.events.subscribe();
        let stream = BroadcastStream::new(rx).map(|res| match res {
            Ok(evt) => Ok(evt),
            Err(_) => Err(Status::cancelled("lmk watch lagged or closed")),
        });
        Ok(Response::new(Box::pin(stream)))
    }
}

/// Map the wire `HostAction` (i32) to the domain level; `None` when `UNSPECIFIED`.
fn host_action_from_proto_i32(raw: i32) -> Option<HostAction> {
    match raw {
        v if v == ProtoHostAction::Freeze as i32 => Some(HostAction::Freeze),
        v if v == ProtoHostAction::Thaw as i32 => Some(HostAction::Thaw),
        v if v == ProtoHostAction::Reclaim as i32 => Some(HostAction::Reclaim),
        _ => None,
    }
}

/// Apply a container-observed Activity event to the shared LMK-proxy and return
/// the derived importance tier (rank ladder shared with `amos-applife` /
/// `governor.proto`). A `Destroy` of a task's last activity leaves no tracked
/// task, reported as `stopped` (saved-state retained → cheap relaunch).
///
/// `activity_id` selects the model:
/// - empty → **legacy whole-task** semantics (each event addresses the task; a
///   `Destroy` always tears it down), and untracked packages are self-healed
///   into the proxy (post-restart re-sync);
/// - non-empty → **per-activity folding**: the identity is recorded as alive on
///   Resume/Pause/Stop, and a `Destroy` only tears the task down when it is the
///   **last** live activity (finishing a stacked/sub activity keeps the app).
fn dispatch_activity(
    lmk: &Arc<Mutex<LmkProxy>>,
    package_name: &str,
    activity_id: &str,
    event: ActivityEvent,
) -> Result<AppState, LmkError> {
    let mut p = lmk.lock().unwrap_or_else(|poison| poison.into_inner());

    // Legacy whole-task model (System UI / no identity on the wire).
    if activity_id.is_empty() {
        return dispatch_whole_task(&mut p, package_name, event);
    }

    // Per-activity identity folding: importance is driven only by the *top*
    // activity; every non-destroyed activity keeps the task alive.
    match event {
        ActivityEvent::Resume => p.resume_activity(package_name, activity_id),
        ActivityEvent::Pause => p.pause_activity(package_name, activity_id),
        ActivityEvent::Stop => p.stop_activity(package_name, activity_id),
        ActivityEvent::Started => p.start_activity(package_name, activity_id),
        ActivityEvent::Destroy => match p.destroy_last(package_name, activity_id)? {
            Some(state) => Ok(state),      // other activities remain — task survives
            None => Ok(AppState::Stopped), // last activity gone
        },
        ActivityEvent::Unspecified => Err(LmkError::Unknown("unspecified event".to_string())),
    }
}

/// The legacy whole-task interpretation of an activity event (no identity). The
/// container feed is the authoritative source: an event for a package this proxy
/// doesn't yet track (daemon restart wiped the registry, or an app surfaced from
/// inside the container / a notification) **self-heals** it at the minimal tier
/// the event implies; a `Destroy` always tears the (whole) task down.
fn dispatch_whole_task(
    p: &mut LmkProxy,
    package_name: &str,
    event: ActivityEvent,
) -> Result<AppState, LmkError> {
    match event {
        ActivityEvent::Resume => {
            if p.contains(package_name) {
                p.resume(package_name)
            } else {
                Ok(p.adopt(package_name, ActivityState::Resumed)) // foreground
            }
        }
        ActivityEvent::Pause => {
            if p.contains(package_name) {
                p.pause(package_name)
            } else {
                Ok(p.adopt(package_name, ActivityState::Paused)) // visible, protected
            }
        }
        ActivityEvent::Stop => {
            if p.contains(package_name) {
                p.stop(package_name)
            } else {
                Ok(p.adopt(package_name, ActivityState::Stopped)) // background
            }
        }
        ActivityEvent::Destroy => {
            if p.contains(package_name) {
                p.destroy(package_name)?;
            }
            // Whether or not we tracked it, the task is gone → benign `stopped`
            // (saved-state retained → cheap relaunch), never a hard error.
            Ok(AppState::Stopped)
        }
        // Whole-task mode has no per-activity identity, so a bare `Started` is
        // either a first observation (self-heal to visible) or a no-op when the
        // task is already tracked.
        ActivityEvent::Started => {
            if p.contains(package_name) {
                p.importance(package_name)
            } else {
                Ok(p.adopt(package_name, ActivityState::Started)) // visible
            }
        }
        ActivityEvent::Unspecified => Err(LmkError::Unknown("unspecified event".to_string())),
    }
}

/// Map the wire `MemoryPressure` (i32) to the domain level; `None` when the
/// value is `UNSPECIFIED` / out of range.
fn pressure_from_proto_i32(raw: i32) -> Option<MemoryPressure> {
    match raw {
        v if v == ProtoPressure::None as i32 => Some(MemoryPressure::None),
        v if v == ProtoPressure::Low as i32 => Some(MemoryPressure::Low),
        v if v == ProtoPressure::Critical as i32 => Some(MemoryPressure::Critical),
        _ => None,
    }
}

/// Convert a lifecycle error into a tonic `Status`.
fn lmk_status(e: &LmkError) -> Status {
    match e {
        LmkError::Unknown(pkg) => Status::not_found(format!("no such running task: {pkg}")),
    }
}

/// Convenience for wiring the service into a tonic server. Wraps the runtime in
/// the default enhanced manager so timeouts + caching apply automatically.
pub fn server(runtime: Arc<dyn AndroidRuntime>) -> AndroidManagerServer<AndroidManagerService> {
    AndroidManagerServer::new(AndroidManagerService::with_runtime(runtime))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::DemoRuntime;
    use std::sync::Mutex;

    /// Records every host-bridge call so a test can assert what the service
    /// reported up to the (daemon) resource governor.
    #[derive(Clone, Default)]
    struct RecordingHost {
        log: Arc<Mutex<Vec<String>>>,
    }
    impl LmkHost for RecordingHost {
        fn report_state(&self, package_name: &str, state: AppState) {
            self.log
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("state:{package_name}={}", state.key()));
        }
        fn report_killed(&self, package_name: &str) {
            self.log
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("kill:{package_name}"));
        }
    }
    impl RecordingHost {
        fn joined(&self) -> String {
            self.log
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .join("\n")
        }
    }

    #[tokio::test]
    async fn get_installed_apps_returns_curated_list() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        let reply = svc
            .get_installed_apps(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(reply.apps.len(), 4);
        assert_eq!(reply.apps[0].package_name, "com.tencent.mm");
    }

    #[tokio::test]
    async fn launch_returns_window_id() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        let reply = svc
            .launch_android_app(Request::new(AppLaunchRequest {
                package_name: "com.tencent.mm".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(reply.success);
        assert_eq!(reply.window_id, "waydroid_demo_com.tencent.mm");
    }

    #[tokio::test]
    async fn get_app_icon_returns_png_and_caches() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        let reply = svc
            .get_app_icon(Request::new(AppIconRequest {
                package_name: "com.tencent.mm".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(reply.found);
        assert_eq!(
            &reply.icon_png[..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );

        // Second call hits the LRU cache (no runtime round-trip).
        let stats = svc.manager.cache_stats().await;
        assert_eq!(stats.entries, 1, "icon cached after first fetch");
        assert_eq!(stats.total_accesses, 1, "first access counted");
        let again = svc
            .get_app_icon(Request::new(AppIconRequest {
                package_name: "com.tencent.mm".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(again.found);
        let stats2 = svc.manager.cache_stats().await;
        assert_eq!(stats2.total_accesses, 2, "cache hit bumps access count");
    }

    #[tokio::test]
    async fn launch_adopts_app_then_activity_tracks_importance() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        // Launching registers the app as a resumed (foreground) task.
        svc.launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();

        // The app loses focus but stays visible -> visible tier.
        let pause = svc
            .on_activity(Request::new(ActivityEventRequest {
                package_name: "com.tencent.mm".into(),
                event: ActivityEvent::Pause as i32,
                activity_id: String::new(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(pause.state_key, "visible");

        // Hidden -> background tier.
        let stop = svc
            .on_activity(Request::new(ActivityEventRequest {
                package_name: "com.tencent.mm".into(),
                event: ActivityEvent::Stop as i32,
                activity_id: String::new(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(stop.state_key, "background");

        // Snapshot reflects the single tracked task.
        let snap = svc
            .get_lmk_snapshot(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(snap.tasks.len(), 1);
        assert_eq!(snap.tasks[0].package_name, "com.tencent.mm");
        assert_eq!(snap.tasks[0].state_key, "background");
        assert_eq!(snap.background_count, 1);
    }

    #[tokio::test]
    async fn trigger_lmk_critical_reclaims_background_app() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        svc.launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();
        svc.on_activity(Request::new(ActivityEventRequest {
            package_name: "com.tencent.mm".into(),
            event: ActivityEvent::Stop as i32,
            activity_id: String::new(),
        }))
        .await
        .unwrap();

        let reply = svc
            .trigger_lmk(Request::new(LmkRequest {
                pressure: ProtoPressure::Critical as i32,
                budget: 10,
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(reply.victims.len(), 1);
        assert_eq!(reply.victims[0].package_name, "com.tencent.mm");
        assert!(
            reply.victims[0].killed,
            "critical reclaim kills the process"
        );
        assert_eq!(reply.victims[0].window_id, "waydroid_demo_com.tencent.mm");

        // The task is gone from the snapshot.
        let snap = svc
            .get_lmk_snapshot(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert!(snap.tasks.is_empty());
    }

    #[tokio::test]
    async fn trigger_lmk_low_freezes_not_kills() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        svc.launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();
        svc.on_activity(Request::new(ActivityEventRequest {
            package_name: "com.tencent.mm".into(),
            event: ActivityEvent::Stop as i32,
            activity_id: String::new(),
        }))
        .await
        .unwrap();

        let reply = svc
            .trigger_lmk(Request::new(LmkRequest {
                pressure: ProtoPressure::Low as i32,
                budget: 10,
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(reply.victims.len(), 1);
        assert!(!reply.victims[0].killed, "low pressure freezes, not kills");

        // Frozen -> cached, still tracked.
        let snap = svc
            .get_lmk_snapshot(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(snap.tasks.len(), 1);
        assert_eq!(snap.tasks[0].state_key, "cached");
        assert_eq!(snap.cached_count, 1);
    }

    #[tokio::test]
    async fn trigger_lmk_rejects_unspecified_pressure() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        let err = svc
            .trigger_lmk(Request::new(LmkRequest {
                pressure: ProtoPressure::Unspecified as i32,
                budget: 1,
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn on_activity_rejects_unspecified_event() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        let err = svc
            .on_activity(Request::new(ActivityEventRequest {
                package_name: "com.tencent.mm".into(),
                event: ActivityEvent::Unspecified as i32,
                activity_id: String::new(),
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn host_bridge_reports_launch_importance_and_kill() {
        let host = RecordingHost::default();
        let svc = AndroidManagerService::with_runtime_and_host(
            Arc::new(DemoRuntime::new()),
            Arc::new(host.clone()),
        );

        // Launch -> host foreground.
        svc.launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();
        // Hidden -> host background.
        svc.on_activity(Request::new(ActivityEventRequest {
            package_name: "com.tencent.mm".into(),
            event: ActivityEvent::Stop as i32,
            activity_id: String::new(),
        }))
        .await
        .unwrap();
        // Critical reclaim kills it -> host drop.
        svc.trigger_lmk(Request::new(LmkRequest {
            pressure: ProtoPressure::Critical as i32,
            budget: 10,
        }))
        .await
        .unwrap();

        let log = host.joined();
        assert!(
            log.contains("state:com.tencent.mm=foreground"),
            "got:\n{log}"
        );
        assert!(
            log.contains("state:com.tencent.mm=background"),
            "got:\n{log}"
        );
        assert!(log.contains("kill:com.tencent.mm"), "got:\n{log}");
    }

    #[tokio::test]
    async fn host_bridge_maps_visible_to_foreground() {
        let host = RecordingHost::default();
        let svc = AndroidManagerService::with_runtime_and_host(
            Arc::new(DemoRuntime::new()),
            Arc::new(host.clone()),
        );
        svc.launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();
        // Container top Activity pauses (still visible); the host cannot hold a
        // settable `Visible`, so it must be reported as foreground (protected).
        svc.on_activity(Request::new(ActivityEventRequest {
            package_name: "com.tencent.mm".into(),
            event: ActivityEvent::Pause as i32,
            activity_id: String::new(),
        }))
        .await
        .unwrap();

        let log = host.joined();
        assert!(
            !log.contains("=visible"),
            "host must never see visible:\n{log}"
        );
        assert!(
            log.contains("state:com.tencent.mm=foreground"),
            "got:\n{log}"
        );
    }

    #[tokio::test]
    async fn host_reclaim_drops_the_container_task() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        svc.launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();
        let before = svc
            .get_lmk_snapshot(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(before.tasks.len(), 1, "task present before host reclaim");

        // A host governor reclaim decision drives the reverse half of the bridge:
        // force-stop the container process and drop the task from the proxy.
        svc.apply_host_action("com.tencent.mm", HostAction::Reclaim)
            .await;

        let snap = svc
            .get_lmk_snapshot(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert!(snap.tasks.is_empty(), "host reclaim must drop the task");
    }

    #[tokio::test]
    async fn apply_host_decision_rpc_reclaims_drops_task() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        svc.launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();

        // A host decision pushed over the wire drives the reverse half.
        svc.apply_host_decision(Request::new(HostActionRequest {
            package_name: "com.tencent.mm".into(),
            action: ProtoHostAction::Reclaim as i32,
        }))
        .await
        .unwrap();

        let snap = svc
            .get_lmk_snapshot(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert!(
            snap.tasks.is_empty(),
            "host reclaim via RPC must drop the task"
        );
    }

    #[tokio::test]
    async fn apply_host_decision_reclaim_reports_killed_to_host() {
        let host = RecordingHost::default();
        let svc = AndroidManagerService::with_runtime_and_host(
            Arc::new(DemoRuntime::new()),
            Arc::new(host.clone()),
        );
        svc.launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();
        // After host claims to have reclaimed it, the container is force-stopped;
        // reflect the drop back up so a host that had NOT yet acted stays in sync.
        svc.apply_host_decision(Request::new(HostActionRequest {
            package_name: "com.tencent.mm".into(),
            action: ProtoHostAction::Reclaim as i32,
        }))
        .await
        .unwrap();

        let log = host.joined();
        assert!(log.contains("kill:com.tencent.mm"), "got:\n{log}");
        let snap = svc
            .get_lmk_snapshot(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert!(snap.tasks.is_empty());
    }

    #[tokio::test]
    async fn apply_host_decision_freeze_reports_actual_state_not_cached_for_protected() {
        let host = RecordingHost::default();
        let svc = AndroidManagerService::with_runtime_and_host(
            Arc::new(DemoRuntime::new()),
            Arc::new(host.clone()),
        );
        svc.launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();

        // Freeze on a foreground (protected) task is a no-op in the proxy, so the
        // host must NOT be told it became Cached.
        svc.apply_host_decision(Request::new(HostActionRequest {
            package_name: "com.tencent.mm".into(),
            action: ProtoHostAction::Freeze as i32,
        }))
        .await
        .unwrap();
        let log = host.joined();
        assert!(
            !log.contains("=cached"),
            "protected task not frozen:\n{log}"
        );

        // Hide it (background) then freeze → actually Cached, reported up.
        svc.on_activity(Request::new(ActivityEventRequest {
            package_name: "com.tencent.mm".into(),
            event: ActivityEvent::Stop as i32,
            activity_id: String::new(),
        }))
        .await
        .unwrap();
        svc.apply_host_decision(Request::new(HostActionRequest {
            package_name: "com.tencent.mm".into(),
            action: ProtoHostAction::Freeze as i32,
        }))
        .await
        .unwrap();
        let log2 = host.joined();
        assert!(
            log2.contains("=cached"),
            "background task frozen to cached:\n{log2}"
        );
    }

    #[tokio::test]
    async fn apply_host_decision_rejects_unspecified_action() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        let err = svc
            .apply_host_decision(Request::new(HostActionRequest {
                package_name: "com.tencent.mm".into(),
                action: ProtoHostAction::Unspecified as i32,
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn watch_lmk_streams_reclaimed_event() {
        use std::time::Duration;
        use tokio_stream::StreamExt;

        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        svc.launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();
        // Hide it, then reclaim under critical pressure.
        svc.on_activity(Request::new(ActivityEventRequest {
            package_name: "com.tencent.mm".into(),
            event: ActivityEvent::Stop as i32,
            activity_id: String::new(),
        }))
        .await
        .unwrap();

        // Subscribe before the decision so the event is delivered to this stream.
        let mut stream = svc
            .watch_lmk(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        svc.trigger_lmk(Request::new(LmkRequest {
            pressure: ProtoPressure::Critical as i32,
            budget: 10,
        }))
        .await
        .unwrap();

        let evt = tokio::time::timeout(Duration::from_millis(500), stream.next())
            .await
            .expect("timed out waiting for lmk event")
            .expect("stream ended")
            .expect("event must not be an error");
        assert_eq!(evt.kind, LmkEventKind::Reclaimed as i32);
        assert_eq!(evt.package_name, "com.tencent.mm");
        assert_eq!(evt.window_id, "waydroid_demo_com.tencent.mm");
    }

    #[test]
    fn resume_for_untracked_package_adopts_it_as_foreground() {
        let lmk = std::sync::Arc::new(std::sync::Mutex::new(LmkProxy::new()));

        // An app this proxy never launched (daemon restart / foregrounded from
        // inside the container) comes to the foreground: it must be adopted as a
        // tracked, protected foreground task — not rejected with an Unknown error.
        let state = dispatch_activity(&lmk, "com.tencent.mm", "", ActivityEvent::Resume).unwrap();
        assert_eq!(state, AppState::Foreground);

        let snap = lmk.lock().unwrap().snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].package_name, "com.tencent.mm");
        assert_eq!(snap[0].state, AppState::Foreground);

        // A second Resume on the now-tracked task is a plain resume, no duplicate.
        let again = dispatch_activity(&lmk, "com.tencent.mm", "", ActivityEvent::Resume).unwrap();
        assert_eq!(again, AppState::Foreground);
        assert_eq!(lmk.lock().unwrap().len(), 1);
    }

    #[test]
    fn pause_stop_destroy_self_heal_untracked_packages() {
        let lmk = std::sync::Arc::new(std::sync::Mutex::new(LmkProxy::new()));

        // Stop for an untracked package: it exists but is hidden → adopt Background.
        let bg = dispatch_activity(&lmk, "com.tencent.mm", "", ActivityEvent::Stop).unwrap();
        assert_eq!(bg, AppState::Background);

        // Pause for a (different) untracked package: still visible → adopt Visible.
        let vs = dispatch_activity(&lmk, "com.taobao.taobao", "", ActivityEvent::Pause).unwrap();
        assert_eq!(vs, AppState::Visible);
        let snap = lmk.lock().unwrap().snapshot();
        assert_eq!(snap.len(), 2);
        let tb = snap
            .iter()
            .find(|t| t.package_name == "com.taobao.taobao")
            .unwrap();
        assert_eq!(tb.activity, ActivityState::Paused);
        assert_eq!(tb.state, AppState::Visible);
        let mm = snap
            .iter()
            .find(|t| t.package_name == "com.tencent.mm")
            .unwrap();
        assert_eq!(mm.state, AppState::Background);

        // Destroy of a package we never saw is a benign no-op (gone), not an error.
        assert_eq!(
            dispatch_activity(&lmk, "com.never.seen", "", ActivityEvent::Destroy).unwrap(),
            AppState::Stopped
        );

        // A Destroy of the adopted Background task removes it cleanly.
        assert!(dispatch_activity(&lmk, "com.tencent.mm", "", ActivityEvent::Destroy).is_ok());
        assert_eq!(lmk.lock().unwrap().len(), 1); // only the Visible task remains
    }

    #[test]
    fn per_activity_folding_keeps_task_until_the_last_activity_dies() {
        let lmk = std::sync::Arc::new(std::sync::Mutex::new(LmkProxy::new()));

        // Two stacked activities in one task, both alive (identity-folding path).
        let first = dispatch_activity(&lmk, "com.app", "act:A", ActivityEvent::Resume).unwrap();
        assert_eq!(first, AppState::Foreground);
        let second = dispatch_activity(&lmk, "com.app", "act:B", ActivityEvent::Resume).unwrap();
        assert_eq!(second, AppState::Foreground);
        assert_eq!(lmk.lock().unwrap().len(), 1, "one task for the package");

        // A re-resume of the SAME identity must not double-count it.
        let _ = dispatch_activity(&lmk, "com.app", "act:A", ActivityEvent::Resume).unwrap();
        assert_eq!(lmk.lock().unwrap().len(), 1);

        // Finishing the top activity (B) leaves A alive → the task + surface stay.
        let after_top =
            dispatch_activity(&lmk, "com.app", "act:B", ActivityEvent::Destroy).unwrap();
        assert_eq!(after_top, AppState::Foreground, "A is still resumed");
        assert_eq!(
            lmk.lock().unwrap().len(),
            1,
            "sub-activity finish keeps the app"
        );

        // Destroying the LAST live activity (A) tears the whole task down.
        let last = dispatch_activity(&lmk, "com.app", "act:A", ActivityEvent::Destroy).unwrap();
        assert_eq!(last, AppState::Stopped);
        assert!(lmk.lock().unwrap().is_empty());
    }

    #[test]
    fn stopped_sibling_neither_demotes_top_nor_prematurely_kills_the_task() {
        let lmk = std::sync::Arc::new(std::sync::Mutex::new(LmkProxy::new()));
        let pkg = "com.app";

        // A foreground top activity.
        assert_eq!(
            dispatch_activity(&lmk, pkg, "act:A", ActivityEvent::Resume).unwrap(),
            AppState::Foreground
        );
        // B enters (Started: liveness only) then becomes the resumed top.
        let _ = dispatch_activity(&lmk, pkg, "act:B", ActivityEvent::Started).unwrap();
        assert_eq!(
            dispatch_activity(&lmk, pkg, "act:B", ActivityEvent::Resume).unwrap(),
            AppState::Foreground
        );
        // A is now a *stopped sibling* below B. A real adapter sends its onStop,
        // but that must NOT demote the package (B is still foreground).
        let st = dispatch_activity(&lmk, pkg, "act:A", ActivityEvent::Stop).unwrap();
        assert_eq!(
            st,
            AppState::Foreground,
            "stopping a non-top sibling must not demote the resumed top"
        );

        // B (the top) finishes → the stopped sibling A is still alive, so the task
        // + surface survive (demoted to a visible placeholder, never torn down).
        let after_b = dispatch_activity(&lmk, pkg, "act:B", ActivityEvent::Destroy).unwrap();
        assert_eq!(after_b, AppState::Visible, "A is still alive");
        assert_eq!(lmk.lock().unwrap().len(), 1);

        // A comes back to the foreground, then finishes → last activity gone.
        assert_eq!(
            dispatch_activity(&lmk, pkg, "act:A", ActivityEvent::Resume).unwrap(),
            AppState::Foreground
        );
        let last = dispatch_activity(&lmk, pkg, "act:A", ActivityEvent::Destroy).unwrap();
        assert_eq!(last, AppState::Stopped);
        assert!(lmk.lock().unwrap().is_empty());
    }
}
