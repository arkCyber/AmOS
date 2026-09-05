//! `amos-wm` — transport-agnostic window manager state machine.
//!
//! This crate models *only the decision logic* of the Amos multi-window OS:
//! which window is focused, the z-order (bring-to-front), and how
//! open/focus/hide/close/home transition state. It knows nothing about Tauri,
//! Winit, the WebView, or the mobile shell — a thin adapter in `amos-tauri`
//! maps `WmEvent`s to real `WebviewWindow::show()/hide()/set_focus()` calls.
//!
//! Design rules enforced here:
//!   * Exactly one **Launcher** (the root, immortal, always at the bottom).
//!   * At most one window is `Focused`; focusing another demotes the current
//!     one to `Shown`.
//!   * The focus stack ("recents") keeps the most-recently-used window on top;
//!     hiding/closing the focused window restores focus to the previous one.
//!   * Transitions return `WmEvent`s for the host to apply to the real backend.

// P0-1 gate: production code must not panic on programmer error. Test code is
// exempt (assertions/unwrap are idiomatic there).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Desktop geometry / split-screen domain (see [`crate::layout`]).
pub mod layout;
/// Split-screen session over two windows (see [`crate::split`]).
pub mod split;

/// Opaque identifier for a window, allocated by [`WindowManager::register`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WindowId(pub u64);

/// Broad purpose of a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WindowKind {
    /// The home screen / launcher. Exactly one, immortal, always at the bottom.
    Launcher,
    /// A user-facing application.
    App,
    /// A system surface (notification center, control panel, dialogs).
    System,
}

impl std::fmt::Display for WindowKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            WindowKind::Launcher => "Launcher",
            WindowKind::App => "App",
            WindowKind::System => "System",
        })
    }
}

/// Visibility / focus of a single window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WindowState {
    Hidden,
    Shown,
    Focused,
}

impl std::fmt::Display for WindowState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            WindowState::Hidden => "Hidden",
            WindowState::Shown => "Shown",
            WindowState::Focused => "Focused",
        })
    }
}

/// A state transition the host must apply to the real windowing backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WmEvent {
    /// A window was created (host should build the real window, hidden).
    Created(WindowId),
    /// A window was removed for good (host should destroy it).
    Closed(WindowId),
    /// A window became visible.
    Shown(WindowId),
    /// A window became hidden.
    Hidden(WindowId),
    /// The focused window changed; `None` means nothing is focused.
    FocusChanged(Option<WindowId>),
}

struct WindowMeta {
    id: WindowId,
    kind: WindowKind,
    state: WindowState,
}

/// The multi-window state machine.
pub struct WindowManager {
    windows: Vec<WindowMeta>,
    /// Most-recently-used order; the back is the focused window.
    focus_stack: VecDeque<WindowId>,
    next_id: u64,
}

impl WindowManager {
    /// Create a manager and immediately register + focus its Launcher.
    pub fn new() -> Self {
        let mut wm = Self {
            windows: Vec::new(),
            focus_stack: VecDeque::new(),
            next_id: 0,
        };
        let (launcher, _created) = wm.register(WindowKind::Launcher);
        wm.focus(launcher);
        wm
    }

    /// Register a new window (initially hidden). Returns its id plus the
    /// `Created` event the host must apply to build the real window.
    ///
    /// Emitting `Created` here — not just in the host — keeps the "every
    /// transition produces events" contract uniform: the Tauri adapter can then
    /// mirror the exact same state machine in real windows without guessing
    /// which windows already exist.
    pub fn register(&mut self, kind: WindowKind) -> (WindowId, Vec<WmEvent>) {
        let id = WindowId(self.next_id);
        self.next_id += 1;
        self.windows.push(WindowMeta {
            id,
            kind,
            state: WindowState::Hidden,
        });
        (id, vec![WmEvent::Created(id)])
    }

    /// Bring `id` to the foreground and focus it (shows it if hidden).
    pub fn open(&mut self, id: WindowId) -> Vec<WmEvent> {
        let mut events = Vec::new();
        if let Some(m) = self.windows.iter_mut().find(|w| w.id == id) {
            if m.state == WindowState::Hidden {
                m.state = WindowState::Shown;
                events.push(WmEvent::Shown(id));
            }
        }
        events.extend(self.focus(id));
        events
    }

    /// Focus an existing window (no visibility change).
    pub fn focus(&mut self, id: WindowId) -> Vec<WmEvent> {
        let mut events = Vec::new();
        if !self.windows.iter().any(|w| w.id == id) {
            return events;
        }
        // Demote the current focused window.
        if let Some(fid) = self.focused() {
            if fid != id {
                if let Some(m) = self.windows.iter_mut().find(|w| w.id == fid) {
                    m.state = WindowState::Shown;
                }
            }
        }
        self.focus_stack.retain(|x| *x != id);
        self.focus_stack.push_back(id);
        if let Some(m) = self.windows.iter_mut().find(|w| w.id == id) {
            m.state = WindowState::Focused;
        }
        events.push(WmEvent::FocusChanged(Some(id)));
        events
    }

    /// Hide `id`. If it was focused, focus falls back to the previous window.
    pub fn hide(&mut self, id: WindowId) -> Vec<WmEvent> {
        let mut events = Vec::new();
        let was_focused = self.focused() == Some(id);
        let Some(meta) = self.windows.iter_mut().find(|w| w.id == id) else {
            return events;
        };
        if meta.kind == WindowKind::Launcher || meta.state == WindowState::Hidden {
            return events;
        }
        meta.state = WindowState::Hidden;
        events.push(WmEvent::Hidden(id));
        if was_focused {
            let fallback = self.promote_fallback_after(id);
            events.push(WmEvent::FocusChanged(fallback));
        }
        events
    }

    /// Permanently close `id` (except the Launcher, which is immortal). The window
    /// is removed from the recents stack whether or not it was focused.
    pub fn close(&mut self, id: WindowId) -> Vec<WmEvent> {
        let mut events = Vec::new();
        let was_focused = self.focused() == Some(id);
        let kind = self.windows.iter().find(|w| w.id == id).map(|w| w.kind);
        if kind == Some(WindowKind::Launcher) {
            return events;
        }
        self.windows.retain(|w| w.id != id);
        // Purge the closed window from recents and, if it was the top, promote the
        // next most-recent window to Focused so `focused()` stays consistent.
        let fallback = self.promote_fallback_after(id);
        events.push(WmEvent::Closed(id));
        if was_focused {
            events.push(WmEvent::FocusChanged(fallback));
        }
        events
    }

    /// After removing a *focused* window from the recents stack, promote the new
    /// top of the stack to [`WindowState::Focused`] so `focused()` always agrees
    /// with exactly one window being `Focused`. Returns the new focus (if any).
    fn promote_fallback_after(&mut self, removed: WindowId) -> Option<WindowId> {
        self.focus_stack.retain(|x| *x != removed);
        let fallback = self.focus_stack.back().copied();
        if let Some(fb) = fallback {
            if let Some(m) = self.windows.iter_mut().find(|w| w.id == fb) {
                m.state = WindowState::Focused;
            }
        }
        fallback
    }

    /// Return to the home screen: focus the Launcher.
    pub fn home(&mut self) -> Vec<WmEvent> {
        match self.windows.iter().find(|w| w.kind == WindowKind::Launcher) {
            Some(l) => self.focus(l.id),
            None => Vec::new(),
        }
    }

    /// The currently focused window, if any.
    pub fn focused(&self) -> Option<WindowId> {
        self.focus_stack.back().copied()
    }

    /// Windows in front-to-back z-order (front first).
    pub fn z_order(&self) -> Vec<WindowId> {
        self.focus_stack.iter().rev().copied().collect()
    }

    /// Current state of a window, or `None` if unknown.
    pub fn state_of(&self, id: WindowId) -> Option<WindowState> {
        self.windows.iter().find(|w| w.id == id).map(|w| w.state)
    }

    /// All known window ids (any order).
    pub fn windows(&self) -> Vec<WindowId> {
        self.windows.iter().map(|w| w.id).collect()
    }

    /// Id of the Launcher.
    pub fn launcher(&self) -> Option<WindowId> {
        self.windows
            .iter()
            .find(|w| w.kind == WindowKind::Launcher)
            .map(|w| w.id)
    }

    /// The most recent two **shown, non-Launcher** windows, front-to-back — the
    /// natural candidates the host offers for entering split-screen. Fewer than
    /// two means there is nothing to split.
    pub fn split_candidates(&self) -> Vec<WindowId> {
        self.focus_stack
            .iter()
            .rev()
            .filter(|id| {
                self.state_of(**id) != Some(WindowState::Hidden)
                    && self.windows.iter().find(|w| w.id == **id).map(|w| w.kind)
                        != Some(WindowKind::Launcher)
            })
            .take(2)
            .copied()
            .collect()
    }
}

impl Default for WindowManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_is_focused_on_start() {
        let wm = WindowManager::new();
        assert_eq!(wm.windows().len(), 1);
        assert_eq!(wm.launcher(), wm.focused());
    }

    #[test]
    fn opening_an_app_focuses_it_and_demotes_previous() {
        let mut wm = WindowManager::new();
        let launcher = wm.launcher().unwrap();
        let app = wm.register(WindowKind::App).0;
        wm.open(app);
        assert_eq!(wm.focused(), Some(app));
        assert_eq!(wm.state_of(launcher), Some(WindowState::Shown));
        assert_eq!(wm.state_of(app), Some(WindowState::Focused));
        assert_eq!(wm.z_order(), vec![app, launcher]);
    }

    #[test]
    fn z_order_bring_to_front_on_refocus() {
        let mut wm = WindowManager::new();
        let a = wm.register(WindowKind::App).0;
        let b = wm.register(WindowKind::App).0;
        wm.open(a);
        wm.open(b);
        assert_eq!(wm.z_order(), vec![b, a, wm.launcher().unwrap()]);
        wm.focus(a);
        assert_eq!(wm.focused(), Some(a));
        assert_eq!(wm.z_order(), vec![a, b, wm.launcher().unwrap()]);
    }

    #[test]
    fn hiding_focused_restores_previous_focus() {
        let mut wm = WindowManager::new();
        let a = wm.register(WindowKind::App).0;
        let b = wm.register(WindowKind::App).0;
        wm.open(a);
        wm.open(b);
        assert_eq!(wm.focused(), Some(b));
        wm.hide(b);
        assert_eq!(wm.focused(), Some(a), "focus falls back to previous app");
    }

    #[test]
    fn closing_focused_returns_to_launcher_when_nothing_left() {
        let mut wm = WindowManager::new();
        let app = wm.register(WindowKind::App).0;
        wm.open(app);
        assert_eq!(wm.focused(), Some(app));
        wm.close(app);
        assert_eq!(
            wm.focused(),
            wm.launcher(),
            "back to launcher after closing last app"
        );
        assert!(!wm.windows().contains(&app), "app window removed");
    }

    #[test]
    fn launcher_cannot_be_hidden_or_closed() {
        let mut wm = WindowManager::new();
        let launcher = wm.launcher().unwrap();
        assert!(wm.hide(launcher).is_empty(), "launcher hide is a no-op");
        assert!(wm.close(launcher).is_empty(), "launcher close is a no-op");
        assert!(wm.windows().contains(&launcher));
    }

    #[test]
    fn home_focuses_launcher() {
        let mut wm = WindowManager::new();
        let app = wm.register(WindowKind::App).0;
        wm.open(app);
        wm.home();
        assert_eq!(wm.focused(), wm.launcher());
    }

    #[test]
    fn system_window_sits_above_launcher_but_not_apps() {
        let mut wm = WindowManager::new();
        let app = wm.register(WindowKind::App).0;
        let sys = wm.register(WindowKind::System).0;
        wm.open(app);
        wm.open(sys);
        assert_eq!(wm.focused(), Some(sys));
        assert_eq!(wm.z_order(), vec![sys, app, wm.launcher().unwrap()]);
    }

    #[test]
    fn open_emits_shown_then_focus_changed() {
        let mut wm = WindowManager::new();
        let app = wm.register(WindowKind::App).0;
        let events = wm.open(app);
        assert!(events.contains(&WmEvent::Shown(app)), "shows the window");
        assert!(
            events.contains(&WmEvent::FocusChanged(Some(app))),
            "focuses it"
        );
    }

    #[test]
    fn register_emits_created_event() {
        let mut wm = WindowManager::new();
        let (app, events) = wm.register(WindowKind::App);
        assert!(events.contains(&WmEvent::Created(app)), "emits Created");
        assert!(
            events.len() == 1,
            "registration produces exactly one event, got {events:?}"
        );
    }

    /// Core invariants the manager must satisfy at every instant.
    fn assert_wm_invariants(wm: &WindowManager) {
        let launcher = wm.launcher().expect("launcher always present");
        // At most one window is Focused.
        let focused_count = wm
            .windows()
            .iter()
            .filter(|id| wm.state_of(**id) == Some(WindowState::Focused))
            .count();
        assert!(focused_count <= 1, ">1 focused windows: {focused_count}");
        // `focused()` must agree with the Focused *state* in both directions:
        // exactly the single Focused window is reported, and the reported window
        // is actually in the Focused state (catches demote-then-fallback bugs).
        match wm.focused() {
            Some(f) => {
                assert_eq!(
                    focused_count, 1,
                    "focused()={f:?} but {focused_count} windows are Focused"
                );
                assert_eq!(wm.state_of(f), Some(WindowState::Focused));
                let only = wm
                    .windows()
                    .iter()
                    .find(|id| wm.state_of(**id) == Some(WindowState::Focused))
                    .copied();
                assert_eq!(only, Some(f), "focused() and the Focused state disagree");
            }
            None => assert_eq!(
                focused_count, 0,
                "no focus reported but {focused_count} windows are Focused"
            ),
        }
        // The Launcher is immortal and never hidden. (It is *not* required to be
        // the last entry in `z_order`: `home()`/focus legitimately raise it to the
        // top. "At the bottom" is a stacking rule when apps are above it, not an
        // absolute ordering invariant while it is focused.)
        let launcher_state = wm.state_of(launcher);
        assert!(
            matches!(
                launcher_state,
                Some(WindowState::Shown) | Some(WindowState::Focused)
            ),
            "launcher must be shown/focused, got {launcher_state:?}"
        );
        assert!(
            wm.windows().contains(&launcher),
            "launcher window must remain present"
        );
    }

    /// Aerospace-grade property test: after every step of a long deterministic
    /// script of open/focus/hide/close/home the manager invariants still hold.
    #[test]
    fn invariants_hold_across_a_deterministic_operation_script() {
        let mut wm = WindowManager::new();
        let mut ids: Vec<WindowId> = Vec::new();
        for _ in 0..6 {
            ids.push(wm.register(WindowKind::App).0);
        }
        ids.push(wm.register(WindowKind::System).0);
        assert_wm_invariants(&wm);

        // Deterministic LCG (no external rng dependency).
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move || {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (seed >> 33) as usize
        };

        for _ in 0..2000 {
            let op = next() % 5;
            let id = ids[next() % ids.len()];
            match op {
                0 => {
                    wm.open(id);
                }
                1 => {
                    wm.focus(id);
                }
                2 => {
                    wm.hide(id);
                }
                3 => {
                    wm.close(id);
                }
                _ => {
                    wm.home();
                }
            }
            assert_wm_invariants(&wm);
        }
    }

    #[test]
    fn hiding_focused_promotes_fallback_to_focused_state() {
        let mut wm = WindowManager::new();
        let a = wm.register(WindowKind::App).0;
        let b = wm.register(WindowKind::App).0;
        wm.open(a);
        wm.open(b);
        assert_eq!(wm.focused(), Some(b));

        wm.hide(b);
        assert_eq!(wm.focused(), Some(a), "focus falls back to previous app");
        assert_eq!(
            wm.state_of(a),
            Some(WindowState::Focused),
            "fallback window must be Focused, not merely Shown"
        );
        assert_eq!(wm.state_of(b), Some(WindowState::Hidden));
        assert_eq!(
            wm.windows()
                .iter()
                .filter(|id| wm.state_of(**id) == Some(WindowState::Focused))
                .count(),
            1,
            "exactly one Focused window after hiding the focused one"
        );
    }

    #[test]
    fn closing_focused_promotes_launcher_when_nothing_left() {
        let mut wm = WindowManager::new();
        let launcher = wm.launcher().unwrap();
        let app = wm.register(WindowKind::App).0;
        wm.open(app);
        assert_eq!(wm.focused(), Some(app));

        wm.close(app);
        assert_eq!(wm.focused(), Some(launcher));
        assert_eq!(wm.state_of(launcher), Some(WindowState::Focused));
        assert_eq!(wm.windows().len(), 1, "only the launcher remains");
    }

    #[test]
    fn closing_a_background_window_purges_it_from_recents() {
        let mut wm = WindowManager::new();
        let a = wm.register(WindowKind::App).0;
        let b = wm.register(WindowKind::App).0;
        wm.open(a);
        wm.open(b); // b focused, a is background
        wm.close(a); // closing a non-focused window

        assert!(
            !wm.z_order().contains(&a),
            "closed background window must leave the recents/z-order"
        );
        assert_eq!(wm.focused(), Some(b));
        assert_eq!(wm.state_of(b), Some(WindowState::Focused));
        assert_wm_invariants(&wm);
    }

    #[test]
    fn split_candidates_returns_front_two_shown_non_launcher() {
        let mut wm = WindowManager::new();
        let a = wm.register(WindowKind::App).0;
        let b = wm.register(WindowKind::App).0;
        let _sys = wm.register(WindowKind::System).0; // stays hidden
        wm.open(a);
        wm.open(b);

        assert_eq!(
            wm.split_candidates(),
            vec![b, a],
            "front two shown, non-Launcher windows"
        );

        // Hiding the focused app removes it from the candidates.
        wm.hide(b);
        assert_eq!(wm.split_candidates(), vec![a]);
    }
}
