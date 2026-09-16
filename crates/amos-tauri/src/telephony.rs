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
    EndRequest, SimulateIncomingRequest, StatusRequest, WatchRequest,
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
    /// Caller-supplied number exceeds [`super::MAX_TELEPHONY_DIAL_BYTES`].
    pub const NUMBER_TOO_LONG: &str = "amos.telephony.number_too_long";
    /// Caller-supplied call id exceeds [`super::MAX_TELEPHONY_CALL_ID_BYTES`].
    pub const CALL_ID_TOO_LONG: &str = "amos.telephony.call_id_too_long";
    /// Any telephony RPC failed (daemon unreachable / rejected).
    pub const RPC_FAILED: &str = "amos.telephony.rpc_failed";
    /// `spawn_telephony_watch` could not open the long-lived `Watch` stream.
    pub const WATCH_OPEN_FAILED: &str = "amos.telephony.watch_open_failed";
    /// A `Watch` event could not be read off the stream.
    pub const WATCH_STREAM_ERROR: &str = "amos.telephony.watch_stream_error";
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
    pub recording: String,
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
        recording,
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
    #[cfg(feature = "android")]
    if crate::incall::real_hang_up().unwrap_or(false) {
        return Ok(());
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

/// Start recording a live call; returns its authoritative snapshot (recording=On).
#[tauri::command]
pub async fn telephony_start_recording(call_id: String) -> Result<TelephonyCallPayload, AmosError> {
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyCallIdTooLong,
            format!(
                "telephony call_id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
                call_id.len()
            ),
        ));
    }
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
#[tauri::command]
pub async fn telephony_stop_recording(call_id: String) -> Result<TelephonyCallPayload, AmosError> {
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::TelephonyCallIdTooLong,
            format!(
                "telephony call_id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
                call_id.len()
            ),
        ));
    }
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
    #[cfg(feature = "android")]
    if crate::incall::real_answer().unwrap_or(false) {
        return Ok(());
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
    use super::{call_payload, codes};
    use amos_proto::amos_telephony::{
        CallDirection as ProtoDirection, CallIdMsg, CallSnapshot, CallState as ProtoState,
        RecordingState as ProtoRecording,
    };

    fn snap(state: i32, direction: i32, recording: i32) -> CallSnapshot {
        CallSnapshot {
            call: Some(CallIdMsg { id: "c1".into() }),
            peer: "13800138000".into(),
            direction,
            state,
            end_reason: 0,
            emergency: false,
            recording,
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
        assert_eq!(p.recording, "On");
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
        assert_eq!(p.recording, "Failed");
    }

    #[test]
    fn unknown_values_degrade_to_safe_defaults() {
        // Unrecognized wire values must never panic or leak raw ints to the UI.
        let p = call_payload(&snap(999, 999, 999));
        assert_eq!(p.state, "Unknown");
        assert_eq!(p.direction, "Outgoing");
        assert_eq!(p.recording, "Off");
    }

    #[test]
    fn maps_dialing_and_recording_off() {
        let p = call_payload(&snap(
            ProtoState::Dialing as i32,
            ProtoDirection::Outgoing as i32,
            ProtoRecording::RecordingOff as i32,
        ));
        assert_eq!(p.state, "Dialing");
        assert_eq!(p.recording, "Off");
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

        // The enum side keeps the same strings — a drift between the two would
        // be a wire break one of the callsites would not survive.
        assert_eq!(
            ErrorCode::TelephonyNumberTooLong.as_str(),
            codes::NUMBER_TOO_LONG
        );
        assert_eq!(ErrorCode::TelephonyRpcFailed.as_str(), codes::RPC_FAILED);

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
}
