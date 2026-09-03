//! Tauri window-manager adapter + system-wide context (multi-window phase).
//!
//! Bridges the transport-agnostic `amos-wm` state machine to *real* Tauri
//! `WebviewWindow`s, and implements the system-wide clipboard/selection
//! context (`SystemContext`) that gets injected into `AgentRequest.context`
//! when the AI assistant streams a reply — see `docs/multi-window.md`.
//!
//! The `WindowManager` decides *what* should happen (focus, z-order, show/hide);
//! this module decides *how* to mirror each `WmEvent` onto the running app:
//! `Created` → build a real window, `Shown/Hidden` → `show()/hide()`,
//! `FocusChanged` → `set_focus()`, `Closed` → `close()`.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use amos_wm::{WindowId, WindowKind, WindowManager, WmEvent};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Tauri label of the launcher window (declared in `tauri.conf.json`).
const LAUNCHER_LABEL: &str = "main";

/// Web path (relative to `frontendDist`) every app window loads.
const APP_ENTRY: &str = "index.html";

/// Shared state: the transport-agnostic `WindowManager` plus a registry that
/// maps `WindowId` ⇄ Tauri window label.
pub struct WmState {
    inner: Mutex<WmCore>,
}

struct WmCore {
    wm: WindowManager,
    /// WindowId -> Tauri window label.
    labels: HashMap<WindowId, String>,
    /// Tauri window label -> WindowId.
    by_label: HashMap<String, WindowId>,
    /// WindowId -> human-readable kind ("Launcher" | "App" | "System").
    kinds: HashMap<WindowId, String>,
    /// WindowIds that are *external* surfaces (e.g. a legacy Android APK surface
    /// composited from Waydroid) — tracked in the state machine for focus/z-order
    /// but **not** backed by a Tauri WebviewWindow.
    external: HashSet<WindowId>,
}

impl Default for WmState {
    fn default() -> Self {
        Self::new()
    }
}

impl WmState {
    /// Create a manager whose Launcher is bound to the Tauri main window.
    // `WindowManager::new()` registers the Launcher synchronously, so
    // `launcher()` is always Some here; this single documented invariant-site is
    // allowed (P0-1), everything else in production is gated.
    #[allow(clippy::expect_used)]
    pub fn new() -> Self {
        let wm = WindowManager::new(); // registers + focuses the Launcher
        let launcher = wm.launcher().expect("launcher always registered");
        let mut labels = HashMap::new();
        let mut by_label = HashMap::new();
        let mut kinds = HashMap::new();
        labels.insert(launcher, LAUNCHER_LABEL.to_string());
        by_label.insert(LAUNCHER_LABEL.to_string(), launcher);
        kinds.insert(launcher, WindowKind::Launcher.to_string());
        Self {
            inner: Mutex::new(WmCore {
                wm,
                labels,
                by_label,
                kinds,
                external: HashSet::new(),
            }),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, WmCore>, String> {
        self.inner.lock().map_err(|e| e.to_string())
    }

    /// Label for a window id, if registered.
    fn label_for(&self, id: WindowId) -> Result<String, String> {
        self.lock()?
            .labels
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("unknown window id {id:?}"))
    }

    fn real_window(&self, app: &AppHandle, id: WindowId) -> Result<tauri::WebviewWindow, String> {
        let label = self.label_for(id)?;
        app.get_webview_window(&label)
            .ok_or_else(|| format!("window '{label}' does not exist"))
    }

    /// Open (create-if-needed + focus) the window addressed by `label`.
    pub fn open(&self, app: &AppHandle, label: &str) -> Result<Vec<WmEvent>, String> {
        let events = {
            let mut core = self.lock()?;
            let (id, mut events) = match core.by_label.get(label) {
                Some(id) => (*id, Vec::new()),
                None => {
                    // First time this label is referenced: register an App window
                    // and bind it to the label before applying the events.
                    let (id, created) = core.wm.register(WindowKind::App);
                    core.labels.insert(id, label.to_string());
                    core.by_label.insert(label.to_string(), id);
                    core.kinds.insert(id, WindowKind::App.to_string());
                    (id, created)
                }
            };
            events.extend(core.wm.open(id));
            events
        };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Focus an already-registered window.
    pub fn focus(&self, app: &AppHandle, label: &str) -> Result<Vec<WmEvent>, String> {
        let events = {
            let mut core = self.lock()?;
            let id = *core
                .by_label
                .get(label)
                .ok_or_else(|| format!("window '{label}' is not registered"))?;
            core.wm.focus(id)
        };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Hide a registered window.
    pub fn hide(&self, app: &AppHandle, label: &str) -> Result<Vec<WmEvent>, String> {
        let events = {
            let mut core = self.lock()?;
            let id = *core
                .by_label
                .get(label)
                .ok_or_else(|| format!("window '{label}' is not registered"))?;
            core.wm.hide(id)
        };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Close a registered window (Launcher is a no-op, as enforced by `amos-wm`).
    pub fn close(&self, app: &AppHandle, label: &str) -> Result<Vec<WmEvent>, String> {
        let events = {
            let mut core = self.lock()?;
            let id = *core
                .by_label
                .get(label)
                .ok_or_else(|| format!("window '{label}' is not registered"))?;
            core.wm.close(id)
        };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Return to the Launcher (home).
    pub fn home(&self, app: &AppHandle) -> Result<Vec<WmEvent>, String> {
        let events = { self.lock()?.wm.home() };
        self.apply(app, &events)?;
        Ok(events)
    }

    /// Whether `id` is an external surface (no real Tauri window behind it).
    fn is_external(&self, id: WindowId) -> bool {
        self.lock()
            .map(|c| c.external.contains(&id))
            .unwrap_or(false)
    }

    /// Register an external surface (e.g. a legacy Android APK's composited
    /// surface) as a `System` window in the state machine, focused on top. No
    /// `WebviewWindow` is created — the surface is composited separately
    /// (Waydroid Wayland/DMA-BUF), but it *does* participate in focus/z-order
    /// and shows up in `wm_windows`.
    pub fn open_surface(&self, label: &str) -> Result<(), String> {
        {
            let mut core = self.lock()?;
            // Reuse an existing surface window bound to this label if present.
            if let Some(id) = core.by_label.get(label).copied() {
                core.wm.focus(id);
                return Ok(());
            }
            let (id, mut events) = core.wm.register(WindowKind::System);
            core.labels.insert(id, label.to_string());
            core.by_label.insert(label.to_string(), id);
            core.kinds.insert(id, WindowKind::System.to_string());
            core.external.insert(id);
            events.extend(core.wm.open(id));
        }
        Ok(())
    }

    /// Mirror a batch of state-machine events onto the real windows.
    fn apply(&self, app: &AppHandle, events: &[WmEvent]) -> Result<(), String> {
        for e in events {
            match *e {
                WmEvent::Created(id) => {
                    if self.is_external(id) {
                        continue; // external surfaces have no WebviewWindow
                    }
                    let label = self.label_for(id)?;
                    if app.get_webview_window(&label).is_none() {
                        // Load the app entry with a `#window=<label>` fragment so
                        // the boot script auto-navigates to that app's screen.
                        let url = WebviewUrl::App(format!("{APP_ENTRY}#window={label}").into());
                        WebviewWindowBuilder::new(app, label.clone(), url)
                            .title("Amos")
                            .inner_size(480.0, 820.0)
                            .build()
                            .map_err(|e| format!("failed to create window '{label}': {e}"))?;
                    }
                }
                WmEvent::Closed(id) => {
                    if self.is_external(id) {
                        continue; // nothing to close on the host side
                    }
                    if let Some(w) = self
                        .label_for(id)
                        .ok()
                        .and_then(|l| app.get_webview_window(&l))
                    {
                        let _ = w.close();
                    }
                }
                WmEvent::Shown(id) => {
                    if self.is_external(id) {
                        continue;
                    }
                    self.real_window(app, id)?
                        .show()
                        .map_err(|e| e.to_string())?;
                }
                WmEvent::Hidden(id) => {
                    if self.is_external(id) {
                        continue;
                    }
                    self.real_window(app, id)?
                        .hide()
                        .map_err(|e| e.to_string())?;
                }
                WmEvent::FocusChanged(Some(id)) => {
                    if self.is_external(id) {
                        continue;
                    }
                    let _ = self.real_window(app, id)?.set_focus();
                }
                // Nothing focused: leave windowing as-is (Launcher stays visible).
                WmEvent::FocusChanged(None) => {}
            }
        }
        Ok(())
    }

    /// Serializable snapshot of the current windowing state.
    pub fn snapshot(&self) -> Result<WmSnapshot, String> {
        let core = self.lock()?;
        let focused = core.wm.focused();
        let windows = core
            .wm
            .windows()
            .into_iter()
            .map(|id| WindowInfo {
                id: id.0,
                label: core.labels.get(&id).cloned().unwrap_or_default(),
                kind: core
                    .kinds
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| "Unknown".to_string()),
                state: core
                    .wm
                    .state_of(id)
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
                focused: Some(id) == focused,
                external: core.external.contains(&id),
            })
            .collect();
        Ok(WmSnapshot {
            focused: focused.map(|id| id.0),
            windows,
        })
    }
}

/// Serializable view of a single window (enums aren't ergonomic over IPC).
#[derive(Serialize, Clone, Debug)]
pub struct WindowInfo {
    pub id: u64,
    pub label: String,
    pub kind: String,
    pub state: String,
    pub focused: bool,
    /// True when this is an external composited surface (no WebviewWindow).
    pub external: bool,
}

/// Serializable view of the whole windowing state.
#[derive(Serialize, Clone, Debug)]
pub struct WmSnapshot {
    pub focused: Option<u64>,
    pub windows: Vec<WindowInfo>,
}

// ---- Tauri commands (frontend: `invoke('wm_open', { label })`) ----

/// Open (create + focus) the window for `label`; returns the new snapshot.
#[tauri::command]
pub fn wm_open(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    state.open(&app, &label)?;
    state.snapshot()
}

/// Focus the window for `label` without changing visibility.
#[tauri::command]
pub fn wm_focus(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    state.focus(&app, &label)?;
    state.snapshot()
}

/// Hide the window for `label`.
#[tauri::command]
pub fn wm_hide(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    state.hide(&app, &label)?;
    state.snapshot()
}

/// Close the window for `label` (Launcher is a no-op).
#[tauri::command]
pub fn wm_close(
    app: AppHandle,
    state: State<'_, WmState>,
    label: String,
) -> Result<WmSnapshot, String> {
    state.close(&app, &label)?;
    state.snapshot()
}

/// Return to the Launcher.
#[tauri::command]
pub fn wm_home(app: AppHandle, state: State<'_, WmState>) -> Result<WmSnapshot, String> {
    state.home(&app)?;
    state.snapshot()
}

/// Read-only snapshot of the current windowing state.
#[tauri::command]
pub fn wm_windows(state: State<'_, WmState>) -> Result<WmSnapshot, String> {
    state.snapshot()
}

// ---- System-wide context (multi-window AI context sharing) ----

/// A snippet of text captured from a source window, destined for a target.
#[derive(Clone, Serialize, Debug)]
pub struct SystemContextEntry {
    pub source_window: String,
    pub text: String,
    pub timestamp_ms: u64,
}

/// Shared system-wide clipboard/selection context, injected into AI requests.
///
/// Keyed by *target* window label: when the AI assistant asks, the backend
/// takes the entry addressed to it and merges it into `AgentRequest.context`
/// under the `system_selection` key (see `docs/multi-window.md` §3).
pub struct SystemContext {
    inner: Mutex<HashMap<String, SystemContextEntry>>,
}

impl Default for SystemContext {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemContext {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Record context captured from `source_window`, addressed to `target_window`.
    pub fn set(&self, target_window: &str, source_window: &str, text: &str) {
        let entry = SystemContextEntry {
            source_window: source_window.to_string(),
            text: text.to_string(),
            timestamp_ms: now_ms(),
        };
        if let Ok(mut g) = self.inner.lock() {
            g.insert(target_window.to_string(), entry);
        }
    }

    /// Drop the context addressed to `target_window` (e.g. user cleared it).
    pub fn clear(&self, target_window: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(target_window);
        }
    }

    /// Peek (without consuming) the context for `target_window`.
    pub fn peek(&self, target_window: &str) -> Option<SystemContextEntry> {
        self.inner.lock().ok()?.get(target_window).cloned()
    }

    /// Take (and consume) the context for `target_window`, if any.
    pub fn take_for(&self, target_window: &str) -> Option<SystemContextEntry> {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(target_window)
        } else {
            None
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Merge the system-wide context addressed to `target` into `out` under the
/// `system_selection` key, consuming it. Shared by `ask_ai_agent` and unit
/// tests so the injection path is exercised headlessly.
pub fn inject_context(ctx: &SystemContext, target: &str, out: &mut HashMap<String, String>) {
    if let Some(entry) = ctx.take_for(target) {
        out.insert("system_selection".to_string(), entry.text);
    }
}

/// Tauri command: capture selection/clipboard text from a window for a target.
#[tauri::command]
pub fn system_set_context(
    state: State<'_, SystemContext>,
    target_window: String,
    source_window: String,
    text: String,
) -> Result<(), String> {
    state.set(&target_window, &source_window, &text);
    Ok(())
}

/// Tauri command: drop the context addressed to a window.
#[tauri::command]
pub fn system_clear_context(
    state: State<'_, SystemContext>,
    target_window: String,
) -> Result<(), String> {
    state.clear(&target_window);
    Ok(())
}

/// Tauri command: peek (without consuming) the context addressed to a window,
/// so the target app can show a "已附加系统上下文" hint before sending.
#[tauri::command]
pub fn system_peek_context(
    state: State<'_, SystemContext>,
    target_window: String,
) -> Result<Option<SystemContextEntry>, String> {
    Ok(state.peek(&target_window))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn open_surface_registers_external_system_window() {
        let s = WmState::new();
        s.open_surface("legacy:waydroid_0").unwrap();

        let snap = s.snapshot().unwrap();
        let surface = snap
            .windows
            .iter()
            .find(|w| w.label == "legacy:waydroid_0")
            .expect("surface window registered");
        assert_eq!(
            surface.kind, "System",
            "legacy APK surfaces are System windows"
        );
        assert!(surface.external, "external surfaces have no WebviewWindow");
        assert!(surface.focused, "opening a surface focuses it");
        assert_eq!(snap.focused, Some(surface.id));
    }

    #[test]
    fn open_surface_reuses_existing_label() {
        let s = WmState::new();
        s.open_surface("legacy:surf-1").unwrap();
        s.open_surface("legacy:surf-1").unwrap(); // same label again
        let snap = s.snapshot().unwrap();
        let count = snap
            .windows
            .iter()
            .filter(|w| w.label == "legacy:surf-1")
            .count();
        assert_eq!(count, 1, "reusing a label does not duplicate the window");
    }

    #[test]
    fn inject_context_puts_selection_into_request_map() {
        let ctx = SystemContext::new();
        ctx.set("ai", "notes", "selected text for the agent");

        let mut out = HashMap::new();
        inject_context(&ctx, "ai", &mut out);

        assert_eq!(
            out.get("system_selection").map(String::as_str),
            Some("selected text for the agent"),
            "context injected under system_selection"
        );
        assert!(ctx.peek("ai").is_none(), "context consumed after injection");
    }

    #[test]
    fn inject_context_noop_for_unknown_target() {
        let ctx = SystemContext::new();
        ctx.set("ai", "notes", "hello");
        let mut out = HashMap::new();
        inject_context(&ctx, "settings", &mut out);
        assert!(out.is_empty(), "nothing injected for a different target");
        assert!(
            ctx.peek("ai").is_some(),
            "context still present for its target"
        );
    }
}
