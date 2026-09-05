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
#[cfg(feature = "android")]
pub mod android_glue;
pub mod android_lmk;
pub mod appstore;
pub mod assistant_voice;
pub mod buttons;
pub mod clipboard;
#[cfg(feature = "android")]
pub mod clipboard_glue;
pub mod daemon;
pub mod display;
pub mod flashlight;
#[cfg(feature = "android")]
pub mod incall;
pub mod interpret;
pub mod mail;
pub mod privacy_client;
pub mod radio;
pub mod real_dial;
pub mod sensor_host;
pub mod sensors;
pub mod store;
pub mod system;
pub mod taskmgr;
pub mod telephony;
pub mod translate;
pub mod tts;
pub mod wm;

use ai_bridge::AiBridge;
use std::sync::Arc;
use store::SharedStore;
use tauri::{Emitter, Manager};
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
    let clipboard = Arc::new(clipboard::GlobalClipboard::new());
    let shared_store = SharedStore::new();
    let radio_seed = radio::seed_from_settings(shared_store.get("amos.settings").as_deref());
    let radio_bridge = radio::RadioBridge::mock_seeded(radio_seed);
    // Same in-process rationale as the radios: the Android torch (CameraManager)
    // is reachable only from the System UI APK, so flashlight lives here too.
    // On-device boot prefers the real Android provider (installed by the Kotlin
    // FlashlightGlue upcall); desktop/CI always falls back to the seeded Mock.
    let flashlight_seed =
        flashlight::seed_from_settings(shared_store.get(flashlight::FLASHLIGHT_KEY).as_deref());
    let flashlight_bridge = flashlight::boot_bridge(flashlight_seed);

    tauri::Builder::default()
        .manage(AiBridge::new())
        .manage(assistant_voice::VoiceSession::new())
        .manage(assistant_voice::DeviceMic::new())
        .manage(WmState::new())
        .manage(SystemContext::new())
        .manage(clipboard.clone())
        .manage(shared_store)
        .manage(radio_bridge)
        .manage(flashlight_bridge)
        .manage(display::DisplayPowerBridge::file_default())
        .manage(buttons::HardwareButtons::new())
        .manage(interpret::InterpretationBridge::new())
        .manage(tts::TtsBridge::new())
        .manage(mail::MailBridge::new())
        .manage(appstore::StoreBridge::new())
        .manage(sensor_host::SensorHost::new())
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
            assistant_voice::device_mic_start,
            assistant_voice::device_mic_stop,
            assistant_voice::device_mic_status,
            ai_bridge::get_android_apps,
            ai_bridge::launch_android_app,
            ai_bridge::get_android_app_icon,
            ai_bridge::android_lmk_tasks,
            android_lmk::android_lmk_debug,
            buttons::simulate_button,
            wm::wm_open,
            wm::wm_focus,
            wm::wm_hide,
            wm::wm_close,
            wm::wm_home,
            wm::wm_windows,
            wm::wm_layout_snapshot,
            wm::wm_layout_set_screen,
            wm::wm_split,
            wm::wm_split_resize,
            wm::wm_split_move,
            wm::wm_split_swap,
            wm::wm_split_exit,
            wm::wm_split_candidates,
            wm::wm_split_demo,
            wm::system_set_context,
            wm::system_clear_context,
            wm::system_peek_context,
            clipboard::clipboard_write,
            clipboard::clipboard_read,
            clipboard::clipboard_history,
            clipboard::clipboard_clear,
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
            appstore::appstore_bundle_uri,
            telephony::telephony_dial,
            telephony::telephony_end,
            telephony::telephony_status,
            telephony::telephony_answer,
            telephony::telephony_simulate_incoming,
            telephony::telephony_start_recording,
            telephony::telephony_stop_recording,
            radio::radio_status,
            radio::radio_set,
            flashlight::flashlight_status,
            flashlight::flashlight_set,
            sensors::sensor_snapshot,
            sensors::sensor_set_mode,
            sensors::sensor_acquire,
            sensor_host::sensor_host_snapshot,
            sensor_host::sensor_host_set_mode,
            sensor_host::sensor_host_record_imu,
            sensor_host::sensor_host_record_frame,
            sensor_host::sensor_host_acquire,
            system::system_health,
            display::screen_state_set,
            display::screen_state_get,
            privacy_client::perm_authorize,
            privacy_client::perm_grant,
            privacy_client::perm_revoke,
            privacy_client::perm_granted,
            privacy_client::perm_recent_audit,
            taskmgr::taskmgr_snapshot,
            taskmgr::taskmgr_app_action,
            taskmgr::taskmgr_job_action,
            real_dial::real_dial
        ])
        .setup(|app| {
            // Arm the native clipboard ingest bus with the managed GlobalClipboard
            // so container-originated copies land in the shared buffer, and install
            // an announce hook so those ingests broadcast a metadata-only
            // `clipboard-changed` notice to foreground UIs (same as Webview writes).
            let _ = clipboard::arm_ingest(
                app.state::<Arc<clipboard::GlobalClipboard>>()
                    .inner()
                    .clone(),
            );
            let handle = app.handle().clone();
            let _ = clipboard::set_notifier(move |entry: &clipboard::ClipboardEntry| {
                let _ = handle.emit("clipboard-changed", clipboard::ClipboardNotice::from(entry));
            });
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
            // Forward the daemon `WatchLmk` stream to the WebView as `lmk-surface`
            // so the shell can tear down / refresh a `legacy` surface when its
            // Android app is reclaimed/destroyed (reconnects if the daemon starts).
            android_lmk::spawn_lmk_watch(app.handle().clone());
            // On device, arm the torch device-seam UI pusher so OS-driven torch
            // changes (TorchCallback) reach the System UI live via the shared
            // store's `store-updated` event (status bar + open control-center).
            #[cfg(feature = "android")]
            flashlight::install_ui_pusher(app.handle().clone());
            // Real in-call bridge (default-dialer / InCallService): give the Rust side
            // an AppHandle so Kotlin-pushed real call states reach the WebView as
            // `telephony-event`, and so telephony answer/end can drive the real call.
            #[cfg(feature = "android")]
            incall::set_app(app.handle().clone());
            // Physical camera key → AmOS Home: hand the seam an AppHandle so the
            // MainActivity's intercepted camera key can route as Home.
            #[cfg(feature = "android")]
            buttons::install_android_app(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running amos System UI");
}
