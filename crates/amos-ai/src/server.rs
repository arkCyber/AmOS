//! gRPC service implementation served over a Unix Domain Socket.

use std::collections::HashMap;
use std::path::Path;
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
use crate::governor::{parse_kinds_env, DvfsDriver, ResourceGovernor};
use crate::inference::real::{BackendKind, InferenceBackend, MockBackend, OllamaBackend};
use crate::monitoring::Monitor;
use crate::pool::GenerationPool;
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
    /// Daemon-wide bound on concurrent in-flight generations — the enforcement
    /// half of `Config::max_concurrent_sessions` / `AMOS_MAX_SESSIONS`, which
    /// existed and was validated but was never wired into the serving path.
    generation_pool: Arc<GenerationPool>,
    /// How long a generation may wait for a pool slot before an honest
    /// rejection (`AMOS_GEN_POOL_WAIT_MS`; zero = fail-fast, the default).
    pool_wait: Duration,
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
    /// The optional resident DVFS driver (discovered from `AMOS_CPUFREQ_ROOT`);
    /// `get_status` reports its applied/failed write counters.
    dvfs: Option<Arc<std::sync::Mutex<DvfsDriver>>>,
    /// OS system working-status sampler (CPU/memory, amos-monitor). Sampled on
    /// each `get_status` (advancing the busy% delta baseline) and folded into
    /// `StatusReply.system`. Real `/proc` on Linux/Android; honest "unknown" where
    /// `/proc` is absent (e.g. macOS dev) — never a fabricated reading.
    system_sampler: Arc<dyn amos_monitor::SystemSampler>,
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
        // Snapshot the wrapped-to-be backend name BEFORE optional cache
        // decoration, so EngineState still matches the real engine kind.
        let inner_engine_name = backend.metadata().name;
        // Opt-in response cache (`AMOS_RESPONSE_CACHE=1`): identical
        // (model, prompt, context, max_tokens) generations replay from a
        // bounded LRU+TTL cache. Default OFF — caching changes observable
        // latency (a hit has near-zero TTFT), so it must be a deliberate
        // operator choice; `get_status` shows it via the `+cache` name.
        let backend: Arc<dyn InferenceBackend> = if std::env::var("AMOS_RESPONSE_CACHE")
            .is_ok_and(|v| v == "1" || v.to_lowercase() == "true")
        {
            Arc::new(crate::cache::CachingBackend::new(
                backend,
                Arc::new(crate::cache::ResponseCache::with_defaults()),
            ))
        } else {
            backend
        };
        // Daemon-wide generation gate (REQ-A43): `AMOS_MAX_SESSIONS` finally
        // enforced; bounded wait defaults to fail-fast (deterministic).
        let generation_pool = Arc::new(GenerationPool::from_env());
        let pool_wait = std::env::var("AMOS_GEN_POOL_WAIT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or(Duration::ZERO);
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
        let engine = EngineState::from_env(&inner_engine_name);
        Self {
            model: "amos-infer@0.1.0",
            active_sessions: Arc::new(AtomicUsize::new(0)),
            security: Arc::new(security),
            backend,
            generation_pool,
            pool_wait,
            engine,
            sessions,
            sessions_path,
            monitor: Arc::new(Monitor::new()),
            profile: Arc::new(ProfileStore::new()),
            energy: Arc::new(EnergyStore::new()),
            governor: None,
            dvfs: None,
            system_sampler: default_system_sampler(),
        }
    }

    /// Build a service around a caller-provided security manager, using the
    /// mock backend (used by tests to tighten rate limits / revoke access).
    pub fn with_security(security: Arc<SecurityManager>) -> Self {
        Self::with_security_and_backend(security, Arc::new(MockBackend::new()))
    }

    /// Build a service with an explicit security manager and inference backend.
    /// Uses the default generation gate (16 slots, fail-fast).
    pub fn with_security_and_backend(
        security: Arc<SecurityManager>,
        backend: Arc<dyn InferenceBackend>,
    ) -> Self {
        Self {
            model: "amos-infer@0.1.0",
            active_sessions: Arc::new(AtomicUsize::new(0)),
            security,
            backend,
            generation_pool: Arc::new(GenerationPool::from_env()),
            pool_wait: Duration::ZERO,
            engine: EngineState::non_degraded(),
            sessions: Arc::new(SessionManager::default()),
            sessions_path: None,
            monitor: Arc::new(Monitor::new()),
            profile: Arc::new(ProfileStore::new()),
            energy: Arc::new(EnergyStore::new()),
            governor: None,
            dvfs: None,
            system_sampler: default_system_sampler(),
        }
    }

    /// Build a service with an explicit security manager, backend, and
    /// generation gate (used by tests to shrink the pool / shape the wait).
    pub fn with_generation_gate(
        security: Arc<SecurityManager>,
        backend: Arc<dyn InferenceBackend>,
        generation_pool: Arc<GenerationPool>,
        pool_wait: Duration,
    ) -> Self {
        let mut svc = Self::with_security_and_backend(security, backend);
        svc.generation_pool = generation_pool;
        svc.pool_wait = pool_wait;
        svc
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

    /// Shared handle to the OS system-load sampler (real `/proc` on Linux/Android;
    /// honest "unknown" elsewhere). Shared so `get_status` and the periodic system
    /// heartbeat advance the same busy% delta baseline.
    pub fn system_sampler(&self) -> Arc<dyn amos_monitor::SystemSampler> {
        Arc::clone(&self.system_sampler)
    }

    /// Attach the daemon's shared resource-governor closed loop so `get_status`
    /// reports its live decision (called by `serve()`).
    pub fn set_governor(&mut self, governor: Arc<std::sync::Mutex<ResourceGovernor>>) {
        self.governor = Some(governor);
    }

    /// Attach the optional shared DVFS driver so `get_status` can report its
    /// applied/failed write counters (called by `serve()`; absent on hosts with no
    /// `AMOS_CPUFREQ_ROOT`).
    pub fn set_dvfs(&mut self, dvfs: Option<Arc<std::sync::Mutex<DvfsDriver>>>) {
        self.dvfs = dvfs;
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
        // DVFS write counters (0 when no DVFS beat is active).
        let (dvfs_applied, dvfs_failed) = match &self.dvfs {
            Some(d) => {
                let d = d.lock().unwrap_or_else(|p| p.into_inner());
                (d.applied_total(), d.failed_total())
            }
            None => (0, 0),
        };
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
                        dvfs_applied,
                        dvfs_failed,
                        dropped: o.dropped.len() as u64,
                    },
                    None => GovernorMetrics {
                        sensor_mode: "balanced".to_string(),
                        reason: "pending".to_string(),
                        cap_inference: false,
                        throttle_background: false,
                        ticks: 0,
                        dvfs_applied,
                        dvfs_failed,
                        dropped: 0,
                    },
                }
            }
            None => GovernorMetrics {
                sensor_mode: "balanced".to_string(),
                reason: "pending".to_string(),
                cap_inference: false,
                throttle_background: false,
                ticks: 0,
                dvfs_applied,
                dvfs_failed,
                dropped: 0,
            },
        }
    }

    /// Fold the OS system working status into the wire `SystemHealth` (amos-monitor).
    ///
    /// Samples the system sampler (advancing its busy% delta baseline so the next
    /// read reports a real window), folds the shared governor's registered app
    /// lifecycle into per-tier process counts, and reports battery honestly as
    /// "unknown" here (battery/thermal/power live on the energy-governor block
    /// above, which this block must not duplicate). Absent optionals = unknown.
    fn system_metrics(&self) -> amos_proto::ai_agent::SystemHealth {
        // Shared fold (sampler load + energy battery + governor counts) that the
        // periodic system heartbeat also logs, so both tell one consistent story.
        let h = fold_system_health(
            self.system_sampler.as_ref(),
            self.energy.snapshot(),
            self.governor.as_ref().map(|g| g.as_ref()),
        );
        let l = &h.load;
        amos_proto::ai_agent::SystemHealth {
            load: Some(amos_proto::ai_agent::SystemLoad {
                cpu_busy_pct: l.cpu.busy_pct,
                mem_total_bytes: l.memory.total_bytes,
                mem_available_bytes: l.memory.available_bytes,
            }),
            battery: Some(amos_proto::ai_agent::SystemBattery {
                level_pct: h.battery.level_pct,
                charging: h.battery.charging,
                live_power_mw: h.battery.live_power_mw,
            }),
            processes: Some(amos_proto::ai_agent::ProcessCounts {
                running: h.processes.running as u32,
                cached: h.processes.cached as u32,
                stopped: h.processes.stopped as u32,
            }),
            sampler: self.system_sampler.name().to_string(),
            apps: self.governor_apps(),
        }
    }

    /// The governor's tracked apps as (id, lifecycle-key) pairs for the Task-Manager
    /// listing (empty when nothing is registered).
    fn governor_apps(&self) -> Vec<amos_proto::ai_agent::AppProcess> {
        match &self.governor {
            Some(g) => {
                let g = g.lock().unwrap_or_else(|p| p.into_inner());
                g.app_entries()
                    .into_iter()
                    .map(|(id, state)| amos_proto::ai_agent::AppProcess {
                        id: id.0,
                        state: state.key().to_string(),
                    })
                    .collect()
            }
            None => Vec::new(),
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
    matches!(
        kind,
        "api" | "ollama" | "hermes" | "ggml" | "anthropic" | "gemini"
    )
}

/// Trim + parse a non-negative integer; `None` for empty / malformed input.
fn parse_trimmed_u32(s: &str) -> Option<u32> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        t.parse::<u32>().ok()
    }
}

/// Split a comma-separated list of sysfs node paths, trimming + dropping empties.
/// Malformed members are simply dropped so a bad value never takes the daemon down.
fn parse_node_paths(s: &str) -> Vec<std::path::PathBuf> {
    s.split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(std::path::PathBuf::from)
        .collect()
}

/// Read an optional non-negative integer from the environment (trimmed); `None`
/// for unset/empty/unparseable so a bad value never takes the daemon down.
pub fn opt_env_u32(key: &str) -> Option<u32> {
    std::env::var(key).ok().and_then(|v| parse_trimmed_u32(&v))
}

/// Build the daemon's system-load sampler (real `/proc` on Linux/Android) and
/// take one warm read so a subsequent `get_status` has a busy% delta baseline
/// instead of reporting "unknown" on its first probe. On hosts without `/proc`
/// (e.g. macOS dev) reads are honest "unknown".
fn default_system_sampler() -> Arc<dyn amos_monitor::SystemSampler> {
    let sampler: Arc<dyn amos_monitor::SystemSampler> =
        Arc::new(amos_monitor::LinuxSystemSampler::new());
    let _ = sampler.snapshot();
    sampler
}

/// Fold the OS system working status (sampler load + energy-governor battery +
/// governor app counts) into the crate-level [`amos_monitor::SystemHealth`]. Shared
/// by `get_status` (proto mapping) and the periodic system heartbeat so both tell
/// the same story from one fold. Absent values are honest "unknown".
fn fold_system_health(
    sampler: &dyn amos_monitor::SystemSampler,
    energy: EnergySnapshot,
    governor: Option<&std::sync::Mutex<ResourceGovernor>>,
) -> amos_monitor::SystemHealth {
    use amos_applife::AppState;
    let load = sampler.snapshot();
    let mut processes = amos_monitor::ProcessSummary::default();
    if let Some(g) = governor {
        let g = g.lock().unwrap_or_else(|p| p.into_inner());
        for (_, state) in g.app_entries() {
            match state {
                AppState::Cached => processes.cached += 1,
                AppState::Stopped => processes.stopped += 1,
                _ => processes.running += 1,
            }
        }
    }
    // Charging is only reported once the energy governor has actually ticked (before
    // that it is the "pending" baseline — unknown, never fabricated).
    let charging = if energy.ticks > 0 {
        Some(energy.charging)
    } else {
        None
    };
    amos_monitor::SystemHealth {
        load,
        battery: amos_monitor::BatteryStatus {
            level_pct: energy.level_pct,
            charging,
            live_power_mw: energy.power_mw,
        },
        processes,
    }
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
///   AMOS_BACKEND = "mock" | "api" | "ollama" | "hermes" | "ggml"
///                 | "anthropic" | "gemini"                     (default "mock")
///   AMOS_MODEL_PATH                                       (ggml)
///   AMOS_API_KEY / AMOS_API_ENDPOINT / AMOS_MODEL         (api, anthropic, gemini)
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
        // Claude (Anthropic Messages, native protocol). Endpoint defaults to the
        // official API; model + key come from AMOS_MODEL / AMOS_API_KEY.
        "anthropic" => BackendKind::Anthropic {
            api_key: std::env::var("AMOS_API_KEY").unwrap_or_default(),
            endpoint: std::env::var("AMOS_API_ENDPOINT")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://api.anthropic.com/v1/messages".into()),
            model: std::env::var("AMOS_MODEL")
                .unwrap_or_else(|_| "claude-3-5-sonnet-latest".into()),
        },
        // Google Gemini native REST. AMOS_API_ENDPOINT (optional) is the v1beta
        // base URL the model id is appended to.
        "gemini" => BackendKind::Gemini {
            api_key: std::env::var("AMOS_API_KEY").unwrap_or_default(),
            base: std::env::var("AMOS_API_ENDPOINT")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".into()),
            model: std::env::var("AMOS_MODEL").unwrap_or_else(|_| "gemini-2.0-flash".into()),
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
            if matches!(
                kind.as_str(),
                "api" | "ollama" | "hermes" | "ggml" | "anthropic" | "gemini"
            ) {
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

        // Daemon-wide generation admission (REQ-A43): acquire a slot BEFORE any
        // session/bookkeeping is created — a rejected request must not allocate
        // resources. The permit is moved into the streaming task below and is
        // released on drop on every exit path (client disconnect, error, done).
        let gate_permit = match self.generation_pool.acquire(self.pool_wait).await {
            Ok(p) => p,
            Err(e) => {
                let reason = e.reason();
                tracing::warn!(client = %client_id, "stream_chat rejected: {reason}");
                self.security
                    .audit_logger
                    .log(
                        client_id.clone(),
                        "stream_chat".to_string(),
                        "inference".to_string(),
                        AuditResult::Rejected,
                        reason.clone(),
                    )
                    .await;
                return Err(Status::resource_exhausted(format!(
                    "generation gate: {reason}"
                )));
            }
        };

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
            // Hold the generation-gate permit for the whole task: dropping it on
            // any exit path (card path, client disconnect, inference error, or
            // normal completion) releases the daemon-wide slot exactly once.
            let _gate = gate_permit;
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
        // Generation-gate handle for per-turn admission inside the Prompt arm.
        let pool = self.generation_pool.clone();
        let pool_wait = self.pool_wait;
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
                        // Per-turn daemon-wide admission (REQ-A43): one slot per
                        // executing bidi turn. A saturated gate answers this turn
                        // with an honest error chunk + audit and keeps the
                        // connection alive (the user may retry).
                        let _gate = match pool.acquire(pool_wait).await {
                            Ok(p) => p,
                            Err(e) => {
                                let reason = e.reason();
                                let _ = tx
                                    .send(Ok(AgentChunk {
                                        session_id: String::new(),
                                        token: String::new(),
                                        done: true,
                                        error: format!("generation gate: {reason}"),
                                        card: None,
                                    }))
                                    .await;
                                security
                                    .audit_logger
                                    .log(
                                        client_id.clone(),
                                        "chat".to_string(),
                                        "inference".to_string(),
                                        AuditResult::Rejected,
                                        reason,
                                    )
                                    .await;
                                continue;
                            }
                        };
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
            system: Some(self.system_metrics()),
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

/// Resolve an optional TCP listen address from `AMOS_TCP_ADDR` (e.g. `127.0.0.1:8787`).
///
/// When set, the daemon serves the same gRPC stack over **loopback TCP** instead of
/// a Unix socket. This is the "host-target split" transport used for on-device lab
/// bring-up on a *retail* (non-root, SELinux-enforcing) Android: a `shell` process
/// there cannot create a Unix socket file (`avc: denied … tclass=sock_file`), but it
/// can bind loopback TCP — so the daemon can run with no root, and a System UI on the
/// same device (or on the host, via `adb forward`) reaches it over TCP.
fn resolve_tcp_addr() -> Option<std::net::SocketAddr> {
    let raw = std::env::var("AMOS_TCP_ADDR").ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    raw.parse().ok()
}

/// Run the tonic gRPC stack until a shutdown signal arrives.
///
/// Transport: if `AMOS_TCP_ADDR` is set we serve over loopback TCP (see
/// [`resolve_tcp_addr`]); otherwise we bind the Unix socket at `path`, harden it to
/// `0700`, and clean it up on shutdown.
pub async fn serve(path: std::path::PathBuf) -> anyhow::Result<()> {
    let tcp_addr = resolve_tcp_addr();

    // Bind the Unix socket only in the UDS transport. In TCP mode a shell process on
    // a retail Android device cannot create a socket file under SELinux, so we skip
    // binding entirely (loopback TCP needs no root).
    let incoming: Option<UnixListenerStream> = if tcp_addr.is_some() {
        None
    } else {
        let listener = tokio::net::UnixListener::bind(&path)?;

        // Restrict access: only the owning OS user may connect to the daemon.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                .context("failed to harden socket permissions")?;
        }

        Some(UnixListenerStream::new(listener))
    };
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
    // Android-compat container runtime + LMK-proxy + host bridge. We keep the
    // SAME instances here for (a) the AndroidManager service mount below and (b)
    // the governor beat, which drives container decisions BACK into the proxy /
    // real force-stop (reverse half of the bridge, docs/lmk-proxy.md §8). The
    // host bridge also records which apps it adopted so the beat only touches
    // real container apps, not host-native ones.
    let android_runtime = amos_android::auto();
    let android_proxy: Arc<std::sync::Mutex<amos_android::lmk::LmkProxy>> =
        Arc::new(std::sync::Mutex::new(amos_android::lmk::LmkProxy::new()));
    let android_manager: Arc<amos_android::manager::EnhancedAndroidManager> = Arc::new(
        amos_android::manager::EnhancedAndroidManager::new(android_runtime),
    );
    let android_host: Arc<crate::governor_service::GovernorLmkHost> = Arc::new(
        crate::governor_service::GovernorLmkHost::new(Arc::clone(&governor)),
    );
    let android_host_dyn: Arc<dyn amos_android::lmk::LmkHost> = android_host.clone();
    // One shared `WatchLmk` broadcast: the AndroidManager service emits the
    // System-UI-visible decisions (TriggerLmk / ApplyHostDecision / OnActivity)
    // and the governor beat feeds host-driven reclaims through the same fan-out.
    let lmk_events: tokio::sync::broadcast::Sender<amos_proto::android_compat::LmkEvent> =
        tokio::sync::broadcast::channel(128).0;
    // Optional resident DVFS beat: when `AMOS_CPUFREQ_ROOT` points at a Linux
    // cpufreq sysfs tree (device bring-up), discover the CPU domains once and each
    // beat apply the frequency plan the ResourceGovernor decision implies — only
    // when it changed. Inert on hosts without such a root (CI/desktop unchanged).
    let dvfs_root = std::env::var("AMOS_CPUFREQ_ROOT").ok();
    // Optional NPU hardware max (kHz): lets the governor's `freq_plan` emit NPU
    // ceilings (Balanced ~85% / PowerSave lower) on device; unset = no NPU cap.
    let npu_max_khz = opt_env_u32("AMOS_CPUFREQ_NPU_MAX_KHZ");
    // Optional NPU devfreq max-freq node(s) to actually write (comma-separated,
    // e.g. "/sys/class/devfreq/1d84000.npu/max_freq"). Empty = only compute plans.
    let npu_paths = std::env::var("AMOS_CPUFREQ_NPU_NODES")
        .ok()
        .map(|v| parse_node_paths(&v))
        .unwrap_or_default();
    let mut dvfs_driver = dvfs_root.as_deref().and_then(|r| {
        tracing::info!(
            root = %r,
            npu_max_khz,
            npu_nodes = npu_paths.len(),
            "amos-ai enabling resident DVFS beat"
        );
        DvfsDriver::from_cpufreq_root(Path::new(r), 64, npu_max_khz, npu_paths.clone())
    });
    // Device bring-up may override the kind heuristic with the real topology:
    // `AMOS_GOVERNOR_CPU_KINDS="0:Little,4:Big"` (kind case-insensitive).
    if let (Ok(kinds_env), Some(drv)) = (
        std::env::var("AMOS_GOVERNOR_CPU_KINDS"),
        dvfs_driver.as_mut(),
    ) {
        let kinds = parse_kinds_env(&kinds_env);
        if !kinds.is_empty() {
            tracing::info!(kinds = %kinds_env, "amos-ai dvfs kind override");
            drv.relabel_kinds(&kinds);
        }
    }
    // Share the driver between the beat (writes) and get_status (read counters).
    let dvfs: Option<Arc<std::sync::Mutex<DvfsDriver>>> =
        dvfs_driver.map(|d| Arc::new(std::sync::Mutex::new(d)));
    let governor_beat = {
        let dvfs_beat = dvfs.clone();
        let gov = Arc::clone(&governor);
        let ahost = Arc::clone(&android_host);
        let aproxy = Arc::clone(&android_proxy);
        let amanager = Arc::clone(&android_manager);
        let levents = lmk_events.clone();
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
                // Reverse half of the bridge: whatever the host governor decided
                // for a container-managed app, drive back into the container
                // (force-stop / freeze / thaw) so both registries stay coherent.
                crate::governor_service::drive_host_decisions(
                    &o, &ahost, &aproxy, &amanager, &levents,
                )
                .await;
                // Resident DVFS: apply the frequency plan implied by the latest
                // energy decision, only when the ceilings actually changed.
                if let Some(darc) = &dvfs_beat {
                    let plan = {
                        let drv = darc.lock().unwrap_or_else(|p| p.into_inner());
                        let g = gov.lock().unwrap_or_else(|p| p.into_inner());
                        g.freq_plan(drv.clusters(), drv.npu_max_khz())
                    };
                    if let Some(p) = plan {
                        let rep = {
                            let mut drv = darc.lock().unwrap_or_else(|p| p.into_inner());
                            drv.apply_if_changed(&p)
                        };
                        if let Some(rep) = rep {
                            if rep.is_clean() {
                                tracing::info!(
                                    mode = o.sensor_mode,
                                    applied = rep.applied,
                                    "amos-ai dvfs applied"
                                );
                            } else {
                                tracing::warn!(
                                    mode = o.sensor_mode,
                                    partial = %rep,
                                    "amos-ai dvfs partial"
                                );
                            }
                        }
                    }
                }
                let acted = !o.fired_alarms.is_empty()
                    || !o.ran_deferred.is_empty()
                    || !o.frozen.is_empty()
                    || !o.thawed.is_empty()
                    || !o.reclaimed.is_empty()
                    || !o.dropped.is_empty();
                if acted {
                    tracing::info!(
                        sensor_mode = o.sensor_mode,
                        reason = o.reason,
                        fired_alarms = o.fired_alarms.len(),
                        ran_deferred = o.ran_deferred.len(),
                        frozen = o.frozen.len(),
                        thawed = o.thawed.len(),
                        reclaimed = o.reclaimed.len(),
                        dropped = o.dropped.len(),
                        background_count = o.background_count,
                        "amos-ai resource governor acted"
                    );
                }
            }
        })
    };
    // Make get_status report the shared governor's live decision (same instance the
    // beat ticks and the Governor gRPC service mutates) + the DVFS write counters.
    ai_service.set_governor(Arc::clone(&governor));
    ai_service.set_dvfs(dvfs);
    let svc_monitor = Arc::clone(&monitor);

    // Periodic system working-status heartbeat: logs one `SystemHealth::summary()`
    // line on the same cadence as the other beats (CPU busy% is a delta, so a
    // periodic read keeps it meaningful; battery/process tiers fold the SAME shared
    // governor/energy the get_status path uses). Aborted on shutdown below.
    let sys_sampler = ai_service.system_sampler();
    let sys_energy = ai_service.energy();
    let sys_gov = Arc::clone(&governor);
    let sys_interval = interval.max(Duration::from_millis(100));
    let system_beat = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(sys_interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let health = fold_system_health(
                sys_sampler.as_ref(),
                sys_energy.snapshot(),
                Some(sys_gov.as_ref()),
            );
            tracing::info!(
                sampler = sys_sampler.name(),
                "amos-ai system working status: {}",
                health.summary()
            );
        }
    });

    // LMK self-protection (base A): re-verify + self-heal `oom_score_adj` on the
    // same cadence as the other beats, so the "never reclaim this daemon by OOM
    // tier" property is *continuously assured* rather than assumed at boot. The
    // first tick fires immediately (boot-time verification); a drift is healed
    // and logged when privileged; a host with no oom control (desktop dev) is a
    // quiet trace-level no-op. See `life_guard` module + `docs/life-guard.md`.
    // Aborted on shutdown below.
    let life_guard = Arc::new(crate::life_guard::LifeGuard::new(
        crate::life_guard::PlatformProcFs::new(),
    ));
    let life_beat = life_guard.spawn_periodic(interval);

    // Shared telemetry-spy hit bus. The System UI's `Watch` subscribers consume
    // it; on a device (`telemetry-spy-audit`) the pnet capture producer feeds the
    // SAME instance (clone shares the broadcast), so a real NIC hit reaches Watch.
    // The test/demo injection RPC is off unless AMOS_SPY_ALLOW_INJECT is set.
    let telemetry_svc = crate::telemetry_spy_service::TelemetrySpySvc::new_with_inject(
        crate::telemetry_spy_service::injection_env_allowed(),
    );

    let server = tonic::transport::Server::builder()
        .add_service(AiAgentServer::with_interceptor(
            ai_service,
            move |req: tonic::Request<()>| {
                svc_monitor.record_rpc();
                Ok(req)
            },
        ))
        // Android-compat service whose LMK-proxy is bridged into the SAME shared
        // ResourceGovernor the periodic beat and the Governor gRPC service drive:
        // container Activity/Task importance and LMK kills are reflected up as
        // register_app/move_app/kill_app; the beat drives host decisions back
        // (reverse half). Built from the SAME proxy/manager/host instances the
        // beat uses (docs/lmk-proxy.md §2/§8).
        .add_service(
            amos_proto::android_compat::android_manager_server::AndroidManagerServer::new(
                amos_android::AndroidManagerService::with_parts_and_events(
                    Arc::clone(&android_manager),
                    Arc::clone(&android_proxy),
                    android_host_dyn.clone(),
                    lmk_events.clone(),
                ),
            ),
        )
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
        // OS-permissions service (proto privacy.proto): the daemon's authoritative
        // PrivacyManager — grant/revoke/ask/audit over the shared UDS. Persistence
        // (grants JSON + durable unified audit) is enabled by AMOS_PRIVACY_PATH;
        // unset ⇒ fresh deny-by-default, in-memory (docs/permissions-sandbox-audit-plan.md).
        .add_service({
            let (privacy, persist) = crate::privacy_service::bootstrap();
            crate::privacy_service::server(privacy, persist)
        })
        // Egress network-guard service (amos-network-guard + proto netguard.proto):
        // lets the System UI arm/disarm the userspace data-plane egress gate and read
        // a status + audit summary over the same UDS. P1 is policy intent on the
        // in-process Mock; real enforcement (VpnService / nftables) is a device/AOSP
        // step (docs/anti-telemetry-egress-guard.md §3.1/§3.4).
        .add_service(crate::netguard_service::server())
        // Passive telemetry-spy audit stream (crates/amos-telemetry-spy + proto
        // telemetry_spy.proto): lets the System UI subscribe (server-streaming Watch)
        // to high-severity egress hits. On this default host build no capture producer
        // feeds the service, so Watch yields nothing (never a fabricated hit); a real
        // pnet capture feed is started below under `telemetry-spy-audit`
        // (docs/telemetry-spy.md). The mounted instance is the SHARED bus the producer
        // feeds, so subscribers and producer see the same hits.
        .add_service(crate::telemetry_spy_service::server_for(
            telemetry_svc.clone(),
        ))
        // Offline local vector retrieval (proto ai_agent.proto, `service Rag`):
        // index note/document passages and retrieve the nearest ids to a query
        // over the same UDS, so Notes / System UI can "ask my files". Embedder
        // is mock (offline) unless AMOS_RAG_EMBEDDER=ollama (local Ollama) or
        // =api (cloud OpenAI-compatible /v1/embeddings) — see rag_service.rs.
        // "Retrieve-then-answer" is composed by the caller from Rag.Query +
        // AiAgent.StreamChat.
        .add_service(crate::rag_service::server(
            crate::rag_service::RagSvc::from_env()?,
        ));

    // (feature `telemetry-spy-audit`) Real-device capture producer: opens the data
    // interface named by AMOS_SPY_IFACE and feeds every decoded+scanned match into
    // the SAME TelemetrySpySvc mounted above, so a NIC hit reaches Watch -> System
    // UI. Quiet by default: the producer only starts when BOTH an interface and at
    // least one watch identifier (AMOS_SPY_IDS) are configured; a refused start is
    // logged, never a fabricated success. Needs raw-socket privilege (device/AOSP).
    #[cfg(feature = "telemetry-spy-audit")]
    let (spy_stop, spy_pump) = {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pump = crate::telemetry_spy_capture::spawn_configured(telemetry_svc, Arc::clone(&stop));
        (stop, pump)
    };

    // The transport decides how the fully-built tonic server consumes its connection
    // source: TCP (`.serve`) when `AMOS_TCP_ADDR` was set, else the Unix stream bound
    // above. Only one arm runs; in the other mode that resource was never created.
    match tcp_addr {
        Some(addr) => {
            tokio::select! {
                result = server.serve(addr) => { result?; }
                _ = shutdown_signal() => {
                    tracing::info!("shutdown signal received");
                }
            }
        }
        None => {
            if let Some(incoming) = incoming {
                tokio::select! {
                    result = server.serve_with_incoming(incoming) => { result?; }
                    _ = shutdown_signal() => {
                        tracing::info!("shutdown signal received");
                    }
                }
            }
        }
    }
    heartbeat.abort();
    profile_beat.abort();
    energy_beat.abort();
    governor_beat.abort();
    system_beat.abort();
    life_beat.abort();
    // Halt the on-device telemetry-spy capture: request the pnet loop stop and
    // abort the pump task (feature `telemetry-spy-audit` only).
    #[cfg(feature = "telemetry-spy-audit")]
    {
        crate::telemetry_spy_capture::stop_request(&spy_stop);
        if let Some(handle) = spy_pump {
            handle.abort();
        }
    }

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
        for real in ["api", "ollama", "hermes", "ggml", "anthropic", "gemini"] {
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
    async fn generation_gate_rejects_when_saturated_then_serves_after_release() {
        // Capacity 1, fail-fast: the second in-flight stream_chat must be
        // rejected honestly (ResourceExhausted + audited), must not allocate a
        // session, and the slot must be reusable once the first stream ends.
        let security = Arc::new(SecurityManager::default());
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        let pool = Arc::new(GenerationPool::try_new(1).unwrap());
        let svc = AiAgentService::with_generation_gate(
            security,
            Arc::new(MockBackend::new()),
            pool.clone(),
            Duration::ZERO,
        );

        // 1) The first request acquires the only slot and starts streaming.
        let mut stream1 = svc
            .stream_chat(stream_req(DEFAULT_CLIENT_ID, "s1"))
            .await
            .expect("first request passes the gate")
            .into_inner();
        assert_eq!(
            pool.in_flight().await,
            1,
            "the accepted request holds the single slot"
        );

        // 2) A second request while saturated: honest typed rejection, and no
        // session must be allocated for it (rejection precedes bookkeeping).
        let err = svc
            .stream_chat(stream_req(DEFAULT_CLIENT_ID, "s2"))
            .await
            .unwrap_err();
        assert_eq!(
            err.code(),
            tonic::Code::ResourceExhausted,
            "a saturated gate must surface ResourceExhausted"
        );
        assert!(
            err.message().contains("generation gate"),
            "the rejection reason must name the gate, got: {}",
            err.message()
        );
        assert_eq!(
            svc.sessions.count_active().await,
            1,
            "a gate-rejected request must not allocate a session"
        );
        assert_eq!(
            pool.counters(),
            (1, 1, 0),
            "one acquisition, one fail-fast rejection, zero timeouts"
        );

        // 3) Drain stream1 to completion; the permit is released on task end.
        while let Some(chunk) = stream1.next().await {
            if let Ok(c) = chunk {
                if c.done {
                    break;
                }
            }
        }
        for _ in 0..50 {
            if pool.in_flight().await == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            pool.in_flight().await,
            0,
            "the slot is released once the stream task ends"
        );

        // 4) A new request is served again on the released slot.
        assert!(
            svc.stream_chat(stream_req(DEFAULT_CLIENT_ID, "s3"))
                .await
                .is_ok(),
            "a released slot must be reusable"
        );

        // 5) The saturation was audited against the caller.
        let entries = svc.security.audit_logger.get_recent(20).await;
        assert!(
            entries.iter().any(|e| e.result == AuditResult::Rejected
                && e.details.contains("generation pool saturated")),
            "the gate rejection must be audited with its honest reason"
        );
    }

    #[tokio::test]
    async fn response_cache_replays_identical_prompts_when_enabled() {
        // With the cache decorator in the serving path, the second identical
        // (session, prompt, context, max_tokens) request is a cache hit: the
        // token sequence is replayed identically and the store saw exactly one
        // store + one hit (the backend itself is called only once).
        let security = Arc::new(SecurityManager::default());
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        let cache = Arc::new(crate::cache::ResponseCache::with_defaults());
        let backend = Arc::new(crate::cache::CachingBackend::new(
            Arc::new(MockBackend::new()),
            cache.clone(),
        ));
        let svc = AiAgentService::with_generation_gate(
            security,
            backend.clone(),
            Arc::new(GenerationPool::try_new(4).unwrap()),
            Duration::ZERO,
        );
        // Same client session id ⇒ same cache key (the session participates in
        // the key by design: identical conversations replay, divergent ones
        // never share).
        let mut s1 = svc
            .stream_chat(stream_req(DEFAULT_CLIENT_ID, "same"))
            .await
            .expect("first call")
            .into_inner();
        let mut toks1 = Vec::new();
        while let Some(chunk) = s1.next().await {
            if let Ok(c) = chunk {
                if c.done {
                    break;
                }
                toks1.push(c.token);
            }
        }
        let mut s2 = svc
            .stream_chat(stream_req(DEFAULT_CLIENT_ID, "same"))
            .await
            .expect("second call")
            .into_inner();
        let mut toks2 = Vec::new();
        while let Some(chunk) = s2.next().await {
            if let Ok(c) = chunk {
                if c.done {
                    break;
                }
                toks2.push(c.token);
            }
        }
        let s = cache.stats();
        assert_eq!(
            (s.stores, s.hits),
            (1, 1),
            "the second identical prompt must be a cache hit, not a new generation"
        );
        assert_eq!(
            toks1, toks2,
            "cache replay must be token-for-token identical"
        );
        assert!(
            backend.metadata().name.ends_with("+cache"),
            "get_status can see the cache via the backend name"
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
        assert_eq!(after.dropped, 0, "no deferred window expired in this tick");
    }

    #[test]
    fn governor_metrics_surfaces_expired_deferred_count() {
        use amos_power::{BatteryState, Telemetry, Usage};
        use amos_scheduler::{JobId, ScheduledJob};

        let mut svc = AiAgentService::with_security_and_backend(
            Arc::new(SecurityManager::default()),
            Arc::new(MockBackend::new()),
        );
        let gov = Arc::new(std::sync::Mutex::new(ResourceGovernor::default()));
        // A deferred job whose [0,3] window fully passes while PowerSave throttles it.
        gov.lock()
            .unwrap()
            .schedule(ScheduledJob::deferred(JobId::new("expired"), 0, 3).unwrap())
            .unwrap();
        svc.set_governor(Arc::clone(&gov));

        // now=50, low battery (PowerSave) → the expired deferred is dropped.
        gov.lock().unwrap().observe(
            50,
            Telemetry::new(BatteryState::on_battery(15.0), Usage::default(), None),
            false,
            false,
        );
        let m = svc.governor_metrics();
        assert_eq!(m.sensor_mode, "power_save");
        assert_eq!(m.dropped, 1, "expired deferred surfaced on the wire");
    }

    #[test]
    fn governor_metrics_reports_dvfs_write_counters() {
        use crate::governor::DvfsDriver;
        use amos_power::plan;
        use amos_sensor::SensorMode;
        use std::sync::atomic::{AtomicU64, Ordering};

        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("amos-ai-dvfs-status-{}-{seq}", std::process::id()));
        for (cpu, max) in [(0u32, 1_800_000u32), (4, 2_500_000u32)] {
            let dir = root.join(format!("cpu{cpu}/cpufreq"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("cpuinfo_max_freq"), format!("{max}\n")).unwrap();
            std::fs::write(dir.join("scaling_max_freq"), "999999\n").unwrap();
        }

        // One applied PowerSave plan over the discovered topology => 2 writes.
        let mut d = DvfsDriver::from_cpufreq_root(&root, 8, None, Vec::new()).unwrap();
        let ps = plan(SensorMode::PowerSave, d.clusters(), None);
        assert!(d.apply_if_changed(&ps).is_some());
        let shared = Arc::new(std::sync::Mutex::new(d));

        let mut svc = AiAgentService::with_security_and_backend(
            Arc::new(SecurityManager::default()),
            Arc::new(MockBackend::new()),
        );
        svc.set_dvfs(Some(shared));
        let m = svc.governor_metrics();
        assert_eq!(m.dvfs_applied, 2);
        assert_eq!(m.dvfs_failed, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn system_metrics_folds_governor_process_counts_and_stays_honest() {
        use crate::governor::ResourceGovernor;
        use amos_applife::AppId;

        let mut svc = AiAgentService::with_security_and_backend(
            Arc::new(SecurityManager::default()),
            Arc::new(MockBackend::new()),
        );
        // Deterministic host sampler: 8 GB total, 2 GB available, no CPU baseline.
        svc.system_sampler = Arc::new(amos_monitor::MockSystemSampler::new(
            8_000_000_000,
            2_000_000_000,
        ));

        // One live foreground app registered into the shared governor.
        let gov = Arc::new(std::sync::Mutex::new(ResourceGovernor::default()));
        gov.lock()
            .unwrap()
            .register_app(AppId::new("com.amos.photos"))
            .unwrap();
        svc.set_governor(Arc::clone(&gov));

        let h = svc.system_metrics();
        assert_eq!(h.sampler, "mock");

        // CPU honest "unknown" on the first read (no baseline yet) — never a number.
        let load = h.load.expect("load block present");
        assert_eq!(
            load.cpu_busy_pct, None,
            "first mock read has no CPU baseline"
        );
        assert_eq!(load.mem_total_bytes, Some(8_000_000_000));
        assert_eq!(load.mem_available_bytes, Some(2_000_000_000));

        // The one live foreground app is counted as running; nothing cached/stopped.
        let procs = h.processes.expect("process block present");
        assert_eq!(procs.running, 1);
        assert_eq!(procs.cached, 0);
        assert_eq!(procs.stopped, 0);

        // ... and appears in the per-app list by id + lifecycle key.
        assert_eq!(h.apps.len(), 1);
        assert_eq!(h.apps[0].id, "com.amos.photos");
        assert_eq!(h.apps[0].state, "foreground");

        // Battery comes from the energy-governor store; not ticked yet → pending →
        // level honestly unknown (never fabricated).
        assert_eq!(h.battery.expect("battery block present").level_pct, None);
    }

    #[test]
    fn system_metrics_threads_energy_battery_level() {
        use amos_power::Telemetry;

        let svc = AiAgentService::with_security_and_backend(
            Arc::new(SecurityManager::default()),
            Arc::new(MockBackend::new()),
        );
        // Tick the energy governor with an explicit 62% on-battery read → the system
        // block reflects it (single-surface battery from the authoritative source).
        svc.energy().tick_with(Telemetry::new(
            amos_power::BatteryState::on_battery(62.0),
            amos_power::Usage::default(),
            None,
        ));
        let h = svc.system_metrics();
        let b = h.battery.expect("battery block present");
        assert_eq!(b.level_pct, Some(62.0));
        assert_eq!(b.charging, Some(false), "on-battery → not charging");
    }

    #[test]
    fn fold_system_health_shares_sampler_energy_and_governor() {
        use amos_applife::AppId;
        use amos_power::{BatteryState, Telemetry, Usage};

        let sampler = amos_monitor::MockSystemSampler::new(8_000_000_000, 2_000_000_000);
        let energy = EnergyStore::new();
        energy.tick_with(Telemetry::new(
            BatteryState::on_battery(62.0),
            Usage::default(),
            None,
        ));
        let gov = std::sync::Mutex::new(ResourceGovernor::default());
        gov.lock()
            .unwrap()
            .register_app(AppId::new("com.amos.photos"))
            .unwrap();

        let h = fold_system_health(&sampler, energy.snapshot(), Some(&gov));
        assert_eq!(
            h.load.memory.used_pct(),
            Some(75.0),
            "8 GB total, 2 GB avail"
        );
        assert_eq!(h.battery.level_pct, Some(62.0));
        assert_eq!(h.battery.charging, Some(false), "on-battery → not charging");
        assert_eq!(h.processes.running, 1);
        assert!(h.summary().contains("battery=62%"), "{}", h.summary());

        // Pending energy baseline → battery honest unknown, charging unreported.
        let pending = fold_system_health(&sampler, EnergySnapshot::pending(), Some(&gov));
        assert_eq!(pending.battery.level_pct, None);
        assert_eq!(pending.battery.charging, None);
        assert_eq!(pending.processes.running, 1, "process tiers still fold");
    }

    #[test]
    fn parse_trimmed_u32_is_hermetic_and_lenient() {
        assert_eq!(parse_trimmed_u32("1500000"), Some(1_500_000));
        assert_eq!(
            parse_trimmed_u32("  2100000  "),
            Some(2_100_000),
            "trims whitespace"
        );
        assert_eq!(parse_trimmed_u32(""), None, "empty → None");
        assert_eq!(parse_trimmed_u32("  "), None, "blank → None");
        assert_eq!(parse_trimmed_u32("nope"), None, "non-numeric → None");
        assert_eq!(parse_trimmed_u32("-5"), None, "negative rejected (u32)");
    }

    #[test]
    fn parse_node_paths_splits_trims_and_drops_empties() {
        use std::path::PathBuf;
        let p = parse_node_paths(
            " /sys/class/devfreq/npu/max_freq ,,/sys/class/devfreq/npu2/max_freq ,  ",
        );
        assert_eq!(
            p,
            vec![
                PathBuf::from("/sys/class/devfreq/npu/max_freq"),
                PathBuf::from("/sys/class/devfreq/npu2/max_freq"),
            ]
        );
        assert!(parse_node_paths("").is_empty(), "empty → no nodes");
        assert!(
            parse_node_paths(" , , ").is_empty(),
            "only blanks → no nodes"
        );
    }
}
