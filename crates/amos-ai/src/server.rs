//! gRPC service implementation served over a Unix Domain Socket.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use amos_proto::ai_agent::{
    ai_agent_server::{AiAgent, AiAgentServer},
    AgentChunk, AgentRequest, Alert, Alerts, BreakerMetrics, ClearSessionsReply,
    ClearSessionsRequest, ClientMessage, EnergyPolicy, GenerationPoolMetrics, GetHistoryReply,
    GetHistoryRequest, GovernorMetrics, HistoryTurn, ListSessionsReply, ListSessionsRequest,
    LogSinkMetrics, ProfileMetrics, RemoveSessionReply, RemoveSessionRequest, ResponseCacheMetrics,
    SessionInfo, StatusReply, StatusRequest,
};
use amos_proto::{CLIENT_ID_HEADER, DEFAULT_CLIENT_ID};
use anyhow::{anyhow, Context};
use std::pin::Pin;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
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
    /// The live response cache handle when `AMOS_RESPONSE_CACHE=1` wrapped the
    /// backend, so `get_status` can report honest hit/miss/store counters.
    /// `None` = caching disabled (the default) — the wire block says
    /// `enabled=false` rather than fabricating a cache that does not exist.
    response_cache: Option<Arc<crate::cache::ResponseCache>>,
    /// Live handle to the backend circuit breaker (REQ-A131), so `get_status` can
    /// report its state and honest decision counters. `Some` even when
    /// `AMOS_BREAKER=0` — then the snapshot's `enabled=false` says it is *not* in the
    /// serving path rather than pretending it is absent.
    breaker: Option<crate::breaker::SharedBreaker>,
    /// Threshold alerts derived from the counters above (REQ-A133). Holds only the
    /// "first seen at" bookkeeping — the alert *list* is recomputed on every status.
    alerts: Arc<std::sync::Mutex<crate::alerts::AlertTracker>>,
    /// Live handle to the on-disk log sink when `AMOS_LOG_DIR` opened one, so
    /// `get_status` can report whether the persisted trail is intact (and how much
    /// of it went missing). `None` = stdout-only logging: the wire block says
    /// `enabled=false` with honest zeros rather than pretending a sink exists.
    log_sink: Option<crate::logfile::LogSinkHandle>,
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
    /// Build a service with the security manager configured from the environment
    /// (documented knobs `AMOS_RATE_LIMIT_RPS` / `AMOS_RATE_LIMIT_TPH` /
    /// `AMOS_AUDIT_MAX_ENTRIES`, else defaults). It grants `Standard` to the
    /// default client, selects the backend from the environment, and loads
    /// sessions from `AMOS_SESSIONS_PATH` (if set).
    pub async fn new() -> Self {
        Self::new_with_audit(None).await
    }

    /// Same as [`AiAgentService::new`], but attaches `audit_sink` as the daemon's
    /// shared durable audit trail: every security-layer operation (rate-limit
    /// rejection / permission denial / liveness-probe outcome) is mirrored into it
    /// — the **same** trail the privacy manager appends to, so `RecentTrail` reads
    /// both domains back and neither is lost to a restart. `None` keeps the audit
    /// memory-only, the honest "no trail configured" state.
    pub async fn new_with_audit(audit_sink: Option<crate::audit::AuditFile>) -> Self {
        let security = SecurityManager::from_env();
        let security = match audit_sink {
            Some(sink) => security.with_audit_sink(sink),
            None => security,
        };
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
        // Backend circuit breaker (REQ-A131): **inside** the cache, so a cache hit is
        // still served while the backend is open and only real (uncached) generations
        // are gated. Default ON — a flapping/hung backend must fail fast with a stated
        // reason instead of making every caller walk the full backend timeout;
        // `AMOS_BREAKER=0` removes it from the serving path entirely.
        let breaker_cfg = crate::breaker::BreakerConfig::from_env();
        let breaker = crate::breaker::shared(breaker_cfg);
        let backend: Arc<dyn InferenceBackend> = if breaker_cfg.enabled {
            Arc::new(crate::breaker::BreakerBackend::new(
                backend,
                breaker.clone(),
            ))
        } else {
            backend
        };
        // Opt-in response cache (`AMOS_RESPONSE_CACHE=1`): identical
        // (model, prompt, context, max_tokens) generations replay from a
        // bounded LRU+TTL cache. Default OFF — caching changes observable
        // latency (a hit has near-zero TTFT), so it must be a deliberate
        // operator choice; `get_status` shows it via the `+cache` name and the
        // `response_cache` metrics block.
        let (backend, response_cache): (
            Arc<dyn InferenceBackend>,
            Option<Arc<crate::cache::ResponseCache>>,
        ) = if std::env::var("AMOS_RESPONSE_CACHE")
            .is_ok_and(|v| v == "1" || v.to_lowercase() == "true")
        {
            let cache = Arc::new(crate::cache::ResponseCache::with_defaults());
            (
                Arc::new(crate::cache::CachingBackend::new(backend, cache.clone())),
                Some(cache),
            )
        } else {
            (backend, None)
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
            response_cache,
            breaker: Some(breaker),
            alerts: Arc::new(std::sync::Mutex::new(crate::alerts::AlertTracker::new())),
            // The on-disk log sink belongs to the process (it is the tracing
            // subscriber's writer); the serving entry point attaches its handle via
            // [`Self::with_log_sink`], so `get_status` can report its health.
            log_sink: None,
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
            response_cache: None,
            breaker: None,
            alerts: Arc::new(std::sync::Mutex::new(crate::alerts::AlertTracker::new())),
            log_sink: None,
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

    /// Attach a live response-cache handle so `get_status` reports its honest
    /// counters. Call this when the backend handed to the service is wrapped in
    /// [`crate::cache::CachingBackend`] around `cache`; without it the
    /// `response_cache` wire block honestly reports `enabled=false`.
    pub fn with_response_cache(mut self, cache: Arc<crate::cache::ResponseCache>) -> Self {
        self.response_cache = Some(cache);
        self
    }

    /// Fold the circuit breaker's state and honest counters into the wire
    /// `BreakerMetrics` (REQ-A131). With no breaker attached (a custom embedding) or
    /// with `AMOS_BREAKER=0`, `enabled=false` — and then `state` is the empty string:
    /// "not in the serving path", never a fabricated "closed".
    fn breaker_metrics(&self) -> BreakerMetrics {
        match &self.breaker {
            Some(b) => {
                let s = crate::breaker::lock(b).snapshot();
                BreakerMetrics {
                    enabled: s.enabled,
                    state: if s.enabled {
                        s.state.label().to_string()
                    } else {
                        String::new()
                    },
                    fail_threshold: s.fail_threshold,
                    cooldown_seconds: s.cooldown.as_secs(),
                    consecutive_failures: s.consecutive_failures,
                    openings: s.openings,
                    rejections: s.rejections,
                    failures: s.failures,
                    successes: s.successes,
                }
            }
            None => BreakerMetrics::default(),
        }
    }

    /// Gather the alert rules' input from the blocks this reply already reports, then
    /// evaluate them (REQ-A133). A rule that newly appears is logged **once** at its
    /// own level: the list is a report, so the log is the only "delivery" — and it must
    /// not fire on every poll of a condition that is simply still true.
    fn alerts_now(&self) -> Alerts {
        let breaker_state = match &self.breaker {
            Some(b) => {
                let s = crate::breaker::lock(b).snapshot();
                s.enabled.then(|| s.state.label().to_string())
            }
            None => None,
        };
        let (_, pool_rejected_saturated, pool_rejected_timeout) = self.generation_pool.counters();
        let log = match &self.log_sink {
            Some(h) => h.report(),
            None => crate::logfile::LogSinkReport::disabled(),
        };
        let (_, dvfs_failed) = match &self.dvfs {
            Some(d) => {
                let d = d.lock().unwrap_or_else(|p| p.into_inner());
                (d.applied_total(), d.failed_total())
            }
            None => (0, 0),
        };
        let energy = self.energy.snapshot();
        let obs = crate::alerts::Observations {
            breaker_state,
            pool_rejections: pool_rejected_saturated + pool_rejected_timeout,
            log_lost_bytes: log.lost_bytes,
            log_write_failures: log.write_failures,
            degraded: self.engine.degraded,
            throttled: energy.cap_inference || energy.throttle_background,
            dvfs_failures: dvfs_failed,
        };
        let mut tracker = self.alerts.lock().unwrap_or_else(|p| p.into_inner());
        let before = tracker.active_ids();
        let active = tracker.evaluate(&obs, std::time::Instant::now());
        for a in &active {
            if !before.contains(&a.id) {
                match a.severity {
                    crate::alerts::Severity::Error => {
                        tracing::error!(alert = a.id, detail = %a.detail, "alert raised")
                    }
                    crate::alerts::Severity::Warn => {
                        tracing::warn!(alert = a.id, detail = %a.detail, "alert raised")
                    }
                }
            }
        }
        Alerts {
            alerts: active
                .into_iter()
                .map(|a| Alert {
                    id: a.id.to_string(),
                    severity: a.severity.label().to_string(),
                    detail: a.detail,
                    active_for_seconds: a.active_for.as_secs(),
                })
                .collect(),
        }
    }

    /// Attach a live breaker handle so `get_status` reports its state (tests /
    /// custom embeddings). The serving path sets this in [`AiAgentService::new`].
    pub fn with_breaker(mut self, breaker: crate::breaker::SharedBreaker) -> Self {
        self.breaker = Some(breaker);
        self
    }

    /// Attach the live on-disk log sink so `get_status` reports its health (bytes
    /// persisted, bytes lost, failed writes, rotations). Without it the `log_sink`
    /// wire block honestly reports `enabled=false`.
    pub fn with_log_sink(mut self, sink: crate::logfile::LogSinkHandle) -> Self {
        self.log_sink = Some(sink);
        self
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

    /// Fold the on-disk log sink's health into the wire `LogSinkMetrics` (REQ-A87).
    /// With no sink the block is the honest zero of "stdout only" — never a
    /// fabricated reading, and never a silent one either (`lost_bytes > 0` is visible
    /// on the operator's status surface, not only on the daemon's stderr).
    fn log_sink_metrics(&self) -> LogSinkMetrics {
        let r = match &self.log_sink {
            Some(h) => h.report(),
            None => crate::logfile::LogSinkReport::disabled(),
        };
        LogSinkMetrics {
            enabled: r.enabled,
            path: r.path,
            bytes_written: r.bytes_written,
            lost_bytes: r.lost_bytes,
            write_failures: r.write_failures,
            rotations: r.rotations,
            active_bytes: r.active_bytes,
        }
    }

    /// Fold the generation admission pool's live state + monotonic counters into
    /// the wire `GenerationPoolMetrics` (REQ-A43). `in_flight <= capacity` holds
    /// by construction; reporting `available` alongside lets a UI show both
    /// without arithmetic (and without inventing a value when busy).
    async fn generation_pool_metrics(&self) -> GenerationPoolMetrics {
        let (acquired, rejected_saturated, rejected_timeout) = self.generation_pool.counters();
        // One consistent read for the free/busy split so `available + in_flight
        // == capacity` always holds on the wire (two separate reads could
        // straddle a concurrent acquire/release and lie).
        let (in_flight, available) = self.generation_pool.snapshot();
        GenerationPoolMetrics {
            capacity: self.generation_pool.capacity() as u32,
            in_flight: in_flight as u32,
            available: available as u32,
            acquired_total: acquired,
            rejected_saturated,
            rejected_timeout,
            wait_ms: self.pool_wait.as_millis() as u64,
        }
    }

    /// Fold the response cache's honest counters into the wire
    /// `ResponseCacheMetrics` (REQ-A44). When the cache is disabled (default) the
    /// block says `enabled=false` with all-zero counters — never a fabricated
    /// cache, matching the P0-3 "no placeholder pretending to be a reading" rule.
    fn response_cache_metrics(&self) -> ResponseCacheMetrics {
        match &self.response_cache {
            Some(cache) => {
                let s = cache.stats();
                ResponseCacheMetrics {
                    enabled: true,
                    capacity: cache.capacity() as u32,
                    ttl_seconds: cache.ttl().as_secs(),
                    entries: s.entries as u32,
                    hits: s.hits,
                    misses: s.misses,
                    stores: s.stores,
                    evicted: s.evicted,
                    expired: s.expired,
                    oversized: s.oversized,
                }
            }
            None => ResponseCacheMetrics {
                enabled: false,
                ..Default::default()
            },
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
        // Key the daemon's OWN session by the client-supplied id, so a conversation
        // accumulates metadata/token totals across turns (and, with
        // `AMOS_SESSIONS_PATH` set, those survive a restart) instead of minting a
        // fresh throwaway session per turn. `get_or_create` exists for exactly this
        // and was previously unused; an empty id keeps the generated-id behaviour.
        let session_key = if session_id.is_empty() {
            sessions.create(self.model.to_string()).await
        } else {
            sessions
                .get_or_create(&session_id, self.model.to_string())
                .await;
            session_id.clone()
        };

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
        // A liveness probe is still permission-checked and audited, but it is metered
        // on its own bucket: generation traffic must not make the daemon's health
        // channel look dead (`security::validate_probe`, REQ-A82).
        if let Err(e) = self.security.validate_probe(&client_id).await {
            return Err(Status::resource_exhausted(format!(
                "request rejected by security layer: {e}"
            )));
        }
        // Single snapshot so the reply's metrics are mutually consistent.
        let snap = self.monitor.snapshot();
        let meta = self.backend.metadata();
        let generation_pool = self.generation_pool_metrics().await;
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
            generation_pool: Some(generation_pool),
            response_cache: Some(self.response_cache_metrics()),
            breaker: Some(self.breaker_metrics()),
            log_sink: Some(self.log_sink_metrics()),
            alerts: Some(self.alerts_now()),
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
fn resolve_tcp_addr() -> anyhow::Result<Option<std::net::SocketAddr>> {
    match std::env::var("AMOS_TCP_ADDR") {
        Ok(raw) => parse_tcp_addr(&raw),
        Err(_) => Ok(None),
    }
}

/// Parse `AMOS_TCP_ADDR`, **strictly**.
///
/// Two things this must not do, both of which the previous version did:
///  - silently fall back to the Unix socket when the value is malformed (a typo turned
///    "serve on TCP" into "serve on a socket file") — a parse error is an error now;
///  - accept a non-loopback address. This transport exists for on-device / `adb` IPC, so
///    a LAN-reachable bind is never what was meant; `AMOS_TCP_ALLOW_REMOTE=1` is the
///    explicit, warned override for someone who really means it.
fn parse_tcp_addr(raw: &str) -> anyhow::Result<Option<std::net::SocketAddr>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let addr: std::net::SocketAddr = raw
        .parse()
        .map_err(|e| anyhow!("AMOS_TCP_ADDR={raw:?} is not a host:port address: {e}"))?;
    if !addr.ip().is_loopback() {
        if !allow_remote_tcp() {
            anyhow::bail!(
                "AMOS_TCP_ADDR={raw:?} is not a loopback address; this transport is for \
                 on-device IPC and has no authentication for remote peers — use 127.0.0.1, \
                 or set AMOS_TCP_ALLOW_REMOTE=1 to accept the exposure"
            );
        }
        tracing::warn!(
            %addr,
            "AMOS_TCP_ALLOW_REMOTE=1: serving the daemon on a non-loopback address \
             (unauthenticated unless AMOS_TCP_TOKEN is set)"
        );
    }
    Ok(Some(addr))
}

/// Explicit opt-in for a non-loopback TCP bind (`AMOS_TCP_ALLOW_REMOTE=1`).
fn allow_remote_tcp() -> bool {
    matches!(
        std::env::var("AMOS_TCP_ALLOW_REMOTE").ok().as_deref(),
        Some("1") | Some("true")
    )
}

/// Run the tonic gRPC stack until a shutdown signal arrives.
///
/// Transport: if `AMOS_TCP_ADDR` is set we serve over loopback TCP (see
/// [`resolve_tcp_addr`]); otherwise we bind the Unix socket at `path`, harden it to
/// `0700`, and clean it up on shutdown.
pub async fn serve(path: std::path::PathBuf) -> anyhow::Result<()> {
    serve_with_log_sink(path, None).await
}

/// The accepted-connection stream handed to tonic in UDS mode: each item is a
/// peer-checked `UnixStream` (or the accept error). Factored out because clippy rejects
/// the inline `Pin<Box<dyn Stream<…> + Send>>` shape.
type UnixIncoming = Pin<
    Box<dyn tokio_stream::Stream<Item = Result<tokio::net::UnixStream, std::io::Error>> + Send>,
>;

/// Same as [`serve`], but attaches the daemon's live on-disk log sink so
/// `get_status` can report whether the persisted trail is intact and how much of it
/// went missing (REQ-A87). The binary passes the sink it installed as the tracing
/// writer; tests and embedders that do not persist logs pass `None`, and the wire
/// block then honestly says `enabled=false`.
pub async fn serve_with_log_sink(
    path: std::path::PathBuf,
    log_sink: Option<crate::logfile::LogSinkHandle>,
) -> anyhow::Result<()> {
    let tcp_addr = resolve_tcp_addr()?;
    // TCP has neither the socket's 0700 mode nor the kernel peer check, and loopback TCP
    // is reachable by every process on the device — so the transport states its policy
    // (and warns when it has none) instead of pretending the socket hardening applies.
    // On the UDS transport the token is deliberately **not** consulted (the peer check
    // already covers it), which is why an unrelated AMOS_TCP_TOKEN cannot lock the shell
    // out of its own socket.
    let tcp_policy = if tcp_addr.is_some() {
        crate::tcp_auth::TcpPolicy::from_env()
    } else {
        crate::tcp_auth::TcpPolicy::Open
    };
    let tcp_gate = crate::tcp_auth::TokenGate::new(tcp_policy);
    if tcp_addr.is_some() {
        tcp_gate.policy().announce();
    }

    // Bind the Unix socket only in the UDS transport. In TCP mode a shell process on
    // a retail Android device cannot create a socket file under SELinux, so we skip
    // binding entirely (loopback TCP needs no root).
    // Peer-credential gate for the UDS transport (gap #28 / REQ-A141): the 0700 mode
    // keeps *other* users out, but that is a filesystem property — this asks the kernel
    // who connected (SO_PEERCRED / getpeereid). A refused connection is dropped before
    // tonic ever sees it, and `PeerGuard` logs every refusal (plus the "could not
    // verify" case), so the policy actually in force is never silent.
    let peer_guard = crate::peercred::PeerGuard::from_env();
    tracing::info!(
        our_uid = crate::peercred::our_uid(),
        policy = %std::env::var("AMOS_UDS_PEER").unwrap_or_else(|_| "enforce".into()),
        "unix-socket peer-credential policy"
    );
    let incoming: Option<UnixIncoming> = if tcp_addr.is_some() {
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

        let (tx, rx) = mpsc::channel::<Result<tokio::net::UnixStream, std::io::Error>>(16);
        // Accept in its own task so the peer check runs **before** tonic ever sees the
        // connection (a refused one is simply never forwarded). The task ends when the
        // receiver is dropped at shutdown, which is exactly when the server stops.
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        if !peer_guard.admits(&stream) {
                            continue; // logged by the guard; the socket is closed on drop
                        }
                        if tx.send(Ok(stream)).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        if tx.send(Err(e)).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Some(Box::pin(ReceiverStream::new(rx)))
    };
    // The single UDS serves BOTH gRPC services: the AI agent and the Android
    // compat layer, so Tauri talks to the whole OS backend over one connection.
    // The runtime is auto-selected: real Waydroid on device, in-process demo
    // elsewhere (so the whole pipeline works on any host).
    // The daemon's **single, durable audit trail**. Resolved once and handed to
    // BOTH the security layer and the privacy manager, so one `RecentTrail` read
    // shows operation results (rate-limit / permission / probe) *and* access
    // decisions, and both survive a restart. Path: `AMOS_AUDIT_PATH`, else
    // `<AMOS_PRIVACY_PATH>.jsonl` (the historical location); neither set ⇒
    // memory-only, honestly reported as no-trail.
    let audit_sink = crate::audit::shared_trail_from_env();
    let mut ai_service = AiAgentService::new_with_audit(audit_sink.clone()).await;
    if let Some(handle) = log_sink {
        ai_service = ai_service.with_log_sink(handle);
    }
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
    // Android manager knobs come from the environment (documented
    // AMOS_ANDROID_*_TIMEOUT / *_CACHE_SIZE), defaulting to the tuned values.
    let android_manager: Arc<amos_android::manager::EnhancedAndroidManager> =
        Arc::new(amos_android::manager::EnhancedAndroidManager::with_config(
            android_runtime,
            amos_android::manager::AndroidManagerConfig::from_env(),
        ));
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
            // Runs until the daemon shuts down (the task is aborted when `serve`
            // returns). `tick()` is the wait; the loop has no exit of its own.
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
        // Runs until the daemon shuts down (the task is aborted when `serve`
        // returns, "Aborted on shutdown below"). `tick()` is the wait.
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
        // Applied to **every** service: on the TCP transport a request without the right
        // `x-amos-token` is refused before routing (see `tcp_auth.rs`); on UDS the gate's
        // policy is `Open`, so this layer costs one metadata read.
        .layer(tonic::service::interceptor::InterceptorLayer::new(tcp_gate))
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
            let (privacy, persist) =
                crate::privacy_service::bootstrap_with_sink(audit_sink.clone());
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
    async fn status_reports_the_breaker_honestly_and_never_a_fake_closed() {
        let security = Arc::new(SecurityManager::default());
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        // A backend that always fails, behind a threshold-2 breaker.
        struct Failing;
        #[async_trait::async_trait]
        impl crate::inference::real::InferenceBackend for Failing {
            async fn infer(
                &self,
                _p: &str,
                _c: &std::collections::HashMap<String, String>,
                _m: usize,
            ) -> anyhow::Result<Box<dyn crate::inference::real::TokenStream>> {
                anyhow::bail!("backend is down")
            }
            fn metadata(&self) -> crate::inference::real::BackendMetadata {
                MockBackend::new().metadata()
            }
            async fn health_check(&self) -> anyhow::Result<()> {
                Ok(())
            }
            async fn get_stats(&self) -> crate::inference::real::BackendStats {
                crate::inference::real::BackendStats::default()
            }
        }
        let br = crate::breaker::shared(crate::breaker::BreakerConfig {
            enabled: true,
            fail_threshold: 2,
            cooldown: Duration::from_secs(30),
        });
        let backend: Arc<dyn InferenceBackend> = Arc::new(crate::breaker::BreakerBackend::new(
            Arc::new(Failing),
            br.clone(),
        ));
        let svc = AiAgentService::with_security_and_backend(security, backend).with_breaker(br);

        // Healthy-looking at first: closed, enabled, and no invented counter movement.
        let st = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        let b = st.breaker.expect("the breaker block is present");
        assert!(b.enabled);
        assert_eq!(b.state, "closed");
        assert_eq!(b.fail_threshold, 2);
        assert_eq!(b.cooldown_seconds, 30);
        assert_eq!(b.openings, 0);
        assert_eq!(b.rejections, 0);

        // Two real failures open it; the third call is skipped (rejections moves).
        for _ in 0..2 {
            let mut s = svc
                .stream_chat(stream_req(DEFAULT_CLIENT_ID, "sess"))
                .await
                .expect("stream opens")
                .into_inner();
            while s.next().await.is_some() {}
        }
        let mut s = svc
            .stream_chat(stream_req(DEFAULT_CLIENT_ID, "sess"))
            .await
            .expect("stream opens")
            .into_inner();
        let mut saw_err = false;
        while let Some(chunk) = s.next().await {
            if let Ok(c) = chunk {
                if c.error.contains("circuit breaker open") {
                    saw_err = true;
                }
            }
        }
        assert!(saw_err, "the skipped call must say *why* it was skipped");

        let st = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        let b = st.breaker.expect("the breaker block is present");
        assert_eq!(b.state, "open");
        assert_eq!(b.openings, 1);
        assert_eq!(b.failures, 2);
        assert_eq!(
            b.rejections, 1,
            "one call was skipped without touching the backend"
        );
    }

    #[tokio::test]
    async fn alerts_are_empty_when_healthy_and_list_what_is_wrong_when_not() {
        // Healthy: a mock daemon with no breaker/stats attached ⇒ no rules fire. The
        // reply must not carry an "all clear" object, just the empty list.
        let security = Arc::new(SecurityManager::default());
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        let svc = AiAgentService::with_security(security);
        let st = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        let alerts = st.alerts.expect("the alerts block is present").alerts;
        assert!(
            alerts.is_empty(),
            "a healthy daemon reports no alerts: {alerts:?}"
        );

        // Degraded engine + an open breaker: two rules must fire, error first.
        let security = Arc::new(SecurityManager::default());
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        let br = crate::breaker::shared(crate::breaker::BreakerConfig {
            enabled: true,
            fail_threshold: 1,
            cooldown: Duration::from_secs(30),
        });
        // Open it for real (one failure at threshold 1) so the alert is not synthetic.
        crate::breaker::lock(&br).on_failure(std::time::Instant::now());
        let mut svc = AiAgentService::with_security(security).with_breaker(br);
        svc.engine.degraded = true;
        let st = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        let alerts = st.alerts.expect("the alerts block is present").alerts;
        let ids: Vec<&str> = alerts.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"breaker_open"), "{ids:?}");
        assert!(ids.contains(&"engine_degraded"), "{ids:?}");
        assert_eq!(alerts[0].severity, "error", "errors come first: {ids:?}");
        assert_eq!(alerts[0].id, "breaker_open");
        // `active_for` is honest about the process-local history: first sight is 0s.
        assert_eq!(alerts[0].active_for_seconds, 0);

        // Polling again does not invent history, and clearing the condition clears the
        // alert (no sticky alarm).
        let st2 = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        let ids2: Vec<String> = st2
            .alerts
            .expect("alerts")
            .alerts
            .into_iter()
            .map(|a| a.id)
            .collect();
        assert_eq!(ids2.len(), 2);
        svc.engine.degraded = false;
        let st3 = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        let ids3: Vec<String> = st3
            .alerts
            .expect("alerts")
            .alerts
            .into_iter()
            .map(|a| a.id)
            .collect();
        assert_eq!(ids3, vec!["breaker_open".to_string()], "degraded cleared");
    }

    #[test]
    fn tcp_addr_is_parsed_strictly_and_must_be_loopback() {
        // Unset / empty ⇒ no TCP (the UDS path is used).
        assert_eq!(parse_tcp_addr("").unwrap(), None);
        assert_eq!(parse_tcp_addr("   ").unwrap(), None);

        // A malformed value is an **error**, not a silent fallback to the socket: the
        // old code returned None here, so a typo turned "serve on TCP" into "serve on a
        // socket file" with nothing said.
        assert!(parse_tcp_addr("127.0.0.1").is_err(), "missing port");
        assert!(parse_tcp_addr("nonsense:99999").is_err(), "bad port");
        assert!(
            parse_tcp_addr("127.0.0.1:70000").is_err(),
            "out-of-range port"
        );

        // Loopback is accepted (v4 and v6).
        assert_eq!(
            parse_tcp_addr("127.0.0.1:19090").unwrap().map(|a| a.port()),
            Some(19090)
        );
        assert!(parse_tcp_addr("[::1]:19090").unwrap().is_some());
    }

    #[test]
    fn a_non_loopback_tcp_bind_needs_the_explicit_override() {
        std::env::remove_var("AMOS_TCP_ALLOW_REMOTE");
        let err = parse_tcp_addr("0.0.0.0:19090").expect_err("must refuse a LAN bind");
        assert!(
            err.to_string().contains("AMOS_TCP_ALLOW_REMOTE"),
            "the message must name the override: {err}"
        );
        assert!(parse_tcp_addr("192.168.1.10:19090").is_err());

        // …and the override is honoured (with a warning, which the server emits).
        std::env::set_var("AMOS_TCP_ALLOW_REMOTE", "1");
        assert!(parse_tcp_addr("0.0.0.0:19090").unwrap().is_some());
        std::env::remove_var("AMOS_TCP_ALLOW_REMOTE");
    }

    #[tokio::test]
    async fn a_disabled_breaker_reports_enabled_false_and_no_state() {
        let security = Arc::new(SecurityManager::default());
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        let br = crate::breaker::shared(crate::breaker::BreakerConfig {
            enabled: false,
            fail_threshold: 3,
            cooldown: Duration::from_secs(30),
        });
        let svc = AiAgentService::with_security(security).with_breaker(br);
        let st = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        let b = st.breaker.expect("the breaker block is present");
        assert!(!b.enabled);
        // Not in the serving path ⇒ no state at all, never a fabricated "closed".
        assert_eq!(b.state, "");
        assert_eq!(b.successes, 0);
        assert_eq!(b.failures, 0);
        assert_eq!(b.rejections, 0);
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
        // The mock engine must not be passed off as a real model. The reported name is
        // the *serving path*: the backend circuit breaker (REQ-A131) is on by default,
        // so it appears as an honest `+breaker` suffix — the kind is still plainly
        // `mock`. Only known decorators may ever appear here.
        assert!(
            reply.engine == "mock" || reply.engine == "mock+breaker",
            "mock backend reports itself as mock, decorated only by known paths (got {:?})",
            reply.engine
        );
        assert!(
            reply
                .engine
                .rsplit('+')
                .next()
                .is_some_and(|k| k == "mock" || k == "breaker"),
            "unexpected decorator in the engine name (got {:?})",
            reply.engine
        );
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
    async fn get_status_reports_the_log_sink_honestly() {
        let security = Arc::new(SecurityManager::default());
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        let svc = AiAgentService::with_security(Arc::clone(&security));

        // 1) No sink attached ⇒ the honest zero of "stdout only" (not a fake reading).
        let reply = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("get_status")
            .into_inner();
        let ls = reply.log_sink.expect("log_sink block");
        assert!(!ls.enabled, "absent sink must report enabled=false");
        assert!(ls.path.is_empty(), "no path may be invented");
        assert_eq!(
            (
                ls.bytes_written,
                ls.lost_bytes,
                ls.write_failures,
                ls.rotations,
                ls.active_bytes
            ),
            (0, 0, 0, 0, 0)
        );

        // 2) A live sink is reported: which file, and how much actually landed.
        let dir = std::env::temp_dir().join(format!("amos-ai-logsink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sink = crate::logfile::TeeWriter::new(Some(crate::logfile::LogFileConfig {
            dir: dir.clone(),
            max_bytes: 1024,
            keep: 2,
        }));
        {
            use std::io::Write;
            use tracing_subscriber::fmt::MakeWriter;
            let mut w = sink.make_writer();
            w.write_all(b"persisted\n").unwrap();
        }
        let svc = svc.with_log_sink(sink.handle());
        let reply = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("get_status")
            .into_inner();
        let ls = reply.log_sink.expect("log_sink block");
        assert!(ls.enabled);
        assert!(ls.path.ends_with("amos-ai.log"), "path: {}", ls.path);
        assert_eq!(ls.bytes_written, 10, "the bytes that really landed on disk");
        assert_eq!((ls.lost_bytes, ls.write_failures), (0, 0));
        assert_eq!(ls.active_bytes, 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn get_status_is_not_starved_by_generation_rate_limits() {
        // Regression (found by the load test, REQ-A82): a generation burst used to
        // exhaust the *shared* per-client bucket, so the daemon answered its own
        // liveness probe with "request rejected by security layer" — the operator and
        // the System UI lost sight of a healthy, busy daemon.
        let config = RateLimitConfig {
            requests_per_second: 1,
            probe_requests_per_second: 2,
            ..Default::default()
        };
        let security = Arc::new(SecurityManager::new(config));
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        let svc = AiAgentService::with_security(security);

        // Generation lane: first call admitted, second honestly rejected.
        assert!(svc
            .stream_chat(stream_req(DEFAULT_CLIENT_ID, "burst-1"))
            .await
            .is_ok());
        let err = svc
            .stream_chat(stream_req(DEFAULT_CLIENT_ID, "burst-2"))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::ResourceExhausted);

        // Health channel: still answers while the generation lane is exhausted.
        let status = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("a liveness probe must not be starved by generation traffic")
            .into_inner();
        assert!(status.running);

        // …and the probe lane is itself bounded (audited, not silently dropped).
        assert!(svc.get_status(Request::new(StatusRequest {})).await.is_ok());
        let err = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::ResourceExhausted);

        let entries = svc.security.audit_logger.get_recent(30).await;
        assert!(
            entries
                .iter()
                .any(|e| e.operation == "probe" && e.result == AuditResult::Success),
            "successful liveness probes must be audited"
        );
        assert!(
            entries.iter().any(|e| e.operation == "probe"
                && e.result == AuditResult::Rejected
                && e.details.contains("probe rate limit")),
            "over-limit probes must be audited as rejected"
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
    async fn get_status_reports_honest_generation_pool_metrics() {
        // get_status must carry the live pool state, not a fabricated one:
        // capacity is the configured slot count, in_flight mirrors held permits,
        // and a disabled cache is reported as enabled=false (never a fake cache).
        let security = Arc::new(SecurityManager::default());
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        let pool = Arc::new(GenerationPool::try_new(3).unwrap());
        let svc = AiAgentService::with_generation_gate(
            security,
            Arc::new(MockBackend::new()),
            pool.clone(),
            Duration::from_millis(250),
        );

        let st = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("get_status")
            .into_inner();
        let gp = st.generation_pool.expect("generation_pool block present");
        assert_eq!(gp.capacity, 3, "capacity is the configured slot count");
        assert_eq!(gp.in_flight, 0);
        assert_eq!(gp.available, 3);
        assert_eq!(gp.wait_ms, 250, "bounded wait is reported in ms");
        assert_eq!(
            (
                gp.acquired_total,
                gp.rejected_saturated,
                gp.rejected_timeout
            ),
            (0, 0, 0)
        );
        assert_eq!(gp.available + gp.in_flight, gp.capacity);

        // Hold a slot: in_flight must rise and available must fall in lockstep.
        let permit = pool.acquire(Duration::ZERO).await.expect("slot");
        let st = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("get_status")
            .into_inner();
        let gp = st.generation_pool.expect("generation_pool block present");
        assert_eq!((gp.in_flight, gp.available), (1, 2));
        assert_eq!(gp.acquired_total, 1);
        assert_eq!(gp.available + gp.in_flight, gp.capacity);
        drop(permit);

        // Default service (no cache wired) truthfully reports a disabled cache.
        let rc = st.response_cache.expect("response_cache block present");
        assert!(!rc.enabled, "caching is off by default");
        assert_eq!(rc.capacity, 0);
        assert_eq!((rc.hits, rc.misses, rc.stores), (0, 0, 0));
    }

    #[tokio::test]
    async fn get_status_reports_response_cache_counters_when_enabled() {
        // With a live cache handle attached, get_status must show the real
        // hit/miss/store counters after an identical-prompt replay.
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
            backend,
            Arc::new(GenerationPool::try_new(4).unwrap()),
            Duration::ZERO,
        )
        .with_response_cache(cache.clone());

        let rc = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("get_status")
            .into_inner()
            .response_cache
            .expect("response_cache block present");
        assert!(rc.enabled);
        assert_eq!(rc.capacity, 32);
        assert_eq!(rc.ttl_seconds, 300);
        assert_eq!(rc.entries, 0);

        // Two identical prompts: one miss+store, then one hit.
        for _ in 0..2 {
            let mut s = svc
                .stream_chat(stream_req(DEFAULT_CLIENT_ID, "same"))
                .await
                .expect("stream opens")
                .into_inner();
            while let Some(chunk) = s.next().await {
                if let Ok(c) = chunk {
                    if c.done {
                        break;
                    }
                }
            }
        }

        let rc = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("get_status")
            .into_inner()
            .response_cache
            .expect("response_cache block present");
        assert!(rc.enabled);
        assert_eq!((rc.misses, rc.hits, rc.stores), (1, 1, 1));
        assert_eq!(rc.entries, 1);
        assert!(
            rc.hits + rc.misses >= 2,
            "invariant: hits + misses equals lookups performed"
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

    #[tokio::test]
    async fn stream_chat_keys_the_session_by_the_client_id() {
        let security = Arc::new(SecurityManager::default());
        security
            .permission_manager
            .grant(DEFAULT_CLIENT_ID.to_string(), Permission::Standard)
            .await;
        let sessions = Arc::new(SessionManager::default());
        let svc = AiAgentService::with_security(security).with_sessions(sessions.clone(), None);

        // Two turns of the SAME conversation, then one of a different conversation.
        for sid in ["conv-1", "conv-1", "conv-2"] {
            let mut stream = svc
                .stream_chat(stream_req(DEFAULT_CLIENT_ID, sid))
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
        }

        // Token updates land just after each terminal frame; poll briefly.
        let mut list = sessions.list_active().await;
        for _ in 0..50 {
            if list.iter().any(|s| s.tokens_generated >= 2) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            list = sessions.list_active().await;
        }

        // Regression: the daemon used to mint a fresh session per turn and ignore the
        // client id, so two turns of "conv-1" were two throwaway sessions and the
        // conversation's usage never accumulated.
        assert_eq!(
            list.len(),
            2,
            "one daemon session per client conversation id"
        );
        let conv1 = list
            .iter()
            .find(|s| s.id == "conv-1")
            .expect("conv-1 tracked under the client-supplied id");
        assert!(
            conv1.tokens_generated >= 2,
            "both turns counted on one session (got {})",
            conv1.tokens_generated
        );
        assert!(
            list.iter().any(|s| s.id == "conv-2"),
            "conv-2 has its own session"
        );
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
