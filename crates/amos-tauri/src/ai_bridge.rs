//! Tauri <-> AI daemon RPC bridge.
//!
//! The WebView calls `ask_ai_agent`/`get_status`; these commands open a tonic
//! client over the local Unix Domain Socket, spawn a background task that
//! consumes the token stream, and re-emit each token as a Tauri event so the
//! frontend renders without ever blocking the UI thread.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::wm::{inject_context, SystemContext, WmState};
use amos_proto::ai_agent::client_message::Payload;
use amos_proto::ai_agent::{
    ai_agent_client::AiAgentClient, AgentRequest, ClientMessage, StatusRequest,
};
use amos_proto::android_compat::{
    android_manager_client::AndroidManagerClient, AppIconRequest, AppLaunchRequest, Empty,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

/// App-managed state holding a cached gRPC channel. Reusing the channel avoids
/// re-handshaking per call; on an RPC failure the cache is invalidated and the
/// next call reconnects, so daemon restarts are handled gracefully.
pub struct AiBridge {
    channel: Arc<Mutex<Option<tonic::transport::Channel>>>,
    /// Outbound sender of the currently-active bidirectional `Chat` stream, if
    /// any, so `cancel_ai_session` can push a `Cancel` mid-conversation.
    active_bidi: Arc<Mutex<Option<mpsc::Sender<ClientMessage>>>>,
}

impl Default for AiBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl AiBridge {
    pub fn new() -> Self {
        Self {
            channel: Arc::new(Mutex::new(None)),
            active_bidi: Arc::new(Mutex::new(None)),
        }
    }

    /// Return the cached gRPC channel (shared by the AI and Android clients).
    async fn connect_channel(&self) -> Result<tonic::transport::Channel, String> {
        if let Some(c) = self
            .channel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            return Ok(c.clone());
        }
        let channel = build_channel().await?;
        if let Ok(mut g) = self.channel.lock() {
            *g = Some(channel.clone());
        }
        Ok(channel)
    }

    /// Return an AI agent client, reusing the cached channel when healthy.
    async fn connect(&self) -> Result<AiAgentClient<tonic::transport::Channel>, String> {
        Ok(AiAgentClient::new(self.connect_channel().await?))
    }

    /// Return an Android-manager client over the same shared channel.
    async fn connect_android(
        &self,
    ) -> Result<AndroidManagerClient<tonic::transport::Channel>, String> {
        Ok(AndroidManagerClient::new(self.connect_channel().await?))
    }

    /// Drop any cached channel so the next call rebuilds it.
    fn invalidate(&self) {
        if let Ok(mut g) = self.channel.lock() {
            *g = None;
        }
    }
}

/// Open a gRPC channel routed over the amos Unix Domain Socket.
async fn build_channel() -> Result<tonic::transport::Channel, String> {
    let path = amos_proto::socket::default_socket_path();
    // The URI host/port are unused for UDS; the connector below ignores them.
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = path.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| e.to_string())
}

/// Serializable snapshot of the daemon status (prost types don't impl serde).
#[derive(Serialize)]
pub struct DaemonStatus {
    pub running: bool,
    pub model: String,
    pub uptime_seconds: i64,
    pub gpu_util: u32,
    pub active_sessions: u32,
}

/// Probe the daemon, retrying once after reconnecting (in case it restarted).
pub async fn fetch_status(bridge: &AiBridge) -> Result<DaemonStatus, String> {
    let mut attempt = 0;
    loop {
        let mut client = bridge.connect().await?;
        match client.get_status(StatusRequest {}).await {
            Ok(reply) => {
                let r = reply.into_inner();
                return Ok(DaemonStatus {
                    running: r.running,
                    model: r.model,
                    uptime_seconds: r.uptime_seconds,
                    gpu_util: r.gpu_util,
                    active_sessions: r.active_sessions,
                });
            }
            Err(e) => {
                attempt += 1;
                bridge.invalidate();
                if attempt >= 2 {
                    return Err(e.to_string());
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

/// Tauri command: kick off an AI generation and stream tokens to the WebView.
///
/// If a `SystemContext` entry is addressed to the requesting window (via
/// `target_window`), its text is injected into `AgentRequest.context` under the
/// `system_selection` key so the multi-window "selection → AI" flow works
/// without any new protocol (see `docs/multi-window.md` §3).
#[tauri::command]
pub async fn ask_ai_agent(
    app: AppHandle,
    state: State<'_, AiBridge>,
    ctx: State<'_, SystemContext>,
    prompt: String,
    session_id: Option<String>,
    target_window: Option<String>,
) -> Result<(), String> {
    let sid = session_id.unwrap_or_else(|| "default".to_string());

    // Merge the system-wide selection context (addressed to this window) into
    // the request before it crosses the wire.
    let mut context = std::collections::HashMap::new();
    let target = target_window.unwrap_or_else(|| "ai".to_string());
    inject_context(&ctx, &target, &mut context);

    let request = AgentRequest {
        session_id: sid.clone(),
        prompt,
        context,
    };

    // Establish the stream with a single reconnect retry on failure.
    let mut attempt = 0;
    let mut stream = loop {
        let mut client = state.connect().await?;
        match client.stream_chat(request.clone()).await {
            Ok(s) => break s.into_inner(),
            Err(e) => {
                attempt += 1;
                state.invalidate();
                if attempt >= 2 {
                    return Err(e.to_string());
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    };

    // Consume the token stream on a background task and fan it out to the UI.
    tauri::async_runtime::spawn(async move {
        let mut full = String::new();
        while let Ok(Some(chunk)) = stream.message().await {
            if !chunk.token.is_empty() {
                full.push_str(&chunk.token);
                let _ = app.emit("ai-token-received", chunk.token);
            }
            if chunk.done {
                let _ = app.emit("ai-session-complete", (sid, full));
                let _ = app.emit("ai-chat-complete", ());
                break;
            }
        }
    });

    Ok(())
}

/// Tauri command: return a serializable daemon status snapshot.
#[tauri::command]
pub async fn get_status(state: State<'_, AiBridge>) -> Result<DaemonStatus, String> {
    fetch_status(&state).await
}

/// Tauri command: open a *bidirectional* `Chat` stream, push the opening prompt,
/// and stream tokens back via the same `ai-token-received` / `ai-chat-complete`
/// events as `ask_ai_agent`. The outbound sender is retained so the frontend can
/// push a `Cancel` (or a follow-up prompt) via `cancel_ai_session`.
///
/// System-wide context addressed to `target_window` is injected into the prompt
/// (the bidi `ClientMessage` carries no context field, so it is prefixed).
#[tauri::command]
pub async fn chat_agent(
    app: AppHandle,
    state: State<'_, AiBridge>,
    ctx: State<'_, SystemContext>,
    prompt: String,
    session_id: Option<String>,
    target_window: Option<String>,
) -> Result<(), String> {
    let sid = session_id.unwrap_or_else(|| "default".to_string());
    let target = target_window.unwrap_or_else(|| "ai".to_string());

    // Inject the system-wide selection context addressed to this window.
    let mut context = std::collections::HashMap::new();
    inject_context(&ctx, &target, &mut context);
    let mut prompt = prompt;
    if let Some(selection) = context.get("system_selection") {
        prompt = format!("[系统上下文] {selection}\n\n{prompt}");
    }

    let (tx, rx) = mpsc::channel(16);
    let request_stream = ReceiverStream::new(rx);

    let mut client = state.connect().await?;
    let mut stream = client
        .chat(request_stream)
        .await
        .map_err(|e| e.to_string())?
        .into_inner();

    // Remember the outbound sender so `cancel_ai_session` can interrupt it.
    if let Ok(mut g) = state.active_bidi.lock() {
        *g = Some(tx.clone());
    }

    // Push the opening prompt.
    tx.send(ClientMessage {
        payload: Some(Payload::Prompt(prompt)),
    })
    .await
    .map_err(|e| e.to_string())?;

    // Consume the token stream and fan it out to the UI on a background task.
    let active = state.active_bidi.clone();
    tauri::async_runtime::spawn(async move {
        let mut full = String::new();
        while let Ok(Some(chunk)) = stream.message().await {
            if !chunk.token.is_empty() {
                full.push_str(&chunk.token);
                let _ = app.emit("ai-token-received", chunk.token);
            }
            if chunk.done {
                let _ = app.emit("ai-session-complete", (sid.clone(), full.clone()));
                let _ = app.emit("ai-chat-complete", ());
                break;
            }
        }
        // Stream finished: drop the stored sender.
        if let Ok(mut g) = active.lock() {
            *g = None;
        }
    });

    Ok(())
}

/// Tauri command: push a `Cancel` on the active bidirectional `Chat` stream, if
/// one is open, so the UI can stop generation.
#[tauri::command]
pub async fn cancel_ai_session(state: State<'_, AiBridge>) -> Result<(), String> {
    // Take the sender out and drop the guard *before* awaiting, so the future
    // stays Send (a std::sync::MutexGuard cannot be held across an .await).
    let tx = {
        let mut guard = state.active_bidi.lock().unwrap_or_else(|p| p.into_inner());
        guard.take()
    };
    if let Some(tx) = tx {
        let _ = tx
            .send(ClientMessage {
                payload: Some(Payload::Cancel("user cancelled".to_string())),
            })
            .await;
    }
    Ok(())
}

/// Serializable view of a legacy Android app (prost types don't impl serde).
#[derive(Serialize)]
pub struct AndroidAppInfo {
    pub name: String,
    pub package_name: String,
    pub icon_path: String,
    pub activity: String,
}

/// Result of launching a legacy APK through the Android compat layer.
#[derive(Serialize)]
pub struct AndroidLaunchResult {
    pub success: bool,
    pub window_id: String,
    /// Window label the surface was registered under in the window manager
    /// (e.g. `legacy:<window_id>`); empty if the launch failed.
    pub window_label: String,
    pub error: String,
}

/// Tauri command: list installed Android apps (from the container runtime).
#[tauri::command]
pub async fn get_android_apps(state: State<'_, AiBridge>) -> Result<Vec<AndroidAppInfo>, String> {
    let mut attempt = 0;
    loop {
        let mut client = state.connect_android().await?;
        match client.get_installed_apps(Empty {}).await {
            Ok(resp) => {
                return Ok(resp
                    .into_inner()
                    .apps
                    .into_iter()
                    .map(|a| AndroidAppInfo {
                        name: a.name,
                        package_name: a.package_name,
                        icon_path: a.icon_path,
                        activity: a.activity,
                    })
                    .collect());
            }
            Err(e) => {
                attempt += 1;
                state.invalidate();
                if attempt >= 2 {
                    return Err(e.to_string());
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

/// Tauri command: launch a legacy Android app in the container.
#[tauri::command]
pub async fn launch_android_app(
    state: State<'_, AiBridge>,
    wm: State<'_, WmState>,
    package_name: String,
) -> Result<AndroidLaunchResult, String> {
    let mut attempt = 0;
    loop {
        let mut client = state.connect_android().await?;
        match client
            .launch_android_app(AppLaunchRequest {
                package_name: package_name.clone(),
            })
            .await
        {
            Ok(resp) => {
                let r = resp.into_inner();
                // Register the launched legacy app as an *external* System window
                // in the window manager (no WebviewWindow is created; the surface
                // is composited separately by Waydroid). Focus/z-order are tracked.
                let label = format!("legacy:{}", r.window_id);
                let _ = wm.open_surface(&label);
                return Ok(AndroidLaunchResult {
                    success: r.success,
                    window_id: r.window_id,
                    window_label: label,
                    error: r.error,
                });
            }
            Err(e) => {
                attempt += 1;
                state.invalidate();
                if attempt >= 2 {
                    return Err(e.to_string());
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

/// Tauri command: fetch a PNG icon for an app (rendered as a data URI).
#[tauri::command]
pub async fn get_android_app_icon(
    state: State<'_, AiBridge>,
    package_name: String,
) -> Result<Option<Vec<u8>>, String> {
    let mut attempt = 0;
    loop {
        let mut client = state.connect_android().await?;
        match client
            .get_app_icon(AppIconRequest {
                package_name: package_name.clone(),
            })
            .await
        {
            Ok(resp) => {
                let r = resp.into_inner();
                return Ok(if r.found { Some(r.icon_png) } else { None });
            }
            Err(e) => {
                attempt += 1;
                state.invalidate();
                if attempt >= 2 {
                    return Err(e.to_string());
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}
