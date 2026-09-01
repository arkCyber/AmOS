//! Session management for the inference daemon.
//!
//! Tracks active inference sessions, manages their lifecycle, and provides
//! utilities for context injection and session cleanup.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
}
