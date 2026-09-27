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
use tauri::{AppHandle, Emitter, Runtime, State};

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

/// The store key for the shell's UI language, stored **raw** (`"zh"` / `"en"`).
///
/// Two Rust readers sit on this key and neither can see the other: the native menu bar
/// (`menu::stored_locale`, REQ-A437) and the system tray (`tray::stored_locale`, REQ-A864).
/// They were written as two literals with a comment promising they matched, which is a
/// promise only a reader can keep; the key is a value here so the compiler keeps it. The
/// frontend writes it through the same string (`locale.svelte.ts`) — that half is checked
/// by `i18n-scan`, which is why the key is *not* duplicated in the locales.
pub const LOCALE_KEY: &str = "amos-ui.locale";

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
    resolve_state_file_from(
        std::env::var_os("AMOS_STATE_FILE"),
        std::env::var_os("HOME"),
    )
}

/// Pure resolution of the persistence file (both raw values are injected so
/// every arm is reachable in a test). The knob is read as **three** facts, not
/// two: an **absent** (or blank) `AMOS_STATE_FILE` falls through to `$HOME`,
/// and an absent `$HOME` is the documented memory-only fallback — both silent;
/// a value the operator *did* set but which cannot be read as UTF-8 is reported
/// once, then treated as absent, so an unreadable path is never silently
/// mistaken for "no state file" (which would make the whole durable `amos.*`
/// map memory-only). (REQ-A2011 / F-SH-956)
fn resolve_state_file_from(
    file: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    resolve_state_file_with("AMOS_STATE_FILE", "HOME", file, home)
}

/// The key names are parameters as well as the raw values, so a test can drive
/// every arm — including the warn-once dedup table — without touching the
/// process environment or colliding with a sibling test's key.
fn resolve_state_file_with(
    state_key: &str,
    home_key: &str,
    file: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if let Some(p) = usable_path(state_key, file) {
        return Some(PathBuf::from(p));
    }
    usable_path(home_key, home).map(|h| Path::new(&h).join(DEFAULT_RELATIVE))
}

/// Pure three-state read of one path knob: **absent** (or blank) ⇒ `None`
/// silently; a **usable** path ⇒ `Some`; a value that *is* present but cannot be
/// read as UTF-8 ⇒ reported once, then `None`.
fn usable_path(key: &str, raw: Option<std::ffi::OsString>) -> Option<String> {
    let raw = raw?;
    match raw.into_string() {
        Ok(s) if !s.is_empty() => Some(s),
        // Blank is a legitimate "unset": silent.
        Ok(_) => None,
        Err(_) => {
            report_unusable_state_path(key);
            None
        }
    }
}

fn unusable_state_path_seen() -> &'static Mutex<std::collections::BTreeSet<(String, String)>> {
    static SEEN: std::sync::OnceLock<Mutex<std::collections::BTreeSet<(String, String)>>> =
        std::sync::OnceLock::new();
    SEEN.get_or_init(Default::default)
}

#[cfg(test)]
fn unusable_state_path_reports_for(key: &str) -> usize {
    unusable_state_path_seen()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|(k, _)| k == key)
        .count()
}

fn report_unusable_state_path(key: &str) {
    let first = unusable_state_path_seen()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert((key.to_owned(), "<non-Unicode>".to_owned()));
    if first {
        tracing::warn!(
            env = key,
            "amos-tauri: a state-path variable is set but is not valid Unicode; ignoring it — \
             fix or unset the variable"
        );
    }
}

/// Move a state file that could not be read back aside so the store's next write
/// cannot overwrite it.
///
/// This store is the **whole** durable `amos.*` map: every mutation rewrites the
/// entire file (`persist` above), so starting empty *on top of* an unparseable file
/// would replace every key the user ever set with whatever the first `store_set`
/// happens to carry. The bytes are kept beside the original instead. `None` when
/// there was nothing to keep (no file) or when the rename failed — the caller warns
/// either way and still starts empty.
fn preserve_unreadable_state(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let kept = path.with_extension(format!("corrupt-{nonce}"));
    fs::rename(path, &kept).ok().map(|()| kept)
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
    ///
    /// A file that will not parse is **moved aside** before we start empty: the store
    /// rewrites the whole map on every mutation, so an in-place "start empty" would let
    /// the first `store_set` destroy every key the file still held (`preserve_unreadable_state`).
    pub fn from_file(path: &Path) -> Self {
        let inner = if path.exists() {
            match fs::read(path)
                .ok()
                .and_then(|b| serde_json::from_slice::<HashMap<String, String>>(&b).ok())
            {
                Some(map) => map,
                None => {
                    match preserve_unreadable_state(path) {
                        Some(kept) => tracing::warn!(
                            "state file {} unreadable/corrupt; kept at {} and starting empty",
                            path.display(),
                            kept.display()
                        ),
                        None => tracing::warn!(
                            "state file {} unreadable/corrupt; could not be moved aside, starting empty",
                            path.display()
                        ),
                    }
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
    ///
    /// The guard is taken the same way [`Self::get`] takes it: a *poisoned* lock is not a
    /// refusal to write. The map is still there, and dropping the mutation here would make
    /// the durable mirror silently disagree with what the writer thinks it stored (the
    /// frontend broadcasts the new value to every window and keeps it in `localStorage`,
    /// while the next boot's hydration copies the *stale* snapshot back over it).
    /// REQ-A1474.
    pub fn insert(&self, key: &str, value: String) {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key.to_string(), value);
        self.persist();
    }

    /// Mutate + persist without broadcasting (Rust services can use this even
    /// without an `AppHandle`). Same poisoned-lock rule as [`Self::insert`].
    pub fn remove_key(&self, key: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key);
        self.persist();
    }

    /// Write a value, persist, and broadcast the change to every window.
    ///
    /// Generic over the runtime for the same reason `close_target` in `wm.rs` is: the
    /// window-manager paths that write this key are generic (REQ-A473 made `apply`
    /// runtime-generic so the mock runtime can drive identity tests), and a
    /// `Wry`-only signature here would have forced one of them back to a concrete runtime.
    pub fn set<R: Runtime>(&self, app: &AppHandle<R>, key: &str, value: String) {
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
    ///
    /// The snapshot is taken under the same poisoned-lock rule as [`Self::get`]: `.ok()`
    /// here would make every write after a panic invisible on disk while the in-memory map
    /// still held them, so the two stores would drift apart and the file would win on the
    /// next boot.
    ///
    /// The write itself goes through [`write_atomic`], not `fs::write`: this file is
    /// rewritten in full on *every* mutation, so a torn write would corrupt the one copy
    /// of the whole durable map — and the read-side preservation (F-SH-927) only protects a
    /// file that is still intact enough to be moved aside.
    fn persist(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let bytes = {
            let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            serde_json::to_vec_pretty(&*g).ok()
        };
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
        if let Err(e) = write_atomic(path, &bytes) {
            tracing::warn!("failed to persist state to {}: {e}", path.display());
        }
    }
}

/// Replace `path` with `bytes` atomically: write a sibling temp file, then `rename` it
/// onto the target.
///
/// A plain `fs::write` truncates the destination in place, so a torn write (power loss,
/// full disk, a crash between the truncate and the write) leaves a **partial** state file
/// at `path`. Because this file is rewritten on *every* mutation, the next boot parses the
/// wreckage, starts empty, and then the next `store_set` overwrites it — destroying the one
/// copy of the whole durable map. `rename` within a directory is atomic on POSIX, so a
/// concurrent reader sees either the complete previous snapshot or the complete new one,
/// never a truncated prefix. The temp must sit **beside** the target (not in
/// `std::env::temp_dir()`), or the rename could cross a filesystem boundary and silently
/// degrade back to copy-then-delete. The `.json.tmp` suffix keeps it from colliding with
/// the `*.corrupt-*` siblings the read path writes (F-SH-927). (REQ-A1944 / F-SH-940.)
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
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

    /// The read half of this rule is pinned above; this is the **write** half. A poisoned
    /// lock is not a refusal to write — the map is intact (as `get`/`snapshot` already
    /// agree), so dropping the mutation silently diverges the durable mirror from what the
    /// frontend stored and broadcast: on the next boot `hydrateFromSystemStore` copies the
    /// stale snapshot back over the user's writes.
    #[test]
    fn a_poisoned_lock_does_not_swallow_a_write() {
        let path = temp_path("poison-write");
        let s = SharedStore::from_file(&path);
        s.insert("amos.settings", "{}".into());

        // Poison the lock the way a panicking command handler would.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = s.inner.lock().unwrap_or_else(|p| p.into_inner());
            panic!("a handler panicked while holding the store lock");
        }));
        assert!(s.inner.is_poisoned(), "the lock must really be poisoned");

        s.insert("amos.wifi", "{\"on\":true}".into());
        assert_eq!(
            s.get("amos.wifi").as_deref(),
            Some("{\"on\":true}"),
            "an insert under poison still inserts"
        );
        s.remove_key("amos.settings");
        assert_eq!(
            s.get("amos.settings"),
            None,
            "a removal under poison still removes"
        );
        // The disk half matters too: `persist` takes the same lock, so a poison that only
        // skipped the file write would leave the two stores divergent.
        let again = SharedStore::from_file(&path);
        assert_eq!(
            again.get("amos.wifi").as_deref(),
            Some("{\"on\":true}"),
            "the write reached the file"
        );
        assert_eq!(
            again.get("amos.settings"),
            None,
            "the removal reached the file"
        );
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

    /// The `<stem>.corrupt-*` sibling of `path`, if one was kept beside it.
    ///
    /// Matched on the **stem** rather than by scanning the directory for "corrupt-":
    /// every test in this module shares one temp dir, so a directory-wide search could
    /// pick up a sibling test's kept file and make this one pass for the wrong reason.
    fn kept_aside(path: &Path) -> Option<PathBuf> {
        let stem = path.file_stem()?.to_string_lossy().into_owned();
        let prefix = format!("{stem}.corrupt-");
        std::fs::read_dir(path.parent()?)
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with(&prefix))
            })
    }

    /// A state file that cannot be read back must be **moved aside**, never left where the
    /// store's next write would overwrite it: every mutation rewrites the *whole* map, so
    /// starting empty *on top of* the user's file replaces their entire durable state with
    /// whatever the first `store_set` happens to carry (REQ-A1925 / F-SH-927).
    #[test]
    fn an_unreadable_state_file_is_preserved_not_silently_overwritten() {
        let path = temp_path("corrupt-preserved");
        std::fs::write(&path, "{ not valid json !").unwrap();

        let s = SharedStore::from_file(&path);
        assert!(s.snapshot().is_empty(), "a corrupt file still starts empty");
        assert!(
            !path.exists(),
            "the corrupt state file must be moved aside, not left to be overwritten"
        );
        let kept =
            kept_aside(&path).expect("the corrupt state file was kept under a corrupt-* name");
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"{ not valid json !",
            "the user's bytes survive intact"
        );

        // The next mutation makes a *fresh* file at the original path — beside, not over,
        // the kept one.
        s.insert("amos.settings", "{}".into());
        assert!(
            path.exists(),
            "a fresh state file is written at the original path"
        );
        assert!(kept.exists(), "and the preserved bytes are still there");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&kept);
    }

    /// A reader that opened the state file **before** a mutation must still read the
    /// complete **previous** snapshot afterwards.
    ///
    /// `fs::write` truncates the file it is handed, so the old in-place persist left
    /// any such reader staring at an empty or half-written buffer — the classic torn
    /// read, and here the file is the whole `amos.*` map. Replacing it through a temp
    /// sibling and `rename` swaps the directory entry and leaves the old inode, and
    /// its readers, untouched. This is the observable face of "atomic": a unit test
    /// cannot crash the process inside `persist`, but it can hold the file open across
    /// it (REQ-A1944 / F-SH-940).
    #[test]
    fn a_persist_leaves_an_open_reader_on_the_complete_previous_snapshot() {
        use std::io::Read as _;

        let path = temp_path("atomic-open-reader");
        std::fs::write(&path, br#"{"a":"1"}"#).unwrap();
        let store = SharedStore::from_file(&path);

        // Pin the pre-write inode across the mutation.
        let mut reader = std::fs::File::open(&path).unwrap();
        store.insert("b", "2".into());

        let mut seen = String::new();
        reader.read_to_string(&mut seen).unwrap();
        assert_eq!(
            seen, r#"{"a":"1"}"#,
            "an in-place write truncates the file under the reader; an atomic replace does not"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// Positive control for the atomic replace: the temp sibling is renamed onto the
    /// target, so it must not survive the write. A fix that wrote the temp and forgot
    /// the `rename` would fail here (and would leave `state.json` stale).
    #[test]
    fn a_persist_leaves_no_temp_sibling_behind() {
        let path = temp_path("atomic-no-tmp");
        let store = SharedStore::from_file(&path);
        store.insert("amos.settings", "{}".into());

        assert!(path.exists(), "the state file is written");
        assert!(
            !path.with_extension("json.tmp").exists(),
            "the temp file is renamed away, never left beside the state file"
        );
        let again = SharedStore::from_file(&path);
        assert_eq!(
            again.get("amos.settings").as_deref(),
            Some("{}"),
            "the renamed file is the new state"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// Positive control: a file that *parses* is loaded in place and nothing is moved
    /// aside, so the fix cannot degenerate into "rename every state file".
    #[test]
    fn a_readable_state_file_is_loaded_without_being_moved_aside() {
        let path = temp_path("readable");
        SharedStore::from_file(&path).insert("amos.settings", "{\"wifi\":true}".into());

        let again = SharedStore::from_file(&path);
        assert_eq!(
            again.get("amos.settings").as_deref(),
            Some("{\"wifi\":true}"),
            "a readable state file is loaded, not discarded"
        );
        assert!(path.exists(), "a readable state file stays in place");
        assert!(
            kept_aside(&path).is_none(),
            "nothing is moved aside when the file parses"
        );

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

    #[cfg(unix)]
    fn non_unicode(raw: &[u8]) -> std::ffi::OsString {
        use std::os::unix::ffi::OsStringExt;
        std::ffi::OsString::from_vec(raw.to_vec())
    }

    #[test]
    fn an_unset_state_file_and_home_are_memory_only_and_silent() {
        let resolved = resolve_state_file_with("TEST_SF_NONE", "TEST_HOME_NONE", None, None);
        assert_eq!(resolved, None);
        assert_eq!(unusable_state_path_reports_for("TEST_SF_NONE"), 0);
        assert_eq!(unusable_state_path_reports_for("TEST_HOME_NONE"), 0);
    }

    #[test]
    fn a_blank_state_file_falls_through_to_home() {
        let resolved = resolve_state_file_with(
            "TEST_SF_BLANK",
            "TEST_HOME_BLANK",
            Some("".into()),
            Some("/home/op".into()),
        );
        assert_eq!(
            resolved,
            Some(PathBuf::from("/home/op").join(DEFAULT_RELATIVE))
        );
        assert_eq!(
            unusable_state_path_reports_for("TEST_SF_BLANK"),
            0,
            "a blank AMOS_STATE_FILE is a legitimate 'unset', not a reportable one"
        );
    }

    #[test]
    fn a_usable_state_file_wins_over_home() {
        let resolved = resolve_state_file_with(
            "TEST_SF_OK",
            "TEST_HOME_OK",
            Some("/var/amos/state.json".into()),
            Some("/home/op".into()),
        );
        assert_eq!(resolved, Some(PathBuf::from("/var/amos/state.json")));
        assert_eq!(unusable_state_path_reports_for("TEST_SF_OK"), 0);
    }

    #[test]
    fn a_usable_home_is_the_documented_relative_default() {
        let resolved = resolve_state_file_with(
            "TEST_SF_HOME",
            "TEST_HOME_OK2",
            None,
            Some("/home/op".into()),
        );
        assert_eq!(
            resolved,
            Some(Path::new("/home/op").join(DEFAULT_RELATIVE)),
            "an unset AMOS_STATE_FILE under a usable HOME is ~/.amos/state.json"
        );
        assert_eq!(unusable_state_path_reports_for("TEST_HOME_OK2"), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_non_unicode_state_file_is_reported_not_read_as_unset() {
        let resolved = resolve_state_file_with(
            "TEST_SF_MOJIBAKE",
            "TEST_HOME_MOJIBAKE",
            Some(non_unicode(b"/var/amos/\xff-state.json")),
            Some("/home/op".into()),
        );
        assert_eq!(
            resolved,
            Some(Path::new("/home/op").join(DEFAULT_RELATIVE)),
            "an unreadable AMOS_STATE_FILE still falls back to HOME"
        );
        assert_eq!(
            unusable_state_path_reports_for("TEST_SF_MOJIBAKE"),
            1,
            "a set-but-unreadable AMOS_STATE_FILE must be reported, not silently read as unset"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_non_unicode_home_is_reported_not_read_as_memory_only() {
        let resolved = resolve_state_file_with(
            "TEST_SF_HOME_NONE",
            "TEST_HOME_MOJIBAKE",
            None,
            Some(non_unicode(b"/home/\xfe")),
        );
        assert_eq!(resolved, None);
        assert_eq!(
            unusable_state_path_reports_for("TEST_HOME_MOJIBAKE"),
            1,
            "a set-but-unreadable HOME must be reported, not silently degrade to memory-only"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_repeated_bad_state_path_is_reported_once() {
        let key = "TEST_SF_DEDUP";
        let _ =
            resolve_state_file_with(key, "TEST_HOME_DEDUP", Some(non_unicode(b"\xfe\xff")), None);
        let _ =
            resolve_state_file_with(key, "TEST_HOME_DEDUP", Some(non_unicode(b"\xfe\xff")), None);
        assert_eq!(unusable_state_path_reports_for(key), 1);
    }

    /// The production reader must inject the raw `OsString` for **both** keys:
    /// a `std::env::var(..)` read can never see the `NotUnicode` case, so a
    /// non-Unicode state path would silently degrade the whole durable store.
    #[test]
    fn the_state_file_reader_injects_both_raw_values_via_var_os() {
        let src = include_str!("store.rs");
        assert!(src.contains("std::env::var_os(\"AMOS_STATE_FILE\")"));
        assert!(src.contains("std::env::var_os(\"HOME\")"));
        // The needles are assembled at run time so this test's *own* literals do
        // not satisfy the `include_str!` scan it performs (a self-referential
        // corpus).
        for var in ["AMOS_STATE_FILE", "HOME"] {
            let folded = format!("std::env::var(\"{var}\")");
            assert!(
                !src.contains(&folded),
                "resolve_state_file must read {var} with var_os, not var"
            );
        }
    }
}
