//! Session management for the inference daemon.
//!
//! Tracks active inference sessions, manages their lifecycle, and provides
//! utilities for context injection and session cleanup.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// Unique session identifier.
pub type SessionId = String;

/// One conversation turn recorded on a session (appended only once a turn fully
/// completes, so it never sees partial streaming state).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub role: String, // "user" | "assistant"
    pub text: String,
}

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

    /// Completed conversation turns (bounded; oldest dropped beyond the cap).
    pub history: Vec<Turn>,
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

    /// Append one completed conversation turn, bounding history to the newest
    /// `SESSION_HISTORY_CAP` turns (dropping the oldest).
    pub fn append_turn(&mut self, role: String, text: String) {
        self.history.push(Turn { role, text });
        if self.history.len() > SESSION_HISTORY_CAP {
            self.history
                .drain(0..self.history.len() - SESSION_HISTORY_CAP);
        }
    }
}

/// Max completed turns kept per session.
pub const SESSION_HISTORY_CAP: usize = 200;

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
            history: Vec::new(),
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
                history: Vec::new(),
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

    /// Remove every tracked session, returning how many were removed.
    pub async fn clear_all(&self) -> usize {
        let mut sessions = self.sessions.write().await;
        let n = sessions.len();
        sessions.clear();
        n
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
            // Runs until the daemon shuts down: no exit here; the task is aborted
            // with the runtime. `tick()` is the wait (never a spin).
            loop {
                ticker.tick().await;
                self.cleanup_stale().await;
            }
        })
    }

    /// A sane cleanup cadence derived from the timeout (half of it, min 1s) so a
    /// stale session is reaped within ~1.5× the inactivity timeout.
    pub fn cleanup_interval(&self) -> Duration {
        let secs = self.session_timeout.as_secs().max(2) / 2;
        Duration::from_secs(secs.max(1))
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
        let target = path.to_path_buf();
        // Write-to-temp + rename is an atomic replace, but both calls are **blocking**
        // filesystem work — and this method is `async`, so it must not run them on the
        // tokio worker (today the only caller is the daemon's shutdown path; the split
        // keeps that true if a hot-path caller ever appears). `json` and the paths are
        // moved in, so nothing is borrowed across the thread boundary.
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
            std::fs::rename(&tmp, &target)
                .map_err(|e| format!("rename to {}: {e}", target.display()))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("persist task failed: {e}"))??;
        tracing::info!("persisted {} sessions to {}", stored.len(), path.display());
        Ok(())
    }

    /// Load sessions previously written by [`SessionManager::save`].
    ///
    /// Three distinct outcomes, because they carry three distinct facts:
    ///
    /// - **absent** (`NotFound`) — the honest first-run default, and silent:
    ///   nothing was there to lose.
    /// - a file that *exists* but **cannot be read back** (permissions, non-UTF-8
    ///   bytes) — **kept aside** (`<name>.corrupt-<nonce>`) and reported once.
    /// - a file that *exists* and reads but does not **parse** — also kept aside
    ///   and reported.
    ///
    /// The aside matters because the daemon holds this same path
    /// (`AMOS_SESSIONS_PATH`) and calls [`SessionManager::save`] on graceful
    /// shutdown, so starting empty *on top of* it would overwrite the operator's
    /// only copy of the session history. The returned manager is still empty in
    /// both of the latter cases — the file is outside the trust boundary and its
    /// contents are never trusted; what the aside buys is that the bytes are not
    /// destroyed (REQ-A1939 / F-AI-037).
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(json) => match serde_json::from_str::<Vec<StoredSession>>(&json) {
                Ok(stored) => {
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
                Err(e) => {
                    keep_sessions_aside(path, &format!("is unparseable: {e}"));
                    Self::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(e) => {
                keep_sessions_aside(path, &format!("is unreadable: {e}"));
                Self::default()
            }
        }
    }
}

/// Move an unreadable/unparseable session file aside so a later
/// [`SessionManager::save`] cannot overwrite it, and report it. The daemon keeps
/// the original path live across shutdown, so the aside is what stops a fresh
/// save from destroying the operator's only copy of the history.
fn keep_sessions_aside(path: &Path, reason: &str) {
    match preserve_unreadable_state(path) {
        Some(kept) => tracing::warn!(
            "session file {} {reason}; kept at {} and starting with no sessions",
            path.display(),
            kept.display()
        ),
        None => tracing::warn!(
            "session file {} {reason}; could not be moved aside, starting with no sessions",
            path.display()
        ),
    }
}

/// Rename `path` to a `<name>.corrupt-<nonce>` sibling. `None` when there was
/// nothing to keep (not a regular file) or the rename failed — the caller warns
/// either way and still starts empty. (Renaming works even when the file itself
/// cannot be read, since it is a directory operation.)
fn preserve_unreadable_state(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let kept = path.with_extension(format!("corrupt-{nonce}"));
    std::fs::rename(path, &kept).ok().map(|()| kept)
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
    /// Completed turns (missing on pre-history files => default empty).
    #[serde(default)]
    history: Vec<Turn>,
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
            history: s.history.clone(),
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
            history: self.history,
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
    async fn touch_keeps_active_session_alive() {
        let manager = SessionManager::new(Duration::from_millis(120));
        let id = manager.create("model1".to_string()).await;
        // Activity before the timeout expires keeps the session from being reaped.
        tokio::time::sleep(Duration::from_millis(80)).await;
        manager.update(&id, |s| s.touch()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            manager.cleanup_stale().await,
            0,
            "touched session stays alive"
        );
        // Once it actually goes idle past the timeout it is reaped.
        tokio::time::sleep(Duration::from_millis(140)).await;
        assert_eq!(manager.cleanup_stale().await, 1);
    }

    #[tokio::test]
    async fn background_sweeper_reaps_stale_periodically() {
        let manager = Arc::new(SessionManager::new(Duration::from_millis(120)));
        let _id = manager.create("model1".to_string()).await;
        let _sweeper = manager
            .clone()
            .spawn_cleanup_task(Duration::from_millis(30));
        tokio::time::sleep(Duration::from_millis(220)).await;
        assert_eq!(
            manager.count_active().await,
            0,
            "sweeper removed the stale session"
        );
    }

    #[test]
    fn cleanup_interval_is_half_the_timeout_and_never_zero() {
        // Sub-second timeouts still get a ≥1s cadence.
        assert_eq!(
            SessionManager::new(Duration::from_millis(100)).cleanup_interval(),
            Duration::from_secs(1)
        );
        // 600s timeout → sweep every 300s.
        assert_eq!(
            SessionManager::new(Duration::from_secs(600)).cleanup_interval(),
            Duration::from_secs(300)
        );
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
        let dir = tmp_dir("empty");
        let missing = SessionManager::load(&dir.join("missing.json"));
        assert_eq!(missing.count_active().await, 0);

        let bad = dir.join("sessions.json");
        std::fs::write(&bad, "not json").unwrap();
        let loaded = SessionManager::load(&bad);
        assert_eq!(
            loaded.count_active().await,
            0,
            "malformed file yields empty manager"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh temp dir per test (the aside files a load leaves behind are
    /// siblings of the session file, so counting them needs a directory of our
    /// own — not the shared temp dir).
    fn tmp_dir(tag: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("amos-sess-{tag}-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The `*.corrupt-*` file a load kept beside `dir`'s session file, if any.
    fn corrupt_aside(dir: &Path) -> Option<PathBuf> {
        std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.to_string_lossy().contains("corrupt-"))
    }

    /// Counts WARN events so an assertion lands on the *observable* diagnostic:
    /// the daemon's shutdown path has no caller to return an error to, so
    /// tracing is the one channel that tells the operator the file was dropped.
    struct WarnProbe(std::sync::Arc<std::sync::atomic::AtomicU64>);
    impl tracing::Subscriber for WarnProbe {
        fn enabled(&self, _m: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _s: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _id: &tracing::span::Id, _r: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _a: &tracing::span::Id, _b: &tracing::span::Id) {}
        fn event(&self, ev: &tracing::Event<'_>) {
            if ev.metadata().level() == &tracing::Level::WARN {
                self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        fn enter(&self, _id: &tracing::span::Id) {}
        fn exit(&self, _id: &tracing::span::Id) {}
    }

    /// A session file that **exists but cannot be read back** is kept aside
    /// before the empty default is used, because the daemon holds this same path
    /// (`AMOS_SESSIONS_PATH`) and calls `save` on graceful shutdown: without the
    /// aside, that save rewrites the file from scratch and the operator's only
    /// copy of the session history is gone. A non-UTF-8 byte sequence is the
    /// reachable instance — `read_to_string` refuses it, which used to fold into
    /// the same silent `Self::default()` as a missing file (REQ-A1939 /
    /// F-AI-037).
    #[tokio::test]
    async fn an_unreadable_session_file_is_kept_aside_before_the_next_save_overwrites_it() {
        let dir = tmp_dir("unreadable");
        let path = dir.join("sessions.json");
        let original: &[u8] = &[b'{', 0xff, 0xfe, b'}'];
        std::fs::write(&path, original).unwrap();

        let warns = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let loaded = {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            SessionManager::load(&path)
        };
        assert_eq!(
            loaded.count_active().await,
            0,
            "unreadable file => no sessions"
        );
        assert_eq!(
            warns.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "the drop must be audible: the shutdown path has no error to return to"
        );

        let kept = corrupt_aside(&dir).expect("the unreadable file was kept beside the original");
        assert!(
            !path.exists(),
            "the live path no longer holds the undecodable bytes"
        );
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            original,
            "the bytes the operator left behind survive byte-for-byte"
        );

        // The proof that matters: a later save rewrites `path`, and the kept copy
        // is still there to be recovered.
        loaded.save(&path).await.expect("save");
        assert!(path.exists(), "the live path is rewritten with fresh state");
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            original,
            "the aside is not the file a save touches"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The parse arm of the same defect: the file reads fine but is not the JSON
    /// `save` writes, so starting empty on top of it would overwrite it.
    #[tokio::test]
    async fn an_unparseable_session_file_is_kept_aside_too() {
        let dir = tmp_dir("unparseable");
        let path = dir.join("sessions.json");
        let original: &[u8] = b"{ this is not the session list";
        std::fs::write(&path, original).unwrap();

        let warns = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let loaded = {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            SessionManager::load(&path)
        };
        assert_eq!(loaded.count_active().await, 0);
        assert_eq!(warns.load(std::sync::atomic::Ordering::Relaxed), 1);

        let kept = corrupt_aside(&dir).expect("the unparseable file was kept aside");
        assert_eq!(std::fs::read(&kept).unwrap(), original);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Positive control for the two cases above: a *readable* session file is
    /// loaded in place — nothing is moved aside.
    #[tokio::test]
    async fn a_readable_session_file_is_loaded_in_place_with_no_aside() {
        let dir = tmp_dir("readable");
        let path = dir.join("sessions.json");
        let manager = SessionManager::default();
        let id = manager.create("model1".to_string()).await;
        manager.save(&path).await.expect("save");

        let loaded = SessionManager::load(&path);
        assert!(loaded.get(&id).await.is_some(), "the session survived");
        assert!(
            corrupt_aside(&dir).is_none(),
            "a file that parsed is never moved aside"
        );
        assert!(path.exists(), "the live path is left where it was");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Negative control, disjoint from the two aside cases: a **missing** file is
    /// not corruption. There is nothing to keep, so no aside is written and no
    /// warning is emitted — the honest first-run default.
    #[tokio::test]
    async fn a_missing_session_file_keeps_nothing_aside_and_stays_silent() {
        let dir = tmp_dir("missing");
        let path = dir.join("sessions.json");

        let warns = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let loaded = {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            SessionManager::load(&path)
        };
        assert_eq!(loaded.count_active().await, 0);
        assert_eq!(
            warns.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "an absent file is the honest first-run default, not a finding"
        );
        assert!(corrupt_aside(&dir).is_none(), "nothing to keep aside");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
