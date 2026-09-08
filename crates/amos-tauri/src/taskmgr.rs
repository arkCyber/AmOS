//! Tauri <-> daemon resource-governor (Task Manager) bridge.
//!
//! The WebView's Task-Manager surface calls `taskmgr_snapshot` / `taskmgr_app_action`;
//! these open a `GovernorClient` over the OS daemon's Unix Domain Socket (the same
//! socket that carries `AiAgent` + `AndroidManager` + `Telephony` + `Sensor` + the
//! Governor service), list the governor's apps/jobs, and drive a per-app lifecycle
//! action into the SAME shared `ResourceGovernor` the daemon beat ticks.
//!
//! Prost types aren't `Serialize`, so we mirror them into serde payloads via pure
//! mappers (unit-tested). Absent daemon → descriptive error (UI shows a
//! "daemon not connected" state).

use crate::ai_bridge::with_client_id;
use amos_proto::amos_governor::governor_client::GovernorClient;
use amos_proto::amos_governor::{
    AppRef as ProtoAppRef, Empty as GovernorEmpty, JobRef as ProtoJobRef, MoveAppRequest,
};
use serde::Serialize;

async fn build_channel() -> Result<tonic::transport::Channel, String> {
    crate::daemon::channel().await
}

async fn connect() -> Result<GovernorClient<tonic::transport::Channel>, String> {
    Ok(GovernorClient::new(build_channel().await?))
}

/// One tracked app/process in the lifecycle registry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TaskApp {
    pub id: String,
    /// Lifecycle key: foreground|visible|foreground_service|background|cached|stopped.
    pub state: String,
}

/// One scheduled job.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TaskJob {
    pub id: String,
    /// exact | deferred
    pub kind: String,
    pub earliest: u64,
    pub latest: u64,
}

/// The governor's latest energy decision (advisory).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TaskDecision {
    pub mode: String,
    pub reason: String,
    pub cap_inference: bool,
    pub throttle_background: bool,
    pub ticks: u64,
}

/// Serializable snapshot of the daemon resource-governor (Task-Manager surface).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TaskSnapshot {
    pub apps: Vec<TaskApp>,
    pub jobs: Vec<TaskJob>,
    pub background_count: u64,
    pub decision: Option<TaskDecision>,
}

/// Stable lifecycle key for a proto `AppState` enum value (1..=5).
pub fn app_state_key(v: i32) -> &'static str {
    match v {
        1 => "foreground",
        2 => "background",
        3 => "cached",
        4 => "foreground_service",
        5 => "stopped",
        _ => "unknown",
    }
}

/// Job kind key for a proto `JobType` enum value.
pub fn job_kind_key(v: i32) -> &'static str {
    match v {
        1 => "exact",
        2 => "deferred",
        _ => "unknown",
    }
}

/// Per-app actions a Task-Manager can drive into the governor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppAction {
    Foreground,
    Background,
    Freeze, // -> Cached (tombstone)
    Stop,   // -> Stopped (keeps saved state)
    Kill,   // Unregister (drops saved state)
}

/// Parse an action token from the frontend. `None` for unknown / malformed.
pub fn parse_action(s: &str) -> Option<AppAction> {
    match s {
        "foreground" => Some(AppAction::Foreground),
        "background" => Some(AppAction::Background),
        "freeze" | "cached" => Some(AppAction::Freeze),
        "stop" => Some(AppAction::Stop),
        "kill" | "unregister" => Some(AppAction::Kill),
        _ => None,
    }
}

/// The proto `AppState` value an action moves an app to (`None` for Kill, which uses
/// `UnregisterApp` instead of `MoveApp`).
fn action_to_state(a: AppAction) -> Option<i32> {
    match a {
        AppAction::Foreground => Some(1),
        AppAction::Background => Some(2),
        AppAction::Freeze => Some(3),
        AppAction::Stop => Some(5),
        AppAction::Kill => None,
    }
}

/// Pure mapper from a proto `GovernorState` into a serializable [`TaskSnapshot`].
pub fn task_snapshot(s: &amos_proto::amos_governor::GovernorState) -> TaskSnapshot {
    TaskSnapshot {
        apps: s
            .apps
            .iter()
            .map(|a| TaskApp {
                id: a.app_id.clone(),
                state: app_state_key(a.state).to_string(),
            })
            .collect(),
        jobs: s
            .jobs
            .iter()
            .map(|j| TaskJob {
                id: j.job_id.clone(),
                kind: job_kind_key(j.job_type).to_string(),
                earliest: j.earliest,
                latest: j.latest,
            })
            .collect(),
        background_count: s.background_count,
        decision: s.decision.as_ref().map(|d| TaskDecision {
            mode: d.sensor_mode.clone(),
            reason: d.reason.clone(),
            cap_inference: d.cap_inference,
            throttle_background: d.throttle_background,
            ticks: d.ticks,
        }),
    }
}

/// Tauri command: return the governor's live app/job snapshot.
#[tauri::command]
pub async fn taskmgr_snapshot() -> Result<TaskSnapshot, String> {
    let mut client = connect().await?;
    let state = client
        .get_state(with_client_id(GovernorEmpty {}))
        .await
        .map_err(|e| format!("task manager snapshot failed: {e}"))?
        .into_inner();
    Ok(task_snapshot(&state))
}

/// Tauri command: drive a per-app lifecycle action, then return the fresh snapshot.
#[tauri::command]
pub async fn taskmgr_app_action(app_id: String, action: String) -> Result<TaskSnapshot, String> {
    let act =
        parse_action(&action).ok_or_else(|| format!("unknown task-manager action '{action}'"))?;
    let mut client = connect().await?;
    let target = action_to_state(act);
    match target {
        Some(state) => {
            client
                .move_app(with_client_id(MoveAppRequest {
                    app_id: app_id.clone(),
                    to: state,
                }))
                .await
                .map_err(|e| format!("move_app '{app_id}' failed: {e}"))?;
        }
        None => {
            client
                .unregister_app(with_client_id(ProtoAppRef {
                    app_id: app_id.clone(),
                }))
                .await
                .map_err(|e| format!("unregister_app '{app_id}' failed: {e}"))?;
        }
    }
    let state = client
        .get_state(with_client_id(GovernorEmpty {}))
        .await
        .map_err(|e| format!("task manager refresh failed: {e}"))?
        .into_inner();
    Ok(task_snapshot(&state))
}

/// Tauri command: drive a job action (only `cancel` for now), then return the fresh
/// snapshot.
#[tauri::command]
pub async fn taskmgr_job_action(job_id: String, action: String) -> Result<TaskSnapshot, String> {
    if action != "cancel" {
        return Err(format!(
            "unknown task-manager job action '{action}' (only 'cancel')"
        ));
    }
    let mut client = connect().await?;
    client
        .cancel_job(with_client_id(ProtoJobRef {
            job_id: job_id.clone(),
        }))
        .await
        .map_err(|e| format!("cancel_job '{job_id}' failed: {e}"))?;
    let state = client
        .get_state(with_client_id(GovernorEmpty {}))
        .await
        .map_err(|e| format!("task manager refresh failed: {e}"))?
        .into_inner();
    Ok(task_snapshot(&state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_proto::amos_governor::{AppInfo, GovernorDecision, GovernorState, JobInfo};

    fn sample_state() -> GovernorState {
        GovernorState {
            apps: vec![
                AppInfo {
                    app_id: "com.amos.photos".to_string(),
                    state: 1, // foreground
                },
                AppInfo {
                    app_id: "com.amos.maps".to_string(),
                    state: 3, // cached
                },
            ],
            jobs: vec![JobInfo {
                job_id: "bg.sync".to_string(),
                job_type: 2, // deferred
                earliest: 0,
                latest: 200,
            }],
            background_count: 0,
            decision: Some(GovernorDecision {
                sensor_mode: "power_save".to_string(),
                reason: "battery_low".to_string(),
                cap_inference: true,
                throttle_background: true,
                ticks: 12,
            }),
        }
    }

    #[test]
    fn maps_state_and_job_keys() {
        assert_eq!(app_state_key(1), "foreground");
        assert_eq!(app_state_key(3), "cached");
        assert_eq!(app_state_key(5), "stopped");
        assert_eq!(app_state_key(99), "unknown");
        assert_eq!(job_kind_key(1), "exact");
        assert_eq!(job_kind_key(2), "deferred");
        assert_eq!(job_kind_key(0), "unknown");
    }

    #[test]
    fn parses_actions_and_targets() {
        assert_eq!(parse_action("freeze"), Some(AppAction::Freeze));
        assert_eq!(parse_action("background"), Some(AppAction::Background));
        assert_eq!(parse_action("kill"), Some(AppAction::Kill));
        assert_eq!(action_to_state(AppAction::Foreground), Some(1));
        assert_eq!(action_to_state(AppAction::Stop), Some(5));
        assert_eq!(action_to_state(AppAction::Kill), None);
        assert_eq!(parse_action("nuke"), None);
        assert_eq!(parse_action(""), None);
    }

    #[test]
    fn maps_a_governor_state_snapshot() {
        let s = task_snapshot(&sample_state());
        assert_eq!(s.apps.len(), 2);
        assert_eq!(s.apps[0].id, "com.amos.photos");
        assert_eq!(s.apps[0].state, "foreground");
        assert_eq!(s.apps[1].state, "cached");
        assert_eq!(s.jobs[0].id, "bg.sync");
        assert_eq!(s.jobs[0].kind, "deferred");
        assert_eq!(s.jobs[0].latest, 200);
        let d = s.decision.expect("decision present");
        assert_eq!(d.mode, "power_save");
        assert_eq!(d.reason, "battery_low");
        assert_eq!(d.ticks, 12);
    }

    #[test]
    fn empty_state_maps_to_empty_snapshot() {
        let s = task_snapshot(&GovernorState {
            apps: vec![],
            jobs: vec![],
            background_count: 0,
            decision: None,
        });
        assert!(s.apps.is_empty());
        assert!(s.jobs.is_empty());
        assert!(s.decision.is_none());
    }
}
