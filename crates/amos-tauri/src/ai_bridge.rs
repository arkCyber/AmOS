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
    ai_agent_client::AiAgentClient, AgentRequest, ClearSessionsRequest, ClientMessage,
    GetHistoryRequest, ListSessionsRequest, RemoveSessionRequest, StatusRequest,
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

/// Wrap an outbound RPC payload in a `Request` carrying the caller identity, so
/// the daemon's security layer can apply per-client rate limits and attribute
/// each audit entry to this System UI client.
pub(crate) fn with_client_id<T>(payload: T) -> tonic::Request<T> {
    let mut req = tonic::Request::new(payload);
    // `system-ui` always parses; if it ever didn't we simply omit the header
    // (daemon treats the request as anonymous) rather than panic.
    if let Ok(value) = amos_proto::DEFAULT_CLIENT_ID.parse() {
        req.metadata_mut()
            .insert(amos_proto::CLIENT_ID_HEADER, value);
    }
    req
}

/// Serializable mirror of a proto `UiCard` so the frontend can receive it as an
/// event payload (prost structs are not `Serialize`).
#[derive(Clone, Debug, Serialize)]
pub struct CardPayload {
    kind: String,
    title: String,
    subtitle: String,
    fields: Vec<FieldPayload>,
    actions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
struct FieldPayload {
    key: String,
    value: String,
}

fn card_payload(card: amos_proto::ai_agent::UiCard) -> CardPayload {
    CardPayload {
        kind: card.kind,
        title: card.title,
        subtitle: card.subtitle,
        fields: card
            .fields
            .into_iter()
            .map(|f| FieldPayload {
                key: f.key,
                value: f.value,
            })
            .collect(),
        actions: card.actions,
    }
}

/// One unit of an AI reply stream, mirroring the daemon `AgentChunk` so the
/// (Tauri-free) core can be unit/integration tested headlessly.
#[derive(Clone, Debug, Serialize)]
pub struct ReplyEvent {
    pub token: String,
    pub done: bool,
    pub card: Option<CardPayload>,
}

/// Drive one unary `stream_chat` request against the daemon and collect the whole
/// reply (tokens + terminal card + done marker). This is the exact RPC the
/// `ask_ai_agent` command performs, but without any Tauri `AppHandle`, so it is
/// exercisable headlessly against a real daemon.
pub async fn ask_daemon(
    bridge: &AiBridge,
    request: AgentRequest,
) -> Result<Vec<ReplyEvent>, String> {
    // Establish the stream with a single reconnect retry on failure.
    let mut attempt = 0;
    let mut stream = loop {
        let mut client = bridge.connect().await?;
        match client.stream_chat(with_client_id(request.clone())).await {
            Ok(s) => break s.into_inner(),
            Err(e) => {
                attempt += 1;
                bridge.invalidate();
                if attempt >= 2 {
                    return Err(e.to_string());
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    };

    let mut events = Vec::new();
    while let Ok(Some(chunk)) = stream.message().await {
        let done = chunk.done;
        events.push(ReplyEvent {
            token: chunk.token,
            done,
            card: chunk.card.map(card_payload),
        });
        if done {
            break;
        }
    }
    Ok(events)
}

/// App-managed state holding a cached gRPC channel. Reusing the channel avoids
/// re-handshaking per call; on an RPC failure the cache is invalidated and the
/// next call reconnects, so daemon restarts are handled gracefully.
pub struct AiBridge {
    channel: Arc<Mutex<Option<tonic::transport::Channel>>>,
    /// Outbound sender of the currently-active bidirectional `Chat` stream, if
    /// any, so `cancel_ai_session` can push a `Cancel` mid-conversation.
    active_bidi: Arc<Mutex<Option<mpsc::Sender<ClientMessage>>>>,
}

/// Resolve the Amos repo root (hosts `scripts/ai-backend.sh` + the daemon bin):
/// `AMOS_ROOT` env first, else derive from the running binary's location.
fn repo_root() -> std::path::PathBuf {
    if let Ok(r) = std::env::var("AMOS_ROOT") {
        if !r.is_empty() {
            return std::path::PathBuf::from(r);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// Where the cloud AI key is persisted (0600) so it never lives in the webview
/// store and can be reused on later switches/resumes.
fn creds_path() -> Option<std::path::PathBuf> {
    if let Ok(f) = std::env::var("AMOS_CRED_FILE") {
        if !f.is_empty() {
            return Some(std::path::PathBuf::from(f));
        }
    }
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(|h| std::path::PathBuf::from(h).join(".amos").join("ai.key"))
}

/// One-click backend switch: runs `scripts/ai-backend.sh` which stops the current
/// amos-ai and starts it with the selected provider (local mock | DeepSeek api).
#[tauri::command]
pub async fn ai_backend_switch(provider: String, api_key: String) -> Result<String, String> {
    let root = repo_root();
    let script = root.join("scripts").join("ai-backend.sh");
    let script_s = script.display().to_string();
    let root_s = root.display().to_string();
    let cred = creds_path();

    tauri::async_runtime::spawn_blocking(move || {
        // Resolve an effective key: caller-provided wins and is persisted;
        // otherwise fall back to the 0600 key file (so switching cloud later,
        // or resuming after a restart, needs no re-entry).
        let mut effective = api_key;
        if provider == "deepseek" {
            if !effective.is_empty() {
                if let Some(path) = cred.clone() {
                    if let Some(dir) = path.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(&path, effective.as_bytes());
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                }
            } else if let Some(path) = cred {
                if let Ok(s) = std::fs::read_to_string(&path) {
                    effective = s.trim().to_string();
                }
            }
        }

        let out = std::process::Command::new("bash")
            .arg(&script_s)
            .arg(&provider)
            .arg(&effective)
            .env("AMOS_ROOT", &root_s)
            .env("AMOS_API_KEY", &effective)
            .output();
        match out {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                if o.status.success() {
                    Ok(stdout.trim().to_string())
                } else {
                    Err(format!("{stdout}\n{stderr}").trim().to_string())
                }
            }
            Err(e) => Err(format!("failed to run {script_s}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("switch task join error: {e}"))?
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
    pub(crate) async fn connect(&self) -> Result<AiAgentClient<tonic::transport::Channel>, String> {
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
    /// Active inference engine kind (mock|api|ollama|hermes|ggml).
    pub engine: String,
    /// Concrete model behind `engine` (empty for mock).
    pub engine_model: String,
    /// True when a real engine was requested but the daemon serves mock.
    pub degraded: bool,
    /// Voice ASR recognizer in effect (mock|sherpa|off).
    pub asr: String,
    /// Resolved device-acceleration target of the local GGML engine, e.g.
    /// "android/nnapi" (empty when a non-local engine is serving).
    pub accelerator: String,
}

/// Serializable mirror of the daemon `SessionInfo` so the frontend can render a
/// lightweight session list (prost structs are not `Serialize`).
#[derive(Clone, Debug, Serialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub model: String,
    pub tokens_generated: u64,
    pub cancelled: bool,
    pub age_seconds: u64,
}

/// Serializable mirror of a session's completed conversation history.
#[derive(Clone, Debug, Serialize)]
pub struct HistoryTurn {
    pub role: String,
    pub text: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct SessionHistory {
    pub session_id: String,
    pub model: String,
    pub tokens_generated: u64,
    pub cancelled: bool,
    pub turns: Vec<HistoryTurn>,
}

/// Fetch one session's completed conversation history (headless).
pub async fn get_session_history(bridge: &AiBridge, id: &str) -> Result<SessionHistory, String> {
    let mut attempt = 0;
    loop {
        let mut client = bridge.connect().await?;
        match client
            .get_history(with_client_id(GetHistoryRequest {
                session_id: id.to_string(),
            }))
            .await
        {
            Ok(reply) => {
                let r = reply.into_inner();
                return Ok(SessionHistory {
                    session_id: r.session_id,
                    model: r.model,
                    tokens_generated: r.tokens_generated,
                    cancelled: r.cancelled,
                    turns: r
                        .turns
                        .into_iter()
                        .map(|t| HistoryTurn {
                            role: t.role,
                            text: t.text,
                        })
                        .collect(),
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

/// List the daemon's tracked sessions (most recently active first), headless so
/// it can be unit/e2e tested like `fetch_status`.
pub async fn list_sessions(bridge: &AiBridge) -> Result<Vec<SessionInfo>, String> {
    let mut attempt = 0;
    loop {
        let mut client = bridge.connect().await?;
        match client
            .list_sessions(with_client_id(ListSessionsRequest {}))
            .await
        {
            Ok(reply) => {
                let r = reply.into_inner();
                return Ok(r
                    .sessions
                    .into_iter()
                    .map(|s| SessionInfo {
                        session_id: s.session_id,
                        model: s.model,
                        tokens_generated: s.tokens_generated,
                        cancelled: s.cancelled,
                        age_seconds: s.age_seconds,
                    })
                    .collect());
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

/// Probe the daemon, retrying once after reconnecting (in case it restarted).
pub async fn fetch_status(bridge: &AiBridge) -> Result<DaemonStatus, String> {
    let mut attempt = 0;
    loop {
        let mut client = bridge.connect().await?;
        match client.get_status(with_client_id(StatusRequest {})).await {
            Ok(reply) => {
                let r = reply.into_inner();
                return Ok(DaemonStatus {
                    running: r.running,
                    model: r.model,
                    uptime_seconds: r.uptime_seconds,
                    gpu_util: r.gpu_util,
                    active_sessions: r.active_sessions,
                    engine: r.engine,
                    engine_model: r.engine_model,
                    degraded: r.degraded,
                    asr: r.asr,
                    accelerator: r.accelerator,
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

    // Drive the RPC headlessly (collectable/testable), then fan the events out to
    // the WebView exactly as before: per-token + card + session-complete.
    let events = ask_daemon(&state, request).await?;
    tauri::async_runtime::spawn(async move {
        let mut full = String::new();
        for e in events {
            if !e.token.is_empty() {
                full.push_str(&e.token);
                let _ = app.emit("ai-token-received", e.token);
            }
            if let Some(card) = e.card {
                if !card.kind.is_empty() {
                    let _ = app.emit("ai-card-received", card);
                }
            }
            if e.done {
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

/// Remove every tracked daemon session; returns how many were cleared.
pub async fn clear_sessions(bridge: &AiBridge) -> Result<u32, String> {
    let mut attempt = 0;
    loop {
        let mut client = bridge.connect().await?;
        match client
            .clear_sessions(with_client_id(ClearSessionsRequest {}))
            .await
        {
            Ok(reply) => return Ok(reply.into_inner().removed),
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

/// Tauri command: return the daemon's tracked sessions (for a session manager UI).
#[tauri::command]
pub async fn get_ai_sessions(state: State<'_, AiBridge>) -> Result<Vec<SessionInfo>, String> {
    list_sessions(&state).await
}

/// Remove a single tracked daemon session by id.
async fn remove_session(bridge: &AiBridge, id: &str) -> Result<bool, String> {
    let mut attempt = 0;
    loop {
        let mut client = bridge.connect().await?;
        match client
            .remove_session(with_client_id(RemoveSessionRequest {
                session_id: id.to_string(),
            }))
            .await
        {
            Ok(reply) => return Ok(reply.into_inner().removed),
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

/// Tauri command: remove a single tracked daemon session.
#[tauri::command]
pub async fn remove_ai_session(
    state: State<'_, AiBridge>,
    session_id: String,
) -> Result<bool, String> {
    remove_session(&state, &session_id).await
}

/// Tauri command: fetch one session's completed conversation history.
#[tauri::command]
pub async fn get_ai_session_history(
    state: State<'_, AiBridge>,
    session_id: String,
) -> Result<SessionHistory, String> {
    get_session_history(&state, &session_id).await
}

/// Tauri command: clear all tracked daemon sessions.
#[tauri::command]
pub async fn clear_ai_sessions(state: State<'_, AiBridge>) -> Result<u32, String> {
    clear_sessions(&state).await
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
        .chat(with_client_id(request_stream))
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
            if let Some(card) = chunk.card {
                if !card.kind.is_empty() {
                    let _ = app.emit("ai-card-received", card_payload(card));
                }
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
