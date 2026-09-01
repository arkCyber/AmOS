//! amos System UI Rust core.
//!
//! Assembles the Tauri application and registers the AI bridge commands. The
//! WebView never talks to the daemon directly: every request flows through
//! `ai_bridge` over the local Unix Domain Socket.

pub mod ai_bridge;
pub mod store;
pub mod wm;

use ai_bridge::AiBridge;
use store::SharedStore;
use tauri::Manager;
use wm::{SystemContext, WmState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AiBridge::new())
        .manage(WmState::new())
        .manage(SystemContext::new())
        .manage(SharedStore::new())
        .invoke_handler(tauri::generate_handler![
            ai_bridge::ask_ai_agent,
            ai_bridge::chat_agent,
            ai_bridge::cancel_ai_session,
            ai_bridge::get_status,
            ai_bridge::get_android_apps,
            ai_bridge::launch_android_app,
            ai_bridge::get_android_app_icon,
            wm::wm_open,
            wm::wm_focus,
            wm::wm_hide,
            wm::wm_close,
            wm::wm_home,
            wm::wm_windows,
            wm::system_set_context,
            wm::system_clear_context,
            wm::system_peek_context,
            store::store_get,
            store::store_set,
            store::store_remove,
            store::store_snapshot
        ])
        .setup(|app| {
            // System-wide readiness probe: log the daemon status once on boot.
            let bridge = app.state::<AiBridge>();
            match tauri::async_runtime::block_on(ai_bridge::fetch_status(&bridge)) {
                Ok(status) => tracing::info!("AI daemon online: model={}", status.model),
                Err(e) => tracing::warn!("AI daemon not reachable on boot: {e}"),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running amos System UI");
}
