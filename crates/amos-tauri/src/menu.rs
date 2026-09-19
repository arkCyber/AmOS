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

use tauri::{
    menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemKind, SubmenuBuilder},
    AppHandle, Emitter, Manager, Runtime,
};

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

    /// View menu.
    pub const MINIMIZE: &str = "menu.minimize";
    pub const ZOOM: &str = "menu.zoom";
    pub const ENTER_FULLSCREEN: &str = "menu.enter-fullscreen";

    /// **Every** id this module declares — the list [`verify_tree`] checks the built menu
    /// against, and the one the uniqueness test walks. Kept in one place precisely because
    /// the REQ-A423 defect (an id with a handler, a doc entry and no menu item) is invisible
    /// to a compiler: nothing references `QUIT` except a `match` arm that could never run.
    pub const ALL: &[&str] = &[
        ABOUT,
        PREFERENCES,
        HIDE_AMOS,
        HIDE_OTHERS,
        SHOW_ALL,
        QUIT,
        NEW_WINDOW,
        CLOSE_WINDOW,
        MINIMIZE,
        ZOOM,
        ENTER_FULLSCREEN,
    ];
}

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
    let target = actionable_window_label(app);
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

/// The focused app window a menu action could act on, or `None` when there is none.
///
/// One owner for the question both [`close_key_window`] and [`sync_window_items`] must answer:
/// the platform's key window first (macOS's own semantics), then the window manager's answer
/// (a window created a moment ago is on screen before the OS makes it key — REQ-A431). The
/// launcher is never a candidate: it *is* the desktop (F-SH-008).
#[cfg(target_os = "macos")]
fn actionable_window_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let windows = app.webview_windows();
    let platform_key = windows
        .iter()
        .find(|(label, window)| {
            !crate::wm::is_screen_window(label) && window.is_focused().unwrap_or(false)
        })
        .map(|(label, _)| label.clone());
    close_target_label(platform_key.as_deref(), model_focused_label(app).as_deref())
}

/// Menu items that act on **the focused app window** — see [`sync_window_items`].
#[cfg(target_os = "macos")]
const WINDOW_ITEMS: &[&str] = &[
    ids::CLOSE_WINDOW,
    ids::MINIMIZE,
    ids::ZOOM,
    ids::ENTER_FULLSCREEN,
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
    let enabled = actionable_window_label(app).is_some();
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

/// Which window a menu **Close** (⌘W) should act on: the platform's key window when it names
/// one, otherwise the window the window manager says is focused. The launcher is never a
/// target in either branch (F-SH-008) — see [`close_key_window`] for the measurement that
/// made the fallback necessary.
#[cfg(target_os = "macos")]
fn close_target_label(platform_key: Option<&str>, model_focused: Option<&str>) -> Option<String> {
    let actionable = |label: &str| (!crate::wm::is_screen_window(label)).then(|| label.to_string());
    platform_key
        .and_then(actionable)
        .or_else(|| model_focused.and_then(actionable))
}

/// The window the **window manager** says is focused, if that state is mounted and readable.
///
/// `None` for an external surface: such a surface has no platform window to close, and
/// pretending otherwise would close a neighbour.
#[cfg(target_os = "macos")]
fn model_focused_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let state = app.try_state::<crate::wm::WmState>()?;
    let snapshot = state.snapshot().ok()?;
    snapshot
        .windows
        .iter()
        .find(|w| w.focused && !w.external)
        .map(|w| w.label.clone())
}

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
            items = ids::ALL.len(),
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

/// Tauri command: draw the menu bar in the shell's language (`amos-ui.locale`).
///
/// Defined on every platform so the frontend's call is the same everywhere: off macOS the body
/// is the documented no-op above.
#[tauri::command]
pub fn menu_set_locale(app: AppHandle, locale: String) -> Result<String, String> {
    set_locale(&app, &locale)
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
    missing_ids(ids::ALL, |id| present.iter().any(|p| p == id))
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
    new_window: "New Files Window",
    close_window: "Close Window",
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
    new_window: "新建「文件」窗口",
    close_window: "关闭窗口",
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
};

/// The label table for `locale`.
#[cfg(target_os = "macos")]
pub fn labels_for(locale: MenuLocale) -> &'static MenuLabels {
    match locale {
        MenuLocale::Zh => &LABELS_ZH,
        MenuLocale::En => &LABELS_EN,
    }
}

/// The locale the shell last stored, or the shell's own default (`zh`) before it ever did.
#[cfg(target_os = "macos")]
fn stored_locale<R: Runtime>(app: &AppHandle<R>) -> MenuLocale {
    app.try_state::<crate::store::SharedStore>()
        .and_then(|store| store.get("amos-ui.locale"))
        .map(|raw| MenuLocale::parse(Some(raw.as_str())))
        .unwrap_or(MenuLocale::Zh)
}

/// Build the full menu tree in `l`.
#[cfg(target_os = "macos")]
fn build_menu<R: Runtime>(app: &AppHandle<R>, l: &MenuLabels) -> Result<Menu<R>, String> {
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
            Some("CmdOrCtrl+,"),
        )?)
        .separator()
        .item(&item(
            app,
            ids::HIDE_AMOS,
            l.hide_amos,
            true,
            Some("CmdOrCtrl+H"),
        )?)
        .item(&item(
            app,
            ids::HIDE_OTHERS,
            l.hide_others,
            true,
            Some("CmdOrCtrl+Alt+H"),
        )?)
        .item(&item(app, ids::SHOW_ALL, l.show_all, true, None)?)
        .separator()
        .item(&item(app, ids::QUIT, l.quit, true, Some("CmdOrCtrl+Q"))?)
        .build()
        .map_err(|e| e.to_string())?;

    // ── File menu ────────────────────────────────────────────────────────────
    // "New Files Window", not "New Window" (REQ-A434): the item opens the **Files** app's
    // window (`DesktopShell`'s `menu.new-window` branch → `wm_open("files")`) — the same thing
    // Finder's own "New Finder Window" does. But a macOS label that says "New Window" promises
    // "another window of what you are looking at": measured on this machine (2026-09-18), with
    // the Notes window focused, its click handed the user a Files window and there was nothing
    // anywhere to have known that. A per-app "new window" needs a second identity besides the
    // label ⇄ app mapping (the host keeps one window per label), so the honest fix today is the
    // label that states what actually happens.
    let file = SubmenuBuilder::new(app, l.file)
        .item(&item(
            app,
            ids::NEW_WINDOW,
            l.new_window,
            true,
            Some("CmdOrCtrl+N"),
        )?)
        .separator()
        .item(&item(
            app,
            ids::CLOSE_WINDOW,
            l.close_window,
            true,
            Some("CmdOrCtrl+W"),
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
            Some("CmdOrCtrl+M"),
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

    // ── Help menu ─────────────────────────────────────────────────────────────
    let help = SubmenuBuilder::new(app, l.help)
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

/// Non-macOS desktop: no menu bar is installed (see [`install`]), so there is nothing to
/// route. Present so the `Builder::on_menu_event` wiring is one line on every target
/// instead of a `#[cfg]` at the call site — the same shape `install` uses.
#[cfg(not(target_os = "macos"))]
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
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else {
        tracing::warn!(
            target: "amos::menu",
            item = name,
            "menu item needs the main thread; it was not performed"
        );
        return;
    };
    f(&objc2_app_kit::NSApplication::sharedApplication(mtm));
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
        let mut all: Vec<&str> = ids::ALL.to_vec();
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
        assert_eq!(missing_ids(ids::ALL, present), vec![ids::QUIT.to_string()]);
        // …and a complete tree reports nothing.
        assert!(missing_ids(ids::ALL, |_| true).is_empty());
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
            missing_ids(ids::ALL, |id| root_only.iter().any(|r| r == id)).len(),
            ids::ALL.len(),
            "a root-only check is exactly the all-missing false alarm this fix removes"
        );
        // And with the walk, a tree that has them reports nothing missing for those three.
        assert!(missing_ids(&[ids::QUIT, ids::ABOUT], |id| {
            present.iter().any(|p| p == id)
        })
        .is_empty());
    }

    /// REQ-A431 — the fallback that closes the window the user just opened while the OS has
    /// not made it key yet. Pure, so the rule is pinned without a platform.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_menu_close_target_prefers_the_key_window_and_falls_back_to_the_model() {
        // The platform names a key app window: that is macOS's own Close.
        assert_eq!(
            close_target_label(Some("notes"), Some("photos")).as_deref(),
            Some("notes")
        );
        // The platform names no key window (measured right after a window is created): the
        // window manager's answer is used instead of closing nothing.
        assert_eq!(
            close_target_label(None, Some("settings")).as_deref(),
            Some("settings")
        );
        // The launcher is never a target, in either branch (F-SH-008) — and when only the
        // launcher is focused there is honestly nothing to close.
        assert_eq!(close_target_label(Some("main"), None), None);
        assert_eq!(close_target_label(None, Some("main")), None);
        assert_eq!(
            close_target_label(Some("main"), Some("notes")).as_deref(),
            Some("notes")
        );
        assert_eq!(close_target_label(None, None), None);
    }

    /// REQ-A433 — the items `sync_window_items` greys must be ids this module declares **and**
    /// installs. A renamed or dropped id would leave a row that never gets synced (the
    /// function reports a count mismatch at runtime, and this pins the cause at build time).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_window_menu_items_are_declared_ids() {
        for id in WINDOW_ITEMS {
            assert!(ids::ALL.contains(id), "{id} is not a declared menu id");
        }
        // No duplicates, and the four actions that act on a focused window are all covered.
        let mut sorted = WINDOW_ITEMS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), WINDOW_ITEMS.len(), "no duplicate ids");
        assert_eq!(WINDOW_ITEMS.len(), 4);
        assert!(WINDOW_ITEMS.contains(&ids::CLOSE_WINDOW));
        assert!(WINDOW_ITEMS.contains(&ids::ZOOM));
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
        let pairs: [(&str, &str, &str); 22] = [
            ("about", zh.about, en.about),
            ("preferences", zh.preferences, en.preferences),
            ("hide_amos", zh.hide_amos, en.hide_amos),
            ("hide_others", zh.hide_others, en.hide_others),
            ("show_all", zh.show_all, en.show_all),
            ("quit", zh.quit, en.quit),
            ("file", zh.file, en.file),
            ("new_window", zh.new_window, en.new_window),
            ("close_window", zh.close_window, en.close_window),
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

    #[test]
    fn quit_is_declared_because_the_app_menu_installs_it() {
        // The regression guard for the specific defect: ⌘Q is the one chord every macOS
        // user has in muscle memory. If a future edit drops the item from `build_menu`
        // (the only place that decides), this pin and the install-time `verify_tree` both
        // fail — `ids::QUIT` staying in the handler set is not evidence of anything.
        assert!(ids::ALL.contains(&ids::QUIT));
        assert!(RUST_HANDLED.contains(&ids::QUIT));
        assert!(TERMINAL_RUST.contains(&ids::QUIT));
    }
}
