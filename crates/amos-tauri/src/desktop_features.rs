//! `desktop_features` — the two documented desktop-shell switches, resolved **host-side**
//! (REQ-A287).
//!
//! `docs/ENV_VARIABLES.md` documents `AMOS_DESKTOP_SHORTCUTS` and
//! `AMOS_DOCK_CONTEXT_MENU` as production switches over two shell capabilities:
//! the window shortcuts (`⌘W` / `⌘M` / `⌘H` / `⌘,`) and the Dock's right-click menu.
//! Until this module existed, the **frontend** read them itself:
//!
//! ```text
//! import.meta.env.AMOS_DESKTOP_SHORTCUTS   // Vite only inlines VITE_* (no envPrefix here)
//! process.env.AMOS_DESKTOP_SHORTCUTS       // there is no `process` global in a WebView
//! ```
//!
//! Neither exists in the shipped page, so both switches were **documented but
//! unreachable** — while the unit test covering them passed (under `bun`, where
//! `process.env` is real). That is the "says something it cannot do" shape this repo
//! refuses, so the reads moved to where an environment actually exists: the host. The
//! UI asks once at boot (`desktop_features_disabled`, called from `Shell.onMount` next
//! to the layout snapshot) and caches the answer in `lib/desktopFeatures.ts` — the same
//! path the form factor already takes (`AMOS_FORM_FACTOR` → `LayoutSnapshot.form`).
//!
//! Parsing is a **pure function** ([`disabled_for`]): env-mutating tests are a race in a
//! parallel runner, so every rule below is tested through a lookup closure, and the only
//! non-pure code is the thin [`disabled_from_env`] wrapper.

/// Env var that switches the desktop shell's keyboard shortcuts (`⌘W`/`⌘M`/`⌘H`/`⌘,`).
pub const SHORTCUTS_ENV: &str = "AMOS_DESKTOP_SHORTCUTS";
/// Env var that switches the Dock's right-click menu.
pub const DOCK_CONTEXT_MENU_ENV: &str = "AMOS_DOCK_CONTEXT_MENU";

/// Longest env value this host will parse. Values are a word or a short comma list; past
/// the bound the value is treated as unreadable (⇒ the capability stays **enabled**, the
/// documented default) instead of being split into an unbounded number of items (Power of
/// 10 #2). The bound is deliberately far above any real use, so it can only fire on a
/// hostile/broken environment.
pub const MAX_ENV_VALUE_BYTES: usize = 4096;

/// The capabilities the two switches cover. The wire key is exactly the string the
/// frontend passes to `isDesktopFeatureEnabled`, so host and UI cannot drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopFeature {
    /// Window shortcuts (`⌘W` / `⌘M` / `⌘H` / `⌘,`).
    Shortcuts,
    /// Dock right-click (context) menu.
    DockContextMenu,
}

impl DesktopFeature {
    /// Every capability, in wire order.
    pub const ALL: [DesktopFeature; 2] =
        [DesktopFeature::Shortcuts, DesktopFeature::DockContextMenu];

    /// The key shared with the UI (`lib/desktopFeatures.ts`).
    pub fn key(self) -> &'static str {
        match self {
            DesktopFeature::Shortcuts => "shortcuts",
            DesktopFeature::DockContextMenu => "dock-context-menu",
        }
    }

    /// The env var that switches this capability.
    pub fn env_var(self) -> &'static str {
        match self {
            DesktopFeature::Shortcuts => SHORTCUTS_ENV,
            DesktopFeature::DockContextMenu => DOCK_CONTEXT_MENU_ENV,
        }
    }
}

/// Does the env value `raw` switch `feature` **off**?
///
/// Two accepted spellings, both mirroring the rule the UI documented before this moved
/// host-side (and still the contract, now that the host is the reader):
///   * `disabled` (any case, trimmed) — switches **this** capability off;
///   * a comma-separated list containing **this capability's own key** (`shortcuts` in
///     `AMOS_DESKTOP_SHORTCUTS`, `dock-context-menu` in `AMOS_DOCK_CONTEXT_MENU`).
///     Each variable owns exactly one capability, so a key belonging to the *other*
///     one has no effect here — [`stray_vars`] is what reports that mistake instead of
///     letting it pass silently.
///
/// Anything else (`enabled`, empty, an unknown word, an over-long value) leaves the
/// capability **on**: the default is "declared capabilities are on", so a typo can only
/// fail to disable something, never silently hide a capability nobody asked to hide.
/// `None`/blank means "the variable is not set at all".
pub fn disabled_for(feature: DesktopFeature, raw: Option<&str>) -> bool {
    let Some(raw) = raw else { return false };
    if raw.len() > MAX_ENV_VALUE_BYTES {
        return false;
    }
    let value = raw.trim();
    if value.is_empty() {
        return false;
    }
    if value.eq_ignore_ascii_case("disabled") {
        return true;
    }
    items(value).any(|item| item.eq_ignore_ascii_case(feature.key()))
}

/// The comma-separated items of an already-bounded value (trimmed, empties dropped).
fn items(value: &str) -> impl Iterator<Item = &str> {
    value.split(',').map(str::trim).filter(|s| !s.is_empty())
}

/// Variables whose value names a capability they do **not** own —
/// `AMOS_DESKTOP_SHORTCUTS=dock-context-menu` is the shape. Owned keys take effect;
/// a stray one is ignored, so the boot path logs this instead of leaving an operator
/// to wonder why the other capability stayed on.
pub fn stray_vars<F>(lookup: F) -> Vec<&'static str>
where
    F: Fn(&str) -> Option<String>,
{
    DesktopFeature::ALL
        .into_iter()
        .filter(|owner| {
            let Some(raw) = lookup(owner.env_var()) else {
                return false;
            };
            if raw.len() > MAX_ENV_VALUE_BYTES || raw.trim().eq_ignore_ascii_case("disabled") {
                return false;
            }
            DesktopFeature::ALL
                .into_iter()
                .filter(|other| other.key() != owner.key())
                .any(|other| items(raw.trim()).any(|i| i.eq_ignore_ascii_case(other.key())))
        })
        .map(DesktopFeature::env_var)
        .collect()
}

/// Resolve every disabled capability using `lookup(env_var)`.
///
/// The lookup form is what makes this testable without touching the process environment:
/// production passes [`std::env::var`], tests pass a closure.
pub fn disabled_from<F>(lookup: F) -> Vec<&'static str>
where
    F: Fn(&str) -> Option<String>,
{
    DesktopFeature::ALL
        .into_iter()
        .filter(|f| disabled_for(*f, lookup(f.env_var()).as_deref()))
        .map(DesktopFeature::key)
        .collect()
}

/// Resolve every disabled capability from the process environment.
pub fn disabled_from_env() -> Vec<&'static str> {
    // `.ok()`: a non-unicode value is "not readable" ⇒ the capability stays on
    // (documented default), the same direction every other unreadable value takes.
    disabled_from(|key| std::env::var(key).ok())
}

/// The capabilities the operator switched off with `AMOS_DESKTOP_SHORTCUTS` /
/// `AMOS_DOCK_CONTEXT_MENU`; empty means "all declared capabilities are on".
///
/// The UI calls this **once** at boot and caches the answer. A missing bridge (or a failed
/// call) leaves the UI's default in place — the same default this returns for an unset
/// environment — and `lib/backend` records the failure in the diagnostics ledger. Queries
/// that happen *before* the boot answer lands also see the default; the two capabilities
/// only gate user-gesture handlers (a key chord, a right-click), so the window in which
/// that could matter ends before any gesture can occur.
#[tauri::command]
pub fn desktop_features_disabled() -> Vec<String> {
    disabled_from_env().into_iter().map(String::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Resolve against a fake environment (no process-env mutation, so this is safe in a
    /// parallel test runner).
    fn from_pairs(pairs: &[(&str, &str)]) -> Vec<&'static str> {
        disabled_from(|key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
        })
    }

    #[test]
    fn an_unset_environment_leaves_every_capability_on() {
        assert!(from_pairs(&[]).is_empty());
        for f in DesktopFeature::ALL {
            assert!(!disabled_for(f, None), "{f:?} must default to enabled");
        }
    }

    #[test]
    fn the_word_disabled_switches_off_only_its_own_capability() {
        assert_eq!(
            from_pairs(&[(SHORTCUTS_ENV, "disabled")]),
            vec!["shortcuts"]
        );
        assert_eq!(
            from_pairs(&[(DOCK_CONTEXT_MENU_ENV, "disabled")]),
            vec!["dock-context-menu"]
        );
        // Both spelled the same way still resolve independently.
        assert_eq!(
            from_pairs(&[
                (SHORTCUTS_ENV, "disabled"),
                (DOCK_CONTEXT_MENU_ENV, "disabled")
            ]),
            vec!["shortcuts", "dock-context-menu"]
        );
    }

    #[test]
    fn disabled_is_case_and_whitespace_insensitive() {
        for raw in ["DISABLED", "disabled", " Disabled ", "dIsAbLeD"] {
            assert!(
                disabled_for(DesktopFeature::Shortcuts, Some(raw)),
                "{raw} must disable"
            );
        }
    }

    #[test]
    fn a_comma_list_disables_only_the_key_its_variable_owns() {
        // `AMOS_DESKTOP_SHORTCUTS` owns `shortcuts`: listing it works …
        assert!(disabled_for(DesktopFeature::Shortcuts, Some("shortcuts")));
        // … and the dock key in *this* variable does nothing here (each variable owns one
        // capability) — `stray_vars` is what reports that mistake.
        assert!(!disabled_for(
            DesktopFeature::Shortcuts,
            Some("dock-context-menu")
        ));
        assert!(disabled_for(
            DesktopFeature::DockContextMenu,
            Some("dock-context-menu")
        ));
        // Padding and mixed case inside the list are tolerated.
        assert!(disabled_for(
            DesktopFeature::Shortcuts,
            Some(" shortcuts , other ")
        ));
        assert!(disabled_for(DesktopFeature::Shortcuts, Some("SHORTCUTS")));
        // The list form reaches exactly one capability per variable.
        assert_eq!(
            from_pairs(&[(SHORTCUTS_ENV, "shortcuts")]),
            vec!["shortcuts"]
        );
        assert_eq!(
            from_pairs(&[(DOCK_CONTEXT_MENU_ENV, "dock-context-menu")]),
            vec!["dock-context-menu"]
        );
    }

    #[test]
    fn a_key_named_in_the_wrong_variable_is_reported_not_silently_dropped() {
        // The mistake an operator can actually make: naming the *other* capability in
        // this variable. It stays off-effect (each variable owns one capability) but the
        // boot path can see and log it instead of the capability simply never moving.
        assert_eq!(
            from_pairs(&[(SHORTCUTS_ENV, "dock-context-menu")]),
            Vec::<&str>::new()
        );
        assert_eq!(
            stray_vars(|key| (key == SHORTCUTS_ENV).then(|| "dock-context-menu".to_string())),
            vec![SHORTCUTS_ENV]
        );
        // Owned keys, the `disabled` shorthand and an unset environment are not stray.
        assert!(
            stray_vars(|key| (key == SHORTCUTS_ENV).then(|| "shortcuts".to_string())).is_empty()
        );
        assert!(
            stray_vars(|key| (key == SHORTCUTS_ENV).then(|| "disabled".to_string())).is_empty()
        );
        assert!(stray_vars(|_| None).is_empty());
    }

    #[test]
    fn enabled_and_unrecognised_values_never_disable_anything() {
        // The documented default is "on", so a typo must fail *open*, not closed.
        for raw in ["enabled", "", "   ", "true", "0", "no", "shortcut", "dock"] {
            for f in DesktopFeature::ALL {
                assert!(
                    !disabled_for(f, Some(raw)),
                    "{raw:?} must not disable {f:?}"
                );
            }
        }
        assert!(from_pairs(&[
            (SHORTCUTS_ENV, "enabled"),
            (DOCK_CONTEXT_MENU_ENV, "nonsense")
        ])
        .is_empty());
    }

    #[test]
    fn an_over_long_value_is_refused_rather_than_half_parsed() {
        // Past the bound the value is not read at all ⇒ the capability stays on
        // (documented), and a hostile value cannot make the host split megabytes of items.
        let huge = "a".repeat(MAX_ENV_VALUE_BYTES + 1);
        assert!(!disabled_for(DesktopFeature::Shortcuts, Some(&huge)));
        // The bound is inclusive, and it is pinned from *both* sides: a value of exactly
        // MAX_ENV_VALUE_BYTES is still parsed …
        let mut at_limit = String::from("shortcuts");
        while at_limit.len() < MAX_ENV_VALUE_BYTES {
            at_limit.push(',');
        }
        assert_eq!(at_limit.len(), MAX_ENV_VALUE_BYTES);
        assert!(disabled_for(DesktopFeature::Shortcuts, Some(&at_limit)));
        // … and the same value one byte longer is refused (so the boundary is exactly here,
        // not one item either way).
        let over = format!("{at_limit},");
        assert_eq!(over.len(), MAX_ENV_VALUE_BYTES + 1);
        assert!(!disabled_for(DesktopFeature::Shortcuts, Some(&over)));
    }

    #[test]
    fn the_wire_keys_are_the_strings_the_ui_uses() {
        // Pinned because the UI matches these exact strings (`lib/desktopFeatures.ts`).
        assert_eq!(DesktopFeature::Shortcuts.key(), "shortcuts");
        assert_eq!(DesktopFeature::DockContextMenu.key(), "dock-context-menu");
        assert_eq!(
            DesktopFeature::Shortcuts.env_var(),
            "AMOS_DESKTOP_SHORTCUTS"
        );
        assert_eq!(
            DesktopFeature::DockContextMenu.env_var(),
            "AMOS_DOCK_CONTEXT_MENU"
        );
    }
}
