//! gRPC service implementation served over a Unix Domain Socket.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use amos_proto::ai_agent::{
    ai_agent_server::{AiAgent, AiAgentServer},
    AgentChunk, AgentRequest, ClearSessionsReply, ClearSessionsRequest, ClientMessage,
    EnergyPolicy, GetHistoryReply, GetHistoryRequest, GovernorMetrics, HistoryTurn,
    ListSessionsReply, ListSessionsRequest, ProfileMetrics, RemoveSessionReply,
    RemoveSessionRequest, SessionInfo, StatusReply, StatusRequest,
};
use amos_proto::{CLIENT_ID_HEADER, DEFAULT_CLIENT_ID};
use anyhow::Context;
use tokio::sync::mpsc;
use tokio_stream::wrappers::{ReceiverStream, UnixListenerStream};
use tonic::{Request, Response, Status, Streaming};

use crate::energy::{EnergySnapshot, EnergyStore};
use crate::governor::ResourceGovernor;
use crate::inference::real::{BackendKind, InferenceBackend, MockBackend, OllamaBackend};
use crate::monitoring::Monitor;
use crate::profiler::{ProfileSnapshot, ProfileStore};
use crate::security::{AuditResult, Permission, SecurityManager};
use crate::session::SessionManager;

/// The AiAgent service implementation backed by the (mock) inference engine.
///
/// Every RPC passes through the [`SecurityManager`] gate: permission check +
/// per-client rate limiting first, then token accounting + audit logging while
/// the stream runs. See `security.rs`.
pub struct AiAgentService {
    model: &'static str,
    /// Number of in-flight generation sessions (for `get_status`).
    active_sessions: Arc<AtomicUsize>,
    /// Rate limiting / audit logging / permission checks applied to every call.
    security: Arc<SecurityManager>,
    /// The active inference backend (GGML / API / Mock), selected via env.
    backend: Arc<dyn InferenceBackend>,
    /// Startup snapshot of the effective engine + ASR, so `get_status` can tell a
    /// caller which real engine is serving and whether it degraded to mock.
    engine: EngineState,
    /// Session lineage tracking (token usage, context, memory).
    sessions: Arc<SessionManager>,
    /// Where sessions are persisted (`AMOS_SESSIONS_PATH`); `None` = in-memory.
    sessions_path: Option<std::path::PathBuf>,
    /// Daemon health/metrics (RPC counts, uptime, heartbeats).
    monitor: Arc<Monitor>,
    /// Rolling inference profile (decode tokens/s + TTFT) shared with the
    /// stream_chat decode path and exposed via `get_status`.
    profile: Arc<ProfileStore>,
    /// Rolling energy-governor store (battery/thermal/power → SensorMode + throttle
    /// flags), ticked periodically and exposed via `get_status`.
    energy: Arc<EnergyStore>,
    /// The shared resource-governor closed loop (set by `serve()` so `get_status`
    /// can report what the governor is doing; `None` for a standalone service).
    governor: Option<Arc<std::sync::Mutex<ResourceGovernor>>>,
}

impl AiAgentService {
    /// Build a service with the default security manager (grants `Standard` to
    /// the default client), the backend selected from the environment, and
    /// sessions loaded from `AMOS_SESSIONS_PATH` (if set).
    pub async fn new() -> Self {
        let security = SecurityManager::default();
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        // Periodically drop idle client buckets so the rate limiter's memory
        // stays bounded as one-off clients come and go.
        security.start_cleanup_task();
        let backend = build_backend_from_env().await;
        let sessions_path = std::env::var("AMOS_SESSIONS_PATH")
            .ok()
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from);
        let session_timeout = std::env::var("AMOS_SESSION_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|s| *s >= 1)
            .map(Duration::from_secs)
            .unwrap_or(Duration::from_secs(300));
        let sessions = Arc::new(match &sessions_path {
            Some(p) => SessionManager::load(p),
            None => SessionManager::new(session_timeout),
        });
        // Long-lived sessions that go idle must not accumulate: run the periodic
        // stale-session sweeper for the daemon's whole lifetime.
        let _sweeper = sessions
            .clone()
            .spawn_cleanup_task(sessions.cleanup_interval());
        // Snapshot the effective engine state (captured before the backend is
        // moved into the struct): reports which real engine is serving and
        // whether a requested real engine degraded to mock at startup.
        let engine = EngineState::from_env(&backend.metadata().name);
        Self {
            model: "amos-infer@0.1.0",
            active_sessions: Arc::new(AtomicUsize::new(0)),
            security: Arc::new(security),
            backend,
            engine,
            sessions,
            sessions_path,
            monitor: Arc::new(Monitor::new()),
            profile: Arc::new(ProfileStore::new()),
            energy: Arc::new(EnergyStore::new()),
            governor: None,
        }
    }

    /// Build a service around a caller-provided security manager, using the
    /// mock backend (used by tests to tighten rate limits / revoke access).
    pub fn with_security(security: Arc<SecurityManager>) -> Self {
        Self::with_security_and_backend(security, Arc::new(MockBackend::new()))
    }

    /// Build a service with an explicit security manager and inference backend.
    pub fn with_security_and_backend(
        security: Arc<SecurityManager>,
        backend: Arc<dyn InferenceBackend>,
    ) -> Self {
        Self {
            model: "amos-infer@0.1.0",
            active_sessions: Arc::new(AtomicUsize::new(0)),
            security,
            backend,
            engine: EngineState::non_degraded(),
            sessions: Arc::new(SessionManager::default()),
            sessions_path: None,
            monitor: Arc::new(Monitor::new()),
            profile: Arc::new(ProfileStore::new()),
            energy: Arc::new(EnergyStore::new()),
            governor: None,
        }
    }

    /// Attach a session manager and a persistence path (used by tests / custom
    /// embedding); call [`Self::save_sessions`] before shutdown to persist.
    pub fn with_sessions(
        self,
        sessions: Arc<SessionManager>,
        sessions_path: Option<std::path::PathBuf>,
    ) -> Self {
        Self {
            sessions,
            sessions_path,
            ..self
        }
    }

    /// Persist all tracked sessions to `AMOS_SESSIONS_PATH` (no-op if unset).
    pub async fn save_sessions(&self) {
        if let Some(p) = &self.sessions_path {
            if let Err(e) = self.sessions.save(p).await {
                tracing::warn!("failed to persist sessions: {e}");
            }
        }
    }

    /// Shared handle to the daemon metrics monitor (used by the gRPC interceptor
    /// and the periodic self-health heartbeat).
    pub fn monitor(&self) -> Arc<Monitor> {
        Arc::clone(&self.monitor)
    }

    /// Shared handle to the rolling inference profile store (decode path records
    /// into it; `get_status` reads it).
    pub fn profile(&self) -> Arc<ProfileStore> {
        Arc::clone(&self.profile)
    }

    /// Shared handle to the energy-governor store (ticked periodically; `get_status`
    /// reads it).
    pub fn energy(&self) -> Arc<EnergyStore> {
        Arc::clone(&self.energy)
    }

    /// Attach the daemon's shared resource-governor closed loop so `get_status`
    /// reports its live decision (called by `serve()`).
    pub fn set_governor(&mut self, governor: Arc<std::sync::Mutex<ResourceGovernor>>) {
        self.governor = Some(governor);
    }

    /// Fold the current [`ProfileStore`] snapshot into the wire `ProfileMetrics`.
    fn profile_metrics(&self) -> ProfileMetrics {
        let s: ProfileSnapshot = self.profile.snapshot();
        ProfileMetrics {
            decode_tokens_per_sec: s.decode_tokens_per_sec,
            ttft_ms: s.ttft_ms,
            decode_tokens_total: s.decode_tokens_total,
            decode_runs: s.decode_runs,
        }
    }

    /// Fold the current [`EnergyStore`] snapshot into the wire `EnergyPolicy`.
    fn energy_metrics(&self) -> EnergyPolicy {
        let s: EnergySnapshot = self.energy.snapshot();
        EnergyPolicy {
            sensor_mode: s.sensor_mode.to_string(),
            reason: s.reason.to_string(),
            cap_inference: s.cap_inference,
            throttle_background: s.throttle_background,
            ticks: s.ticks,
        }
    }

    /// Fold the shared resource-governor's latest decision into the wire
    /// `GovernorMetrics` (pending baseline when the governor is not attached / has
    /// not run yet).
    fn governor_metrics(&self) -> GovernorMetrics {
        match &self.governor {
            Some(g) => {
                let g = g.lock().unwrap_or_else(|p| p.into_inner());
                match g.last_decision() {
                    Some(o) => GovernorMetrics {
                        sensor_mode: o.sensor_mode.to_string(),
                        reason: o.reason.to_string(),
                        cap_inference: o.cap_inference,
                        throttle_background: o.throttle_background,
                        ticks: g.ticks(),
                    },
                    None => GovernorMetrics {
                        sensor_mode: "balanced".to_string(),
                        reason: "pending".to_string(),
                        cap_inference: false,
                        throttle_background: false,
                        ticks: 0,
                    },
                }
            }
            None => GovernorMetrics {
                sensor_mode: "balanced".to_string(),
                reason: "pending".to_string(),
                cap_inference: false,
                throttle_background: false,
                ticks: 0,
            },
        }
    }

    /// Resolve the caller identity from the gRPC metadata header, falling back
    /// to the default client id when the caller did not identify itself.
    fn client_id<T>(&self, request: &Request<T>) -> String {
        request
            .metadata()
            .get(CLIENT_ID_HEADER)
            .and_then(|v| v.to_str().ok())
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_CLIENT_ID)
            .to_string()
    }
}

/// A real inference backend kind (as named by `AMOS_BACKEND`), as opposed to the
/// dev/test `mock` (or an empty/unknown value).
fn is_real_backend(kind: &str) -> bool {
    matches!(kind, "api" | "ollama" | "hermes" | "ggml")
}

/// Human label of the voice ASR recognizer that `ChatAsr` would build from the
/// environment — "off" (disabled), "sherpa" (explicit), "mock" (explicit), or
/// the unset-default which is "sherpa(auto)" when the `asr-sherpa` feature is
/// compiled in, else "mock". Mirrors `crate::chat_asr::ChatAsr::from_env`.
fn asr_label_from_env() -> String {
    match std::env::var("AMOS_ASR_BACKEND").as_deref() {
        Ok("off") | Ok("none") | Ok("disabled") => "off".to_string(),
        Ok("sherpa") => "sherpa".to_string(),
        Ok("mock") => "mock".to_string(),
        _ => {
            if cfg!(feature = "asr-sherpa") {
                "sherpa(auto)".to_string()
            } else {
                "mock".to_string()
            }
        }
    }
}

/// Startup snapshot of the *effective* engine state, captured once so the daemon
/// truthfully reports — and an operator can never mistake a degraded (mock)
/// engine for the real inference they asked for.
#[derive(Clone, Debug)]
struct EngineState {
    /// True when a real engine was requested (`AMOS_BACKEND` = api/ollama/hermes/
    /// ggml) but the daemon is actually serving the deterministic mock (the real
    /// backend failed to initialise at startup).
    degraded: bool,
    /// Voice ASR recognizer in effect: "mock" | "sherpa" | "sherpa(auto)" | "off".
    asr: String,
    /// Resolved device-acceleration target of the *local* inference engine
    /// (`amos_ai::accelerator`), e.g. "android/nnapi". `Some` only when a local
    /// engine that actually offloads is serving (ggml); `None` for remote/managed
    /// backends (mock/api/ollama/hermes). Never `Auto`, never fabricated.
    accelerator: Option<String>,
}

impl EngineState {
    /// Capture from the environment at startup.
    fn from_env(active_backend_name: &str) -> Self {
        let requested = std::env::var("AMOS_BACKEND").unwrap_or_default();
        Self {
            degraded: is_real_backend(&requested) && active_backend_name == "mock",
            asr: asr_label_from_env(),
            accelerator: accel_label_for_active(active_backend_name),
        }
    }

    /// Explicitly non-degraded snapshot (used when the caller injects a concrete
    /// backend, e.g. tests), with the ASR label read from the environment. No
    /// local-accelerator claim unless the caller sets one.
    fn non_degraded() -> Self {
        Self {
            degraded: false,
            asr: asr_label_from_env(),
            accelerator: None,
        }
    }
}

/// Which *active* backend should report a device-acceleration target: only the
/// local GGML engine applies `amos_ai::accelerator` offload (see
/// `inference::real`), so only it gets a label. Remote/managed backends
/// (mock/api/ollama/hermes) have no local offload to report → `None`.
fn accel_label_for_active(active: &str) -> Option<String> {
    (active == "ggml").then(|| crate::accelerator::AccelProfile::from_env().label())
}

/// Select and build the inference backend from the environment.
///
/// Env vars:
///   AMOS_BACKEND = "mock" | "api" | "ollama" | "hermes" | "ggml"  (default "mock")
///   AMOS_MODEL_PATH                                       (ggml)
///   AMOS_API_KEY / AMOS_API_ENDPOINT / AMOS_MODEL         (api)
///   AMOS_OLLAMA_HOST / AMOS_MODEL                         (ollama)
///   AMOS_HERMES_ENDPOINT / AMOS_MODEL                     (hermes)
///
/// **Honesty rule**: `mock` is a *dev/test* default only. When the operator
/// explicitly selects a real backend (`api`/`ollama`/`hermes`/`ggml`) and it
/// fails to initialise (unreachable server, missing model, bad key…), we keep
/// the daemon serving so the System UI and health probes stay up, but log the
/// failure at **error** level and make clear the running engine is the
/// deterministic mock — never silently pretending mock is real inference.
async fn build_backend_from_env() -> Arc<dyn InferenceBackend> {
    let kind = std::env::var("AMOS_BACKEND").unwrap_or_else(|_| "mock".to_string());
    // Surface which chip/accelerator the local-inference path would use, resolved
    // honestly (never "auto", never an uncompiled vendor SDK). See accelerator.rs.
    let accel = crate::accelerator::AccelProfile::from_env();
    let (accel_eff, accel_reason) = accel.resolve();
    match accel_reason {
        Some(r) => tracing::info!(
            requested = %accel.accel.label(),
            vendor = accel.vendor.label(),
            accel = %accel_eff.label(),
            "accelerator downgraded: {r}"
        ),
        None => tracing::info!(
            accel = %accel_eff.label(),
            vendor = accel.vendor.label(),
            llama_layers = accel.n_gpu_layers(),
            "local-inference accelerator profile"
        ),
    }
    let backend = match kind.as_str() {
        "ggml" => BackendKind::Ggml(std::env::var("AMOS_MODEL_PATH").unwrap_or_default()),
        "api" => BackendKind::Api {
            api_key: std::env::var("AMOS_API_KEY").unwrap_or_default(),
            endpoint: std::env::var("AMOS_API_ENDPOINT")
                .unwrap_or_else(|_| "https://api.openai.com/v1/chat/completions".into()),
            model: std::env::var("AMOS_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into()),
        },
        // Real on-device / localhost engine via Ollama. When the operator does
        // not pin a model, auto-select the first model the running Ollama has
        // actually installed (so the daemon serves real tokens instead of
        // erroring on a hard-coded default that may not be pulled yet).
        "ollama" => BackendKind::Ollama {
            host: std::env::var("AMOS_OLLAMA_HOST")
                .unwrap_or_else(|_| "http://localhost:11434".into()),
            model: resolve_ollama_model().await,
            // Some local Ollama builds / proxies gate `/v1` behind an API key.
            bearer: std::env::var("AMOS_OLLAMA_API_KEY")
                .ok()
                .filter(|k| !k.is_empty()),
        },
        "hermes" => BackendKind::Hermes {
            base_url: std::env::var("AMOS_HERMES_ENDPOINT")
                .unwrap_or_else(|_| "http://127.0.0.1:11438".into()),
            model: std::env::var("AMOS_MODEL").unwrap_or_else(|_| "hermes-rust".into()),
        },
        _ => BackendKind::Mock,
    };
    // Ollama manages its own offload, so the accelerator can't be passed as CLI
    // args — surface the resolved profile as the operator/device hint (which
    // chip Ollama should use). See accelerator.rs / docs/qcom-mtk-bringup.md.
    if kind == "ollama" {
        tracing::info!(
            accel = %accel_eff.label(),
            vendor = accel.vendor.label(),
            ollama_hint = %accel.ollama_hint(),
            "ollama backend — accelerator device hint"
        );
    }
    match backend.build().await {
        Ok(b) => Arc::from(b),
        Err(e) => {
            if matches!(kind.as_str(), "api" | "ollama" | "hermes" | "ggml") {
                tracing::error!(
                    backend = %kind,
                    "requested inference backend failed to initialise: {e:#}; serving the \
                     deterministic mock engine instead — this is NOT real inference"
                );
            } else {
                tracing::debug!("mock backend ready");
            }
            Arc::new(MockBackend::new())
        }
    }
}

/// Is `name` plausibly a *chat* model (not an embedding/test/junk model)?
/// Ollama reports every pulled model in `/api/tags`, including `*-embed*`
/// variants (no `/v1` chat) and stray `cli-smoke-*`/`bad-mf-*` entries left by
/// ad-hoc test pulls. Auto-selection must never hand the daemon one of these —
/// it yields an immediate empty/error reply or, worse, silently serves garbage.
fn is_chat_model(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() {
        return false;
    }
    let lower = n.to_ascii_lowercase();
    // Names are only the authoritative signal (list_models has no sizes). These
    // substrings reliably mark non-chat/test entries and won't match a real model.
    !["embed", "cli-smoke", "bad-mf"]
        .iter()
        .any(|marker| lower.contains(marker))
}

/// Pick the Ollama model to run: `AMOS_MODEL` when set, otherwise the first
/// *chat-capable* model the local Ollama reports installed via `/api/tags`
/// (embedding/text models are skipped). Falls back to the classic `hermes3`
/// name (Ollama will pull it on first use) when Ollama is unreachable or only
/// reports embedding models. Resolution is time-boxed so a down Ollama cannot
/// stall daemon startup for the full tags timeout.
async fn resolve_ollama_model() -> String {
    if let Ok(m) = std::env::var("AMOS_MODEL") {
        if !m.trim().is_empty() {
            return m;
        }
    }
    let host =
        std::env::var("AMOS_OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".into());
    let probe = OllamaBackend::new(host.clone(), String::new());
    let models = tokio::time::timeout(Duration::from_secs(3), probe.list_models())
        .await
        .unwrap_or_default();
    match models.iter().find(|m| is_chat_model(m)).cloned() {
        Some(model) => {
            tracing::info!(host = %host, model = %model, "auto-selected Ollama model");
            model
        }
        None => {
            tracing::warn!(
                host = %host,
                "Ollama reported no chat-capable installed model; defaulting to 'hermes3' (pulled on first use)"
            );
            "hermes3".to_string()
        }
    }
}

#[tonic::async_trait]
impl AiAgent for AiAgentService {
    type StreamChatStream = ReceiverStream<Result<AgentChunk, Status>>;

    async fn stream_chat(
        &self,
        request: Request<AgentRequest>,
    ) -> Result<Response<Self::StreamChatStream>, Status> {
        let client_id = self.client_id(&request);

        // Security gate: permission check + per-client rate limit. On failure the
        // SecurityManager already wrote a `Rejected` audit entry; surface it to
        // the caller as a gRPC error so it can back off.
        if let Err(e) = self.security.validate_request(&client_id).await {
            tracing::warn!(client = %client_id, "stream_chat rejected: {e}");
            return Err(Status::resource_exhausted(format!(
                "request rejected by security layer: {e}"
            )));
        }

        let req = request.into_inner();
        tracing::info!(session = %req.session_id, client = %client_id, "stream_chat start");

        self.active_sessions.fetch_add(1, Ordering::SeqCst);
        let active = self.active_sessions.clone();

        let (tx, rx) = mpsc::channel(64);
        let session_id = req.session_id.clone();
        let prompt = req.prompt.clone();
        let mut context = req.context.clone();
        // Pass the client session_id through so backends with their own session
        // lineage (Hermes-Rust) can bind multi-turn memory to it.
        if !session_id.is_empty() {
            context.insert(
                crate::inference::real::SESSION_CTX_KEY.to_string(),
                session_id.clone(),
            );
        }
        // Semantic intent detection (parity with the bidi `chat` path): if the
        // prompt maps to a structured card, acknowledge briefly and attach the
        // card to the terminal frame instead of a long text echo.
        let card = crate::semantic::detect(&prompt);

        // Hand clones of the security manager + backend to the streaming task.
        let security = self.security.clone();
        let client_for_log = client_id.clone();
        let backend = self.backend.clone();
        let sessions = self.sessions.clone();
        let profile = self.profile.clone();
        let session_key = sessions.create(self.model.to_string()).await;

        tokio::spawn(async move {
            // Card intent: brief ack + terminal frame carrying the card.
            if let Some(card) = card {
                let ack = AgentChunk {
                    session_id: session_id.clone(),
                    token: "✨ 已识别意图，正在生成卡片…".to_string(),
                    done: false,
                    error: String::new(),
                    card: None,
                };
                if tx.send(Ok(ack)).await.is_err() {
                    active.fetch_sub(1, Ordering::SeqCst);
                    return;
                }
                let done = AgentChunk {
                    session_id,
                    token: String::new(),
                    done: true,
                    error: String::new(),
                    card: Some(card),
                };
                let _ = tx.send(Ok(done)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                security.log_tokens(&client_for_log, 1).await;
                security
                    .audit_logger
                    .log(
                        client_for_log,
                        "stream_chat".to_string(),
                        "inference".to_string(),
                        AuditResult::Success,
                        "1 tokens streamed".to_string(),
                    )
                    .await;
                let _ = sessions.update(&session_key, |s| s.add_tokens(1)).await;
                return;
            }

            // Text intent: stream from the configured inference backend.
            // Profile this decode turn: gen_start → first token is the TTFT; the
            // whole run (tokens + wall) is the end-to-end decode throughput.
            let gen_start = Instant::now();
            let mut ttft_recorded = false;
            let mut stream = match backend.infer(&prompt, &context, 256).await {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx
                        .send(Ok(AgentChunk {
                            session_id: session_id.clone(),
                            token: String::new(),
                            done: true,
                            error: format!("inference error: {e}"),
                            card: None,
                        }))
                        .await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    return;
                }
            };

            let mut token_count = 0usize;
            let mut full = String::new();
            while let Some(token) = stream.next().await {
                let token = match token {
                    Ok(t) => t,
                    Err(_) => break,
                };
                full.push_str(&token);
                if !ttft_recorded {
                    ttft_recorded = true;
                    profile.record_ttft(gen_start.elapsed());
                }
                let chunk = AgentChunk {
                    session_id: session_id.clone(),
                    token,
                    done: false,
                    error: String::new(),
                    card: None,
                };
                if tx.send(Ok(chunk)).await.is_err() {
                    // Client disconnected; stop generating.
                    active.fetch_sub(1, Ordering::SeqCst);
                    return;
                }
                token_count += 1;
                tokio::time::sleep(crate::inference::TOKEN_INTERVAL).await;
            }
            // Record the completed decode turn for get_status profile metrics.
            profile.record_decode(token_count as u64, gen_start.elapsed());
            let final_frame = AgentChunk {
                session_id,
                token: String::new(),
                done: true,
                error: String::new(),
                card: None,
            };
            let _ = tx.send(Ok(final_frame)).await;
            active.fetch_sub(1, Ordering::SeqCst);

            // Token accounting against the per-client hourly quota + a completion
            // audit entry so the stream is fully attributable.
            security.log_tokens(&client_for_log, token_count).await;
            security
                .audit_logger
                .log(
                    client_for_log,
                    "stream_chat".to_string(),
                    "inference".to_string(),
                    AuditResult::Success,
                    format!("{token_count} tokens streamed"),
                )
                .await;
            let _ = sessions
                .update(&session_key, |s| s.add_tokens(token_count))
                .await;
            // Record the completed turn (user prompt + assistant reply) so a
            // session's history can be read back via get_history.
            let _ = sessions
                .update(&session_key, |s| {
                    s.append_turn("user".to_string(), prompt.clone());
                    s.append_turn("assistant".to_string(), full.clone());
                })
                .await;
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    type ChatStream = ReceiverStream<Result<AgentChunk, Status>>;

    async fn chat(
        &self,
        request: Request<Streaming<ClientMessage>>,
    ) -> Result<Response<Self::ChatStream>, Status> {
        let client_id = self.client_id(&request);

        // Security gate at stream establishment: permission + per-client rate
        // limit. A bidi stream is one logical "request" from the caller's side,
        // so we validate once up front (each turn is still token-accounted).
        if let Err(e) = self.security.validate_request(&client_id).await {
            tracing::warn!(client = %client_id, "chat rejected: {e}");
            return Err(Status::resource_exhausted(format!(
                "request rejected by security layer: {e}"
            )));
        }

        let mut inbound = request.into_inner();
        self.active_sessions.fetch_add(1, Ordering::SeqCst);
        let active = self.active_sessions.clone();
        let (tx, rx) = mpsc::channel(64);
        let security = self.security.clone();
        let backend = self.backend.clone();
        let sessions = self.sessions.clone();
        let profile = self.profile.clone();
        let session_key = sessions.create(self.model.to_string()).await;

        tokio::spawn(async move {
            // Reader task: forward every inbound message to a local channel so the
            // token loop can detect a `Cancel` *mid-generation* without losing a
            // queued follow-up message.
            let (in_tx, mut in_rx) = mpsc::channel(64);
            let forward = tokio::spawn(async move {
                while let Ok(Some(m)) = inbound.message().await {
                    if in_tx.send(m).await.is_err() {
                        break;
                    }
                }
            });

            // A follow-up message buffered while the previous turn was streaming.
            let mut pending: Option<ClientMessage> = None;

            // Session-aware context so backends with lineage (Hermes-Rust) bind
            // every turn of this connection to one conversation.
            let chat_ctx = {
                let mut m = HashMap::new();
                m.insert(
                    crate::inference::real::SESSION_CTX_KEY.to_string(),
                    session_key.clone(),
                );
                m
            };

            // Per-connection voice recognizer: `Payload::Audio` frames feed it;
            // when an utterance completes its text is enqueued as a prompt (see
            // the Audio arm below). Deterministic mock by default; disabled via
            // AMOS_ASR_BACKEND=off.
            let mut chat_asr = crate::chat_asr::ChatAsr::from_env();

            'outer: loop {
                let msg = if let Some(m) = pending.take() {
                    m
                } else {
                    match in_rx.recv().await {
                        Some(m) => m,
                        None => break, // client closed the outbound half
                    }
                };

                match msg.payload {
                    Some(amos_proto::ai_agent::client_message::Payload::Prompt(p)) => {
                        // Semantic intent detection: if the prompt maps to a
                        // structured UI card, acknowledge briefly and attach the
                        // card to the terminal frame instead of a long text echo.
                        let card = crate::semantic::detect(&p);
                        if let Some(card) = card {
                            let _ = tx
                                .send(Ok(AgentChunk {
                                    session_id: String::new(),
                                    token: "✨ 已识别意图，正在生成卡片…".to_string(),
                                    done: false,
                                    error: String::new(),
                                    card: None,
                                }))
                                .await;
                            let _ = tx
                                .send(Ok(AgentChunk {
                                    session_id: String::new(),
                                    token: String::new(),
                                    done: true,
                                    error: String::new(),
                                    card: Some(card),
                                }))
                                .await;
                            security.log_tokens(&client_id, 1).await;
                            security
                                .audit_logger
                                .log(
                                    client_id.clone(),
                                    "chat".to_string(),
                                    "inference".to_string(),
                                    AuditResult::Success,
                                    "1 tokens streamed".to_string(),
                                )
                                .await;
                            let _ = sessions.update(&session_key, |s| s.add_tokens(1)).await;
                            continue;
                        }
                        let gen_start = Instant::now();
                        let mut ttft_recorded = false;
                        let mut stream = match backend.infer(&p, &chat_ctx, 256).await {
                            Ok(s) => s,
                            Err(e) => {
                                let _ = tx
                                    .send(Ok(AgentChunk {
                                        session_id: String::new(),
                                        token: String::new(),
                                        done: true,
                                        error: format!("inference error: {e}"),
                                        card: None,
                                    }))
                                    .await;
                                continue;
                            }
                        };
                        let mut token_count = 0usize;
                        let mut cancelled = false;
                        let mut full = String::new();
                        loop {
                            let next_fut = stream.next();
                            tokio::select! {
                                r = next_fut => match r {
                                    Some(Ok(token)) => {
                                        full.push_str(&token);
                                        if !ttft_recorded {
                                            ttft_recorded = true;
                                            profile.record_ttft(gen_start.elapsed());
                                        }
                                        if tx
                                            .send(Ok(AgentChunk {
                                                session_id: String::new(),
                                                token,
                                                done: false,
                                                error: String::new(),
                                                card: None,
                                            }))
                                            .await
                                            .is_err()
                                        {
                                            active.fetch_sub(1, Ordering::SeqCst);
                                            return;
                                        }
                                        token_count += 1;
                                        tokio::time::sleep(crate::inference::TOKEN_INTERVAL).await;
                                    }
                                    Some(Err(_)) => break,
                                    None => break,
                                },
                                maybe = in_rx.recv() => match maybe {
                                    Some(ClientMessage {
                                        payload: Some(amos_proto::ai_agent::client_message::Payload::Cancel(_)),
                                        ..
                                    }) => cancelled = true,
                                    other => pending = other,
                                },
                            }
                            if cancelled {
                                break 'outer;
                            }
                        }
                        if cancelled {
                            break 'outer;
                        }
                        // Completed (non-cancelled) turn → fold into the shared
                        // inference profile (same store as stream_chat).
                        profile.record_decode(token_count as u64, gen_start.elapsed());
                        let _ = tx
                            .send(Ok(AgentChunk {
                                session_id: String::new(),
                                token: String::new(),
                                done: true,
                                error: String::new(),
                                card: None,
                            }))
                            .await;
                        // Per-turn token accounting + audit for the bidi path.
                        security.log_tokens(&client_id, token_count).await;
                        security
                            .audit_logger
                            .log(
                                client_id.clone(),
                                "chat".to_string(),
                                "inference".to_string(),
                                AuditResult::Success,
                                format!("{token_count} tokens streamed"),
                            )
                            .await;
                        let _ = sessions
                            .update(&session_key, |s| s.add_tokens(token_count))
                            .await;
                        // Bidi turn completed: record the prompt + reply for history.
                        let _ = sessions
                            .update(&session_key, |s| {
                                s.append_turn("user".to_string(), p.clone());
                                s.append_turn("assistant".to_string(), full.clone());
                            })
                            .await;
                    }
                    Some(amos_proto::ai_agent::client_message::Payload::Audio(audio)) => {
                        // Voice input: feed the frame to this connection's
                        // recognizer. When an utterance is complete (recognizer
                        // endpoint), enqueue its text as a *prompt* so the
                        // existing Prompt path (semantic card + inference +
                        // audit + session history) handles it unchanged. When
                        // voice is disabled the frame is simply dropped.
                        if let Some(prompt_text) =
                            chat_asr.as_mut().and_then(|a| a.feed_audio(&audio))
                        {
                            pending = Some(ClientMessage {
                                payload: Some(
                                    amos_proto::ai_agent::client_message::Payload::Prompt(
                                        prompt_text,
                                    ),
                                ),
                            });
                        }
                    }
                    Some(amos_proto::ai_agent::client_message::Payload::AudioEnd(_)) => {
                        // Push-to-talk release: the user signalled "done speaking",
                        // so force-finalize whatever was recognized so far into a
                        // prompt (works even for a short utterance that has not yet
                        // reached the recognizer's own VAD/endpoint).
                        if let Some(prompt_text) = chat_asr.as_mut().and_then(|a| a.finish()) {
                            pending = Some(ClientMessage {
                                payload: Some(
                                    amos_proto::ai_agent::client_message::Payload::Prompt(
                                        prompt_text,
                                    ),
                                ),
                            });
                        }
                    }
                    Some(amos_proto::ai_agent::client_message::Payload::Cancel(_)) => {
                        break 'outer;
                    }
                    None => {}
                }
            }
            active.fetch_sub(1, Ordering::SeqCst);
            forward.abort();
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn get_status(
        &self,
        request: Request<StatusRequest>,
    ) -> Result<Response<StatusReply>, Status> {
        let client_id = self.client_id(&request);
        // Consistency: even a liveness probe is a request the caller must be
        // permitted + within rate limit to make (prevents probe-driven abuse).
        if let Err(e) = self.security.validate_request(&client_id).await {
            return Err(Status::resource_exhausted(format!(
                "request rejected by security layer: {e}"
            )));
        }
        // Single snapshot so the reply's metrics are mutually consistent.
        let snap = self.monitor.snapshot();
        let meta = self.backend.metadata();
        Ok(Response::new(StatusReply {
            running: true,
            model: self.model.to_string(),
            uptime_seconds: snap.uptime_secs as i64,
            gpu_util: 0, // honest: no GPU/NPU metrics instrumented yet (0 ≠ a reading)
            active_sessions: self.active_sessions.load(Ordering::SeqCst) as u32,
            rpc_total: snap.rpc_total as i64,
            heartbeats: snap.heartbeats as i64,
            engine: meta.name,
            engine_model: meta.model_name,
            degraded: self.engine.degraded,
            asr: self.engine.asr.clone(),
            accelerator: self.engine.accelerator.clone().unwrap_or_default(),
            profile: Some(self.profile_metrics()),
            energy: Some(self.energy_metrics()),
            governor: Some(self.governor_metrics()),
        }))
    }

    /// Enumerate the daemon's tracked sessions, most-recently-active first.
    async fn list_sessions(
        &self,
        request: Request<ListSessionsRequest>,
    ) -> Result<Response<ListSessionsReply>, Status> {
        let client_id = self.client_id(&request);
        if let Err(e) = self.security.validate_request(&client_id).await {
            return Err(Status::resource_exhausted(format!(
                "request rejected by security layer: {e}"
            )));
        }
        let mut sessions = self.sessions.list_active().await;
        sessions.sort_by_key(|a| std::cmp::Reverse(a.last_activity));
        let sessions = sessions
            .into_iter()
            .take(100)
            .map(|s| SessionInfo {
                session_id: s.id,
                model: s.model,
                tokens_generated: s.tokens_generated as u64,
                cancelled: s.cancelled,
                age_seconds: s.created_at.elapsed().as_secs(),
            })
            .collect::<Vec<_>>();
        Ok(Response::new(ListSessionsReply {
            count: sessions.len() as u32,
            sessions,
        }))
    }

    /// Remove all tracked sessions (session-management "clear all").
    async fn clear_sessions(
        &self,
        request: Request<ClearSessionsRequest>,
    ) -> Result<Response<ClearSessionsReply>, Status> {
        let client_id = self.client_id(&request);
        if let Err(e) = self.security.validate_request(&client_id).await {
            return Err(Status::resource_exhausted(format!(
                "request rejected by security layer: {e}"
            )));
        }
        let removed = self.sessions.clear_all().await;
        Ok(Response::new(ClearSessionsReply {
            removed: removed as u32,
        }))
    }

    /// Remove a single tracked session by id.
    async fn remove_session(
        &self,
        request: Request<RemoveSessionRequest>,
    ) -> Result<Response<RemoveSessionReply>, Status> {
        let client_id = self.client_id(&request);
        if let Err(e) = self.security.validate_request(&client_id).await {
            return Err(Status::resource_exhausted(format!(
                "request rejected by security layer: {e}"
            )));
        }
        let id = request.into_inner().session_id;
        let removed = self.sessions.remove(&id).await.is_ok();
        Ok(Response::new(RemoveSessionReply { removed }))
    }

    /// Fetch one session's completed conversation history.
    async fn get_history(
        &self,
        request: Request<GetHistoryRequest>,
    ) -> Result<Response<GetHistoryReply>, Status> {
        let client_id = self.client_id(&request);
        if let Err(e) = self.security.validate_request(&client_id).await {
            return Err(Status::resource_exhausted(format!(
                "request rejected by security layer: {e}"
            )));
        }
        let id = request.into_inner().session_id;
        let meta = self
            .sessions
            .get(&id)
            .await
            .ok_or_else(|| Status::not_found("session not found"))?;
        let turns = meta
            .history
            .into_iter()
            .map(|t| HistoryTurn {
                role: t.role,
                text: t.text,
            })
            .collect();
        Ok(Response::new(GetHistoryReply {
            session_id: id,
            model: meta.model,
            tokens_generated: meta.tokens_generated as u64,
            cancelled: meta.cancelled,
            turns,
        }))
    }
}

/// Bind the UDS, harden its permissions, and run the tonic server until a
/// shutdown signal arrives, then clean up the socket file.
pub async fn serve(path: std::path::PathBuf) -> anyhow::Result<()> {
    let listener = tokio::net::UnixListener::bind(&path)?;

    // Restrict access: only the owning OS user may connect to the daemon.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .context("failed to harden socket permissions")?;
    }

    let incoming = UnixListenerStream::new(listener);
    // The single UDS serves BOTH gRPC services: the AI agent and the Android
    // compat layer, so Tauri talks to the whole OS backend over one connection.
    // The runtime is auto-selected: real Waydroid on device, in-process demo
    // elsewhere (so the whole pipeline works on any host).
    let mut ai_service = AiAgentService::new().await;
    // monitor counts requests to the *AiAgent* gRPC service (the AI daemon's own
    // RPCs); the Android-compat service sharing the same socket is separate.
    let monitor = ai_service.monitor();
    // Keep a handle to the session store so we can persist it on shutdown.
    let sessions = ai_service.sessions.clone();
    let sessions_path = ai_service.sessions_path.clone();

    // Periodic self-health heartbeat: logs a metrics line every interval (aborted
    // on shutdown). Metrics are also served live over GetStatus.
    let interval = metrics_interval();
    let heartbeat = monitor.spawn_periodic(interval);
    // Roll the live inference profile into the same periodic cadence so an
    // operator sees decode tps / TTFT without an RPC round-trip.
    let profile_beat = ai_service.profile().spawn_periodic_log(interval);
    // Tick the energy governor on the same cadence (battery/thermal → SensorMode +
    // throttle flags), logged + served over GetStatus.energy.
    let energy_beat = ai_service.energy().spawn_periodic(interval);
    // Run the composed resource/energy/lifecycle/scheduler closed loop over a
    // SHARED ResourceGovernor. The periodic beat ticks it (energy → freeze/thaw →
    // defer/reclaim) while the Governor gRPC service (below) lets a System UI /
    // per-app host register apps & jobs into the same instance — so the loop acts
    // on host-registered apps, not an empty registry. Logs only when it acts.
    let governor: Arc<std::sync::Mutex<ResourceGovernor>> =
        Arc::new(std::sync::Mutex::new(ResourceGovernor::default()));
    let gov_pressure = env_governor_flag("AMOS_GOVERNOR_MEMORY_PRESSURE");
    let gov_window = env_governor_flag("AMOS_GOVERNOR_MAINTENANCE");
    let governor_beat = {
        let gov = Arc::clone(&governor);
        let interval = interval.max(std::time::Duration::from_millis(1));
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            let mut now = 0u64;
            loop {
                ticker.tick().await;
                now += 1;
                let t = crate::energy::telemetry_from_env();
                let o = {
                    let mut g = gov.lock().unwrap_or_else(|p| p.into_inner());
                    g.observe(now, t, gov_pressure, gov_window)
                };
                let acted = !o.fired_alarms.is_empty()
                    || !o.ran_deferred.is_empty()
                    || !o.frozen.is_empty()
                    || !o.thawed.is_empty()
                    || !o.reclaimed.is_empty();
                if acted {
                    tracing::info!(
                        sensor_mode = o.sensor_mode,
                        reason = o.reason,
                        fired_alarms = o.fired_alarms.len(),
                        ran_deferred = o.ran_deferred.len(),
                        frozen = o.frozen.len(),
                        thawed = o.thawed.len(),
                        reclaimed = o.reclaimed.len(),
                        background_count = o.background_count,
                        "amos-ai resource governor acted"
                    );
                }
            }
        })
    };
    // Make get_status report the shared governor's live decision (same instance the
    // beat ticks and the Governor gRPC service mutates).
    ai_service.set_governor(Arc::clone(&governor));
    let svc_monitor = Arc::clone(&monitor);

    let server = tonic::transport::Server::builder()
        .add_service(AiAgentServer::with_interceptor(
            ai_service,
            move |req: tonic::Request<()>| {
                svc_monitor.record_rpc();
                Ok(req)
            },
        ))
        .add_service(amos_android::service::server(amos_android::auto()))
        // Telephony service (see crates/amos-telephony + docs/telephony.md).
        // P1 backend is the in-process mock; a real Android provider is swapped in
        // later (feature `android`). We mount the *rate-limited* variant: ordinary
        // dials are capped per client id (30/min) while emergency calls are always
        // exempt (docs/telephony.md §5); auto-connect keeps the desktop demo operable.
        .add_service(amos_telephony::service::demo_server_limited(30))
        // Device-sensor service (crates/amos-sensor + docs/sensors.md). P1 backend
        // is the in-process mock; a real Android HAL provider is swapped in later
        // (feature `android`) without changing the mount point.
        .add_service(amos_sensor::service::mock_server())
        // Resource-governor service (crates/amos-ai governor_service + proto
        // governor.proto): lets a System UI / per-app host register apps & jobs and
        // move apps through their lifecycle, driving the SAME shared governor the
        // periodic beat ticks (docs/device-bring-up.md §4).
        .add_service(crate::governor_service::server(Arc::clone(&governor)))
        .serve_with_incoming(incoming);

    tokio::select! {
        result = server => { result?; }
        _ = shutdown_signal() => {
            tracing::info!("shutdown signal received");
        }
    }
    heartbeat.abort();
    profile_beat.abort();
    energy_beat.abort();
    governor_beat.abort();

    // Persist sessions (if `AMOS_SESSIONS_PATH` is set) before exiting.
    if let Some(p) = &sessions_path {
        if let Err(e) = sessions.save(p).await {
            tracing::warn!("failed to persist sessions: {e}");
        }
    }

    // Remove the socket file so a stale one never blocks the next bind.
    let _ = std::fs::remove_file(&path);
    Ok(())
}

/// Resolve the periodic health-metrics interval: `AMOS_METRICS_INTERVAL_SECS`
/// (≥1s) or a 60s default.
fn metrics_interval() -> Duration {
    let secs = std::env::var("AMOS_METRICS_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|s| *s >= 1)
        .unwrap_or(60);
    Duration::from_secs(secs)
}

/// Parse an optional bool env var for the governor beat (`1`/`true`/`yes`); an
/// unset or garbage value is treated as `false`.
fn env_governor_flag(key: &str) -> bool {
    matches!(
        std::env::var(key)
            .ok()
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Resolves on SIGINT, SIGTERM, or Ctrl-C so the daemon can exit cleanly.
/// Registering the Unix handlers is best-effort: failing to install one must
/// never panic the daemon (P0-1) — we degrade to whatever is available, and
/// Ctrl-C always is.
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let term = match signal(SignalKind::terminate()) {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!(
                "SIGTERM handler unavailable ({e}); supervisor stop falls back to SIGINT"
            );
            None
        }
    };
    let int = match signal(SignalKind::interrupt()) {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!("SIGINT handler unavailable ({e}); relying on Ctrl-C");
            None
        }
    };
    // A handler that could not be installed is awaited as pending (never fires),
    // so the other branches still decide the outcome.
    let wait = |mut s: Option<tokio::signal::unix::Signal>| async move {
        match s.as_mut() {
            Some(sig) => {
                sig.recv().await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = wait(term) => {}
        _ = wait(int) => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::RateLimitConfig;
    use std::sync::Arc;
    use tokio_stream::StreamExt as _;

    /// Build a `stream_chat` request tagged with the given client id.
    fn stream_req(client: &str, sid: &str) -> Request<AgentRequest> {
        let mut r = Request::new(AgentRequest {
            session_id: sid.to_string(),
            prompt: "hello".to_string(),
            context: Default::default(),
        });
        r.metadata_mut()
            .insert(CLIENT_ID_HEADER, client.parse().unwrap());
        r
    }

    #[test]
    fn ollama_auto_model_skips_embedding_models() {
        // Chat models are selected for auto-resolution...
        assert!(is_chat_model("qwen2.5"));
        assert!(is_chat_model("gemma4-4b:latest"));
        assert!(is_chat_model("llama3-latest"));
        assert!(is_chat_model("Qwen3-8B"));
        // ...embedding/text models (which cannot do /v1 chat) are never chosen.
        assert!(!is_chat_model("nomic-embed-text-latest"));
        assert!(!is_chat_model("bge-embedding-v1"));
        assert!(!is_chat_model("  "), "blank is not a model");
        // ...nor stray ad-hoc test/junk entries left in /api/tags.
        assert!(!is_chat_model("cli-smoke-bad-mf-1786097807099608000"));
        assert!(!is_chat_model("CLI-SMOKE-000"));
        assert!(!is_chat_model("bad-mf-12345"));
    }

    #[test]
    fn real_backend_kinds_are_detected() {
        for real in ["api", "ollama", "hermes", "ggml"] {
            assert!(is_real_backend(real), "{real} is a real backend");
        }
        for dev in ["mock", "", "unknown"] {
            assert!(!is_real_backend(dev), "{dev:?} is not a real backend");
        }
    }

    #[tokio::test]
    async fn status_reports_engine_and_degradation_honestly() {
        // Default build boots with the deterministic mock engine; it must be
        // reported as such (not as a real model), and never "degraded" (mock was
        // the default, not a fallback). The ASR label reflects the env and may be
        // any of its valid values.
        let svc = AiAgentService::new().await;
        let reply = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("get_status")
            .into_inner();
        assert!(reply.running);
        assert_eq!(reply.engine, "mock", "mock backend reports itself as mock");
        assert!(!reply.engine_model.is_empty(), "mock still names its model");
        assert!(!reply.degraded, "mock-as-default is not a degradation");
        assert!(
            matches!(
                reply.asr.as_str(),
                "mock" | "sherpa" | "sherpa(auto)" | "off"
            ),
            "asr label is one of the known values (got {:?})",
            reply.asr
        );
        assert!(
            reply.accelerator.is_empty(),
            "a mock serving reports no local-accelerator target (got {:?})",
            reply.accelerator
        );
    }

    #[test]
    fn accelerator_label_only_for_local_ggml() {
        // Only the local GGML engine applies amos_ai::accelerator offload, so it
        // alone reports a label; mock/api/ollama/hermes have no local offload.
        assert!(accel_label_for_active("ggml").is_some());
        for remote in ["mock", "api", "ollama", "hermes", ""] {
            assert!(
                accel_label_for_active(remote).is_none(),
                "'{remote}' must not claim a local accelerator"
            );
        }
        // The label is the concrete "<vendor>/<accel>" resolution, never "auto".
        let l = accel_label_for_active("ggml").expect("ggml reports an accelerator");
        assert!(
            !l.contains("auto"),
            "accelerator label is concrete, not auto: {l}"
        );
        assert!(
            l.contains('/'),
            "accelerator label is vendor/accel shaped: {l}"
        );
    }

    #[tokio::test]
    async fn session_counter_round_trips() {
        let svc = AiAgentService::new().await;
        assert_eq!(svc.active_sessions.load(Ordering::SeqCst), 0);
        svc.active_sessions.fetch_add(1, Ordering::SeqCst);
        assert_eq!(svc.active_sessions.load(Ordering::SeqCst), 1);
        svc.active_sessions.fetch_sub(1, Ordering::SeqCst);
        assert_eq!(svc.active_sessions.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn status_reports_running_and_model() {
        let svc = AiAgentService::new().await;
        let reply = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        assert!(reply.running);
        assert!(!reply.model.is_empty());
        assert_eq!(reply.active_sessions, 0);
    }

    #[tokio::test]
    async fn list_sessions_reports_seeded_sessions() {
        let svc = AiAgentService::new().await;
        let _a = svc.sessions.create("model-m".to_string()).await;
        let _b = svc.sessions.create("model-m".to_string()).await;
        let reply = svc
            .list_sessions(Request::new(ListSessionsRequest {}))
            .await
            .expect("list_sessions")
            .into_inner();
        assert_eq!(reply.count, 2);
        assert_eq!(reply.sessions.len(), 2);
        assert!(reply.sessions.iter().all(|s| s.model == "model-m"));
        // Distinct sessions carry distinct ids.
        let ids = reply
            .sessions
            .iter()
            .map(|s| s.session_id.clone())
            .collect::<Vec<_>>();
        assert_ne!(ids[0], ids[1]);
    }

    #[tokio::test]
    async fn list_sessions_is_ordered_by_recent_activity() {
        let svc = AiAgentService::new().await;
        let _older = svc.sessions.create("model-m".to_string()).await;
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let newer = svc.sessions.create("model-m".to_string()).await;
        let reply = svc
            .list_sessions(Request::new(ListSessionsRequest {}))
            .await
            .expect("list_sessions")
            .into_inner();
        assert_eq!(reply.sessions.len(), 2);
        // The later-created session is the most recently active -> listed first.
        assert_eq!(reply.sessions[0].session_id, newer);
    }

    #[tokio::test]
    async fn clear_sessions_removes_all_tracked() {
        let svc = AiAgentService::new().await;
        let _a = svc.sessions.create("model-m".to_string()).await;
        let _b = svc.sessions.create("model-m".to_string()).await;
        let reply = svc
            .clear_sessions(Request::new(ClearSessionsRequest {}))
            .await
            .expect("clear_sessions")
            .into_inner();
        assert_eq!(reply.removed, 2);
        assert_eq!(svc.sessions.count_active().await, 0);
    }

    #[tokio::test]
    async fn remove_session_deletes_one_and_reports_missing() {
        let svc = AiAgentService::new().await;
        let a = svc.sessions.create("model-m".to_string()).await;
        let b = svc.sessions.create("model-m".to_string()).await;
        let removed = svc
            .remove_session(Request::new(RemoveSessionRequest {
                session_id: a.clone(),
            }))
            .await
            .expect("remove_session")
            .into_inner();
        assert!(removed.removed);
        assert_eq!(svc.sessions.count_active().await, 1);
        // second session still there, and the removed one is gone
        assert!(svc.sessions.get(&b).await.is_some());
        assert!(svc.sessions.get(&a).await.is_none());
        // removing an unknown id reports removed=false (no error)
        let missing = svc
            .remove_session(Request::new(RemoveSessionRequest {
                session_id: "nope".to_string(),
            }))
            .await
            .expect("remove_session missing")
            .into_inner();
        assert!(!missing.removed);
    }

    #[tokio::test]
    async fn get_history_returns_completed_turns() {
        let svc = AiAgentService::new().await;
        let id = svc.sessions.create("model-m".to_string()).await;
        svc.sessions
            .update(&id, |s| {
                s.append_turn("user".to_string(), "hi".to_string());
                s.append_turn("assistant".to_string(), "hello!".to_string());
            })
            .await
            .unwrap();
        let reply = svc
            .get_history(Request::new(GetHistoryRequest {
                session_id: id.clone(),
            }))
            .await
            .expect("get_history")
            .into_inner();
        assert_eq!(reply.session_id, id);
        assert_eq!(reply.turns.len(), 2);
        assert_eq!(reply.turns[0].role, "user");
        assert_eq!(reply.turns[1].text, "hello!");
    }

    #[tokio::test]
    async fn get_history_unknown_session_is_not_found() {
        let svc = AiAgentService::new().await;
        let err = svc
            .get_history(Request::new(GetHistoryRequest {
                session_id: "nope".to_string(),
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::NotFound);
    }

    #[tokio::test]
    async fn stream_chat_is_audited_and_rate_limited() {
        // Tight limit (1 request/sec) so the second call in the same second is
        // rejected, while the first writes a validation + completion audit trail.
        let config = RateLimitConfig {
            requests_per_second: 1,
            ..Default::default()
        };
        let security = Arc::new(SecurityManager::new(config));
        security
            .permission_manager
            .grant("client-a".to_string(), Permission::Standard)
            .await;
        let svc = AiAgentService::with_security(security);

        // 1) A permitted, within-limit request succeeds and is streamed.
        assert!(
            svc.stream_chat(stream_req("client-a", "s1")).await.is_ok(),
            "first request within limit should succeed"
        );

        // 2) The second request in the same second hits the per-second quota.
        let err = svc
            .stream_chat(stream_req("client-a", "s2"))
            .await
            .unwrap_err();
        assert_eq!(
            err.code(),
            tonic::Code::ResourceExhausted,
            "over-quota request must be rejected with ResourceExhausted"
        );

        // 3) Audit log recorded both the validation and the rejection.
        let entries = svc.security.audit_logger.get_recent(20).await;
        assert!(
            entries.iter().any(|e| e.operation == "infer"
                && e.result == AuditResult::Success
                && e.client_id == "client-a"),
            "a successful request validation must be audited"
        );
        assert!(
            entries.iter().any(|e| e.operation == "infer"
                && e.result == AuditResult::Rejected
                && e.details.contains("rate limit")),
            "the rejected request must be audited as rate-limited"
        );
    }

    #[tokio::test]
    async fn unknown_client_is_rejected() {
        // A fresh SecurityManager grants nothing, so any caller is denied.
        let security = Arc::new(SecurityManager::default());
        let svc = AiAgentService::with_security(security);

        let err = svc
            .stream_chat(stream_req("intruder", "s1"))
            .await
            .unwrap_err();
        assert_eq!(
            err.code(),
            tonic::Code::ResourceExhausted,
            "unauthenticated caller must be rejected"
        );

        let entries = svc.security.audit_logger.get_recent(10).await;
        assert!(
            entries
                .iter()
                .any(|e| e.client_id == "intruder" && e.result == AuditResult::Rejected),
            "the denial must be audited against the caller"
        );
    }

    #[tokio::test]
    async fn stream_completion_logs_tokens() {
        let svc = AiAgentService::new().await; // grants Standard to the default client
        let mut stream = svc
            .stream_chat(stream_req(DEFAULT_CLIENT_ID, "s1"))
            .await
            .unwrap()
            .into_inner();

        // Drain the token stream; the completion audit entry is written after the
        // terminal `done` frame, so drive it to completion first.
        let mut saw_done = false;
        while let Some(chunk) = stream.next().await {
            if let Ok(c) = chunk {
                if c.done {
                    saw_done = true;
                    break;
                }
            }
        }
        assert!(saw_done, "stream should terminate with a done frame");

        // Then poll briefly for the completion audit entry (logged just after the
        // terminal frame by the streaming task).
        let mut logged = false;
        for _ in 0..50 {
            let entries = svc.security.audit_logger.get_recent(20).await;
            if entries.iter().any(|e| {
                e.operation == "stream_chat"
                    && e.result == AuditResult::Success
                    && e.details.contains("tokens streamed")
            }) {
                logged = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(logged, "a completed stream must log its token count");
    }

    #[tokio::test]
    async fn stream_chat_tracks_and_persists_session() {
        let security = Arc::new(SecurityManager::default());
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        let sessions = Arc::new(SessionManager::default());
        let path = std::env::temp_dir().join(format!("amos-svc-sess-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let svc = AiAgentService::with_security(security)
            .with_sessions(sessions.clone(), Some(path.clone()));

        let mut stream = svc
            .stream_chat(stream_req(DEFAULT_CLIENT_ID, "s1"))
            .await
            .unwrap()
            .into_inner();
        while let Some(chunk) = stream.next().await {
            if let Ok(c) = chunk {
                if c.done {
                    break;
                }
            }
        }

        assert_eq!(
            sessions.count_active().await,
            1,
            "one session tracked per stream"
        );
        // The token update is written just after the terminal frame; poll briefly.
        let mut got_tokens = false;
        for _ in 0..50 {
            let list = sessions.list_active().await;
            if list.iter().any(|s| s.tokens_generated > 0) {
                got_tokens = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(got_tokens, "token usage recorded in the session");

        svc.save_sessions().await;
        assert!(path.exists(), "sessions persisted to disk on shutdown");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn governor_metrics_reflects_shared_governor_decision() {
        use crate::governor::ResourceGovernor;
        use amos_power::{BatteryState, Telemetry, Usage};

        let mut svc = AiAgentService::with_security_and_backend(
            Arc::new(SecurityManager::default()),
            Arc::new(MockBackend::new()),
        );
        let gov = Arc::new(std::sync::Mutex::new(ResourceGovernor::default()));
        svc.set_governor(Arc::clone(&gov));

        // Pending baseline before any tick.
        let before = svc.governor_metrics();
        assert_eq!(before.reason, "pending");
        assert_eq!(before.ticks, 0);

        // A low-battery observe on the shared governor surfaces as power_save.
        gov.lock().unwrap().observe(
            1,
            Telemetry::new(BatteryState::on_battery(15.0), Usage::default(), None),
            false,
            false,
        );
        let after = svc.governor_metrics();
        assert_eq!(after.sensor_mode, "power_save");
        assert!(after.throttle_background);
        assert!(after.ticks >= 1);
    }
}
