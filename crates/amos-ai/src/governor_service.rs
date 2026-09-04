//! gRPC `Governor` service exposing the daemon's [`ResourceGovernor`] closed loop
//! over the shared UDS (proto `amos_governor`, `proto/governor.proto`).
//!
//! Mirrors the `amos-sensor`/`amos-telephony` service pattern: the service holds a
//! shared `Arc<Mutex<ResourceGovernor>>` (the *same* instance the periodic beat in
//! `serve()` ticks) and maps tonic RPCs onto the domain core — so a System UI /
//! per-app process host can register apps & jobs and move apps through their
//! lifecycle, while the daemon keeps deciding over them. See
//! `docs/device-bring-up.md` §4.

use std::sync::{Arc, Mutex};

use amos_applife::AppId;
use amos_proto::amos_governor::{
    governor_server::{Governor, GovernorServer},
    AppInfo, AppRef, AppState as ProtoState, Empty, GovernorDecision, GovernorState, JobInfo,
    JobType as ProtoJobType, MoveAppRequest, ScheduleJobRequest,
};
use amos_scheduler::ScheduledJob;
use tonic::{Request, Response, Status};

use crate::governor::ResourceGovernor;

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
