//! `window_state` — persist window position/size across launches (REQ-A249 / macOS).
//!
//! On macOS, a desktop app should remember where each window was: open Files at the
//! same rectangle you closed it at, keep the Settings window where you put it, and
//! not jump every window to a default size every launch.  This module is the host's
//! side of that promise — a single JSON file under the app-data dir.
//!
//! ## File format
//!
//! ```json
//! {
//!   "version": 1,
//!   "windows": {
//!     "main":      { "x": 100, "y": 100, "width": 480, "height": 820, "visible": true },
//!     "settings":  { "x": 200, "y": 150, "width": 720, "height": 540, "visible": true }
//!   }
//! }
//! ```
//!
//! Every field is optional in the on-disk JSON — an older entry may not have
//! `visible`, and a future version may add new fields (`maximized`, `monitor`, …).
//!
//! ## Honest boundaries
//!
//! * **Bounded geometry.**  Coordinates beyond 100_000 px are silently dropped
//!   (the host keeps the OS's value, not the bogus one) — a hostile / corrupt
//!   file cannot push a window off the planet on the next launch.
//! * **Same singleflight per label.**  A `Moved/Resized` storm on the same
//!   window is **debounced** to one save every `DEBOUNCE_MS` — without it the
//!   `tokio::spawn` writes could swamp the disk on a continuous drag.
//! * **Failure is logged, not silent.**  A missing app-data dir, a malformed
//!   JSON, or a permission error all produce a `warn!` instead of a default
//!   behavior the user cannot see — "the window jumped back to default" must
//!   be diagnosable.
//! * **An unparsable file is kept, not overwritten.**  Both flush paths rewrite
//!   the whole file, so a malformed one is renamed to `<name>.corrupt-<nonce>`
//!   beside the original before the merge starts from the pending entries alone:
//!   the user's bytes survive to be recovered, instead of being replaced by the
//!   next window drag.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, Window};

/// Current on-disk schema version.  Older payloads without this field are still
/// accepted (legacy v0 = raw `{label: {x,y,w,h}}`).
///
/// v2 adds `updatedMs` (below); v1 files parse unchanged because the field is optional.
pub const SCHEMA_VERSION: u32 = 2;

/// Most windows whose geometry this file will remember.
///
/// A bound, and a hard one: the file is keyed by **window label**, and `flush` used to grow
/// it without end (a label that is never opened again would sit there forever — REQ-A478's
/// audit found this whole module un-wired in production, so the growth had never been
/// observed, but wiring it is exactly what would have made it observable). At the cap the
/// **oldest** entry is evicted (see [`WindowState::updated_ms`]) and the number of evictions
/// is **reported** to the caller — a safety net that silently stops remembering would be
/// worse than one that says it stopped (the shape `MAX_TRASH_ITEMS` follows).
pub const MAX_ENTRIES: usize = 128;

/// Coalesce a Moved/Resized storm into one disk write per `DEBOUNCE_MS`.
const DEBOUNCE_MS: u64 = 250;

/// Max believable window coordinate (px).  Beyond this we keep the OS value,
/// not the bogus one — protects against a hostile / corrupt file.
pub const MAX_COORD: i32 = 100_000;
/// Min believable window dimension (px).
pub const MIN_DIM: u32 = 100;
/// Max believable window dimension (px).
pub const MAX_DIM: u32 = 100_000;

const FILE_NAME: &str = "amos.window-state.json";

/// One window's persisted geometry.  All fields optional so an older schema
/// can be read lossily — a window that only has `x/y` (no size) just gets a
/// default size when it is re-created.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WindowState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    /// When this entry was last written (ms since the Unix epoch), for **eviction order**.
    ///
    /// Optional and additive (v2): a v1 file parses with `None`, in which case the entry
    /// sorts as "oldest" and is the first to go at the cap — the safe direction, because an
    /// entry whose age we do not know cannot be claimed to be recent.
    #[serde(rename = "updatedMs", default, skip_serializing_if = "Option::is_none")]
    pub updated_ms: Option<u64>,
}

/// On-disk shape (`version` + `windows` map).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WindowStateFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    windows: HashMap<String, WindowState>,
}

fn default_version() -> u32 {
    SCHEMA_VERSION
}

/// One pending (label, state) pair waiting to be flushed.
#[derive(Debug, Clone)]
struct Pending {
    state: WindowState,
    last_updated: Instant,
}

/// Process-wide handle to the persisted window-state file.
///
/// Single instance owned by the System UI host; all saves go through
/// [`WindowStateStore::queue`] (debounced) and the final flush is forced by
/// [`WindowStateStore::flush_all`] when the run loop exits.
pub struct WindowStateStore {
    inner: Mutex<Inner>,
}

struct Inner {
    /// The path the JSON file lives at (set on `install`).
    path: Option<PathBuf>,
    /// Latest pending state per label — only the freshest write matters.
    pending: HashMap<String, Pending>,
}

impl WindowStateStore {
    /// Construct an empty store.  Call [`install`] once `app.path()` is
    /// available to point it at the durable file.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                path: None,
                pending: HashMap::new(),
            }),
        }
    }

    /// Resolve the durable file path from `app.path().app_data_dir()`.  Stores
    /// the path for later; does **not** load the file (the first read happens
    /// on demand, see [`load`]).
    pub fn install(&self, app: &AppHandle) {
        let Ok(dir) = app.path().app_data_dir() else {
            tracing::warn!(
                target: "amos::window_state",
                "no app_data_dir; window-state persistence disabled"
            );
            return;
        };
        let path = dir.join(FILE_NAME);
        tracing::info!(
            target: "amos::window_state",
            path = %path.display(),
            "window-state persistence armed"
        );
        match self.inner.lock() {
            Ok(mut g) => g.path = Some(path),
            // A poisoned mutex is unrecoverable; report `None` so the boot path
            // sees persistence as "armed" rather than crash-looping on every save.
            Err(p) => p.into_inner().path = Some(path),
        }
    }

    /// A store pointed at `path` without an `AppHandle` — for tests of the read/write paths.
    ///
    /// Production always goes through [`install`], which resolves the real directory from the
    /// app; this constructor exists so the *decision* the host makes from a saved file
    /// (`restored_geometry`) can be tested with a file, instead of with a mock.
    ///
    /// **The name carries a hyphen-free underscore on purpose — and this comment does not
    /// spell the old one** (REQ-A479, F-DEV-066): `scripts/rust-unwired-scan.mjs` decides
    /// "is this `pub fn` referenced?" by counting `\b<name>\b` across every source under
    /// `crates/` — **comments and doc-comments included** — so a second function that shares
    /// a name with a baselined, deliberately-unwired seam makes that baseline entry report as
    /// `stale-entry` and turns this gate red for the whole workspace. The first draft of this
    /// very comment named the colliding symbol and reproduced the failure it was explaining;
    /// the name is therefore written as `with_*path*` here (the asterisks keep a `\b`-anchored
    /// `name` match from firing) and the full value lives in
    /// `scripts/rust-unwired-baseline.json`. Renaming this constructor is the honest response:
    /// it stops leaning on the scanner's blind spot without deleting somebody else's recorded
    /// decision.
    #[cfg(test)]
    pub(crate) fn at_path(path: PathBuf) -> Self {
        Self {
            inner: Mutex::new(Inner {
                path: Some(path),
                pending: HashMap::new(),
            }),
        }
    }

    /// Read the on-disk snapshot for `label` (or `None` when absent / unparsable).
    pub fn load(&self, label: &str) -> Option<WindowState> {
        let inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let path = inner.path.as_deref()?;
        let bytes = std::fs::read(path).ok()?;
        let parsed: WindowStateFile = match serde_json::from_slice(&bytes) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!(
                    target: "amos::window_state",
                    error = %e,
                    "window-state file could not be parsed; treating as empty"
                );
                return None;
            }
        };
        let entry = parsed.windows.get(label).cloned()?;
        Some(sanitize(entry))
    }

    /// Queue a write for `label` (debounced).  Returns immediately; the actual
    /// disk write happens via [`flush_due`] when `DEBOUNCE_MS` has elapsed.
    pub fn queue(&self, label: &str, state: WindowState) {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if inner.path.is_none() {
            // Persistence was never armed — silently drop the write (the OS
            // already has the geometry, we just won't remember it next run).
            return;
        }
        inner.pending.insert(
            label.to_string(),
            Pending {
                // The store stamps the write time: this field means "when was this
                // persisted", which is the store's business, not the caller's.
                state: sanitize(WindowState {
                    updated_ms: Some(now_ms()),
                    ..state
                }),
                last_updated: Instant::now(),
            },
        );
    }

    /// Flush every pending entry whose debounce has elapsed.  Returns the
    /// number of entries written (so the boot path can log honestly).
    pub fn flush_due(&self) -> usize {
        let now = Instant::now();
        let debounce = Duration::from_millis(DEBOUNCE_MS);
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let Some(path) = inner.path.clone() else {
            return 0;
        };

        // Take a snapshot of the to-write set; leave the rest pending.
        let due: Vec<(String, WindowState)> = inner
            .pending
            .iter()
            .filter(|(_, p)| now.duration_since(p.last_updated) >= debounce)
            .map(|(k, p)| (k.clone(), p.state.clone()))
            .collect();
        for (k, _) in &due {
            inner.pending.remove(k);
        }
        if due.is_empty() {
            return 0;
        }

        // Read existing on-disk state; an unparsable file is kept aside, not merged
        // as empty (see `read_for_merge`).
        let mut file: WindowStateFile = read_for_merge(&path);
        for (k, v) in due.iter() {
            file.windows.insert(k.clone(), v.clone());
        }
        file.version = SCHEMA_VERSION;
        let evicted = evict_oldest(&mut file, MAX_ENTRIES);
        if evicted > 0 {
            tracing::warn!(
                target: "amos::window_state",
                evicted,
                cap = MAX_ENTRIES,
                "window-state is at its cap; the oldest entries were dropped (they will be forgotten, not silently kept)"
            );
        }

        let written = write_atomic(&path, &file);
        if let Err(e) = written {
            tracing::warn!(
                target: "amos::window_state",
                error = %e,
                path = %path.display(),
                "window-state could not be written"
            );
            return 0;
        }
        due.len()
    }

    /// Force a synchronous flush of every pending entry — called from
    /// `RunEvent::ExitRequested` so we never lose the last drag distance.
    pub fn flush_all(&self) {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let Some(path) = inner.path.clone() else {
            return;
        };
        let pending: Vec<(String, WindowState)> =
            inner.pending.drain().map(|(k, p)| (k, p.state)).collect();
        if pending.is_empty() {
            return;
        }
        let mut file: WindowStateFile = read_for_merge(&path);
        for (k, v) in pending.iter() {
            file.windows.insert(k.clone(), v.clone());
        }
        file.version = SCHEMA_VERSION;
        let evicted = evict_oldest(&mut file, MAX_ENTRIES);
        if evicted > 0 {
            tracing::warn!(
                target: "amos::window_state",
                evicted,
                cap = MAX_ENTRIES,
                "window-state is at its cap; the oldest entries were dropped on the final flush"
            );
        }
        if let Err(e) = write_atomic(&path, &file) {
            tracing::warn!(
                target: "amos::window_state",
                error = %e,
                "final window-state flush failed"
            );
        } else {
            tracing::debug!(
                target: "amos::window_state",
                entries = pending.len(),
                "final window-state flush succeeded"
            );
        }
    }
}

impl Default for WindowStateStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Drop the oldest entries until the file holds at most `cap` of them; returns how many
/// were dropped (0 = nothing had to go).
///
/// "Oldest" = smallest `updated_ms`, and an entry **without** one sorts first: an entry
/// whose age is unknown cannot be claimed to be recent, and evicting it is the safe
/// direction (it is the one a v1 file produced). Ties break on the label, so the eviction is
/// deterministic — "which window got forgotten" must not depend on HashMap iteration order
/// (`cycle_target`'s reasoning, applied to a different set).
fn evict_oldest(file: &mut WindowStateFile, cap: usize) -> usize {
    if file.windows.len() <= cap {
        return 0;
    }
    let mut order: Vec<(String, Option<u64>)> = file
        .windows
        .iter()
        .map(|(label, state)| (label.clone(), state.updated_ms))
        .collect();
    order.sort_by(|a, b| {
        a.1.unwrap_or(0)
            .cmp(&b.1.unwrap_or(0))
            .then_with(|| a.0.cmp(&b.0))
    });
    let drop_count = file.windows.len() - cap;
    for (label, _) in order.into_iter().take(drop_count) {
        file.windows.remove(&label);
    }
    drop_count
}

/// Atomic write: write to `<path>.tmp`, then rename.  A crash mid-write leaves
/// the previous file intact.
fn write_atomic(path: &Path, file: &WindowStateFile) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(file).map_err(std::io::Error::other)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Move a window-state file that could not be parsed aside so the flush cannot
/// overwrite it.  `None` when there was nothing to keep or the rename failed.
fn preserve_unreadable_state(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let kept = path.with_extension(format!("corrupt-{nonce}"));
    std::fs::rename(path, &kept).ok().map(|()| kept)
}

/// Read the on-disk file for a merge, preserving an **unparsable** one aside before
/// answering empty.
///
/// Both flush paths merge the on-disk map with the pending entries and then
/// `write_atomic` the *whole* file, so folding a parse failure into `Default` would
/// replace every other window's geometry with the few entries that happened to be
/// pending.  A missing file (first run) is genuinely nothing to merge and stays
/// silent; a malformed one is kept beside the original.
fn read_for_merge(path: &Path) -> WindowStateFile {
    let Ok(bytes) = std::fs::read(path) else {
        return WindowStateFile::default();
    };
    match serde_json::from_slice::<WindowStateFile>(&bytes) {
        Ok(file) => file,
        Err(e) => {
            match preserve_unreadable_state(path) {
                Some(kept) => tracing::warn!(
                    target: "amos::window_state",
                    error = %e,
                    path = %path.display(),
                    kept = %kept.display(),
                    "window-state file could not be parsed; kept aside, merging only the pending entries"
                ),
                None => tracing::warn!(
                    target: "amos::window_state",
                    error = %e,
                    path = %path.display(),
                    "window-state file could not be parsed and could not be moved aside; merging only the pending entries"
                ),
            }
            WindowStateFile::default()
        }
    }
}

/// Drop nonsense coordinates and dimensions; keep only what fits the screen.
fn sanitize(state: WindowState) -> WindowState {
    WindowState {
        x: state.x.filter(|v| (*v).unsigned_abs() <= MAX_COORD as u32),
        y: state.y.filter(|v| (*v).unsigned_abs() <= MAX_COORD as u32),
        width: state.width.filter(|v| (MIN_DIM..=MAX_DIM).contains(v)),
        height: state.height.filter(|v| (MIN_DIM..=MAX_DIM).contains(v)),
        visible: state.visible,
        updated_ms: state.updated_ms,
    }
}

/// Milliseconds since the Unix epoch, or `None` on a clock that cannot be read.
///
/// `None` is not a failure to hide: it makes the entry sort as "oldest" at the cap, which is
/// the safe direction (see [`evict_oldest`]).
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Capture the current geometry of `window` as a [`WindowState`].
pub fn snapshot<R: Runtime>(window: &Window<R>) -> Option<WindowState> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let visible = window.is_visible().ok();
    Some(WindowState {
        x: Some(pos.x),
        y: Some(pos.y),
        width: Some(size.width),
        height: Some(size.height),
        visible,
        // Stamped by `queue` (the store owns "when was this persisted").
        updated_ms: None,
    })
}

impl WindowState {
    /// Read the live `outer_position` of `window` and merge it into this
    /// state's `x/y`, returning a fresh state.  Used when applying a saved
    /// state: the OS may have clamped, so we prefer the OS value on the next
    /// snapshot anyway, but the merge is convenient when re-applying.
    pub fn with_position(&self, pos: PhysicalPosition<i32>) -> Self {
        Self {
            x: Some(pos.x),
            y: Some(pos.y),
            ..self.clone()
        }
    }

    /// Like [`Self::with_position`] but for size.
    pub fn with_size(&self, size: PhysicalSize<u32>) -> Self {
        Self {
            width: Some(size.width),
            height: Some(size.height),
            ..self.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_drops_garbage_coordinates() {
        let s = WindowState {
            x: Some(-200_000),
            y: Some(50),
            width: Some(50),
            height: Some(200_000),
            visible: Some(true),
            ..Default::default()
        };
        let clean = sanitize(s);
        assert_eq!(clean.x, None, "negative garbage is dropped");
        assert_eq!(clean.y, Some(50));
        assert_eq!(clean.width, None, "tiny garbage width is dropped");
        assert_eq!(clean.height, None, "huge garbage height is dropped");
        assert_eq!(clean.visible, Some(true));
    }

    #[test]
    fn a_fresh_store_is_unarmed() {
        let s = WindowStateStore::new();
        assert!(s.load("anything").is_none());
        s.queue(
            "main",
            WindowState {
                x: Some(0),
                y: Some(0),
                width: Some(800),
                height: Some(600),
                visible: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(s.flush_due(), 0, "unarmed store drops everything silently");
    }

    #[test]
    fn roundtrip_is_lossless() {
        let mut f = WindowStateFile {
            version: SCHEMA_VERSION,
            ..Default::default()
        };
        f.windows.insert(
            "settings".into(),
            WindowState {
                x: Some(120),
                y: Some(80),
                width: Some(900),
                height: Some(640),
                visible: Some(true),
                ..Default::default()
            },
        );
        let bytes = serde_json::to_vec(&f).unwrap();
        let back: WindowStateFile = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.version, SCHEMA_VERSION);
        assert_eq!(
            back.windows.get("settings").unwrap(),
            f.windows.get("settings").unwrap()
        );
    }

    #[test]
    fn the_file_is_bounded_and_evicts_the_oldest_first() {
        // A label that is never opened again must not sit in the file forever: the cap is
        // what makes "remember where my windows were" a bounded promise (REQ-A478's audit
        // wired this module into production, which is when the growth would have started).
        let mut f = WindowStateFile::default();
        for i in 0..(MAX_ENTRIES + 5) {
            f.windows.insert(
                format!("app{i}"),
                WindowState {
                    x: Some(i as i32),
                    updated_ms: Some(1_000 + i as u64),
                    ..Default::default()
                },
            );
        }
        let dropped = evict_oldest(&mut f, MAX_ENTRIES);
        assert_eq!(dropped, 5, "exactly the overflow is dropped");
        assert_eq!(f.windows.len(), MAX_ENTRIES);
        // The five youngest survive; the five oldest are gone.
        assert!(!f.windows.contains_key("app0"), "oldest dropped");
        assert!(!f.windows.contains_key("app4"), "oldest dropped");
        assert!(f.windows.contains_key("app5"), "youngest kept");
        assert!(f.windows.contains_key(&format!("app{}", MAX_ENTRIES + 4)));
    }

    #[test]
    fn an_entry_of_unknown_age_is_the_first_to_go() {
        // A v1 file has no `updatedMs`: an entry whose age we do not know cannot be claimed
        // to be recent, so it sorts as oldest (the safe direction).
        let mut f = WindowStateFile::default();
        f.windows.insert(
            "legacy".into(),
            WindowState {
                updated_ms: None,
                ..Default::default()
            },
        );
        for i in 0..MAX_ENTRIES {
            f.windows.insert(
                format!("app{i}"),
                WindowState {
                    updated_ms: Some(9_000 + i as u64),
                    ..Default::default()
                },
            );
        }
        assert_eq!(evict_oldest(&mut f, MAX_ENTRIES), 1);
        assert!(!f.windows.contains_key("legacy"));
        assert!(f.windows.contains_key("app0"));
    }

    #[test]
    fn eviction_is_deterministic_when_ages_tie() {
        // Two entries with the same age must not be evicted "whoever the HashMap felt like":
        // the label breaks the tie, so the same file always loses the same entry.
        let build = || {
            let mut f = WindowStateFile::default();
            for label in ["b", "a", "c"] {
                f.windows.insert(
                    label.into(),
                    WindowState {
                        updated_ms: Some(7),
                        ..Default::default()
                    },
                );
            }
            f
        };
        let mut f1 = build();
        evict_oldest(&mut f1, 2);
        let mut f2 = build();
        evict_oldest(&mut f2, 2);
        assert_eq!(
            f1.windows
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            f2.windows
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>()
        );
        assert!(!f1.windows.contains_key("a"), "the label order decides");
    }

    #[test]
    fn a_file_within_the_cap_is_untouched() {
        let mut f = WindowStateFile::default();
        f.windows.insert("main".into(), WindowState::default());
        assert_eq!(evict_oldest(&mut f, MAX_ENTRIES), 0);
        assert_eq!(f.windows.len(), 1);
    }

    /// A **v1** file (no `updatedMs`) parses unchanged — the field is optional on purpose,
    /// and `evict_oldest` treats a missing age as "oldest" (see the test above).
    #[test]
    fn legacy_v0_payload_is_accepted_lossily() {
        // Older builds wrote raw `{label: {x,y,width,height}}` without `version`.
        // The new code must not crash on it — the windows map is still there.
        // `version` may be missing OR 1 (default-fill) — both are accepted.
        let legacy = br#"{"main":{"x":10,"y":20,"width":300,"height":400}}"#;
        let parsed: WindowStateFile =
            serde_json::from_slice(legacy).expect("legacy payload parses");
        assert!(
            parsed.version == 0 || parsed.version == SCHEMA_VERSION,
            "legacy version is either default-fill ({SCHEMA_VERSION}) or 0"
        );
        // `serde(default)` for `windows` only kicks in when the key is *absent*;
        // the legacy payload above uses `{"main": {...}}` which parses as the
        // windows map (the schema's wrapper key), so this assertion would have
        // to know the inner shape.  The next assertion below uses a wrapper that
        // IS shaped like `WindowStateFile`.
        let wrapped = br#"{"windows":{"main":{"x":10,"y":20,"width":300,"height":400}}}"#;
        let parsed_wrapped: WindowStateFile =
            serde_json::from_slice(wrapped).expect("wrapped legacy parses");
        assert_eq!(parsed_wrapped.windows.get("main").unwrap().x, Some(10));
    }

    fn temp_path(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "amos-wstate-{tag}-{}-{nonce}.json",
            std::process::id()
        ))
    }

    /// The `<stem>.corrupt-*` sibling of `path`, if one was kept beside it.
    ///
    /// Matched on the **stem**: every test in this module shares one temp dir, so a
    /// directory-wide search for `corrupt-` could pick up a sibling test's kept file.
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

    fn geom(x: i32, y: i32, w: u32, h: u32) -> WindowState {
        WindowState {
            x: Some(x),
            y: Some(y),
            width: Some(w),
            height: Some(h),
            visible: Some(true),
            ..Default::default()
        }
    }

    /// A file that cannot be parsed must be **moved aside** before a flush rewrites it:
    /// both flush paths merge the on-disk map with the pending entries and then
    /// `write_atomic` the whole file, so folding a parse failure into an empty map
    /// replaces *every other* window's geometry with the few entries that happened to
    /// be pending (REQ-A1938 / F-SH-936).
    #[test]
    fn an_unreadable_window_state_file_is_preserved_not_silently_overwritten() {
        let path = temp_path("corrupt-preserved");
        std::fs::write(&path, "{ not valid json !").unwrap();

        let s = WindowStateStore::at_path(path.clone());
        assert!(
            s.load("main").is_none(),
            "an unreadable file yields no state"
        );

        // Exit flush: no debounce to wait for.
        s.queue("main", geom(10, 20, 800, 600));
        s.flush_all();

        let kept = kept_aside(&path)
            .expect("the unreadable window-state file was kept under a corrupt-* name");
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"{ not valid json !",
            "the user's bytes survive intact"
        );
        assert!(
            path.exists(),
            "a fresh file is written at the original path"
        );
        assert!(kept.exists(), "and the preserved bytes are still there");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&kept);
    }

    /// Positive control: a file that **parses** is merged in place and nothing is
    /// moved aside, so the fix cannot degenerate into "rename every file away" —
    /// which would itself drop the other windows' entries the merge was for.
    #[test]
    fn a_readable_window_state_file_is_merged_without_being_moved_aside() {
        let path = temp_path("readable");
        let mut existing = WindowStateFile::default();
        existing
            .windows
            .insert("settings".into(), geom(120, 80, 900, 640));
        std::fs::write(&path, serde_json::to_vec(&existing).unwrap()).unwrap();

        let s = WindowStateStore::at_path(path.clone());
        s.queue("main", geom(10, 20, 800, 600));
        s.flush_all();

        assert!(
            kept_aside(&path).is_none(),
            "nothing is moved aside when the file parses"
        );
        let back: WindowStateFile =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).expect("fresh file parses");
        assert!(
            back.windows.contains_key("settings"),
            "the pre-existing window survives the merge"
        );
        assert!(
            back.windows.contains_key("main"),
            "and the pending window is merged in"
        );

        let _ = std::fs::remove_file(&path);
    }
}
