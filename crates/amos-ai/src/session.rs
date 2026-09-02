//! Session management for the inference daemon.
//!
//! Tracks active inference sessions, manages their lifecycle, and provides
//! utilities for context injection and session cleanup.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// Unique session identifier.
pub type SessionId = String;

/// A single inference session's metadata and context.
#[derive(Debug, Clone)]
pub struct SessionMetadata {
    /// Unique session ID.
    pub id: SessionId,

    /// When this session was created.
    pub created_at: Instant,

    /// Last activity timestamp (request received or response sent).
    pub last_activity: Instant,

    /// Model being used for this session.
    pub model: String,

    /// Optional context data injected into every request (e.g., screen state,
    /// system intent, user preferences).
    pub context: HashMap<String, String>,

    /// Number of tokens generated in this session.
    pub tokens_generated: usize,

    /// Whether the session has been explicitly cancelled.
    pub cancelled: bool,
}

impl SessionMetadata {
    /// Check if the session has been inactive for longer than the given duration.
    pub fn is_stale(&self, timeout: Duration) -> bool {
        self.last_activity.elapsed() > timeout
    }

    /// Update the last activity timestamp to now.
    pub fn touch(&mut self) {
        self.last_activity = Instant::now();
    }

    /// Add or update a context key.
    pub fn set_context(&mut self, key: String, value: String) {
        self.context.insert(key, value);
    }

    /// Increment the token counter.
    pub fn add_tokens(&mut self, count: usize) {
        self.tokens_generated += count;
    }
}

/// Manages the lifecycle of inference sessions.
pub struct SessionManager {
    /// Active sessions, keyed by ID.
    sessions: Arc<RwLock<HashMap<SessionId, SessionMetadata>>>,

    /// Session inactivity timeout.
    session_timeout: Duration,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new(Duration::from_secs(300))
    }
}

impl SessionManager {
    /// Create a new session manager with the specified timeout.
    pub fn new(session_timeout: Duration) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            session_timeout,
        }
    }

    /// Create a new session and return its ID.
    pub async fn create(&self, model: String) -> SessionId {
        let id = uuid::Uuid::new_v4().to_string();
        let metadata = SessionMetadata {
            id: id.clone(),
            created_at: Instant::now(),
            last_activity: Instant::now(),
            model,
            context: HashMap::new(),
            tokens_generated: 0,
            cancelled: false,
        };

        let mut sessions = self.sessions.write().await;
        sessions.insert(id.clone(), metadata);
        tracing::debug!("created session: {}", id);
        id
    }

    /// Ensure a session with the given id exists (used to key a conversation by
    /// the client-supplied `session_id` so history persists across calls). A
    /// no-op if the session already exists.
    pub async fn get_or_create(&self, id: &str, model: String) {
        let mut sessions = self.sessions.write().await;
        if sessions.contains_key(id) {
            return;
        }
        sessions.insert(
            id.to_string(),
            SessionMetadata {
                id: id.to_string(),
                created_at: Instant::now(),
                last_activity: Instant::now(),
                model,
                context: HashMap::new(),
                tokens_generated: 0,
                cancelled: false,
            },
        );
        tracing::debug!("created session (keyed): {}", id);
    }

    /// Get a session by ID (returns a clone).
    pub async fn get(&self, id: &str) -> Option<SessionMetadata> {
        let sessions = self.sessions.read().await;
        sessions.get(id).cloned()
    }

    /// Update a session's metadata (last_activity, tokens, etc.).
    pub async fn update<F>(&self, id: &str, f: F) -> Result<(), String>
    where
        F: FnOnce(&mut SessionMetadata),
    {
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(id) {
            f(session);
            Ok(())
        } else {
            Err(format!("session not found: {}", id))
        }
    }

    /// Mark a session as cancelled.
    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        self.update(id, |s| {
            s.cancelled = true;
            s.touch();
        })
        .await?;
        tracing::info!("cancelled session: {}", id);
        Ok(())
    }

    /// Remove a session.
    pub async fn remove(&self, id: &str) -> Result<SessionMetadata, String> {
        let mut sessions = self.sessions.write().await;
        sessions
            .remove(id)
            .ok_or_else(|| format!("session not found: {}", id))
    }

    /// Get all active sessions.
    pub async fn list_active(&self) -> Vec<SessionMetadata> {
        let sessions = self.sessions.read().await;
        sessions.values().cloned().collect()
    }

    /// Get the count of active sessions.
    pub async fn count_active(&self) -> usize {
        let sessions = self.sessions.read().await;
        sessions.len()
    }

    /// Clean up stale sessions (older than configured timeout).
    ///
    /// Returns the number of sessions removed.
    pub async fn cleanup_stale(&self) -> usize {
        let mut sessions = self.sessions.write().await;
        let initial_count = sessions.len();

        sessions.retain(|_, session| !session.is_stale(self.session_timeout));

        let removed = initial_count - sessions.len();
        if removed > 0 {
            tracing::info!("cleaned up {} stale sessions", removed);
        }
        removed
    }

    /// Inject a context key-value pair into a session.
    pub async fn inject_context(&self, id: &str, key: String, value: String) -> Result<(), String> {
        self.update(id, |s| s.set_context(key, value)).await
    }

    /// Get the context of a session.
    pub async fn get_context(&self, id: &str) -> Result<HashMap<String, String>, String> {
        self.get(id)
            .await
            .map(|s| s.context)
            .ok_or_else(|| format!("session not found: {}", id))
    }

    /// Spawn a background task that periodically cleans up stale sessions.
    pub fn spawn_cleanup_task(self: Arc<Self>, interval: Duration) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                self.cleanup_stale().await;
            }
        })
    }

    /// Persist all active sessions to `path` as JSON (atomic write).
    ///
    /// `Instant` values are converted to wall-clock on save and reconstructed on
    /// load, so sessions survive a daemon restart while staleness stays correct.
    pub async fn save(&self, path: &Path) -> Result<(), String> {
        let sessions = self.sessions.read().await;
        let stored: Vec<StoredSession> = sessions.values().map(StoredSession::from).collect();
        let json = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
        drop(sessions);

        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("rename to {}: {e}", path.display()))?;
        tracing::info!("persisted {} sessions to {}", stored.len(), path.display());
        Ok(())
    }

    /// Load sessions previously written by [`SessionManager::save`]. If the file
    /// is absent or malformed, returns a fresh, empty manager (non-fatal).
    pub fn load(path: &Path) -> Self {
        let Ok(json) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        let stored: Vec<StoredSession> = match serde_json::from_str(&json) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("failed to parse session file {}: {e}", path.display());
                return Self::default();
            }
        };
        let mut sessions = HashMap::new();
        for s in stored {
            sessions.insert(s.id.clone(), s.into_metadata());
        }
        tracing::info!("loaded {} sessions from {}", sessions.len(), path.display());
        Self {
            sessions: Arc::new(RwLock::new(sessions)),
            session_timeout: Duration::from_secs(300),
        }
    }
}

/// Unix timestamp in whole seconds.
fn current_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Serializable snapshot of a [`SessionMetadata`] for disk persistence.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSession {
    id: SessionId,
    created_at_unix: u64,
    last_activity_unix: u64,
    model: String,
    context: HashMap<String, String>,
    tokens_generated: usize,
    cancelled: bool,
}

impl From<&SessionMetadata> for StoredSession {
    fn from(s: &SessionMetadata) -> Self {
        let now = current_unix();
        Self {
            id: s.id.clone(),
            created_at_unix: now.saturating_sub(s.created_at.elapsed().as_secs()),
            last_activity_unix: now.saturating_sub(s.last_activity.elapsed().as_secs()),
            model: s.model.clone(),
            context: s.context.clone(),
            tokens_generated: s.tokens_generated,
            cancelled: s.cancelled,
        }
    }
}

impl StoredSession {
    /// Reconstruct a `SessionMetadata`, deriving monotonic `Instant`s from the
    /// persisted wall-clock timestamps (valid for staleness checks).
    fn into_metadata(self) -> SessionMetadata {
        let now = Instant::now();
        let now_unix = current_unix();
        SessionMetadata {
            id: self.id,
            created_at: now - Duration::from_secs(now_unix.saturating_sub(self.created_at_unix)),
            last_activity: now
                - Duration::from_secs(now_unix.saturating_sub(self.last_activity_unix)),
            model: self.model,
            context: self.context,
            tokens_generated: self.tokens_generated,
            cancelled: self.cancelled,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_session_generates_unique_ids() {
        let manager = SessionManager::default();
        let id1 = manager.create("model1".to_string()).await;
        let id2 = manager.create("model2".to_string()).await;
        assert_ne!(id1, id2);
    }

    #[tokio::test]
    async fn get_session_returns_metadata() {
        let manager = SessionManager::default();
        let id = manager.create("model1".to_string()).await;
        let session = manager.get(&id).await;
        assert!(session.is_some());
        assert_eq!(session.unwrap().model, "model1");
    }

    #[tokio::test]
    async fn cancel_session_marks_cancelled() {
        let manager = SessionManager::default();
        let id = manager.create("model1".to_string()).await;
        manager.cancel(&id).await.unwrap();
        let session = manager.get(&id).await.unwrap();
        assert!(session.cancelled);
    }

    #[tokio::test]
    async fn remove_session_deletes_it() {
        let manager = SessionManager::default();
        let id = manager.create("model1".to_string()).await;
        manager.remove(&id).await.unwrap();
        assert!(manager.get(&id).await.is_none());
    }

    #[tokio::test]
    async fn cleanup_stale_removes_old_sessions() {
        let manager = SessionManager::new(Duration::from_millis(100));
        let _id = manager.create("model1".to_string()).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let removed = manager.cleanup_stale().await;
        assert_eq!(removed, 1);
    }

    #[tokio::test]
    async fn inject_context_sets_key_value() {
        let manager = SessionManager::default();
        let id = manager.create("model1".to_string()).await;
        manager
            .inject_context(&id, "screen".to_string(), "unlocked".to_string())
            .await
            .unwrap();
        let context = manager.get_context(&id).await.unwrap();
        assert_eq!(context.get("screen"), Some(&"unlocked".to_string()));
    }

    #[tokio::test]
    async fn save_then_load_round_trips_sessions() {
        let path =
            std::env::temp_dir().join(format!("amos-sess-roundtrip-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let manager = SessionManager::default();
        let id = manager.create("model1".to_string()).await;
        manager
            .inject_context(&id, "screen".to_string(), "locked".to_string())
            .await
            .unwrap();
        manager.update(&id, |s| s.add_tokens(42)).await.unwrap();
        manager.save(&path).await.expect("save");
        assert!(path.exists(), "session file written");

        // Load into a fresh manager and verify the session survived.
        let loaded = SessionManager::load(&path);
        let session = loaded.get(&id).await.expect("session restored");
        assert_eq!(session.model, "model1");
        assert_eq!(session.tokens_generated, 42);
        assert_eq!(
            session.context.get("screen").map(String::as_str),
            Some("locked")
        );
        assert!(!session.cancelled);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn load_missing_or_malformed_file_is_empty() {
        let dir = std::env::temp_dir();
        let missing = SessionManager::load(
            &dir.join(format!("amos-sess-missing-{}.json", std::process::id())),
        );
        assert_eq!(missing.count_active().await, 0);

        let bad = dir.join(format!("amos-sess-bad-{}.json", std::process::id()));
        std::fs::write(&bad, "not json").unwrap();
        let loaded = SessionManager::load(&bad);
        assert_eq!(
            loaded.count_active().await,
            0,
            "malformed file yields empty manager"
        );
        let _ = std::fs::remove_file(&bad);
    }
}
