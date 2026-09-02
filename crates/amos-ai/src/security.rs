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
    /// Maximum tokens per hour per client.
    pub tokens_per_hour: usize,
    /// Cleanup interval for stale entries.
    pub cleanup_interval_secs: u64,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            requests_per_second: 10,
            tokens_per_hour: 100_000,
            cleanup_interval_secs: 3600,
        }
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
        let elapsed = now - self.last_refill;
        let new_tokens = (elapsed as usize) * self.refill_rate;
        self.tokens = std::cmp::min(self.capacity, self.tokens + new_tokens);
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
    request: TokenBucket,
    tokens: TokenBucket,
    /// Unix timestamp (secs) of the last request/token check from this client.
    last_activity: u64,
}

impl ClientBuckets {
    fn new(rps: usize, tokens_per_hour: usize) -> Self {
        Self {
            request: TokenBucket::new(rps, rps),
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
            ClientBuckets::new(self.config.requests_per_second, self.config.tokens_per_hour)
        });
        entry.last_activity = current_timestamp();

        if entry.request.consume(1) {
            Ok(())
        } else {
            Err(anyhow::anyhow!("rate limit exceeded: requests per second"))
        }
    }

    /// Check if a client can generate tokens.
    pub async fn check_tokens(&self, client_id: &str, count: usize) -> Result<()> {
        let mut buckets = self.buckets.write().await;
        let entry = buckets.entry(client_id.to_string()).or_insert_with(|| {
            ClientBuckets::new(self.config.requests_per_second, self.config.tokens_per_hour)
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
}

impl Default for AuditLogger {
    fn default() -> Self {
        Self::new(10_000)
    }
}

impl AuditLogger {
    /// Create a new audit logger.
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: Arc::new(RwLock::new(Vec::with_capacity(max_entries))),
            max_entries,
        }
    }

    /// Log an audit entry.
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

        let mut entries = self.entries.write().await;
        entries.push(entry.clone());

        // Trim old entries if necessary.
        if entries.len() > self.max_entries {
            let remove_count = entries.len() - self.max_entries;
            let _ = entries.drain(0..remove_count).collect::<Vec<_>>();
        }

        tracing::debug!("audit: {:?}", entry);
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

    /// Log token consumption.
    pub async fn log_tokens(&self, client_id: &str, count: usize) {
        let _ = self.rate_limiter.check_tokens(client_id, count).await;
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

    /// Spawn a background task that periodically drops idle client buckets to
    /// bound memory. The idle window comes from `cleanup_interval_secs`.
    pub fn start_cleanup_task(&self) {
        let idle_secs = self.rate_limiter.config.cleanup_interval_secs.max(1);
        let limiter = self.rate_limiter.clone();
        tokio::spawn(async move {
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
}
