//! `window_background.rs` — the colour of a window's own frame (REQ-A326).
//!
//! A WebView window is painted by the OS **before** the page has painted anything, and Tauri
//! only paints what the builder is told. Nothing was told (`tauri.conf.json` sets no
//! `backgroundColor`, and the runtime builder passed none either), so on a dark machine every
//! window that opens flashes the OS default — the light canvas — and then turns dark.
//!
//! The frontend already answers "which appearance is this?" and mirrors it into the shared
//! store (`lib/themeCore::writeStored` → `store_set`, key `amos-ui.theme`), so the host can
//! read it at window-creation time. That is what this module does, and it deliberately keeps
//! the decision **pure** (mode + OS answer → colour) so it can be tested without a window:
//!
//!   * an explicit `"dark"`/`"light"` is the user's decision — it wins, even when the OS
//!     disagrees (the same rule `lib/themeCore::resolveDark` applies in the frontend);
//!   * `"auto"` (or a store that has never been written) follows the **OS**, and when the OS
//!     does not answer either the answer is `None` — "say nothing", letting the OS default
//!     apply exactly as it does today. Guessing here would be a colour the user did not ask
//!     for.
//!
//! The shell window itself is declared in `tauri.conf.json`, which can only carry a fixed
//! colour, so it is out of reach of this module (see `docs/UI_APPLE_HIG_AUDIT.md` §15.3).

/// The frontend's persisted appearance key (`src/lib/themeCore.ts::THEME_KEY`, written through
/// `store_set`). One spelling, two consumers — a frontend test pins that they still agree.
pub const THEME_STORE_KEY: &str = "amos-ui.theme";

/// What the OS resolves to when neither the store nor the window tells us: say nothing.
const UNKNOWN: Option<(u8, u8, u8)> = None;

/// The dark frame colour: Tailwind `neutral-900`, the exact value the repo used as its
/// (dark-only) bootstrap background before REQ-A325 retired it.
const DARK: (u8, u8, u8) = (23, 23, 23);
/// The light frame colour: pure white, which is what the engine's light canvas is.
const LIGHT: (u8, u8, u8) = (255, 255, 255);

/// The RGB a new window should be painted with, or `None` to leave it to the OS.
pub fn window_background(mode: Option<&str>, os_dark: Option<bool>) -> Option<(u8, u8, u8)> {
    match mode {
        Some("dark") => Some(DARK),
        Some("light") => Some(LIGHT),
        // `"auto"`, an unknown value, or no stored value at all: the OS decides — if it said.
        _ => match os_dark {
            Some(true) => Some(DARK),
            Some(false) => Some(LIGHT),
            None => UNKNOWN,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_mode_wins_even_when_the_os_disagrees() {
        // The user's choice is the decision (frontend parity: `resolveDark`).
        assert_eq!(window_background(Some("dark"), Some(false)), Some(DARK));
        assert_eq!(window_background(Some("light"), Some(true)), Some(LIGHT));
        assert_eq!(window_background(Some("dark"), None), Some(DARK));
        assert_eq!(window_background(Some("light"), None), Some(LIGHT));
    }

    #[test]
    fn auto_follows_the_os_in_both_directions() {
        // REQ-A324's lesson, applied one layer down: both directions must work.
        assert_eq!(window_background(Some("auto"), Some(true)), Some(DARK));
        assert_eq!(window_background(Some("auto"), Some(false)), Some(LIGHT));
    }

    #[test]
    fn nothing_is_claimed_when_nothing_is_known() {
        // Never written, or an OS that does not answer: the OS default stands (today's
        // behaviour) rather than a colour the user did not ask for.
        assert_eq!(window_background(None, None), None);
        assert_eq!(window_background(Some("auto"), None), None);
        assert_eq!(window_background(Some("sepia"), None), None);
        // …and an unknown value does not lose the OS signal it *does* have.
        assert_eq!(window_background(Some("sepia"), Some(true)), Some(DARK));
    }

    #[test]
    fn the_dark_frame_is_the_value_the_repo_already_used() {
        // Continuity: this is Tailwind's `neutral-900`, the retired dark bootstrap colour.
        assert_eq!(DARK, (0x17, 0x17, 0x17));
        assert_eq!(THEME_STORE_KEY, "amos-ui.theme");
    }
}
