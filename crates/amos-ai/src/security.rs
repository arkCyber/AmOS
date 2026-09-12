//! Security and compliance layer.
//!
//! Implements rate limiting, audit logging, permission checks, and
//! other security mechanisms to protect the inference service.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::audit::{audit_max_entries_from, AuditFile};

/// Audit log entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub timestamp: u64,
    pub client_id: String,
    pub operation: String,
    pub resource: String,
    pub result: AuditResult,
    pub details: String,
}

/// Audit result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuditResult {
    /// Operation succeeded.
    Success,
    /// Operation was rejected (e.g., rate limit, permission denied).
    Rejected,
    /// Operation failed due to an error.
    Error,
}

impl std::fmt::Display for AuditResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Success => "SUCCESS",
            Self::Rejected => "REJECTED",
            Self::Error => "ERROR",
        })
    }
}

/// Rate limit configuration.
#[derive(Debug, Clone)]
pub struct RateLimitConfig {
    /// Maximum requests per second per client.
    pub requests_per_second: usize,
    /// Maximum read-only **liveness probes** per second per client.
    ///
    /// Deliberately a *separate* bucket: probes and generations must not be able to
    /// starve each other. With one shared bucket, a generation burst pushed the
    /// daemon's own health channel (`GetStatus`, the System UI's liveness probe) into
    /// `ResourceExhausted` — the operator lost sight of a **healthy** daemon exactly
    /// while it was busy. This lane is bounded too, so probe-driven abuse is capped.
    pub probe_requests_per_second: usize,
    /// Maximum tokens per hour per client.
    pub tokens_per_hour: usize,
    /// Cleanup interval for stale entries.
    pub cleanup_interval_secs: u64,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            requests_per_second: 10,
            probe_requests_per_second: 50,
            tokens_per_hour: 100_000,
            cleanup_interval_secs: 3600,
        }
    }
}

impl RateLimitConfig {
    /// Overlay the documented env knobs on the defaults.
    ///
    /// `AMOS_RATE_LIMIT_RPS` / `AMOS_RATE_LIMIT_TPH` (documented in
    /// `SECURITY_LAYER_SUMMARY.md` / `PHASE2_COMPLETION_REPORT.md`) used to be
    /// **write-only**: nothing read them, so an operator tuning the limit saw no
    /// effect. Pure for the values, so the "garbage/zero is ignored" policy is
    /// unit-testable without touching the process environment.
    pub fn from_vars(rps: Option<&str>, tph: Option<&str>) -> Self {
        fn positive(v: Option<&str>) -> Option<usize> {
            v.and_then(|s| s.trim().parse::<usize>().ok())
                .filter(|n| *n > 0)
        }
        let mut cfg = Self::default();
        if let Some(n) = positive(rps) {
            cfg.requests_per_second = n;
        }
        if let Some(n) = positive(tph) {
            cfg.tokens_per_hour = n;
        }
        cfg
    }

    /// [`Self::from_vars`] with the values read from the environment.
    pub fn from_env() -> Self {
        Self::from_vars(
            std::env::var("AMOS_RATE_LIMIT_RPS").ok().as_deref(),
            std::env::var("AMOS_RATE_LIMIT_TPH").ok().as_deref(),
        )
    }
}

/// Rate limiter using a token bucket algorithm.
#[derive(Debug)]
struct TokenBucket {
    /// Maximum capacity (tokens).
    capacity: usize,
    /// Current tokens available.
    tokens: usize,
    /// Last refill timestamp.
    last_refill: u64,
    /// Refill rate (tokens per second).
    refill_rate: usize,
}

impl TokenBucket {
    fn new(capacity: usize, refill_rate: usize) -> Self {
        Self {
            capacity,
            tokens: capacity,
            last_refill: current_timestamp(),
            refill_rate,
        }
    }

    fn refill(&mut self) {
        let now = current_timestamp();
        // Saturate so a wall-clock regression (NTP step-back) can never underflow
        // into a panic or a huge wrap.
        let elapsed = now.saturating_sub(self.last_refill);
        let new_tokens = (elapsed as usize).saturating_mul(self.refill_rate);
        self.tokens = std::cmp::min(self.capacity, self.tokens.saturating_add(new_tokens));
        self.last_refill = now;
    }

    fn consume(&mut self, tokens: usize) -> bool {
        self.refill();
        if self.tokens >= tokens {
            self.tokens -= tokens;
            true
        } else {
            false
        }
    }
}

/// Per-client state for the rate limiter.
#[derive(Debug)]
struct ClientBuckets {
    /// Generation/management requests (the "expensive" lane).
    request: TokenBucket,
    /// Read-only liveness probes (the "watchdog" lane, see `probe_requests_per_second`).
    probe: TokenBucket,
    tokens: TokenBucket,
    /// Unix timestamp (secs) of the last request/token check from this client.
    last_activity: u64,
}

impl ClientBuckets {
    fn new(rps: usize, probe_rps: usize, tokens_per_hour: usize) -> Self {
        Self {
            request: TokenBucket::new(rps, rps),
            probe: TokenBucket::new(probe_rps, probe_rps),
            tokens: TokenBucket::new(tokens_per_hour, tokens_per_hour / 3600),
            last_activity: current_timestamp(),
        }
    }
}

/// Rate limiter for clients.
#[derive(Clone)]
pub struct RateLimiter {
    config: RateLimitConfig,
    /// Client ID -> per-client rate-limit state.
    buckets: Arc<RwLock<HashMap<String, ClientBuckets>>>,
}

impl RateLimiter {
    /// Create a new rate limiter.
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            buckets: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Check if a client can make a request.
    pub async fn check_request(&self, client_id: &str) -> Result<()> {
        let mut buckets = self.buckets.write().await;
        let entry = buckets.entry(client_id.to_string()).or_insert_with(|| {
            ClientBuckets::new(
                self.config.requests_per_second,
                self.config.probe_requests_per_second,
                self.config.tokens_per_hour,
            )
        });
        entry.last_activity = current_timestamp();

        if entry.request.consume(1) {
            Ok(())
        } else {
            Err(anyhow::anyhow!("rate limit exceeded: requests per second"))
        }
    }

    /// Check if a client can make a **read-only liveness probe**.
    ///
    /// Uses its own bucket so a generation burst cannot blind the operator's health
    /// channel (and vice versa). Still bounded, so probing is not free.
    pub async fn check_probe(&self, client_id: &str) -> Result<()> {
        let mut buckets = self.buckets.write().await;
        let entry = buckets.entry(client_id.to_string()).or_insert_with(|| {
            ClientBuckets::new(
                self.config.requests_per_second,
                self.config.probe_requests_per_second,
                self.config.tokens_per_hour,
            )
        });
        entry.last_activity = current_timestamp();

        if entry.probe.consume(1) {
            Ok(())
        } else {
            Err(anyhow::anyhow!(
                "rate limit exceeded: liveness probes per second"
            ))
        }
    }

    /// Check if a client can generate tokens.
    pub async fn check_tokens(&self, client_id: &str, count: usize) -> Result<()> {
        let mut buckets = self.buckets.write().await;
        let entry = buckets.entry(client_id.to_string()).or_insert_with(|| {
            ClientBuckets::new(
                self.config.requests_per_second,
                self.config.probe_requests_per_second,
                self.config.tokens_per_hour,
            )
        });
        entry.last_activity = current_timestamp();

        if entry.tokens.consume(count) {
            Ok(())
        } else {
            Err(anyhow::anyhow!("rate limit exceeded: tokens per hour"))
        }
    }

    /// Remove client buckets idle for longer than `idle_window_secs`, bounding
    /// memory when many one-off clients connect over time. Only *inactive*
    /// clients are dropped — active quotas are preserved (unlike clearing all).
    pub async fn cleanup_stale(&self, idle_window_secs: u64) {
        let mut buckets = self.buckets.write().await;
        let now = current_timestamp();
        let before = buckets.len();
        buckets.retain(|_, b| now.saturating_sub(b.last_activity) < idle_window_secs);
        if before != buckets.len() {
            tracing::debug!(
                "rate limiter cleanup: {} -> {} clients",
                before,
                buckets.len()
            );
        }
    }
}

/// Audit logger.
pub struct AuditLogger {
    entries: Arc<RwLock<Vec<AuditEntry>>>,
    /// Maximum number of entries to keep in memory.
    max_entries: usize,
    /// Optional durable JSON-lines sink; when present every [`log`] is also
    /// appended there (via the unified [`AuditFile`]) so the audit survives
    /// restarts. Disk failures are logged, never fatal.
    ///
    /// [`log`]: AuditLogger::log
    sink: Option<AuditFile>,
}

impl Default for AuditLogger {
    fn default() -> Self {
        Self::new(crate::audit::DEFAULT_AUDIT_MAX_ENTRIES)
    }
}

impl AuditLogger {
    /// Create a new, memory-only audit logger.
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: Arc::new(RwLock::new(Vec::with_capacity(max_entries))),
            max_entries,
            sink: None,
        }
    }

    /// Attach (or replace) the durable sink this logger mirrors every entry to.
    ///
    /// Passing the daemon's **shared** trail (`crate::audit::shared_trail_from_env`)
    /// is what makes the security layer's operations (rate-limit rejections,
    /// permission denials, probe outcomes) show up in the same `RecentTrail` as
    /// the privacy decisions — and survive a restart.
    pub fn attach_sink(&mut self, sink: AuditFile) {
        self.sink = Some(sink);
    }

    /// Create a durable audit logger that appends to a JSON-lines [`AuditFile`]
    /// at `path` (created if absent) in addition to the in-memory ring.
    pub fn new_persistent(max_entries: usize, path: impl AsRef<std::path::Path>) -> Result<Self> {
        let sink = AuditFile::open(path, max_entries)?;
        let mut logger = Self::new(max_entries);
        logger.attach_sink(sink);
        Ok(logger)
    }

    /// The path of the durable sink, if one was configured.
    pub fn durable_path(&self) -> Option<&std::path::Path> {
        self.sink.as_ref().and_then(AuditFile::path)
    }

    /// Log an audit entry. When a durable sink was configured the entry is also
    /// appended there (normalised to [`crate::audit::AuditRecord`]); a disk
    /// error is logged, never fatal.
    pub async fn log(
        &self,
        client_id: String,
        operation: String,
        resource: String,
        result: AuditResult,
        details: String,
    ) {
        let entry = AuditEntry {
            timestamp: current_timestamp(),
            client_id,
            operation,
            resource,
            result,
            details,
        };
        tracing::debug!("audit: {:?}", entry);

        // Keep the bounded in-memory ring first.
        {
            let mut entries = self.entries.write().await;
            entries.push(entry.clone());

            // Trim old entries if necessary.
            if entries.len() > self.max_entries {
                let remove_count = entries.len() - self.max_entries;
                let _ = entries.drain(0..remove_count).collect::<Vec<_>>();
            }
        }

        // Best-effort durable append through the unified sink.
        if let Some(sink) = &self.sink {
            let rec = crate::audit::AuditRecord::from(entry);
            if let Err(e) = sink.log(rec).await {
                tracing::warn!("audit file append failed: {e:#}");
            }
        }
    }

    /// Get recent audit entries.
    pub async fn get_recent(&self, limit: usize) -> Vec<AuditEntry> {
        let entries = self.entries.read().await;
        entries.iter().rev().take(limit).cloned().collect()
    }

    /// Export audit log as JSON (for external systems).
    pub async fn export_json(&self) -> String {
        let entries = self.entries.read().await;
        match serde_json::to_string(&*entries) {
            Ok(json) => json,
            Err(e) => {
                tracing::error!("failed to serialize audit log: {}", e);
                "[]".to_string()
            }
        }
    }
}

/// Permission level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    /// No access.
    Deny = 0,
    /// Limited access (e.g., rate-limited).
    Limited = 1,
    /// Standard access.
    Standard = 2,
    /// Administrative access.
    Admin = 3,
}

/// Permission manager.
pub struct PermissionManager {
    /// Client ID -> Permission level.
    permissions: Arc<RwLock<HashMap<String, Permission>>>,
}

impl Default for PermissionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PermissionManager {
    /// Create a new permission manager.
    pub fn new() -> Self {
        Self {
            permissions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Grant permission to a client.
    pub async fn grant(&self, client_id: String, permission: Permission) {
        let mut perms = self.permissions.write().await;
        perms.insert(client_id, permission);
    }

    /// Revoke permission from a client.
    pub async fn revoke(&self, client_id: &str) {
        let mut perms = self.permissions.write().await;
        perms.remove(client_id);
    }

    /// Check if a client has a permission level.
    pub async fn check(&self, client_id: &str, required: Permission) -> bool {
        let perms = self.permissions.read().await;
        perms
            .get(client_id)
            .map(|&p| p >= required)
            .unwrap_or(false)
    }

    /// Get a client's permission level.
    pub async fn get(&self, client_id: &str) -> Permission {
        let perms = self.permissions.read().await;
        perms.get(client_id).copied().unwrap_or(Permission::Deny)
    }
}

/// Combined security manager.
pub struct SecurityManager {
    pub rate_limiter: RateLimiter,
    pub audit_logger: AuditLogger,
    pub permission_manager: PermissionManager,
}

impl Default for SecurityManager {
    fn default() -> Self {
        Self::new(RateLimitConfig::default())
    }
}

impl SecurityManager {
    /// Create a new security manager.
    pub fn new(rate_limit_config: RateLimitConfig) -> Self {
        Self {
            rate_limiter: RateLimiter::new(rate_limit_config),
            audit_logger: AuditLogger::default(),
            permission_manager: PermissionManager::default(),
        }
    }

    /// Build the manager the **daemon** runs with, honouring the documented knobs
    /// `AMOS_RATE_LIMIT_RPS` / `AMOS_RATE_LIMIT_TPH` / `AMOS_AUDIT_MAX_ENTRIES`.
    /// Unset/garbage/zero values fall back to the defaults, so the bounds are never
    /// silently disabled by a typo.
    pub fn from_env() -> Self {
        Self {
            rate_limiter: RateLimiter::new(RateLimitConfig::from_env()),
            audit_logger: AuditLogger::new(audit_max_entries_from(
                std::env::var("AMOS_AUDIT_MAX_ENTRIES").ok().as_deref(),
            )),
            permission_manager: PermissionManager::default(),
        }
    }

    /// Attach the daemon's durable audit sink (builder).
    ///
    /// Passing the **shared** trail (`crate::audit::shared_trail_from_env`) is what
    /// makes this layer's operations — rate-limit rejections, permission denials,
    /// liveness-probe outcomes — land in the same trail the privacy manager writes
    /// to, so `RecentTrail` can read both back and the record survives a restart.
    pub fn with_audit_sink(mut self, sink: AuditFile) -> Self {
        self.audit_logger.attach_sink(sink);
        self
    }

    /// Validate a client request (rate limit + permission check).
    pub async fn validate_request(&self, client_id: &str) -> Result<()> {
        // Check permission first.
        if !self
            .permission_manager
            .check(client_id, Permission::Standard)
            .await
        {
            self.audit_logger
                .log(
                    client_id.to_string(),
                    "infer".to_string(),
                    "global".to_string(),
                    AuditResult::Rejected,
                    "permission denied".to_string(),
                )
                .await;
            return Err(anyhow::anyhow!("permission denied"));
        }

        // Check rate limit.
        match self.rate_limiter.check_request(client_id).await {
            Ok(()) => {
                self.audit_logger
                    .log(
                        client_id.to_string(),
                        "infer".to_string(),
                        "global".to_string(),
                        AuditResult::Success,
                        "request validated".to_string(),
                    )
                    .await;
                Ok(())
            }
            Err(e) => {
                self.audit_logger
                    .log(
                        client_id.to_string(),
                        "infer".to_string(),
                        "global".to_string(),
                        AuditResult::Rejected,
                        format!("rate limit: {}", e),
                    )
                    .await;
                Err(e)
            }
        }
    }

    /// Validate a **read-only liveness probe** (`GetStatus`) — permission + audit on
    /// the same terms as [`Self::validate_request`], but metered on the *probe* lane.
    ///
    /// Why a separate lane: generation traffic and the health channel must not be able
    /// to starve one another. Sharing one bucket meant a burst of generations made the
    /// daemon report "request rejected by security layer" for its own `GetStatus`, so
    /// the operator (and the System UI) lost sight of a healthy daemon. Probes stay
    /// audited and bounded, so this is not an exemption from the security layer.
    pub async fn validate_probe(&self, client_id: &str) -> Result<()> {
        if !self
            .permission_manager
            .check(client_id, Permission::Standard)
            .await
        {
            self.audit_logger
                .log(
                    client_id.to_string(),
                    "probe".to_string(),
                    "global".to_string(),
                    AuditResult::Rejected,
                    "permission denied".to_string(),
                )
                .await;
            return Err(anyhow::anyhow!("permission denied"));
        }

        match self.rate_limiter.check_probe(client_id).await {
            Ok(()) => {
                self.audit_logger
                    .log(
                        client_id.to_string(),
                        "probe".to_string(),
                        "global".to_string(),
                        AuditResult::Success,
                        "liveness probe validated".to_string(),
                    )
                    .await;
                Ok(())
            }
            Err(e) => {
                self.audit_logger
                    .log(
                        client_id.to_string(),
                        "probe".to_string(),
                        "global".to_string(),
                        AuditResult::Rejected,
                        format!("probe rate limit: {}", e),
                    )
                    .await;
                Err(e)
            }
        }
    }

    /// Log token consumption and its outcome. Over-quota generation is recorded as
    /// [`AuditResult::Rejected`], never as a success.
    pub async fn log_tokens(&self, client_id: &str, count: usize) {
        match self.rate_limiter.check_tokens(client_id, count).await {
            Ok(()) => {
                self.audit_logger
                    .log(
                        client_id.to_string(),
                        "generate".to_string(),
                        "tokens".to_string(),
                        AuditResult::Success,
                        format!("{} tokens", count),
                    )
                    .await;
            }
            Err(e) => {
                self.audit_logger
                    .log(
                        client_id.to_string(),
                        "generate".to_string(),
                        "tokens".to_string(),
                        AuditResult::Rejected,
                        format!("tokens over quota ({count}): {e}"),
                    )
                    .await;
            }
        }
    }

    /// Spawn a background task that periodically drops idle client buckets to
    /// bound memory. The idle window comes from `cleanup_interval_secs`.
    pub fn start_cleanup_task(&self) {
        let idle_secs = self.rate_limiter.config.cleanup_interval_secs.max(1);
        let limiter = self.rate_limiter.clone();
        tokio::spawn(async move {
            // Runs until the daemon shuts down: no exit here; the task is aborted
            // with the runtime. `sleep()` is the wait (never a spin).
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(idle_secs)).await;
                limiter.cleanup_stale(idle_secs).await;
            }
        });
    }
}

/// Get current Unix timestamp in seconds.
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_config_reads_documented_env_knobs() {
        let d = RateLimitConfig::default();
        // Unset / garbage / zero keep the defaults (a typo must not disable the bound).
        assert_eq!(
            RateLimitConfig::from_vars(None, None).requests_per_second,
            d.requests_per_second
        );
        assert_eq!(
            RateLimitConfig::from_vars(Some("nope"), None).requests_per_second,
            d.requests_per_second
        );
        assert_eq!(
            RateLimitConfig::from_vars(Some("0"), None).requests_per_second,
            d.requests_per_second
        );
        assert_eq!(
            RateLimitConfig::from_vars(None, Some("-5")).tokens_per_hour,
            d.tokens_per_hour
        );
        // Valid values are honoured (whitespace tolerated).
        let cfg = RateLimitConfig::from_vars(Some(" 25 "), Some("5000"));
        assert_eq!(cfg.requests_per_second, 25);
        assert_eq!(cfg.tokens_per_hour, 5_000);
        // Untouched fields keep their tuned defaults.
        assert_eq!(cfg.probe_requests_per_second, d.probe_requests_per_second);
        assert_eq!(cfg.cleanup_interval_secs, d.cleanup_interval_secs);
    }

    #[test]
    fn audit_max_entries_env_defaults_and_ignores_garbage() {
        assert_eq!(audit_max_entries_from(None), 10_000);
        assert_eq!(audit_max_entries_from(Some("")), 10_000);
        assert_eq!(audit_max_entries_from(Some("junk")), 10_000);
        assert_eq!(audit_max_entries_from(Some("0")), 10_000);
        assert_eq!(audit_max_entries_from(Some(" 250 ")), 250);
    }

    #[tokio::test]
    async fn rate_limiter_blocks_excessive_requests() {
        let config = RateLimitConfig {
            requests_per_second: 2,
            ..Default::default()
        };
        let limiter = RateLimiter::new(config);

        // First two requests should succeed.
        assert!(limiter.check_request("client1").await.is_ok());
        assert!(limiter.check_request("client1").await.is_ok());

        // Third should fail.
        assert!(limiter.check_request("client1").await.is_err());
    }

    #[tokio::test]
    async fn audit_logger_records_entries() {
        let logger = AuditLogger::default();
        logger
            .log(
                "client1".to_string(),
                "test".to_string(),
                "resource".to_string(),
                AuditResult::Success,
                "test details".to_string(),
            )
            .await;

        let entries = logger.get_recent(10).await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].client_id, "client1");
    }

    #[tokio::test]
    async fn permission_manager_checks_access() {
        let manager = PermissionManager::default();
        manager.grant("admin".to_string(), Permission::Admin).await;

        // Admin (level 3) should pass Standard (level 2) check
        assert!(manager.check("admin", Permission::Standard).await);
        // Admin should also pass Admin check
        assert!(manager.check("admin", Permission::Admin).await);
        // Unknown client should fail all checks
        assert!(!manager.check("unknown", Permission::Limited).await);
    }

    #[tokio::test]
    async fn security_manager_validates_requests() {
        let manager = SecurityManager::default();
        manager
            .permission_manager
            .grant("client1".to_string(), Permission::Standard)
            .await;

        assert!(manager.validate_request("client1").await.is_ok());
        assert!(manager.validate_request("unknown").await.is_err());
    }

    #[tokio::test]
    async fn cleanup_stale_drops_idle_clients_keeps_active() {
        let config = RateLimitConfig {
            cleanup_interval_secs: 3600,
            ..Default::default()
        };
        let limiter = RateLimiter::new(config);
        limiter.check_request("active").await.unwrap();
        limiter.check_request("idle").await.unwrap();
        assert_eq!(
            limiter.buckets.read().await.len(),
            2,
            "two clients registered"
        );

        // Simulate the "idle" client having been inactive for two hours.
        {
            let mut b = limiter.buckets.write().await;
            let idle = b.get_mut("idle").expect("idle bucket exists");
            idle.last_activity = current_timestamp().saturating_sub(7200);
        }

        limiter.cleanup_stale(3600).await;
        let b = limiter.buckets.read().await;
        assert_eq!(b.len(), 1, "idle client dropped");
        assert!(b.contains_key("active"), "active client retained");
        assert!(!b.contains_key("idle"), "idle client gone");
    }

    #[test]
    fn token_bucket_refill_handles_clock_regression_and_huge_elapsed() {
        // Clock regression (last_refill in the future): no panic, no refill.
        let mut behind = TokenBucket::new(100, 10);
        behind.tokens = 0;
        behind.last_refill = current_timestamp() + 10_000;
        behind.refill();
        assert_eq!(behind.tokens, 0, "no refill while the clock is behind");

        // Huge elapsed must saturate to capacity, never overflow/panic.
        let mut huge = TokenBucket::new(1000, 1);
        huge.tokens = 0;
        huge.last_refill = current_timestamp().saturating_sub(u64::MAX / 2);
        huge.refill();
        assert_eq!(huge.tokens, huge.capacity, "huge elapsed caps at capacity");
    }

    #[tokio::test]
    async fn log_tokens_over_quota_is_audited_as_rejected() {
        let cfg = RateLimitConfig {
            requests_per_second: 100,
            tokens_per_hour: 10, // tiny quota so over-quota is easy to hit
            ..Default::default()
        };
        let sm = SecurityManager::new(cfg);
        sm.permission_manager
            .grant("client".to_string(), Permission::Admin)
            .await;

        sm.log_tokens("client", 5).await; // within quota → Success
        sm.log_tokens("client", 10).await; // over remaining → Rejected

        let recent = sm.audit_logger.get_recent(10).await;
        let token_entries: Vec<_> = recent
            .iter()
            .filter(|e| e.operation == "generate")
            .collect();
        assert!(
            token_entries
                .iter()
                .any(|e| e.result == AuditResult::Rejected),
            "over-quota generation must be audited as rejected"
        );
        assert!(
            token_entries
                .iter()
                .any(|e| e.result == AuditResult::Success),
            "in-quota generation is audited as success"
        );
    }

    #[tokio::test]
    async fn persistent_logger_appends_to_durable_audit_file() {
        let dir = std::env::temp_dir().join(format!("amos-sec-audit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.jsonl");

        let logger = AuditLogger::new_persistent(64, &path).unwrap();
        assert_eq!(logger.durable_path(), Some(path.as_path()));
        logger
            .log(
                "client-a".to_string(),
                "generate".to_string(),
                "tokens".to_string(),
                AuditResult::Success,
                "ok".to_string(),
            )
            .await;

        // The in-memory ring sees the entry for this session…
        let session = logger.get_recent(10).await;
        assert_eq!(session.len(), 1);

        // …and the same event was appended to the durable JSON-lines file, so a
        // fresh reader (restart) recovers it from disk via the unified sink.
        let sink = AuditFile::open(&path, 64).unwrap();
        assert_eq!(sink.count().await, 1, "entry persisted to the audit file");
        let rec = sink.recent(10).await;
        assert_eq!(rec[0].principal, "client-a");
        assert_eq!(rec[0].outcome, crate::audit::Outcome::Success);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_shared_sink_receives_the_security_layers_own_decisions() {
        // The daemon hands the SAME sink to this layer and the privacy manager. The
        // point of this test is that the security half really writes into it: a
        // rejected request must appear in the unified trail (and on disk), not only
        // in this process's memory ring — otherwise `RecentTrail` could never show
        // why a request was refused.
        let sink = AuditFile::memory(16);
        let sm = SecurityManager::default().with_audit_sink(sink.clone());

        // An ungranted client is refused (deny-by-default) and audited.
        assert!(sm.validate_request("nobody").await.is_err());

        let recent = sink.recent(4).await;
        assert_eq!(recent.len(), 1, "the refusal reached the shared trail");
        assert_eq!(recent[0].principal, "nobody");
        assert_eq!(recent[0].resource, "global");
        assert_eq!(recent[0].outcome, crate::audit::Outcome::Rejected);

        // Without a sink the same call is only in memory — the honest no-trail state.
        let bare = SecurityManager::default();
        assert!(bare.validate_request("nobody").await.is_err());
        assert!(bare.audit_logger.durable_path().is_none());
    }

    #[tokio::test]
    async fn probe_lane_is_independent_of_the_generation_lane() {
        // 1 generation-request/sec but 3 probes/sec: a generation burst must not be
        // able to exhaust the liveness lane, and probes must not eat generation budget.
        let limiter = RateLimiter::new(RateLimitConfig {
            requests_per_second: 1,
            probe_requests_per_second: 3,
            ..Default::default()
        });

        assert!(limiter.check_probe("c").await.is_ok());
        assert!(limiter.check_probe("c").await.is_ok());
        assert!(limiter.check_probe("c").await.is_ok());
        // Probe lane is bounded too — not an exemption from the security layer.
        assert!(limiter.check_probe("c").await.is_err());

        // The generation lane is untouched by the probes above…
        assert!(limiter.check_request("c").await.is_ok());
        assert!(limiter.check_request("c").await.is_err());

        // …and a fresh client gets its own, independent probe allowance.
        assert!(limiter.check_probe("fresh").await.is_ok());
    }

    #[tokio::test]
    async fn validate_probe_audits_and_keeps_the_health_channel_alive_under_load() {
        let security = SecurityManager::new(RateLimitConfig {
            requests_per_second: 1,
            probe_requests_per_second: 2,
            ..Default::default()
        });
        security
            .permission_manager
            .grant("ui".to_string(), Permission::Standard)
            .await;

        // Saturate the generation lane.
        assert!(security.validate_request("ui").await.is_ok());
        assert!(security.validate_request("ui").await.is_err());

        // The health channel still answers, and both outcomes are audited.
        assert!(security.validate_probe("ui").await.is_ok());
        assert!(security.validate_probe("ui").await.is_ok());
        assert!(security.validate_probe("ui").await.is_err());

        let log = security.audit_logger.get_recent(20).await;
        assert!(
            log.iter()
                .any(|e| e.operation == "probe" && e.result == AuditResult::Success),
            "successful probes must be audited"
        );
        assert!(
            log.iter()
                .any(|e| e.operation == "probe" && e.result == AuditResult::Rejected),
            "rejected probes must be audited (no silent drops)"
        );

        // An unauthorised client cannot probe either.
        assert!(security.validate_probe("stranger").await.is_err());
    }
}
