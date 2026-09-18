//! `menu` — native macOS menu bar (Aqua Global Menu).
//!
//! Installs a real macOS menu bar via Tauri 2's `tauri::menu` API, so the shell
//! presents a genuine Aqua experience instead of a fake web-app bar.
//!
//! ## macOS Global Menu rules (enforced by `MenuBuilder` docs)
//!
//! * A **global menu** (`.set_menu()`) can only contain [`Submenu`]s — a bare
//!   `MenuItem` has nowhere to live without a parent menu.
//! * Every menu lives in **one** tree; items are consumed by `.build()` and cannot
//!   be reused.
//!
//! ## Menu event routing
//!
//! `on_menu_event` fires with the item's `id`; we forward that to the frontend
//! as a `menu-event` so the WebView can react (e.g. open Preferences, request a
//! "new window").  Three items are handled here in Rust because they are
//! genuinely host-owned:
//!
//!   * `menu.about`       → emits `show-about-dialog` (frontend may render it)
//!   * `menu.quit`        → terminates the process
//!   * `menu.hide-amos`   → hides the launcher window
//!
//! ## Why a single global menu, not per-window
//!
//! macOS expects **one** menu bar per app, swapping per-window content via the
//! Window menu (a focused-window submenu).  Tauri exposes `window.set_menu()` for
//! per-window overrides, but on macOS the global menu is what the user sees —
//! leaving it set app-wide is the macOS-correct behaviour.

use tauri::{
    menu::{Menu, MenuBuilder, MenuEvent, MenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, Runtime,
};

/// Stable ids for every menu item — these are what `MenuEvent::id()` returns.
///
/// One source of truth so the frontend can pattern-match without typos.
pub mod ids {
    /// Apple menu (always-present on macOS, named after the app by convention).
    pub const ABOUT: &str = "menu.about";
    pub const PREFERENCES: &str = "menu.preferences";
    pub const SERVICES: &str = "menu.services";
    pub const HIDE_AMOS: &str = "menu.hide-amos";
    pub const HIDE_OTHERS: &str = "menu.hide-others";
    pub const SHOW_ALL: &str = "menu.show-all";
    pub const QUIT: &str = "menu.quit";

    /// File menu.
    pub const NEW_WINDOW: &str = "menu.new-window";
    pub const CLOSE_WINDOW: &str = "menu.close-window";

    /// View menu.
    pub const MINIMIZE: &str = "menu.minimize";
    pub const ZOOM: &str = "menu.zoom";
    pub const ENTER_FULLSCREEN: &str = "menu.enter-fullscreen";
}

/// Rust-handled items — consumed in Rust with no frontend event.
const RUST_HANDLED: &[&str] = &[ids::ABOUT, ids::QUIT, ids::HIDE_AMOS];

/// Items that **terminate** the event after Rust handles them (no frontend echo).
const TERMINAL_RUST: &[&str] = &[ids::QUIT];

/// Build the complete native macOS menu bar and install it.
///
/// Called once at startup from [`crate::run`]`::setup`.  The menu tree is owned by
/// macOS once installed; we hold no reference after this.
#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let menu = build_menu(app)?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    tracing::info!(target: "amos::menu", "native macOS menu bar installed");
    Ok(())
}

/// Non-macOS desktop: log a single info line and return success so the boot path
/// is identical across desktop targets.  Windows / Linux GTK menus are out of
/// scope for this iteration (`docs/mac-menu.md`).
#[cfg(not(target_os = "macos"))]
pub fn install<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
    tracing::debug!(
        target: "amos::menu",
        "native menu bar only installs on macOS; non-mac desktop builds compile but skip"
    );
    Ok(())
}

/// Build the full menu tree.
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> Result<Menu<R>, String> {
    // ── Apple menu (the "Amos" menu, per macOS convention) ──────────────────
    let apple = SubmenuBuilder::new(app, "Amos")
        .item(&item(app, ids::ABOUT, "About Amos", true, None)?)
        .separator()
        .item(&item(
            app,
            ids::PREFERENCES,
            "Preferences…",
            true,
            Some("CmdOrCtrl+,"),
        )?)
        .separator()
        .item(&item(app, ids::SERVICES, "Services", false, None)?) // placeholder
        .separator()
        .item(&item(
            app,
            ids::HIDE_AMOS,
            "Hide Amos",
            true,
            Some("CmdOrCtrl+H"),
        )?)
        .item(&item(
            app,
            ids::HIDE_OTHERS,
            "Hide Others",
            true,
            Some("CmdOrCtrl+Alt+H"),
        )?)
        .item(&item(app, ids::SHOW_ALL, "Show All", true, None)?)
        .build()
        .map_err(|e| e.to_string())?;

    // ── File menu ────────────────────────────────────────────────────────────
    let file = SubmenuBuilder::new(app, "File")
        .item(&item(
            app,
            ids::NEW_WINDOW,
            "New Window",
            true,
            Some("CmdOrCtrl+N"),
        )?)
        .separator()
        .item(&item(
            app,
            ids::CLOSE_WINDOW,
            "Close Window",
            true,
            Some("CmdOrCtrl+W"),
        )?)
        .build()
        .map_err(|e| e.to_string())?;

    // ── Edit menu (predefined: undo/redo/cut/copy/paste/select-all) ─────────
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .build()
        .map_err(|e| e.to_string())?;

    // ── View menu ─────────────────────────────────────────────────────────────
    let view = SubmenuBuilder::new(app, "View")
        .item(&item(
            app,
            ids::MINIMIZE,
            "Minimize",
            true,
            Some("CmdOrCtrl+M"),
        )?)
        .item(&item(app, ids::ZOOM, "Zoom", true, None)?)
        .separator()
        .item(&item(
            app,
            ids::ENTER_FULLSCREEN,
            "Enter Full Screen",
            true,
            Some("Ctrl+Cmd+F"),
        )?)
        .build()
        .map_err(|e| e.to_string())?;

    // ── Window menu (predefined minimize/zoom are platform-provided) ─────────
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()
        .map_err(|e| e.to_string())?;

    // ── Help menu ─────────────────────────────────────────────────────────────
    let help = SubmenuBuilder::new(app, "Help")
        .build()
        .map_err(|e| e.to_string())?;

    // ── Root: macOS global menu must contain ONLY Submenus ─────────────────────
    MenuBuilder::new(app)
        .item(&apple)
        .item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .item(&help)
        .build()
        .map_err(|e| e.to_string())
}

/// Create a labelled `MenuItem` with optional accelerator.
fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    enabled: bool,
    accelerator: Option<&str>,
) -> Result<MenuItem<R>, String> {
    MenuItem::with_id(app, id, label, enabled, accelerator).map_err(|e| e.to_string())
}

/// Forward a `MenuEvent` to the frontend as a Tauri event, and handle Rust-only
/// items in-process.
///
/// Called from [`crate::run`]`::on_menu_event`.
#[cfg(target_os = "macos")]
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    tracing::debug!(target: "amos::menu", id, "menu item activated");

    if RUST_HANDLED.contains(&id) {
        match id {
            ids::ABOUT => {
                show_about_dialog(app);
            }
            ids::QUIT => {
                tracing::info!(target: "amos::menu", "Quit requested from menu");
                std::process::exit(0);
            }
            ids::HIDE_AMOS => {
                if let Some(window) = app.get_webview_window("main") {
                    // Hiding can fail (the window may already be gone). A menu action that
                    // silently does nothing is worse than a log line — same rule as
                    // `dock_badge.rs`'s event mirror (REQ-A387: this was a `let _ =`).
                    if let Err(e) = window.hide() {
                        tracing::warn!(
                            target: "amos::menu",
                            error = %e,
                            "Hiding the main window failed"
                        );
                    }
                }
            }
            _ => unreachable!("all RUST_HANDLED ids must be matched above"),
        }
        if TERMINAL_RUST.contains(&id) {
            return;
        }
    }

    // Forward everything (including Rust-handled non-terminal events like About)
    // to the frontend so it can update its own UI in lockstep with native chrome.
    if let Err(e) = app.emit("menu-event", id) {
        tracing::warn!(
            target: "amos::menu",
            error = %e,
            id,
            "menu event could not be delivered to the frontend"
        );
    }
}

/// Show the About dialog.
///
/// Currently a simple informational event.  A real NSAlert / native dialog would
/// require an `NSApplication.shared.runModal(for:)` call over FFI, which is a
/// larger step (Phase 2).  For now we emit a `show-about-dialog` event the
/// frontend can surface however it likes.
#[cfg(target_os = "macos")]
fn show_about_dialog<R: Runtime>(app: &AppHandle<R>) {
    let version = option_env!("CARGO_PKG_VERSION").unwrap_or("unknown");
    tracing::info!(
        target: "amos::menu",
        version,
        "About dialog requested from menu"
    );
    // The frontend has no consumer for this yet (no About surface exists), so the
    // emission routinely finds no listener — record *that* instead of dropping it on
    // the floor with `let _ =` (REQ-A387; `dock_badge.rs` does the same for its event).
    if let Err(e) = app.emit("show-about-dialog", version) {
        tracing::debug!(
            target: "amos::menu",
            error = %e,
            "show-about-dialog event could not be delivered (no listener)"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_rust_handled_id_is_classified() {
        // The `RUST_HANDLED` set is the union of (terminal, non-terminal) — every
        // entry must be classified, otherwise the runtime unreachable!() above
        // will panic for an un-matched id.
        for id in RUST_HANDLED {
            let is_terminal = TERMINAL_RUST.contains(id);
            let is_non_terminal = matches!(*id, ids::ABOUT | ids::HIDE_AMOS);
            assert!(
                is_terminal || is_non_terminal,
                "{id} must be either terminal or explicitly non-terminal"
            );
        }
    }

    #[test]
    fn menu_ids_are_unique() {
        // A duplicated id would silently shadow the first entry (muda keeps the
        // first registration), so the frontend would never see the second.
        let mut all: Vec<&str> = vec![
            ids::ABOUT,
            ids::PREFERENCES,
            ids::SERVICES,
            ids::HIDE_AMOS,
            ids::HIDE_OTHERS,
            ids::SHOW_ALL,
            ids::QUIT,
            ids::NEW_WINDOW,
            ids::CLOSE_WINDOW,
            ids::MINIMIZE,
            ids::ZOOM,
            ids::ENTER_FULLSCREEN,
        ];
        all.sort_unstable();
        let len = all.len();
        all.dedup();
        assert_eq!(all.len(), len, "menu ids must not collide");
    }
}
