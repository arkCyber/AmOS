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
    android_manager_client::AndroidManagerClient, Empty, LmkEvent, LmkEventKind,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::net::UnixStream;
use tokio::time::{sleep, Duration};
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

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

/// The OS daemon socket — the same one `ai_bridge`/`telephony` use (`AMOS_SOCKET`
/// wins, else the platform default, e.g. `/tmp/amos-ai.sock`).
fn socket_path() -> std::path::PathBuf {
    amos_proto::socket::default_socket_path()
}

async fn build_android_client() -> Result<AndroidManagerClient<tonic::transport::Channel>, String> {
    let socket = socket_path();
    let owned = socket.clone();
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
        .map_err(|e| format!("OS daemon unavailable at {socket:?}: {e}"))?;
    Ok(AndroidManagerClient::new(channel))
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
/// lifetime of the app. Reconnects with bounded backoff so a late-starting (or
/// restarted) daemon is picked up without a full UI reload.
pub fn spawn_lmk_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff_ms: u64 = 500;
        loop {
            let _ = lmk_round(app.clone()).await;
            sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(8000);
        }
    });
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
}
