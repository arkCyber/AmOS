//! amos System UI Rust core.
//!
//! Assembles the Tauri application and registers the AI bridge commands. The
//! WebView never talks to the daemon directly: every request flows through
//! `ai_bridge` over the local Unix Domain Socket.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
// Two documented invariant/boot sites are individually #[allow]ed.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod ai_bridge;
pub mod appstore;
pub mod assistant_voice;
pub mod buttons;
pub mod interpret;
pub mod mail;
pub mod radio;
pub mod store;
pub mod telephony;
pub mod translate;
pub mod tts;
pub mod wm;

use ai_bridge::AiBridge;
use store::SharedStore;
use tauri::Manager;
use wm::{SystemContext, WmState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// Boot boundary: if the GUI event loop cannot start, exiting the process is the
// intended loud failure (nothing sensible can run without it). This is the
// single allowed expect in production — everything else is gated (P0-1).
#[allow(clippy::expect_used)]
pub fn run() {
    // Durable store is the source of truth for quick-settings. Radio toggles live
    // in-process (Android services are reachable from the System UI APK, not the
    // headless daemon), so we seed the radio bridge from the persisted
    // `amos.settings` so radios survive restarts without the UI re-applying them.
    let shared_store = SharedStore::new();
    let radio_seed = radio::seed_from_settings(shared_store.get("amos.settings").as_deref());
    let radio_bridge = radio::RadioBridge::mock_seeded(radio_seed);

    tauri::Builder::default()
        .manage(AiBridge::new())
        .manage(assistant_voice::VoiceSession::new())
        .manage(WmState::new())
        .manage(SystemContext::new())
        .manage(shared_store)
        .manage(radio_bridge)
        .manage(buttons::HardwareButtons::new())
        .manage(interpret::InterpretationBridge::new())
        .manage(tts::TtsBridge::new())
        .manage(mail::MailBridge::new())
        .manage(appstore::StoreBridge::new())
        .invoke_handler(tauri::generate_handler![
            ai_bridge::ask_ai_agent,
            ai_bridge::chat_agent,
            ai_bridge::cancel_ai_session,
            ai_bridge::get_status,
            ai_bridge::get_ai_sessions,
            ai_bridge::clear_ai_sessions,
            ai_bridge::remove_ai_session,
            ai_bridge::get_ai_session_history,
            ai_bridge::ai_backend_switch,
            assistant_voice::assistant_voice_start,
            assistant_voice::assistant_voice_feed,
            assistant_voice::assistant_voice_end,
            assistant_voice::assistant_voice_stop,
            ai_bridge::get_android_apps,
            ai_bridge::launch_android_app,
            ai_bridge::get_android_app_icon,
            buttons::simulate_button,
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
            store::store_snapshot,
            translate::transcribe_audio,
            translate::translate_text,
            interpret::interpret_start,
            interpret::interpret_text,
            interpret::interpret_audio,
            interpret::interpret_end_of_speech,
            interpret::interpret_pause,
            interpret::interpret_resume,
            interpret::interpret_stop,
            interpret::interpret_restart,
            interpret::interpret_abort,
            interpret::interpret_status,
            tts::tts_synthesize,
            mail::mail_mailboxes,
            mail::mail_list,
            mail::mail_search,
            mail::mail_inbox,
            mail::mail_read,
            mail::mail_send,
            mail::mail_set_flagged,
            mail::mail_set_seen,
            mail::mail_delete,
            mail::mail_move,
            appstore::appstore_catalog,
            appstore::appstore_search,
            appstore::appstore_find,
            appstore::appstore_installed,
            appstore::appstore_updatable,
            appstore::appstore_status,
            appstore::appstore_install,
            appstore::appstore_upgrade,
            appstore::appstore_uninstall,
            appstore::appstore_bundle_resource,
            telephony::telephony_dial,
            telephony::telephony_end,
            telephony::telephony_status,
            telephony::telephony_answer,
            telephony::telephony_simulate_incoming,
            telephony::telephony_start_recording,
            telephony::telephony_stop_recording,
            radio::radio_status,
            radio::radio_set
        ])
        .setup(|app| {
            // System-wide readiness probe: log the daemon status once on boot.
            let bridge = app.state::<AiBridge>();
            match tauri::async_runtime::block_on(ai_bridge::fetch_status(&bridge)) {
                Ok(status) => tracing::info!("AI daemon online: model={}", status.model),
                Err(e) => tracing::warn!("AI daemon not reachable on boot: {e}"),
            }
            // Forward the daemon telephony `Watch` stream (incoming/connected/ended)
            // to the WebView as `telephony-event` so the phone UI stays live without
            // polling (reconnects if the daemon starts/stops).
            telephony::spawn_telephony_watch(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running amos System UI");
}
