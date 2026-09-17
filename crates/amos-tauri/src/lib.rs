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
pub mod airplay;
pub mod airplay_platform;
#[cfg(test)]
#[path = "airplay_tests.rs"]
mod airplay_tests;
pub mod alarm_sched;
#[cfg(feature = "android")]
pub mod android_glue;
pub mod android_lmk;
pub mod appstore;
pub mod assistant_voice;
/// Spam blocking (calls + SMS): rule storage, SMS filtering and the Android
/// call-screening JNI hook.
pub mod blocklist;
pub mod buttons;
pub mod clipboard;
#[cfg(feature = "android")]
pub mod clipboard_glue;
/// Host-side guest-container clipboard transport (Waydroid / no-UI base). Host
/// half of the global-clipboard sync seam: framed protocol + a `ClipboardNative`
/// sink + an ingest loop, transport-agnostic over an injectable byte channel.
/// Inert (not auto-wired) until a real guest channel is attached on-device.
pub mod clipboard_guest;
/// Host-half **wiring** for the guest clipboard link: builds the audited mirror sink
/// over the real Unix-domain-socket transport (`amos_clipboard::unix`) and starts the
/// reconnecting ingest loop. **Env-gated, inert by default**
/// (`AMOS_GUEST_CLIPBOARD_SOCKET`); see `docs/clipboard-container-sync.md` §5/§7.
pub mod clipboard_guest_link;
pub mod daemon;
/// Desktop-shell capability switches (`AMOS_DESKTOP_SHORTCUTS` /
/// `AMOS_DOCK_CONTEXT_MENU`) — read **host-side** because a WebView has no
/// environment to read (REQ-A287).
pub mod desktop_features;
pub mod devcare;
#[cfg(feature = "android")]
pub mod devcare_device;
pub mod display;
/// Typed error envelope shared across the System UI Rust core. See
/// [`error::ErrorCode`] for the wire vocabulary and [`error::AmosError`] for the
/// serializable failure shape returned by every `#[tauri::command]`.
pub mod error;
pub mod flashlight;
pub mod host_battery;
pub mod host_log;
/// Input method (IME): the System UI's on-screen pinyin keyboard. `amos-ime` owns
/// the engine; this bridge owns the session + the `amos-ime.json` profile.
pub mod ime;
#[cfg(feature = "android")]
pub mod incall;
pub mod interpret;
pub mod link;
pub mod mail;
pub mod media;
pub mod mic_permission;
pub mod netguard;
pub mod note_export;
pub mod privacy_client;
pub mod push_notifications;
pub mod radio;
pub mod rag_client;
pub mod real_dial;
pub mod sensor_host;
pub mod sensors;
pub mod sms;
pub mod store;
pub mod system;
pub mod taskmgr;
pub mod telemetry_spy;
pub mod telephony;
pub mod terminal;
pub mod translate;
pub mod tts;
pub mod watch_backoff;
pub mod wm;
// Desktop-only native-application surfaces (runtime availability, never a `cfg`:
// `wine_is_available` / `linux_is_available` answer for the host they run on).
#[cfg(desktop)]
pub mod linux_apps;
#[cfg(desktop)]
pub mod wine;
// The freedesktop `.desktop` entry format, shared by both surfaces above (pure).
#[cfg(desktop)]
pub mod desktop_entry;
// Call recording storage and metadata (used by telephony).
pub mod recording;
// macOS menu bar (Aqua Global Menu) — REQ-A275.
#[cfg(target_os = "macos")]
pub mod menu;
// macOS window title-bar colour (REQ-A326).
#[cfg(target_os = "macos")]
pub mod window_background;
// Persist window position/size across launches (REQ-A249).
#[cfg(target_os = "macos")]
pub mod window_state;

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
    // Install the `tracing` sink **first**: every report below (boot facts, a shell
    // window that could not be sized, a screen that could not be measured, a degraded
    // provider) is a no-op without a subscriber. On device that is logcat; on desktop
    // it is stderr — and *before REQ-A229 the desktop had no subscriber at all*, so the
    // PC build printed nothing and the "reported, not silent" claims were unverifiable
    // where a desktop user actually runs it.
    host_log::install();
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
        .manage(airplay::AirPlayState::new())
        .manage(assistant_voice::VoiceSession::new())
        .manage(assistant_voice::DeviceMic::new())
        .manage(WmState::new())
        .manage(SystemContext::new())
        .manage(alarm_sched::AlarmSchedState::new())
        .manage(clipboard.clone())
        .manage(shared_store)
        .manage(radio_bridge)
        .manage(flashlight_bridge)
        .manage(media::MediaBridge::boot())
        .manage(display::DisplayPowerBridge::file_default())
        .manage(buttons::HardwareButtons::new())
        .manage(interpret::InterpretationBridge::new())
        .manage(tts::TtsBridge::new())
        .manage(mail::MailBridge::new())
        .manage(appstore::StoreBridge::new())
        .manage(sensor_host::SensorHost::new())
        .manage(sms::SmsBridge::boot())
        .manage(sms::trash_shared())
        .manage(blocklist::shared())
        .manage(devcare::DevCareBridge::new())
        // Input method (IME): the on-screen pinyin keyboard's session + learner.
        .manage(ime::ImeBridge::boot())
        // Push notifications: APNs-compatible service for remote notifications
        .manage(push_notifications::PushNotificationState::new())
        // The `amos-app://` gateway: one custom-protocol handler for every system
        // asset the WebView may read — the compiled PWA index
        // (`amos-app://index/apps.json` + its icons) and any installed web-bundle
        // (`amos-app://<app-id>/…`). Tauri's own
        // `register_asynchronous_uri_scheme_protocol` **is** the mechanism (there
        // is no separate protocol plugin); reads run on the blocking pool so a
        // slow disk never stalls the WebView thread. See docs/pwa-index.md.
        .register_asynchronous_uri_scheme_protocol(amos_appstore::SCHEME, |ctx, request, responder| {
            let uri = request.uri().to_string();
            let app = ctx.app_handle().clone();
            // Detached on purpose: dropping the `JoinHandle` does not cancel the
            // task, and the responder is moved in and answers when the read ends.
            drop(tauri::async_runtime::spawn_blocking(move || {
                let (install_root, index_dir) = {
                    let bridge = app.state::<appstore::StoreBridge>();
                    (
                        bridge.web_install_dir().map(std::path::Path::to_path_buf),
                        appstore::pwa_index_dir(),
                    )
                };
                let reply =
                    appstore::serve_protocol_uri(install_root.as_deref(), index_dir.as_deref(), &uri);
                responder.respond(appstore::protocol_response(reply));
            }));
        })
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
            mic_permission::mic_permission_state,
            mic_permission::mic_permission_request,
            ai_bridge::get_android_apps,
            ai_bridge::launch_android_app,
            ai_bridge::get_android_app_icon,
            ai_bridge::android_lmk_tasks,
            android_lmk::android_lmk_debug,
            buttons::simulate_button,
            buttons::take_pending_hardware_button,
            wm::wm_open,
            wm::wm_focus,
            wm::wm_hide,
            wm::wm_close,
            wm::wm_home,
            wm::wm_set_shell_title,
            wm::wm_windows,
            wm::wm_layout_snapshot,
            desktop_features::desktop_features_disabled,
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
            clipboard_guest_link::clipboard_guest_status,
            ime::ime_status,
            ime::ime_key,
            ime::ime_backspace,
            ime::ime_clear,
            ime::ime_commit,
            ime::ime_fuzzy_toggle,
            ime::ime_fuzzy_preset,
            ime::ime_learning_clear,
            ime::ime_forget_last,
            store::store_get,
            store::store_set,
            store::store_remove,
            store::store_snapshot,
            note_export::notes_export_txt,
            media::media_provider_name,
            media::media_available_collections,
            media::media_grants,
            media::media_grant_read,
            media::media_grant_write,
            media::media_revoke,
            media::media_list,
            media::media_save,
            media::media_load,
            media::media_read_range,
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
            appstore::pwa_index_url,
            appstore::appstore_bundle_entry,
            appstore::csp_probe,
            telephony::telephony_dial,
            telephony::telephony_end,
            telephony::telephony_status,
            telephony::telephony_answer,
            telephony::telephony_simulate_incoming,
            telephony::telephony_start_recording,
            telephony::telephony_stop_recording,
            radio::radio_status,
            radio::radio_set,
            radio::radio_control,
            radio::radio_open_settings,
            radio::bluetooth_adapter_name,
            radio::bluetooth_rename_adapter,
            radio::bluetooth_paired_devices,
            radio::bluetooth_start_scan,
            radio::bluetooth_stop_scan,
            radio::bluetooth_scan_state,
            radio::bluetooth_pair,
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
            host_battery::system_host_battery,
            display::screen_state_set,
            display::screen_state_get,
            privacy_client::perm_authorize,
            privacy_client::perm_grant,
            privacy_client::perm_revoke,
            privacy_client::perm_granted,
            privacy_client::perm_recent_audit,
            privacy_client::perm_record_audit,
            privacy_client::perm_recent_trail,
            privacy_client::perm_grants_all,
            netguard::netguard_toggle,
            netguard::netguard_status,
            link::link_status,
            rag_client::rag_status,
            rag_client::rag_query,
            rag_client::rag_index,
            rag_client::rag_remove,
            sms::sms_status,
            sms::sms_snapshot,
            sms::sms_counts,
            sms::sms_messages,
            sms::sms_send,
            sms::sms_trash_add,
            sms::sms_trash_list,
            sms::sms_trash_restore,
            sms::sms_trash_purge,
            blocklist::blocklist_snapshot,
            blocklist::blocklist_add,
            blocklist::blocklist_remove,
            blocklist::blocklist_clear,
            blocklist::blocklist_set_unknown,
            blocklist::blocklist_check,
            blocklist::blocklist_status,
            blocklist::blocklist_request_role,
            taskmgr::taskmgr_snapshot,
            taskmgr::taskmgr_app_action,
            taskmgr::taskmgr_job_action,
            devcare::devcare_status,
            devcare::devcare_scan,
            devcare::devcare_clean,
            devcare::devcare_apps,
            devcare::devcare_permissions,
            devcare::devcare_report,
            devcare::devcare_uninstall,
            devcare::devcare_trail,
            devcare::devcare_memory,
            devcare::devcare_boost,
            devcare::devcare_storage,
            terminal::term_spawn,
            terminal::term_write,
            terminal::term_read,
            terminal::term_kill,
            terminal::term_resize,
            alarm_sched::scheduler_alarm_register,
            alarm_sched::scheduler_alarm_cancel,
            alarm_sched::scheduler_alarm_poll,
            alarm_sched::scheduler_alarm_open_settings,
            real_dial::real_dial,
            #[cfg(desktop)]
            wine::wine_is_available,
            #[cfg(desktop)]
            wine::wine_apps,
            #[cfg(desktop)]
            wine::wine_launch,
            #[cfg(desktop)]
            linux_apps::linux_is_available,
            #[cfg(desktop)]
            linux_apps::linux_apps,
            #[cfg(desktop)]
            linux_apps::linux_launch,
            airplay::airplay_available,
            airplay::airplay_discover,
            airplay::airplay_stop_discovery,
            airplay::airplay_get_devices,
            airplay::airplay_get_status,
            airplay::airplay_connect,
            airplay::airplay_disconnect,
            airplay::airplay_start_stream,
            airplay::airplay_stop_stream,
            airplay::airplay_set_volume,
            push_notifications::push_register_token,
            push_notifications::push_get_token,
            push_notifications::push_request_permission,
            push_notifications::push_get_permission,
            push_notifications::push_simulate_receive,
            push_notifications::push_get_badge,
            push_notifications::push_set_badge,
            push_notifications::push_get_history,
            push_notifications::push_mark_read,
            push_notifications::push_clear_history,
            push_notifications::push_get_statistics,
            push_notifications::push_get_status,
        ])
        .on_window_event(|window, event| {
            // Keep the layout model's screen equal to the **real** window area.
            // Only the screen window (the Launcher/main surface) defines that area:
            // every other window — including split panes, which this very handler's
            // `finish_layout` re-places — is positioned *inside* it, so reacting to
            // their resizes would feed the pane-writing loop back into itself.
            if !wm::is_screen_window(window.label()) {
                return;
            }
            // The event's **own** reading: at `ScaleFactorChanged` the window has
            // not been resized yet, so re-reading `inner_size()` there would pair
            // the new DPI with the old size.
            let Some((width, height, new_scale)) = wm::resize_reading(event) else {
                return;
            };
            let scale = match new_scale {
                Some(scale) => scale,
                None => window.scale_factor().unwrap_or(1.0),
            };
            let state = window.state::<WmState>();
            match state.sync_from_pixels(width, height, scale, window.app_handle()) {
                Ok(Some(snapshot)) => {
                    // A **shrunken** screen can leave app windows hanging outside it
                    // (the user dragged them there, or they were placed when the shell
                    // was bigger). Pull them back — read from the platform, so no
                    // host-side ledger can drift — and report how many moved.
                    match state.reclamp_windows(window.app_handle()) {
                        Ok(0) => {}
                        Ok(moved) => tracing::info!(
                            moved,
                            screen_w = snapshot.screen_w,
                            screen_h = snapshot.screen_h,
                            "app windows were pulled inside the new screen area"
                        ),
                        Err(e) => tracing::warn!(
                            target: "amos::wm",
                            error = %e,
                            "could not re-clamp app windows after the screen changed"
                        ),
                    }
                    // This measurement is post-application by construction (the event
                    // carries the size the window now has), so it is the authoritative
                    // answer to the boot-time shell-size request: say plainly whether the
                    // OS honoured it. The boot path's own read right after `set_size`
                    // cannot do this — it can still show the old size (measured on
                    // macOS: ~50 ms of 480×820 before the resize lands), which is
                    // exactly why the request is remembered instead of assumed.
                    // (REQ-A230)
                    let applied = amos_wm::layout::Size::new(snapshot.screen_w, snapshot.screen_h);
                    match state.note_applied_size(applied) {
                        Ok(Some(wm::ShellFitOutcome::Honoured { size })) => tracing::info!(
                            width = size.width,
                            height = size.height,
                            "the requested shell window size was applied"
                        ),
                        Ok(Some(wm::ShellFitOutcome::Adjusted { requested, applied })) => {
                            tracing::warn!(
                                requested_width = requested.width,
                                requested_height = requested.height,
                                applied_width = applied.width,
                                applied_height = applied.height,
                                "the OS applied a different shell window size than requested \
                                 (a display that cannot hold it, or a window-manager clamp)"
                            );
                        }
                        Ok(None) => {}
                        Err(e) => tracing::warn!(
                            target: "amos::wm",
                            error = %e,
                            "could not record the applied shell window size"
                        ),
                    }
                }
                Ok(None) => {}
                Err(e) => tracing::warn!(
                    target: "amos::wm",
                    error = %e,
                    "could not re-measure the OS window after a resize; \
                     the layout keeps its previous screen"
                ),
            }
        })
        .setup(|app| {
            // Desktop-shell capability switches (`AMOS_DESKTOP_SHORTCUTS` /
            // `AMOS_DOCK_CONTEXT_MENU`) are resolved **here**, where an environment
            // exists — the WebView has none, which is why these two documented
            // switches could never be applied before (REQ-A287). Reported as a boot
            // fact so an operator can see what the host actually resolved instead of
            // inferring it from whether a key chord "felt" ignored.
            {
                let disabled = desktop_features::disabled_from_env();
                if disabled.is_empty() {
                    tracing::info!(
                        "desktop shell capabilities: all enabled \
                         (neither AMOS_DESKTOP_SHORTCUTS nor AMOS_DOCK_CONTEXT_MENU set)"
                    );
                } else {
                    tracing::info!(
                        disabled = ?disabled,
                        "desktop shell capabilities disabled by the environment"
                    );
                }
                // Each variable owns one capability, so naming the *other* key in it has
                // no effect. That is a one-word mistake an operator cannot see from the
                // outside, so it is reported rather than left as a capability that
                // simply never moved.
                let stray = desktop_features::stray_vars(|k| std::env::var(k).ok());
                if !stray.is_empty() {
                    tracing::warn!(
                        vars = ?stray,
                        "a desktop-shell switch names the other capability's key; \
                         it has no effect there (each variable owns one capability)"
                    );
                }
            }
            // Arm the native clipboard ingest bus with the managed GlobalClipboard
            // so container-originated copies land in the shared buffer, and install
            // an announce hook so those ingests broadcast a metadata-only
            // `clipboard-changed` notice to foreground UIs (same as Webview writes).
            // A failure here is not noise: either the ingest bus was armed with a *different*
            // clipboard (container copies would land in the wrong buffer) or the announce hook
            // belongs to someone else (the UI would never be told). Both are once-per-boot
            // `OnceLock`s, so this can only fire when something really is duplicated.
            if let Err(e) = clipboard::arm_ingest(
                app.state::<Arc<clipboard::GlobalClipboard>>()
                    .inner()
                    .clone(),
            ) {
                tracing::warn!(
                    target: "amos::clipboard",
                    error = %e,
                    "clipboard ingest bus NOT armed with the managed buffer"
                );
            }
            let handle = app.handle().clone();
            if let Err(e) = clipboard::set_notifier(move |entry: &clipboard::ClipboardEntry| {
                if let Err(e) = handle.emit("clipboard-changed", clipboard::ClipboardNotice::from(entry)) {
                    // `emit` errors only for a *registered* listener (no listener is `Ok`).
                    tracing::warn!(
                        target: "amos::clipboard",
                        event = "clipboard-changed",
                        error = %e,
                        "container clipboard notice could not be delivered to the UI"
                    );
                }
            }) {
                tracing::warn!(
                    target: "amos::clipboard",
                    error = %e,
                    "clipboard announce hook NOT installed — container ingests will not notify the UI"
                );
            }
            // Guest-container clipboard link (host↔guest text sync): **env-gated and
            // inert by default** — it only dials when `AMOS_GUEST_CLIPBOARD_SOCKET`
            // names a socket, so desktop/CI is unaffected. When armed it installs the
            // audited mirror sink over the real Unix-socket transport and starts the
            // reconnecting ingest loop.
            let guest_link = clipboard_guest_link::activate_from_env();
            if guest_link.armed {
                tracing::info!("clipboard guest link armed: socket={:?}", guest_link.socket);
            } else {
                tracing::debug!("clipboard guest link inert: {}", guest_link.reason);
            }
            // A PC must not keep launching the shell as a handset slab: app windows
            // already opened at their class's size, but the **main** window came
            // from a static config value and was never adapted (REQ-A222). Only the
            // exact handset default is replaced — a size somebody chose is left
            // alone — and a failure is reported rather than silently ignored.
            {
                let handle = app.handle().clone();
                let state = app.state::<WmState>();
                match state.fit_shell_window(&handle) {
                    Ok(Some((was, amos_wm::form::ShellFit::Maximize))) => tracing::info!(
                        was_width = was.width,
                        was_height = was.height,
                        "requested a desktop-aligned (maximized) shell window; the next \
                         measurement reports the area the platform gave it"
                    ),
                    Ok(Some((was, amos_wm::form::ShellFit::Resize(now)))) => tracing::info!(
                        was_width = was.width,
                        was_height = was.height,
                        width = now.width,
                        height = now.height,
                        "requested this form factor's shell window size \
                         (the next measurement reports what the OS applied)"
                    ),
                    Ok(Some((_, amos_wm::form::ShellFit::Leave))) => tracing::debug!(
                        "shell window size left unchanged (the policy asked for nothing)"
                    ),
                    Ok(None) => tracing::debug!("shell window size left unchanged"),
                    Err(e) => tracing::warn!(
                        target: "amos::wm",
                        error = %e,
                        "could not size the shell window for this form factor"
                    ),
                }
            }
            // Measure the **real** OS window instead of keeping the layout's
            // fallback rectangle: the split geometry and the content-column signal
            // are derived from it, so an unmeasured host would describe a window
            // nobody has (REQ-A218). Reported, not silent: on failure the model
            // keeps the fallback and the log says so.
            {
                let handle = app.handle().clone();
                let state = app.state::<WmState>();
                match state.sync_window_layout(&handle) {
                    Ok(Some(_)) => {}
                    Ok(None) => tracing::debug!(
                        "layout screen unchanged on boot (or no screen window yet)"
                    ),
                    Err(e) => tracing::warn!(
                        target: "amos::wm",
                        error = %e,
                        "could not measure the OS window; the layout keeps its fallback screen"
                    ),
                }
            }
            // A **bare** (non-bundled) macOS binary is not a "regular" app: it has no
            // Dock presence and cannot come to the front by itself, so `set_focus()`
            // returns `Ok` while the user sees nothing (measured, REQ-A232). Ask for the
            // regular policy first — and report a refusal, because a platform that will
            // not treat this as an app must not be mistaken for a focused window.
            #[cfg(target_os = "macos")]
            if let Err(e) = app
                .handle()
                .set_activation_policy(tauri::ActivationPolicy::Regular)
            {
                tracing::warn!(
                    target: "amos::wm",
                    error = %e,
                    "could not make this process a regular macOS app; the shell window \
                     may open behind other windows"
                );
            }
            // The model starts with the Launcher **focused** (`amos-wm` asserts it) and
            // this adapter documents `FocusChanged(Some(id)) → set_focus()`, but nothing
            // ever told the OS at boot: a shell started from a background process (a
            // terminal, a script, CI-driven launch) stayed behind every other app — the
            // window rendered and the user saw nothing (measured on macOS: `frontmost`
            // was false with the editor in front — REQ-A232). Do it **after** the resize
            // and the measurement, so the window comes forward at its final size.
            {
                let handle = app.handle().clone();
                let state = app.state::<WmState>();
                match state.focus_launcher(&handle) {
                    // Only say "focused" when the platform confirms it.
                    Ok(wm::LauncherFocus::Focused) => tracing::info!(
                        "the shell window is focused (the model's starting state, confirmed by the platform)"
                    ),
                    Ok(wm::LauncherFocus::Refused) => tracing::warn!(
                        target: "amos::wm",
                        "the platform did not hand focus to the shell window; it is on screen but \
                         may sit behind other apps (a non-bundled macOS binary has no app bundle \
                         to activate — build/run the `.app`, or bring it forward yourself)"
                    ),
                    Ok(wm::LauncherFocus::NoWindow) => tracing::warn!(
                        target: "amos::wm",
                        "no shell window to focus at boot; the UI may be invisible to the user"
                    ),
                    Err(e) => tracing::warn!(
                        target: "amos::wm",
                        error = %e,
                        "could not bring the shell window to the front; it may open behind other windows"
                    ),
                }
            }
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
            // Forward the daemon `TelemetrySpyService.Watch` stream (high-severity
            // egress audit hits) to the WebView as `telemetry-spy-hit` so the shell
            // can surface an exfiltration warning live (reconnects if the daemon
            // starts; quiet until a real `audit`-feature capture producer is wired).
            telemetry_spy::spawn_telemetry_spy_watch(app.handle().clone());
            // Broadcast real-time sensor changes (new IMU sample / camera frame /
            // energy-mode switch) from the System UI's SensorHost stream bus to the
            // WebView as `sensor-data`, so a live sensor tile updates without
            // polling. Fires for *every* producer: WebView `record_*` commands,
            // on-device `android_glue` IMU/frame callbacks and host feeders all
            // land on the shared bus the host observes.
            {
                let host = app.state::<sensor_host::SensorHost>();
                let handle = app.handle().clone();
                let notifier = Arc::new(move |ev: sensor_host::SensorHostEvent| {
                    // A failed delivery means a registered sensor listener missed this sample
                    // (no listener is `Ok` in Tauri) — the live tiles would silently freeze.
                    if let Err(e) = handle.emit(sensor_host::SENSOR_DATA_EVENT, ev) {
                        tracing::warn!(
                            target: "amos::sensors",
                            event = sensor_host::SENSOR_DATA_EVENT,
                            error = %e,
                            "sensor data could not be delivered to the UI"
                        );
                    }
                });
                host.set_notifier(notifier);
            }
            // On-device: arm the shared sensor bus with the managed SensorHost's
            // producer so the Kotlin SensorGlue/CameraGlue upcalls (recordImu /
            // recordFrame) land in the same LiveSensorProvider SensorHost reads —
            // and the real-time `sensor-data` broadcast fans out to the WebView.
            #[cfg(feature = "android")]
            {
                let host = app.state::<sensor_host::SensorHost>();
                // A failed arm means the Kotlin producer upcalls (recordImu /
                // recordFrame) have nowhere to land: the live sensor and camera feed
                // would be dead with no other symptom, so the failure is reported
                // instead of discarded (REQ-A187 — the discard gate could not see this
                // line because it ran clippy without `--features android`).
                if let Err(e) = android_glue::arm(host.producer()) {
                    tracing::warn!(
                        target: "amos::android",
                        error = %e,
                        "android glue bus not armed — live sensor/camera upcalls are dropped"
                    );
                }
            }
            // On device, arm the torch device-seam UI pusher so OS-driven torch
            // changes (TorchCallback) reach the System UI live via the shared
            // store's `store-updated` event (status bar + open control-center).
            #[cfg(feature = "android")]
            flashlight::install_ui_pusher(app.handle().clone());
            // On device, hand the SMS seam an AppHandle so the Kotlin SmsGlue's
            // SMS_RECEIVED receiver can push `sms-received` → the Messages screen
            // refreshes live instead of on a manual pull.
            #[cfg(feature = "android")]
            sms::install_events(app.handle().clone());
            // Point the blocklist at its JSON file so the rules survive restarts
            // (the Android CallScreeningService can also configure this itself
            // when the system cold-starts the process for an incoming call).
            if let Ok(dir) = app.path().app_data_dir() {
                // On Android, Tauri's `app_data_dir()` resolves to
                // `Context.getDataDir()` (…/<pkg>), while the Kotlin glue persists
                // under `Context.getFilesDir()` (…/<pkg>/files). Configure the SAME
                // directory the glue uses: two paths would silently keep two
                // different rule stores, so rules added in the UI would never reach
                // the call-screening service (and `configure` would keep wiping the
                // in-memory list on every switch).
                #[cfg(feature = "android")]
                let dir = dir.join("files");
                blocklist::shared().configure(blocklist::file_in(&dir));
                // The SMS trash lives next to the blocklist (same atomic-write,
                // corrupt-file-logged policy; same glue-visible directory).
                sms::trash_shared().configure(sms::trash_file_in(&dir));
                // The IME profile (fuzzy prefs + learned pins) shares that dir too,
                // so the on-screen keyboard's preferences survive a restart.
                app.state::<ime::ImeBridge>().configure(ime::file_in(&dir));
            } else {
                // No persistent directory: the IME profile (like the blocklist and
                // the SMS trash) stays in memory for this run. Say so, instead of
                // letting the user believe preferences were saved.
                tracing::warn!(
                    target: "amos::ime",
                    "app data dir unavailable — input-method preferences and learning will not persist"
                );
            }
            // Real in-call bridge (default-dialer / InCallService): give the Rust side
            // an AppHandle so Kotlin-pushed real call states reach the WebView as
            // `telephony-event`, and so telephony answer/end can drive the real call.
            #[cfg(feature = "android")]
            incall::set_app(app.handle().clone());
            // Physical camera key → AmOS Home: hand the seam an AppHandle so the
            // MainActivity's intercepted camera key can route as Home.
            #[cfg(feature = "android")]
            buttons::install_android_app(app.handle().clone());
            // Device care on-device: hand the seam an AppHandle so the Kotlin
            // `DevCareGlue`'s JNI attach can install the real `PackageManager` /
            // `StatFs` / app-private-filesystem backend into the managed bridge.
            #[cfg(feature = "android")]
            devcare_device::install_android_app(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running amos System UI");
}
