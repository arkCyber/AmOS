//! gRPC `Governor` service exposing the daemon's [`ResourceGovernor`] closed loop
//! over the shared UDS (proto `amos_governor`, `proto/governor.proto`).
//!
//! Mirrors the `amos-sensor`/`amos-telephony` service pattern: the service holds a
//! shared `Arc<Mutex<ResourceGovernor>>` (the *same* instance the periodic beat in
//! `serve()` ticks) and maps tonic RPCs onto the domain core — so a System UI /
//! per-app process host can register apps & jobs and move apps through their
//! lifecycle, while the daemon keeps deciding over them. See
//! `docs/device-bring-up.md` §4.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use amos_android::lmk::{LmkHost, LmkProxy};
use amos_android::manager::EnhancedAndroidManager;
use amos_applife::{AppId, AppState};
use amos_proto::amos_governor::{
    governor_server::{Governor, GovernorServer},
    AppInfo, AppRef, AppState as ProtoState, Empty, GovernorDecision, GovernorState, JobInfo,
    JobRef, JobType as ProtoJobType, MoveAppRequest, ScheduleJobRequest,
};
use amos_proto::android_compat::{LmkEvent, LmkEventKind};
use amos_scheduler::ScheduledJob;
use tokio::sync::broadcast;
use tonic::{Request, Response, Status};

use crate::governor::{GovernorOutcome, ResourceGovernor};

/// Broadcast one container LMK decision on the shared `WatchLmk` channel.
fn emit_lmk(
    events: &broadcast::Sender<LmkEvent>,
    package: &str,
    window: Option<String>,
    kind: LmkEventKind,
) {
    let _ = events.send(LmkEvent {
        package_name: package.to_string(),
        window_id: window.unwrap_or_default(),
        kind: kind as i32,
    });
}

/// The host-side half of the container↔host LMK bridge: an [`LmkHost`] that
/// reflects container `LmkProxy` importance/kills into the **same shared
/// [`ResourceGovernor`]** the daemon's periodic beat and the `Governor` gRPC
/// service drive. Keeps the container registry and the host closed loop in one
/// coherent view — a container `Kill` drops the app from the host; a container
/// tier change `register_app`/`move_app`s it (no-op when unchanged).
///
/// It also tracks *which* host apps are container-managed (the package set it
/// registered), so the reverse half of the bridge ([`drive_host_decisions`])
/// only touches real container apps when the daemon reclaims/freezes them.
pub struct GovernorLmkHost {
    /// The shared resource governor (same instance the daemon beat + service use).
    pub governor: Arc<Mutex<ResourceGovernor>>,
    /// Package names this host has adopted from the container proxy.
    managed: Arc<Mutex<HashSet<String>>>,
}

impl GovernorLmkHost {
    pub fn new(governor: Arc<Mutex<ResourceGovernor>>) -> Self {
        Self {
            governor,
            managed: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Package names currently adopted from the container (for reverse driving).
    pub fn managed_ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .managed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .cloned()
            .collect();
        v.sort();
        v
    }
}

impl LmkHost for GovernorLmkHost {
    fn report_state(&self, package_name: &str, state: AppState) {
        let id = AppId::new(package_name);
        let mut g = self.governor.lock().unwrap_or_else(|p| p.into_inner());
        if g.app_state(&id) == Some(state) {
            return; // no-op de-dupe (avoids inflating the LRU recency).
        }
        if g.app_state(&id).is_none() {
            // register creates at Foreground; subsequent move lands the target tier.
            if let Err(e) = g.register_app(id.clone()) {
                // The container already believes this app exists. If the host refuses it,
                // the two registries diverge for the rest of the session (the daemon will
                // not manage an app it never admitted), so say so instead of discarding.
                tracing::warn!(
                    package = package_name,
                    error = %e,
                    "container reported an app the host governor refused to register; \
                     host and container state now diverge"
                );
                return;
            }
            self.managed
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(package_name.to_string());
        }
        if let Err(e) = g.move_app(id, state) {
            // Not every container tier has a host representative — `Visible` has no
            // `AppState` at all, and a transition the lifecycle rejects (e.g. a
            // `Stopped` app being moved straight to `Foreground`) fails here. The host
            // keeps its previous tier, which is *not* what the container just reported,
            // so the divergence is logged rather than swallowed (REQ-A146).
            tracing::warn!(
                package = package_name,
                reported = ?state,
                error = %e,
                "host governor could not adopt the container's reported tier; \
                 the host keeps its previous state for this app"
            );
        }
    }

    fn report_killed(&self, package_name: &str) {
        let id = AppId::new(package_name);
        let mut g = self.governor.lock().unwrap_or_else(|p| p.into_inner());
        g.kill_app(&id);
        self.managed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(package_name);
    }
}

/// Log one failed container mirror op: the host decided something and the container did
/// not follow, so the two sides no longer agree (REQ-A146). Best-effort semantics are
/// unchanged — this only makes the divergence visible instead of silent.
fn mirror_failed(op: &str, package: &str, err: &dyn std::fmt::Display) {
    tracing::warn!(
        op,
        package,
        error = %err,
        "the container did not apply the host's lifecycle decision; \
         host and container state now diverge"
    );
}

/// The reverse half of the container↔host bridge: after the daemon's shared
/// `ResourceGovernor` has run one `observe` tick (freeze/thaw/reclaim on its own
/// registry), drive those decisions **back into the container** so the two sides
/// stay coherent. Only apps this host adopted from the container (`host.managed`)
/// are touched; a `reclaim` force-stops the container process and drops the
/// task, while `frozen`/`thawed` mirror the container tier. Best effort — but a
/// failure is reported (`mirror_failed`), never swallowed.
pub async fn drive_host_decisions(
    outcome: &GovernorOutcome,
    host: &GovernorLmkHost,
    proxy: &Arc<Mutex<LmkProxy>>,
    manager: &Arc<EnhancedAndroidManager>,
    events: &broadcast::Sender<LmkEvent>,
) {
    // Snapshot the container-managed set once (cheap O(n)) instead of cloning it
    // per id; a reclaimed app is also dropped from the live set below.
    let managed: HashSet<String> = host.managed_ids().into_iter().collect();
    for id in outcome.reclaimed.iter().chain(outcome.frozen.iter()) {
        if !managed.contains(&id.0) {
            continue;
        }
        if outcome.reclaimed.contains(id) {
            // Host killed it (no saved state) → real container force-stop and stop
            // tracking it as a managed container app.
            let window = proxy
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .window_id(&id.0);
            let stopped = manager.force_stop_app(&id.0).await;
            if let Err(e) = stopped {
                mirror_failed("force_stop_app", &id.0, &e);
            }
            let destroyed = proxy
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .destroy(&id.0);
            if let Err(e) = destroyed {
                mirror_failed("destroy", &id.0, &e);
            }
            host.managed
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id.0);
            emit_lmk(events, &id.0, window, LmkEventKind::Reclaimed);
        } else {
            // Host froze it to Cached → mirror the container tier.
            let window = proxy
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .window_id(&id.0);
            let frozen = proxy
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .freeze(&id.0);
            if let Err(e) = frozen {
                // The host now believes the app is tombstoned while the container keeps
                // running it — the governor will not retry (its own state says Cached),
                // so this is the only chance to say so.
                mirror_failed("freeze", &id.0, &e);
            }
            emit_lmk(events, &id.0, window, LmkEventKind::Frozen);
        }
    }
    for id in &outcome.thawed {
        if managed.contains(&id.0) {
            let window = proxy
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .window_id(&id.0);
            let thawed = proxy.lock().unwrap_or_else(|p| p.into_inner()).thaw(&id.0);
            if let Err(e) = thawed {
                mirror_failed("thaw", &id.0, &e);
            }
            emit_lmk(events, &id.0, window, LmkEventKind::Thawed);
        }
    }
}

/// gRPC service wiring the resource governor to the wire contract.
pub struct GovernorService {
    /// Shared with the daemon's periodic beat so RPC registration feeds the same
    /// closed loop that decides each cadence.
    governor: Arc<Mutex<ResourceGovernor>>,
}

impl GovernorService {
    pub fn new(governor: Arc<Mutex<ResourceGovernor>>) -> Self {
        Self { governor }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ResourceGovernor> {
        self.governor.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// A ready-to-mount [`GovernorServer`] around a shared governor.
pub fn server(governor: Arc<Mutex<ResourceGovernor>>) -> GovernorServer<GovernorService> {
    GovernorServer::new(GovernorService::new(governor))
}

#[tonic::async_trait]
impl Governor for GovernorService {
    async fn register_app(&self, request: Request<AppRef>) -> Result<Response<Empty>, Status> {
        let app_id = request.into_inner().app_id;
        self.lock()
            .register_app(AppId::new(app_id))
            .map_err(lifecycle_status)?;
        Ok(Response::new(Empty {}))
    }

    async fn move_app(&self, request: Request<MoveAppRequest>) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        let target = app_state_from_proto_i32(req.to)
            .ok_or_else(|| Status::invalid_argument("unspecified/unsupported target app state"))?;
        self.lock()
            .move_app(AppId::new(req.app_id), target)
            .map_err(lifecycle_status)?;
        Ok(Response::new(Empty {}))
    }

    async fn unregister_app(&self, request: Request<AppRef>) -> Result<Response<Empty>, Status> {
        let app_id = AppId::new(request.into_inner().app_id);
        let mut g = self.lock();
        if !g.kill_app(&app_id) {
            return Err(Status::not_found(format!("no such app: {app_id}")));
        }
        Ok(Response::new(Empty {}))
    }

    async fn schedule_job(
        &self,
        request: Request<ScheduleJobRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        let job_type = job_type_from_proto_i32(req.job_type)
            .ok_or_else(|| Status::invalid_argument("unspecified job type"))?;
        let job = ScheduledJob::new(
            amos_scheduler::JobId::new(req.job_id),
            job_type,
            req.earliest,
            req.latest,
        )
        .map_err(|e| Status::invalid_argument(e.to_string()))?;
        self.lock()
            .schedule(job)
            .map_err(|e| Status::invalid_argument(e.to_string()))?;
        Ok(Response::new(Empty {}))
    }

    async fn cancel_job(&self, request: Request<JobRef>) -> Result<Response<Empty>, Status> {
        let job_id = amos_scheduler::JobId::new(request.into_inner().job_id);
        let mut g = self.lock();
        if !g.cancel_job(&job_id) {
            return Err(Status::not_found(format!("no such job: {job_id}")));
        }
        Ok(Response::new(Empty {}))
    }

    async fn get_state(&self, _request: Request<Empty>) -> Result<Response<GovernorState>, Status> {
        let g = self.lock();
        let apps = g
            .app_entries()
            .into_iter()
            .map(|(id, state)| AppInfo {
                app_id: id.to_string(),
                state: proto_app_state(state) as i32,
            })
            .collect();
        let jobs = g
            .job_entries()
            .into_iter()
            .map(|(id, ty, earliest, latest)| JobInfo {
                job_id: id.to_string(),
                job_type: proto_job_type(ty) as i32,
                earliest,
                latest,
            })
            .collect();
        let background_count = g
            .app_entries()
            .into_iter()
            .filter(|(_, s)| *s == amos_applife::AppState::Background)
            .count() as u64;
        // The governor's most recent decision (ticks == 0 ⇒ it has not run yet).
        let decision = match g.last_decision() {
            Some(o) => GovernorDecision {
                sensor_mode: o.sensor_mode.to_string(),
                reason: o.reason.to_string(),
                cap_inference: o.cap_inference,
                throttle_background: o.throttle_background,
                ticks: g.ticks(),
            },
            None => GovernorDecision {
                sensor_mode: "balanced".to_string(),
                reason: "pending".to_string(),
                cap_inference: false,
                throttle_background: false,
                ticks: 0,
            },
        };
        Ok(Response::new(GovernorState {
            apps,
            jobs,
            background_count,
            decision: Some(decision),
        }))
    }
}

// ---- proto ↔ domain mapping -------------------------------------------------

/// Map a domain [`amos_applife::AppState`] to the wire enum. `Visible` has no wire
/// variant (it is derived, not settable) so it maps to "unspecified".
fn proto_app_state(s: amos_applife::AppState) -> ProtoState {
    use amos_applife::AppState as S;
    match s {
        S::Foreground => ProtoState::Foreground,
        S::Background => ProtoState::Background,
        S::Cached => ProtoState::Cached,
        S::ForegroundService => ProtoState::ForegroundService,
        S::Stopped => ProtoState::Stopped,
        S::Visible => ProtoState::Unspecified,
    }
}

/// Parse a wire `i32` target state into a domain state. `UNSPECIFIED`/unknown → `None`.
fn app_state_from_proto_i32(v: i32) -> Option<amos_applife::AppState> {
    use amos_applife::AppState as S;
    match ProtoState::try_from(v).ok()? {
        ProtoState::Foreground => Some(S::Foreground),
        ProtoState::Background => Some(S::Background),
        ProtoState::Cached => Some(S::Cached),
        ProtoState::ForegroundService => Some(S::ForegroundService),
        ProtoState::Stopped => Some(S::Stopped),
        ProtoState::Unspecified => None,
    }
}

fn proto_job_type(t: amos_scheduler::JobType) -> ProtoJobType {
    match t {
        amos_scheduler::JobType::AlarmExact => ProtoJobType::AlarmExact,
        amos_scheduler::JobType::Deferred => ProtoJobType::Deferred,
    }
}

/// Parse a wire `i32` job type; `UNSPECIFIED`/unknown → `None`.
fn job_type_from_proto_i32(v: i32) -> Option<amos_scheduler::JobType> {
    match ProtoJobType::try_from(v).ok()? {
        ProtoJobType::AlarmExact => Some(amos_scheduler::JobType::AlarmExact),
        ProtoJobType::Deferred => Some(amos_scheduler::JobType::Deferred),
        ProtoJobType::Unspecified => None,
    }
}

fn lifecycle_status(e: amos_applife::LifecycleError) -> Status {
    match e {
        amos_applife::LifecycleError::Unknown(id) => {
            Status::not_found(format!("no such app: {id}"))
        }
        other => Status::invalid_argument(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_applife::AppState as S;
    use amos_power::{BatteryState, Telemetry, Usage};
    use tonic::Request;

    fn low_telemetry() -> Telemetry {
        Telemetry::new(BatteryState::on_battery(15.0), Usage::default(), None)
    }

    // Drive the trait methods directly on the concrete service (no socket) and
    // confirm they mutate the same shared governor the daemon beat ticks.
    #[tokio::test]
    async fn register_move_schedule_and_read_state() {
        let shared = Arc::new(Mutex::new(ResourceGovernor::default()));
        let svc = GovernorService::new(Arc::clone(&shared));

        svc.register_app(Request::new(AppRef {
            app_id: "notes".to_string(),
        }))
        .await
        .unwrap();
        svc.move_app(Request::new(MoveAppRequest {
            app_id: "notes".to_string(),
            to: ProtoState::Background as i32,
        }))
        .await
        .unwrap();
        svc.schedule_job(Request::new(ScheduleJobRequest {
            job_id: "sync".to_string(),
            job_type: ProtoJobType::Deferred as i32,
            earliest: 0,
            latest: 100,
        }))
        .await
        .unwrap();

        let st = svc
            .get_state(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(st.background_count, 1);
        assert_eq!(st.apps.len(), 1);
        assert_eq!(st.apps[0].app_id, "notes");
        assert_eq!(st.apps[0].state, ProtoState::Background as i32);
        assert_eq!(st.jobs.len(), 1);
        assert_eq!(st.jobs[0].job_type, ProtoJobType::Deferred as i32);

        // The beat's observe over the SAME instance freezes the background app on
        // low battery and withholds the deferred job.
        let outcome = shared
            .lock()
            .unwrap()
            .observe(50, low_telemetry(), false, false);
        assert_eq!(outcome.frozen, vec![AppId::new("notes")]);
        assert!(outcome.ran_deferred.is_empty());

        // GetState now reports the latest decision (power_save, throttling).
        let st2 = svc
            .get_state(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        let d = st2.decision.expect("decision present");
        assert_eq!(d.sensor_mode, "power_save");
        assert!(d.throttle_background);
        assert!(d.ticks >= 1);
        // The frozen app is now Cached → no longer "background".
        assert_eq!(st2.background_count, 0);
    }

    #[tokio::test]
    async fn schedule_then_cancel_job_over_the_service() {
        let shared = Arc::new(Mutex::new(ResourceGovernor::default()));
        let svc = GovernorService::new(Arc::clone(&shared));

        svc.schedule_job(Request::new(ScheduleJobRequest {
            job_id: "bg.sync".to_string(),
            job_type: ProtoJobType::Deferred as i32,
            earliest: 0,
            latest: 100,
        }))
        .await
        .unwrap();
        let st = svc
            .get_state(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(st.jobs.len(), 1);

        // Cancel removes the job from the register.
        svc.cancel_job(Request::new(JobRef {
            job_id: "bg.sync".to_string(),
        }))
        .await
        .unwrap();
        let st2 = svc
            .get_state(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert!(st2.jobs.is_empty(), "job cancelled over the service");

        // Cancelling a job that does not exist → NotFound.
        let err = svc
            .cancel_job(Request::new(JobRef {
                job_id: "nope".to_string(),
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::NotFound);
    }

    #[test]
    fn domain_state_maps_round_trip() {
        for s in [
            S::Foreground,
            S::Background,
            S::Cached,
            S::ForegroundService,
            S::Stopped,
        ] {
            assert_eq!(
                app_state_from_proto_i32(proto_app_state(s) as i32),
                Some(s),
                "{s:?}"
            );
        }
        assert_eq!(app_state_from_proto_i32(0), None); // UNSPECIFIED
    }

    #[test]
    fn visible_is_not_settable_over_the_wire() {
        // Visible is derived from surface visibility, never a settable target.
        assert_eq!(proto_app_state(S::Visible), ProtoState::Unspecified);
        assert_eq!(app_state_from_proto_i32(0), None);
    }
}
