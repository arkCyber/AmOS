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
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

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
    channel: Arc<Mutex<Option<crate::daemon::DaemonChannel>>>,
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

/// Persist the cloud API key to `path` with `0600`.
///
/// The key file is a **secret**, and its write used to be three silent discards
/// (`create_dir_all`, `write`, `set_permissions`). Both failure modes matter to the user:
/// a write that did not happen means the UI claimed the key was saved and it is gone after
/// a restart ("switching cloud later needs no re-entry"), and a `chmod` that did not happen
/// leaves the key readable by other users on the device. So both are errors here — and a
/// file that could not be restricted is **removed** rather than left on disk (REQ-A147).
pub fn persist_cloud_key(path: &std::path::Path, key: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
    }
    std::fs::write(path, key.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            let removed = std::fs::remove_file(path);
            return Err(match removed {
                Ok(()) => format!(
                    "cannot restrict {} to 0600 ({e}); the key was NOT persisted (the file was removed)",
                    path.display()
                ),
                Err(rm) => format!(
                    "cannot restrict {} to 0600 ({e}) and it could not be removed ({rm}) — \
                     the key may be readable by other users; fix its permissions",
                    path.display()
                ),
            });
        }
    }
    Ok(())
}

/// Persist the caller-provided cloud key and return a **user-visible** warning when that
/// failed, or `None` on success. The backend switch itself is not blocked by a persistence
/// failure (the key still reaches the daemon through the environment for this run), but the
/// user is told — which is the whole point: the failure used to be invisible, and a
/// `Result::Err` would have been invisible too, because the UI caller has no `.catch`.
fn persist_cloud_key_reporting(path: Option<&std::path::Path>, key: &str) -> Option<String> {
    match path {
        // No credential path at all (no `AMOS_CRED_FILE`, no `HOME`): the key cannot be
        // saved, which is exactly the claim the UI would otherwise make.
        None => Some(
            "⚠ no credential path configured (AMOS_CRED_FILE/HOME unset) — the API key was NOT persisted"
                .to_string(),
        ),
        Some(path) => persist_cloud_key(path, key).err().map(|e| format!("⚠ {e}")),
    }
}

/// One-click backend switch: runs `scripts/ai-backend.sh` which stops the current
/// amos-ai and starts it with the selected provider (local Ollama | OpenAI |
/// DeepSeek | custom OpenAI-compatible endpoint). `model`/`endpoint` carry the
/// cloud preset so openai/deepseek/custom map onto the daemon's generic `api`.
#[tauri::command]
pub async fn ai_backend_switch(
    provider: String,
    api_key: String,
    model: Option<String>,
    endpoint: Option<String>,
) -> Result<String, String> {
    let root = repo_root();
    let script = root.join("scripts").join("ai-backend.sh");
    let script_s = script.display().to_string();
    let root_s = root.display().to_string();
    let cred = creds_path();

    tauri::async_runtime::spawn_blocking(move || {
        let provider_id = provider.trim().to_string();
        // Any non-local/mock/ollama id is a cloud OpenAI-compatible backend.
        let cloud = !matches!(provider_id.as_str(), "local" | "mock" | "ollama");

        // Resolve an effective key: caller-provided wins and is persisted;
        // otherwise fall back to the 0600 key file (so switching cloud later,
        // or resuming after a restart, needs no re-entry).
        let mut effective = api_key;
        // A credential that failed to persist (or could not be restricted to 0600) must be
        // visible in the command's report; see `persist_cloud_key_reporting`.
        let mut persist_warning: Option<String> = None;
        if cloud {
            if !effective.is_empty() {
                persist_warning = persist_cloud_key_reporting(cred.as_deref(), &effective);
            } else if let Some(path) = cred {
                if let Ok(s) = std::fs::read_to_string(&path) {
                    effective = s.trim().to_string();
                }
            }
        }

        let mut cmd = std::process::Command::new("bash");
        cmd.arg(&script_s)
            .arg(&provider_id)
            .arg(&effective)
            .env("AMOS_ROOT", &root_s)
            .env("AMOS_API_KEY", &effective);
        // Only hand through a real cloud model/endpoint so a preset default
        // (resolved in ai-backend.sh) is used when the UI left them empty.
        for (name, val) in [("AMOS_MODEL", model), ("AMOS_API_ENDPOINT", endpoint)] {
            if let Some(v) = val {
                let t = v.trim();
                if !t.is_empty() {
                    cmd.env(name, t);
                }
            }
        }
        let out = cmd.output();
        // `persist_warning` is folded into whichever report the command returns: the user
        // sees the daemon launch report *and* the fact that the key was not saved (or not
        // restricted), instead of a success message that is quietly wrong.
        let with_warning = |report: String| match &persist_warning {
            Some(w) => format!("{report}\n{w}"),
            None => report,
        };
        match out {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                if o.status.success() {
                    Ok(with_warning(stdout.trim().to_string()))
                } else {
                    Err(with_warning(
                        format!("{stdout}\n{stderr}").trim().to_string(),
                    ))
                }
            }
            Err(e) => Err(with_warning(format!("failed to run {script_s}: {e}"))),
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
    async fn connect_channel(&self) -> Result<crate::daemon::DaemonChannel, String> {
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
    pub(crate) async fn connect(
        &self,
    ) -> Result<AiAgentClient<crate::daemon::DaemonChannel>, String> {
        Ok(AiAgentClient::new(self.connect_channel().await?))
    }

    /// Return an Android-manager client over the same shared channel.
    async fn connect_android(
        &self,
    ) -> Result<AndroidManagerClient<crate::daemon::DaemonChannel>, String> {
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
async fn build_channel() -> Result<crate::daemon::DaemonChannel, String> {
    crate::daemon::channel().await
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
    /// Generation admission pool live state + counters (REQ-A43); `None` on a
    /// daemon too old to report it.
    pub generation_pool: Option<GenerationPoolStatus>,
    /// Inference-response cache counters (REQ-A44); `None` on an older daemon.
    /// `enabled=false` when the cache is off (the default).
    pub response_cache: Option<ResponseCacheStatus>,
    /// On-disk log sink health (REQ-A87); `None` on a daemon too old to report it,
    /// `enabled=false` when the daemon logs to stdout only.
    pub log_sink: Option<LogSinkStatus>,
    /// Backend circuit breaker state + decision counters (REQ-A131); `None` on a
    /// daemon too old to report it. `enabled=false` means it is **not** in the
    /// serving path — then `state` is empty rather than a fabricated "closed".
    pub breaker: Option<BreakerStatus>,
    /// Active threshold alerts (REQ-A133); `None` on an older daemon. An **empty**
    /// list is the healthy state — absence of the block means "not reported", which is
    /// why the two are not the same thing to a caller.
    pub alerts: Option<Vec<AlertStatus>>,
}

/// Serializable mirror of one daemon `Alert` (REQ-A133): what is wrong, how bad, and
/// how long *this daemon* has seen it (not how long the problem existed).
#[derive(Clone, Debug, Serialize)]
pub struct AlertStatus {
    pub id: String,
    pub severity: String,
    pub detail: String,
    pub active_for_seconds: u64,
}

/// Serializable mirror of the daemon `BreakerMetrics` (REQ-A131), so the AI page can
/// show that the backend is being skipped *on purpose* — and how often.
#[derive(Clone, Debug, Serialize)]
pub struct BreakerStatus {
    pub enabled: bool,
    /// "closed" | "open" | "half_open"; "" when not in the serving path.
    pub state: String,
    pub fail_threshold: u32,
    pub cooldown_seconds: u64,
    pub consecutive_failures: u32,
    pub openings: u64,
    pub rejections: u64,
    pub failures: u64,
    pub successes: u64,
}

/// Serializable mirror of the daemon `LogSinkMetrics` (REQ-A87): whether the
/// persisted log trail exists, where, and how much of it failed to land.
#[derive(Clone, Debug, Serialize)]
pub struct LogSinkStatus {
    pub enabled: bool,
    pub path: String,
    pub bytes_written: u64,
    pub lost_bytes: u64,
    pub write_failures: u64,
    pub rotations: u64,
    pub active_bytes: u64,
}

/// Serializable mirror of the daemon `GenerationPoolMetrics` (REQ-A43), so the
/// diagnostics UI can show concurrent-generation headroom + rejection reasons.
#[derive(Clone, Debug, Serialize)]
pub struct GenerationPoolStatus {
    pub capacity: u32,
    pub in_flight: u32,
    pub available: u32,
    pub acquired_total: u64,
    pub rejected_saturated: u64,
    pub rejected_timeout: u64,
    pub wait_ms: u64,
}

/// Serializable mirror of the daemon `ResponseCacheMetrics` (REQ-A44). When the
/// cache is disabled every counter is an honest zero (never fabricated).
#[derive(Clone, Debug, Serialize)]
pub struct ResponseCacheStatus {
    pub enabled: bool,
    pub capacity: u32,
    pub ttl_seconds: u64,
    pub entries: u32,
    pub hits: u64,
    pub misses: u64,
    pub stores: u64,
    pub evicted: u64,
    pub expired: u64,
    pub oversized: u64,
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
                    generation_pool: r.generation_pool.map(|g| GenerationPoolStatus {
                        capacity: g.capacity,
                        in_flight: g.in_flight,
                        available: g.available,
                        acquired_total: g.acquired_total,
                        rejected_saturated: g.rejected_saturated,
                        rejected_timeout: g.rejected_timeout,
                        wait_ms: g.wait_ms,
                    }),
                    response_cache: r.response_cache.map(|c| ResponseCacheStatus {
                        enabled: c.enabled,
                        capacity: c.capacity,
                        ttl_seconds: c.ttl_seconds,
                        entries: c.entries,
                        hits: c.hits,
                        misses: c.misses,
                        stores: c.stores,
                        evicted: c.evicted,
                        expired: c.expired,
                        oversized: c.oversized,
                    }),
                    log_sink: r.log_sink.map(|l| LogSinkStatus {
                        enabled: l.enabled,
                        path: l.path,
                        bytes_written: l.bytes_written,
                        lost_bytes: l.lost_bytes,
                        write_failures: l.write_failures,
                        rotations: l.rotations,
                        active_bytes: l.active_bytes,
                    }),
                    breaker: r.breaker.map(|b| BreakerStatus {
                        enabled: b.enabled,
                        state: b.state,
                        fail_threshold: b.fail_threshold,
                        cooldown_seconds: b.cooldown_seconds,
                        consecutive_failures: b.consecutive_failures,
                        openings: b.openings,
                        rejections: b.rejections,
                        failures: b.failures,
                        successes: b.successes,
                    }),
                    alerts: r.alerts.map(|a| {
                        a.alerts
                            .into_iter()
                            .map(|x| AlertStatus {
                                id: x.id,
                                severity: x.severity,
                                detail: x.detail,
                                active_for_seconds: x.active_for_seconds,
                            })
                            .collect()
                    }),
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

/// Merge the AI system context for a request: prefer the `SystemContext` entry
/// addressed to `target` (the multi-window "selection → AI" flow); otherwise fall
/// back to the newest text in the *global clipboard* so the agent can also see
/// what the user most recently copied anywhere. Either way it lands under the
/// `system_selection` key, keeping the wire/proto unchanged.
fn merge_system_selection(
    ctx: &SystemContext,
    target: &str,
    clip: &crate::clipboard::GlobalClipboard,
    out: &mut std::collections::HashMap<String, String>,
) {
    inject_context(ctx, target, out);
    if out.get("system_selection").is_none() {
        if let Some(text) = clip.latest_text() {
            out.insert("system_selection".into(), text);
        }
    }
}

/// Tauri command: kick off an AI generation and stream tokens to the WebView.
///
/// If a `SystemContext` entry is addressed to the requesting window (via
/// `target_window`), its text is injected into `AgentRequest.context` under the
/// `system_selection` key so the multi-window "selection → AI" flow works
/// without any new protocol (see `docs/multi-window.md` §3); otherwise the
/// newest text on the global clipboard is used instead.
#[tauri::command]
pub async fn ask_ai_agent(
    app: AppHandle,
    state: State<'_, AiBridge>,
    ctx: State<'_, SystemContext>,
    clip: State<'_, std::sync::Arc<crate::clipboard::GlobalClipboard>>,
    prompt: String,
    session_id: Option<String>,
    target_window: Option<String>,
) -> Result<(), String> {
    let sid = session_id.unwrap_or_else(|| "default".to_string());

    // Merge the system-wide selection context (addressed to this window) into
    // the request before it crosses the wire, falling back to the global
    // clipboard's newest text when no per-window entry is attached.
    let mut context = std::collections::HashMap::new();
    let target = target_window.unwrap_or_else(|| "ai".to_string());
    merge_system_selection(&ctx, &target, clip.inner(), &mut context);

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
/// (the bidi `ClientMessage` carries no context field, so it is prefixed),
/// falling back to the newest text on the global clipboard.
#[tauri::command]
pub async fn chat_agent(
    app: AppHandle,
    state: State<'_, AiBridge>,
    ctx: State<'_, SystemContext>,
    clip: State<'_, std::sync::Arc<crate::clipboard::GlobalClipboard>>,
    prompt: String,
    session_id: Option<String>,
    target_window: Option<String>,
) -> Result<(), String> {
    let sid = session_id.unwrap_or_else(|| "default".to_string());
    let target = target_window.unwrap_or_else(|| "ai".to_string());

    // Inject the system-wide selection context addressed to this window,
    // preferring it over the global clipboard's newest text.
    let mut context = std::collections::HashMap::new();
    merge_system_selection(&ctx, &target, clip.inner(), &mut context);
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
    /// (e.g. `legacy:<window_id>`); empty if the launch failed (or returned no
    /// window id), so the shell can tell "registered" from "not registered".
    pub window_label: String,
    pub error: String,
}

/// The external WM surface label for a container launch — `Some("legacy:<id>")`
/// **only** when the container actually started the app and gave back a real
/// window id. A failed launch (or a success that returned no id) yields `None`
/// so the WM never registers a bogus empty `legacy:` System window for an app
/// that did not start. Mirrors the daemon's `AppLaunchResponse` semantics
/// (`service.rs`: `success=false → window_id=""`).
fn legacy_surface_label(success: bool, window_id: &str) -> Option<String> {
    (success && !window_id.is_empty()).then(|| format!("legacy:{window_id}"))
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
                // Only a *successful* launch (with a real window id) opens a
                // surface — a failed launch must not leave a stale `legacy:`
                // System window behind.
                let label = legacy_surface_label(r.success, &r.window_id).unwrap_or_default();
                if !label.is_empty() {
                    // The launch succeeded in the container; if the window manager cannot
                    // take the surface, the app is running with nothing on screen — say so
                    // instead of returning a result that looks complete (REQ-A147).
                    if let Err(e) = wm.open_surface(&label) {
                        tracing::warn!(
                            label = %label,
                            error = %e,
                            "the launched container surface could not be registered with \
                             the window manager; the app is running but not shown"
                        );
                    }
                }
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

/// Serializable live container LMK task (prost types don't impl serde). The shell
/// uses this (via `GetLmkSnapshot`) as the *authoritative* set of still-alive
/// legacy surfaces when reconciling against `wm_windows`.
#[derive(Serialize)]
pub struct AndroidLmkTaskInfo {
    pub window_id: String,
    pub package_name: String,
    /// `foreground|visible|foreground_service|background|cached|stopped`.
    pub state: String,
}

/// Tauri command: fetch the daemon's live LMK task snapshot (which container
/// legacy surfaces are still alive) so the shell can reconcile stale surfaces.
#[tauri::command]
pub async fn android_lmk_tasks(
    state: State<'_, AiBridge>,
) -> Result<Vec<AndroidLmkTaskInfo>, String> {
    let mut attempt = 0;
    loop {
        let mut client = state.connect_android().await?;
        match client.get_lmk_snapshot(Empty {}).await {
            Ok(resp) => {
                let snap = resp.into_inner();
                return Ok(snap
                    .tasks
                    .into_iter()
                    .map(|t| AndroidLmkTaskInfo {
                        window_id: t.window_id,
                        package_name: t.package_name,
                        state: t.state_key,
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

#[cfg(test)]
mod tests {
    use super::{
        legacy_surface_label, merge_system_selection, persist_cloud_key,
        persist_cloud_key_reporting,
    };
    use crate::clipboard::GlobalClipboard;
    use crate::wm::SystemContext;
    use std::collections::HashMap;

    #[test]
    fn target_system_context_wins_over_global_clipboard() {
        let ctx = SystemContext::new();
        ctx.set("ai", "notes", "attached selection");
        let clip = GlobalClipboard::new();
        clip.write_plain("browser", "browser", "last copied")
            .unwrap();
        let mut out = HashMap::new();
        merge_system_selection(&ctx, "ai", &clip, &mut out);
        assert_eq!(
            out.get("system_selection").map(String::as_str),
            Some("attached selection")
        );
    }

    #[test]
    fn empty_system_context_falls_back_to_global_clipboard() {
        let ctx = SystemContext::new();
        let clip = GlobalClipboard::new();
        clip.write_plain("browser", "browser", "last copied")
            .unwrap();
        let mut out = HashMap::new();
        merge_system_selection(&ctx, "ai", &clip, &mut out);
        assert_eq!(
            out.get("system_selection").map(String::as_str),
            Some("last copied")
        );
    }

    #[test]
    fn empty_everything_injects_nothing() {
        let ctx = SystemContext::new();
        let clip = GlobalClipboard::new();
        let mut out = HashMap::new();
        merge_system_selection(&ctx, "ai", &clip, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn legacy_label_from_successful_launch() {
        assert_eq!(
            legacy_surface_label(true, "waydroid_com.tencent.mm"),
            Some("legacy:waydroid_com.tencent.mm".to_string())
        );
    }

    #[test]
    fn legacy_label_none_when_container_launch_failed() {
        // Daemon returns success=false (and an empty window_id) for a failed
        // launch — we must NOT register a stale empty `legacy:` System surface.
        assert_eq!(legacy_surface_label(false, ""), None);
        assert_eq!(legacy_surface_label(false, "waydroid_x"), None);
    }

    #[test]
    fn legacy_label_none_when_success_has_no_window_id() {
        // Defensive: a success that somehow carried no window id must not map to
        // the degenerate `legacy:` label either.
        assert_eq!(legacy_surface_label(true, ""), None);
    }

    /// The cloud API key is a secret kept in a 0600 file (REQ-A147). Its write used to be
    /// three silent discards, so a file that was never written — or written but left
    /// readable by other users — was indistinguishable from success.
    #[test]
    fn a_persisted_cloud_key_is_written_and_restricted_to_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("amos-creds-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("ai.key"); // parent must be created too

        persist_cloud_key(&path, "sk-secret").expect("persist");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "sk-secret");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the key file must not be group/other readable");

        // …and a successful persist raises no user-visible warning.
        assert!(persist_cloud_key_reporting(Some(&path), "sk-secret").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cloud_key_that_cannot_be_persisted_is_reported_not_swallowed() {
        let dir = std::env::temp_dir().join(format!("amos-creds-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A directory where the key file should be: `fs::write` fails.
        let path = dir.join("as-a-directory");
        std::fs::create_dir_all(&path).unwrap();

        let err = persist_cloud_key(&path, "sk-secret").expect_err("write must fail");
        assert!(
            err.contains(&path.display().to_string()),
            "the error must name the file: {err}"
        );
        let warned = persist_cloud_key_reporting(Some(&path), "sk-secret")
            .expect("a failed persist must produce a user-visible warning");
        assert!(
            warned.starts_with('⚠') && warned.contains("cannot write"),
            "{warned}"
        );

        // No credential path configured is *also* a silence worth breaking: the UI would
        // otherwise claim the key was saved.
        let none = persist_cloud_key_reporting(None, "sk-secret").expect("warning");
        assert!(none.contains("NOT persisted"), "{none}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
