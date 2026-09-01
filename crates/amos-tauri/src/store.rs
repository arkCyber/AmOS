//! Shared cross-window key/value store (multi-window step 3).
//!
//! Settings / notifications are no longer purely per-webview `localStorage`:
//! every write is mirrored here (the shared `State`) and broadcast to all
//! windows as a `store-updated` event, so changing WiFi in the Settings window
//! instantly reflects in the launcher's Notification Center quick toggles.
//!
//! The frontend keeps `localStorage` as a synchronous cache (for snappy UI and
//! the headless bun test harness) and writes through to this store; remote
//! updates are applied locally via the event. See `docs/multi-window.md` §3.

use std::collections::HashMap;
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

/// Thread-safe shared key/value store (source of truth across windows).
pub struct SharedStore {
    inner: Mutex<HashMap<String, String>>,
}

impl Default for SharedStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SharedStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Read a value (used by the `store_get` command / hydration).
    pub fn get(&self, key: &str) -> Option<String> {
        self.inner.lock().ok()?.get(key).cloned()
    }

    /// Snapshot of all keys (used by a freshly-opened window to hydrate).
    pub fn snapshot(&self) -> HashMap<String, String> {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// Write a value and broadcast the change to every window.
    pub fn set(&self, app: &AppHandle, key: &str, value: String) {
        if let Ok(mut g) = self.inner.lock() {
            g.insert(key.to_string(), value.clone());
        }
        let _ = app.emit(
            STORE_UPDATED_EVENT,
            StoreUpdated {
                key: key.to_string(),
                value: Some(value),
            },
        );
    }

    /// Remove a key and broadcast the change to every window.
    pub fn remove(&self, app: &AppHandle, key: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(key);
        }
        let _ = app.emit(
            STORE_UPDATED_EVENT,
            StoreUpdated {
                key: key.to_string(),
                value: None,
            },
        );
    }

    #[cfg(test)]
    fn insert_local(&self, key: &str, value: String) {
        if let Ok(mut g) = self.inner.lock() {
            g.insert(key.to_string(), value);
        }
    }

    #[cfg(test)]
    fn delete_local(&self, key: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(key);
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

    #[test]
    fn get_insert_delete_snapshot_roundtrip() {
        let s = SharedStore::new();
        assert_eq!(s.get("amos.settings"), None, "missing key is None");
        s.insert_local("amos.settings", "{\"wifi\":true}".into());
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
        s.delete_local("amos.settings");
        assert_eq!(s.get("amos.settings"), None, "delete removes the key");
    }

    #[test]
    fn snapshot_covers_multiple_keys() {
        let s = SharedStore::new();
        s.insert_local("amos.settings", "{}".into());
        s.insert_local("amos.notifications", "[]".into());
        let snap = s.snapshot();
        assert_eq!(snap.len(), 2, "both keys present");
        assert!(snap.contains_key("amos.notifications"));
    }
}
