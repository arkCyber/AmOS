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
/// The Android **system IME** (`InputMethodService`) glue: JNI trampolines the
/// Kotlin `AmosImeService` calls so a real Android app can type with the `amos-ime`
/// pinyin engine (`docs/input-method.md` §System IME).
#[cfg(feature = "android")]
pub mod android_ime;
pub mod android_lmk;
pub mod appstore;
pub mod assistant_voice;
pub mod ble;
/// Spam blocking (calls + SMS): rule storage, SMS filtering and the Android
/// call-screening JNI hook.
pub mod blocklist;
pub mod buttons;
/// Cellular signal strength (the missing host half of the honest bars tile):
/// `TelephonyManager` presence + signal level, folded into the frontend's
/// `RadioSignal` seam. See the module header.
pub mod cellular;
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
pub mod files;
pub mod podcast;
// The macOS Dock badge + attention request. Written ahead of its consumer: nothing
// paints a badge yet, but the host API is registered (REQ-A389).
pub mod dock_badge;
/// Typed error envelope shared across the System UI Rust core. See
/// [`error::ErrorCode`] for the wire vocabulary and [`error::AmosError`] for the
/// serializable failure shape returned by every `#[tauri::command]`.
pub mod error;
pub mod flashlight;
pub mod host_battery;
/// Host filesystem access (REQ-A526 follow-up: real filesystem chokepoint).
///
/// `host_fs` is the bridge that turns the WebView sandbox's "no real filesystem"
/// posture into typed commands the WebView can call. The allowed root is
/// `AMOS_HOST_FS_ROOT` at process start; every command goes through one
/// canonicalize-then-starts_with chokepoint before any syscall. See the module
/// header for the wire shape and the env-var contract.
pub mod host_fs;
pub mod host_log;

/// The **embedded frontend bundle's fingerprint** — which UI this binary carries
/// (REQ-A425).
///
/// Written by `build.rs` (see its module docs for the staleness this exists to stop) and
/// `include_str!`d precisely so that a changed bundle makes this crate dirty: without it,
/// `generate_context!`'s embedding has no tracked input and a release binary silently
/// keeps shipping the previous `frontend-ts/dist`. It is also the honest answer to "which
/// UI is in this build?", which the boot log states when the bundle is the thing being
/// loaded. `"absent"` means no bundle existed at build time (a fresh checkout, or the dev
/// server path) — a state to report, not to guess about.
pub const EMBEDDED_FRONTEND_FINGERPRINT: &str =
    include_str!(concat!(env!("OUT_DIR"), "/embedded-frontend.fingerprint"));

/// Input method (IME): the System UI's on-screen pinyin keyboard. `amos-ime` owns
/// the engine; this bridge owns the session + the `amos-ime.json` profile.
pub mod ime;
#[cfg(feature = "android")]
pub mod incall;
pub mod interpret;
#[cfg(feature = "android")]
pub mod jni_glue;
pub mod link;
pub mod location_permission;
pub mod mail;
pub mod media;
pub mod mic_permission;
pub mod netguard;
pub mod note_export;
pub mod ota;
pub mod privacy_client;
pub mod push_notifications;
pub mod radio;
pub mod rag_client;
pub mod real_dial;
pub mod rotation;
pub mod screenshot;
pub mod sensor_host;
pub mod sensors;
// Shortcut automation triggers: the wall-clock side of "run this shortcut at 08:00".
// The WebView owns *what* runs (`lib/shortcuts.ts`); this module owns *when*, so a
// trigger still fires with no window open (see the module header for the split).
pub mod shortcut_triggers;
// Spaces (virtual desktops): the manager plus its Tauri commands. The shell mounts
// `SpacesPanel`, so these have to be compiled and registered (REQ-A389).
pub mod sms;
pub mod sms_permission;
pub mod spaces;
pub mod spaces_commands;
// Stage Manager: the rail that parks windows off-stage, plus the one-shot tidy. The
// geometry is `amos-wm`'s; this module is the ledger half and the Tauri commands the
// desktop shell calls (REQ-A1545/A1546).
pub mod stage;
// System-level screen recording: spawn the platform tool, keep the child between
// commands, seal on stop and confirm the file (REQ-A1578).
pub mod screen_record;
// The Android half of screen recording: `MediaProjection` lives in Kotlin
// (`android-glue/…/ScreenRecordGlue.kt`), so the host is a thin typed seam over it rather
// than the process-owning state machine the macOS path needs (REQ-A1582 / F-DEV-141).
#[cfg(feature = "android")]
pub mod screen_record_android;
pub mod store;
pub mod system;
pub mod taskmgr;
pub mod telemetry_spy;
pub mod telephony;
pub mod terminal;
pub mod translate;
pub mod tts;
pub mod watch_backoff;
/// WebMan browser: the **real** download pipeline (ureq streaming to disk, with
/// progress events, cancellation and a persistent cookie jar). See the module
/// header for what is real and what is still an `<iframe>` limitation.
pub mod webman_download;
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
// Host power / session actions (restart / shut down / sleep) — REQ-A515. Like the two
// modules above, the commands are registered under `#[cfg(desktop)]` and **availability is
// answered at runtime** by `session::invocation` (a host with no `osascript`/`pmset`/
// `systemctl` gets a named `amos.session.unsupported_host` refusal, never a missing command).
#[cfg(desktop)]
pub mod session;
// Call-recording storage and metadata (both halves of call recording).
//
// **Both halves are wired (REQ-A1334 → REQ-A1579).** `recordings_list` / `recording_delete` /
// `recordings_capture_status` below are invoked by the recordings settings page, so the storage
// contract authored under REQ-A480 finally has a reader; and on Android the file a row points at
// is now really produced — `AmosInCallService.setRecording` drives a `MediaRecorder` and
// `incall.rs` files the finished recording through `add_recording`. `recordings_capture_status`
// answers from **runtime** facts (this build / a bound default dialer / granted `RECORD_AUDIO`),
// so the page says why capture is off instead of letting an empty list imply recordings exist.
// REQ-A480's orphan entry in `scripts/rust-unwired-baseline.json` was removed once these callers
// landed. The `crates/amos-telephony` provider still refuses `start_recording` by name, but that
// crate is not linked into the APK — see its module header. This comment used to say "used by
// telephony" before that, which was false — a comment is a claim; this one now has a caller
// behind it.
pub mod recording;
// The native menu bar (Aqua Global Menu on macOS) — REQ-A275.
//
// **No `cfg` here, on purpose, and this is a fix rather than an oversight.** All three
// modules below used to be declared `#[cfg(target_os = "macos")]`, while their *call
// sites* were not: `menu::menu_set_locale` / `menu::menu_set_shortcuts` sit in the
// `generate_handler!` list below, `menu::sync_window_items` in the window-event handler,
// and `wm.rs` imports `window_background` / `window_state` at its top. A `use`/path to a
// module that the cfg removed is E0432/E0433 — so the crate did **not compile off macOS
// at all**, which is the platform the only CI runner uses (`ubuntu-24.04`). Measured by
// making these three predicates false on a macOS host (the same shape a Linux build sees):
// 13 errors, all of them exactly these module references.
//
// Each module is cross-platform **by its own design**, so the gate was the defect and not
// a platform constraint:
//   * `menu` — every macOS-only item has a `#[cfg(not(target_os = "macos"))]` twin
//     (`install`, `on_menu_event`, `sync_window_items`, `set_locale`, `apply_accelerators`),
//     written so the wiring is one line on every target (`menu.rs` says so itself);
//   * `window_background` — pure (mode + OS answer → colour) and uses **no** Tauri API;
//   * `window_state` — a JSON ledger plus `outer_position` / `outer_size` / `is_visible` /
//     `app_data_dir`, all of which exist on every target in Tauri 2.11 (they answer `Err`
//     where unsupported, which the module already treats as "nothing to remember").
//
// Honest boundary: this restores *compilation* off macOS. It is not a claim that the
// desktop shell has been run on Linux/Windows — no such run exists (see `docs/GATES.md`).
pub mod menu;
// The **system tray** (REQ-A864) — the status item that keeps AmOS reachable while no shell
// window is in front. Declared with no `cfg`, like `menu` above and for the same reason:
// `install` has a `#[cfg(not(desktop))]` twin, so the boot path is one line everywhere,
// while everything that touches `tauri::tray` sits behind `#[cfg(desktop)]` — the feature
// `tauri/tray-icon` is compiled only for desktop targets (see `Cargo.toml`), so a mobile
// build must not reach into that module at all.
pub mod tray;
// The host **print** path (REQ-A869) — File ▸ Print / ⌘P, and the focused-window rule that
// decides what is printed. Declared with no `cfg`, like `menu` / `tray` above and for the
// same reason: `print_document` is registered on **every** target and answers a named
// refusal (`amos.print.unsupported_platform`) where no print dialog exists, so the shell
// never has to tell "this platform cannot print" apart from "the command is missing" —
// while everything that touches `WebviewWindow::print()` (itself `#[cfg(desktop)]` in
// tauri 2.11) sits behind `#[cfg(desktop)]` inside the module.
pub mod print;
// Window title-bar colour (REQ-A326; the decision is pure — no Tauri API).
pub mod window_background;
// Persist window position/size across launches (REQ-A249).
pub mod window_state;

use ai_bridge::AiBridge;
use std::sync::Arc;
use store::SharedStore;
use tauri::{Emitter, Manager};
use wm::{SystemContext, WmState};

/// How often the geometry-memory poller asks the store to write (REQ-A478).
///
/// Above the store's own 250 ms debounce, so a drag still collapses into one write per
/// debounce window, and short enough that letting go of a window is reflected on disk within
/// about a second. See the comment at the `spawn` in `run` for why a poller is needed at all.
const FLUSH_TICK_MS: u64 = 500;

/// Remember an app window's rectangle (REQ-A478), skipping the cases where the geometry is
/// not the user's choice.
///
/// Called for the **platform events** a user's drag produces (`Moved` / `Resized`), never for
/// geometry this host itself applied: the writer is the OS telling us what the user did.
///
/// Deliberate exclusions, each because the rectangle would be a lie:
/// * a **split pane** is placed by the split session (see `apply_split_to_real`) — its half
///   screen is the split's shape, not the user's choice;
/// * a rectangle the user dragged **off the screen** is still written (it is what they did),
///   but it is bounded by `sanitize` (`MAX_COORD`) and clamped into the screen when it is
///   used again — `WmState::reclamp_windows` owns the same rule for a live window.
///
/// One correction is applied *before* the write rather than after it: a rectangle that
/// covers the Stage Manager rail is pushed out of it first (REQ-A1564), and it is the
/// corrected rectangle that is remembered. See the call to `stage_clamp_moved` below.
///
/// A store that is not armed drops the write silently by design (`queue`'s contract) — and
/// `install` logs whether it is armed, so "it forgot my window" stays diagnosable.
fn remember_window_geometry<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let Some(state) = window.app_handle().try_state::<WmState>() else {
        return;
    };
    // A split pane's rectangle belongs to the split.
    if state.is_in_split(window.label()).unwrap_or(false) {
        return;
    }
    let Some(mut captured) = window_state::snapshot(window) else {
        tracing::debug!(
            target: "amos::window_state",
            label = %window.label(),
            "window geometry could not be read; nothing remembered this time"
        );
        return;
    };
    // **Clamp, then remember** (REQ-A1564). The order is the whole point of this call site:
    // the Stage rail is protected by geometry everywhere the host places a window, so the
    // only way a window covers it is a drag — and a drag that ended inside the band would
    // otherwise be written to disk as the window's position and restored there at the next
    // launch, where no drag exists to explain it. `stage_clamp_moved` rewrites `captured`
    // with the rectangle it applied, because re-reading the platform here races its own
    // asynchronous `set_position` and can hand back the very position being corrected.
    //
    // `Err` is a poisoned `WmState` lock, and the uncorrected rectangle is remembered: the
    // honest outcome, since the host could not decide otherwise.
    match state.stage_clamp_moved(window, window.label(), &mut captured) {
        Ok(true) => tracing::info!(
            target: "amos::wm",
            window = %window.label(),
            "a moved window was pushed out of the Stage rail"
        ),
        Ok(false) => {}
        Err(e) => tracing::warn!(
            target: "amos::wm",
            window = %window.label(),
            error = %e,
            "the Stage rail's exclusion could not be decided for a moved window"
        ),
    }
    let Some(store) = window
        .app_handle()
        .try_state::<window_state::WindowStateStore>()
    else {
        return;
    };
    store.queue(window.label(), captured);
    // Flush on the same beat: the store's own debounce turns a drag's storm of events into
    // one write per `DEBOUNCE_MS`, so this needs no timer of its own.
    let written = store.flush_due();
    if written > 0 {
        tracing::debug!(
            target: "amos::window_state",
            written,
            "window geometry remembered"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::expect_used)]
pub fn run() {
    // Boot boundary: if the GUI event loop cannot start, exiting the process is the
    // intended loud failure (nothing sensible can run without it). This is the
    // single allowed expect in production — everything else is gated (P0-1).
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

    // The IME bridge is managed here *and* published process-wide: the Android
    // system IME (`crate::android_ime`) is bound by the platform in this same
    // process and must drive the very same engine, learner and profile file as the
    // WebView's on-screen keyboard (REQ-A1880). `install_shared` answers with the
    // instance that *is* shared: if the platform cold-started this process for the
    // IME service, the service already published its engine (`shared_or_boot`) and
    // this boot is discarded by adoption — otherwise the host would manage a second
    // learner over the same profile file and the two would overwrite each other's
    // picks. The managed handle stays the type every `ime_*` command injects.
    let ime_bridge = ime::install_shared(ime::ImeBridge::boot());

    tauri::Builder::default()
        .manage(AiBridge::new())
        .manage(screen_record::ScreenRecorder::new())
        .manage(airplay::AirPlayState::new())
        .manage(assistant_voice::VoiceSession::new())
        .manage(assistant_voice::DeviceMic::new())
        .manage(WmState::new())
        // REQ-A478: the window-geometry memory (REQ-A249) — **wired at last**. It had been
        // declared and unit-tested since it was written, with **no production caller** at
        // all: nothing constructed the store, nothing recorded a move, and no window ever
        // came back where it was left (its own tests were the only callers, which is why
        // `rust-unwired-scan` — "every `pub fn` needs a caller" — stayed green). `install`
        // points it at `app_data_dir()` in `setup`; the window-event handler records moves
        // and resizes, and `WmState::apply`'s `Created` branch restores them.
        .manage(window_state::WindowStateStore::new())
        .manage(SystemContext::new())
        .manage(host_fs::HostFsState::new())
        .manage(alarm_sched::AlarmSchedState::new())
        .manage(shortcut_triggers::ShortcutTriggerState::new())
        .manage(clipboard.clone())
        // The Space ledger is persisted through the same store the rest of the shell
        // uses, so a restart restores the spaces (and the default space when there is
        // nothing saved yet).
        .manage(std::sync::Mutex::new(spaces::SpaceManager::load(
            &shared_store,
        )))
        .manage(webman_download::WebmanDownloads::boot())
        .manage(dock_badge::DockBadgeState::new())
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
        .manage(podcast::PodcastBridge::new())
        .manage(sensor_host::SensorHost::new())
        .manage(sms::SmsBridge::boot())
        .manage(sms::trash_shared())
        .manage(blocklist::shared())
        .manage(devcare::DevCareBridge::new())
        // System update (OTA) decision layer: the Settings「关于本机」check.
        .manage(ota::OtaBridge::new())
        // Input method (IME): the on-screen pinyin keyboard's session + learner.
        // The same instance is published process-wide for the Android system IME.
        .manage(ime_bridge)
        // Push notifications: APNs-compatible service for remote notifications
        .manage(push_notifications::PushNotificationState::new())
        // The robot console's heartbeat forwarder handle — kept so its never-ending
        // `StreamHeartbeats` task can be aborted when the console closes.
        .manage(link::HeartbeatWatch::default())
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
        .register_asynchronous_uri_scheme_protocol(amos_media::SCHEME, |ctx, request, responder| {
            let uri = request.uri().to_string();
            // The `Range` header is the whole point of this gateway: a media element asks
            // for `bytes=…` and gets a bounded `206` instead of the file (docs/media.md §6).
            // It is read here — the handler owns the request — and parsed by
            // `amos_media::serve`, never by hand.
            let range = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let app = ctx.app_handle().clone();
            // Detached on purpose, as above: the responder answers when the read ends.
            drop(tauri::async_runtime::spawn_blocking(move || {
                let bridge = app.state::<media::MediaBridge>();
                let reply = amos_media::serve(bridge.manager(), &uri, range.as_deref());
                responder.respond(media::protocol_response(reply));
            }));
        })
        .invoke_handler(tauri::generate_handler![
            webman_download::webman_download_start,
            webman_download::webman_download_cancel,
            webman_download::webman_cookies_list,
            webman_download::webman_cookies_clear,
            dock_badge::dock_badge_set,
            dock_badge::dock_request_attention,
            spaces_commands::spaces_list,
            spaces_commands::spaces_active,
            spaces_commands::spaces_switch,
            spaces_commands::spaces_create,
            spaces_commands::spaces_delete,
            spaces_commands::spaces_rename,
            spaces_commands::spaces_move_window,
            spaces_commands::spaces_unfile_window,
            // Stage Manager (REQ-A1545/A1546). The rail view is *derived* from the
            // `wm-changed` snapshot, so these commands add no new event.
            stage::stage_snapshot,
            stage::stage_set_enabled,
            stage::stage_park,
            stage::stage_bring,
            stage::stage_arrange,
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
            location_permission::location_permission_state,
            location_permission::location_permission_request,
            sms_permission::sms_permission_request,
            ai_bridge::get_android_apps,
            ai_bridge::launch_android_app,
            ai_bridge::get_android_app_icon,
            ai_bridge::android_lmk_tasks,
            android_lmk::android_lmk_debug,
            buttons::simulate_button,
            buttons::take_pending_hardware_button,
            wm::wm_open,
            wm::wm_new_window,
            wm::wm_cycle_app,
            wm::wm_focus,
            wm::wm_hide,
            wm::wm_minimize,
            wm::wm_zoom,
            wm::wm_maximize,
            wm::wm_fullscreen,
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
            wm::wm_snap,
            wm::wm_displays,
            wm::wm_split_candidates,
            wm::wm_split_demo,
            wm::wm_pane_rects,
            wm::wm_slide_over_rect,
            wm::system_set_context,
            wm::system_clear_context,
            wm::system_peek_context,
            clipboard::clipboard_write,
            clipboard::clipboard_read,
            clipboard::clipboard_history,
            clipboard::clipboard_clear,
            clipboard::clipboard_subscribe,
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
            ime::ime_system_status,
            ime::ime_system_open_picker,
            ime::ime_system_open_settings,
            store::store_get,
            store::store_set,
            menu::menu_set_locale,
            menu::menu_set_shortcuts,
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
            media::media_stream_url,
            files::files_preview_bytes,
            files::files_bundle_export,
            files::files_bundle_import,
            files::files_cloud_validate,
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
            mail::mail_status,
            mail::mail_list,
            mail::mail_search,
            mail::mail_inbox,
            mail::mail_read,
            mail::mail_send,
            mail::mail_set_flagged,
            mail::mail_set_answered,
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
            appstore::pwa_open_remote,
            appstore::appstore_bundle_entry,
            appstore::csp_probe,
            podcast::podcast_backend_name,
            podcast::podcast_subscriptions,
            podcast::podcast_subscribe,
            podcast::podcast_add,
            podcast::podcast_refresh,
            podcast::podcast_feed,
            podcast::podcast_unsubscribe,
            podcast::podcast_set_position,
            podcast::podcast_set_speed,
            podcast::podcast_set_played,
            podcast::podcast_download,
            podcast::podcast_download_state,
            podcast::podcast_remove_download,
            telephony::telephony_dial,
            telephony::telephony_end,
            telephony::telephony_status,
            telephony::telephony_backend_kind,
            telephony::telephony_answer,
            telephony::telephony_simulate_incoming,
            telephony::telephony_start_recording,
            telephony::telephony_stop_recording,
            telephony::telephony_set_muted,
            telephony::telephony_set_speaker,
            telephony::telephony_set_hold,
            telephony::telephony_play_dtmf,
            // The call-recording ledger's real readers (REQ-A1334). Until this round the
            // module had none and was recorded as an orphan; the capture half is still
            // device-pending, and `recordings_capture_status` is how the page is told so.
            recording::recordings_list,
            recording::recording_delete,
            recording::recordings_capture_status,
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
            rotation::rotation_get,
            rotation::rotation_set,
            cellular::cellular_signal,
            ble::ble_connect,
            ble::ble_disconnect,
            ble::ble_discover_services,
            ble::ble_read,
            ble::ble_write,
            ble::ble_subscribe,
            ble::ble_unsubscribe,
            ble::nfc_status,
            ble::nfc_start_dispatch,
            ble::nfc_stop_dispatch,
            ble::nfc_format_tag,
            ble::nfc_write_message,
            ble::nfc_read_bytes,
            ble::biometric_available,
            ble::biometric_authenticate,
            sensors::sensor_snapshot,
            sensors::sensor_set_mode,
            sensors::sensor_acquire,
            sensor_host::sensor_host_snapshot,
            sensor_host::sensor_host_set_mode,
            sensor_host::sensor_host_record_imu,
            sensor_host::sensor_host_record_vitals,
            sensor_host::sensor_host_record_frame,
            sensor_host::sensor_host_record_video,
            sensor_host::sensor_host_acquire,
            system::system_health,
            host_battery::system_host_battery,
            screenshot::screenshot_capture,
            // System-level screen recording (REQ-A1578). Capability is a plain value
            // (a fact, not a failed read); start/stop share one recorder slot.
            screen_record::screen_record_start,
            screen_record::screen_record_stop,
            screen_record::screen_record_status,
            screen_record::screen_record_capability,
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
            link::link_publish,
            link::link_topics,
            link::link_watch_heartbeats,
            link::link_stop_heartbeats,
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
            host_fs::host_fs_root_status,
            host_fs::host_fs_read_dir,
            host_fs::host_fs_read_text,
            host_fs::host_fs_read_bytes,
            host_fs::host_fs_write_text,
            host_fs::host_fs_write_bytes,
            host_fs::host_fs_stat,
            host_fs::host_fs_create_dir,
            host_fs::host_fs_rename,
            host_fs::host_fs_remove,
            host_fs::host_fs_copy,
            host_fs::host_fs_watch_subscribe,
            host_fs::host_fs_watch_unsubscribe,
            host_fs::host_fs_watch_list,
            alarm_sched::scheduler_alarm_register,
            alarm_sched::scheduler_alarm_cancel,
            alarm_sched::scheduler_alarm_poll,
            alarm_sched::scheduler_alarm_open_settings,
            shortcut_triggers::shortcuts_trigger_sync,
            shortcut_triggers::shortcuts_trigger_poll,
            real_dial::real_dial,
            real_dial::telephony_real_dial_status,
            real_dial::telephony_default_dialer_status,
            real_dial::telephony_request_default_dialer,
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
            #[cfg(desktop)]
            session::session_restart,
            #[cfg(desktop)]
            session::session_shutdown,
            #[cfg(desktop)]
            session::session_sleep,
            // The shell's Apple menu asks for the platform About panel (REQ-A796). Registered
            // on every desktop target — the command answers `unsupported_host` where the
            // platform has no such panel, rather than being absent (`session.rs` rule 2).
            #[cfg(desktop)]
            menu::shell_about_panel,
            // File ▸ Print / ⌘P (REQ-A869). **Not** under `#[cfg(desktop)]`, unlike the
            // desktop-only surfaces above: a print dialog is a desktop concept, but
            // "this host has no print dialog" is an *answer*, and a mobile build that
            // omitted the command would hand the shell Tauri's opaque "command not found"
            // where it could say `amos.print.unsupported_platform` (`print.rs` header,
            // rule 2).
            print::print_document,
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
            push_notifications::push_delete_notification,
            push_notifications::push_clear_history,
            push_notifications::push_get_statistics,
            push_notifications::push_get_status,
            ota::ota_status,
            ota::ota_check,
            ota::ota_install,
        ])
        .on_window_event(|window, event| {
            // REQ-A433: the window-related menu items (Close / Minimize / Zoom / Enter Full
            // Screen) can only act on a focused app window, so the bar has to follow the
            // platform's own focus events — that is the one signal that fires for *every*
            // way focus can move (our `wm_focus`, a click on another window, a window that
            // closes and hands the key over). Nothing here guesses: `sync_window_items`
            // asks the platform and the model, in that order.
            if matches!(event, tauri::WindowEvent::Focused(_)) {
                menu::sync_window_items(window.app_handle());
            }
            // Keep the layout model's screen equal to the **real** window area.
            // Only the screen window (the Launcher/main surface) defines that area:
            // every other window — including split panes, which this very handler's
            // `finish_layout` re-places — is positioned *inside* it, so reacting to
            // their resizes would feed the pane-writing loop back into itself.
            if !wm::is_screen_window(window.label()) {
                // REQ-A478: an **app window** that the user moves or resizes is remembered
                // (REQ-A249), so it opens where it was left. Two deliberate exclusions:
                //
                //   * the Launcher is the *screen* (the branch below owns it) — remembering
                //     "where the shell was" would fight the class's `ShellFit` rule;
                //   * a window that is currently a **split pane** is placed by the split
                //     (`apply_split_to_real`), so its half-screen rectangle is the split's
                //     geometry, not the user's choice — restoring it later would open a
                //     window at half size with no split to explain it (the same reasoning
                //     `zoomable_window` uses to refuse a pane).
                if matches!(
                    event,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                ) {
                    remember_window_geometry(window);
                }
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
            // **Which frontend will the WebView load?** (REQ-A421) A compile-time fact
            // (`tauri::is_dev() == !cfg!(feature = "custom-protocol")`) decides between the
            // embedded `frontendDist` and `build.devUrl` — and it fails *silently* at
            // runtime: the window is blank because nothing serves the dev URL, while every
            // gate stays green (measured 2026-09-18: `scripts/run-ui-release.sh` produced a
            // white 1 176-colour window this way). Stated once at boot so a blank window
            // comes with the line that explains it.
            if tauri::is_dev() {
                tracing::warn!(
                    target: "amos::shell",
                    dev_url = app
                        .config()
                        .build
                        .dev_url
                        .as_ref()
                        .map(|u| u.to_string())
                        .as_deref()
                        .unwrap_or("(unset)"),
                    "the WebView loads the DEV url, not the embedded bundle (this build has \
                     no tauri `custom-protocol` feature) — if the window is blank, nothing \
                     is serving that url"
                );
            } else {
                tracing::info!(
                    target: "amos::shell",
                    bundle = EMBEDDED_FRONTEND_FINGERPRINT.trim(),
                    "the WebView loads the embedded frontend bundle (production mode)"
                );
            }
            // Re-apply the stored rotation lock / forced-orientation intent. An
            // Activity's requested orientation does not survive a process restart,
            // so a lock the user set must be re-applied here or the display would
            // silently unlock. Desktop is an honest no-op (no orientation control).
            {
                let store = app.state::<SharedStore>();
                rotation::apply_persisted(&store);
            }
            // Re-apply the stored Stage Manager mode (REQ-A1755). It is a **preference**
            // (`docs/stage-manager.md` §3.2), so `stage_set_enabled` persists it and this is
            // what makes it outlive a restart — without it the mode silently reset to OFF
            // every launch, which is exactly what `ErrorCode::StagePersistFailed` names.
            // Seeding it here, before the shell reads `LayoutSnapshot::rail_width`, means the
            // very first placement already knows the stage's width. A stored `true` on a
            // class with no rail is refused by `set_stage_enabled` and only warned about
            // (`apply_persisted`), never fatal to the launch.
            {
                let store = app.state::<SharedStore>();
                stage::apply_persisted(&store, &app.state::<WmState>());
            }
            // Install the system tray (REQ-A864) — the menu bar's counterpart on the way
            // *out*: the menu bar is how a user reaches the shell while it is in front, the
            // tray is how they reach it when it is not. Gated `desktop` because that is the
            // predicate `tauri::tray` itself is gated by (and the one `tray::install`'s twin
            // answers to), and the failure is **reported**: a tray that silently is not there
            // leaves a build that looks exactly like this call was never written.
            #[cfg(desktop)]
            {
                if let Err(e) = tray::install(app.handle()) {
                    tracing::warn!(
                        target: "amos::tray",
                        error = %e,
                        "installing the system tray failed; the app runs without one"
                    );
                }
            }
            // Install the native macOS menu bar (REQ-A418). `menu::install` is
            // documented as a no-op off macOS, but the **module** is `cfg(target_os="macos")`,
            // so the call site MUST be gated by the same predicate — a non-macOS build
            // (Android, iOS, Linux, Windows) would otherwise reference a missing module.
            // Wired here, once, with a *reported* failure (a menu that silently is not
            // there is the same defect class as a control that does nothing).
            #[cfg(target_os = "macos")]
            {
                if let Err(e) = menu::install(app.handle()) {
                    tracing::warn!(
                        target: "amos::menu",
                        error = %e,
                        "installing the native menu bar failed; the app runs without it"
                    );
                }
                // Forward macOS menu events to the desktop shell's onMenuEvent handler
                // (preferences / new-window / close-window / minimize / zoom /
                // enter-fullscreen / show-all). Without this the native menu items render
                // but tapping them fires into Tauri's default no-op — exactly the
                // "Tauri default menu" boot observed 2026-09-18.
                let menu_handle = app.handle().clone();
                app.handle().on_menu_event(move |_app, event| {
                    menu::on_menu_event(&menu_handle, event);
                });
            }
            // Install the JNI bridge emitter so device-glue callbacks (BLE
            // notifications, NFC tag discoveries, biometric results) reach the
            // WebView through Tauri events. A quiet no-op before this runs.
            #[cfg(feature = "android")]
            {
                jni_glue::init();
                let handle = app.handle().clone();
                jni_glue::set_emitter(move |event, payload| {
                    if let Err(e) = handle.emit(event, payload) {
                        tracing::warn!(
                            target: "amos::jni",
                            event,
                            error = %e,
                            "device glue event could not be delivered to the UI"
                        );
                    }
                });
            }
            // REQ-A478: arm the window-geometry memory. This is the step that was missing
            // since REQ-A249 — `install` resolves `app_data_dir()/amos.window-state.json`
            // and **says so** (an unarmed store drops every write, and that silence is
            // exactly how a feature can be "implemented" yet never running).
            app.state::<window_state::WindowStateStore>()
                .install(app.handle());
            // …and **keep asking it to write**. The store is debounced *by design* ("flush
            // when `DEBOUNCE_MS` has elapsed"), which means someone has to ask once the user
            // stops dragging — and nothing did. Measured on device after wiring the store:
            // the `Moved` event arrived, every input the recorder needs was present
            // (`PROBE: geometry-memory inputs … snap=true has_store=true`), the entry was
            // queued, and **no file was ever written**; the exit hook is not a substitute
            // either, because a native quit does not deliver `RunEvent::ExitRequested` on
            // macOS (also measured: quitting produced neither the flush nor the file).
            //
            // So the poller is what makes the debounce real. One thread, 500 ms, under the
            // debounce plus scheduling jitter: a gesture lands about a second after the user
            // lets go, and a drag's storm of events still collapses into one write. The
            // thread ends when the app state is gone (it is not detached from the app's
            // lifetime in any other way, and it never blocks the UI thread — the store's own
            // lock is held for the length of a small JSON write).
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(FLUSH_TICK_MS));
                    match handle.try_state::<window_state::WindowStateStore>() {
                        Some(store) => {
                            store.flush_due();
                        }
                        None => break,
                    }
                });
            }
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
                let stray = desktop_features::stray_vars(desktop_features::env_knob);
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
            // Where do WebMan downloads come to rest? On Android there is **no**
            // browsable Downloads directory: `dirs::download_dir()` and
            // `dirs::home_dir()` both answer `None`, so the pipeline used to fall
            // through to `temp_dir()/amos-downloads` (= `/data/local/tmp/...`, which
            // an app cannot even write) — the file was invisible to the user and
            // pruned by the system, or the download simply failed. The destination
            // is the MediaStore `Download` collection: stage app-privately under
            // `app_cache_dir()`, then stream into MediaStore at completion.
            //
            // Installed here (not in `boot()`) because `app.path()` does not exist
            // until the app does — `manage()` runs first. The sink delegates through
            // the media bridge's live backend, so a transfer that finishes after the
            // Kotlin glue attaches still lands in MediaStore instead of the mock.
            #[cfg(feature = "android")]
            {
                match app.path().app_cache_dir() {
                    Ok(cache) => app
                        .state::<webman_download::WebmanDownloads>()
                        .configure(std::sync::Arc::new(webman_download::MediaStoreSink::new(
                            app.state::<media::MediaBridge>().backend(),
                            cache.join("webman-staging"),
                        ))),
                    Err(e) => tracing::warn!(
                        target: "amos::webman",
                        error = %e,
                        "app cache dir unavailable — downloads fall back to the \
                         process-wide download directory (which is not user-visible on Android)"
                    ),
                }
            }
            // Real in-call bridge (default-dialer / InCallService): give the Rust side
            // an AppHandle so Kotlin-pushed real call states reach the WebView as
            // `telephony-event`, and so telephony answer/end can drive the real call.
            #[cfg(feature = "android")]
            incall::set_app(app.handle().clone());
            // BLE / NFC / Biometric device glue: the JNI emitter is set up at the
            // top of `setup`; the JavaVM + Context binding is installed by Kotlin
            // `MainActivity.onStart`. Nothing more to do here.
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
        .build(tauri::generate_context!())
        .expect("error while building the amos System UI")
        .run(|app_handle, event| {
            // REQ-A478: the store's debounce holds up to `DEBOUNCE_MS` of writes, and this is
            // the last chance to land them — the module's own doc has claimed since it was
            // written that `flush_all` is "called from `RunEvent::ExitRequested`", which was
            // true of nothing until now.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(store) = app_handle.try_state::<window_state::WindowStateStore>() {
                    store.flush_all();
                    tracing::info!(
                        target: "amos::window_state",
                        "final window-state flush on exit"
                    );
                }
            }
        });
}
