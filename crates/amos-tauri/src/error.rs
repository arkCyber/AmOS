//! `error.rs` — typed error envelope shared across the System UI Rust core.
//!
//! Every `#[tauri::command]` that can fail returns [`Result<T, AmosError>`].
//! The envelope is two pieces of information — a **stable code** the UI can
//! branch on, and a **human-readable message** the UI should not parse — plus
//! an optional cause chain so a watcher can see where the failure actually
//! originated without grepping the source.
//!
//! # Why a code AND a message
//!
//! The frontend i18n layer translates the *code* into the user's locale. The
//! *message* is a developer-facing diagnostic (logs, the error overlay) that
//! stays in English and may change without notice. Branching on the message —
//! a habit this crate's earlier code encouraged — made every rewording a wire
//! break; the code is the contract.

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(into = "&'static str")]
pub enum ErrorCode {
    ButtonsUnknown,
    ButtonsNameTooLong,
    ButtonsDeliveryFailed,
    DisplayContractMissing,
    DisplayWriteFailed,
    DisplayReadMalformed,
    FlashlightStoredShapeInvalid,
    FlashlightProviderUnconfirmed,
    NetGuardToggleFailed,
    NetGuardStatusFailed,
    NetGuardEgressFailed,
    SensorsUnknownMode,
    SensorsUnknownKind,
    SensorsRateOutOfRange,
    SensorsRpcFailed,
    TelemetrySpyWatchOpenFailed,
    TelemetrySpyStreamError,
    TelemetrySpyEmitFailed,
    // --- telephony (REQ-A268 follow-up: dialer / call state surface) ---
    /// Caller-supplied number exceeds [`telephony::MAX_TELEPHONY_DIAL_BYTES`].
    TelephonyNumberTooLong,
    /// Caller-supplied call id exceeds [`telephony::MAX_TELEPHONY_CALL_ID_BYTES`].
    TelephonyCallIdTooLong,
    /// Any telephony RPC failed (daemon unreachable / rejected).
    TelephonyRpcFailed,
    /// `spawn_telephony_watch` could not open the long-lived `Watch` stream.
    TelephonyWatchOpenFailed,
    /// A `Watch` event could not be read off the stream.
    TelephonyWatchStreamError,
    /// The in-call recording toggle was refused: the caller is not the focused
    /// window (F-TEL-001), AmOS is not the default dialer (no `AmosInCallService`
    /// is bound), or the JNI call to the bound service failed. A **named refusal**
    /// rather than a bare string, so the UI can render "you are not allowed to
    /// record here" distinctly from a generic telephony RPC failure.
    TelephonyRecordingRefused,
    /// The in-call **mute** toggle was refused. Distinct from
    /// [`Self::TelephonyRecordingRefused`] because the reasons differ: a mute refusal is
    /// the bound in-call service declining (or a JNI failure), while a recording refusal
    /// also covers the foreground/default-dialer gate. Keeping the code strings apart is
    /// what lets the UI blame the control the user actually pressed.
    TelephonyMuteRefused,
    /// The in-call **loudspeaker route** toggle was refused by the bound in-call service.
    TelephonySpeakerRefused,
    /// The in-call **hold** toggle was refused — the call was not in a holdable state, or
    /// the bound in-call service could not perform it.
    TelephonyHoldRefused,
    /// An in-call **DTMF tone** could not be sent to the call. There is no DTMF path on the
    /// daemon (mock) transport — a tone that never reached the call must not be reported as
    /// sent, so a refusal here is what keeps the keypad from claiming an IVR heard the digit.
    TelephonyDtmfRefused,
    // --- radio / Bluetooth (REQ-A202/REQ-A203 carry-over: structured refusal) ---
    /// Caller asked for a radio key (`wifi` / `bluetooth` / …) the bridge does not know.
    RadioUnknownKey,
    /// The Bluetooth MAC address passed to `bluetooth_pair` is empty or too long.
    RadioAddressInvalid,
    /// Any radio / Bluetooth provider call failed (Mock refused; Android provider missing).
    RadioRpcFailed,
    /// `radio_open_settings` was asked for a switch this app owns — no system surface exists.
    RadioNoSystemSurface,
    // --- SMS (REQ-A268 follow-up: messaging surface) ---
    /// Caller passed blank `thread_id` / `message_id` / `address` to an SMS command.
    SmsBlankId,
    /// Caller passed a thread id / message id / address that is over the SMS-id size cap.
    SmsIdTooLong,
    /// Caller passed an unknown folder name (`inbox` | `sent` | `draft` only).
    SmsUnknownFolder,
    /// Caller asked for messages from a sender the blocklist has blocked for SMS.
    SmsBlockedSender,
    /// The `sms_send` text body exceeds [`sms::MAX_SMS_TEXT_BYTES`].
    SmsTextTooLong,
    /// SMS provider rejected the read / send (SmsError kind); the user-visible
    /// reason lives in `message` and the SmsError kind in `cause[0]`.
    SmsProviderRejected,
    /// An SMS read that carries the user's messages was driven by a window the user is not
    /// looking at. Reading someone's inbox is a disclosure, so it follows the same
    /// [`crate::clipboard::require_foreground`] rule `clipboard_read` follows; the caller's
    /// own window label and the focused one ride along in `message` / `cause[0]`.
    SmsForegroundRequired,
    // --- Mail bridge (amos-mail) ---
    /// A mail read that carries the user's messages was driven by a window the user is not
    /// looking at. Mail follows the same [`crate::clipboard::require_foreground`] rule the
    /// SMS reads (`ErrorCode::SmsForegroundRequired`) and `clipboard_read` follow, for the
    /// same reason: reading someone's mailbox is a disclosure. The caller's own window label
    /// and the focused one ride along in `message` / `cause[0]`.
    MailForegroundRequired,
    /// Caller handed a mailbox / message id / search query the mail seam refuses: empty, or
    /// over [`mail::MAX_MAIL_NAME_BYTES`]. A malformed request is a different fact from the
    /// engine refusing a well-formed one, so it is a different code.
    MailInvalidArgument,
    /// The mail engine refused a read (permission / unavailable / no such mailbox); the
    /// engine's own words ride in `cause[0]`.
    MailProviderRejected,
    /// A mail mutation reached the engine but its durable store could not be written, so
    /// the change was **undone** and this refusal reported instead of a success it could
    /// not keep. Distinct from [`Self::MailProviderRejected`]: the engine did not refuse
    /// anything — the disk did. Same shape as [`Self::StagePersistFailed`] (audit PH-P2-02).
    MailPersistFailed,
    // --- Call-recording ledger (recording.rs) ---
    /// The call-recording ledger — *who* was recorded, when, and for how long — was read by a
    /// window the user is not looking at. Recordings follow the same
    /// [`crate::clipboard::require_foreground`] rule the SMS reads, the mail reads and
    /// `clipboard_read` follow, for the same reason: the ledger names the user's recorded
    /// calls, so reading it is a disclosure. The caller's own window label and the focused
    /// one ride along in `message` / `cause[0]`.
    RecordingsForegroundRequired,
    /// The recording ledger could not be read (no app-data dir, or a corrupt index). A
    /// different fact from [`Self::RecordingsForegroundRequired`] — "this window may not read
    /// right now" is not "the ledger is unreadable" — so it is a different code.
    RecordingsReadFailed,
    // --- AI bridge / RAG (REQ-A268 follow-up: LLM surface) ---
    /// Caller passed a `prompt` / `context` string over the prompt byte cap.
    AiPromptTooLong,
    /// Caller passed a `session_id` over the session-id byte cap.
    AiSessionIdTooLong,
    /// Caller passed an `api_key` / `model` / `endpoint` string over its byte cap.
    AiBackendPayloadTooLong,
    /// Caller passed an Android `package_name` that is empty or over the cap.
    AiAndroidPackageInvalid,
    /// Any AI / Android-manager RPC failed (daemon unreachable / rejected).
    AiRpcFailed,
    /// `ai_backend_switch` could not invoke / complete the `ai-backend.sh` script.
    AiBackendSwitchFailed,
    /// A RAG id / text / query string is over its byte cap.
    RagPayloadTooLong,
    /// Any RAG RPC failed (notes-index unreachable / rejected).
    RagRpcFailed,
    /// A window asked the note index a *question* — `rag_query` hands back the user's own note
    /// passages — from a window the user is not looking at. Retrieval follows the same
    /// [`crate::clipboard::require_foreground`] rule the SMS reads, the mail reads, the
    /// recording ledger and `clipboard_read` follow, for the same reason: an indexed passage is
    /// the user's note text, so querying it is a disclosure. The caller's own window label and
    /// the focused one ride along in `message` / `cause[0]`.
    RagForegroundRequired,
    // --- App Store (REQ-A268 follow-up: install / upgrade / uninstall surface) ---
    /// `appstore_install` / `appstore_upgrade` / `appstore_uninstall` — caller-supplied
    /// id is empty. The same check gates `appstore_status` and `appstore_bundle_entry`.
    AppStoreIdEmpty,
    /// Caller-supplied id exceeds [`MAX_APPSTORE_ID_BYTES`] (128 B). Long ids are
    /// path segments; the cap prevents unbounded filesystem work from a paste attack.
    AppStoreIdTooLong,
    /// Caller-supplied id contains path metacharacters (`/` `\` `..`) that would
    /// escape `<install-root>/` — refused before any filesystem call.
    AppStoreIdInvalid,
    /// The download → verify → install pipeline failed (provider unreachable, bundle
    /// corrupted, verification rejected). The user-visible reason lives in `message`.
    AppStoreInstallFailed,
    /// The catalog has no newer release for this app, or the upgrade pipeline failed.
    AppStoreUpgradeFailed,
    /// Uninstall failed (installed registry write error, bundle cleanup error). The
    /// uninstall is idempotent — retrying after a failure will still attempt removal.
    AppStoreUninstallFailed,
    /// Generic appstore RPC failure (status / catalog / find — surface as data so the
    /// UI can show a translated message instead of swallowing it into `null`).
    AppStoreRpcFailed,
    // --- Podcasts ---
    //
    // `PodcastError` is split this way on purpose: "the bytes never arrived"
    // (`PodcastFetchFailed`) and "the bytes arrived but are not a feed"
    // (`PodcastParseFailed`) need different sentences *and* different recoveries
    // (retry vs. drop the source), and the domain crate keeps them distinct for
    // exactly that reason — folding them here would discard that.
    /// The feed URL is empty, whitespace-only, or past the byte ceiling.
    PodcastUrlInvalid,
    /// The feed URL is not `http`/`https` (e.g. `file:`, `ftp:`).
    PodcastUrlSchemeUnsupported,
    /// The network/transport half failed (DNS, TLS, status, timeout).
    PodcastFetchFailed,
    /// The bytes arrived but do not parse as an RSS or Atom feed.
    PodcastParseFailed,
    /// The document parsed but carried no usable channel/feed element, or a feed
    /// with no episodes the caller asked to subscribe to.
    PodcastFeedRejected,
    /// The referenced feed id is not in the subscription list.
    PodcastUnknownFeed,
    /// The subscription list is at its cap and this add would exceed it (refused,
    /// never silently evicted — a subscription is user data).
    PodcastSubscriptionLimitReached,
    /// A subscription / cache / progress / download store read or write failed.
    PodcastStoreFailed,
    /// An episode has no downloadable audio, or the download attempt failed.
    PodcastDownloadFailed,
    /// The download was refused **before any bytes moved**: the episode is not in
    /// the cached feed, or it carries no enclosure URL. Distinct from
    /// `PodcastDownloadFailed`: nothing was attempted, so the recovery is "pick a
    /// playable episode", not "retry".
    PodcastNoAudio,
    /// The active provider has no transport for episode bytes, so the download
    /// could not even be attempted. Distinct from `PodcastDownloadFailed`: that
    /// means the transport *tried* and the bytes did not arrive (retry may help);
    /// this means there was never a transport to retry.
    PodcastDownloadUnsupported,
    /// A download was requested but no directory is configured to hold the audio,
    /// so writing it would land somewhere the user did not choose. Recovery:
    /// configure `$AMOS_PODCAST_DIR`.
    PodcastDownloadNoDir,
    /// A caller-supplied episode id is empty.
    PodcastEpisodeIdEmpty,
    /// A caller-supplied episode id exceeds its byte cap.
    PodcastEpisodeIdTooLong,
    /// Generic podcast RPC failure (a poisoned bridge lock, an unexpected shape).
    PodcastRpcFailed,
    // --- Spaces / virtual desktops (REQ-A297 phase 2 follow-up: typed errors) ---
    /// `SpaceManager`'s inner `Mutex` was poisoned (a thread panicked while holding
    /// the lock). The Spaces commands refuse to silently drop the request — the UI
    /// is told to retry / surface the failure.
    SpacesLockFailed,
    /// `SpaceManager::save()` could not serialize the in-memory state to JSON
    /// (a wire-contract change on `Space` / `SpaceManagerData` that would have been
    /// silent). The error returns rather than corrupting `SharedStore`.
    SpacesSerializationFailed,
    /// `spaces_switch` / `spaces_delete` / `spaces_move_window` / `spaces_rename`
    /// received an id / index that does not match any current Space.
    SpacesNotFound,
    /// `spaces_switch` index is `>=` the current space count. The UI is told
    /// "out of bounds", not "blank id".
    SpacesIndexOutOfBounds,
    /// The caller asked to delete the last remaining Space — refused so the
    /// manager always has at least one usable desktop.
    SpacesDeleteLast,
    // --- BLE / NFC / Biometric (REQ-A382 follow-up: device glue wire surface) ---
    /// `ble_connect` was called before the Android glue binding was attached
    /// (no foreground Activity has called `bind`). The UI should not retry; the
    /// boot path must install the binding first.
    BleConnectFailed,
    /// `nfc_status` / `nfc_write_message` / etc. was called before the NFC glue
    /// was initialized (no Activity has run `onStart` to hand up the Context).
    NfcNotInitialized,
    /// `biometric_authenticate` was called without an Activity-bound prompt
    /// (the Kotlin glue requires a `FragmentActivity` to host `BiometricPrompt`).
    BiometricNoActivity,
    // --- host power / session actions (REQ-A515: restart / shut down / sleep) ---
    /// This host has no power/session command for the requested action. A **named
    /// refusal** rather than an unregistered command: availability is a runtime fact
    /// (`session::invocation`), so a platform without `osascript`/`pmset`/`systemctl`
    /// has to say so instead of silently offering a button that can never work.
    SessionUnsupportedHost,
    /// The detached, delayed delivery could not be started (the shell or the power
    /// program is missing / not executable). The action **did not** run — this is not
    /// a "maybe it worked" case.
    SessionSpawnFailed,
    // --- host print path (REQ-A869: File ▸ Print / ⌘P) ---
    /// This host has no print dialog (`print::supports_dialog`). A **named refusal**
    /// rather than an unregistered command: `print_document` is registered on every
    /// target, and a mobile build that answered with Tauri's "command not found" would
    /// make the shell report an opaque failure where it could say "this platform has no
    /// print dialog". See [`crate::print`].
    PrintUnsupportedPlatform,
    /// Nothing focused that may be printed: no app window is focused, or only the
    /// launcher is — and the launcher *is* the desktop, never a document (F-SH-008).
    /// Reached from the native menu bar's ⌘P while the desktop is in front, which is a
    /// state the shell must report rather than print the desktop for.
    PrintNoWindow,
    /// The platform's own print call (`WebviewWindow::print()`) returned an error. The
    /// platform's message is in `cause[0]`. **This is not "the user cancelled"**: wry
    /// discards the result of the Linux dialog and returns `Ok(())` on a cancel, and on
    /// macOS it returns `Ok(())` even when the print selector is missing — so a *success*
    /// reply means "the request was made", never "a page was printed" (`crate::print`'s
    /// header table states the per-platform reality).
    PrintDialogFailed,
    // --- host filesystem access (REQ-A526 follow-up: real filesystem chokepoint) ---
    /// `host_fs_*` command was called and `AMOS_HOST_FS_ROOT` is unset / empty.
    /// The bridge refuses to bind to a "guessed" root, so this is the most common
    /// error the WebView will see on a fresh install — not a path-too-short code.
    HostFsRootNotConfigured,
    /// `AMOS_HOST_FS_ROOT` was set but does not exist (or could not be canonicalized).
    HostFsRootNotFound,
    /// `AMOS_HOST_FS_ROOT` was set but resolves to a non-directory (e.g. a file).
    HostFsRootNotADir,
    /// A path the WebView handed in is empty or longer than `MAX_PATH_BYTES`.
    HostFsPathNotFound,
    /// A path resolved to a directory where a file was expected (or vice versa).
    HostFsPathIsADir,
    HostFsPathIsNotADir,
    /// A path resolved to somewhere outside the allowed root (`..` segments,
    /// an absolute path outside the root, or a symlink that escapes the root).
    /// Refused **before** any syscall runs.
    HostFsPathEscapesRoot,
    /// A read or write payload exceeded the cap (`MAX_READ_CAP` / `MAX_WRITE_CAP`).
    HostFsFileTooLarge,
    /// Generic I/O failure on a read.
    HostFsReadFailed,
    /// Generic I/O failure on a write or atomic-rename.
    HostFsWriteFailed,
    /// `host_fs_read_text` was handed bytes that are not valid UTF-8.
    HostFsReadNotUtf8,
    /// Atomic write's `.tmp → rename` failed (the staged file is cleaned up;
    /// the original file is untouched when this fires on a rewrite).
    HostFsWriteAtomicsFailed,
    /// `host_fs_create_dir` / `host_fs_copy` / `host_fs_rename` targeted a path
    /// that already exists and no `overwrite` was requested. A **named refusal**
    /// so the UI can ask "replace it?" instead of silently clobbering a file.
    HostFsTargetExists,
    /// `host_fs_remove` was pointed at a non-empty directory without
    /// `recursive: true`. Deleting a folder's contents is opt-in, never implied.
    HostFsDirNotEmpty,
    /// A recursive `host_fs_copy` / `host_fs_remove` walked past the entry or
    /// depth budget ([`MAX_RECURSIVE_ENTRIES`] / [`MAX_RECURSIVE_DEPTH`]). The
    /// operation aborts rather than traversing an unbounded tree.
    HostFsRecursionLimit,
    /// Generic I/O failure on `host_fs_create_dir`.
    HostFsCreateDirFailed,
    /// Generic I/O failure on `host_fs_remove`.
    HostFsRemoveFailed,
    /// Generic I/O failure on `host_fs_rename` (including a cross-filesystem
    /// rename the OS refuses with `EXDEV`).
    HostFsRenameFailed,
    /// Generic I/O failure on `host_fs_copy`.
    HostFsCopyFailed,
    // --- push notifications (REQ-A595: typed envelope for the push surface) ---
    /// `push_register_token` was handed a token that is empty, shorter than the
    /// sandbox minimum (32), longer than [`push_notifications::MAX_DEVICE_TOKEN_LEN`],
    /// or not pure hex. A **named refusal** so the UI can tell "this token is
    /// malformed" from "the host could not reach the push service".
    PushTokenInvalid,
    /// An incoming payload serialised to more than [`push_notifications::MAX_PAYLOAD_SIZE`]
    /// (the 4 KB APNs bound) and was refused rather than stored.
    PushPayloadTooLong,
    /// A payload could not be serialised at all (a contract change on
    /// `PushPayload`); returned instead of storing a half-written record.
    PushReceiveFailed,
    /// The shared `PushNotificationManager` mutex was poisoned (a thread panicked
    /// while holding it). The command refuses to silently drop the request.
    PushLockFailed,
    // --- WebMan browser download pipeline (REQ-A5xx: real download / cookie jar) ---
    /// `webman_download_start` got a URL that is empty, over-long, not `http(s)`,
    /// or has no host. Refused before any socket is opened.
    WebmanUrlInvalid,
    /// The transfer failed: server answered a non-2xx status, the connection
    /// dropped, or the TLS/redirect chain broke. The user-visible reason is in
    /// `message`.
    WebmanDownloadFailed,
    /// The destination body exceeded [`webman_download::MAX_DOWNLOAD_BYTES`].
    /// Fails closed rather than filling the volume.
    WebmanDownloadTooLarge,
    /// A local filesystem error while creating / writing / finalizing the file.
    WebmanIoFailed,
    // --- Stage Manager (REQ-A1545/A1546 — `stage.rs`) ---
    /// A `stage_*` command that only means something while Stage mode is on was asked
    /// with it off. A **named** refusal, so the UI can say "turn Stage Manager on"
    /// instead of silently doing nothing.
    StageDisabled,
    /// The label is not a registered app window.
    StageWindowUnknown,
    /// The label names the Launcher (or another chrome surface): it *is* the stage, so
    /// parking it would be parking the thing that shows the rail.
    StageWindowIsScreen,
    /// The label names a window inside an active split: its rectangle belongs to the
    /// split session, so parking it would leave the split describing a layout that is no
    /// longer on screen. Exit the split first.
    StageWindowInSplit,
    /// The Stage mode preference could not be persisted.
    StagePersistFailed,
    /// This class has no stage at all (no rail — see `LayoutPolicy::stage_rail_width`),
    /// so Stage mode cannot be turned on here. Distinct from [`Self::StageDisabled`]:
    /// that one means "off but available", this one means "not available".
    StageUnsupported,
    /// The window-manager mutex was poisoned, so no stage question could be answered.
    /// Matches the shape [`Self::SpacesLockFailed`] uses at its own `lock()` sites.
    StageLockFailed,
    /// "Tidy" was asked and the geometry refused: the work area cannot give every
    /// on-stage window its class minimum pane. The honest answer, never a partial
    /// layout the user cannot tell from a complete one (`LayoutPolicy::arrange_stage`).
    StageArrangeImpossible,
    // --- screen recording (REQ-A1551/A1552 — `screen_record.rs`) ---
    /// `screen_record_start` was called while a recording is already running.
    ScreenRecordAlreadyRecording,
    /// `screen_record_stop` was called with no recording running.
    ScreenRecordNotRecording,
    /// This build/platform cannot record the screen (no encoder, no platform API).
    /// Answered with a **reason** — see `ScreenRecordCapability`.
    ScreenRecordUnsupported,
    /// The encoder process could not be spawned.
    ScreenRecordSpawnFailed,
    /// Stopping or finalizing the recording failed.
    ScreenRecordStopFailed,
    /// The recording was stopped but **no bytes were written**: the platform refused the
    /// screen-capture permission, or the encoder died. Reported rather than claimed as a
    /// success — the same discipline `screenshot::confirm_written` follows.
    ScreenRecordConfirmFailed,
    /// A requested duration outside `MIN_RECORD_SECS..=MAX_RECORD_SECS`.
    ScreenRecordDurationOutOfRange,
    /// The command needs a foreground window (the in-call/recording gate,
    /// `recording.rs::require_recordings_foreground`) and there is none.
    ScreenRecordForegroundRequired,
    // --- the Android system IME's entry point (REQ-A1904 — `ime.rs`) ---
    /// `ime_system_open_picker` / `ime_system_open_settings` could not reach the
    /// platform: this is a host/desktop build, no `Context` has been bound yet
    /// (`MainActivity.onStart` has not run), or the glue class is not on the app's
    /// loader. Distinct from [`Self::ImeSystemOpenFailed`] because the user can act on
    /// it differently: nothing is going to launch until the app is really running.
    ImeSystemGlueUnavailable,
    /// The platform was reached and **refused** the launch (or the JNI call threw) —
    /// e.g. a ROM with no input-method settings screen. The platform's own words are in
    /// the message rather than folded into "not available".
    ImeSystemOpenFailed,
    /// `ime_system_open_picker` was refused by the platform's own precondition: nothing in
    /// the window is accepting text, so there is no IME window for the keyboard switcher to be
    /// drawn from and the platform returns having shown nothing. Distinct from
    /// [`Self::ImeSystemOpenFailed`] because the user's next step differs — put the caret in a
    /// text field, or use the settings door (`ime_system_open_settings`), which needs no input
    /// connection — and because retrying this one unchanged cannot ever work.
    ImeSystemNoTextEditor,
    // --- simultaneous interpretation (REQ-A461 follow-up: typed envelope) ---
    /// A session-driving command (`interpret_text` / `_audio` / `_pause` / `_resume` /
    /// `_stop` / `_restart` / `_abort` / `_end_of_speech`) was called with no active
    /// session. The bridge holds at most one [`ActiveSession`] at a time, and the caller
    /// must run `interpret_start` first. A **named** refusal so the UI can render
    /// "you haven't started a session" distinctly from "the daemon refused".
    InterpretNoActive,
    /// A `session_id` argument does not match the active session's id. The bridge keeps
    /// only one live session and the wire type is `Option<u64>` so the caller can omit
    /// the id for the common case, but when they pass one it has to match — the daemon's
    /// own session id ledger is the only thing that keeps an `interp.sendFailed` blame
    /// honest.
    InterpretSessionIdMismatch,
    /// `interpret_text` was handed text longer than [`interpret::MAX_INTERPRET_TEXT_BYTES`].
    /// Refused at the command seam rather than letting the gRPC pipeline either stall
    /// or burn its token budget — distinct from "the daemon rejected a well-formed line".
    InterpretTextTooLong,
    /// `interpret_audio` was handed an f32 sample chunk longer than
    /// [`interpret::MAX_INTERPRET_AUDIO_SAMPLES`]. Refused at the seam — a 5-second
    /// mono-16k buffer is the legitimate ceiling; beyond it the call is a runaway
    /// producer or paste attack.
    InterpretAudioTooLarge,
    /// The active session's underlying `amos_int::Session::start/pause/resume/stop/
    /// restart/abort` returned an error (the domain layer refused — e.g. invalid state
    /// transition). The domain message rides along in `cause[0]`. Distinct from
    /// [`Self::InterpretNoActive`] (no session at all) and from
    /// [`Self::InterpretChannelFailed`] (session exists but the producer channel broke).
    InterpretSessionFailed,
    /// The session exists but pushing the [`amos_int::event::SessionEvent`] through the
    /// in-process channel failed — the producer has been dropped, so the session is
    /// already past recovery. Distinct from [`Self::InterpretSessionFailed`]: that one
    /// is a domain refusal on a well-formed event, this one is the channel underneath
    /// the session giving up.
    InterpretChannelFailed,
    // --- window manager (REQ-A462 follow-up: typed envelope) ---
    /// `crates/amos-tauri/src/wm.rs` — `enter_split` / `minimize_target` / `snap_plan` /
    /// `close` ∕ etc. asked for a label that is not in [`amos_wm::state::WmCore::by_label`].
    /// The window may have been closed, the caller's snapshot is stale, or the label was
    /// ever invented — a **named** refusal so the UI can render "unknown window" distinctly
    /// from "the window is in a split you cannot zoom" or "the platform call failed".
    WmWindowNotRegistered,
    /// `wm_close` / `snap_window` ∕ etc. — the label is registered but the **platform**
    /// window is gone (closed out from under AmOS, or never created). Distinct from
    /// [`Self::WmWindowNotRegistered`]: that one is a model-level absence, this one is
    /// a platform-level absence. Frontend can branch on the difference because the
    /// remediation differs ("looks like a stale snapshot" vs. "try re-register").
    WmWindowNotFound,
    /// The label is one of the two panes of an active split — minimizing ∕ zooming ∕
    /// snapping that rectangle would put the split describing a layout the pane has
    /// left. The split must be exited first. Shared by `minimize_target` ∕ `zoomable_window` ∕
    /// `snap_plan`.
    WmWindowInSplit,
    /// `enter_split` was asked on a form factor that has no user interface (e.g. a
    /// server-style class). Distinct from [`Self::WmStageRailNotAvailable`] which is
    /// about Stage Manager specifically; this one is the broader "no UI to split" rule.
    WmFormFactorNoUi,
    /// `set_stage_enabled(true)` was asked on a form factor that has no Stage Manager
    /// rail (the rail width is `0` for this class). Distinct from [`Self::WmFormFactorNoUi`]:
    /// that one is "the class cannot split", this one is "the class *can* split but does
    /// not have a Stage rail to inset".
    WmStageRailNotAvailable,
    /// `enter_split` was asked with `(a, a)` — a window cannot split with itself. The
    /// UI surfaces a same-pane drop target first; the host still rejects duplicates so a
    /// stale invariant is loud rather than silent.
    WmSelfSplit,
    /// `enter_split` was asked with `(launcher, x)` — the launcher is the desktop surface,
    /// and parking it would park the thing that shows the rail. Distinct from
    /// [`Self::WmSelfSplit`]: "you used the same window twice" is a different fact from
    /// "you used the window that owns the screen".
    WmLauncherSplit,
    /// `split_resize` ∕ `split_move` ∕ `split_swap` were asked with no active split. The
    /// UI's button gating should prevent this from reaching the host, but the refusal is
    /// here so a stale keystroke is loud rather than silent.
    WmSplitNotActive,
    /// `split_resize` ∕ `split_move` asked for a divider share the current minimum pane
    /// size cannot satisfy (a clamp-to-`min` would zero one pane).
    WmSplitRatioInfeasible,
    /// `snap_plan` was asked for a zone string that is not a member of the documented
    /// set (`top` ∕ `bottom` ∕ `left` ∕ `right` ∕ `tl` ∕ `tr` ∕ `bl` ∕ `br` ∕ `maximize`).
    /// Refused before any platform call.
    WmSnapZoneUnknown,
    /// `enter_split` was asked for an axis that is not `vertical` ∕ `horizontal` ∕
    /// `auto` (and not the empty string). Distinct from [`Self::WmSnapZoneUnknown`]:
    /// that one is about a snap-zone string, this one is about a split-axis string;
    /// the frontend i18n table can resolve the two differently even though the
    /// user's eye sees the same "unknown keyword" failure mode.
    WmAxisUnknown,
    /// A platform-level window call (`set_position` ∕ `set_size` ∕ `minimize` ∕
    /// `close` ∕ `enumerate_displays` ∕ etc.) failed. The platform's own message rides
    /// along in `cause[0]`. The host's own refusal of a well-formed request is what
    /// distinguishes this from any of the model-level `WmWindow*` codes above.
    WmPlatformWindowFailed,
    /// `identity::identity_of_label(label)` refused (the label is not parseable as an
    /// AmOS-managed label). Surfaced from the small set of `wm_*` paths that go
    /// through the identity domain — `register_app_instance` ∕ `open_surface` ∕
    /// `app_window_title`. Distinct from [`Self::WmWindowNotRegistered`]: that one is
    /// "the model says no such window", this one is "the label is not even parseable
    /// as one of ours".
    WmIdentityRefused,
    /// `register_app_instance` reached the binding invariant check but found the
    /// freshly-minted label is already bound to a live window — the identity ledger
    /// and the model ledger disagree. Always an internal invariant violation
    /// (`next_window_label` mints a label that is, by construction, fresh); named
    /// so the UI can show an "internal error" hint rather than the generic
    /// "platform call failed" string the old `format!` produced.
    WmLabelAlreadyBound,
    /// `normalize_shell_title` ∕ `resolved_title` — the proposed title is empty,
    /// contains a control character (`U+0000..=U+001F` / `U+007F..=U+009F`), or exceeds
    /// `MAX_SHELL_TITLE_CHARS`. The `cause[0]` is the diagnostic message (the *message*
    /// in the envelope remains the wire-stable "title shape is not acceptable" sentence).
    /// Distinct from [`Self::AiPromptTooLong`] which gates the prompt body, not the
    /// window title.
    WmTitleInvalid,
    /// `WmState::inner`'s mutex is poisoned — another thread panicked while holding it, so the
    /// window model is no longer trustworthy and no further mutation may be applied. The
    /// internal string rides in `cause[0]`. Distinct from every model-level `Wm*` refusal
    /// above: those are the manager *declining* a well-formed request, this one is the
    /// manager *unable* to answer at all.
    WmLockFailed,
    /// A `wm_*` path reached the seam where the module's pure layout helpers still speak
    /// `Result<_, String>` and the layout model could not be materialised (e.g. a live split
    /// whose pane geometry is unavailable) or the apply-to-real-windows step failed. The
    /// internal string rides in `cause[0]`. Distinct from [`Self::WmLockFailed`]: the state
    /// was readable, the layout itself is what did not resolve.
    WmLayoutFailed,
    /// `wm_split_demo` was run with fewer than two windows it could offer as panes. Sibling of
    /// [`Self::WmSelfSplit`] / [`Self::WmLauncherSplit`]: those name a bad *pair* of windows,
    /// this one names the absence of a pair at all. Distinct from
    /// [`Self::WmSplitRatioInfeasible`], which is asked *with* two windows the current screen
    /// cannot seat.
    WmSplitNeedsTwoWindows,
}

impl ErrorCode {
    /// The stable wire code for this variant.
    ///
    /// `const` so a module's own `codes::` vocabulary can be **derived** from
    /// the single declaration here (`const X: &str = ErrorCode::Y.as_str();`)
    /// rather than re-typed — a second literal spelling of the same wire code
    /// is exactly the drift this signature makes impossible.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ButtonsUnknown => "amos.buttons.unknown",
            Self::ButtonsNameTooLong => "amos.buttons.name_too_long",
            Self::ButtonsDeliveryFailed => "amos.buttons.delivery_failed",
            Self::DisplayContractMissing => "amos.display.contract_missing",
            Self::DisplayWriteFailed => "amos.display.write_failed",
            Self::DisplayReadMalformed => "amos.display.read_malformed",
            Self::FlashlightStoredShapeInvalid => "amos.flashlight.stored_shape_invalid",
            Self::FlashlightProviderUnconfirmed => "amos.flashlight.provider_unconfirmed",
            Self::NetGuardToggleFailed => "amos.netguard.toggle_failed",
            Self::NetGuardStatusFailed => "amos.netguard.status_failed",
            Self::NetGuardEgressFailed => "amos.netguard.egress_failed",
            Self::SensorsUnknownMode => "amos.sensors.unknown_mode",
            Self::SensorsUnknownKind => "amos.sensors.unknown_kind",
            Self::SensorsRateOutOfRange => "amos.sensors.rate_out_of_range",
            Self::SensorsRpcFailed => "amos.sensors.rpc_failed",
            Self::TelemetrySpyWatchOpenFailed => "amos.telemetry_spy.watch_open_failed",
            Self::TelemetrySpyStreamError => "amos.telemetry_spy.stream_error",
            Self::TelemetrySpyEmitFailed => "amos.telemetry_spy.emit_failed",
            Self::TelephonyNumberTooLong => "amos.telephony.number_too_long",
            Self::TelephonyCallIdTooLong => "amos.telephony.call_id_too_long",
            Self::TelephonyRpcFailed => "amos.telephony.rpc_failed",
            Self::TelephonyWatchOpenFailed => "amos.telephony.watch_open_failed",
            Self::TelephonyWatchStreamError => "amos.telephony.watch_stream_error",
            Self::TelephonyRecordingRefused => "amos.telephony.recording_refused",
            Self::TelephonyMuteRefused => "amos.telephony.mute_refused",
            Self::TelephonySpeakerRefused => "amos.telephony.speaker_refused",
            Self::TelephonyHoldRefused => "amos.telephony.hold_refused",
            Self::TelephonyDtmfRefused => "amos.telephony.dtmf_refused",
            Self::RadioUnknownKey => "amos.radio.unknown_key",
            Self::RadioAddressInvalid => "amos.radio.address_invalid",
            Self::RadioRpcFailed => "amos.radio.rpc_failed",
            Self::RadioNoSystemSurface => "amos.radio.no_system_surface",
            Self::SmsBlankId => "amos.sms.blank_id",
            Self::SmsIdTooLong => "amos.sms.id_too_long",
            Self::SmsUnknownFolder => "amos.sms.unknown_folder",
            Self::SmsBlockedSender => "amos.sms.blocked_sender",
            Self::SmsTextTooLong => "amos.sms.text_too_long",
            Self::SmsProviderRejected => "amos.sms.provider_rejected",
            Self::SmsForegroundRequired => "amos.sms.foreground_required",
            Self::MailForegroundRequired => "amos.mail.foreground_required",
            Self::MailInvalidArgument => "amos.mail.invalid_argument",
            Self::MailProviderRejected => "amos.mail.provider_rejected",
            Self::MailPersistFailed => "amos.mail.persist_failed",
            Self::RecordingsForegroundRequired => "amos.recordings.foreground_required",
            Self::RecordingsReadFailed => "amos.recordings.read_failed",
            Self::AiPromptTooLong => "amos.ai.prompt_too_long",
            Self::AiSessionIdTooLong => "amos.ai.session_id_too_long",
            Self::AiBackendPayloadTooLong => "amos.ai.backend_payload_too_long",
            Self::AiAndroidPackageInvalid => "amos.ai.android_package_invalid",
            Self::AiRpcFailed => "amos.ai.rpc_failed",
            Self::AiBackendSwitchFailed => "amos.ai.backend_switch_failed",
            Self::RagPayloadTooLong => "amos.rag.payload_too_long",
            Self::RagRpcFailed => "amos.rag.rpc_failed",
            Self::RagForegroundRequired => "amos.rag.foreground_required",
            Self::AppStoreIdEmpty => "amos.appstore.id_empty",
            Self::AppStoreIdTooLong => "amos.appstore.id_too_long",
            Self::AppStoreIdInvalid => "amos.appstore.id_invalid",
            Self::AppStoreInstallFailed => "amos.appstore.install_failed",
            Self::AppStoreUpgradeFailed => "amos.appstore.upgrade_failed",
            Self::AppStoreUninstallFailed => "amos.appstore.uninstall_failed",
            Self::AppStoreRpcFailed => "amos.appstore.rpc_failed",
            Self::PodcastUrlInvalid => "amos.podcast.url_invalid",
            Self::PodcastUrlSchemeUnsupported => "amos.podcast.url_scheme_unsupported",
            Self::PodcastFetchFailed => "amos.podcast.fetch_failed",
            Self::PodcastParseFailed => "amos.podcast.parse_failed",
            Self::PodcastFeedRejected => "amos.podcast.feed_rejected",
            Self::PodcastUnknownFeed => "amos.podcast.unknown_feed",
            Self::PodcastSubscriptionLimitReached => "amos.podcast.subscription_limit",
            Self::PodcastStoreFailed => "amos.podcast.store_failed",
            Self::PodcastDownloadFailed => "amos.podcast.download_failed",
            Self::PodcastNoAudio => "amos.podcast.no_audio",
            Self::PodcastDownloadUnsupported => "amos.podcast.download_unsupported",
            Self::PodcastDownloadNoDir => "amos.podcast.download_no_dir",
            Self::PodcastEpisodeIdEmpty => "amos.podcast.episode_id_empty",
            Self::PodcastEpisodeIdTooLong => "amos.podcast.episode_id_too_long",
            Self::PodcastRpcFailed => "amos.podcast.rpc_failed",
            Self::SpacesLockFailed => "amos.spaces.lock_failed",
            Self::SpacesSerializationFailed => "amos.spaces.serialization_failed",
            Self::SpacesNotFound => "amos.spaces.not_found",
            Self::SpacesIndexOutOfBounds => "amos.spaces.index_out_of_bounds",
            Self::SpacesDeleteLast => "amos.spaces.delete_last",
            Self::BleConnectFailed => "amos.ble.connect_failed",
            Self::NfcNotInitialized => "amos.nfc.not_initialized",
            Self::BiometricNoActivity => "amos.biometric.no_activity",
            Self::SessionUnsupportedHost => "amos.session.unsupported_host",
            Self::SessionSpawnFailed => "amos.session.spawn_failed",
            Self::PrintUnsupportedPlatform => "amos.print.unsupported_platform",
            Self::PrintNoWindow => "amos.print.no_window",
            Self::PrintDialogFailed => "amos.print.dialog_failed",
            Self::HostFsRootNotConfigured => "amos.host_fs.root_not_configured",
            Self::HostFsRootNotFound => "amos.host_fs.root_not_found",
            Self::HostFsRootNotADir => "amos.host_fs.root_not_a_dir",
            Self::HostFsPathNotFound => "amos.host_fs.path_not_found",
            Self::HostFsPathIsADir => "amos.host_fs.path_is_a_dir",
            Self::HostFsPathIsNotADir => "amos.host_fs.path_is_not_a_dir",
            Self::HostFsPathEscapesRoot => "amos.host_fs.path_escapes_root",
            Self::HostFsFileTooLarge => "amos.host_fs.file_too_large",
            Self::HostFsReadFailed => "amos.host_fs.read_failed",
            Self::HostFsWriteFailed => "amos.host_fs.write_failed",
            Self::HostFsReadNotUtf8 => "amos.host_fs.read_not_utf8",
            Self::HostFsWriteAtomicsFailed => "amos.host_fs.write_atomics_failed",
            Self::HostFsTargetExists => "amos.host_fs.target_exists",
            Self::HostFsDirNotEmpty => "amos.host_fs.dir_not_empty",
            Self::HostFsRecursionLimit => "amos.host_fs.recursion_limit",
            Self::HostFsCreateDirFailed => "amos.host_fs.create_dir_failed",
            Self::HostFsRemoveFailed => "amos.host_fs.remove_failed",
            Self::HostFsRenameFailed => "amos.host_fs.rename_failed",
            Self::HostFsCopyFailed => "amos.host_fs.copy_failed",
            Self::PushTokenInvalid => "amos.push.token_invalid",
            Self::PushPayloadTooLong => "amos.push.payload_too_long",
            Self::PushReceiveFailed => "amos.push.receive_failed",
            Self::PushLockFailed => "amos.push.lock_failed",
            Self::WebmanUrlInvalid => "amos.webman.url_invalid",
            Self::WebmanDownloadFailed => "amos.webman.download_failed",
            Self::WebmanDownloadTooLarge => "amos.webman.download_too_large",
            Self::WebmanIoFailed => "amos.webman.io_failed",
            Self::StageDisabled => "amos.stage.disabled",
            Self::StageWindowUnknown => "amos.stage.window_unknown",
            Self::StageWindowIsScreen => "amos.stage.window_is_screen",
            Self::StageWindowInSplit => "amos.stage.window_in_split",
            Self::StagePersistFailed => "amos.stage.persist_failed",
            Self::StageUnsupported => "amos.stage.unsupported",
            Self::StageLockFailed => "amos.stage.lock_failed",
            Self::StageArrangeImpossible => "amos.stage.arrange_impossible",
            Self::ScreenRecordAlreadyRecording => "amos.screenrecord.already_recording",
            Self::ScreenRecordNotRecording => "amos.screenrecord.not_recording",
            Self::ScreenRecordUnsupported => "amos.screenrecord.unsupported",
            Self::ScreenRecordSpawnFailed => "amos.screenrecord.spawn_failed",
            Self::ScreenRecordStopFailed => "amos.screenrecord.stop_failed",
            Self::ScreenRecordConfirmFailed => "amos.screenrecord.confirm_failed",
            Self::ScreenRecordDurationOutOfRange => "amos.screenrecord.duration_out_of_range",
            Self::ScreenRecordForegroundRequired => "amos.screenrecord.foreground_required",
            Self::ImeSystemGlueUnavailable => "amos.ime.system_glue_unavailable",
            Self::ImeSystemOpenFailed => "amos.ime.system_open_failed",
            Self::ImeSystemNoTextEditor => "amos.ime.system_no_text_editor",
            Self::InterpretNoActive => "amos.interpret.no_active",
            Self::InterpretSessionIdMismatch => "amos.interpret.session_id_mismatch",
            Self::InterpretTextTooLong => "amos.interpret.text_too_long",
            Self::InterpretAudioTooLarge => "amos.interpret.audio_too_large",
            Self::InterpretSessionFailed => "amos.interpret.session_failed",
            Self::InterpretChannelFailed => "amos.interpret.channel_failed",
            Self::WmWindowNotRegistered => "amos.wm.window_not_registered",
            Self::WmWindowNotFound => "amos.wm.window_not_found",
            Self::WmWindowInSplit => "amos.wm.window_in_split",
            Self::WmFormFactorNoUi => "amos.wm.form_factor_no_ui",
            Self::WmStageRailNotAvailable => "amos.wm.stage_rail_not_available",
            Self::WmSelfSplit => "amos.wm.self_split",
            Self::WmLauncherSplit => "amos.wm.launcher_split",
            Self::WmSplitNotActive => "amos.wm.split_not_active",
            Self::WmSplitRatioInfeasible => "amos.wm.split_ratio_infeasible",
            Self::WmSnapZoneUnknown => "amos.wm.snap_zone_unknown",
            Self::WmAxisUnknown => "amos.wm.axis_unknown",
            Self::WmPlatformWindowFailed => "amos.wm.platform_window_failed",
            Self::WmIdentityRefused => "amos.wm.identity_refused",
            Self::WmLabelAlreadyBound => "amos.wm.label_already_bound",
            Self::WmTitleInvalid => "amos.wm.title_invalid",
            Self::WmLockFailed => "amos.wm.lock_failed",
            Self::WmLayoutFailed => "amos.wm.layout_failed",
            Self::WmSplitNeedsTwoWindows => "amos.wm.split_needs_two_windows",
        }
    }

    pub fn group(self) -> &'static str {
        let s = self.as_str();
        let after_prefix = match s.strip_prefix("amos.") {
            Some(rest) => rest,
            None => return s,
        };
        match after_prefix.find('.') {
            Some(end) => &after_prefix[..end],
            None => after_prefix,
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl From<ErrorCode> for &'static str {
    fn from(c: ErrorCode) -> &'static str {
        c.as_str()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AmosError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cause: Vec<String>,
}

impl AmosError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cause: Vec::new(),
        }
    }

    pub fn with_cause(
        code: ErrorCode,
        message: impl Into<String>,
        cause: impl fmt::Display,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            cause: vec![cause.to_string()],
        }
    }

    pub fn push_cause(mut self, cause: impl fmt::Display) -> Self {
        self.cause.push(cause.to_string());
        self
    }

    pub fn code(&self) -> &'static str {
        self.code.as_str()
    }
}

impl fmt::Display for AmosError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)?;
        for c in &self.cause {
            write!(f, " (caused by: {c})")?;
        }
        Ok(())
    }
}

impl std::error::Error for AmosError {}

pub type AmosResult<T> = Result<T, AmosError>;

pub trait IntoAmosError {
    fn into_envelope(self, code: ErrorCode) -> AmosError;
}

impl<E: fmt::Display> IntoAmosError for E {
    fn into_envelope(self, code: ErrorCode) -> AmosError {
        AmosError::with_cause(code, code.as_str(), self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every [`ErrorCode`] variant, hand-listed — the test module’s one full spelling of the
    /// vocabulary, shared by the two assertions below so the two lists cannot drift apart.
    ///
    /// Hand-written, and that is the residual gap: nothing on **stable** Rust enumerates an
    /// enum’s variants (`std::mem::variant_count` is unstable, and `strum` would be a new
    /// dependency for one assertion), so a variant added to the enum and to *neither* list is
    /// invisible to every assertion here. What is pinned instead is that the two hand-lists
    /// agree — the direction that was measurably open (measured, REQ-A870: three variants
    /// deleted from the frozen table while `FROZEN_VARIANT_COUNT` was left alone kept
    /// `wire_codes_are_frozen` green, which is exactly what its doc comment denied).
    const ALL_VARIANTS: &[ErrorCode] = &[
        ErrorCode::ButtonsUnknown,
        ErrorCode::ButtonsNameTooLong,
        ErrorCode::ButtonsDeliveryFailed,
        ErrorCode::DisplayContractMissing,
        ErrorCode::DisplayWriteFailed,
        ErrorCode::DisplayReadMalformed,
        ErrorCode::FlashlightStoredShapeInvalid,
        ErrorCode::FlashlightProviderUnconfirmed,
        ErrorCode::NetGuardToggleFailed,
        ErrorCode::NetGuardStatusFailed,
        ErrorCode::NetGuardEgressFailed,
        ErrorCode::SensorsUnknownMode,
        ErrorCode::SensorsUnknownKind,
        ErrorCode::SensorsRateOutOfRange,
        ErrorCode::SensorsRpcFailed,
        ErrorCode::TelemetrySpyWatchOpenFailed,
        ErrorCode::TelemetrySpyStreamError,
        ErrorCode::TelemetrySpyEmitFailed,
        ErrorCode::TelephonyNumberTooLong,
        ErrorCode::TelephonyCallIdTooLong,
        ErrorCode::TelephonyRpcFailed,
        ErrorCode::TelephonyWatchOpenFailed,
        ErrorCode::TelephonyWatchStreamError,
        ErrorCode::TelephonyRecordingRefused,
        ErrorCode::TelephonyMuteRefused,
        ErrorCode::TelephonySpeakerRefused,
        ErrorCode::TelephonyHoldRefused,
        ErrorCode::TelephonyDtmfRefused,
        ErrorCode::RadioUnknownKey,
        ErrorCode::RadioAddressInvalid,
        ErrorCode::RadioRpcFailed,
        ErrorCode::RadioNoSystemSurface,
        ErrorCode::SmsBlankId,
        ErrorCode::SmsIdTooLong,
        ErrorCode::SmsUnknownFolder,
        ErrorCode::SmsBlockedSender,
        ErrorCode::SmsTextTooLong,
        ErrorCode::SmsProviderRejected,
        ErrorCode::SmsForegroundRequired,
        ErrorCode::MailForegroundRequired,
        ErrorCode::MailInvalidArgument,
        ErrorCode::MailProviderRejected,
        ErrorCode::MailPersistFailed,
        ErrorCode::RecordingsForegroundRequired,
        ErrorCode::RecordingsReadFailed,
        ErrorCode::AiPromptTooLong,
        ErrorCode::AiSessionIdTooLong,
        ErrorCode::AiBackendPayloadTooLong,
        ErrorCode::AiAndroidPackageInvalid,
        ErrorCode::AiRpcFailed,
        ErrorCode::AiBackendSwitchFailed,
        ErrorCode::RagPayloadTooLong,
        ErrorCode::RagRpcFailed,
        ErrorCode::RagForegroundRequired,
        ErrorCode::AppStoreIdEmpty,
        ErrorCode::AppStoreIdTooLong,
        ErrorCode::AppStoreIdInvalid,
        ErrorCode::AppStoreInstallFailed,
        ErrorCode::AppStoreUpgradeFailed,
        ErrorCode::AppStoreUninstallFailed,
        ErrorCode::AppStoreRpcFailed,
        ErrorCode::PodcastUrlInvalid,
        ErrorCode::PodcastUrlSchemeUnsupported,
        ErrorCode::PodcastFetchFailed,
        ErrorCode::PodcastParseFailed,
        ErrorCode::PodcastFeedRejected,
        ErrorCode::PodcastUnknownFeed,
        ErrorCode::PodcastSubscriptionLimitReached,
        ErrorCode::PodcastStoreFailed,
        ErrorCode::PodcastDownloadFailed,
        ErrorCode::PodcastNoAudio,
        ErrorCode::PodcastDownloadUnsupported,
        ErrorCode::PodcastDownloadNoDir,
        ErrorCode::PodcastEpisodeIdEmpty,
        ErrorCode::PodcastEpisodeIdTooLong,
        ErrorCode::PodcastRpcFailed,
        ErrorCode::SpacesLockFailed,
        ErrorCode::SpacesSerializationFailed,
        ErrorCode::SpacesNotFound,
        ErrorCode::SpacesIndexOutOfBounds,
        ErrorCode::SpacesDeleteLast,
        ErrorCode::BleConnectFailed,
        ErrorCode::NfcNotInitialized,
        ErrorCode::BiometricNoActivity,
        ErrorCode::SessionUnsupportedHost,
        ErrorCode::SessionSpawnFailed,
        ErrorCode::PrintUnsupportedPlatform,
        ErrorCode::PrintNoWindow,
        ErrorCode::PrintDialogFailed,
        ErrorCode::HostFsRootNotConfigured,
        ErrorCode::HostFsRootNotFound,
        ErrorCode::HostFsRootNotADir,
        ErrorCode::HostFsPathNotFound,
        ErrorCode::HostFsPathIsADir,
        ErrorCode::HostFsPathIsNotADir,
        ErrorCode::HostFsPathEscapesRoot,
        ErrorCode::HostFsFileTooLarge,
        ErrorCode::HostFsReadFailed,
        ErrorCode::HostFsWriteFailed,
        ErrorCode::HostFsReadNotUtf8,
        ErrorCode::HostFsWriteAtomicsFailed,
        ErrorCode::HostFsTargetExists,
        ErrorCode::HostFsDirNotEmpty,
        ErrorCode::HostFsRecursionLimit,
        ErrorCode::HostFsCreateDirFailed,
        ErrorCode::HostFsRemoveFailed,
        ErrorCode::HostFsRenameFailed,
        ErrorCode::HostFsCopyFailed,
        ErrorCode::PushTokenInvalid,
        ErrorCode::PushPayloadTooLong,
        ErrorCode::PushReceiveFailed,
        ErrorCode::PushLockFailed,
        ErrorCode::WebmanUrlInvalid,
        ErrorCode::WebmanDownloadFailed,
        ErrorCode::WebmanDownloadTooLarge,
        ErrorCode::WebmanIoFailed,
        ErrorCode::StageDisabled,
        ErrorCode::StageWindowUnknown,
        ErrorCode::StageWindowIsScreen,
        ErrorCode::StageWindowInSplit,
        ErrorCode::StagePersistFailed,
        ErrorCode::StageUnsupported,
        ErrorCode::StageLockFailed,
        ErrorCode::StageArrangeImpossible,
        ErrorCode::ScreenRecordAlreadyRecording,
        ErrorCode::ScreenRecordNotRecording,
        ErrorCode::ScreenRecordUnsupported,
        ErrorCode::ScreenRecordSpawnFailed,
        ErrorCode::ScreenRecordStopFailed,
        ErrorCode::ScreenRecordConfirmFailed,
        ErrorCode::ScreenRecordDurationOutOfRange,
        ErrorCode::ScreenRecordForegroundRequired,
        ErrorCode::ImeSystemGlueUnavailable,
        ErrorCode::ImeSystemOpenFailed,
        ErrorCode::ImeSystemNoTextEditor,
        ErrorCode::InterpretNoActive,
        ErrorCode::InterpretSessionIdMismatch,
        ErrorCode::InterpretTextTooLong,
        ErrorCode::InterpretAudioTooLarge,
        ErrorCode::InterpretSessionFailed,
        ErrorCode::InterpretChannelFailed,
        ErrorCode::WmWindowNotRegistered,
        ErrorCode::WmWindowNotFound,
        ErrorCode::WmWindowInSplit,
        ErrorCode::WmFormFactorNoUi,
        ErrorCode::WmStageRailNotAvailable,
        ErrorCode::WmSelfSplit,
        ErrorCode::WmLauncherSplit,
        ErrorCode::WmSplitNotActive,
        ErrorCode::WmSplitRatioInfeasible,
        ErrorCode::WmSnapZoneUnknown,
        ErrorCode::WmAxisUnknown,
        ErrorCode::WmPlatformWindowFailed,
        ErrorCode::WmIdentityRefused,
        ErrorCode::WmLabelAlreadyBound,
        ErrorCode::WmTitleInvalid,
        ErrorCode::WmLockFailed,
        ErrorCode::WmLayoutFailed,
        ErrorCode::WmSplitNeedsTwoWindows,
    ];

    #[test]
    fn codes_are_distinct_stability_keys() {
        let codes = ALL_VARIANTS;
        let mut seen = std::collections::HashSet::new();
        for c in codes {
            let s = c.as_str();
            assert!(seen.insert(s), "duplicate code string: {s}");
            assert!(s.starts_with("amos."), "code must be namespaced: {s}");
        }
    }

    /// The wire codes are a **stability contract**: the frontend i18n layer
    /// branches on these exact strings, so renaming one is a wire break.
    ///
    /// `codes_are_distinct_stability_keys` above only checks that the keys are
    /// distinct and namespaced — it asserts **no value**. This test pins every
    /// value, so an accidental rename in `as_str` (the one declaration the
    /// per-module `codes::` constants now derive from) fails here instead of
    /// silently breaking every consumer of that code.
    ///
    /// REQ-A870 corrected this test's own claim. It used to say "a variant added to the enum
    /// without a frozen value (or a stale entry) is caught here too", and that sentence was
    /// **false**: `seen` is built from `frozen` itself, so `seen.len()` can only ever equal the
    /// table's own size — the constant was the only thing that could notice a missing entry, and
    /// a variant missing from *both* the table and the constant's arithmetic was invisible.
    /// Measured (REQ-A869/A870): deleting the three `Print*` entries and leaving the constant at
    /// its old value kept this test green. The set comparison against [`ALL_VARIANTS`] below
    /// closes that direction; the enum→list link stays a human obligation (see
    /// [`ALL_VARIANTS`]' doc for why stable Rust cannot close it here).
    const FROZEN_VARIANT_COUNT: usize = 159;

    #[test]
    fn wire_codes_are_frozen() {
        let frozen: &[(ErrorCode, &str)] = &[
            (ErrorCode::ButtonsUnknown, "amos.buttons.unknown"),
            (ErrorCode::ButtonsNameTooLong, "amos.buttons.name_too_long"),
            (
                ErrorCode::ButtonsDeliveryFailed,
                "amos.buttons.delivery_failed",
            ),
            (
                ErrorCode::DisplayContractMissing,
                "amos.display.contract_missing",
            ),
            (ErrorCode::DisplayWriteFailed, "amos.display.write_failed"),
            (
                ErrorCode::DisplayReadMalformed,
                "amos.display.read_malformed",
            ),
            (
                ErrorCode::FlashlightStoredShapeInvalid,
                "amos.flashlight.stored_shape_invalid",
            ),
            (
                ErrorCode::FlashlightProviderUnconfirmed,
                "amos.flashlight.provider_unconfirmed",
            ),
            (
                ErrorCode::NetGuardToggleFailed,
                "amos.netguard.toggle_failed",
            ),
            (
                ErrorCode::NetGuardStatusFailed,
                "amos.netguard.status_failed",
            ),
            (
                ErrorCode::NetGuardEgressFailed,
                "amos.netguard.egress_failed",
            ),
            (ErrorCode::SensorsUnknownMode, "amos.sensors.unknown_mode"),
            (ErrorCode::SensorsUnknownKind, "amos.sensors.unknown_kind"),
            (
                ErrorCode::SensorsRateOutOfRange,
                "amos.sensors.rate_out_of_range",
            ),
            (ErrorCode::SensorsRpcFailed, "amos.sensors.rpc_failed"),
            (
                ErrorCode::TelemetrySpyWatchOpenFailed,
                "amos.telemetry_spy.watch_open_failed",
            ),
            (
                ErrorCode::TelemetrySpyStreamError,
                "amos.telemetry_spy.stream_error",
            ),
            (
                ErrorCode::TelemetrySpyEmitFailed,
                "amos.telemetry_spy.emit_failed",
            ),
            (
                ErrorCode::TelephonyNumberTooLong,
                "amos.telephony.number_too_long",
            ),
            (
                ErrorCode::TelephonyCallIdTooLong,
                "amos.telephony.call_id_too_long",
            ),
            (ErrorCode::TelephonyRpcFailed, "amos.telephony.rpc_failed"),
            (
                ErrorCode::TelephonyWatchOpenFailed,
                "amos.telephony.watch_open_failed",
            ),
            (
                ErrorCode::TelephonyWatchStreamError,
                "amos.telephony.watch_stream_error",
            ),
            (
                ErrorCode::TelephonyRecordingRefused,
                "amos.telephony.recording_refused",
            ),
            (
                ErrorCode::TelephonyMuteRefused,
                "amos.telephony.mute_refused",
            ),
            (
                ErrorCode::TelephonySpeakerRefused,
                "amos.telephony.speaker_refused",
            ),
            (
                ErrorCode::TelephonyHoldRefused,
                "amos.telephony.hold_refused",
            ),
            (
                ErrorCode::TelephonyDtmfRefused,
                "amos.telephony.dtmf_refused",
            ),
            (ErrorCode::RadioUnknownKey, "amos.radio.unknown_key"),
            (ErrorCode::RadioAddressInvalid, "amos.radio.address_invalid"),
            (ErrorCode::RadioRpcFailed, "amos.radio.rpc_failed"),
            (
                ErrorCode::RadioNoSystemSurface,
                "amos.radio.no_system_surface",
            ),
            (ErrorCode::SmsBlankId, "amos.sms.blank_id"),
            (ErrorCode::SmsIdTooLong, "amos.sms.id_too_long"),
            (ErrorCode::SmsUnknownFolder, "amos.sms.unknown_folder"),
            (ErrorCode::SmsBlockedSender, "amos.sms.blocked_sender"),
            (ErrorCode::SmsTextTooLong, "amos.sms.text_too_long"),
            (ErrorCode::SmsProviderRejected, "amos.sms.provider_rejected"),
            (
                ErrorCode::SmsForegroundRequired,
                "amos.sms.foreground_required",
            ),
            (
                ErrorCode::MailForegroundRequired,
                "amos.mail.foreground_required",
            ),
            (ErrorCode::MailInvalidArgument, "amos.mail.invalid_argument"),
            (
                ErrorCode::MailProviderRejected,
                "amos.mail.provider_rejected",
            ),
            (ErrorCode::MailPersistFailed, "amos.mail.persist_failed"),
            (
                ErrorCode::RecordingsForegroundRequired,
                "amos.recordings.foreground_required",
            ),
            (
                ErrorCode::RecordingsReadFailed,
                "amos.recordings.read_failed",
            ),
            (ErrorCode::AiPromptTooLong, "amos.ai.prompt_too_long"),
            (ErrorCode::AiSessionIdTooLong, "amos.ai.session_id_too_long"),
            (
                ErrorCode::AiBackendPayloadTooLong,
                "amos.ai.backend_payload_too_long",
            ),
            (
                ErrorCode::AiAndroidPackageInvalid,
                "amos.ai.android_package_invalid",
            ),
            (ErrorCode::AiRpcFailed, "amos.ai.rpc_failed"),
            (
                ErrorCode::AiBackendSwitchFailed,
                "amos.ai.backend_switch_failed",
            ),
            (ErrorCode::RagPayloadTooLong, "amos.rag.payload_too_long"),
            (ErrorCode::RagRpcFailed, "amos.rag.rpc_failed"),
            (
                ErrorCode::RagForegroundRequired,
                "amos.rag.foreground_required",
            ),
            (ErrorCode::AppStoreIdEmpty, "amos.appstore.id_empty"),
            (ErrorCode::AppStoreIdTooLong, "amos.appstore.id_too_long"),
            (ErrorCode::AppStoreIdInvalid, "amos.appstore.id_invalid"),
            (
                ErrorCode::AppStoreInstallFailed,
                "amos.appstore.install_failed",
            ),
            (
                ErrorCode::AppStoreUpgradeFailed,
                "amos.appstore.upgrade_failed",
            ),
            (
                ErrorCode::AppStoreUninstallFailed,
                "amos.appstore.uninstall_failed",
            ),
            (ErrorCode::AppStoreRpcFailed, "amos.appstore.rpc_failed"),
            (ErrorCode::PodcastUrlInvalid, "amos.podcast.url_invalid"),
            (
                ErrorCode::PodcastUrlSchemeUnsupported,
                "amos.podcast.url_scheme_unsupported",
            ),
            (ErrorCode::PodcastFetchFailed, "amos.podcast.fetch_failed"),
            (ErrorCode::PodcastParseFailed, "amos.podcast.parse_failed"),
            (ErrorCode::PodcastFeedRejected, "amos.podcast.feed_rejected"),
            (ErrorCode::PodcastUnknownFeed, "amos.podcast.unknown_feed"),
            (
                ErrorCode::PodcastSubscriptionLimitReached,
                "amos.podcast.subscription_limit",
            ),
            (ErrorCode::PodcastStoreFailed, "amos.podcast.store_failed"),
            (
                ErrorCode::PodcastDownloadFailed,
                "amos.podcast.download_failed",
            ),
            (ErrorCode::PodcastNoAudio, "amos.podcast.no_audio"),
            (
                ErrorCode::PodcastDownloadUnsupported,
                "amos.podcast.download_unsupported",
            ),
            (
                ErrorCode::PodcastDownloadNoDir,
                "amos.podcast.download_no_dir",
            ),
            (
                ErrorCode::PodcastEpisodeIdEmpty,
                "amos.podcast.episode_id_empty",
            ),
            (
                ErrorCode::PodcastEpisodeIdTooLong,
                "amos.podcast.episode_id_too_long",
            ),
            (ErrorCode::PodcastRpcFailed, "amos.podcast.rpc_failed"),
            (ErrorCode::SpacesLockFailed, "amos.spaces.lock_failed"),
            (
                ErrorCode::SpacesSerializationFailed,
                "amos.spaces.serialization_failed",
            ),
            (ErrorCode::SpacesNotFound, "amos.spaces.not_found"),
            (
                ErrorCode::SpacesIndexOutOfBounds,
                "amos.spaces.index_out_of_bounds",
            ),
            (ErrorCode::SpacesDeleteLast, "amos.spaces.delete_last"),
            (ErrorCode::BleConnectFailed, "amos.ble.connect_failed"),
            (ErrorCode::NfcNotInitialized, "amos.nfc.not_initialized"),
            (ErrorCode::BiometricNoActivity, "amos.biometric.no_activity"),
            (
                ErrorCode::SessionUnsupportedHost,
                "amos.session.unsupported_host",
            ),
            (ErrorCode::SessionSpawnFailed, "amos.session.spawn_failed"),
            (
                ErrorCode::PrintUnsupportedPlatform,
                "amos.print.unsupported_platform",
            ),
            (ErrorCode::PrintNoWindow, "amos.print.no_window"),
            (ErrorCode::PrintDialogFailed, "amos.print.dialog_failed"),
            (
                ErrorCode::HostFsRootNotConfigured,
                "amos.host_fs.root_not_configured",
            ),
            (ErrorCode::HostFsRootNotFound, "amos.host_fs.root_not_found"),
            (ErrorCode::HostFsRootNotADir, "amos.host_fs.root_not_a_dir"),
            (ErrorCode::HostFsPathNotFound, "amos.host_fs.path_not_found"),
            (ErrorCode::HostFsPathIsADir, "amos.host_fs.path_is_a_dir"),
            (
                ErrorCode::HostFsPathIsNotADir,
                "amos.host_fs.path_is_not_a_dir",
            ),
            (
                ErrorCode::HostFsPathEscapesRoot,
                "amos.host_fs.path_escapes_root",
            ),
            (ErrorCode::HostFsFileTooLarge, "amos.host_fs.file_too_large"),
            (ErrorCode::HostFsReadFailed, "amos.host_fs.read_failed"),
            (ErrorCode::HostFsWriteFailed, "amos.host_fs.write_failed"),
            (ErrorCode::HostFsReadNotUtf8, "amos.host_fs.read_not_utf8"),
            (
                ErrorCode::HostFsWriteAtomicsFailed,
                "amos.host_fs.write_atomics_failed",
            ),
            (ErrorCode::HostFsTargetExists, "amos.host_fs.target_exists"),
            (ErrorCode::HostFsDirNotEmpty, "amos.host_fs.dir_not_empty"),
            (
                ErrorCode::HostFsRecursionLimit,
                "amos.host_fs.recursion_limit",
            ),
            (
                ErrorCode::HostFsCreateDirFailed,
                "amos.host_fs.create_dir_failed",
            ),
            (ErrorCode::HostFsRemoveFailed, "amos.host_fs.remove_failed"),
            (ErrorCode::HostFsRenameFailed, "amos.host_fs.rename_failed"),
            (ErrorCode::HostFsCopyFailed, "amos.host_fs.copy_failed"),
            (ErrorCode::PushTokenInvalid, "amos.push.token_invalid"),
            (ErrorCode::PushPayloadTooLong, "amos.push.payload_too_long"),
            (ErrorCode::PushReceiveFailed, "amos.push.receive_failed"),
            (ErrorCode::PushLockFailed, "amos.push.lock_failed"),
            (ErrorCode::WebmanUrlInvalid, "amos.webman.url_invalid"),
            (
                ErrorCode::WebmanDownloadFailed,
                "amos.webman.download_failed",
            ),
            (
                ErrorCode::WebmanDownloadTooLarge,
                "amos.webman.download_too_large",
            ),
            (ErrorCode::WebmanIoFailed, "amos.webman.io_failed"),
            (ErrorCode::StageDisabled, "amos.stage.disabled"),
            (ErrorCode::StageWindowUnknown, "amos.stage.window_unknown"),
            (
                ErrorCode::StageWindowIsScreen,
                "amos.stage.window_is_screen",
            ),
            (ErrorCode::StageWindowInSplit, "amos.stage.window_in_split"),
            (ErrorCode::StagePersistFailed, "amos.stage.persist_failed"),
            (ErrorCode::StageUnsupported, "amos.stage.unsupported"),
            (ErrorCode::StageLockFailed, "amos.stage.lock_failed"),
            (
                ErrorCode::StageArrangeImpossible,
                "amos.stage.arrange_impossible",
            ),
            (
                ErrorCode::ScreenRecordAlreadyRecording,
                "amos.screenrecord.already_recording",
            ),
            (
                ErrorCode::ScreenRecordNotRecording,
                "amos.screenrecord.not_recording",
            ),
            (
                ErrorCode::ScreenRecordUnsupported,
                "amos.screenrecord.unsupported",
            ),
            (
                ErrorCode::ScreenRecordSpawnFailed,
                "amos.screenrecord.spawn_failed",
            ),
            (
                ErrorCode::ScreenRecordStopFailed,
                "amos.screenrecord.stop_failed",
            ),
            (
                ErrorCode::ScreenRecordConfirmFailed,
                "amos.screenrecord.confirm_failed",
            ),
            (
                ErrorCode::ScreenRecordDurationOutOfRange,
                "amos.screenrecord.duration_out_of_range",
            ),
            (
                ErrorCode::ScreenRecordForegroundRequired,
                "amos.screenrecord.foreground_required",
            ),
            (
                ErrorCode::ImeSystemGlueUnavailable,
                "amos.ime.system_glue_unavailable",
            ),
            (
                ErrorCode::ImeSystemOpenFailed,
                "amos.ime.system_open_failed",
            ),
            (
                ErrorCode::ImeSystemNoTextEditor,
                "amos.ime.system_no_text_editor",
            ),
            (ErrorCode::InterpretNoActive, "amos.interpret.no_active"),
            (
                ErrorCode::InterpretSessionIdMismatch,
                "amos.interpret.session_id_mismatch",
            ),
            (
                ErrorCode::InterpretTextTooLong,
                "amos.interpret.text_too_long",
            ),
            (
                ErrorCode::InterpretAudioTooLarge,
                "amos.interpret.audio_too_large",
            ),
            (
                ErrorCode::InterpretSessionFailed,
                "amos.interpret.session_failed",
            ),
            (
                ErrorCode::InterpretChannelFailed,
                "amos.interpret.channel_failed",
            ),
            (
                ErrorCode::WmWindowNotRegistered,
                "amos.wm.window_not_registered",
            ),
            (ErrorCode::WmWindowNotFound, "amos.wm.window_not_found"),
            (ErrorCode::WmWindowInSplit, "amos.wm.window_in_split"),
            (ErrorCode::WmFormFactorNoUi, "amos.wm.form_factor_no_ui"),
            (
                ErrorCode::WmStageRailNotAvailable,
                "amos.wm.stage_rail_not_available",
            ),
            (ErrorCode::WmSelfSplit, "amos.wm.self_split"),
            (ErrorCode::WmLauncherSplit, "amos.wm.launcher_split"),
            (ErrorCode::WmSplitNotActive, "amos.wm.split_not_active"),
            (
                ErrorCode::WmSplitRatioInfeasible,
                "amos.wm.split_ratio_infeasible",
            ),
            (ErrorCode::WmSnapZoneUnknown, "amos.wm.snap_zone_unknown"),
            (ErrorCode::WmAxisUnknown, "amos.wm.axis_unknown"),
            (
                ErrorCode::WmPlatformWindowFailed,
                "amos.wm.platform_window_failed",
            ),
            (ErrorCode::WmIdentityRefused, "amos.wm.identity_refused"),
            (
                ErrorCode::WmLabelAlreadyBound,
                "amos.wm.label_already_bound",
            ),
            (ErrorCode::WmTitleInvalid, "amos.wm.title_invalid"),
            (ErrorCode::WmLockFailed, "amos.wm.lock_failed"),
            (ErrorCode::WmLayoutFailed, "amos.wm.layout_failed"),
            (
                ErrorCode::WmSplitNeedsTwoWindows,
                "amos.wm.split_needs_two_windows",
            ),
        ];
        // Every variant must appear exactly once: a variant added to the enum
        // without a frozen value (or a stale entry) is caught here too.
        let mut seen = std::collections::HashSet::new();
        for (code, expected) in frozen {
            let actual = code.as_str();
            assert_eq!(
                actual, *expected,
                "wire code for {code:?} changed: {actual} != {expected} — this is a wire break,                  not a refactor; update the frontend i18n mirror in the same change"
            );
            assert!(seen.insert(*code), "duplicate frozen entry for {code:?}");
        }
        assert_eq!(
            seen.len(),
            FROZEN_VARIANT_COUNT,
            "the frozen table and the enum have diverged — add the new variant's code here"
        );
        // …and the two hand-written lists must be the **same set**, both ways. `seen` grows out
        // of the table above, so on its own it can only ever agree with itself: a variant the
        // enum knows but this table forgot used to leave every assertion here green (measured,
        // REQ-A870). Comparing against `ALL_VARIANTS` — the list `codes_are_distinct_stability_keys`
        // walks — makes a one-sided edit red, whichever side it is on.
        let listed: std::collections::HashSet<ErrorCode> = ALL_VARIANTS.iter().copied().collect();
        let missing_from_frozen: Vec<&str> = listed.difference(&seen).map(|c| c.as_str()).collect();
        assert!(
            missing_from_frozen.is_empty(),
            "these variants are in ALL_VARIANTS but have no frozen value: {missing_from_frozen:?}"
        );
        let missing_from_listed: Vec<&str> = seen.difference(&listed).map(|c| c.as_str()).collect();
        assert!(
            missing_from_listed.is_empty(),
            "the frozen table names variants ALL_VARIANTS does not: {missing_from_listed:?}"
        );
    }

    #[test]
    fn group_is_the_module_after_the_amos_prefix() {
        assert_eq!(ErrorCode::ButtonsUnknown.group(), "buttons");
        assert_eq!(ErrorCode::NetGuardToggleFailed.group(), "netguard");
        assert_eq!(ErrorCode::SensorsUnknownMode.group(), "sensors");
        assert_eq!(ErrorCode::DisplayContractMissing.group(), "display");
        assert_eq!(ErrorCode::TelemetrySpyEmitFailed.group(), "telemetry_spy");
        assert_eq!(
            ErrorCode::FlashlightStoredShapeInvalid.group(),
            "flashlight"
        );
        // The follow-up groups added when migrating telephony / sms / radio /
        // ai / rag to typed envelopes: each module's variants must collapse to
        // the same group so a single tracing filter scopes the whole surface.
        assert_eq!(ErrorCode::TelephonyRpcFailed.group(), "telephony");
        assert_eq!(ErrorCode::TelephonyRecordingRefused.group(), "telephony");
        assert_eq!(ErrorCode::RadioRpcFailed.group(), "radio");
        assert_eq!(ErrorCode::SmsProviderRejected.group(), "sms");
        assert_eq!(ErrorCode::SmsForegroundRequired.group(), "sms");
        assert_eq!(ErrorCode::MailForegroundRequired.group(), "mail");
        assert_eq!(
            ErrorCode::RecordingsForegroundRequired.group(),
            "recordings"
        );
        assert_eq!(ErrorCode::RecordingsReadFailed.group(), "recordings");
        assert_eq!(ErrorCode::MailInvalidArgument.group(), "mail");
        assert_eq!(ErrorCode::MailProviderRejected.group(), "mail");
        assert_eq!(ErrorCode::MailPersistFailed.group(), "mail");
        assert_eq!(ErrorCode::AiRpcFailed.group(), "ai");
        assert_eq!(ErrorCode::RagRpcFailed.group(), "rag");
        assert_eq!(ErrorCode::RagForegroundRequired.group(), "rag");
        assert_eq!(ErrorCode::AppStoreInstallFailed.group(), "appstore");
        assert_eq!(ErrorCode::PodcastFetchFailed.group(), "podcast");
        assert_eq!(ErrorCode::PodcastUnknownFeed.group(), "podcast");
        assert_eq!(ErrorCode::SpacesLockFailed.group(), "spaces");
        assert_eq!(ErrorCode::SpacesNotFound.group(), "spaces");
        assert_eq!(ErrorCode::SessionUnsupportedHost.group(), "session");
        assert_eq!(ErrorCode::SessionSpawnFailed.group(), "session");
        assert_eq!(ErrorCode::HostFsRootNotConfigured.group(), "host_fs");
        assert_eq!(ErrorCode::HostFsPathEscapesRoot.group(), "host_fs");
        assert_eq!(ErrorCode::PushTokenInvalid.group(), "push");
        assert_eq!(ErrorCode::PushPayloadTooLong.group(), "push");
        assert_eq!(ErrorCode::WebmanUrlInvalid.group(), "webman");
        assert_eq!(ErrorCode::WebmanDownloadFailed.group(), "webman");
        // REQ-A461: the 6 interpret variants (typed envelope follow-up) share a
        // single `interpret` group so a tracing filter / i18n namespace scopes
        // the whole surface — pinning that here means a future rename would be
        // caught at this single test.
        assert_eq!(ErrorCode::InterpretNoActive.group(), "interpret");
        assert_eq!(ErrorCode::InterpretSessionIdMismatch.group(), "interpret");
        assert_eq!(ErrorCode::InterpretTextTooLong.group(), "interpret");
        assert_eq!(ErrorCode::InterpretAudioTooLarge.group(), "interpret");
        assert_eq!(ErrorCode::InterpretSessionFailed.group(), "interpret");
        assert_eq!(ErrorCode::InterpretChannelFailed.group(), "interpret");
        // REQ-A462: the 12 window-manager variants (typed envelope follow-up)
        // share a single `wm` group so a tracing filter / i18n namespace
        // scopes the whole surface — pinning that here means a future rename
        // would be caught at this single test, and the constant above catches
        // a variant added on either side without the other.
        assert_eq!(ErrorCode::WmWindowNotRegistered.group(), "wm");
        assert_eq!(ErrorCode::WmWindowNotFound.group(), "wm");
        assert_eq!(ErrorCode::WmWindowInSplit.group(), "wm");
        assert_eq!(ErrorCode::WmFormFactorNoUi.group(), "wm");
        assert_eq!(ErrorCode::WmStageRailNotAvailable.group(), "wm");
        assert_eq!(ErrorCode::WmSelfSplit.group(), "wm");
        assert_eq!(ErrorCode::WmLauncherSplit.group(), "wm");
        assert_eq!(ErrorCode::WmSplitNotActive.group(), "wm");
        assert_eq!(ErrorCode::WmSplitRatioInfeasible.group(), "wm");
        assert_eq!(ErrorCode::WmSnapZoneUnknown.group(), "wm");
        assert_eq!(ErrorCode::WmPlatformWindowFailed.group(), "wm");
        assert_eq!(ErrorCode::WmIdentityRefused.group(), "wm");
        assert_eq!(ErrorCode::WmLabelAlreadyBound.group(), "wm");
        assert_eq!(ErrorCode::WmTitleInvalid.group(), "wm");
        assert_eq!(ErrorCode::WmLockFailed.group(), "wm");
        assert_eq!(ErrorCode::WmLayoutFailed.group(), "wm");
        assert_eq!(ErrorCode::WmSplitNeedsTwoWindows.group(), "wm");
    }

    /// REQ-A462 negative control: deleting the constant's declaration or the
    /// `wc.frozen` loop's assertion on FROZEN_VARIANT_COUNT would let a future
    /// drift between [`ALL_VARIANTS`] and the frozen table slip through
    /// unnoticed. This test pins **both** numbers, derived from the source of
    /// truth (the enum itself), so an edit on only one side is caught here.
    #[test]
    fn wm_frozen_count_is_pinned() {
        // Total variants = 156 (this run). 18 are window manager.
        assert_eq!(FROZEN_VARIANT_COUNT, 159);
        let wm = ALL_VARIANTS
            .iter()
            // Match `amos.wm.<kind>` exactly — anything starting with `amos.wm.`
            // but with more components (`amos.webman.*`, `amos.wm_manager.*`)
            // is in a different group and would only show up here as noise.
            .filter(|c| {
                let s = c.as_str();
                s.starts_with("amos.wm.") && s[8..].find('.').is_none()
            })
            .count();
        assert_eq!(
            wm, 18,
            "wm.* variant count drifted from 18 — a rename in `as_str` or a \
             forgotten entry in ALL_VARIANTS / frozen is now wrong"
        );
    }

    #[test]
    fn envelope_serialises_with_code_and_message() {
        let e = AmosError::new(ErrorCode::ButtonsUnknown, "boop");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "amos.buttons.unknown");
        assert_eq!(v["message"], "boop");
        assert!(v.get("cause").is_none(), "no cause field on empty chain");
    }

    #[test]
    fn envelope_serialises_the_cause_chain_when_present() {
        let e = AmosError::with_cause(ErrorCode::NetGuardStatusFailed, "status", "daemon down");
        let e = e.push_cause("socket closed");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "amos.netguard.status_failed");
        assert_eq!(v["cause"][0], "daemon down");
        assert_eq!(v["cause"][1], "socket closed");
    }

    #[test]
    fn into_envelope_preserves_the_underlying_message() {
        let e: AmosError = "rpc failed".into_envelope(ErrorCode::NetGuardToggleFailed);
        assert_eq!(e.code(), "amos.netguard.toggle_failed");
        assert_eq!(e.message, "amos.netguard.toggle_failed");
        assert_eq!(e.cause, vec!["rpc failed".to_string()]);
    }
}
