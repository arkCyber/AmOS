//! Core display state vocabulary: whether the screen is on, and what changed
//! after a controller call.

/// Whether the interactive display is currently on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenState {
    /// On: the user is (or could be) looking at the screen.
    On,
    /// Off: auto-idle or explicit sleep turned the display off (the host shows
    /// sleep/lock; the daemon treats this as `screen_on = false`).
    Off,
}

impl ScreenState {
    /// Stable wire / file / UI key — also the file content of the shared
    /// screen-state contract (`on` | `off`).
    pub fn key(self) -> &'static str {
        match self {
            ScreenState::On => "on",
            ScreenState::Off => "off",
        }
    }

    pub fn from_key(s: &str) -> Option<ScreenState> {
        match s {
            "on" => Some(ScreenState::On),
            "off" => Some(ScreenState::Off),
            _ => None,
        }
    }
}

/// What one [`crate::ScreenController`] call changed on the screen state.
///
/// `None` means "nothing to do"; the `On`/`Off` variants report the *new* state
/// so a host can react exactly once (render the lock, or clear it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenChange {
    /// No state transition happened.
    None,
    /// The screen just turned on (woke).
    On,
    /// The screen just turned off (went to sleep).
    Off,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip() {
        for s in [ScreenState::On, ScreenState::Off] {
            assert_eq!(ScreenState::from_key(s.key()), Some(s));
        }
        assert_eq!(ScreenState::from_key("bogus"), None);
    }
}
