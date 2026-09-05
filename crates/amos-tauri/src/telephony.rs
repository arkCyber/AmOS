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

/// Tauri event name carrying one `TelephonyCallPayload` per daemon `Watch` event.
pub const TELEPHONY_EVENT: &str = "telephony-event";

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

async fn build_channel() -> Result<tonic::transport::Channel, String> {
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
#[tauri::command]
pub async fn telephony_dial(
    number: String,
    emergency: bool,
) -> Result<TelephonyDialPayload, String> {
    let mut client = TelephonyClient::new(build_channel().await?);
    let resp = client
        .dial(DialRequest { number, emergency })
        .await
        .map_err(|e| format!("telephony dial RPC failed: {e}"))?
        .into_inner();
    Ok(TelephonyDialPayload { id: resp.id })
}

/// End a live call by id.
#[tauri::command]
pub async fn telephony_end(call_id: String) -> Result<(), String> {
    // When AmOS is the default phone app, a real Telecom call is in flight — hang up
    // the real call via the bound AmosInCallService instead of the daemon (mock).
    #[cfg(feature = "android")]
    if crate::incall::real_hang_up().unwrap_or(false) {
        return Ok(());
    }
    let mut client = TelephonyClient::new(build_channel().await?);
    client
        .end(EndRequest {
            call: Some(CallIdMsg { id: call_id }),
        })
        .await
        .map_err(|e| format!("telephony end RPC failed: {e}"))?;
    Ok(())
}

/// List live calls (dialling / ringing / active).
#[tauri::command]
pub async fn telephony_status() -> Result<Vec<TelephonyCallPayload>, String> {
    let mut client = TelephonyClient::new(build_channel().await?);
    let resp = client
        .status(StatusRequest {})
        .await
        .map_err(|e| format!("telephony status RPC failed: {e}"))?
        .into_inner();
    Ok(resp.calls.iter().map(call_payload).collect())
}

/// Start recording a live call; returns its authoritative snapshot (recording=On).
#[tauri::command]
pub async fn telephony_start_recording(call_id: String) -> Result<TelephonyCallPayload, String> {
    let mut client = TelephonyClient::new(build_channel().await?);
    let resp = client
        .start_recording(CallIdMsg { id: call_id })
        .await
        .map_err(|e| format!("telephony start-recording RPC failed: {e}"))?
        .into_inner();
    Ok(call_payload(&resp))
}

/// Stop recording a live call; returns its authoritative snapshot (recording=Off).
#[tauri::command]
pub async fn telephony_stop_recording(call_id: String) -> Result<TelephonyCallPayload, String> {
    let mut client = TelephonyClient::new(build_channel().await?);
    let resp = client
        .stop_recording(CallIdMsg { id: call_id })
        .await
        .map_err(|e| format!("telephony stop-recording RPC failed: {e}"))?
        .into_inner();
    Ok(call_payload(&resp))
}

/// Answer an incoming (ringing) call. The resulting `Active` transition arrives on
/// the `Watch` stream and is delivered to the UI as a `telephony-event`.
#[tauri::command]
pub async fn telephony_answer(call_id: String) -> Result<(), String> {
    // Real incoming call (default phone app): answer via the bound in-call service.
    #[cfg(feature = "android")]
    if crate::incall::real_answer().unwrap_or(false) {
        return Ok(());
    }
    let mut client = TelephonyClient::new(build_channel().await?);
    client
        .answer(AnswerRequest {
            call: Some(CallIdMsg { id: call_id }),
        })
        .await
        .map_err(|e| format!("telephony answer RPC failed: {e}"))?;
    Ok(())
}

/// Dev/demo: ask the mock daemon to ring an incoming call from `number` (so the
/// desktop demo can exercise the incoming-call surface). Returns the new call id.
#[tauri::command]
pub async fn telephony_simulate_incoming(number: String) -> Result<String, String> {
    let mut client = TelephonyClient::new(build_channel().await?);
    let resp = client
        .simulate_incoming(SimulateIncomingRequest { number })
        .await
        .map_err(|e| format!("telephony simulate-incoming RPC failed: {e}"))?
        .into_inner();
    Ok(resp.id)
}

/// Drive one continuous `Watch` round: open the stream and forward every call-state
/// event to the WebView as `telephony-event`. Ends `Ok(())` when the daemon closes
/// the stream (caller reconnects) or `Err` if the daemon is down/errors.
async fn watch_round(app: AppHandle) -> Result<(), String> {
    let mut client = TelephonyClient::new(build_channel().await?);
    let mut stream = client
        .watch(WatchRequest {})
        .await
        .map_err(|e| format!("telephony watch open failed: {e}"))?
        .into_inner();
    while let Some(evt) = stream
        .message()
        .await
        .map_err(|e| format!("telephony watch stream error: {e}"))?
    {
        if let Some(call) = evt.call {
            let _ = app.emit(TELEPHONY_EVENT, call_payload(&call));
        }
    }
    Ok(())
}

/// Background task forwarding the daemon telephony `Watch` stream to the WebView for
/// the lifetime of the app. Reconnects with bounded backoff so a late-starting (or
/// restarted) daemon is picked up without a full UI reload.
pub fn spawn_telephony_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff_ms: u64 = 500;
        loop {
            let _ = watch_round(app.clone()).await;
            sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(8000);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::call_payload;
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
}
