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
use tokio::net::UnixStream;
use tokio::time::{sleep, Duration};
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

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

/// The OS daemon socket — the same one `ai_bridge`/`translate` use (`AMOS_SOCKET`
/// wins, else the platform default, e.g. `/tmp/amos-ai.sock`).
fn socket_path() -> std::path::PathBuf {
    amos_proto::socket::default_socket_path()
}

async fn build_channel() -> Result<tonic::transport::Channel, String> {
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
    Ok(channel)
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
