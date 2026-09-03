//! Shared cross-window key/value store (multi-window step 3) — now **durable**.
//!
//! Settings / notifications are no longer purely per-webview `localStorage`:
//! every write is mirrored here (the shared `State`) and broadcast to all
//! windows as a `store-updated` event, so changing WiFi in the Settings window
//! instantly reflects in the launcher's Notification Center quick toggles.
//!
//! The frontend keeps `localStorage` as a synchronous cache (for snappy UI and
//! the headless bun test harness) and writes through to this store; remote
//! updates are applied locally via the event. See `docs/multi-window.md` §3.
//!
//! Since (2026-09-03) the store is also **persisted to disk**: every mutation
//! writes back to `$AMOS_STATE_FILE` (default `~/.amos/state.json`), so state
//! survives restarts and is readable by Rust services — not trapped in one
//! WebView's localStorage.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Payload broadcast on every mutation.
#[derive(Clone, Serialize)]
pub struct StoreUpdated {
    pub key: String,
    /// `None` means the key was removed.
    pub value: Option<String>,
}

/// The event name the frontend subscribes to.
pub const STORE_UPDATED_EVENT: &str = "store-updated";

/// File used when `AMOS_STATE_FILE` is unset: `~/.amos/state.json`.
const DEFAULT_RELATIVE: &str = ".amos/state.json";

/// Thread-safe shared key/value store — the **durable** source of truth for the
/// `amos.*` keys the frontend writes through (`amos.settings`, notifications,
/// home layout, …). It mirrors every mutation to a JSON file on disk so state
/// survives restarts *and* is readable by Rust services (not just localStorage
/// inside one WebView).
pub struct SharedStore {
    inner: Mutex<HashMap<String, String>>,
    /// JSON file backing the store (`None` = memory-only, e.g. tests).
    path: Option<PathBuf>,
}

/// Resolve the persistence file: `AMOS_STATE_FILE` wins, then `~/.amos/state.json`
/// (via `$HOME`), else memory-only.
fn resolve_state_file() -> Option<PathBuf> {
    if let Some(p) = std::env::var("AMOS_STATE_FILE")
        .ok()
        .filter(|s| !s.is_empty())
    {
        return Some(PathBuf::from(p));
    }
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(|home| Path::new(&home).join(DEFAULT_RELATIVE))
}

impl Default for SharedStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SharedStore {
    /// Load the store from `AMOS_STATE_FILE` (or `~/.amos/state.json`). Every
    /// mutation is written back, so state survives restarts.
    pub fn new() -> Self {
        match resolve_state_file() {
            Some(path) => Self::from_file(&path),
            None => Self::memory(),
        }
    }

    /// An empty, in-memory-only store (tests / no writable home).
    pub fn memory() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            path: None,
        }
    }

    /// Load (or start empty at) `path`, persisting every mutation there.
    pub fn from_file(path: &Path) -> Self {
        let inner = if path.exists() {
            match fs::read(path)
                .ok()
                .and_then(|b| serde_json::from_slice::<HashMap<String, String>>(&b).ok())
            {
                Some(map) => map,
                None => {
                    tracing::warn!(
                        "state file {} unreadable/corrupt; starting empty",
                        path.display()
                    );
                    HashMap::new()
                }
            }
        } else {
            HashMap::new()
        };
        Self {
            inner: Mutex::new(inner),
            path: Some(path.to_path_buf()),
        }
    }

    /// The backing file path, if any.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Read a value (used by the `store_get` command / hydration).
    pub fn get(&self, key: &str) -> Option<String> {
        self.inner.lock().ok()?.get(key).cloned()
    }

    /// Snapshot of all keys (used by a freshly-opened window to hydrate).
    pub fn snapshot(&self) -> HashMap<String, String> {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// Mutate + persist without broadcasting (Rust services can use this even
    /// without an `AppHandle`).
    pub fn insert(&self, key: &str, value: String) {
        if let Ok(mut g) = self.inner.lock() {
            g.insert(key.to_string(), value);
        }
        self.persist();
    }

    /// Mutate + persist without broadcasting (Rust services can use this even
    /// without an `AppHandle`).
    pub fn remove_key(&self, key: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(key);
        }
        self.persist();
    }

    /// Write a value, persist, and broadcast the change to every window.
    pub fn set(&self, app: &AppHandle, key: &str, value: String) {
        self.insert(key, value.clone());
        let _ = app.emit(
            STORE_UPDATED_EVENT,
            StoreUpdated {
                key: key.to_string(),
                value: Some(value),
            },
        );
    }

    /// Remove a key, persist, and broadcast the change to every window.
    pub fn remove(&self, app: &AppHandle, key: &str) {
        self.remove_key(key);
        let _ = app.emit(
            STORE_UPDATED_EVENT,
            StoreUpdated {
                key: key.to_string(),
                value: None,
            },
        );
    }

    /// Best-effort write of the whole map as pretty JSON to the backing file.
    fn persist(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let bytes = self
            .inner
            .lock()
            .ok()
            .and_then(|g| serde_json::to_vec_pretty(&*g).ok());
        let Some(bytes) = bytes else {
            tracing::warn!("failed to serialize state for {}", path.display());
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Err(e) = fs::write(path, bytes) {
            tracing::warn!("failed to persist state to {}: {e}", path.display());
        }
    }
}

/// Tauri command: read a single key.
#[tauri::command]
pub fn store_get(state: State<'_, SharedStore>, key: String) -> Option<String> {
    state.get(&key)
}

/// Tauri command: write a key (broadcasts `store-updated`).
#[tauri::command]
pub fn store_set(app: AppHandle, state: State<'_, SharedStore>, key: String, value: String) {
    state.set(&app, &key, value);
}

/// Tauri command: remove a key (broadcasts `store-updated`).
#[tauri::command]
pub fn store_remove(app: AppHandle, state: State<'_, SharedStore>, key: String) {
    state.remove(&app, &key);
}

/// Tauri command: snapshot the whole store (window hydration on boot).
#[tauri::command]
pub fn store_snapshot(state: State<'_, SharedStore>) -> HashMap<String, String> {
    state.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "amos-store-{tag}-{}-{nonce}.json",
            std::process::id()
        ))
    }

    #[test]
    fn get_insert_delete_snapshot_roundtrip() {
        let s = SharedStore::memory();
        assert_eq!(s.get("amos.settings"), None, "missing key is None");
        s.insert("amos.settings", "{\"wifi\":true}".into());
        assert_eq!(
            s.get("amos.settings").as_deref(),
            Some("{\"wifi\":true}"),
            "insert then get"
        );
        let snap = s.snapshot();
        assert_eq!(snap.len(), 1, "snapshot has one key");
        assert_eq!(
            snap.get("amos.settings").map(String::as_str),
            Some("{\"wifi\":true}")
        );
        s.remove_key("amos.settings");
        assert_eq!(s.get("amos.settings"), None, "delete removes the key");
    }

    #[test]
    fn snapshot_covers_multiple_keys() {
        let s = SharedStore::memory();
        s.insert("amos.settings", "{}".into());
        s.insert("amos.notifications", "[]".into());
        let snap = s.snapshot();
        assert_eq!(snap.len(), 2, "both keys present");
        assert!(snap.contains_key("amos.notifications"));
    }

    #[test]
    fn state_persists_across_store_instances() {
        let path = temp_path("persist");
        // Write on one store…
        {
            let s = SharedStore::from_file(&path);
            assert!(s.path().is_some());
            s.insert("amos.settings", "{\"wifi\":true,\"dark\":1}".into());
            s.insert("amos.notifications", "[{\"id\":1}]".into());
        }
        // …and a fresh store over the same file sees it (restart durability).
        {
            let again = SharedStore::from_file(&path);
            assert_eq!(
                again.get("amos.settings").as_deref(),
                Some("{\"wifi\":true,\"dark\":1}"),
                "settings survive a restart"
            );
            assert!(again.get("amos.notifications").is_some());
        }
        // Removal also persists.
        {
            let once = SharedStore::from_file(&path);
            once.remove_key("amos.notifications");
        }
        {
            let thrice = SharedStore::from_file(&path);
            assert_eq!(thrice.get("amos.notifications"), None, "removal persisted");
            assert!(thrice.get("amos.settings").is_some());
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_state_file_starts_empty_without_panicking() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "{ not valid json !").unwrap();
        let s = SharedStore::from_file(&path);
        assert!(s.snapshot().is_empty(), "corrupt file → empty store");
        // A subsequent write repairs it.
        s.insert("amos.settings", "{}".into());
        let again = SharedStore::from_file(&path);
        assert_eq!(again.get("amos.settings").as_deref(), Some("{}"));
        let _ = std::fs::remove_file(&path);
    }
}
