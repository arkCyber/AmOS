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

/// The store key for the currently focused app label (desktop TopBar reads this).
///
/// This is the **only** channel for that fact: `SharedStore::set` broadcasts
/// `store-updated` to every window and the desktop chrome re-renders from the key.
/// A dedicated `app-focused-changed` event used to sit next to it and was removed
/// (REQ-A254) — `scripts/tauri-event-scan.mjs` flagged it as "emitted by the host
/// but no screen subscribes to it", which is exactly what it was.
pub const APP_FOCUSED_KEY: &str = "amos.app_focused";

/// File used when `AMOS_STATE_FILE` is unset: `~/.amos/state.json`.
const DEFAULT_RELATIVE: &str = ".amos/state.json";

/// Maximum bytes in one store value written via `store_set`.
///
/// The state file (`~/.amos/state.json`) is loaded on every boot and parsed as JSON.
/// A value much larger than this would make boot slow and could exhaust memory on a
/// low-end device. 256 KiB comfortably covers any real settings payload (toggle
/// states, layout hints, notification counts); the few legitimately large values (e.g.
/// a screenshot preview in a notification) should use a file path key instead.
pub const MAX_STORE_VALUE_BYTES: usize = 256 << 10;

/// Maximum bytes in a store key.
///
/// Real keys look like `amos.app_focused`, `amos.wifi`, `<16 chars>` — well under
/// 256 B. The cap protects the JSON state file's key space from a paste-sized
/// caller (every key is loaded on every boot, so megabyte keys make boot slow
/// even though each one individually is tiny).
pub const MAX_STORE_KEY_BYTES: usize = 256;

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
    ///
    /// A *poisoned* lock (a handler panicked while holding it) is not an absent key: the
    /// value is still in the map, so the guard is taken with
    /// [`std::sync::PoisonError::into_inner`] — the same rule the other bridges use. `.ok()`
    /// here used to report every key as missing after any panic anywhere in the store.
    pub fn get(&self, key: &str) -> Option<String> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(key)
            .cloned()
    }

    /// Snapshot of all keys (used by a freshly-opened window to hydrate).
    pub fn snapshot(&self) -> HashMap<String, String> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).clone()
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
        // A failed broadcast means a registered listener missed the update (no listener is
        // `Ok` in Tauri) — the other windows would silently keep the stale value.
        if let Err(e) = app.emit(
            STORE_UPDATED_EVENT,
            StoreUpdated {
                key: key.to_string(),
                value: Some(value),
            },
        ) {
            tracing::warn!(
                target: "amos::store",
                event = STORE_UPDATED_EVENT,
                key,
                error = %e,
                "store update could not be broadcast to the other windows"
            );
        }
    }

    /// Remove a key, persist, and broadcast the change to every window.
    pub fn remove(&self, app: &AppHandle, key: &str) {
        self.remove_key(key);
        if let Err(e) = app.emit(
            STORE_UPDATED_EVENT,
            StoreUpdated {
                key: key.to_string(),
                value: None,
            },
        ) {
            tracing::warn!(
                target: "amos::store",
                event = STORE_UPDATED_EVENT,
                key,
                error = %e,
                "store removal could not be broadcast to the other windows"
            );
        }
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
            // Saying *why* matters here: the write below fails too when the directory is
            // missing, and "No such file or directory" alone does not tell the operator
            // that it was the directory creation that was refused (same rule the
            // blocklist and the input-method profile follow).
            if let Err(e) = fs::create_dir_all(dir) {
                tracing::warn!(
                    "could not create the store directory {}: {e}",
                    dir.display()
                );
            }
        }
        if let Err(e) = fs::write(path, bytes) {
            tracing::warn!("failed to persist state to {}: {e}", path.display());
        }
    }
}

/// The JSON **object** stored at `key`, for a *merge*, plus whether a value was present but
/// could not be used.
///
/// The two empty cases are not the same and must not be treated alike:
///
/// * **no value** → this is the first write; merging into a fresh object is right, and
///   nothing can be lost;
/// * **a value that is not a JSON object** (corrupt, or a legacy scalar) → the keys this
///   function cannot see *will be dropped* by whoever merges into the returned map.
///
/// Both used to collapse into `None`, so a corrupt `amos.settings` silently wiped every
/// other quick-toggle (darkmode / dnd / location / wallpaper) on the next radio or torch
/// change. Callers report the second case instead of losing the user's settings quietly.
pub fn object_for_merge(
    store: &SharedStore,
    key: &str,
) -> (serde_json::Map<String, serde_json::Value>, bool) {
    let Some(raw) = store.get(key) else {
        return (serde_json::Map::new(), false);
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(m)) => (m, false),
        _ => (serde_json::Map::new(), true),
    }
}

/// Tauri command: read a single key.
#[tauri::command]
pub fn store_get(state: State<'_, SharedStore>, key: String) -> Option<String> {
    if !check_store_key(&key) {
        return None;
    }
    state.get(&key)
}

/// Tauri command: write a key (broadcasts `store-updated`).
#[tauri::command]
pub fn store_set(app: AppHandle, state: State<'_, SharedStore>, key: String, value: String) {
    // Bound the value at the command seam so a misbehaving / malicious frontend
    // cannot inflate the state file to tens of megabytes and slow boot.
    if value.len() > MAX_STORE_VALUE_BYTES {
        tracing::warn!(
            target: "amos::store",
            key = %key,
            bytes = value.len(),
            "store value capped — use a file path key for large payloads"
        );
        return;
    }
    if !check_store_key(&key) {
        return;
    }
    state.set(&app, &key, value);
}

/// Tauri command: remove a key (broadcasts `store-updated`).
#[tauri::command]
pub fn store_remove(app: AppHandle, state: State<'_, SharedStore>, key: String) {
    if !check_store_key(&key) {
        return;
    }
    state.remove(&app, &key);
}

/// Bound a store key at the command seam — the key is reused in every JSON
/// read/write of the durable state file, so a paste-sized key would inflate
/// every iteration of the on-disk store. The same `valid` predicate is shared
/// by `store_get` / `_set` / `_remove` so a refused key is a consistent no-op
/// regardless of which command reaches it (real call sites only call one).
fn check_store_key(key: &str) -> bool {
    if key.is_empty() || key.len() > MAX_STORE_KEY_BYTES {
        return false;
    }
    // A control-character key would corrupt the JSON file (it is loaded as JSON
    // on every boot; escaped control chars are legal but useless).
    if key.chars().any(|c| c.is_control()) {
        return false;
    }
    true
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
    fn a_merge_tells_apart_missing_from_unusable_state() {
        use serde_json::json;

        let s = SharedStore::memory();
        // Nothing stored yet: the first write, and nothing can be lost.
        assert_eq!(
            object_for_merge(&s, "amos.settings"),
            (Default::default(), false)
        );

        s.insert("amos.settings", r#"{"darkmode":true,"dnd":false}"#.into());
        let (m, unusable) = object_for_merge(&s, "amos.settings");
        assert!(!unusable, "a JSON object is usable");
        assert_eq!(m.get("darkmode"), Some(&json!(true)));

        // Present but *not* an object (corrupt, or a legacy scalar): the keys it should have
        // carried cannot be preserved, and that is what the caller has to report.
        for raw in ["dark", "42", "[1,2]", "{oops", ""] {
            s.insert("amos.settings", raw.into());
            let (m, unusable) = object_for_merge(&s, "amos.settings");
            assert!(unusable, "{raw:?} is present but unusable");
            assert!(m.is_empty());
        }
    }

    #[test]
    fn a_poisoned_lock_does_not_make_values_look_absent() {
        let s = SharedStore::memory();
        s.insert("amos.settings", "{}".into());

        // Poison the lock the way a panicking command handler would.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = s.inner.lock().unwrap_or_else(|p| p.into_inner());
            panic!("a handler panicked while holding the store lock");
        }));
        assert!(s.inner.is_poisoned(), "the lock must really be poisoned");

        // The value is still in the map: "missing" would be a claim about the user's data.
        assert_eq!(s.get("amos.settings").as_deref(), Some("{}"));
        assert_eq!(s.snapshot().len(), 1);
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

    /// `check_store_key` is the single gate for the durable JSON store's keys;
    /// accept well-formed settings keys and refuse empty / oversized / control
    /// ones so a paste-sized JS caller cannot inflate the state file.
    #[test]
    fn store_keys_are_bounded_at_the_command_seam() {
        for ok in [
            "amos.app_focused",
            "amos.wifi",
            "settings.notifications.dnd",
            "x".repeat(MAX_STORE_KEY_BYTES).as_str(),
        ] {
            assert!(
                check_store_key(ok),
                "real key {ok:?} (≤{MAX_STORE_KEY_BYTES} bytes) is accepted"
            );
        }
        // Empty is never a valid store key.
        assert!(!check_store_key(""));
        // Past the byte cap.
        let huge = "x".repeat(MAX_STORE_KEY_BYTES + 1);
        assert!(!check_store_key(&huge));
        // Control characters cannot be a valid JSON key fragment.
        assert!(!check_store_key("amos.\nbad"));
        assert!(!check_store_key("amos.\0bad"));
    }
}
