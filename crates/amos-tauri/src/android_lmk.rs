//! Tauri ⇄ Android LMK `WatchLmk` bridge (surface-teardown push).
//!
//! The WebView's launcher opens a `legacy:<window_id>` surface when an APK is
//! launched. The daemon broadcasts container LMK decisions on `WatchLmk`; this
//! module opens a **long-lived** watch stream and forwards each event to the
//! WebView as an `lmk-surface` event carrying a `LmkSurfacePayload` with
//! `close_surface` set for `RECLAIMED`/`DESTROYED` — so the shell can tear down /
//! refresh the corresponding `legacy` surface without polling. Mirrors
//! `telephony.rs::spawn_telephony_watch` (same socket, same backoff-reconnect).

use amos_proto::android_compat::{
    android_manager_client::AndroidManagerClient, Empty, HostAction, HostActionRequest, LmkEvent,
    LmkEventKind, LmkRequest, LmkResponse, LmkVictim, MemoryPressure,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, Duration};

use crate::ai_bridge::with_client_id;
use crate::watch_backoff::{next_backoff_ms, WATCH_BACKOFF_BASE_MS};

/// Tauri event name carrying one [`LmkSurfacePayload`] per daemon `WatchLmk` event.
pub const LMK_SURFACE_EVENT: &str = "lmk-surface";

/// Serializable description of one container LMK decision (prost structs are not
/// `Serialize`). The shell uses `window_id` to address the `legacy:<window_id>`
/// surface and `close_surface` to decide whether to tear it down.
#[derive(Clone, Debug, Serialize)]
pub struct LmkSurfacePayload {
    pub window_id: String,
    pub package_name: String,
    /// `"reclaimed"` | `"frozen"` | `"thawed"` | `"destroyed"` | `"unknown"`.
    pub kind: String,
    /// `true` when the surface should be torn down (`reclaimed`/`destroyed`).
    pub close_surface: bool,
}

async fn build_android_client() -> Result<AndroidManagerClient<crate::daemon::DaemonChannel>, String>
{
    Ok(AndroidManagerClient::new(crate::daemon::channel().await?))
}

/// Map a daemon `LmkEvent` to the shell-facing payload.
fn surface_payload(evt: &LmkEvent) -> LmkSurfacePayload {
    let kind = match evt.kind {
        k if k == LmkEventKind::Reclaimed as i32 => "reclaimed",
        k if k == LmkEventKind::Frozen as i32 => "frozen",
        k if k == LmkEventKind::Thawed as i32 => "thawed",
        k if k == LmkEventKind::Destroyed as i32 => "destroyed",
        _ => "unknown",
    };
    let close_surface =
        evt.kind == LmkEventKind::Reclaimed as i32 || evt.kind == LmkEventKind::Destroyed as i32;
    LmkSurfacePayload {
        window_id: evt.window_id.clone(),
        package_name: evt.package_name.clone(),
        kind: kind.to_string(),
        close_surface,
    }
}

/// Drive one continuous `WatchLmk` round: open the stream and forward each LMK
/// event to the WebView as `lmk-surface`. Ends `Ok(())` when the daemon closes
/// the stream (caller reconnects) or `Err` if the daemon is down/errors.
async fn lmk_round(app: AppHandle) -> Result<(), String> {
    let mut client = build_android_client().await?;
    let mut stream = client
        .watch_lmk(Empty {})
        .await
        .map_err(|e| format!("android LMK watch open failed: {e}"))?
        .into_inner();
    while let Some(evt) = stream
        .message()
        .await
        .map_err(|e| format!("android LMK watch stream error: {e}"))?
    {
        let _ = app.emit(LMK_SURFACE_EVENT, surface_payload(&evt));
    }
    Ok(())
}

/// Background task forwarding the daemon `WatchLmk` stream to the WebView for the
/// lifetime of the app. Reconnects with the shared bounded backoff
/// ([`crate::watch_backoff`]) so a late-starting (or restarted) daemon is picked
/// up without a full UI reload.
pub fn spawn_lmk_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff_ms: u64 = WATCH_BACKOFF_BASE_MS;
        // Runs for the lifetime of the app: the loop has no exit and is aborted with
        // the Tauri runtime when the app stops. `sleep()` is the wait (never a spin).
        loop {
            // `Ok` means the round opened a live stream (daemon reachable) before
            // it ended — reset the backoff so the next reconnect is immediate.
            let connected = lmk_round(app.clone()).await.is_ok();
            backoff_ms = next_backoff_ms(backoff_ms, connected);
            sleep(Duration::from_millis(backoff_ms)).await;
        }
    });
}

/// Serializable victim row returned by an LMK trigger (prost structs are not
/// `Serialize`). The shell can show which container app was reclaimed/frozen.
#[derive(Clone, Debug, Serialize)]
pub struct LmkVictimOutcome {
    pub package_name: String,
    pub window_id: String,
    /// `true` = killed (surface torn down); `false` = frozen to Cached.
    pub killed: bool,
}

/// Pure mapper from a proto `LmkVictim` to a shell-facing row.
fn victim_outcome(v: &LmkVictim) -> LmkVictimOutcome {
    LmkVictimOutcome {
        package_name: v.package_name.clone(),
        window_id: v.window_id.clone(),
        killed: v.killed,
    }
}

/// Outcome of a debug LMK command: any victims reclaimed + a human note.
#[derive(Clone, Debug, Default, Serialize)]
pub struct LmkDebugOutcome {
    pub victims: Vec<LmkVictimOutcome>,
    pub note: String,
}

/// System-UI debug/user actions the shell can drive into the daemon's Android
/// manager LMK half (bring-up entry for `docs/android-lmk-e2e.md` G3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LmkDebugAction {
    /// Ask the daemon's LMK to reclaim (kill LRU cached/background) this round.
    TriggerCritical,
    /// Apply a host-governor decision back to one container app.
    ApplyFreeze,
    ApplyThaw,
    ApplyReclaim,
}

/// Parse a frontend action token. `None` for unknown / malformed.
fn parse_debug_action(s: &str) -> Option<LmkDebugAction> {
    match s {
        "trigger" | "trigger_critical" => Some(LmkDebugAction::TriggerCritical),
        "freeze" | "apply_freeze" => Some(LmkDebugAction::ApplyFreeze),
        "thaw" | "apply_thaw" => Some(LmkDebugAction::ApplyThaw),
        "reclaim" | "apply_reclaim" => Some(LmkDebugAction::ApplyReclaim),
        _ => None,
    }
}

/// The proto `HostAction` a non-trigger debug action applies (`None` for the LMK
/// trigger, which is a daemon-side reclaim instead of a targeted host decision).
fn action_to_host(a: LmkDebugAction) -> Option<HostAction> {
    match a {
        LmkDebugAction::ApplyFreeze => Some(HostAction::Freeze),
        LmkDebugAction::ApplyThaw => Some(HostAction::Thaw),
        LmkDebugAction::ApplyReclaim => Some(HostAction::Reclaim),
        LmkDebugAction::TriggerCritical => None,
    }
}

/// Tauri command: System-UI debug/user entry to drive the daemon LMK (bring-up
/// G3). `action` is one of the [`LmkDebugAction`] tokens; `trigger` reclaims LRU
/// victims (budget defaults to 1), the `*_apply` actions target one container app
/// by `package_name`. Absent daemon → descriptive error (UI shows offline).
#[tauri::command]
pub async fn android_lmk_debug(
    action: String,
    package_name: Option<String>,
    budget: Option<u64>,
) -> Result<LmkDebugOutcome, String> {
    let act = parse_debug_action(&action)
        .ok_or_else(|| format!("unknown lmk debug action '{action}'"))?;
    let mut client = build_android_client().await?;

    if let Some(host) = action_to_host(act) {
        let pkg =
            package_name.ok_or_else(|| format!("lmk debug '{action}' requires a package_name"))?;
        client
            .apply_host_decision(with_client_id(HostActionRequest {
                package_name: pkg.clone(),
                action: host as i32,
            }))
            .await
            .map_err(|e| format!("apply_host_decision '{pkg}' failed: {e}"))?;
        return Ok(LmkDebugOutcome {
            victims: Vec::new(),
            note: format!("applied host decision to {pkg}"),
        });
    }

    // LMK trigger: ask the daemon to reclaim victims this round.
    let resp: LmkResponse = client
        .trigger_lmk(with_client_id(LmkRequest {
            pressure: MemoryPressure::Critical as i32,
            budget: budget.unwrap_or(1),
        }))
        .await
        .map_err(|e| format!("trigger_lmk failed: {e}"))?
        .into_inner();
    Ok(LmkDebugOutcome {
        victims: resp.victims.iter().map(victim_outcome).collect(),
        note: format!("trigger_lmk returned {} victim(s)", resp.victims.len()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: LmkEventKind, window: &str) -> LmkEvent {
        LmkEvent {
            package_name: "com.tencent.mm".into(),
            window_id: window.into(),
            kind: kind as i32,
        }
    }

    #[test]
    fn reclaimed_and_destroyed_close_the_surface() {
        for (kind, expected) in [
            (LmkEventKind::Reclaimed, "reclaimed"),
            (LmkEventKind::Destroyed, "destroyed"),
        ] {
            let p = surface_payload(&event(kind, "waydroid_x"));
            assert!(p.close_surface, "{expected} must tear down the surface");
            assert_eq!(p.kind, expected);
            assert_eq!(p.window_id, "waydroid_x");
        }
    }

    #[test]
    fn frozen_and_thawed_do_not_close() {
        for (kind, expected) in [
            (LmkEventKind::Frozen, "frozen"),
            (LmkEventKind::Thawed, "thawed"),
        ] {
            let p = surface_payload(&event(kind, "waydroid_x"));
            assert!(!p.close_surface, "{expected} keeps the surface");
            assert_eq!(p.kind, expected);
        }
    }

    #[test]
    fn unknown_kind_is_benign() {
        let p = surface_payload(&event(LmkEventKind::Unspecified, "waydroid_x"));
        assert!(!p.close_surface);
        assert_eq!(p.kind, "unknown");
    }

    #[test]
    fn parses_debug_actions_and_rejects_unknown() {
        assert_eq!(
            parse_debug_action("trigger"),
            Some(LmkDebugAction::TriggerCritical)
        );
        assert_eq!(
            parse_debug_action("apply_reclaim"),
            Some(LmkDebugAction::ApplyReclaim)
        );
        assert_eq!(
            parse_debug_action("freeze"),
            Some(LmkDebugAction::ApplyFreeze)
        );
        assert_eq!(parse_debug_action(""), None);
        assert_eq!(parse_debug_action("nuke"), None);
    }

    #[test]
    fn backoff_doubles_and_is_capped_on_failed_connects() {
        // Policy lives in `watch_backoff`; here we only assert it stays shared so
        // the LMK watcher can't silently reintroduce a non-resetting backoff.
        assert_eq!(
            next_backoff_ms(4000, false),
            crate::watch_backoff::WATCH_BACKOFF_MAX_MS
        );
        assert_eq!(
            next_backoff_ms(8000, true),
            crate::watch_backoff::WATCH_BACKOFF_BASE_MS
        );
    }
    #[test]
    fn backoff_resets_to_base_after_a_successful_connect() {
        // Delegates to the shared policy (full policy tests live in `watch_backoff`).
        assert_eq!(
            next_backoff_ms(crate::watch_backoff::WATCH_BACKOFF_MAX_MS, true),
            crate::watch_backoff::WATCH_BACKOFF_BASE_MS
        );
    }

    #[test]
    fn maps_debug_actions_to_host_actions() {
        assert_eq!(
            action_to_host(LmkDebugAction::ApplyFreeze),
            Some(HostAction::Freeze)
        );
        assert_eq!(
            action_to_host(LmkDebugAction::ApplyThaw),
            Some(HostAction::Thaw)
        );
        assert_eq!(
            action_to_host(LmkDebugAction::ApplyReclaim),
            Some(HostAction::Reclaim)
        );
        // The raw LMK trigger is daemon-side, not a targeted host action.
        assert_eq!(action_to_host(LmkDebugAction::TriggerCritical), None);
    }

    #[test]
    fn maps_lmk_victims_to_serializable_rows() {
        let v = LmkVictim {
            package_name: "com.tencent.mm".into(),
            window_id: "waydroid_3".into(),
            killed: true,
        };
        let o = victim_outcome(&v);
        assert_eq!(o.package_name, "com.tencent.mm");
        assert_eq!(o.window_id, "waydroid_3");
        assert!(o.killed);
    }
}
