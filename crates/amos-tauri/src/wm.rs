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

use amos_wm::layout::{Bounds, Size, SplitAxis};
use amos_wm::split::SplitScreen;
use amos_wm::{WindowId, WindowKind, WindowManager, WmEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Default full OS window area the split layout sub-divides (0,0 origin).
const DEFAULT_SCREEN: Bounds = Bounds::new(0, 0, 1080, 1920);
/// Divider gap between split panes (px).
const SPLIT_GAP: u32 = 8;
/// Minimum size any split pane must keep.
const SPLIT_MIN: Size = Size::new(360, 480);
/// Tauri event broadcast after any layout change, so **non-initiating** windows /
/// surfaces can refresh their geometry without round-tripping a command.
pub const LAYOUT_EVENT: &str = "layout-changed";

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
    /// Full OS window area the split layout sub-divides (0,0 origin).
    screen: Bounds,
    /// Active split-screen session (which two windows share the screen), if any.
    split: Option<SplitScreen>,
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
                screen: DEFAULT_SCREEN,
                split: None,
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

    /// The full OS window area the split layout sub-divides (0,0 origin).
    pub fn screen(&self) -> Result<Bounds, String> {
        Ok(self.lock()?.screen)
    }

    /// Set the full window area used for split layout. If a split is active it is
    /// kept only when its divider still fits the new screen; otherwise the split
    /// ends (honest — never silently re-clamped).
    pub fn set_screen(&self, width: u32, height: u32) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        let screen = Bounds::new(0, 0, width.max(1), height.max(1));
        core.screen = screen;
        if let Some(s) = core.split.as_mut() {
            if !s.set_screen(screen) {
                core.split = None;
            }
        }
        layout_core(&core)
    }

    /// Enter a split between two registered, distinct, non-Launcher windows.
    pub fn enter_split(&self, a: &str, b: &str, axis: &str) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        let ia = *core
            .by_label
            .get(a)
            .ok_or_else(|| format!("window '{a}' is not registered"))?;
        let ib = *core
            .by_label
            .get(b)
            .ok_or_else(|| format!("window '{b}' is not registered"))?;
        if ia == ib {
            return Err("cannot split a window with itself".to_string());
        }
        if core.kinds.get(&ia).map(String::as_str) == Some("Launcher")
            || core.kinds.get(&ib).map(String::as_str) == Some("Launcher")
        {
            return Err("the Launcher cannot be split".to_string());
        }
        let axis = parse_axis(axis)?;
        let screen = core.screen;
        let sp = SplitScreen::new(ia, ib, screen, axis, SPLIT_GAP, SPLIT_MIN)
            .ok_or_else(|| "screen too small to split those two windows".to_string())?;
        core.split = Some(sp);
        layout_core(&core)
    }

    /// Set the divider so the primary pane takes `percent` (1..=99).
    pub fn split_resize(&self, percent: u32) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        let sp = core
            .split
            .as_mut()
            .ok_or_else(|| "no active split".to_string())?;
        if !sp.resize_to(percent) {
            return Err(
                "that divider share is not feasible at the current minimum size".to_string(),
            );
        }
        layout_core(&core)
    }

    /// Move the divider by `delta` percentage points.
    pub fn split_move(&self, delta: i32) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        let sp = core
            .split
            .as_mut()
            .ok_or_else(|| "no active split".to_string())?;
        if !sp.resize_by(delta) {
            return Err(
                "that divider move is not feasible at the current minimum size".to_string(),
            );
        }
        layout_core(&core)
    }

    /// Swap which window is in the primary (first) pane.
    pub fn split_swap(&self) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        let sp = core
            .split
            .as_mut()
            .ok_or_else(|| "no active split".to_string())?;
        sp.swap();
        layout_core(&core)
    }

    /// End the active split (windows return to fullscreen / previous layout).
    pub fn split_exit(&self) -> Result<LayoutSnapshot, String> {
        let mut core = self.lock()?;
        core.split = None;
        layout_core(&core)
    }

    /// Apply the active split's pane rects to the **real** Tauri windows: each pane
    /// window is moved/resized to its bounds. External or not-yet-created windows
    /// are skipped (their geometry is owned elsewhere / comes later). No-op when
    /// there is no active split. Best-effort — a window that fails to resize is
    /// ignored rather than aborting the whole layout.
    pub fn apply_split_to_real(&self, app: &AppHandle) -> Result<(), String> {
        let snapshot = self.layout_snapshot()?;
        let Some(info) = &snapshot.split else {
            return Ok(());
        };
        for pane in &info.panes {
            let Some(window) = app.get_webview_window(&pane.label) else {
                continue; // external surface or not created yet
            };
            let _ = window.set_position(tauri::LogicalPosition::new(pane.x as f64, pane.y as f64));
            let _ = window.set_size(tauri::LogicalSize::new(
                pane.width as f64,
                pane.height as f64,
            ));
        }
        Ok(())
    }

    /// The two window labels in the active split, if any (pane order: primary,
    /// secondary). Used by the host to restore those windows when the split ends.
    pub fn split_labels(&self) -> Result<Option<(String, String)>, String> {
        let core = self.lock()?;
        Ok(match &core.split {
            Some(sp) => match (
                core.labels.get(&sp.primary).cloned(),
                core.labels.get(&sp.secondary).cloned(),
            ) {
                (Some(a), Some(b)) => Some((a, b)),
                _ => None,
            },
            None => None,
        })
    }

    /// The labels the host offers for entering a split (front two shown, non-Launcher).
    pub fn split_candidates_labels(&self) -> Result<Vec<String>, String> {
        let core = self.lock()?;
        Ok(core
            .wm
            .split_candidates()
            .into_iter()
            .filter_map(|id| core.labels.get(&id).cloned())
            .collect())
    }

    /// App-free snapshot of the current layout state.
    pub fn layout_snapshot(&self) -> Result<LayoutSnapshot, String> {
        let core = self.lock()?;
        layout_core(&core)
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

// ---- Multi-window layout (screen + split) — state + commands ----

/// Serializable pane rect for one split window.
#[derive(Serialize, Clone, Debug)]
pub struct PaneLayout {
    pub label: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Serializable view of an active split session.
#[derive(Serialize, Clone, Debug)]
pub struct SplitLayoutInfo {
    /// `"vertical"` (left/right) or `"horizontal"` (top/bottom).
    pub axis: String,
    /// First pane's share of the usable extent (1..=99).
    pub percent: u32,
    /// Window in the first (primary) pane.
    pub primary: String,
    /// Window in the second pane.
    pub secondary: String,
    /// The two pane rects (index 0 = primary).
    pub panes: Vec<PaneLayout>,
}

/// Serializable snapshot of the layout sub-state.
#[derive(Serialize, Clone, Debug)]
pub struct LayoutSnapshot {
    pub screen_w: u32,
    pub screen_h: u32,
    /// The active split, if any.
    pub split: Option<SplitLayoutInfo>,
    /// The labels the host offers for entering a split.
    pub candidates: Vec<String>,
}

fn parse_axis(s: &str) -> Result<SplitAxis, String> {
    match s {
        "vertical" | "v" => Ok(SplitAxis::Vertical),
        "horizontal" | "h" => Ok(SplitAxis::Horizontal),
        other => Err(format!(
            "unknown split axis: {other:?} (vertical|horizontal)"
        )),
    }
}

fn pane(label: String, b: Bounds) -> PaneLayout {
    PaneLayout {
        label,
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
    }
}

/// Build a [`LayoutSnapshot`] from an already-locked core (no re-locking).
fn layout_core(core: &WmCore) -> Result<LayoutSnapshot, String> {
    let split = match &core.split {
        Some(sp) => {
            let (a, b) = sp
                .bounds()
                .ok_or_else(|| "split geometry is not available".to_string())?;
            let primary = core.labels.get(&sp.primary).cloned().unwrap_or_default();
            let secondary = core.labels.get(&sp.secondary).cloned().unwrap_or_default();
            Some(SplitLayoutInfo {
                axis: match sp.axis {
                    SplitAxis::Vertical => "vertical",
                    SplitAxis::Horizontal => "horizontal",
                }
                .to_string(),
                percent: sp.percent(),
                primary: primary.clone(),
                secondary: secondary.clone(),
                panes: vec![pane(primary, a), pane(secondary, b)],
            })
        }
        None => None,
    };
    let candidates = core
        .wm
        .split_candidates()
        .into_iter()
        .filter_map(|id| core.labels.get(&id).cloned())
        .collect();
    Ok(LayoutSnapshot {
        screen_w: core.screen.width,
        screen_h: core.screen.height,
        split,
        candidates,
    })
}

/// Common tail of a mutating layout command: apply the (possibly empty) split to
/// the real windows, broadcast a `layout-changed` event with the new snapshot, and
/// return it. Emitting the *authoritative* reply lets non-initiating surfaces
/// refresh without their own command round-trip.
fn finish_layout(
    app: &AppHandle,
    state: &WmState,
    snap: &LayoutSnapshot,
) -> Result<LayoutSnapshot, String> {
    state.apply_split_to_real(app)?;
    let _ = app.emit(LAYOUT_EVENT, snap);
    Ok(snap.clone())
}

// ---- Tauri commands (frontend: `invoke('wm_open', { label })`) ----

/// Read-only snapshot of the multi-window layout state.
#[tauri::command]
pub fn wm_layout_snapshot(state: State<'_, WmState>) -> Result<LayoutSnapshot, String> {
    state.layout_snapshot()
}

/// Set the full window area the split layout sub-divides (re-applies any live
/// split to the real windows + broadcasts `layout-changed`).
#[tauri::command]
pub fn wm_layout_set_screen(
    app: AppHandle,
    state: State<'_, WmState>,
    width: u32,
    height: u32,
) -> Result<LayoutSnapshot, String> {
    let snap = state.set_screen(width, height)?;
    finish_layout(&app, &state, &snap)
}

/// Enter a split between two windows (`axis`: `vertical`|`horizontal`) and apply
/// the panes to the real windows.
#[tauri::command]
pub fn wm_split(
    app: AppHandle,
    state: State<'_, WmState>,
    primary: String,
    secondary: String,
    axis: String,
) -> Result<LayoutSnapshot, String> {
    let snap = state.enter_split(&primary, &secondary, &axis)?;
    finish_layout(&app, &state, &snap)
}

/// Set the divider so the primary pane takes `percent` (1..=99), re-applying to
/// the real windows.
#[tauri::command]
pub fn wm_split_resize(
    app: AppHandle,
    state: State<'_, WmState>,
    percent: u32,
) -> Result<LayoutSnapshot, String> {
    let snap = state.split_resize(percent)?;
    finish_layout(&app, &state, &snap)
}

/// Move the divider by `delta` percentage points, re-applying to the real windows.
#[tauri::command]
pub fn wm_split_move(
    app: AppHandle,
    state: State<'_, WmState>,
    delta: i32,
) -> Result<LayoutSnapshot, String> {
    let snap = state.split_move(delta)?;
    finish_layout(&app, &state, &snap)
}

/// Swap which window is in the primary pane, re-applying to the real windows and
/// giving the **new primary** window OS focus (input routing follows the swap).
#[tauri::command]
pub fn wm_split_swap(app: AppHandle, state: State<'_, WmState>) -> Result<LayoutSnapshot, String> {
    let snap = state.split_swap()?;
    finish_layout(&app, &state, &snap)?;
    // After a swap, focus the window that is now the primary pane.
    if let Some((primary, _)) = state.split_labels()? {
        if let Some(w) = app.get_webview_window(&primary) {
            let _ = w.set_focus();
        }
    }
    Ok(snap)
}

/// End the active split: restore the two windows to fullscreen (maximize them),
/// clear the split state, and broadcast `layout-changed`.
#[tauri::command]
pub fn wm_split_exit(app: AppHandle, state: State<'_, WmState>) -> Result<LayoutSnapshot, String> {
    // Remember which windows were split before clearing, so we can restore them.
    let pair = state.split_labels()?;
    let snap = state.split_exit()?;
    if let Some((a, b)) = pair {
        for label in [a, b] {
            if let Some(w) = app.get_webview_window(&label) {
                // Returning a split pane to the "full" screen = maximize. Honest
                // fallback when no exact pre-split geometry was captured.
                let _ = w.maximize();
            }
        }
    }
    finish_layout(&app, &state, &snap)
}

/// GUI demo entry for the real multi-window host: pick the two front split
/// candidates, `enter_split` them, then animate a divider cycle — resize 40 →
/// swap → resize 60 → swap — and finally `exit`. Every step is applied to the
/// real windows and broadcast as `layout-changed`, so a dev window can watch the
/// panes move. Requires a live multi-window Tauri app to be visually meaningful.
#[tauri::command]
pub async fn wm_split_demo(
    app: AppHandle,
    state: State<'_, WmState>,
) -> Result<LayoutSnapshot, String> {
    let candidates = state.split_candidates_labels()?;
    if candidates.len() < 2 {
        return Err("need at least two open windows to run the split demo".to_string());
    }
    let a = candidates[0].clone();
    let b = candidates[1].clone();

    let step_ms = std::time::Duration::from_millis(500);
    let mut snap = state.enter_split(&a, &b, "vertical")?;
    finish_layout(&app, &state, &snap)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_resize(40)?;
    finish_layout(&app, &state, &snap)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_swap()?;
    finish_layout(&app, &state, &snap)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_resize(60)?;
    finish_layout(&app, &state, &snap)?;
    tokio::time::sleep(step_ms).await;

    snap = state.split_swap()?;
    finish_layout(&app, &state, &snap)?;
    tokio::time::sleep(step_ms).await;

    // Restore: maximize the two windows and clear the split.
    let pair = state.split_labels()?;
    snap = state.split_exit()?;
    if let Some((x, y)) = pair {
        for label in [x, y] {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.maximize();
            }
        }
    }
    finish_layout(&app, &state, &snap)
}

/// The window labels the host can offer for entering a split.
#[tauri::command]
pub fn wm_split_candidates(state: State<'_, WmState>) -> Result<Vec<String>, String> {
    state.split_candidates_labels()
}

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

    #[test]
    fn layout_split_resize_swap_exit_round_trip() {
        let s = WmState::new();
        s.open_surface("legacy:notes").unwrap();
        s.open_surface("legacy:maps").unwrap();
        assert_eq!(
            s.layout_snapshot().unwrap().candidates,
            vec!["legacy:maps", "legacy:notes"],
            "front two shown, non-Launcher surfaces are split candidates"
        );

        let snap = s
            .enter_split("legacy:notes", "legacy:maps", "vertical")
            .unwrap();
        let info = snap.split.expect("split active");
        assert_eq!(info.primary, "legacy:notes");
        assert_eq!(info.secondary, "legacy:maps");
        assert_eq!(info.axis, "vertical");
        assert_eq!(snap.screen_w, 1080);
        assert_eq!(
            s.split_labels().unwrap(),
            Some(("legacy:notes".to_string(), "legacy:maps".to_string()))
        );
        assert_eq!(info.panes.len(), 2);
        // The two panes tile the screen minus the divider gap.
        let total: u64 = info.panes.iter().map(|p| u64::from(p.width)).sum();
        assert_eq!(total + u64::from(SPLIT_GAP), 1080);

        // Feasible divider move.
        let r = s.split_resize(40).unwrap().split.unwrap();
        assert_eq!(r.percent, 40);

        // Swap flips which window is primary.
        let sw = s.split_swap().unwrap().split.unwrap();
        assert_eq!(sw.primary, "legacy:maps");
        assert_eq!(sw.secondary, "legacy:notes");

        // Exit clears the split (and the host then maximizes those windows).
        assert!(s.split_exit().unwrap().split.is_none());
        assert_eq!(s.split_labels().unwrap(), None);
    }

    #[test]
    fn layout_split_rejects_bad_input_and_set_screen_can_end_a_split() {
        let s = WmState::new();
        s.open_surface("legacy:a").unwrap();
        s.open_surface("legacy:b").unwrap();

        // Same window twice.
        assert!(s.enter_split("legacy:a", "legacy:a", "vertical").is_err());
        // Unknown axis.
        assert!(s.enter_split("legacy:a", "legacy:b", "diagonal").is_err());
        // Launcher cannot be split.
        assert!(s.enter_split("main", "legacy:a", "vertical").is_err());
        // A divider share below the minimum size is rejected.
        let _ = s.enter_split("legacy:a", "legacy:b", "vertical").unwrap();
        assert!(
            s.split_resize(5).is_err(),
            "5% pane is below the minimum size"
        );
        assert_eq!(s.layout_snapshot().unwrap().split.unwrap().percent, 50);

        // Shrinking the screen below the min panes ends the split (no silent clamp).
        let snap = s.set_screen(200, 100).unwrap();
        assert!(snap.split.is_none());
        assert_eq!((snap.screen_w, snap.screen_h), (200, 100));
    }
}
