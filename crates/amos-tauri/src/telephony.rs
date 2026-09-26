//! Tauri <-> telephony service bridge.
//!
//! The WebView's dialer calls `telephony_dial`/`telephony_end`/`telephony_status`;
//! these open a tonic `TelephonyClient` over the OS daemon's Unix Domain Socket
//! (the *same* socket that carries `AiAgent` + `AndroidManager` + `Telephony`),
//! run the unary RPC, and return serializable payloads to the frontend. If the
//! daemon is absent each command fails with a descriptive error (the UI shows a
//! "daemon not connected" state rather than crashing).
//!
//! [`spawn_telephony_watch`] additionally opens a *long-lived* `Watch` stream and
//! forwards each call-state event to the WebView as a `telephony-event` (incoming /
//! connected / ended), so the UI can show a live incoming-call surface and reflect
//! an outgoing call reaching `Active` (and therefore becoming recordable) without
//! polling.

use amos_proto::amos_telephony::{
    telephony_client::TelephonyClient, AnswerRequest, CallIdMsg, CallSnapshot, DialRequest,
    EndRequest, MuteRequest, SimulateIncomingRequest, StatusRequest, WatchRequest,
};
use amos_proto::amos_telephony::{
    CallDirection as ProtoDirection, CallState as ProtoState, RecordingState as ProtoRecording,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, Duration};

use crate::error::{AmosError, ErrorCode};

/// Tauri event name carrying one `TelephonyCallPayload` per daemon `Watch` event.
pub const TELEPHONY_EVENT: &str = "telephony-event";

/// Wire vocabulary for the telephony module. The UI i18n layer branches on
/// these; renaming a variant is a wire break. Kept alongside the constants
/// so the code names match the typed envelopes below without grepping.
pub mod codes {
    use crate::error::ErrorCode;
    /// Caller-supplied number exceeds [`super::MAX_TELEPHONY_DIAL_BYTES`].
    pub const NUMBER_TOO_LONG: &str = ErrorCode::TelephonyNumberTooLong.as_str();
    /// Caller-supplied call id exceeds [`super::MAX_TELEPHONY_CALL_ID_BYTES`].
    pub const CALL_ID_TOO_LONG: &str = ErrorCode::TelephonyCallIdTooLong.as_str();
    /// Any telephony RPC failed (daemon unreachable / rejected).
    pub const RPC_FAILED: &str = ErrorCode::TelephonyRpcFailed.as_str();
    /// `spawn_telephony_watch` could not open the long-lived `Watch` stream.
    pub const WATCH_OPEN_FAILED: &str = ErrorCode::TelephonyWatchOpenFailed.as_str();
    /// A `Watch` event could not be read off the stream.
    pub const WATCH_STREAM_ERROR: &str = ErrorCode::TelephonyWatchStreamError.as_str();
    /// The in-call recording toggle was refused (not the focused window / not the
    /// default dialer / the bound in-call service rejected or answered unknown).
    pub const RECORDING_REFUSED: &str = ErrorCode::TelephonyRecordingRefused.as_str();
    /// The in-call mute toggle was refused (the bound in-call service declined, or the
    /// JNI call failed). Distinct from [`RECORDING_REFUSED`] so the UI can say which
    /// control failed.
    pub const MUTE_REFUSED: &str = ErrorCode::TelephonyMuteRefused.as_str();
    /// The in-call loudspeaker route toggle was refused by the bound in-call service.
    pub const SPEAKER_REFUSED: &str = ErrorCode::TelephonySpeakerRefused.as_str();
    /// The in-call hold toggle was refused (the call was not holdable).
    pub const HOLD_REFUSED: &str = ErrorCode::TelephonyHoldRefused.as_str();
    /// An in-call DTMF tone could not be sent (no in-call bridge, or a non-tone input).
    pub const DTMF_REFUSED: &str = ErrorCode::TelephonyDtmfRefused.as_str();
}

/// Which owner a `telephony_answer` / `telephony_end` command must act on (REQ-A811).
///
/// Two things can own a call: the bound `AmosInCallService` (a **real** Telecom call, once
/// AmOS is the device's default phone app) and the daemon (the mock/demo transport). Which
/// one owns *this* command is decided by **whether the in-call service is bound** — never by
/// the control call's own reply. See [`real_call_route`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RealCallRoute {
    /// An in-call service is bound and performed the control action; the command is done.
    Handled,
    /// No in-call service owns this call — the daemon (mock/demo) path must run.
    Daemon,
    /// An in-call service **is** bound but could not perform the action. The reason is kept
    /// verbatim so the command can fail honestly instead of reporting a call state it did
    /// not achieve.
    Refused(String),
}

/// Route a real-call control command (`answer` / `hang-up`).
///
/// `bound` is [`crate::incall::is_default_dialer_bound`] — the same discriminator the recording
/// commands in this file gate on. `action` is the in-call control call
/// ([`crate::incall::real_answer`] / [`crate::incall::real_hang_up`]) and is **not invoked when
/// nothing is bound**: a JNI round-trip would then only produce a failure with nothing to say.
///
/// The `Err` arm is the whole point of this function. The shipped call sites wrote
/// `.unwrap_or(false)` on that reply, which folds **"we could not reach the in-call service"**
/// into **"there is no real call"**: the daemon's call was then ended/answered and the command
/// returned `Ok(())`, so the WebView reported the call gone while the real Telecom call kept
/// ringing / stayed connected — and kept being billed.
///
/// The frontend half of this contract already exists: `IncomingCall.svelte::actionRefusal`
/// reads the command's diagnostic slot and names the action that refused and the state the
/// user sees — `phone.answerFailed` / `phone.declineFailed` both say the call is still
/// *ringing*, and the in-call hang-up (`phone.hangupFailed`) says it was *not ended*
/// (REQ-A1088). It is reachable only if this function refuses loudly, so the two halves are
/// a pair (F-SH-236 fixed the reader; this fixes the writer).
pub fn real_call_route(
    bound: bool,
    action: impl FnOnce() -> Result<bool, String>,
) -> RealCallRoute {
    if !bound {
        return RealCallRoute::Daemon;
    }
    match action() {
        Ok(true) => RealCallRoute::Handled,
        // `false` is "the in-call service performed nothing": either it unbound itself
        // between the gate and the call, or it is bound with no call this command can act
        // on. The gate is a *device* fact whose lifetime is the whole service, not one call
        // — an in-call service stays bound for as long as AmOS is the default phone app —
        // so a bound service is not evidence that a real call owns this command, and every
        // daemon-owned call reaches this arm. The daemon path is then the correct owner.
        // `answerActive()` / `hangUpActive()` answer `true` only when they acted, which is
        // what makes this arm mean "nothing real owns it" (REQ-A1236 / F-TEL-025).
        Ok(false) => RealCallRoute::Daemon,
        Err(cause) => RealCallRoute::Refused(cause),
    }
}

/// Serializable snapshot of a live call (prost structs are not `Serialize`).
#[derive(Clone, Debug, Serialize)]
pub struct TelephonyCallPayload {
    pub id: String,
    pub peer: String,
    pub state: String,
    /// `"Outgoing"` / `"Incoming"` — who initiated the call.
    pub direction: String,
    pub emergency: bool,
    /// `"Off"` / `"On"` / `"Failed"` — whether this call is being recorded.
    ///
    /// **`None` rather than a guess when the answer is not known**: the real in-call bridge
    /// answers about *one* toggle per call, so the mute / speaker / hold replies cannot claim
    /// anything about recording. This is the same "absent means no claim" rule [`Self::muted`]
    /// follows, and it exists for the same reason — a UI that applies this payload
    /// field-by-field must keep the recording state it already has instead of clearing it.
    /// Every daemon snapshot and every `Watch` event still carries the field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording: Option<String>,
    /// Whether the daemon's call state says this call's outbound audio is muted.
    ///
    /// **`None` rather than `false` when the answer is not known**: the real in-call
    /// bridge (`AmosInCallService`) answers about *one* toggle per call, so a reply from
    /// that path cannot claim anything about mute. Absent means "no claim", so a UI
    /// applying this payload field-by-field keeps the mute state it already has instead
    /// of silently clearing it. Every daemon snapshot and every `Watch` event carries it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    /// Whether this call's audio is routed to the loudspeaker.
    ///
    /// Only the **real in-call bridge** can answer this: the daemon's mock transport has
    /// no audio route, so every daemon snapshot and every `Watch` event leaves it absent.
    /// Absent is "no claim" — the same rule [`Self::muted`] follows and for the same
    /// reason, since a `Watch` event (which cannot carry it) arrives interleaved with the
    /// command replies that can.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<bool>,
    /// Whether this call is on hold. Real in-call bridge only — see [`Self::speaker`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hold: Option<bool>,
}

/// The thin snapshot a **real in-call bridge** reply carries.
///
/// `AmosInCallService` measures exactly *one* toggle per command, so every field it did
/// not measure is left absent — and the call's own identity fields (`peer` / `direction`
/// / `emergency`) are empty, because the bridge reply is not a snapshot of the call, only
/// an acknowledgement of the toggle. Filling them in would be inventing a call state the
/// reply never observed, which is the failure [`TelephonyCallPayload::recording`]'s
/// "absent means no claim" rule exists to prevent.
///
/// `state: "Active"` is the one given, and it names a fact about the payload's **own
/// call** — the call the in-call screen is showing — not an observation that the bound
/// service holds a Telecom call. Those are two different calls: `PhoneApp.adoptLiveCall`
/// never adopts a real call (docs/telephony.md §12 #28) while the daemon can report
/// calls, so the screen (and these toggles) can be up while `AmosInCallService` has
/// `active == null`. That is the ordinary "bound but no call" state, not an edge — and
/// the device toggles refuse it (`Failed`), which [`in_call_toggle_reply`] returns as a
/// typed `Err` rather than a payload claiming a state nothing achieved (REQ-A1267 /
/// F-TEL-027). An earlier revision of this comment asserted the reverse ("only reachable
/// while a call is up") and that premise was the root of the defect.
#[cfg(feature = "android")]
fn in_call_reply(id: String) -> TelephonyCallPayload {
    TelephonyCallPayload {
        id,
        peer: String::new(),
        state: "Active".to_string(),
        direction: String::new(),
        emergency: false,
        recording: None,
        muted: None,
        speaker: None,
        hold: None,
    }
}

/// Fold a real in-call toggle's answer into a WebView payload, or refuse honestly.
///
/// `apply` stamps the one field this toggle measured onto the thin [`in_call_reply`]
/// snapshot. `Failed` and an unclassified word are **refusals** carrying `code` — never
/// rounded up: a `Failed` reply means the device did not perform the toggle, so a
/// command that returned `Ok` would leave the button lit over a call where nothing
/// changed (the F-TEL-001 shape, docs/telephony.md §10.5).
#[cfg(feature = "android")]
fn in_call_toggle_reply(
    id: String,
    answer: Result<crate::incall::ToggleChange, AmosError>,
    code: ErrorCode,
    label: &str,
    apply: impl FnOnce(&mut TelephonyCallPayload, bool),
) -> Result<TelephonyCallPayload, AmosError> {
    match answer {
        Ok(crate::incall::ToggleChange::On) => {
            let mut payload = in_call_reply(id);
            apply(&mut payload, true);
            Ok(payload)
        }
        Ok(crate::incall::ToggleChange::Off) => {
            let mut payload = in_call_reply(id);
            apply(&mut payload, false);
            Ok(payload)
        }
        Ok(crate::incall::ToggleChange::Failed) => Err(AmosError::new(
            code,
            format!("telephony {label} was refused by the in-call service (Failed)"),
        )),
        Ok(crate::incall::ToggleChange::Unknown(reason)) => Err(AmosError::new(
            code,
            format!("telephony {label}: unknown in-call service reply: {reason}"),
        )),
        // The in-call gate already answered a typed envelope (foreground refusal / not
        // the default dialer / JNI failure); keep its code and cause chain, prefixing
        // the toggle's name so the log reads unambiguously.
        Err(e) => Err(AmosError {
            code: e.code,
            message: format!("telephony {label}: {}", e.message),
            cause: e.cause,
        }),
    }
}

/// Serializable result of placing a call.
#[derive(Clone, Debug, Serialize)]
pub struct TelephonyDialPayload {
    pub id: String,
}

/// Maximum bytes in a dial number string the WebView hands to `telephony_dial`.
///
/// The number reaches the daemon over gRPC and the on-device path eventually
/// reaches `Intent(ACTION_CALL, tel:…)`, where the platform itself caps at 32
/// dialable chars ([`crate::real_dial::MAX_DIAL_CHARS`]). We share that ceiling
/// here — anything larger is refused at the command seam with a truthful reason,
/// instead of producing the platform's generic "could not dial" error message.
pub const MAX_TELEPHONY_DIAL_BYTES: usize = 64;

/// Maximum bytes in a call id string the WebView hands to `telephony_end` /
/// `telephony_answer` / recording toggles.
///
/// Daemon-generated call ids look like `tel_0000000000000001` (~20 chars). We
/// cap at 256 to leave headroom for any future id shape while preventing a
/// caller from using this field as a memory amplification vector.
pub const MAX_TELEPHONY_CALL_ID_BYTES: usize = 256;

/// The DTMF alphabet `Call#playDtmfTone` accepts (one tone = one character).
///
/// A three-way contract with no compiler on either side: the Kotlin companion
/// (`AmosInCallService.playDtmf`) validates against its own copy, and this one validates the
/// command seam. It lives here rather than in `incall.rs` because that module is
/// `#[cfg(feature = "android")]` — the desktop build must still refuse a malformed tone
/// before it reaches any bridge.
pub const DTMF_TONES: &str = "0123456789*#ABCD";

/// Is `tone` a single character from [`DTMF_TONES`]?
///
/// `"1"` yes; `""`, `"12"`, `"a"` and `"#123"` no. A caller that gets `true` from this may
/// hand the tone to the platform; `false` must be refused in typed words instead, since
/// `Call#playDtmfTone` throws on anything else.
pub fn is_dtmf_tone(tone: &str) -> bool {
    let mut chars = tone.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => DTMF_TONES.contains(c),
        _ => false,
    }
}

async fn build_channel() -> Result<crate::daemon::DaemonChannel, String> {
    crate::daemon::channel().await
}

fn call_payload(c: &CallSnapshot) -> TelephonyCallPayload {
    let id = c.call.as_ref().map(|m| m.id.clone()).unwrap_or_default();
    let state = match c.state {
        s if s == ProtoState::Idle as i32 => "Idle",
        s if s == ProtoState::Dialing as i32 => "Dialing",
        s if s == ProtoState::Ringing as i32 => "Ringing",
        s if s == ProtoState::Active as i32 => "Active",
        s if s == ProtoState::Ended as i32 => "Ended",
        _ => "Unknown",
    }
    .to_string();
    let direction = match c.direction {
        d if d == ProtoDirection::Incoming as i32 => "Incoming",
        _ => "Outgoing",
    }
    .to_string();
    let recording = match c.recording {
        r if r == ProtoRecording::RecordingOn as i32 => "On",
        r if r == ProtoRecording::RecordingFailed as i32 => "Failed",
        _ => "Off",
    }
    .to_string();
    TelephonyCallPayload {
        id,
        peer: c.peer.clone(),
        state,
        direction,
        emergency: c.emergency,
        recording: Some(recording),
        muted: Some(c.muted),
        // The daemon's transport has no audio route and no hold: it can never answer
        // these, so the snapshot leaves them absent rather than claiming `false`.
        speaker: None,
        hold: None,
    }
}

/// Place a call via the OS telephony service. `emergency=true` (or an emergency
/// number) routes to the privileged emergency provider.
///
/// Returns a typed [`AmosError`] so the UI i18n layer can branch on
/// [`ErrorCode::TelephonyNumberTooLong`] (oversized number) /
/// [`ErrorCode::TelephonyRpcFailed`] (daemon unreachable) without parsing the
/// message.
#[tauri::command]
pub async fn telephony_dial(
    number: String,
    emergency: bool,
) -> Result<TelephonyDialPayload, AmosError> {
    if number.len() > MAX_TELEPHONY_DIAL_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyNumberTooLong,
            format!(
                "telephony number too long: {} bytes (max {MAX_TELEPHONY_DIAL_BYTES})",
                number.len()
            ),
        ));
    }
    let mut client =
        TelephonyClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::TelephonyRpcFailed, codes::RPC_FAILED, e)
        })?);
    let resp = client
        .dial(DialRequest { number, emergency })
        .await
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony dial failed: {e}"),
            )
        })?
        .into_inner();
    Ok(TelephonyDialPayload { id: resp.id })
}

/// End a live call by id.
#[tauri::command]
pub async fn telephony_end(call_id: String) -> Result<(), AmosError> {
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyCallIdTooLong,
            format!(
                "telephony call_id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
                call_id.len()
            ),
        ));
    }
    // When AmOS is the default phone app, a real Telecom call is in flight — hang up
    // the real call via the bound AmosInCallService instead of the daemon (mock).
    //
    // The gate is `is_default_dialer_bound`, NOT the control call's reply: see
    // [`real_call_route`] for why folding that reply ended the *daemon's* call and answered
    // `Ok(())` while the real call was still up.
    #[cfg(feature = "android")]
    match real_call_route(
        crate::incall::is_default_dialer_bound(),
        crate::incall::real_hang_up,
    ) {
        RealCallRoute::Handled => return Ok(()),
        RealCallRoute::Refused(cause) => {
            return Err(AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony end: {cause}"),
            ))
        }
        RealCallRoute::Daemon => {}
    }
    let mut client =
        TelephonyClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::TelephonyRpcFailed, codes::RPC_FAILED, e)
        })?);
    client
        .end(EndRequest {
            call: Some(CallIdMsg { id: call_id }),
        })
        .await
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony end failed: {e}"),
            )
        })?;
    Ok(())
}

/// List live calls (dialling / ringing / active).
#[tauri::command]
pub async fn telephony_status() -> Result<Vec<TelephonyCallPayload>, AmosError> {
    let mut client =
        TelephonyClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::TelephonyRpcFailed, codes::RPC_FAILED, e)
        })?);
    let resp = client
        .status(StatusRequest {})
        .await
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony status failed: {e}"),
            )
        })?
        .into_inner();
    Ok(resp.calls.iter().map(call_payload).collect())
}

/// Which provider backs the daemon's telephony service, and whether it is real.
///
/// The dial path needs this because `telephony_dial` answers a call id whichever backend
/// is mounted — an in-process mock returns one just as a real carrier would. A caller
/// that must have a *real* call (above all an emergency number) asks here first, so it
/// can take a path that can actually place one instead of trusting the mock's success.
///
/// An unreachable daemon fails the command; the caller reads that as "unknown", which
/// must never be rounded up to "real" (`invoke` resolves a failed command to `null`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TelephonyBackendPayload {
    /// Diagnostic token: `mock` / `android` / `unconfigured` / `unspecified`.
    pub kind: String,
    /// The backend's own words about itself.
    pub detail: String,
    /// Does `Dial` reach the platform telephony stack? True only for `android`.
    pub real: bool,
}

#[tauri::command]
pub async fn telephony_backend_kind() -> Result<TelephonyBackendPayload, AmosError> {
    let mut client =
        TelephonyClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::TelephonyRpcFailed, codes::RPC_FAILED, e)
        })?);
    let resp = client
        .get_backend(StatusRequest {})
        .await
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony get-backend failed: {e}"),
            )
        })?
        .into_inner();
    Ok(backend_payload(resp.kind, resp.detail))
}

/// Fold a `BackendStatus` reply into the payload, never rounding an unknown enum arm up
/// to a real backend. Pure, so every arm is unit-tested without a daemon.
pub fn backend_payload(kind: i32, detail: String) -> TelephonyBackendPayload {
    use amos_proto::amos_telephony::BackendKind as Proto;
    match Proto::try_from(kind) {
        Ok(Proto::BackendAndroid) => TelephonyBackendPayload {
            kind: "android".to_string(),
            detail,
            real: true,
        },
        Ok(Proto::BackendMock) => TelephonyBackendPayload {
            kind: "mock".to_string(),
            detail,
            real: false,
        },
        Ok(Proto::BackendUnconfigured) => TelephonyBackendPayload {
            kind: "unconfigured".to_string(),
            detail,
            real: false,
        },
        // `Unspecified` (the proto zero value) and any arm a newer daemon adds: an
        // unrecognized backend is NOT real. Reporting it as real would let a caller
        // trust a simulation it cannot see.
        Ok(Proto::BackendUnspecified) | Err(_) => TelephonyBackendPayload {
            kind: "unspecified".to_string(),
            detail,
            real: false,
        },
    }
}

/// Start recording a live call; returns its authoritative snapshot (recording=On).
///
/// `wm`/`window` are injected by Tauri (they are not part of the JS call): on a real in-call
/// service they gate the toggle to the **focused** window (F-TEL-001) via
/// [`crate::incall::set_recording_for_window`].
#[tauri::command]
pub async fn telephony_start_recording(
    wm: tauri::State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
    call_id: String,
) -> Result<TelephonyCallPayload, AmosError> {
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyCallIdTooLong,
            format!(
                "telephony call_id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
                call_id.len()
            ),
        ));
    }
    // Real in-call (default phone app): toggle recording via the bound in-call service.
    // The Android side answers `On`/`Off`/`Failed`/`Unknown`, mirrored into
    // `TelephonyCallPayload.recording` — the UI reads that string verbatim
    // (`lib/callDisplay.ts`) so the toggle can show "On"/"Failed" rather than one boolean.
    #[cfg(feature = "android")]
    if crate::incall::is_default_dialer_bound() {
        return in_call_toggle_reply(
            call_id,
            crate::incall::set_recording_for_window(true, wm.inner(), window.label()),
            ErrorCode::TelephonyRecordingRefused,
            "recording start",
            |payload, on| payload.recording = Some(if on { "On" } else { "Off" }.to_string()),
        );
    }
    // Without the android feature there is no in-call service and no window-scoped privacy
    // surface to gate: the daemon (mock/demo) path owns the call, so the injected handles are
    // intentionally unused rather than silently requiring a foreground the desktop shell has not
    // established.
    #[cfg(not(feature = "android"))]
    let _ = (&wm, &window);
    let mut client =
        TelephonyClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::TelephonyRpcFailed, codes::RPC_FAILED, e)
        })?);
    let resp = client
        .start_recording(CallIdMsg { id: call_id })
        .await
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony start-recording failed: {e}"),
            )
        })?
        .into_inner();
    Ok(call_payload(&resp))
}

/// Stop recording a live call; returns its authoritative snapshot (recording=Off).
///
/// See [`telephony_start_recording`] for the injected `wm`/`window` foreground gate.
#[tauri::command]
pub async fn telephony_stop_recording(
    wm: tauri::State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
    call_id: String,
) -> Result<TelephonyCallPayload, AmosError> {
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyCallIdTooLong,
            format!(
                "telephony call_id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
                call_id.len()
            ),
        ));
    }
    // Real in-call (default phone app): toggle recording via the bound in-call service.
    // See the parallel block in `telephony_start_recording` — same shape, opposite intent.
    #[cfg(feature = "android")]
    if crate::incall::is_default_dialer_bound() {
        return in_call_toggle_reply(
            call_id,
            crate::incall::set_recording_for_window(false, wm.inner(), window.label()),
            ErrorCode::TelephonyRecordingRefused,
            "recording stop",
            |payload, on| payload.recording = Some(if on { "On" } else { "Off" }.to_string()),
        );
    }
    // See `telephony_start_recording`: the daemon path is not window-scoped.
    #[cfg(not(feature = "android"))]
    let _ = (&wm, &window);
    let mut client =
        TelephonyClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::TelephonyRpcFailed, codes::RPC_FAILED, e)
        })?);
    let resp = client
        .stop_recording(CallIdMsg { id: call_id })
        .await
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony stop-recording failed: {e}"),
            )
        })?
        .into_inner();
    Ok(call_payload(&resp))
}

/// Set the mute flag on a live call; returns the call's authoritative snapshot.
///
/// `muted` is the **desired state**, not a toggle, so a retried command cannot flip a
/// call the user did not touch (the same reason the recording commands are split in
/// two rather than being one `toggle`).
///
/// Two owners, routed by whether an in-call service is bound:
/// * **Real Telecom call** (AmOS is the default phone app) — the platform's own
///   `InCallService#setMuted(boolean)` performs it, so the microphone genuinely stops.
///   Unlike recording there is no foreground gate: silencing one's *own* microphone is
///   not a privacy leak, and it is permitted on an emergency line (docs/telephony.md §6).
/// * **Daemon call** (mock/demo) — the daemon owns the flag, the same call state `Watch`
///   subscribers see, so a mute reaches the lock screen / a future incoming-call overlay
///   / the AI assistant without any of them polling. There is no audio pipeline yet, so
///   the daemon records and broadcasts the *decision*, and the UI says so rather than
///   pretending the audio is already gone.
#[tauri::command]
pub async fn telephony_set_muted(
    call_id: String,
    muted: bool,
) -> Result<TelephonyCallPayload, AmosError> {
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyCallIdTooLong,
            format!(
                "telephony call_id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
                call_id.len()
            ),
        ));
    }
    // A real Telecom call (AmOS is the default phone app): the daemon's flag would describe
    // the *wrong* call — the real call is not in the daemon at all — so route to the bound
    // in-call service instead of writing a flag that describes nothing.
    #[cfg(feature = "android")]
    if crate::incall::is_default_dialer_bound() {
        return in_call_toggle_reply(
            call_id,
            crate::incall::real_set_muted(muted),
            ErrorCode::TelephonyMuteRefused,
            "mute",
            |payload, on| payload.muted = Some(on),
        );
    }
    let mut client =
        TelephonyClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::TelephonyRpcFailed, codes::RPC_FAILED, e)
        })?);
    let resp = client
        .set_muted(MuteRequest {
            call: Some(CallIdMsg { id: call_id }),
            muted,
        })
        .await
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony set-muted failed: {e}"),
            )
        })?
        .into_inner();
    Ok(call_payload(&resp))
}

/// Route the live call's audio to the **loudspeaker** (`true`) or the earpiece (`false`).
///
/// Device-only: the daemon's mock transport carries no audio, so there is no route to set
/// and the command refuses in typed words rather than reporting a switch it did not make.
/// `speaker` is the desired state, not a toggle — a retried command cannot flip a route
/// the user did not touch.
#[tauri::command]
pub async fn telephony_set_speaker(
    call_id: String,
    speaker: bool,
) -> Result<TelephonyCallPayload, AmosError> {
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyCallIdTooLong,
            format!(
                "telephony call_id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
                call_id.len()
            ),
        ));
    }
    #[cfg(feature = "android")]
    if crate::incall::is_default_dialer_bound() {
        return in_call_toggle_reply(
            call_id,
            crate::incall::real_set_speaker(speaker),
            ErrorCode::TelephonySpeakerRefused,
            "speaker route",
            |payload, on| payload.speaker = Some(on),
        );
    }
    // Honest boundary, on-device and on the desktop alike: without a bound in-call service
    // there is no audio route to change. Saying so is the whole point — a fabricated `Ok`
    // here would light the speaker button over a call still on the earpiece.
    #[cfg(not(feature = "android"))]
    let _ = speaker;
    Err(AmosError::new(
        ErrorCode::TelephonySpeakerRefused,
        "telephony speaker: no in-call service is bound (AmOS is not the default phone app \
         on this device), so there is no call audio route to change"
            .to_string(),
    ))
}

/// Put the live call on hold (`true`) or take it off hold (`false`).
///
/// Device-only, like [`telephony_set_speaker`]. `Call#hold()` throws when the call is not
/// holdable (already held by a second call, or a state that cannot be held); the bound
/// in-call service surfaces that as `Failed`, which becomes a typed refusal here rather
/// than a silent no-op that leaves a "held" button lit over a live call.
#[tauri::command]
pub async fn telephony_set_hold(
    call_id: String,
    hold: bool,
) -> Result<TelephonyCallPayload, AmosError> {
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyCallIdTooLong,
            format!(
                "telephony call_id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
                call_id.len()
            ),
        ));
    }
    #[cfg(feature = "android")]
    if crate::incall::is_default_dialer_bound() {
        return in_call_toggle_reply(
            call_id,
            crate::incall::real_set_hold(hold),
            ErrorCode::TelephonyHoldRefused,
            "hold",
            |payload, on| payload.hold = Some(on),
        );
    }
    #[cfg(not(feature = "android"))]
    let _ = hold;
    // See [`telephony_set_speaker`]: no in-call service, no call to hold.
    Err(AmosError::new(
        ErrorCode::TelephonyHoldRefused,
        "telephony hold: no in-call service is bound (AmOS is not the default phone app \
         on this device), so there is no call to hold"
            .to_string(),
    ))
}

/// Send one **DTMF** tone to the live call (a caller navigating an IVR reaches it).
///
/// Returns `true` only when a bound in-call service handed the tone to Telecom, so the
/// keypad can say the tone went out. `false` is "the tone did **not** reach the call" —
/// there is no in-call service, or Telecom refused — which is precisely the keypad's
/// existing honest note (`phone.dtmfLocal`): the tones are echoed locally and nothing
/// reaches the far end. A malformed tone is refused in typed words *before* the JVM is
/// touched, since `Call#playDtmfTone` would throw on it.
#[tauri::command]
pub async fn telephony_play_dtmf(call_id: String, tone: String) -> Result<bool, AmosError> {
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyCallIdTooLong,
            format!(
                "telephony call_id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
                call_id.len()
            ),
        ));
    }
    if !is_dtmf_tone(&tone) {
        return Err(AmosError::new(
            ErrorCode::TelephonyDtmfRefused,
            format!("telephony DTMF: {tone:?} is not a single DTMF tone character"),
        ));
    }
    #[cfg(feature = "android")]
    if crate::incall::is_default_dialer_bound() {
        return crate::incall::real_play_dtmf(&tone);
    }
    // No in-call service: the tone did not go out. `false`, not an error — a keypad tone is
    // a best-effort keystroke, and the pad already says the digits are local-only.
    Ok(false)
}

/// Answer an incoming (ringing) call. The resulting `Active` transition arrives on
/// the `Watch` stream and is delivered to the UI as a `telephony-event`.
#[tauri::command]
pub async fn telephony_answer(call_id: String) -> Result<(), AmosError> {
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyCallIdTooLong,
            format!(
                "telephony call_id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
                call_id.len()
            ),
        ));
    }
    // Real incoming call (default phone app): answer via the bound in-call service.
    // Same gate/reply split as `telephony_end` — see [`real_call_route`].
    #[cfg(feature = "android")]
    match real_call_route(
        crate::incall::is_default_dialer_bound(),
        crate::incall::real_answer,
    ) {
        RealCallRoute::Handled => return Ok(()),
        RealCallRoute::Refused(cause) => {
            return Err(AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony answer: {cause}"),
            ))
        }
        RealCallRoute::Daemon => {}
    }
    let mut client =
        TelephonyClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::TelephonyRpcFailed, codes::RPC_FAILED, e)
        })?);
    client
        .answer(AnswerRequest {
            call: Some(CallIdMsg { id: call_id }),
        })
        .await
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony answer failed: {e}"),
            )
        })?;
    Ok(())
}

/// Dev/demo: ask the mock daemon to ring an incoming call from `number` (so the
/// desktop demo can exercise the incoming-call surface). Returns the new call id.
#[tauri::command]
pub async fn telephony_simulate_incoming(number: String) -> Result<String, AmosError> {
    if number.len() > MAX_TELEPHONY_DIAL_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyNumberTooLong,
            format!(
                "telephony number too long: {} bytes (max {MAX_TELEPHONY_DIAL_BYTES})",
                number.len()
            ),
        ));
    }
    let mut client =
        TelephonyClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::TelephonyRpcFailed, codes::RPC_FAILED, e)
        })?);
    let resp = client
        .simulate_incoming(SimulateIncomingRequest { number })
        .await
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::TelephonyRpcFailed,
                codes::RPC_FAILED,
                format!("telephony simulate-incoming failed: {e}"),
            )
        })?
        .into_inner();
    Ok(resp.id)
}

/// Drive one continuous `Watch` round: open the stream and forward every call-state
/// event to the WebView as `telephony-event`. Ends `Ok(())` when the daemon closes
/// the stream (caller reconnects) or `Err` if the daemon is down/errors.
async fn watch_round(app: AppHandle) -> Result<(), AmosError> {
    let mut client =
        TelephonyClient::new(build_channel().await.map_err(|e| {
            AmosError::with_cause(ErrorCode::TelephonyRpcFailed, codes::RPC_FAILED, e)
        })?);
    let mut stream = client
        .watch(WatchRequest {})
        .await
        .map_err(|e| {
            AmosError::with_cause(
                ErrorCode::TelephonyWatchOpenFailed,
                codes::WATCH_OPEN_FAILED,
                format!("telephony watch open failed: {e}"),
            )
        })?
        .into_inner();
    while let Some(evt) = stream.message().await.map_err(|e| {
        AmosError::with_cause(
            ErrorCode::TelephonyWatchStreamError,
            codes::WATCH_STREAM_ERROR,
            format!("telephony watch stream error: {e}"),
        )
    })? {
        if let Some(call) = evt.call {
            // A failed delivery means a registered listener missed this call-state change
            // (no listener is `Ok` in Tauri) — the in-call UI would silently not update.
            if let Err(e) = app.emit(TELEPHONY_EVENT, call_payload(&call)) {
                tracing::warn!(
                    target: "amos::telephony",
                    event = TELEPHONY_EVENT,
                    error = %e,
                    "telephony event could not be delivered to the UI"
                );
            }
        }
    }
    Ok(())
}

/// Background task forwarding the daemon telephony `Watch` stream to the WebView for
/// the lifetime of the app. Reconnects with the shared bounded backoff
/// ([`crate::watch_backoff`]) so a late-starting (or restarted) daemon is picked
/// up without a full UI reload.
pub fn spawn_telephony_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use crate::watch_backoff::{next_backoff_ms, WATCH_BACKOFF_BASE_MS};
        let mut backoff_ms: u64 = WATCH_BACKOFF_BASE_MS;
        // Runs for the lifetime of the app: the loop has no exit and is aborted with
        // the Tauri runtime when the app stops. `sleep()` is the wait (never a spin).
        loop {
            // `Ok` means the round opened a live stream (daemon reachable) before
            // it ended — reset the backoff so the next reconnect is immediate.
            let connected = watch_round(app.clone()).await.is_ok();
            backoff_ms = next_backoff_ms(backoff_ms, connected);
            sleep(Duration::from_millis(backoff_ms)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{backend_payload, call_payload, codes, TelephonyCallPayload};
    use amos_proto::amos_telephony::{
        BackendKind as ProtoBackendKind, CallDirection as ProtoDirection, CallIdMsg, CallSnapshot,
        CallState as ProtoState, RecordingState as ProtoRecording,
    };

    // ---- backend kind fold (REQ-A1319) ------------------------------------------

    #[test]
    fn the_mock_backend_is_not_real() {
        // The production daemon mounts a mock; a caller must be told the dial will not
        // reach the platform even though `telephony_dial` answered.
        let p = backend_payload(ProtoBackendKind::BackendMock as i32, "why".into());
        assert_eq!(p.kind, "mock");
        assert!(!p.real);
    }

    #[test]
    fn only_the_android_backend_is_real() {
        let p = backend_payload(ProtoBackendKind::BackendAndroid as i32, String::new());
        assert_eq!(p.kind, "android");
        assert!(p.real);
        let u = backend_payload(ProtoBackendKind::BackendUnconfigured as i32, String::new());
        assert!(!u.real);
    }

    #[test]
    fn an_unrecognized_backend_arm_is_never_reported_as_real() {
        // The negative control: a newer daemon adding a backend arm, or the proto zero
        // value, must land on "unspecified / not real". Rounding it up to real is how a
        // caller would trust a simulation it cannot see.
        let unspecified =
            backend_payload(ProtoBackendKind::BackendUnspecified as i32, String::new());
        assert_eq!(unspecified.kind, "unspecified");
        assert!(!unspecified.real);
        let unknown_arm = backend_payload(9_999, String::new());
        assert_eq!(unknown_arm.kind, "unspecified");
        assert!(!unknown_arm.real);
    }

    fn snap(state: i32, direction: i32, recording: i32) -> CallSnapshot {
        CallSnapshot {
            call: Some(CallIdMsg { id: "c1".into() }),
            peer: "13800138000".into(),
            direction,
            state,
            end_reason: 0,
            emergency: false,
            recording,
            muted: false,
        }
    }

    #[test]
    fn maps_active_incoming_recording_on() {
        let p = call_payload(&snap(
            ProtoState::Active as i32,
            ProtoDirection::Incoming as i32,
            ProtoRecording::RecordingOn as i32,
        ));
        assert_eq!(p.id, "c1");
        assert_eq!(p.peer, "13800138000");
        assert_eq!(p.state, "Active");
        assert_eq!(p.direction, "Incoming");
        assert_eq!(p.recording.as_deref(), Some("On"));
        assert!(!p.emergency);
    }

    #[test]
    fn maps_ended_and_failed_recording() {
        let p = call_payload(&snap(
            ProtoState::Ended as i32,
            ProtoDirection::Outgoing as i32,
            ProtoRecording::RecordingFailed as i32,
        ));
        assert_eq!(p.state, "Ended");
        assert_eq!(p.direction, "Outgoing");
        assert_eq!(p.recording.as_deref(), Some("Failed"));
    }

    #[test]
    fn unknown_values_degrade_to_safe_defaults() {
        // Unrecognized wire values must never panic or leak raw ints to the UI.
        let p = call_payload(&snap(999, 999, 999));
        assert_eq!(p.state, "Unknown");
        assert_eq!(p.direction, "Outgoing");
        assert_eq!(p.recording.as_deref(), Some("Off"));
    }

    /// A daemon snapshot always knows the mute flag, so it is serialised as a real
    /// boolean — the UI must not have to guess between "unmuted" and "no answer".
    #[test]
    fn a_daemon_snapshot_always_reports_mute() {
        let p = call_payload(&snap(
            ProtoState::Active as i32,
            ProtoDirection::Outgoing as i32,
            ProtoRecording::RecordingOff as i32,
        ));
        assert_eq!(
            p.muted,
            Some(false),
            "the daemon path answers, not abstains"
        );

        let mut muted = snap(
            ProtoState::Active as i32,
            ProtoDirection::Outgoing as i32,
            ProtoRecording::RecordingOff as i32,
        );
        muted.muted = true;
        assert_eq!(call_payload(&muted).muted, Some(true));

        // The wire shape keeps the field (the UI branches on it), and an absent
        // `muted` is genuinely absent rather than a `null` the UI must special-case.
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["muted"], serde_json::json!(false));
    }

    /// `muted: None` must serialise as **absent**, not `null`: the in-call bridge
    /// reports only the recording toggle, and a UI that applies the payload
    /// field-by-field must keep the mute state it already had.
    #[test]
    fn a_reply_with_no_mute_answer_omits_the_field() {
        let p = TelephonyCallPayload {
            id: "c1".into(),
            peer: String::new(),
            state: "Active".into(),
            direction: String::new(),
            emergency: false,
            recording: Some("On".into()),
            muted: None,
            speaker: None,
            hold: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(
            v.get("muted").is_none(),
            "an unknown mute must be omitted, not sent as null: {v}"
        );
        // The recording answer still rides along, so the recording UI keeps working.
        assert_eq!(v["recording"], "On");
    }

    /// `is_dtmf_tone` is the command seam's validator, so its *negative* answers are the
    /// ones that matter: anything it wrongly accepts is handed to `Call#playDtmfTone`,
    /// which throws on a non-tone and would surface as a generic JNI failure.
    #[test]
    fn is_dtmf_tone_accepts_exactly_one_alphabet_character() {
        use super::{is_dtmf_tone, DTMF_TONES};
        for c in DTMF_TONES.chars() {
            assert!(is_dtmf_tone(&c.to_string()), "{c:?} is in the alphabet");
        }
        for bad in ["", "12", "a", "#123", " 1", "１", "\n"] {
            assert!(!is_dtmf_tone(bad), "{bad:?} is not a single DTMF tone");
        }
        // `A`-`D` are the network control tones and are part of the alphabet — the UI
        // keypad sends only digits, but the seam must not silently narrow the contract
        // the Kotlin side validates against.
        assert!(is_dtmf_tone("A") && is_dtmf_tone("D"));
    }

    /// A real in-call toggle's answer becomes either a payload that claims **only** the
    /// field it measured, or a typed refusal. The two failure modes this pins are the
    /// F-TEL-001 shape (a refusal rounded up to a lit button) and the fabrication shape
    /// (a reply claiming a recording state it never observed).
    #[cfg(feature = "android")]
    mod in_call_toggle_reply {
        use super::super::{in_call_toggle_reply, TelephonyCallPayload};
        use crate::error::{AmosError, ErrorCode};
        use crate::incall::ToggleChange;

        fn mute_reply(
            answer: Result<ToggleChange, AmosError>,
        ) -> Result<TelephonyCallPayload, AmosError> {
            in_call_toggle_reply(
                "tel_1".to_string(),
                answer,
                ErrorCode::TelephonyMuteRefused,
                "mute",
                |payload, on| payload.muted = Some(on),
            )
        }

        #[test]
        fn an_on_answer_claims_only_the_field_this_toggle_measured() {
            let p = mute_reply(Ok(ToggleChange::On)).expect("On is a success");
            assert_eq!(p.id, "tel_1");
            assert_eq!(p.muted, Some(true));
            // Nothing else was measured, so nothing else may be claimed.
            assert_eq!(p.recording, None);
            assert_eq!(p.speaker, None);
            assert_eq!(p.hold, None);
            assert_eq!(p.peer, "");
            assert_eq!(p.emergency, false);
        }

        #[test]
        fn an_off_answer_claims_off_rather_than_claiming_nothing() {
            let p = mute_reply(Ok(ToggleChange::Off)).expect("Off is a success");
            assert_eq!(p.muted, Some(false));
        }

        #[test]
        fn a_failed_answer_is_a_typed_refusal_not_a_lit_button() {
            let err = mute_reply(Ok(ToggleChange::Failed)).expect_err("Failed must refuse");
            assert_eq!(err.code, ErrorCode::TelephonyMuteRefused);
            assert!(err.message.contains("mute"), "{}", err.message);
        }

        #[test]
        fn an_unclassified_word_keeps_the_glue_word_verbatim() {
            let err = mute_reply(Ok(ToggleChange::Unknown("Busy".to_string())))
                .expect_err("an unclassified word must refuse");
            assert_eq!(err.code, ErrorCode::TelephonyMuteRefused);
            assert!(err.message.contains("Busy"), "{}", err.message);
        }

        #[test]
        fn a_gate_error_keeps_its_own_code_and_cause() {
            // The foreground / not-the-default-dialer refusals carry their own code; folding
            // them into the toggle's code would erase *why* the device declined.
            let err = mute_reply(Err(AmosError::with_cause(
                ErrorCode::TelephonyRecordingRefused,
                "denied",
                "not the foreground window",
            )))
            .expect_err("a gate error must pass through");
            assert_eq!(err.code, ErrorCode::TelephonyRecordingRefused);
            assert!(
                err.message.starts_with("telephony mute: "),
                "{}",
                err.message
            );
            assert_eq!(
                err.cause.first().map(String::as_str),
                Some("not the foreground window")
            );
        }
    }

    #[test]
    fn maps_dialing_and_recording_off() {
        let p = call_payload(&snap(
            ProtoState::Dialing as i32,
            ProtoDirection::Outgoing as i32,
            ProtoRecording::RecordingOff as i32,
        ));
        assert_eq!(p.state, "Dialing");
        assert_eq!(p.recording.as_deref(), Some("Off"));
    }

    /// The command-seam ceilings defend the documented shapes — a daemon-
    /// generated call id (e.g. `tel_0000000000000001`, ~20 chars) fits well
    /// inside `MAX_TELEPHONY_CALL_ID_BYTES`, and the dial ceiling matches the
    /// platform's own bound at `real_dial::MAX_DIAL_CHARS` (32) with room for
    /// an emergency label and the `+` prefix.
    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn the_telephony_command_bounds_match_documented_shapes() {
        use super::{MAX_TELEPHONY_CALL_ID_BYTES, MAX_TELEPHONY_DIAL_BYTES};
        // Real daemon ids are ~20 chars; the cap has headroom without inviting
        // paste-sized junk.
        assert!(MAX_TELEPHONY_CALL_ID_BYTES >= 64);
        assert!(MAX_TELEPHONY_CALL_ID_BYTES < 1024);
        // Real E.164 numbers are ≤16 chars; the cap is the platform's `MAX_DIAL_CHARS`
        // doubled so a future emergency label/extension can still fit.
        assert!(MAX_TELEPHONY_DIAL_BYTES >= 32);
        assert!(MAX_TELEPHONY_DIAL_BYTES < 256);
    }

    /// The typed error envelope that `telephony_dial`/`end`/etc. now return must
    /// keep its three contracts: stable `code` strings (UI branches on them),
    /// module-grouped `group()` (tracing filter scopes the whole surface), and
    /// a non-empty `message` (developer-facing diagnostics stay legible).
    #[test]
    fn telephony_error_codes_are_distinct_stability_keys() {
        use crate::error::{AmosError, ErrorCode};
        // The codes module exposes the exact wire strings — UI i18n branches on
        // these literals, so they are part of the IPC contract.
        assert_eq!(codes::NUMBER_TOO_LONG, "amos.telephony.number_too_long");
        assert_eq!(codes::CALL_ID_TOO_LONG, "amos.telephony.call_id_too_long");
        assert_eq!(codes::RPC_FAILED, "amos.telephony.rpc_failed");
        assert_eq!(codes::WATCH_OPEN_FAILED, "amos.telephony.watch_open_failed");
        assert_eq!(
            codes::WATCH_STREAM_ERROR,
            "amos.telephony.watch_stream_error"
        );
        assert_eq!(codes::RECORDING_REFUSED, "amos.telephony.recording_refused");
        assert_eq!(codes::MUTE_REFUSED, "amos.telephony.mute_refused");
        assert_eq!(codes::SPEAKER_REFUSED, "amos.telephony.speaker_refused");
        assert_eq!(codes::HOLD_REFUSED, "amos.telephony.hold_refused");
        assert_eq!(codes::DTMF_REFUSED, "amos.telephony.dtmf_refused");
        // The three in-call toggles must not share a code: the UI names the control that
        // failed, so "mute refused" and "hold refused" cannot be one string.
        assert_ne!(codes::MUTE_REFUSED, codes::SPEAKER_REFUSED);
        assert_ne!(codes::SPEAKER_REFUSED, codes::HOLD_REFUSED);
        assert_ne!(codes::HOLD_REFUSED, codes::DTMF_REFUSED);

        // The enum side keeps the same strings — a drift between the two would
        // be a wire break one of the callsites would not survive.
        assert_eq!(
            ErrorCode::TelephonyNumberTooLong.as_str(),
            codes::NUMBER_TOO_LONG
        );
        assert_eq!(ErrorCode::TelephonyRpcFailed.as_str(), codes::RPC_FAILED);
        assert_eq!(
            ErrorCode::TelephonyRecordingRefused.as_str(),
            codes::RECORDING_REFUSED
        );
        assert_eq!(
            ErrorCode::TelephonyMuteRefused.as_str(),
            codes::MUTE_REFUSED
        );
        assert_eq!(
            ErrorCode::TelephonySpeakerRefused.as_str(),
            codes::SPEAKER_REFUSED
        );
        assert_eq!(
            ErrorCode::TelephonyHoldRefused.as_str(),
            codes::HOLD_REFUSED
        );
        assert_eq!(
            ErrorCode::TelephonyDtmfRefused.as_str(),
            codes::DTMF_REFUSED
        );

        // And every variant groups under "telephony" so a single tracing filter
        // scopes the whole surface.
        assert_eq!(ErrorCode::TelephonyRpcFailed.group(), "telephony");
        assert_eq!(ErrorCode::TelephonyWatchOpenFailed.group(), "telephony");

        // The envelope serialises both fields — UI reads `code` + `message`, never
        // the cause, but the cause chain survives for a watcher (logging, devtools).
        let e = AmosError::with_cause(
            ErrorCode::TelephonyRpcFailed,
            codes::RPC_FAILED,
            "daemon unreachable",
        );
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "amos.telephony.rpc_failed");
        assert_eq!(v["message"], "amos.telephony.rpc_failed");
        assert_eq!(v["cause"][0], "daemon unreachable");
    }

    /// Which owner a real-call control command (`answer` / `hang-up`) must act on.
    ///
    /// The regression this pins: the shipped call sites read
    /// `real_answer()/real_hang_up().unwrap_or(false)`, which folds a **failed** in-call
    /// round-trip into "no real call" — the daemon's call was ended and `Ok(())` returned
    /// while the real Telecom call stayed up.
    mod real_call_route {
        use super::super::real_call_route;
        use super::super::RealCallRoute;
        use std::cell::Cell;

        #[test]
        fn a_bound_service_that_acted_owns_the_command() {
            assert_eq!(real_call_route(true, || Ok(true)), RealCallRoute::Handled,);
        }

        #[test]
        fn with_nothing_bound_the_daemon_path_is_taken() {
            assert_eq!(real_call_route(false, || Ok(false)), RealCallRoute::Daemon,);
        }

        #[test]
        fn an_unbound_gate_never_asks_the_in_call_service() {
            // The gate is what decides; asking anyway would add a JNI round-trip from a
            // tokio worker whose only possible answers are `Err` or a stale `false`.
            let asked = Cell::new(false);
            let route = real_call_route(false, || {
                asked.set(true);
                Err("in-call JVM not captured yet".to_string())
            });
            assert_eq!(route, RealCallRoute::Daemon);
            assert!(
                !asked.get(),
                "the action must not be invoked when nothing is bound"
            );
        }

        #[test]
        fn an_unreachable_in_call_service_is_refused_not_folded_into_no_call() {
            // The defect: this used to route to `Daemon`, end the *daemon's* call and
            // return `Ok(())` — the UI reported the call gone while the real one rang on.
            let route =
                real_call_route(true, || Err("in-call attach failed: JNI error".to_string()));
            assert_eq!(
                route,
                RealCallRoute::Refused("in-call attach failed: JNI error".to_string()),
            );
        }

        #[test]
        fn a_bound_service_that_performed_nothing_yields_the_command_to_the_daemon() {
            // `answerActive()`/`hangUpActive()` answer `false` when they performed nothing —
            // instance null, or bound with no call in an actionable state. Either way this
            // command has no real call behind it, so the daemon owns it (REQ-A1236):
            // `Ok(true)` is what "performed the action" looks like, and the *only* thing
            // that may produce it is a call that was really answered / disconnected.
            assert_eq!(real_call_route(true, || Ok(false)), RealCallRoute::Daemon,);
        }

        #[test]
        fn the_refusal_keeps_the_hosts_own_words_verbatim() {
            let cause = "in-call JVM not captured yet";
            match real_call_route(true, || Err(cause.to_string())) {
                RealCallRoute::Refused(reason) => assert_eq!(reason, cause),
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
    }
}
