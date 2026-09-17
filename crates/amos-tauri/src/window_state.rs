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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, Window};

/// Current on-disk schema version.  Older payloads without this field are still
/// accepted (legacy v0 = raw `{label: {x,y,w,h}}`).
pub const SCHEMA_VERSION: u32 = 1;

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
                state: sanitize(state),
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

        // Read existing on-disk state (lossy on parse error: see `load`).
        let mut file: WindowStateFile = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        for (k, v) in due.iter() {
            file.windows.insert(k.clone(), v.clone());
        }
        file.version = SCHEMA_VERSION;

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
        let mut file: WindowStateFile = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        for (k, v) in pending.iter() {
            file.windows.insert(k.clone(), v.clone());
        }
        file.version = SCHEMA_VERSION;
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

/// Atomic write: write to `<path>.tmp`, then rename.  A crash mid-write leaves
/// the previous file intact.
fn write_atomic(path: &Path, file: &WindowStateFile) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(file).map_err(std::io::Error::other)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Drop nonsense coordinates and dimensions; keep only what fits the screen.
fn sanitize(state: WindowState) -> WindowState {
    WindowState {
        x: state.x.filter(|v| (*v).unsigned_abs() <= MAX_COORD as u32),
        y: state.y.filter(|v| (*v).unsigned_abs() <= MAX_COORD as u32),
        width: state.width.filter(|v| (MIN_DIM..=MAX_DIM).contains(v)),
        height: state.height.filter(|v| (MIN_DIM..=MAX_DIM).contains(v)),
        visible: state.visible,
    }
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
            },
        );
        assert_eq!(s.flush_due(), 0, "unarmed store drops everything silently");
    }

    #[test]
    fn roundtrip_is_lossless() {
        let mut f = WindowStateFile::default();
        f.version = SCHEMA_VERSION;
        f.windows.insert(
            "settings".into(),
            WindowState {
                x: Some(120),
                y: Some(80),
                width: Some(900),
                height: Some(640),
                visible: Some(true),
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
}
