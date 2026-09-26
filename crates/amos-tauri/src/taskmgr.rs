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

async fn build_channel() -> Result<crate::daemon::DaemonChannel, String> {
    crate::daemon::channel().await
}

async fn connect() -> Result<GovernorClient<crate::daemon::DaemonChannel>, String> {
    Ok(GovernorClient::new(build_channel().await?))
}

/// Maximum bytes in a task-manager `app_id` / `job_id` the WebView hands in.
///
/// Real ids are reverse-DNS / short hashes (`org.amos.app`, `job_<digits>`,
/// ≤64 chars). 256 B is the same ceiling the rest of the bridge modules use
/// and prevents a paste-sized caller from inflating the daemon's id keys.
pub const MAX_TASKMGR_ID_BYTES: usize = 256;

/// One tracked app/process in the lifecycle registry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TaskApp {
    pub id: String,
    /// Lifecycle key — exactly the strings [`app_state_key`] emits
    /// (`foreground|background|cached|foreground_service|stopped`, plus `unknown` when the
    /// proto value is absent or one this bridge does not know).
    ///
    /// **`visible` is not one of them here.** The container's `visible` tier has no proto
    /// `AppState` value (`amos_ai::governor_service::proto_app_state` maps it to
    /// `APP_STATE_UNSPECIFIED`), so a visible app arrives on *this* wire as `unknown`. The key
    /// that does carry `visible` is the container LMK snapshot's `state_key`
    /// ([`crate::ai_bridge::AndroidLmkTaskInfo`], built from `amos_applife::AppState::key()`) —
    /// the two vocabularies share five strings and differ in this one.
    ///
    /// These strings are read **as strings** by other code, which is why the exact spelling
    /// matters: the frontend branches its per-app action menu on them
    /// (`frontend-ts/src/lib/taskmgr.ts`, `svelte/TaskManager.svelte`) and the device-care
    /// reclaim planner matches them to pick reclaim victims
    /// (`amos_devocare::reclaim_plan`). `the_lifecycle_keys_are_the_kernels_and_the_reclaim_planners`
    /// below binds this file's spelling to the kernel's keys and to that planner's rule.
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

/// Bound a task-manager id at the command seam: the daemon's gRPC `app_id` /
/// `job_id` is opaque to the bridge, so a paste-sized id would inflate every
/// downstream log line and look-up. The same `valid` rule is shared by
/// `taskmgr_app_action` and `taskmgr_job_action` — `what` names which field was
/// checked for the error message.
fn check_taskmgr_id(id: &str, what: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_TASKMGR_ID_BYTES {
        return Err(format!(
            "taskmgr {what} invalid: {} bytes (max {MAX_TASKMGR_ID_BYTES})",
            id.len()
        ));
    }
    if id.chars().any(|c| c.is_control() || c == '\0') {
        return Err(format!("taskmgr {what} contains control characters"));
    }
    Ok(())
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
    check_taskmgr_id(&app_id, "app_id")?;
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
    check_taskmgr_id(&job_id, "job_id")?;
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

    /// `check_taskmgr_id` is the single gate the command seam runs before
    /// reaching the daemon's gRPC `app_id` / `job_id`. Empty / oversized /
    /// control-character ids are refused with a structured reason so the UI
    /// learns why a click was a no-op instead of being told "ok, you killed it"
    /// while nothing happened.
    #[test]
    fn check_taskmgr_id_accepts_real_ids_and_rejects_oversized() {
        for ok in [
            "org.amos.app",
            "job_42",
            "x".repeat(MAX_TASKMGR_ID_BYTES).as_str(),
        ] {
            assert!(check_taskmgr_id(ok, "id").is_ok(), "{ok:?} is a real id");
        }
        assert!(check_taskmgr_id("", "app_id").is_err());
        assert!(check_taskmgr_id("x\0", "app_id").is_err());
        let huge = "x".repeat(MAX_TASKMGR_ID_BYTES + 1);
        assert!(check_taskmgr_id(&huge, "job_id").is_err());
    }

    // ─── REQ-A669: these keys are read *as strings* by two other spellings ────────
    //
    // The production chain is domain → proto → **this file** → consumer:
    //
    //   `amos_applife::AppState::key()`                  the lifecycle kernel's vocabulary
    //     ↳ `amos_ai::governor_service::proto_app_state` proto i32 (`Visible` has no value)
    //       ↳ [`app_state_key`]                          the strings the UI / planner see
    //         ↳ `amos_devocare::reclaim_plan`            matches those strings to pick victims
    //           + `frontend-ts/src/lib/taskmgr.ts`       normalizes them for the Task Manager
    //
    // REQ-A655 (F-SH-122) bound the kernel's keys to the *planner's* set. Nothing bound this
    // file's spelling — the one the planner is actually fed in production — and the tests
    // around it each compare a copy to itself. So renaming one arm here ("cached" → "frozen")
    // made every key unknown to `reclaim_plan` (nothing to free on the「内存加速」card) and
    // stopped the UI's action menu from recognising the foreground tier, with every suite green.

    /// The `AppState::Variant => "key"` pairs of the lifecycle kernel's `key()`, read from
    /// its **source** (the `include_str!` technique REQ-A655 established, so no cross-crate
    /// dependency is added for the binding).
    fn kernel_state_keys(spec: &str) -> std::collections::BTreeMap<&str, &str> {
        let at = spec
            .find("pub fn key(self) -> &'static str {")
            .expect("AppState::key() not found");
        let rest = &spec[at..];
        let body = &rest[..rest.find("\n    }").expect("key() body not closed")];
        let mut out = std::collections::BTreeMap::new();
        for (i, _) in body.match_indices("AppState::") {
            let arm = &body[i + "AppState::".len()..];
            let variant = &arm[..arm.find(" =>").expect("variant not followed by =>")];
            let after = &arm[arm.find("=> \"").expect("arm has no string key") + 4..];
            let key = &after[..after.find('"').expect("unterminated key literal")];
            out.insert(variant, key);
        }
        out
    }

    /// Every named `APP_STATE_*` member of `proto/governor.proto`'s `AppState` enum as
    /// `(name, value)`, **including** `APP_STATE_UNSPECIFIED` (0) so the caller can assert the
    /// census instead of trusting a hand-typed `1..=5` range — a state added to the wire must not
    /// be able to slip through this bridge as `unknown`.
    fn proto_state_values(proto: &str) -> Vec<(&str, i32)> {
        let at = proto
            .find("enum AppState {")
            .expect("enum AppState not found in proto/governor.proto");
        let rest = &proto[at..];
        let body = &rest[..rest.find("\n}").expect("enum AppState body not closed")];
        let mut out = Vec::new();
        for line in body.lines() {
            let line = line.split("//").next().unwrap_or("").trim();
            let Some((name, value)) = line.split_once('=') else {
                continue;
            };
            let name = name.trim();
            if !name.starts_with("APP_STATE_") {
                continue;
            }
            let digits: String = value
                .trim()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if let Ok(v) = digits.parse::<i32>() {
                out.push((name, v));
            }
        }
        out
    }

    #[test]
    fn the_lifecycle_keys_are_the_kernels_and_the_reclaim_planners() {
        const SPEC: &str = include_str!("../../amos-applife/src/spec.rs");
        const PROTO: &str = include_str!("../../../proto/governor.proto");

        // 1. The kernel's key vocabulary.
        let kernel = kernel_state_keys(SPEC);
        // Vacuity guard: a rewrite that moves the arms out of the scanned window must fail
        // loudly rather than compare against an empty map.
        assert_eq!(
            kernel.len(),
            6,
            "expected six AppState keys, parsed {kernel:?}"
        );

        // 2. The proto values the governor assigns, from the wire contract itself. A re-typed
        //    `2`/`3` here is exactly the kind of copy this test exists to refuse.
        let states = proto_state_values(PROTO);
        assert_eq!(
            states.len(),
            6,
            "expected six named AppState values (UNSPECIFIED + five tiers), parsed {states:?}"
        );
        let value_of = |name: &str| -> i32 {
            states
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| *v)
                .unwrap_or_else(|| panic!("{name} not in the AppState enum"))
        };
        let foreground = value_of("APP_STATE_FOREGROUND");
        let background = value_of("APP_STATE_BACKGROUND");
        let cached = value_of("APP_STATE_CACHED");
        let service = value_of("APP_STATE_FOREGROUND_SERVICE");
        let stopped = value_of("APP_STATE_STOPPED");
        assert!(
            [foreground, background, cached, service, stopped]
                .iter()
                .all(|v| *v > 0),
            "proto AppState values must be positive (parsed {foreground}/{background}/{cached}/{service}/{stopped})"
        );

        // 3. Every key this bridge can emit **for every state the wire can carry** is a kernel
        //    key: the UI and the planner both consume the spelling, so it has to be the kernel's.
        //    Driven by the proto census rather than a range, so a state *added* to the wire is a
        //    red here instead of an app the Task Manager quietly renders as `unknown`.
        for (name, v) in &states {
            if *v == 0 {
                continue; // APP_STATE_UNSPECIFIED is "no state", not a tier.
            }
            let key = app_state_key(*v);
            assert!(
                kernel.values().any(|k| *k == key),
                "app_state_key({v}) = {key:?} for {name} is not an amos_applife::AppState::key()"
            );
        }

        // 4. The planner's rule and this bridge agree in both directions: the two proto values
        //    the governor marks reclaimable produce exactly the strings `reclaim_plan` reclaims,
        //    and the protected / not-running tiers produce strings it never reclaims. That is
        //    the property the「内存加速」card must not be able to break from either side.
        assert!(
            !amos_devocare::RECLAIMABLE_STATES.is_empty(),
            "a planner that reclaims nothing would satisfy every containment below"
        );
        for (name, v) in [
            ("APP_STATE_BACKGROUND", background),
            ("APP_STATE_CACHED", cached),
        ] {
            assert!(
                amos_devocare::is_reclaimable(app_state_key(v)),
                "the bridge must hand the planner the {name} key, got {:?}",
                app_state_key(v)
            );
        }
        for (name, v) in [
            ("APP_STATE_FOREGROUND", foreground),
            ("APP_STATE_FOREGROUND_SERVICE", service),
            ("APP_STATE_STOPPED", stopped),
        ] {
            assert!(
                !amos_devocare::is_reclaimable(app_state_key(v)),
                "app_state_key({v}) = {:?} ({name}) must never be offered for reclaim",
                app_state_key(v)
            );
        }
    }
}
