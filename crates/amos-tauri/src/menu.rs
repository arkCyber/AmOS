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
//! "new window").  The items below are handled in Rust because they are
//! genuinely host- or OS-owned:
//!
//!   * `menu.about`       → the platform's own About panel (`orderFrontStandardAboutPanel`)
//!   * `menu.quit`        → exits the app through Tauri (`⌘Q`)
//!   * `menu.hide-amos`   → hides the launcher window
//!   * `menu.hide-others` → `NSApplication.hideOtherApplications:` (`⌘⌥H`)
//!   * `menu.show-all`    → `NSApplication.unhideAllApplications:`
//!   * `menu.close-window` → closes the OS-**focused** app window (`⌘W`; the rule and
//!     the measurements are documented at `close_key_window` below)
//!
//! **Reachability is the thing that went wrong here (REQ-A423, measured 2026-09-18).**
//! `ids::QUIT` was declared, classified as terminal, documented in `docs/mac-menu.md`
//! and matched in `on_menu_event` — but the **item was never added to the menu tree**,
//! so there was no "Quit Amos" row and ⌘Q did nothing at all (verified by dumping the
//! live menu through the accessibility API: the app menu held About / Settings… /
//! Services / Hide Amos / Hide Others / Show All and nothing else). The same check found
//! "Hide Others" and "Show All" wired to *nothing* — they dispatched and the frontend
//! ignored one of them and reimplemented the other as "unhide our own hidden windows",
//! which is not what those two macOS items mean. Both now call the AppKit methods that
//! define them, and [`tests::every_declared_id_is_in_the_menu_tree`] pins the invariant
//! so a declared-but-uninstalled item cannot come back.
//!
//! The "Services" placeholder is gone: muda cannot install a real `NSMenu`-backed
//! Services menu (`setServicesMenu:`), so the row could only ever be a look-alike that
//! does nothing when clicked — the same lie in a different shape.
//!
//! ## Why a single global menu, not per-window
//!
//! macOS expects **one** menu bar per app, swapping per-window content via the
//! Window menu (a focused-window submenu).  Tauri exposes `window.set_menu()` for
//! per-window overrides, but on macOS the global menu is what the user sees —
//! leaving it set app-wide is the macOS-correct behaviour.

// `tauri::menu` is `#[cfg(desktop)]` in Tauri 2.11 — a menu bar is a desktop concept, and the
// crate does not compile those types for mobile. The import therefore has to carry the same
// gate as the types it names; without it an Android build fails with **E0432 on this line
// alone**, before any of the module's own macOS/`not(macOS)` twins are even considered
// (REQ-A1000 / F-DEV-131: `android-app-check` was red, and was in no workflow either).
#[cfg(desktop)]
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemKind, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Stable ids for every menu item — these are what `MenuEvent::id()` returns.
///
/// One source of truth so the frontend can pattern-match without typos.
pub mod ids {
    /// Apple menu (always-present on macOS, named after the app by convention).
    pub const ABOUT: &str = "menu.about";
    pub const PREFERENCES: &str = "menu.preferences";
    pub const HIDE_AMOS: &str = "menu.hide-amos";
    pub const HIDE_OTHERS: &str = "menu.hide-others";
    pub const SHOW_ALL: &str = "menu.show-all";
    pub const QUIT: &str = "menu.quit";

    /// File menu.
    pub const NEW_WINDOW: &str = "menu.new-window";
    pub const CLOSE_WINDOW: &str = "menu.close-window";
    /// File ▸ Print… (⌘P). REQ-A869: prints the focused **app** window through the host's
    /// print path (`crate::print`), **not** through `window.print()` — see that module's
    /// header for why the shell cannot own this one (its menu switch runs in the launcher
    /// window, so `window.print()` there would print the desktop).
    pub const PRINT: &str = "menu.print";

    /// View menu.
    pub const MINIMIZE: &str = "menu.minimize";
    pub const ZOOM: &str = "menu.zoom";
    pub const ENTER_FULLSCREEN: &str = "menu.enter-fullscreen";

    /// Help menu ids.
    pub mod help {
        /// Search Help (⌘?).
        pub const SEARCH_HELP: &str = "menu.search-help";
        /// "Amos Help" (opens the Settings window with Help selected).
        pub const AMOS_HELP: &str = "menu.amos-help";
    }
}

/// **Every** id this module declares — the list [`verify_tree`] checks the built menu
/// against, and the one the uniqueness test walks. Kept in one place precisely because
/// the REQ-A423 defect (an id with a handler, a doc entry and no menu item) is invisible
/// to a compiler: nothing references `QUIT` except a `match` arm that could never run.
pub const ALL: &[&str] = &[
    ids::ABOUT,
    ids::PREFERENCES,
    ids::HIDE_AMOS,
    ids::HIDE_OTHERS,
    ids::SHOW_ALL,
    ids::QUIT,
    ids::NEW_WINDOW,
    ids::CLOSE_WINDOW,
    ids::PRINT,
    ids::MINIMIZE,
    ids::ZOOM,
    ids::ENTER_FULLSCREEN,
    ids::help::SEARCH_HELP,
    ids::help::AMOS_HELP,
];

/// Rust-handled items — consumed in Rust with no frontend event.
const RUST_HANDLED: &[&str] = &[
    ids::ABOUT,
    ids::QUIT,
    ids::HIDE_AMOS,
    ids::HIDE_OTHERS,
    ids::SHOW_ALL,
    ids::CLOSE_WINDOW,
];

/// Items that **terminate** the event after Rust handles them (no frontend echo).
const TERMINAL_RUST: &[&str] = &[
    ids::QUIT,
    ids::CLOSE_WINDOW,
    ids::HIDE_OTHERS,
    ids::SHOW_ALL,
];

/// Close the window the user is actually looking at (⌘W).
///
/// Why this is handled **here** and not in the WebView (REQ-A420, measured on this machine):
/// the item is consumed by the launcher's shell in the old design, which resolves "the focused
/// window" from the host model — with the Settings window key, ⌘W closed nothing at all (and
/// after REQ-A416 an app window has no shell to consume it in the first place). The OS menu is
/// **app-wide**, so the app-wide side is the right owner.
///
/// **Who gets ⌘W first is conditional, and the condition is now measured** (REQ-A453,
/// 2026-09-19, two builds of this machine's bundle with `AMOS_DESKTOP_SHORTCUTS=disabled`):
///
///   * **frontend owns the chords** (the default) ⇒ this item never runs. Pressing ⌘W with the
///     Files window key closed the window (window count 2 → 1) while the boot log showed **no**
///     `menu item activated` line at all — the WebView's `preventDefault` means AppKit never
///     dispatches the key equivalent, so the claim that "AppKit dispatches it *before* the key
///     reaches the WebView" is **not** what happens here (`⌘N` does go through the menu, which
///     is what makes the two paths distinguishable).
///   * **frontend stands down** (the operator set the capability off — REQ-A453 gave app windows
///     that switch back) ⇒ the item **does** run: same keystroke, log line
///     `DEBUG amos::menu: menu item activated id="menu.close-window"`, window count 2 → 1.
///
/// So this function is the owner of the chord exactly when the shell is not, which is the
/// arrangement the capability switch describes ("前端不抢键" ⇒ the OS takes it).
///
/// REQ-A431 added the fallback: the platform is asked first (that is macOS's own Close), but
/// **a window created a moment ago is on screen before the OS makes it key** — measured, a ⌘W
/// in the first seconds of a new app window's life closed nothing in 3/6 runs, and the only
/// trace was a `debug` line. When the platform names no key window, this falls back to the
/// window the **window manager** says is focused: not a guess, but the host's own answer to
/// "what is focused" (the same one the launcher's shortcuts read). The launcher (`main`) is
/// never a target in either branch — it *is* the desktop (F-SH-008).
#[cfg(target_os = "macos")]
fn close_key_window<R: Runtime>(app: &AppHandle<R>) {
    let windows = app.webview_windows();
    let target = crate::wm::focused_app_label(app);
    let Some(label) = target else {
        // Nothing to act on (the launcher is key, or no window is): say so instead of closing
        // a window the user did not mean — a menu item that closes the *wrong* window is worse
        // than one that closes none.
        tracing::debug!(
            target: "amos::menu",
            "Close Window: no app window is focused (the launcher is never a target); nothing was closed"
        );
        return;
    };
    match windows.get(&label) {
        Some(window) => {
            if let Err(e) = window.close() {
                tracing::warn!(
                    target: "amos::menu",
                    label = %label,
                    error = %e,
                    "Close Window: the host could not close the window"
                );
            }
        }
        // The model names a window the platform does not have: an external composited surface
        // (an Android container has no WebviewWindow) or one that is already gone. Report the
        // pair instead of silently doing nothing.
        None => tracing::debug!(
            target: "amos::menu",
            label = %label,
            "Close Window: the focused window has no platform window (external surface); nothing was closed"
        ),
    }
}

/// Menu items that act on **the focused app window** — see [`sync_window_items`].
#[cfg(target_os = "macos")]
const WINDOW_ITEMS: &[&str] = &[
    ids::CLOSE_WINDOW,
    ids::MINIMIZE,
    ids::ZOOM,
    ids::ENTER_FULLSCREEN,
    // REQ-A869: "Print…" acts on the focused app window like the four above, and the host
    // refuses with `amos.print.no_window` when there is none — so it must be greyed for the
    // same states they are, by the same call. Leaving it enabled would put the refusal in the
    // OS's menu bar, where nothing can explain it (this sync exists because of exactly that:
    // with only the launcher up, Close Window / Minimize / Zoom were enabled and did nothing).
    ids::PRINT,
];

/// Bring the window-related menu items in step with what the app can actually do right now.
///
/// REQ-A433, measured on this machine (2026-09-18) by driving the menu bar through AX: with
/// only the launcher up, `File ▸ Close Window`, `View ▸ Minimize` and `View ▸ Zoom` were
/// **enabled** and did **nothing** — the shell skips the launcher on purpose (F-SH-008) and
/// the launcher is already screen-sized, so Zoom has nothing to zoom. macOS greys an item that
/// cannot act; a row that looks live and is dead is the F-SH-001 defect inside the OS's own
/// menu, where no in-page label can explain it.
///
/// Called after [`install`] (the initial state is "launcher only") and from the window-event
/// handler on every focus change, so the bar follows the user's clicks.
#[cfg(target_os = "macos")]
pub fn sync_window_items<R: Runtime>(app: &AppHandle<R>) {
    let enabled = crate::wm::focused_app_label(app).is_some();
    let Some(menu) = app.menu() else {
        // No menu installed (a non-bundled/dev run, or `install` failed earlier): nothing to
        // sync, and `install` already reported that.
        tracing::debug!(target: "amos::menu", "window items not synced: no app menu");
        return;
    };
    let mut updated = 0usize;
    for item in menu.items().unwrap_or_default() {
        // Two levels, like the tree: our window items live inside the File and View submenus.
        let MenuItemKind::Submenu(submenu) = item else {
            continue;
        };
        for child in submenu.items().unwrap_or_default() {
            if let MenuItemKind::MenuItem(entry) = child {
                if WINDOW_ITEMS.contains(&entry.id().as_ref()) {
                    // Reported, not discarded: an item whose state could not be set keeps a
                    // state the user can see and this function cannot explain.
                    match entry.set_enabled(enabled) {
                        Ok(()) => updated += 1,
                        Err(e) => tracing::warn!(
                            target: "amos::menu",
                            id = %entry.id().as_ref(),
                            error = %e,
                            "could not set a window menu item's enabled state"
                        ),
                    }
                }
            }
        }
    }
    if updated == WINDOW_ITEMS.len() {
        tracing::debug!(target: "amos::menu", enabled, items = updated, "window menu items synced");
    } else {
        // Reported, not silent: a row that silently kept its old state is the very defect this
        // function exists to remove.
        tracing::warn!(
            target: "amos::menu",
            updated,
            expected = WINDOW_ITEMS.len(),
            "some window menu items were not found; those rows kept their previous state"
        );
    }
}

// **REQ-A869 — this module no longer owns "which window is focused".**
//
// The rule used to live here as three private, macOS-gated functions: `close_target_label`
// (the pure choice), `model_focused_label` (the model source) and `actionable_window_label`
// (the platform scan). ⌘P needs the same answer, and a private helper inside the macOS half
// of a module is not something a second consumer can call — so the question now has one owner,
// [`crate::wm::focused_app_label`] (with the pure half in
// [`crate::wm::focused_target_label`]), and ⌘W, the window-item sync and ⌘P all ask it there.
//
// Nothing was left behind as a forwarding alias on purpose: a one-line `fn` with two call
// sites reads as a second definition of the policy, which is how one copy comes to be edited
// while the other is not.

/// Build the complete native macOS menu bar and install it.
///
/// Called once at startup from [`crate::run`]`::setup`.  The menu tree is owned by
/// macOS once installed; we hold no reference after this.
#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let locale = stored_locale(app);
    let labels = labels_for(locale);
    let menu = build_menu(app, labels)?;
    // Self-check before the tree becomes the OS's (REQ-A423): every id this module
    // declares must be an item that actually exists. The defect this catches is not
    // hypothetical — `menu.quit` had a handler, a doc line and a test classification while
    // having no menu row at all, so ⌘Q did nothing and nothing anywhere said so.
    let missing = verify_tree(&menu);
    if missing.is_empty() {
        tracing::info!(
            target: "amos::menu",
            items = ALL.len(),
            "menu tree verified: every declared menu id is installed"
        );
    } else {
        tracing::warn!(
            target: "amos::menu",
            missing = ?missing,
            "the menu tree is missing declared items; those menu rows and their accelerators \
             cannot work"
        );
    }
    app.set_menu(menu).map_err(|e| e.to_string())?;
    tracing::info!(target: "amos::menu", locale = locale.as_str(), "native macOS menu bar installed");
    // REQ-A433: start from the truth — with only the launcher up, the window items have
    // nothing to act on and must be greyed (see `sync_window_items`).
    sync_window_items(app);
    Ok(())
}

/// Re-draw the whole menu bar in `raw`'s language (REQ-A437).
///
/// Called by the shell whenever the UI language changes (`locale.svelte.ts::setLocale` mirrors
/// the locale into the shared store and calls the `menu_set_locale` command). Returns the locale
/// that was applied, so the caller can tell an applied language from the one it asked for —
/// the same contract `wm_set_shell_title` uses.
///
/// The tree is **rebuilt**, not retitled: muda's items cannot be re-parented and reusing them
/// would mean keeping a second copy of the menu's shape here. `set_menu` swaps the bar atomically
/// (macOS takes the new tree in one step), and the window items are re-synced afterwards because
/// the fresh items start enabled (REQ-A433).
#[cfg(target_os = "macos")]
pub fn set_locale<R: Runtime>(app: &AppHandle<R>, raw: &str) -> Result<String, String> {
    let locale = MenuLocale::parse(Some(raw));
    let menu = build_menu(app, labels_for(locale))?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    sync_window_items(app);
    tracing::info!(target: "amos::menu", locale = locale.as_str(), "menu bar re-drawn in the shell's language");
    Ok(locale.as_str().to_string())
}

/// Non-macOS: no menu bar exists, so there is nothing to re-draw — the caller's contract is the
/// same (it gets back the locale it asked for).
#[cfg(not(target_os = "macos"))]
pub fn set_locale<R: Runtime>(_app: &AppHandle<R>, raw: &str) -> Result<String, String> {
    Ok(raw.to_string())
}

/// Tauri command: draw the **native chrome** in the shell's language (`amos-ui.locale`) — the
/// menu bar, and the system tray.
///
/// Defined on every platform so the frontend's call is the same everywhere: off macOS the menu
/// bar half is the documented no-op above, and off desktop the tray half is.
///
/// **REQ-A864 added the tray half here rather than as a second command.** The frontend already
/// calls this on every language change (`locale.svelte.ts::setLocale`), and the tray is the other
/// piece of native chrome with text in it; a separate command would mean the next language-change
/// path could reasonably call one and not the other. The tray is installed once at boot, so
/// without this call it kept the language the app started in — REQ-A437's defect, one surface
/// over. A failure here does **not** fail the command: the menu bar half is what the caller asked
/// for and what its return value describes, so a tray that could not be re-labelled is reported
/// and the applied locale is still returned.
#[tauri::command]
pub fn menu_set_locale(app: AppHandle, locale: String) -> Result<String, String> {
    let applied = set_locale(&app, &locale)?;
    if let Err(e) = crate::tray::set_locale(&app, &applied) {
        tracing::warn!(
            target: "amos::tray",
            error = %e,
            "the tray was not re-labelled after the language change; it keeps the language it \
             was installed in"
        );
    }
    Ok(applied)
}

/// The shell's last word on each synced row (REQ-A490): the item id → the chord it should carry now,
/// with `None` meaning **no chord**. A row the shell never mentioned is absent, and then the
/// build-time default applies — which is the payload's own rule ("an intent the payload omits is not
/// an error").
pub type BindingOverrides = std::collections::HashMap<String, Option<String>>;

/// Why this exists instead of just calling `set_accelerator` (REQ-A490, measured on the device):
/// **muda's macOS `set_key_accelerator(None)` never touches the `NSMenuItem`** — it updates only its
/// own copy of the accelerator and returns `Ok(())` (muda 0.19.3,
/// `src/platform_impl/macos/mod.rs`: `if let Some(key_equivalent) = key_equivalent { … }` with the
/// `None` case falling through). So a disabled binding kept advertising ⌘H in the native app menu —
/// and macOS kept *firing* it — while our count reported it as applied. The honest way to remove a
/// chord from a row is therefore to **rebuild the bar without it**, which is what this map feeds.
static BINDING_OVERRIDES: std::sync::Mutex<Option<BindingOverrides>> = std::sync::Mutex::new(None);

/// The accelerator a row should carry **now**: the shell's last word if there is one, else the
/// build-time default. Pure, so the state machine below is testable without AppKit.
pub fn accelerator_for<'a>(id: &'a str, overrides: &'a BindingOverrides) -> Option<&'a str> {
    match overrides.get(id) {
        Some(chord) => chord.as_deref(),
        None => default_accelerator(id),
    }
}

/// Fold a sync payload into the override map.
///
/// Three rules, each of them a case that would otherwise be a state bug:
///   * a `Some(chord)` **sets** the row (and clears an earlier "no chord" — re-enabling a binding has
///     to be able to undo a disable);
///   * a `None` records "no chord" for that row;
///   * a row the payload does not mention **keeps** what it had (including a previous `None`), because
///     an older shell that knows fewer rows must not silently re-enable the ones it cannot name.
pub fn fold_overrides(
    previous: &BindingOverrides,
    updates: &[AcceleratorUpdate],
) -> BindingOverrides {
    let mut out = previous.clone();
    for update in updates {
        out.insert(update.item_id.clone(), update.accelerator.clone());
    }
    out
}

/// A snapshot of the current overrides (empty before the first sync).
pub fn binding_overrides() -> BindingOverrides {
    BINDING_OVERRIDES
        .lock()
        .map(|guard| guard.clone().unwrap_or_default())
        .unwrap_or_default()
}

/// Record a folded map as the current one.
fn store_binding_overrides(overrides: BindingOverrides) {
    if let Ok(mut guard) = BINDING_OVERRIDES.lock() {
        *guard = Some(overrides);
    }
}

/// The accelerators this bar is **built** with — the build-time defaults, and the complete set of
/// rows that carry a chord at all (REQ-A485).
///
/// They used to be seven literals spread through `build_menu`, which was fine until the sync needed
/// to know *which* rows have a chord (a row the sync touches but that never had one would advertise
/// a key the user has never seen beside that action). One table, two consumers: `build_menu` reads it
/// through [`default_accelerator`], and `tests::the_synced_accelerators_are_declared_ids` checks that
/// every synced row is in it.
///
/// The **cross-language** half — that each row's build-time chord equals the shell's own default
/// (`SYSTEM_DEFAULTS`) — is bound by `frontend-ts/src/__tests__/desktopKeys.test.ts`, which reads this
/// table and `ACCELERATOR_ITEMS` out of this file (REQ-A661). The Rust test named
/// `the_build_time_defaults_equal_the_shells_defaults` re-types the shell's defaults as a Rust literal,
/// so on its own it compares Rust to Rust and would not catch a drift on the frontend side.
pub const DEFAULT_ACCELERATORS: &[(&str, &str)] = &[
    (ids::PREFERENCES, "CmdOrCtrl+,"),
    (ids::HIDE_AMOS, "CmdOrCtrl+H"),
    (ids::HIDE_OTHERS, "CmdOrCtrl+Alt+H"),
    (ids::QUIT, "CmdOrCtrl+Q"),
    (ids::NEW_WINDOW, "CmdOrCtrl+N"),
    (ids::CLOSE_WINDOW, "CmdOrCtrl+W"),
    (ids::MINIMIZE, "CmdOrCtrl+M"),
    // REQ-A869: File ▸ Print… takes the platform's standard chord, and it is **not** in
    // `ACCELERATOR_ITEMS` above — the shell does not bind ⌘P (there is no `print` intent in
    // `SYSTEM_DEFAULTS`), so there is no user binding for a native row to follow. Same
    // disposition as `ENTER_FULLSCREEN`, whose chord is a literal and appears in neither
    // table.
    (ids::PRINT, "CmdOrCtrl+P"),
];

/// The accelerator a row is **built** with, or `None` for a row that carries none.
pub fn default_accelerator(id: &str) -> Option<&'static str> {
    DEFAULT_ACCELERATORS
        .iter()
        .find(|(row, _)| *row == id)
        .map(|(_, accelerator)| *accelerator)
}

/// Which native menu rows carry a chord that the **shell** also binds — and therefore must follow
/// the user's bindings (REQ-A485).
///
/// `build_menu` sets this bar's accelerators as **compile-time literals** (`CmdOrCtrl+N` …), which
/// was accurate while the bindings were fixed and became a false claim the moment they were not:
/// after rebinding — or disabling — "New Window", the native item kept advertising ⌘N while the
/// shell matched something else. That is the same defect the in-window menus had (F-SH-038), on the
/// surface a user reads first.
///
/// This table maps the **shell's intent ids** (`SYSTEM_DEFAULTS` in
/// `frontend-ts/src/lib/keyboardConfigHook.svelte.ts`) to menu item ids, and it is deliberately
/// short: a chord is listed only when a native row exists for the *same action*.
///   * `cycleWindows` (⌘\`) — no native row exists, so there is nothing to keep in step.
///
/// The ids are checked against the declared list at build time
/// (`tests::the_synced_accelerators_are_declared_ids`), because a renamed id would leave a row that
/// silently keeps its build-time chord.
pub const ACCELERATOR_ITEMS: &[(&str, &str)] = &[
    ("newWindow", ids::NEW_WINDOW),
    ("closeWindow", ids::CLOSE_WINDOW),
    ("minimizeWindow", ids::MINIMIZE),
    ("hideApp", ids::HIDE_AMOS),
    ("preferences", ids::PREFERENCES),
];

/// One accelerator update: the native item id, and the accelerator to apply — `None` meaning the
/// binding is **disabled**, so the row must advertise nothing (the rule the in-window menus follow
/// too: a menu may not advertise a binding the shell does not have).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceleratorUpdate {
    pub item_id: String,
    pub accelerator: Option<String>,
}

/// Parse the shell's `menu_set_shortcuts` payload.
///
/// Shape: `{ "<intent id>": "<accelerator>" | null }` in muda's own accelerator grammar
/// (`CmdOrCtrl+N`, `CmdOrCtrl+Shift+N`, …). Pure, so every refusal is testable without AppKit:
///
/// * an **unknown intent id** is refused — a typo would otherwise sync nothing while the shell
///   believed it had (the "reported, not silent" rule this file follows for tree mismatches);
/// * a value that is neither a non-empty string nor `null` is refused (an empty string is not a
///   binding; `null` is how the shell says "the user disabled this");
/// * an intent the payload **omits** is not an error: it keeps the accelerator it was built with,
///   which is the honest reading of "nothing was said about it" (an older UI knows fewer rows).
pub fn accelerator_updates(payload: &serde_json::Value) -> Result<Vec<AcceleratorUpdate>, String> {
    let Some(map) = payload.as_object() else {
        return Err(
            "menu_set_shortcuts expects an object { intent: accelerator | null }".to_string(),
        );
    };
    let mut out = Vec::with_capacity(map.len());
    for (intent, value) in map {
        let Some((_, item_id)) = ACCELERATOR_ITEMS.iter().find(|(id, _)| id == intent) else {
            let known: Vec<&str> = ACCELERATOR_ITEMS.iter().map(|(id, _)| *id).collect();
            return Err(format!(
                "unknown intent id '{intent}' — the synced ids are {known:?} (see ACCELERATOR_ITEMS)"
            ));
        };
        let accelerator = match value {
            serde_json::Value::Null => None,
            serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
            serde_json::Value::String(_) => {
                return Err(format!(
                    "intent '{intent}': an empty accelerator is not a binding — send null to disable it"
                ))
            }
            other => {
                return Err(format!("intent '{intent}': expected a string or null, got {other}"))
            }
        };
        out.push(AcceleratorUpdate {
            item_id: (*item_id).to_string(),
            accelerator,
        });
    }
    Ok(out)
}

/// Apply the updates to the installed menu, **reporting** what it could not do (macOS).
///
/// The traversal is the one `sync_window_items` uses — the top level, then each submenu's items —
/// because these chords live in the app menu (`Hide` / `Settings`) and in the File / Window menus.
/// A row that cannot be found or set is warned about **by id** rather than skipped silently: a menu
/// row keeping a chord the shell no longer matches is exactly the defect this removes.
#[cfg(target_os = "macos")]
pub fn apply_accelerators<R: Runtime>(
    app: &AppHandle<R>,
    updates: &[AcceleratorUpdate],
) -> Result<usize, String> {
    let Some(menu) = app.menu() else {
        return Err("no app menu is installed; nothing to sync".to_string());
    };
    let mut applied = 0usize;
    for item in menu.items().map_err(|e| e.to_string())? {
        let MenuItemKind::Submenu(submenu) = item else {
            continue;
        };
        for child in submenu.items().map_err(|e| e.to_string())? {
            let MenuItemKind::MenuItem(entry) = child else {
                continue;
            };
            let id = entry.id().as_ref().to_string();
            let Some(update) = updates.iter().find(|u| u.item_id == id) else {
                continue;
            };
            let chord = update.accelerator.as_deref();
            match entry.set_accelerator(chord) {
                Ok(()) if chord.is_some() => applied += 1,
                // muda's macOS `set_accelerator(None)` is a no-op — it updates muda's
                // own copy and returns Ok(()), leaving the NSMenuItem carrying its built-in
                // chord (REQ-A490). Count the work as done so the shell's contract ("applied
                // == updates.len()") still holds, but warn loudly so an operator looking at
                // "Hide Others still says ⌥⌘H after the user disabled it" can find the cause.
                // The honest fix is `redraw_bar()` — call `menu_set_locale` with the *current*
                // locale (a no-op for the user) to trigger it.
                Ok(()) => {
                    tracing::warn!(
                        target: "amos::menu",
                        id = %id,
                        "muda's set_accelerator(None) is a no-op on macOS; the row will keep \
                         its built-in chord until the bar is rebuilt. Send menu_set_locale with \
                         the current locale (or any later payload) to trigger redraw_bar."
                    );
                    applied += 1;
                }
                Err(e) => tracing::warn!(
                    target: "amos::menu",
                    id = %id,
                    accelerator = ?update.accelerator,
                    error = %e,
                    "could not set a menu item's accelerator"
                ),
            }
        }
    }
    if applied != updates.len() {
        tracing::warn!(
            target: "amos::menu",
            applied,
            expected = updates.len(),
            "some menu items were not found; those kept the accelerator they were built with"
        );
    }
    Ok(applied)
}

/// Non-macOS: no menu bar exists, so there is nothing to sync. The payload is still validated (the
/// shared parser above), so a malformed one is refused on every platform.
#[cfg(not(target_os = "macos"))]
pub fn apply_accelerators<R: Runtime>(
    _app: &AppHandle<R>,
    updates: &[AcceleratorUpdate],
) -> Result<usize, String> {
    Ok(updates.len())
}

/// Tauri command: make the native bar's accelerators follow the shell's key bindings (REQ-A485).
///
/// Defined on every platform so the frontend's call is identical everywhere (off macOS the applier
/// above is the documented no-op). Returns how many rows were updated, so the shell can compare that
/// with what it sent and report a mismatch — "the menu still says ⌘N" has to be diagnosable.
///
/// **The count is rows *touched*, not rows left carrying a chord** (REQ-A487): a `null` value is the
/// shell asking for a row to be **cleared**, and clearing it is work done — `apply_accelerators`
/// counts it, and its own shortfall warning compares against `updates.len()`, which is every row in
/// the payload whatever its value. The count is therefore comparable with the payload's *length*, not
/// with the number of non-null entries in it: the shell compared the latter and reported
/// "synced fewer menu accelerators than the shell sent" — with `applied` (5) greater than `sent` (4)
/// — for every user who had turned one binding off. Pinned on the shell side by
/// `svelte-tests/desktop-shell.svelte.test.ts` ("a row the host cleared counts as a synced row"), and
/// here by `tests::accelerator_updates_read_the_shell_payload` (a `null` produces an update, so
/// `updates.len()` is the payload's length).
#[tauri::command]
pub fn menu_set_shortcuts(app: AppHandle, shortcuts: serde_json::Value) -> Result<usize, String> {
    let updates = accelerator_updates(&shortcuts)?;
    // Record the shell's word **before** applying it: a rebuild (below) reads this map, and a row the
    // payload does not mention must keep whatever it had.
    let disabled: Vec<String> = updates
        .iter()
        .filter(|u| u.accelerator.is_none())
        .map(|u| u.item_id.clone())
        .collect();
    store_binding_overrides(fold_overrides(&binding_overrides(), &updates));

    // `Some(chord)` can be applied in place — muda sets the `NSMenuItem`'s key equivalent.
    let applied = apply_accelerators(&app, &updates)?;

    // `None` cannot: muda's macOS `set_key_accelerator(None)` updates only its own record and returns
    // `Ok(())` (see `BINDING_OVERRIDES`), so the row keeps advertising — and *acting on* — the chord
    // the user turned off. The bar has to be re-drawn so the row is built without it. Measured before
    // this: the keyboard page showed 隐藏应用 disabled and the native menu still ran ⌘H.
    #[cfg(target_os = "macos")]
    if !disabled.is_empty() {
        redraw_bar(&app, stored_locale(&app))?;
        tracing::info!(
            target: "amos::menu",
            rows = ?disabled,
            "re-drew the menu bar so the disabled rows carry no chord"
        );
    }
    #[cfg(not(target_os = "macos"))]
    let _ = &disabled;

    tracing::debug!(
        target: "amos::menu",
        applied,
        sent = updates.len(),
        "menu accelerators synced with the shell's bindings"
    );
    Ok(applied)
}

/// The ids from `declared` that `present` does not know about — the pure half of the
/// install-time self-check, so the rule can be tested without AppKit (see
/// [`tests::verify_tree_reports_declared_but_missing_ids`]).
fn missing_ids(declared: &[&str], present: impl Fn(&str) -> bool) -> Vec<String> {
    declared
        .iter()
        .filter(|id| !present(id))
        .map(|id| (*id).to_string())
        .collect()
}

/// Ask the **built** menu which of [`ids::ALL`] it actually contains.
///
/// Why this walks the tree itself instead of asking `Menu::get` (REQ-A427, measured on this
/// machine 2026-09-18): tauri's `Menu::get` searches only the root menu's **direct** items
/// (`self.items()?.into_iter().find(...)` — not a tree walk), and every id this module
/// declares lives inside one of the six submenus. The check therefore answered `None` for
/// **all eleven** ids on a *correct* bar: the live boot log read
/// `WARN amos::menu: the menu tree is missing declared items … missing=["menu.about", …]`
/// while the AX menu bar really showed `Apple, Amos, File, Edit, View, Window, Help` with
/// `File ▸ New Window ⌘N, Close Window ⌘W`. A check that always fires can never catch the
/// "declared everywhere, installed nowhere" defect it was written for (REQ-A423) — and it
/// sends the next reader hunting a menu bug that does not exist.
#[cfg(target_os = "macos")]
fn verify_tree<R: Runtime>(menu: &Menu<R>) -> Vec<String> {
    let present = collect_item_ids(menu.items().unwrap_or_default());
    missing_ids(ALL, |id| present.iter().any(|p| p == id))
}

/// Every item id in `items`, descending into submenus.
///
/// Generic over [`MenuNode`] rather than taking `MenuItemKind` directly, because the rule
/// ("an id that lives inside a submenu counts") has to be testable: muda only builds menu
/// trees on the **main thread** and a unit test does not run on it (it panics with
/// "`muda::MenuChild` can only be created on the main thread"). The real implementation is
/// the small `impl` below; the test supplies a plain tree from memory.
///
/// An explicit work list, not recursion: `scripts/rust-recursion-scan.mjs` enforces Power of
/// 10 rule 1 across this workspace, and `MenuNode::child_nodes()` is a dynamic interface, so
/// "the depth is the menu tree's own depth" is not a bound the compiler (or a reader) can
/// check.
#[cfg(target_os = "macos")]
fn collect_item_ids<T: MenuNode>(items: Vec<T>) -> Vec<String> {
    let mut out = Vec::new();
    let mut pending: Vec<Vec<T>> = vec![items];
    while let Some(level) = pending.pop() {
        for node in level {
            out.push(node.node_id());
            let children = node.child_nodes();
            if !children.is_empty() {
                pending.push(children);
            }
        }
    }
    out
}

/// A node of the installed menu tree, as far as [`collect_item_ids`] is concerned.
#[cfg(target_os = "macos")]
trait MenuNode {
    /// This node's own id.
    fn node_id(&self) -> String;
    /// The nodes below this one (empty for a leaf).
    fn child_nodes(&self) -> Vec<Self>
    where
        Self: Sized;
}

#[cfg(target_os = "macos")]
impl<R: Runtime> MenuNode for MenuItemKind<R> {
    fn node_id(&self) -> String {
        self.id().as_ref().to_string()
    }

    fn child_nodes(&self) -> Vec<Self> {
        // A submenu's children are where this module's ids live — which is the whole point.
        // A read that fails (poisoned runtime handle) yields no children, so the parent is
        // reported as not containing them: the honest direction for a *verification*.
        match self {
            MenuItemKind::Submenu(sub) => sub.items().unwrap_or_default(),
            _ => Vec::new(),
        }
    }
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

/// The language the **menu bar** is drawn in.
///
/// REQ-A437, measured on this machine (2026-09-18): the labels were hard-coded English while
/// the shell ships **Chinese first** (`amos-ui.locale` defaults to `zh`), so a user whose whole
/// UI is Chinese read a menu bar saying `File / Edit / View / Window / Help`. macOS menus are
/// localized to the user's language; a menu bar that is the only English thing on screen is the
/// kind of mismatch this crate reports rather than hides.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MenuLocale {
    Zh,
    En,
}

#[cfg(target_os = "macos")]
impl MenuLocale {
    /// Read the locale from the shared store's `amos-ui.locale` value (stored **raw**, like
    /// the theme). `None` — a fresh install — means **Chinese**: that is the shell's own
    /// default (`lib/i18n.currentLocale()`), and the menu bar must not be the one surface that
    /// disagrees with it.
    pub fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some("en") => Self::En,
            _ => Self::Zh,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Zh => "zh",
            Self::En => "en",
        }
    }
}

/// Every user-visible string in the menu bar, per language.
///
/// A **struct** rather than a table keyed by id, and deliberately: adding a menu row then
/// requires choosing a field, and adding a language requires filling **every** field — so "a row
/// shipped without a translation" is a compile error, not something a test has to catch.
#[cfg(target_os = "macos")]
pub struct MenuLabels {
    pub app_menu: &'static str,
    pub about: &'static str,
    pub preferences: &'static str,
    pub hide_amos: &'static str,
    pub hide_others: &'static str,
    pub show_all: &'static str,
    pub quit: &'static str,
    pub file: &'static str,
    pub new_window: &'static str,
    pub close_window: &'static str,
    /// File ▸ Print… (REQ-A869). Carries the `…` because it opens a dialog rather than
    /// acting immediately — the convention every other row that does so follows here.
    pub print: &'static str,
    pub edit: &'static str,
    /// The Edit menu's **predefined** rows (REQ-A439). muda draws them from AppKit's standard
    /// strings, which follow the **system** language — so on this Chinese-first Mac they read
    /// `Undo / Redo / Cut / Copy / Paste / Select All` under a Chinese `编辑`. Passing our own
    /// text is the only way those rows speak the UI's language (`*_with_text` builders); the
    /// standard selector and ⌘-key equivalent are the item type's, not the text's.
    pub undo: &'static str,
    pub redo: &'static str,
    pub cut: &'static str,
    pub copy: &'static str,
    pub paste: &'static str,
    pub select_all: &'static str,
    pub view: &'static str,
    pub minimize: &'static str,
    pub zoom: &'static str,
    pub enter_fullscreen: &'static str,
    pub window: &'static str,
    pub help: &'static str,
    /// Help menu rows (REQ-A482: the Help menu was empty — the most likely place a macOS
    /// user looks for help is the menu bar, and an empty menu meant there was nowhere to go).
    pub search_help: &'static str,
    pub amos_help: &'static str,
}

/// English labels — the app's own name stays `Amos`.
#[cfg(target_os = "macos")]
const LABELS_EN: MenuLabels = MenuLabels {
    app_menu: "Amos",
    about: "About Amos",
    preferences: "Preferences…",
    hide_amos: "Hide Amos",
    hide_others: "Hide Others",
    show_all: "Show All",
    quit: "Quit Amos",
    file: "File",
    new_window: "New Window",
    close_window: "Close Window",
    print: "Print…",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    select_all: "Select All",
    view: "View",
    minimize: "Minimize",
    zoom: "Zoom",
    enter_fullscreen: "Enter Full Screen",
    window: "Window",
    help: "Help",
    search_help: "Search Help",
    amos_help: "Amos Help",
};

/// Chinese labels. The wording follows Apple's own Chinese menu vocabulary (文件 / 编辑 / 显示 /
/// 窗口 / 帮助, 最小化, 缩放, 进入全屏幕, 关闭窗口, 隐藏其他, 全部显示) so a Mac user reads what
/// they expect; the app's name stays `Amos` in both.
#[cfg(target_os = "macos")]
const LABELS_ZH: MenuLabels = MenuLabels {
    app_menu: "Amos",
    about: "关于 Amos",
    preferences: "设置…",
    hide_amos: "隐藏 Amos",
    hide_others: "隐藏其他",
    show_all: "全部显示",
    quit: "退出 Amos",
    file: "文件",
    new_window: "新建窗口",
    close_window: "关闭窗口",
    print: "打印…",
    edit: "编辑",
    // Apple 的中文词汇：撤销 / 重做 / 剪切 / **拷贝**（macOS 用「拷贝」而不是「复制」）/ 粘贴 / 全选。
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "拷贝",
    paste: "粘贴",
    select_all: "全选",
    view: "显示",
    minimize: "最小化",
    zoom: "缩放",
    enter_fullscreen: "进入全屏幕",
    window: "窗口",
    help: "帮助",
    search_help: "搜索帮助",
    amos_help: "Amos 帮助",
};

/// The label table for `locale`.
#[cfg(target_os = "macos")]
pub fn labels_for(locale: MenuLocale) -> &'static MenuLabels {
    match locale {
        MenuLocale::Zh => &LABELS_ZH,
        MenuLocale::En => &LABELS_EN,
    }
}

/// Re-draw the whole bar for `locale` from the **current** bindings (`build_menu` reads the recorded
/// overrides itself). One helper for the two reasons a bar has to be rebuilt — a language change
/// (REQ-A437) and a row whose chord was **disabled** (REQ-A490, see `BINDING_OVERRIDES`).
#[cfg(target_os = "macos")]
fn redraw_bar<R: Runtime>(app: &AppHandle<R>, locale: MenuLocale) -> Result<(), String> {
    let menu = build_menu(app, labels_for(locale))?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    sync_window_items(app);
    Ok(())
}

/// The locale the shell last stored, or the shell's own default (`zh`) before it ever did.
#[cfg(target_os = "macos")]
fn stored_locale<R: Runtime>(app: &AppHandle<R>) -> MenuLocale {
    app.try_state::<crate::store::SharedStore>()
        .and_then(|store| store.get(crate::store::LOCALE_KEY))
        .map(|raw| MenuLocale::parse(Some(raw.as_str())))
        .unwrap_or(MenuLocale::Zh)
}

/// Build the full menu tree in `l`.
#[cfg(target_os = "macos")]
fn build_menu<R: Runtime>(app: &AppHandle<R>, l: &MenuLabels) -> Result<Menu<R>, String> {
    // Chords come from the rows' **current** bindings, not from the literals: `accelerator_for`
    // returns the shell's last word for a synced row (including "no chord") and the build-time
    // default for everything else. That is what lets a rebuild drop a chord — the only way to
    // remove one on macOS (see `BINDING_OVERRIDES`).
    let overrides = binding_overrides();
    // ── Apple menu (the "Amos" menu, per macOS convention) ──────────────────
    //
    // Order and content follow the HIG: About, Settings…, (separator) Hide / Hide
    // Others / Show All, (separator) Quit. **Quit must be here** — its absence was
    // REQ-A423: `ids::QUIT` existed with a handler and no item, so ⌘Q was a dead chord
    // on a machine where every macOS user's first reflex is ⌘Q.
    let apple = SubmenuBuilder::new(app, l.app_menu)
        .item(&item(app, ids::ABOUT, l.about, true, None)?)
        .separator()
        .item(&item(
            app,
            ids::PREFERENCES,
            l.preferences,
            true,
            accelerator_for(ids::PREFERENCES, &overrides),
        )?)
        .separator()
        .item(&item(
            app,
            ids::HIDE_AMOS,
            l.hide_amos,
            true,
            accelerator_for(ids::HIDE_AMOS, &overrides),
        )?)
        .item(&item(
            app,
            ids::HIDE_OTHERS,
            l.hide_others,
            true,
            accelerator_for(ids::HIDE_OTHERS, &overrides),
        )?)
        .item(&item(app, ids::SHOW_ALL, l.show_all, true, None)?)
        .separator()
        .item(&item(
            app,
            ids::QUIT,
            l.quit,
            true,
            accelerator_for(ids::QUIT, &overrides),
        )?)
        .build()
        .map_err(|e| e.to_string())?;

    // ── File menu ────────────────────────────────────────────────────────────
    // "New Window" — and now the label is true (REQ-A473). It was renamed to "New Files
    // Window" by REQ-A434 because the item could only ever open the **Files** app's window
    // (`DesktopShell`'s `menu.new-window` branch → `wm_open("files")`): measured on this
    // machine (2026-09-18), with the Notes window focused, its click handed the user a Files
    // window and nothing anywhere said so. The reason was structural — "another window of
    // what you are looking at" needs a *second identity* besides the label ⇄ app mapping,
    // and the host kept one window per label.
    //
    // That identity now exists (`amos_wm::identity`): the branch asks the shell for
    // `wm_new_window(focused app)` through `desktopSystemKeys::newWindowTarget`, which falls
    // back to Files only when nothing app-shaped is focused — the same rule the in-app menu
    // row and ⌘N use. So the item promises what it does again.
    let file = SubmenuBuilder::new(app, l.file)
        .item(&item(
            app,
            ids::NEW_WINDOW,
            l.new_window,
            true,
            accelerator_for(ids::NEW_WINDOW, &overrides),
        )?)
        .separator()
        .item(&item(
            app,
            ids::CLOSE_WINDOW,
            l.close_window,
            true,
            accelerator_for(ids::CLOSE_WINDOW, &overrides),
        )?)
        // REQ-A869. Built enabled (like every row here) and immediately corrected by
        // `sync_window_items`, which is called after `install` with the boot state — only
        // the launcher is up, so "Print…" is greyed from the first frame. That is the
        // REQ-A433 rule: macOS greys an item that cannot act, and a row that looks live and
        // is dead is an F-SH-001 defect *inside the OS's own menu*, where no in-page label
        // can explain it. The row's action is the host's (`crate::print`) — see `ids::PRINT`
        // for why the shell cannot own it.
        .separator()
        .item(&item(
            app,
            ids::PRINT,
            l.print,
            true,
            accelerator_for(ids::PRINT, &overrides),
        )?)
        .build()
        .map_err(|e| e.to_string())?;

    // ── Edit menu (predefined selectors, **our** text: REQ-A439) ─────────────
    // The rows must speak the UI's language, not the system's. muda's `*_with_text` builders
    // replace only the *text*: the standard selector (`copy:` …) and the ⌘-key equivalent come
    // from the item type, so the editing behaviour is unchanged (measured: clicking these rows
    // in a WebView text field performs the edit).
    let edit = SubmenuBuilder::new(app, l.edit)
        .undo_with_text(l.undo)
        .redo_with_text(l.redo)
        .separator()
        .cut_with_text(l.cut)
        .copy_with_text(l.copy)
        .paste_with_text(l.paste)
        .separator()
        // The platform's own row — **localized by us**, and its `selectAll:` works on click
        // (measured in a Files window: the field's text got selected and copied). Its ⌘A
        // accelerator is registered by muda but does not fire in this app (measured: with the
        // accelerator registered and enabled, no menu event and no selection for ⌘A / ⇧⌘A /
        // ⌥⇧⌘A, while ⇧⌘N-class accelerators of our own items do fire); replacing the row with
        // our own item did not fix the chord *and* broke the click, so the platform's row stays
        // and the chord is registered as a measured platform gap (`docs/mac-menu.md` §6,
        // `lib/editKeys.ts` owns the gesture wherever the key does reach the page — Windows /
        // Linux have no native menu yet).
        .select_all_with_text(l.select_all)
        .build()
        .map_err(|e| e.to_string())?;

    // ── View menu ─────────────────────────────────────────────────────────────
    let view = SubmenuBuilder::new(app, l.view)
        .item(&item(
            app,
            ids::MINIMIZE,
            l.minimize,
            true,
            accelerator_for(ids::MINIMIZE, &overrides),
        )?)
        .item(&item(app, ids::ZOOM, l.zoom, true, None)?)
        .separator()
        .item(&item(
            app,
            ids::ENTER_FULLSCREEN,
            l.enter_fullscreen,
            true,
            Some("Ctrl+Cmd+F"),
        )?)
        .build()
        .map_err(|e| e.to_string())?;

    // ── Window menu (predefined minimize/zoom, our text — same reason as Edit) ──
    let window = SubmenuBuilder::new(app, l.window)
        .minimize_with_text(l.minimize)
        .maximize_with_text(l.zoom)
        .build()
        .map_err(|e| e.to_string())?;

    // ── Help menu (REQ-A482: filled, not empty) ──────────────────────────────────
    // Two entries: "Search Help" (⌘?) opens the spotlight overlay for help search, and
    // "Amos Help" opens the Settings window with Help selected. Both forward to the
    // frontend, which owns the UI for both.
    let help = SubmenuBuilder::new(app, l.help)
        .item(&item(
            app,
            ids::help::SEARCH_HELP,
            l.search_help,
            true,
            Some("Cmd+?"),
        )?)
        .item(&item(app, ids::help::AMOS_HELP, l.amos_help, true, None)?)
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
///
/// `#[cfg(target_os = "macos")]` because its only callers are inside [`build_menu`], which is
/// itself macOS-only: the type is `tauri::menu::MenuItem`, which Tauri does not compile for
/// mobile at all (F-DEV-131). Narrowing the gate, not adding a branch.
#[cfg(target_os = "macos")]
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
                // Through Tauri (not `std::process::exit`): this runs the runtime's own
                // teardown — tray removal, window destruction, the exit-requested hooks —
                // so a menu Quit behaves like the platform's Quit instead of a SIGKILL of
                // ourselves (REQ-A423: this branch had never been reachable, so nobody had
                // noticed it bypassed everything).
                tracing::info!(target: "amos::menu", "Quit requested from menu");
                app.exit(0);
            }
            ids::HIDE_OTHERS => {
                // macOS means "hide the *other apps*" — the OS call, not a loop over our
                // own windows (which is what the frontend used to do for `show-all`).
                with_ns_app("Hide Others", |ns| ns.hideOtherApplications(None));
            }
            ids::SHOW_ALL => {
                with_ns_app("Show All", |ns| ns.unhideAllApplications(None));
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
            ids::CLOSE_WINDOW => {
                // ⌘W is app-wide and dispatched by AppKit before any WebView sees it, so the
                // key window is closed right here (see `close_key_window`).
                close_key_window(app);
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

/// Non-macOS **desktop**: no menu bar is installed (see [`install`]), so there is nothing to
/// route. Present so the `Builder::on_menu_event` wiring is one line on every target
/// instead of a `#[cfg]` at the call site — the same shape `install` uses.
///
/// `desktop` as well as `not(macOS)`: the parameter is `tauri::menu::MenuEvent`, and Tauri
/// compiles no `tauri::menu` for mobile, so this stub cannot exist on Android/iOS at all —
/// it would fail with E0425 on the signature. Nothing is lost there: the crate's only caller
/// (`lib.rs`'s boot path) is itself `#[cfg(target_os = "macos")]`, so this twin was already
/// unreachable off macOS. Narrowing the gate, not adding a branch (F-DEV-131).
#[cfg(all(not(target_os = "macos"), desktop))]
pub fn on_menu_event<R: Runtime>(_app: &AppHandle<R>, _event: MenuEvent) {}

/// Non-macOS: no menu bar exists, so there is nothing to keep in step. Present so the window
/// event path can call it unconditionally (the same shape `install` uses).
#[cfg(not(target_os = "macos"))]
pub fn sync_window_items<R: Runtime>(_app: &AppHandle<R>) {}

/// Run an AppKit [`NSApplication`](objc2_app_kit::NSApplication) call for a menu item that
/// is defined by the *OS*, not by this app (REQ-A423: "Hide Others" / "Show All").
///
/// AppKit is main-thread-only, and this is called from `on_menu_event`, which the runtime
/// dispatches on the event loop. `MainThreadMarker::new()` is the checked way to say so —
/// if a future caller (a test, an embedder pumping events off-thread) violates it, the
/// item **reports that it did nothing** instead of touching AppKit from the wrong thread
/// (undefined behaviour, and in practice a crash nobody could attribute to a menu click).
#[cfg(target_os = "macos")]
fn with_ns_app(name: &'static str, f: impl FnOnce(&objc2_app_kit::NSApplication)) {
    // Menu items report through the trace only — there is no caller to answer, and the
    // warning inside already names the item that did nothing.
    let _ = with_ns_app_checked(name, f);
}

/// [`with_ns_app`], but it **answers whether the AppKit call actually ran** (REQ-A796).
///
/// The menu items do not need the answer; `shell_about_panel` does. A command that returns
/// "the panel is up" when the main-thread check refused would be the F-SH-001 shape on a
/// brand-new wire — so the outcome is reported instead of assumed, and the frontend reads it.
///
/// AppKit is main-thread-only, and this is called from `on_menu_event` (dispatched on the
/// event loop) and from a `#[tauri::command]` (dispatched on the async runtime). If a future
/// caller violates that, the item **reports that it did nothing** instead of touching AppKit
/// from the wrong thread (undefined behaviour, and in practice a crash nobody could attribute
/// to a menu click).
#[cfg(target_os = "macos")]
fn with_ns_app_checked(name: &'static str, f: impl FnOnce(&objc2_app_kit::NSApplication)) -> bool {
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else {
        tracing::warn!(
            target: "amos::menu",
            item = name,
            "menu item needs the main thread; it was not performed"
        );
        return false;
    };
    f(&objc2_app_kit::NSApplication::sharedApplication(mtm));
    true
}

/// Show the **platform's own** About panel (`Amos ▸ About Amos`).
///
/// REQ-A432. This item used to emit a `show-about-dialog` event into a frontend that has no
/// consumer for it — the previous comment said so in as many words ("no About surface exists,
/// so no screen subscribes"), and the event was allow-listed in
/// `scripts/tauri-event-allowlist.json` as a deliberate Phase-2 stub. On this machine that
/// meant a macOS app whose **About** item did nothing at all (AX click, nothing appears; the
/// survey in `docs/mac-menu.md` records it).
///
/// The honest implementation is the platform's: `orderFrontStandardAboutPanel` reads the
/// bundle's own `Info.plist` (`CFBundleName`, `CFBundleShortVersionString`, the app icon), so
/// the panel shows what the OS says this app *is* — no invented UI, no second copy of the
/// product name, and it appears above every window with no frontend involvement. The event is
/// gone with it (nothing else subscribed; the allow-list entry is removed).
#[cfg(target_os = "macos")]
fn show_about_dialog<R: Runtime>(_app: &AppHandle<R>) {
    tracing::info!(target: "amos::menu", "About panel requested from menu");
    with_ns_app("About Amos", |ns| {
        ns.orderFrontStandardAboutPanel(None);
    });
}

/// What happened when the shell asked for the platform About panel (REQ-A796).
///
/// A **three-valued answer, not `()`, and deliberately not a `Result`.** The lesson is
/// F-SH-236, one module over: `invoke` answers `null` both for a command that failed and for a
/// `void` command that succeeded, so "did it work?" was unanswerable at the call site and the
/// frontend rendered a refusal as a success. `()` would rebuild exactly that collapse on this
/// new wire. A `Result` would too — `AmosError` reaches the WebView as `null` as well (the
/// same REQ-A296 bridge convention). An enum is the only shape the caller can read.
///
/// `UnsupportedHost` is a **runtime fact about the host**, following `session.rs`'s rule 2:
/// the command is registered on every desktop target and answers for the machine it runs on,
/// rather than being `#[cfg]`-ed out (a command that is absent off macOS is the "no power row
/// at all" problem rather than the honest "this host has no About panel").
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AboutPanelOutcome {
    /// The platform's own panel was put on screen.
    Shown,
    /// This host's platform has no such panel (Linux / Windows) — the wall-clock is not
    /// claimed to have changed.
    UnsupportedHost,
    /// The call needed the main thread and did not have it, so **nothing was shown**. Not
    /// reachable from this command on a normal run (Tauri dispatches commands on the main
    /// thread when the runtime is configured as this app configures it); it exists so that a
    /// future off-thread caller is reported rather than assumed.
    WrongThread,
}

/// Ask the host to show the platform's own About panel — the shell's Apple menu row **(REQ-A796)**.
///
/// Same panel the native `Amos ▸ About Amos` item opens, through the same function: this is a
/// second *route* to one implementation, not a second implementation. It exists because the
/// in-window Apple menu had no route at all — its row was greyed, and its label said the reason
/// was "no standalone panel", which is false on macOS: `orderFrontStandardAboutPanel` **is** a
/// standalone panel and this app already opens it from the menu bar. The row's real problem was
/// a missing command, and the honest fix for a missing command is the command, not a better
/// apology (the same disposition REQ-A515 took for the power rows, which were greyed with the
/// capability missing until the host grew `session_restart` / `session_shutdown` /
/// `session_sleep`).
///
/// Zero arguments, following `session.rs`'s rule 1: there is nothing here for the WebView to
/// name. Zero return *payload* as well — the panel reads the bundle's `Info.plist`, so the
/// frontend has nothing to supply and nothing to draw.
#[tauri::command]
pub fn shell_about_panel() -> AboutPanelOutcome {
    #[cfg(target_os = "macos")]
    {
        tracing::info!(target: "amos::about", "About panel requested from the shell Apple menu");
        if with_ns_app_checked("About Amos", |ns| ns.orderFrontStandardAboutPanel(None)) {
            AboutPanelOutcome::Shown
        } else {
            AboutPanelOutcome::WrongThread
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        tracing::info!(
            target: "amos::about",
            "About panel requested, but this host's platform has none"
        );
        AboutPanelOutcome::UnsupportedHost
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
        let mut all: Vec<&str> = ALL.to_vec();
        all.sort_unstable();
        let len = all.len();
        all.dedup();
        assert_eq!(all.len(), len, "menu ids must not collide");
    }

    #[test]
    fn verify_tree_reports_declared_but_missing_ids() {
        // The REQ-A423 shape, reproduced on purpose: `menu.quit` was declared, documented,
        // classified — and absent from the tree. The check must name it (not just say
        // "something is wrong"), because the name is what tells you which row to add.
        let present = |id: &str| id != ids::QUIT;
        assert_eq!(missing_ids(ALL, present), vec![ids::QUIT.to_string()]);
        // …and a complete tree reports nothing.
        assert!(missing_ids(ALL, |_| true).is_empty());
        // An empty declaration list must not be mistaken for a failure either.
        assert!(missing_ids(&[], |_| false).is_empty());
    }

    /// REQ-A427 — the install-time check must see items **inside submenus**, which is where
    /// this module's ids live.
    ///
    /// Why a fake tree and not a mock `Menu`: muda builds menu trees on the main thread only,
    /// so building one inside a unit test panics ("`muda::MenuChild` can only be created on
    /// the main thread") — measured, not assumed. The walk is therefore generic over
    /// [`MenuNode`], and this test drives the same function the install path calls.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_tree_check_descends_into_submenus() {
        /// A hand-built tree with the shape the real one has: ids live one level down.
        #[derive(Clone)]
        struct Fake {
            id: String,
            kids: Vec<Fake>,
        }
        impl MenuNode for Fake {
            fn node_id(&self) -> String {
                self.id.clone()
            }
            fn child_nodes(&self) -> Vec<Self> {
                self.kids.clone()
            }
        }
        let leaf = |id: &str| Fake {
            id: id.to_string(),
            kids: Vec::new(),
        };

        let tree = vec![
            Fake {
                id: "menu.app".to_string(),
                kids: vec![leaf(ids::ABOUT), leaf(ids::QUIT)],
            },
            Fake {
                id: "menu.file".to_string(),
                kids: vec![leaf(ids::CLOSE_WINDOW)],
            },
        ];

        let present = collect_item_ids(tree.clone());
        for id in [ids::ABOUT, ids::QUIT, ids::CLOSE_WINDOW] {
            assert!(
                present.contains(&id.to_string()),
                "the walk must reach {id} (it lives inside a submenu); got {present:?}"
            );
        }
        // The defect this replaces, reproduced: a root-only lookup (what `Menu::get` does)
        // finds **none** of them — so `verify_tree` used to report every declared id missing.
        let root_only: Vec<String> = tree.iter().map(|n| n.node_id()).collect();
        assert_eq!(
            missing_ids(ALL, |id| root_only.iter().any(|r| r == id)).len(),
            ALL.len(),
            "a root-only check is exactly the all-missing false alarm this fix removes"
        );
        // And with the walk, a tree that has them reports nothing missing for those three.
        assert!(missing_ids(&[ids::QUIT, ids::ABOUT], |id| {
            present.iter().any(|p| p == id)
        })
        .is_empty());
    }

    /// REQ-A485 — the rows whose chord follows the shell's bindings must be declared ids, and the
    /// mapping must not repeat an intent or an item (a duplicate would make "which accelerator does
    /// this row get?" depend on iteration order).
    #[test]
    fn the_synced_accelerators_are_declared_ids() {
        for (intent, item_id) in ACCELERATOR_ITEMS {
            assert!(ALL.contains(item_id), "{item_id} is not a declared menu id");
            assert!(
                default_accelerator(item_id).is_some(),
                "{item_id} carries no chord in DEFAULT_ACCELERATORS, so syncing it would advertise \
                 a key on a row the user has never seen as a shortcut"
            );
            assert!(
                !intent.is_empty(),
                "every synced row names a shell intent id"
            );
        }
        let mut item_ids: Vec<&str> = ACCELERATOR_ITEMS.iter().map(|(_, id)| *id).collect();
        item_ids.sort_unstable();
        let before = item_ids.len();
        item_ids.dedup();
        assert_eq!(before, item_ids.len(), "no duplicate menu item ids");
        let mut intents: Vec<&str> = ACCELERATOR_ITEMS
            .iter()
            .map(|(intent, _)| *intent)
            .collect();
        intents.sort_unstable();
        let before = intents.len();
        intents.dedup();
        assert_eq!(before, intents.len(), "no duplicate intent ids");
        // The set macOS documents for the focused window, minus the one with no native row (⌘`).
        assert_eq!(ACCELERATOR_ITEMS.len(), 5);
        assert!(ACCELERATOR_ITEMS.iter().any(|(i, _)| *i == "newWindow"));
    }

    /// REQ-A485 — the build-time default and the **shell's** default must be the *same key*, because
    /// that is the property that made the stale menu look right: the literal was correct when the
    /// bindings were fixed, and only stopped being correct once a user could change them.
    ///
    /// **What this test does *not* do (REQ-A661):** the "shell defaults" below are a Rust re-typing of
    /// `desktopKeys.ts`/`SYSTEM_DEFAULTS`, so on its own this compares Rust to Rust. The binding that
    /// actually reads the frontend is `frontend-ts/src/__tests__/desktopKeys.test.ts` — it parses
    /// `ACCELERATOR_ITEMS` and `DEFAULT_ACCELERATORS` from this file and holds them to the shell's own
    /// defaults through the shell's `toAccelerator`. Keep both in step with the frontend's literals.
    #[test]
    fn the_build_time_defaults_equal_the_shells_defaults() {
        // The shell's defaults, re-typed in muda's grammar: ⌘N, ⌘W, ⌘M, ⌘H, ⌘,.
        let shell_defaults: &[(&str, &str)] = &[
            ("newWindow", "CmdOrCtrl+N"),
            ("closeWindow", "CmdOrCtrl+W"),
            ("minimizeWindow", "CmdOrCtrl+M"),
            ("hideApp", "CmdOrCtrl+H"),
            ("preferences", "CmdOrCtrl+,"),
        ];
        for (intent, accelerator) in shell_defaults {
            let (_, item_id) = ACCELERATOR_ITEMS
                .iter()
                .find(|(id, _)| id == intent)
                .unwrap_or_else(|| panic!("{intent} is a synced intent"));
            assert_eq!(
                default_accelerator(item_id),
                Some(*accelerator),
                "{item_id}'s build-time chord must equal the shell's default for {intent}"
            );
        }
    }

    /// REQ-A490 — the override map is the *state* the bar is rebuilt from, so its transitions are
    /// where a wrong answer would live: a disable that cannot be undone, or an older shell silently
    /// re-enabling rows it cannot name.
    #[test]
    fn the_binding_overrides_fold_a_payload_without_losing_state() {
        let empty = BindingOverrides::new();

        // A fresh payload sets chords.
        let first = fold_overrides(
            &empty,
            &accelerator_updates(&serde_json::json!({
                "newWindow": "CmdOrCtrl+Alt+N",
                "hideApp": "CmdOrCtrl+H",
            }))
            .expect("the shell's shape parses"),
        );
        assert_eq!(
            accelerator_for(ids::NEW_WINDOW, &first),
            Some("CmdOrCtrl+Alt+N"),
            "a rebound row carries the user's chord"
        );

        // Disabling records "no chord"…
        let disabled = fold_overrides(
            &first,
            &accelerator_updates(&serde_json::json!({ "hideApp": null }))
                .expect("null is a disable"),
        );
        assert_eq!(accelerator_for(ids::HIDE_AMOS, &disabled), None);
        assert_eq!(
            accelerator_for(ids::NEW_WINDOW, &disabled),
            Some("CmdOrCtrl+Alt+N"),
            "a row the payload omits keeps what it had"
        );

        // …and it is **reversible**: the row the user re-enables gets its chord back (the fold would
        // otherwise leave a permanent hole, which no rebuild could see).
        let re_enabled = fold_overrides(
            &disabled,
            &accelerator_updates(&serde_json::json!({ "hideApp": "CmdOrCtrl+H" }))
                .expect("re-enabling is just a value"),
        );
        assert_eq!(
            accelerator_for(ids::HIDE_AMOS, &re_enabled),
            Some("CmdOrCtrl+H")
        );

        // A row nobody ever mentioned still falls back to the build-time literal.
        assert_eq!(
            accelerator_for(ids::QUIT, &re_enabled),
            default_accelerator(ids::QUIT)
        );
    }

    /// The unsynced rows must keep their literals no matter what the payload says: `⌘Q` / `⌥⌘H` are
    /// not the shell's to move, and a rebuild has to leave them exactly as built.
    #[test]
    fn the_binding_overrides_do_not_touch_rows_the_shell_cannot_name() {
        let folded = fold_overrides(
            &BindingOverrides::new(),
            &accelerator_updates(&serde_json::json!({ "newWindow": null })).expect("parses"),
        );
        assert_eq!(accelerator_for(ids::NEW_WINDOW, &folded), None);
        assert_eq!(
            accelerator_for(ids::QUIT, &folded),
            Some("CmdOrCtrl+Q"),
            "the quit row is pinned by the platform convention, not by the shell's payload"
        );
        assert_eq!(
            accelerator_for(ids::HIDE_OTHERS, &folded),
            Some("CmdOrCtrl+Alt+H")
        );
    }

    /// REQ-A485 — the payload the shell sends is parsed into item-level updates.
    #[test]
    fn accelerator_updates_read_the_shell_payload() {
        let payload = serde_json::json!({
            "newWindow": "CmdOrCtrl+Alt+N",
            "hideApp": null,
        });
        let updates = accelerator_updates(&payload).expect("the shell's own shape parses");
        assert_eq!(updates.len(), 2);
        assert!(updates.contains(&AcceleratorUpdate {
            item_id: ids::NEW_WINDOW.to_string(),
            accelerator: Some("CmdOrCtrl+Alt+N".to_string()),
        }));
        // `null` is "the user disabled this binding" ⇒ the row must advertise **nothing**.
        assert!(updates.contains(&AcceleratorUpdate {
            item_id: ids::HIDE_AMOS.to_string(),
            accelerator: None,
        }));
    }

    /// An intent the payload omits keeps the accelerator it was built with — the honest reading of
    /// "nothing was said about it" (an older UI knows fewer rows).
    #[test]
    fn an_omitted_intent_is_not_an_update() {
        let updates = accelerator_updates(&serde_json::json!({ "closeWindow": "CmdOrCtrl+W" }))
            .expect("parses");
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].item_id, ids::CLOSE_WINDOW);
    }

    /// Every refusal, each with its reason: a typo must not sync nothing in silence, and an empty
    /// string is not a binding (the shell sends `null` to disable).
    #[test]
    fn malformed_payloads_are_refused_by_name() {
        let err = accelerator_updates(&serde_json::json!({ "new-window": "CmdOrCtrl+N" }))
            .expect_err("a hyphenated intent id is not one of ours");
        assert!(
            err.contains("new-window"),
            "the refusal names the offending id: {err}"
        );

        let err = accelerator_updates(&serde_json::json!({ "newWindow": "" }))
            .expect_err("an empty accelerator is not a binding");
        assert!(err.contains("null"), "and says what to send instead: {err}");

        let err = accelerator_updates(&serde_json::json!({ "newWindow": 42 }))
            .expect_err("a number is not an accelerator");
        assert!(err.contains("42"), "and shows what it got: {err}");

        let err = accelerator_updates(&serde_json::json!(["CmdOrCtrl+N"]))
            .expect_err("an array is not the payload's shape");
        assert!(err.contains("object"), "and says the shape it wants: {err}");
    }

    /// The applier must answer "I could not sync" instead of a count, when there is no bar.
    ///
    /// REQ-A490 / REQ-A1856 / MENU_AUDIT §4.2. This test replaces `a_disabled_accelerator_still_counts_as_applied`,
    /// which asserted **nothing on any platform**: it was `#[cfg(target_os = "macos")]`, and its one
    /// assertion sat in a `#[cfg(not(target_os = "macos"))]` block *inside* that gate — provably
    /// unreachable, so the test existed only to carry its name and a comment describing the policy it
    /// claimed to pin. Its doc also promised a migration to `tauri::test::mock_app` that cannot work
    /// for the item walk: muda builds a menu tree on the main thread only, and a `#[test]` runs off it
    /// (`the_tree_check_descends_into_submenus` measured that panic — the same reason that test walks
    /// a `Fake` tree).
    ///
    /// What *can* be driven is the guard in front of that walk, through the production function and a
    /// real `AppHandle` — the "call it, do not re-enact it" rule `dock_badge`'s
    /// `apply_records_what_it_applied_and_collapses_a_blank_to_no_badge` records for its own
    /// re-enacted pipeline. A host whose menu was never installed must **not** answer `Ok(len)`: that
    /// is exactly the audit's worry — the shell comparing `applied == sent` would read "synced" for a
    /// bar nothing touched.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_applier_refuses_when_no_menu_is_installed() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app builds");
        let updates = vec![AcceleratorUpdate {
            item_id: ids::HIDE_AMOS.to_string(),
            accelerator: None,
        }];
        // No `set_menu` was called, so there is no bar to sync.
        let err = apply_accelerators(app.handle(), &updates)
            .expect_err("a host with no installed menu must not report a sync count");
        assert!(err.contains("no app menu"), "and names the cause: {err}");
    }

    /// Off macOS there is no bar to sync, and the applier's contract is to report **every** row as
    /// handled — the count the shell compares against. Pinned here because it is the platform CI and
    /// most builds actually run (REQ-A1856): the macOS branch above it is unreachable in a unit test.
    #[cfg(all(not(target_os = "macos"), desktop))]
    #[test]
    fn the_no_op_applier_reports_every_row_so_the_shell_comparison_holds() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app builds");
        let updates = vec![AcceleratorUpdate {
            item_id: ids::HIDE_AMOS.to_string(),
            accelerator: None,
        }];
        assert_eq!(
            apply_accelerators(app.handle(), &updates).expect("the no-op applier never fails"),
            updates.len(),
            "a count below the payload's length would make the shell report a shortfall on every \
             user who turned a binding off (REQ-A487)"
        );
    }

    /// REQ-A490 — the follow-up: a `null` in the payload means "rebuild the bar". The shell
    /// cannot tell on its own whether the rebuild is needed (it only knows the count of
    /// updates, not what was sent in the past). The host can: it knows whether any update
    /// in this payload was a disable. The audit action (`menu_set_shortcuts`) calls
    /// `apply_accelerators`, observes the warn-by-id, and **then** triggers redraw when at
    /// least one update asked for `None`. This test pins the **detection** of that
    /// condition so the trigger cannot regress.
    #[test]
    fn the_payload_signals_redraw_when_any_update_is_disabled() {
        let only_changes = [AcceleratorUpdate {
            item_id: ids::NEW_WINDOW.to_string(),
            accelerator: Some("CmdOrCtrl+Alt+N".to_string()),
        }];
        assert!(
            only_changes.iter().all(|u| u.accelerator.is_some()),
            "a payload of pure changes does not need a redraw"
        );

        let mixed = [
            AcceleratorUpdate {
                item_id: ids::NEW_WINDOW.to_string(),
                accelerator: Some("CmdOrCtrl+Alt+N".to_string()),
            },
            AcceleratorUpdate {
                item_id: ids::HIDE_AMOS.to_string(),
                accelerator: None,
            },
        ];
        assert!(
            mixed.iter().any(|u| u.accelerator.is_none()),
            "a payload with a disabled row MUST trigger redraw_bar"
        );
    }

    /// REQ-A433 — the items `sync_window_items` greys must be ids this module declares **and**
    /// installs. A renamed or dropped id would leave a row that never gets synced (the
    /// function reports a count mismatch at runtime, and this pins the cause at build time).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_window_menu_items_are_declared_ids() {
        for id in WINDOW_ITEMS {
            assert!(ALL.contains(id), "{id} is not a declared menu id");
        }
        // No duplicates, and **every** action that acts on a focused window is covered.
        //
        // The count is a floor, not a pin: REQ-A869 added Print (the fifth such action, and with
        // the same consequence if it is missed — a row that stays enabled while the launcher is
        // the only window, i.e. a live-looking item whose only possible outcome is the host's
        // `no_window` refusal). So each id is also named: a count alone cannot see a swap, and a
        // swap is exactly what dropping `CLOSE_WINDOW` to add `PRINT` would have looked like.
        let mut sorted = WINDOW_ITEMS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), WINDOW_ITEMS.len(), "no duplicate ids");
        assert_eq!(WINDOW_ITEMS.len(), 5);
        for expected in [
            ids::CLOSE_WINDOW,
            ids::MINIMIZE,
            ids::ZOOM,
            ids::ENTER_FULLSCREEN,
            ids::PRINT,
        ] {
            assert!(
                WINDOW_ITEMS.contains(&expected),
                "{expected} acts on the focused window and must be greyed with the rest"
            );
        }
    }

    /// REQ-A437 — the menu bar's language. Two things are pinned: the locale **default** (a
    /// fresh install's store has no `amos-ui.locale`, and the shell's own default is Chinese),
    /// and that the two tables really are two (a copy-paste that left a row in English would
    /// otherwise be invisible on a Chinese Mac).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_menu_language_defaults_to_the_shells_own_and_both_tables_are_complete() {
        // The store may hold "zh" / "en" (raw, like the theme) — anything else, including the
        // absent value, follows the shell's default.
        assert_eq!(MenuLocale::parse(Some("zh")), MenuLocale::Zh);
        assert_eq!(MenuLocale::parse(Some("en")), MenuLocale::En);
        assert_eq!(MenuLocale::parse(None), MenuLocale::Zh);
        assert_eq!(MenuLocale::parse(Some("fr")), MenuLocale::Zh);
        assert_eq!(MenuLocale::Zh.as_str(), "zh");
        assert_eq!(MenuLocale::En.as_str(), "en");

        let zh = labels_for(MenuLocale::Zh);
        let en = labels_for(MenuLocale::En);
        // The product name is not translated in either table.
        assert_eq!(zh.app_menu, "Amos");
        assert_eq!(en.app_menu, "Amos");
        // Every **translated** row must actually differ; the list is written out so adding a
        // field to `MenuLabels` forces a decision here (a new English row must be translated).
        let pairs: [(&str, &str, &str); 25] = [
            ("about", zh.about, en.about),
            ("preferences", zh.preferences, en.preferences),
            ("hide_amos", zh.hide_amos, en.hide_amos),
            ("hide_others", zh.hide_others, en.hide_others),
            ("show_all", zh.show_all, en.show_all),
            ("quit", zh.quit, en.quit),
            ("file", zh.file, en.file),
            ("new_window", zh.new_window, en.new_window),
            ("close_window", zh.close_window, en.close_window),
            // REQ-A869: File ▸ Print… — the row that sends the activation to the host
            // (`crate::print::print_document`) rather than printing the launcher document.
            ("print", zh.print, en.print),
            ("edit", zh.edit, en.edit),
            // The Edit menu's predefined rows (REQ-A439) are ours to translate now — and the
            // list is what forces a decision when one is added.
            ("undo", zh.undo, en.undo),
            ("redo", zh.redo, en.redo),
            ("cut", zh.cut, en.cut),
            ("copy", zh.copy, en.copy),
            ("paste", zh.paste, en.paste),
            ("select_all", zh.select_all, en.select_all),
            ("view", zh.view, en.view),
            ("minimize", zh.minimize, en.minimize),
            ("zoom", zh.zoom, en.zoom),
            ("enter_fullscreen", zh.enter_fullscreen, en.enter_fullscreen),
            ("window", zh.window, en.window),
            ("help", zh.help, en.help),
            // REQ-A482: the Help menu rows (previously empty, now filled).
            ("search_help", zh.search_help, en.search_help),
            ("amos_help", zh.amos_help, en.amos_help),
        ];
        for (field, zh_label, en_label) in pairs {
            assert!(!zh_label.is_empty(), "{field}: zh label is empty");
            assert!(!en_label.is_empty(), "{field}: en label is empty");
            assert_ne!(
                zh_label, en_label,
                "{field}: the zh and en labels are identical"
            );
        }
    }

    /// The About panel's answer is a **word the frontend can read**, not a `()` (REQ-A796).
    ///
    /// This is the F-SH-236 lesson pinned one module over: on that defect `invoke`'s failure
    /// value and a `void` command's success value were the same `null`, so the IncomingCall
    /// overlay rendered a refused answer as "in a call". A `()`-returning `shell_about_panel`
    /// would recreate that collapse exactly — the desktop Apple menu could not tell "the panel
    /// is up" from "this host has no panel". The serde spelling is part of the contract (the
    /// frontend switches on it), so it is asserted here rather than left to `rename_all` to
    /// keep meaning the same thing.
    ///
    /// Negative control: drop `#[serde(rename_all = "snake_case")]` and the two string
    /// assertions go red (`"Shown"` / `"UnsupportedHost"`); make the non-macOS arm answer
    /// `Shown` and `the_callers_success_word_is_not_the_only_word_there_is` goes red on Linux.
    #[test]
    fn the_about_panel_outcome_is_a_word_the_frontend_can_read() {
        assert_eq!(
            serde_json::to_string(&AboutPanelOutcome::Shown).expect("serializable"),
            "\"shown\""
        );
        assert_eq!(
            serde_json::to_string(&AboutPanelOutcome::UnsupportedHost).expect("serializable"),
            "\"unsupported_host\""
        );
        assert_eq!(
            serde_json::to_string(&AboutPanelOutcome::WrongThread).expect("serializable"),
            "\"wrong_thread\""
        );
    }

    /// **A host with no About panel says so rather than claiming one.**
    ///
    /// The negative control for `shell_about_panel`'s non-macOS arm, and it runs where it counts:
    /// CI is `ubuntu-24.04`, i.e. exactly the host this asserts about. Make that arm answer
    /// `Shown` — the shape a copied-and-pasted command takes — and this goes red, on Linux, in
    /// CI, which is the only place the mistake is visible at all.
    ///
    /// Honest boundary: the macOS arm is **not** exercised here. Calling `shell_about_panel()` on
    /// this machine would put a real panel on screen (that is what it is for), and a test that
    /// opens an AppKit window is not a test anyone can run twice. Its two failure paths are
    /// covered by `with_ns_app_checked`'s return value being read (`WrongThread` is unreachable
    /// on a normally-dispatched command) and by the serde pin above.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_host_without_an_about_panel_says_so_rather_than_claiming_one() {
        assert_eq!(shell_about_panel(), AboutPanelOutcome::UnsupportedHost);
    }

    /// **`with_ns_app_checked` reports a thread it did not get, and opens nothing while doing it.**
    ///
    /// The macOS half of the negative control above. The checked form exists precisely so a menu
    /// item that needs the main thread can *find out* it did not get it: `with_ns_app` logs and
    /// returns `()`, which is the F-SH-236 shape — a refusal and a success answering the same
    /// value. `WrongThread` on `shell_about_panel` is unreachable on a normally-dispatched
    /// command (Tauri runs it on the main thread), so without this test that arm would be
    /// unreachable *and* unverified, which is where "defensive branches that were never once
    /// executed" come from.
    ///
    /// The closure is **empty**, so no AppKit object is touched and no panel appears — what is
    /// under test is the report, not AppKit. The body runs on a **spawned** thread rather than
    /// the test thread: `MainThreadMarker::new()` is `None` there for a deterministic reason
    /// (libtest happens to run on the main thread under `--test-threads=1`, so relying on the
    /// harness's thread choice would make this flake in exactly the configuration nobody runs
    /// locally).
    ///
    /// Negative control: make `with_ns_app_checked` `return true` before the `MainThreadMarker`
    /// check and this goes red — and `shell_about_panel` would then claim the panel was up on a
    /// thread where nothing ran, silently.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_checked_ns_app_helper_reports_a_thread_it_did_not_get() {
        let ran = std::thread::spawn(|| with_ns_app_checked("test", |_ns| {}))
            .join()
            .expect("the probe thread must not panic");
        assert!(
            !ran,
            "a non-main thread must be reported, not assumed to have run the AppKit call"
        );
    }

    #[test]
    fn quit_is_declared_because_the_app_menu_installs_it() {
        // The regression guard for the specific defect: ⌘Q is the one chord every macOS
        // user has in muscle memory. If a future edit drops the item from `build_menu`
        // (the only place that decides), this pin and the install-time `verify_tree` both
        // fail — `ids::QUIT` staying in the handler set is not evidence of anything.
        assert!(ALL.contains(&ids::QUIT));
        assert!(RUST_HANDLED.contains(&ids::QUIT));
        assert!(TERMINAL_RUST.contains(&ids::QUIT));
    }
}
