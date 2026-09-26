//! The **system tray** — AmOS's own presence in the menu bar (macOS), the notification
//! area (Windows) or the app indicator (Linux). REQ-A864.
//!
//! ## Why this module exists
//!
//! `docs/DESKTOP_AUDIT_2026_SEP21.md` ranks "无托盘 / 菜单栏常驻" (A6) **third** by user
//! impact, and §2 confirms it with a zero-hit probe (`grep -rn 'TrayIcon'
//! crates/amos-tauri/src` → 0). The consequence the audit states is not cosmetic: without
//! a tray there is **no surface for the class of software that runs with no window on
//! screen** — the shell is either in front of the user or invisible, and there is nothing
//! in between. The one action that keeps an OS reachable from behind another app had no
//! home.
//!
//! ## What this closes, and what it explicitly does not
//!
//! A6 has two halves. This module closes the **system's own** half: AmOS gets a status
//! item with a menu, so "bring the desktop back" and "quit" exist while no shell window is
//! in front. The **third-party** half — a store-installed app placing its own status item —
//! is *not* here and is a different piece of work: it needs an app-facing registration API
//! (`lib/storeApps` has the manifest, nothing consumes a tray slot from it), a lifetime
//! rule for an item whose app exits, and a way for the shell to render an item it did not
//! write. Saying so matters more than the missing code: the audit's sentence is about
//! "第三方/系统应用", and a reader who finds this file should not conclude that both are
//! done.
//!
//! ## Left click is the primary action, the menu is the right click
//!
//! `show_menu_on_left_click(false)`: on macOS and Windows a left click **brings the
//! desktop back** and the right click opens the menu, which is what a status item with a
//! primary action does. **Honest boundary:** Linux's appindicator has no primary-click
//! channel — the toolkit opens the menu on any click and the flag is ignored — so on Linux
//! the left click opens the menu too. That is the platform's contract, not a fallback we
//! chose, and no code here can change it.
//!
//! ## The icon
//!
//! `app.default_window_icon()`, which `tauri-codegen` always fills (it falls back to
//! `icons/icon.png`; see `context.rs::default_window_icon`). It is shown **in colour** and
//! deliberately *not* as a template: `icon_as_template(true)` makes macOS use the image's
//! alpha as a monochrome mask, which is the right treatment for a purpose-drawn status
//! glyph and the wrong one for a full-colour app icon (the mask of an app icon is a solid
//! blob). A monochrome status-item asset does not exist in this repo; drawing one is a
//! design asset rather than a code change.
//!
//! ## Failure is reported, never swallowed
//!
//! Every step that can fail returns the reason to [`install`]'s caller, which logs it, and
//! `WmState::focus_launcher`'s three non-`Focused` answers are each named rather than folded
//! into "ok" — the same rule `menu::install` follows. A tray that silently did not install
//! would leave a menu-bar-less build looking exactly like this module was never written.
//!
//! The tray object itself is **not** stored: Tauri keeps it alive for the process once
//! built, and dropping the returned handle is what the API expects.
#![cfg_attr(not(desktop), allow(dead_code))]

/// `AppHandle::state` / `try_state` come from `Manager`, and the trait is not in the
/// prelude: importing it at module scope under the same gate as its users keeps the mobile
/// build from carrying an unused import (`menu.rs` pays this same toll).
#[cfg(desktop)]
use tauri::Manager;

/// The tray's own id, so a second install (a re-install after a locale change, a test)
/// cannot silently produce a second icon.
pub const TRAY_ID: &str = "amos-tray";

/// Bring the desktop (the Launcher window) back in front of the user.
pub const SHOW_DESKTOP: &str = "tray.show-desktop";

/// Leave AmOS, the whole process — not "close the focused window".
pub const QUIT: &str = "tray.quit";

/// Every id this module declares.
///
/// A **value**, not a comment, because the two directions have to be checked against
/// something: [`compare_rows`] asks both "is every declared id in the built menu?" and "is
/// every built item a declared id?" — `menu.rs`'s REQ-A423 lesson, where `menu.quit` had a
/// handler, a doc line and a test classification while having **no row at all**.
pub const ALL_IDS: &[&str] = &[SHOW_DESKTOP, QUIT];

/// What a tray menu id means.
///
/// `Hash` is derived so the tests can hold the *reachable* actions in a `HashSet` and compare
/// that against the enum's variants — a set, not a count, so losing one variant cannot pass.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum TrayAction {
    ShowDesktop,
    Quit,
}

/// Resolve a menu id to its action, or `None` for an id this module does not know.
///
/// Pure, and separate from the event handler on purpose: the handler needs a live
/// `AppHandle`, so a mapping written inline there could only be checked by running the app.
/// Here the *whole* id surface is a value a test can hold (`ALL_IDS`) and cross-check in
/// both directions — a row added to the menu without an action is caught by
/// `every_declared_id_has_an_action`, and an action with no row by
/// `no_action_exists_without_a_declared_id`.
pub fn tray_action(id: &str) -> Option<TrayAction> {
    match id {
        SHOW_DESKTOP => Some(TrayAction::ShowDesktop),
        QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

/// The language the **tray menu** is drawn in.
///
/// Same value and the same default as the menu bar (`menu::MenuLocale`): the locale lives
/// in the shared store under `amos-ui.locale`, and a fresh install is **Chinese** — the
/// shell's own default (`lib/i18n.currentLocale()`). The tray is a separate `TrayLabels`
/// rather than a reuse of `MenuLabels` because `MenuLabels` is gated to macOS while the
/// tray is every desktop target; the *parse rule* is shared by being the same rule.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TrayLocale {
    Zh,
    En,
}

impl TrayLocale {
    /// Read the locale from the shell's stored preference. `None` — a fresh install — is
    /// Chinese (see the type doc).
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

/// Every user-visible string in the tray, per language.
///
/// A struct rather than a table keyed by id, for the reason `MenuLabels` gives: adding a
/// row forces choosing a field, and adding a language forces filling every field — "a row
/// shipped without a translation" is a compile error, not something a test has to catch.
pub struct TrayLabels {
    /// The tooltip. The product name, so it is the **same string in both languages** —
    /// `tray_rows_are_translated` excludes it by name rather than by an arbitrary rule.
    pub tooltip: &'static str,
    pub show_desktop: &'static str,
    pub quit: &'static str,
}

const LABELS_EN: TrayLabels = TrayLabels {
    tooltip: "Amos",
    show_desktop: "Show Desktop",
    quit: "Quit Amos",
};

/// Chinese labels. Apple's own vocabulary again: `menu::LABELS_ZH` already says 「退出 Amos」
/// for the menu bar's Quit and 「显示桌面」 is the system's own wording for showing the
/// desktop, so the tray and the bar do not disagree about the same two actions.
const LABELS_ZH: TrayLabels = TrayLabels {
    tooltip: "Amos",
    show_desktop: "显示桌面",
    quit: "退出 Amos",
};

/// The label table for `locale`.
pub fn labels_for(locale: TrayLocale) -> &'static TrayLabels {
    match locale {
        TrayLocale::Zh => &LABELS_ZH,
        TrayLocale::En => &LABELS_EN,
    }
}

/// The locale the shell last stored, or the shell's own default (`zh`) before it ever did.
///
/// A separate copy of `menu::stored_locale`'s three lines rather than a shared helper,
/// because that one is `#[cfg(target_os = "macos")]` and a shared function would have to be
/// un-gated — moving the gate off a macOS-only module to serve a second caller is how the
/// REQ-A785 class of build breakage starts. The **key** is the one thing that must not
/// drift, and it does not: both readers ask for `crate::store::LOCALE_KEY`.
#[cfg(desktop)]
fn stored_locale(app: &tauri::AppHandle) -> TrayLocale {
    app.try_state::<crate::store::SharedStore>()
        .and_then(|store| store.get(crate::store::LOCALE_KEY))
        .map(|raw| TrayLocale::parse(Some(raw.as_str())))
        .unwrap_or(TrayLocale::Zh)
}

/// Which declared ids are missing from a built menu's rows, and which of its rows are undeclared.
///
/// Both directions, because they are different defects: a declared id with no row is a row that
/// can never fire (REQ-A423 — `menu.quit` had a handler, a doc line and a test classification
/// while having no row at all), and a row with no declared id fires into [`tray_action`]'s `None`
/// arm, where the only thing that can happen is a log line.
///
/// A **pure function of the ids found**, not of the menu, and that is the whole point: the
/// walker below needs a live `Menu<R>`, which needs a real runtime (Tauri's mock runtime has no
/// tray and cannot build one), so a comparison written inline in the walker could only ever be
/// exercised by running the app. Here both directions are values a test can hand in, including
/// the two shapes that must be *rejected* — a lost row and a stray row.
pub fn compare_rows(found: &[String]) -> (Vec<String>, Vec<String>) {
    let missing = ALL_IDS
        .iter()
        .filter(|id| !found.iter().any(|f| f == *id))
        .map(|id| (*id).to_string())
        .collect();
    let undeclared = found
        .iter()
        .filter(|id| !ALL_IDS.contains(&id.as_str()))
        .cloned()
        .collect();
    (missing, undeclared)
}

/// The rows a built menu actually carries, as ids.
///
/// Separators and any predefined item are skipped **by kind, not by name** — a row whose id
/// happened to spell a separator would otherwise be read as a row. One level, like the tree:
/// every row in this menu is a top-level item.
#[cfg(desktop)]
fn menu_row_ids<R: tauri::Runtime>(menu: &tauri::menu::Menu<R>) -> Vec<String> {
    use tauri::menu::MenuItemKind;

    menu.items()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|kind| match kind {
            MenuItemKind::MenuItem(item) => Some(item.id().as_ref().to_string()),
            _ => None,
        })
        .collect()
}

/// Build the tray menu in `l`.
#[cfg(desktop)]
fn build_menu(
    app: &tauri::AppHandle,
    l: &TrayLabels,
) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let show = MenuItem::with_id(app, SHOW_DESKTOP, l.show_desktop, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit =
        MenuItem::with_id(app, QUIT, l.quit, true, None::<&str>).map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    Menu::with_items(app, &[&show, &sep, &quit]).map_err(|e| e.to_string())
}

/// Put the desktop back in front of the user.
///
/// The tray's primary action, and the reason [`crate::wm::WmState::focus_launcher`] had to
/// learn to un-minimize first (REQ-A864): the tray is the first caller that can be pressed
/// *after* the platform put the shell away, and `set_focus()` does not bring back a window
/// the platform considers miniaturized (REQ-A441 measured exactly that for app windows).
#[cfg(desktop)]
fn show_desktop(app: &tauri::AppHandle) {
    let state = app.state::<crate::wm::WmState>();
    match state.focus_launcher(app) {
        Ok(crate::wm::LauncherFocus::Focused) => {
            tracing::debug!(target: "amos::tray", "tray: the desktop is back in front");
        }
        // Both of these are "the user pressed it and nothing came forward" — the two ways
        // this can end, named. Note it is *not* an `Err`: the platform answering "no" is a
        // fact to report, not a failure to fold away (see `LauncherFocus`).
        Ok(crate::wm::LauncherFocus::Refused) => tracing::warn!(
            target: "amos::tray",
            "the tray asked for the desktop and the platform did not hand focus over; \
             the shell may sit behind another app"
        ),
        Ok(crate::wm::LauncherFocus::NoWindow) => tracing::warn!(
            target: "amos::tray",
            "the tray asked for the desktop and there is no shell window to give it; \
             the UI is not reachable from the tray"
        ),
        Err(e) => tracing::warn!(
            target: "amos::tray",
            error = %e,
            "the tray could not bring the desktop forward"
        ),
    }
}

/// Build and install the tray icon. Called once at startup from [`crate::run`]`::setup`.
///
/// Non-generic over the runtime on purpose: the two actions it dispatches
/// (`WmState::focus_launcher`, `AppHandle::exit`) are the concrete-runtime ones, and a
/// generic `R` would only move the `R = Wry` requirement into the call site.
///
/// The returned handle is dropped deliberately — Tauri keeps the icon alive for the process
/// once built, and holding it in a `static` would be a second owner of something the
/// framework already owns.
#[cfg(desktop)]
pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::tray::{TrayIconBuilder, TrayIconEvent};

    let locale = stored_locale(app);
    let labels = labels_for(locale);
    let menu = build_menu(app, labels)?;

    // Self-check before the icon becomes the OS's, for the reason `menu::install` gives: a
    // row that cannot fire is invisible from the outside (the menu draws it and nothing
    // happens), so it has to be caught here or not at all.
    let (missing, undeclared) = compare_rows(&menu_row_ids(&menu));
    if missing.is_empty() && undeclared.is_empty() {
        tracing::info!(
            target: "amos::tray",
            rows = ALL_IDS.len(),
            "tray menu verified: every declared row is installed and no row is undeclared"
        );
    } else {
        tracing::warn!(
            target: "amos::tray",
            missing = ?missing,
            undeclared = ?undeclared,
            "the tray menu does not match the declared rows; the listed rows can never fire, \
             and the undeclared ones fire into nothing"
        );
    }

    let mut builder = TrayIconBuilder::with_id(tauri::tray::TrayIconId::new(TRAY_ID))
        .menu(&menu)
        .tooltip(labels.tooltip)
        // Left click runs the primary action; the right click opens the menu. See the
        // module doc for the Linux exception.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match tray_action(event.id().as_ref()) {
            Some(TrayAction::ShowDesktop) => show_desktop(app),
            Some(TrayAction::Quit) => app.exit(0),
            // Reported, not silent: this is what an undeclared row would do if one ever
            // got here, and a menu row that does nothing while looking live is exactly the
            // defect `compare_rows` exists to catch one step earlier.
            None => tracing::warn!(
                target: "amos::tray",
                id = %event.id().as_ref(),
                "a tray row fired that this module does not know; nothing happened"
            ),
        })
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState};
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_desktop(tray.app_handle());
            }
        });

    // Always `Some` on every target `tauri-codegen` supports — it falls back to
    // `icons/icon.png` — but written as a check rather than an `expect`, because a tray with
    // no image is invisible on macOS and "invisible" is the failure this module must not
    // have silently.
    match app.default_window_icon() {
        Some(icon) => builder = builder.icon(icon.clone()),
        None => tracing::warn!(
            target: "amos::tray",
            "no default window icon; the tray item was built without one and may not be \
             visible on macOS"
        ),
    }

    builder.build(app).map_err(|e| e.to_string())?;
    tracing::info!(
        target: "amos::tray",
        locale = locale.as_str(),
        "system tray installed"
    );
    Ok(())
}

/// Re-label the tray in `raw`'s language — the tray's half of REQ-A437, called from the same
/// command that re-draws the menu bar (`menu::menu_set_locale`).
///
/// **Why this has to exist at all:** the tray is built once, at boot, from the locale the store
/// held *then* (`install`). Without this, a language change re-draws the menu bar and leaves the
/// tray reading the language the app started in — which is REQ-A437 itself, one surface over: the
/// bar was fixed and its sibling regressed by being written later. The rebuild goes through the
/// same [`build_menu`] and the same [`compare_rows`] shape, so a re-label cannot introduce a row
/// the boot path would not have.
///
/// The tray is looked up **by id** rather than kept in a field: `install` deliberately drops the
/// handle (Tauri owns it), and a second owner is how two copies of "the tray" start disagreeing.
/// An `Err` here means there is no tray to label — the caller reports it, because a silent no-op
/// would be indistinguishable from a re-label that worked.
#[cfg(desktop)]
pub fn set_locale(app: &tauri::AppHandle, raw: &str) -> Result<TrayLocale, String> {
    let locale = TrayLocale::parse(Some(raw));
    let labels = labels_for(locale);
    let Some(tray) = app.tray_by_id(&tauri::tray::TrayIconId::new(TRAY_ID)) else {
        return Err("no tray is installed; nothing to re-label".to_string());
    };
    let menu = build_menu(app, labels)?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(labels.tooltip))
        .map_err(|e| e.to_string())?;
    tracing::info!(
        target: "amos::tray",
        locale = locale.as_str(),
        "tray re-labelled in the shell's language"
    );
    Ok(locale)
}

/// Non-desktop: no tray exists, so nothing to re-label — and the caller's contract is the same
/// shape `menu::set_locale`'s twin has (it is a success that did nothing, not a failure).
#[cfg(not(desktop))]
pub fn set_locale(_app: &tauri::AppHandle, raw: &str) -> Result<TrayLocale, String> {
    Ok(TrayLocale::parse(Some(raw)))
}

/// Non-desktop (Android / iOS): there is no tray concept, so there is nothing to install —
/// and the boot path stays one line on every target, the shape `menu::install`'s twin uses.
#[cfg(not(desktop))]
pub fn install(_app: &tauri::AppHandle) -> Result<(), String> {
    tracing::debug!(
        target: "amos::tray",
        "the system tray installs on desktop targets only; this build compiles but skips"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Every declared id resolves to an action.
    ///
    /// Set equality, not a count: a floor (`>= 2`) cannot see a rename that drops one row
    /// and keeps the other, which is the one-name loss this has to catch. The named
    /// witnesses below pin the two ids by name so a wholesale rewrite of `ALL_IDS` cannot
    /// pass by agreeing with itself.
    #[test]
    fn every_declared_id_has_an_action() {
        let resolvable: HashSet<&str> = ALL_IDS
            .iter()
            .copied()
            .filter(|id| tray_action(id).is_some())
            .collect();
        let declared: HashSet<&str> = ALL_IDS.iter().copied().collect();
        assert_eq!(
            resolvable, declared,
            "a declared tray id resolves to no action — its row would draw and do nothing"
        );

        assert_eq!(tray_action(SHOW_DESKTOP), Some(TrayAction::ShowDesktop));
        assert_eq!(tray_action(QUIT), Some(TrayAction::Quit));
    }

    /// The other direction: no action exists that no row can reach.
    ///
    /// `TrayAction` has two variants and `ALL_IDS` two entries; this is the assertion that
    /// ties the enum to the table, so adding a variant without a row fails here rather than
    /// shipping an arm nothing can reach.
    #[test]
    fn no_action_exists_without_a_declared_id() {
        let reachable: HashSet<TrayAction> =
            ALL_IDS.iter().filter_map(|id| tray_action(id)).collect();
        assert_eq!(
            reachable.len(),
            2,
            "an action exists that no declared id can reach"
        );
        assert!(reachable.contains(&TrayAction::ShowDesktop));
        assert!(reachable.contains(&TrayAction::Quit));
    }

    /// An unknown id is not guessed at — it answers `None` so the handler can report it.
    #[test]
    fn an_unknown_id_has_no_action() {
        assert_eq!(tray_action("tray.something-else"), None);
        assert_eq!(tray_action(""), None);
        // The menu bar's own ids are a *different* namespace: `menu.quit` must not be
        // mistaken for the tray's quit, or a stray event would quit the app from a row
        // that was never ours.
        assert_eq!(tray_action("menu.quit"), None);
    }

    /// The built menu agrees with the declared ids, row for row.
    ///
    /// This is the *accepting* case, and on its own it is worth nothing: a comparison that
    /// always answered "no problems" would pass it. It is here as the paired half of the two
    /// rejections below — the three together say the instrument can tell them apart.
    #[test]
    fn the_built_rows_match_the_declared_ids() {
        let rows: Vec<String> = ALL_IDS.iter().map(|id| (*id).to_string()).collect();
        let (missing, undeclared) = compare_rows(&rows);
        assert!(missing.is_empty(), "nothing should be missing: {missing:?}");
        assert!(
            undeclared.is_empty(),
            "nothing should be undeclared: {undeclared:?}"
        );
    }

    /// A row that was built but dropped on the way to the menu is named.
    ///
    /// The direction that catches REQ-A423: `menu.quit` had a handler and no row, so pressing
    /// "Quit" was not possible. Asserted as the **exact id**, not `!is_empty()` — any
    /// difference reports *something*, and the thing a reader needs is which row went missing.
    #[test]
    fn a_lost_row_is_reported_by_name() {
        let rows = vec![SHOW_DESKTOP.to_string()];
        let (missing, undeclared) = compare_rows(&rows);
        assert_eq!(missing, vec![QUIT.to_string()]);
        assert!(
            undeclared.is_empty(),
            "nothing is undeclared: {undeclared:?}"
        );
    }

    /// A row nobody declared is named too — the other direction, and a different defect: it
    /// draws, looks live, and fires into [`tray_action`]'s `None` arm.
    #[test]
    fn a_stray_row_is_reported_by_name() {
        let rows = vec![
            SHOW_DESKTOP.to_string(),
            QUIT.to_string(),
            "tray.extra".to_string(),
        ];
        let (missing, undeclared) = compare_rows(&rows);
        assert!(missing.is_empty(), "nothing is missing: {missing:?}");
        assert_eq!(undeclared, vec!["tray.extra".to_string()]);
    }

    /// An empty menu is *not* "fine" — every declared row is missing.
    ///
    /// The shape a silently-failed build would leave behind, and the one a comparison written
    /// as "flag the rows I recognise" would call clean.
    #[test]
    fn an_empty_menu_reports_every_declared_row_missing() {
        let (missing, undeclared) = compare_rows(&[]);
        assert_eq!(
            missing.len(),
            ALL_IDS.len(),
            "every row is missing: {missing:?}"
        );
        assert!(undeclared.is_empty());
    }

    /// Both languages fill every row, and the two rows that are *actions* read differently
    /// in each — the `menu.rs` parity rule, applied to the tray.
    ///
    /// `tooltip` is excluded **by name**: it is the product name, which is the same string
    /// in both languages on purpose (the menu bar's `app_menu` is `"Amos"` twice for the
    /// same reason). Excluding it here is a decision about this one field, not a licence for
    /// the next one.
    #[test]
    fn tray_rows_are_translated() {
        let zh = labels_for(TrayLocale::Zh);
        let en = labels_for(TrayLocale::En);
        for (field, zh_text, en_text) in [
            ("show_desktop", zh.show_desktop, en.show_desktop),
            ("quit", zh.quit, en.quit),
        ] {
            assert!(!zh_text.trim().is_empty(), "{field}: the zh label is empty");
            assert!(!en_text.trim().is_empty(), "{field}: the en label is empty");
            assert_ne!(
                zh_text, en_text,
                "{field}: the zh and en labels are identical"
            );
        }
        assert_eq!(zh.tooltip, en.tooltip, "the tooltip is the product name");
        assert!(!zh.tooltip.trim().is_empty(), "the tooltip is empty");
    }

    /// The locale parse rule: `en` is English, everything else (including nothing at all)
    /// is Chinese — the shell's default.
    #[test]
    fn the_locale_defaults_to_chinese() {
        assert_eq!(TrayLocale::parse(Some("en")), TrayLocale::En);
        assert_eq!(TrayLocale::parse(Some("zh")), TrayLocale::Zh);
        assert_eq!(TrayLocale::parse(None), TrayLocale::Zh);
        assert_eq!(TrayLocale::parse(Some("fr")), TrayLocale::Zh);
        assert_eq!(TrayLocale::Zh.as_str(), "zh");
        assert_eq!(TrayLocale::En.as_str(), "en");
    }

    /// The tooltip is a name a macOS menu-bar item can actually hold.
    ///
    /// Not decoration: an over-long tooltip is elided by the OS, and the elision is the only
    /// place the product name would appear. The bound is the menu bar's own
    /// (`wm::MAX_SHELL_TITLE_CHARS`) rather than a new number.
    #[test]
    fn the_tooltip_fits_the_menu_bar() {
        for locale in [TrayLocale::Zh, TrayLocale::En] {
            let label = labels_for(locale).tooltip;
            assert!(
                label.chars().count() <= crate::wm::MAX_SHELL_TITLE_CHARS,
                "{:?}: the tooltip is longer than a menu-bar item can show",
                locale
            );
        }
    }
}
