//! Lifecycle spec types: [`AppId`] and the per-process [`AppState`] importance
//! ladder + its stable keys.

use std::fmt;

/// Identity of one tracked app / process ("com.amos.photos", a System-UI app id,
/// a daemon…). Kept as a newtype so ids are not confused with arbitrary strings.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AppId(pub String);

impl AppId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AppId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for AppId {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

/// The lifecycle state (importance tier + whether work may run) of one process.
///
/// Reclaim policy built on the rank ladder (higher = *less* important = a better
/// victim): `Foreground` < `Visible` < `ForegroundService` are **protected** and
/// never reclaimed; `Background` may be frozen under pressure; `Cached` is the
/// tombstone — frozen with saved state, reclaimed first. `Stopped` is a dead
/// process that kept its saved state (so relaunch is cheap).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub enum AppState {
    /// The process the user is actively interacting with (top surface, focused).
    Foreground,
    /// Its surface is still visible (split / paused-overlay) but not focused.
    Visible,
    /// A user-perceptible background service (playing media / audio / a call).
    ForegroundService,
    /// Running but not visible; eligible to be frozen (cached) by the OS.
    Background,
    /// Frozen "tombstone": process alive, state saved, no work scheduled. The
    /// prime reclaim target under memory / energy pressure.
    Cached,
    /// Not running (killed); saved state retained so it can relaunch cheaply.
    #[default]
    Stopped,
}

impl AppState {
    /// Every state, ordered most → least important.
    pub const ALL: [AppState; 6] = [
        AppState::Foreground,
        AppState::Visible,
        AppState::ForegroundService,
        AppState::Background,
        AppState::Cached,
        AppState::Stopped,
    ];

    /// Importance rank: lower = more important (less likely to be killed).
    /// `Foreground`=0 … `Stopped`=5.
    pub fn rank(self) -> u8 {
        match self {
            AppState::Foreground => 0,
            AppState::Visible => 1,
            AppState::ForegroundService => 2,
            AppState::Background => 3,
            AppState::Cached => 4,
            AppState::Stopped => 5,
        }
    }

    /// Stable wire/UI key.
    pub fn key(self) -> &'static str {
        match self {
            AppState::Foreground => "foreground",
            AppState::Visible => "visible",
            AppState::ForegroundService => "foreground_service",
            AppState::Background => "background",
            AppState::Cached => "cached",
            AppState::Stopped => "stopped",
        }
    }

    /// Parse from a key; `None` for unknown strings.
    pub fn from_key(s: &str) -> Option<AppState> {
        match s {
            "foreground" => Some(AppState::Foreground),
            "visible" => Some(AppState::Visible),
            "foreground_service" => Some(AppState::ForegroundService),
            "background" => Some(AppState::Background),
            "cached" => Some(AppState::Cached),
            "stopped" => Some(AppState::Stopped),
            _ => None,
        }
    }

    /// Whether the process is actually running (anything but `Stopped`).
    pub fn is_running(self) -> bool {
        self != AppState::Stopped
    }

    /// Whether this state is a protected tier the reclaim policy must never pick.
    pub fn is_protected(self) -> bool {
        self.rank() < AppState::Background.rank()
    }

    /// Whether this is a running state the reclaim policy may pick under pressure
    /// (`Background` then `Cached`, in that preference order).
    pub fn is_reclaimable(self) -> bool {
        matches!(self, AppState::Background | AppState::Cached)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_and_default_is_stopped() {
        assert_eq!(AppState::default(), AppState::Stopped);
        for s in AppState::ALL {
            assert_eq!(AppState::from_key(s.key()), Some(s), "{s:?}");
        }
        assert_eq!(AppState::from_key("bogus"), None);
    }

    #[test]
    fn rank_orders_by_importance() {
        assert!(AppState::Foreground.rank() < AppState::Visible.rank());
        assert!(AppState::Visible.rank() < AppState::ForegroundService.rank());
        assert!(AppState::ForegroundService.rank() < AppState::Background.rank());
        assert!(AppState::Background.rank() < AppState::Cached.rank());
        assert!(AppState::Cached.rank() < AppState::Stopped.rank());
    }

    #[test]
    fn protected_vs_reclaimable() {
        for s in [
            AppState::Foreground,
            AppState::Visible,
            AppState::ForegroundService,
        ] {
            assert!(s.is_protected(), "{s:?}");
            assert!(!s.is_reclaimable());
        }
        assert!(!AppState::Stopped.is_running());
        for s in [AppState::Background, AppState::Cached] {
            assert!(!s.is_protected());
            assert!(s.is_reclaimable());
        }
    }
}
