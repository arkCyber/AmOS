//! Host seam: the *screen-state file* contract that connects the System UI host
//! (which owns the display and writes `on`/`off`) to the daemon energy beat
//! (which reads it so `screen_on = false` is real, not an env default).
//!
//! The path is taken from `AMOS_SCREEN_STATE_PATH` (unset ⇒ no file contract ⇒ a
//! caller falls back to its own default, e.g. the daemon's `AMOS_ENERGY_SCREEN_ON`
//! env). Content is the stable `on` | `off` key — one vocabulary across crates.

use std::path::PathBuf;

use crate::spec::ScreenState;

/// Env var naming the shared screen-state file. The daemon reads it every energy
/// tick; the System UI host writes it (atomically) when the shell idles/wakes.
pub const SCREEN_STATE_ENV: &str = "AMOS_SCREEN_STATE_PATH";

/// Resolve the shared screen-state path from the environment; `None` when unset
/// or blank (no file contract in effect).
pub fn screen_state_path() -> Option<PathBuf> {
    std::env::var(SCREEN_STATE_ENV)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Parse file/UI content into a [`ScreenState`]. Accepts the canonical `on`/`off`
/// plus the forgiving `1/0/true/false/yes/no` forms; anything else is `None`
/// (a caller treats an unreadable/foreign value conservatively, never guessing).
pub fn parse_screen_state(content: &str) -> Option<ScreenState> {
    match content.trim().to_ascii_lowercase().as_str() {
        "on" | "1" | "true" | "yes" => Some(ScreenState::On),
        "off" | "0" | "false" | "no" => Some(ScreenState::Off),
        _ => None,
    }
}

/// Read and parse a screen-state file. A missing/unreadable file yields `None`
/// (honest "unknown"), never a fabricated value.
pub fn read_screen_state_from(path: &std::path::Path) -> Option<ScreenState> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| parse_screen_state(&s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ScreenState;

    #[test]
    fn parse_accepts_canonical_and_forgiving_forms() {
        assert_eq!(parse_screen_state("on"), Some(ScreenState::On));
        assert_eq!(parse_screen_state("  OFF \n"), Some(ScreenState::Off));
        assert_eq!(parse_screen_state("1"), Some(ScreenState::On));
        assert_eq!(parse_screen_state("0"), Some(ScreenState::Off));
        assert_eq!(parse_screen_state("true"), Some(ScreenState::On));
        assert_eq!(parse_screen_state("yes"), Some(ScreenState::On));
        assert_eq!(parse_screen_state("no"), Some(ScreenState::Off));
        // Foreign / garbage → unknown, never guessed.
        assert_eq!(parse_screen_state(""), None);
        assert_eq!(parse_screen_state("lit"), None);
    }

    #[test]
    fn read_missing_file_is_none() {
        let p = std::path::Path::new("/nonexistent/amos-screen-state-0");
        assert_eq!(read_screen_state_from(p), None);
    }

    #[test]
    fn path_respects_blank_env() {
        // SAFETY: only AMOS_SCREEN_STATE_PATH is touched; no other test in this
        // binary sets it, so there is no cross-test env race (repo convention).
        std::env::set_var(SCREEN_STATE_ENV, "");
        assert_eq!(screen_state_path(), None);
        std::env::remove_var(SCREEN_STATE_ENV);
        assert_eq!(screen_state_path(), None);
    }
}
