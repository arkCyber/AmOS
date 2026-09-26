//! Device-orientation policy: the **rotation lock** and forced-orientation
//! decision, and the mapping to Android's `ActivityInfo` requested-orientation
//! codes.
//!
//! A tablet needs to be told what to do about rotating: follow its sensor
//! (the default), freeze at the orientation it is in right now (the "rotation
//! lock" a Control-Centre tile toggles), or force a specific orientation
//! regardless of the sensor. This module is the platform-agnostic kernel for
//! that choice — pure `std`, no Android dependency, fully offline-testable.
//!
//! The host owns *applying* the choice: on Android, `amos-tauri` hands
//! [`RotationMode::requested_orientation`] to
//! `Activity#setRequestedOrientation`, whose argument is exactly the integer
//! this module returns. Declaring those integers here (rather than in the Kotlin
//! glue) keeps "which mode means what" a single, tested decision; the glue only
//! forwards the number.
//!
//! [`ScreenOrientation`] is the **measured** fact (what the display currently
//! is), derived from pixel dimensions the same way the shell's home grid is
//! (`crates/amos-tauri/frontend-ts/src/lib/formLayout.ts`): landscape iff
//! width > height, a square counts as portrait. `settled_orientation` joins the
//! two: what a mode would settle to given the current fact — the honest way to
//! ask "would this lock even change anything".

/// What the user asked the display to do about rotation.
///
/// The four modes are exhaustive on purpose: "auto" is a real, first-class
/// choice (not the absence of one), because *un*-locking is a thing the user
/// does and its effect must be expressible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RotationMode {
    /// Follow the sensor — no lock; the device rotates freely.
    Auto,
    /// Freeze at the orientation the display is in right now.
    Locked,
    /// Force portrait, regardless of the sensor.
    Portrait,
    /// Force landscape, regardless of the sensor.
    Landscape,
}

/// Every mode, in a stable order — the one list the UI and the wire both read.
pub const ROTATION_MODES: [RotationMode; 4] = [
    RotationMode::Auto,
    RotationMode::Locked,
    RotationMode::Portrait,
    RotationMode::Landscape,
];

/// Android `android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE`.
/// Mirrored (not imported): this crate is platform-agnostic and takes no Android
/// dependency. Pinned by a test.
pub const SCREEN_ORIENTATION_LANDSCAPE: i32 = 0;
/// Android `ActivityInfo.SCREEN_ORIENTATION_PORTRAIT`.
pub const SCREEN_ORIENTATION_PORTRAIT: i32 = 1;
/// Android `ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED` — "let the system
/// decide" (the default; follows the sensor / user setting).
pub const SCREEN_ORIENTATION_UNSPECIFIED: i32 = -1;
/// Android `ActivityInfo.SCREEN_ORIENTATION_LOCKED` (API 18+) — freeze at the
/// current orientation. `minSdk` is 26, so this is always available.
pub const SCREEN_ORIENTATION_LOCKED: i32 = 14;

impl RotationMode {
    /// Stable wire / store / UI key. The frontend mirrors this list
    /// (`lib/rotation.ts`) and a test binds the two.
    pub fn key(self) -> &'static str {
        match self {
            RotationMode::Auto => "auto",
            RotationMode::Locked => "locked",
            RotationMode::Portrait => "portrait",
            RotationMode::Landscape => "landscape",
        }
    }

    /// Parse a wire key. Unknown input is `None` — the caller decides the
    /// fallback (the store normaliser picks [`RotationMode::Auto`]).
    pub fn from_key(s: &str) -> Option<RotationMode> {
        match s {
            "auto" => Some(RotationMode::Auto),
            "locked" => Some(RotationMode::Locked),
            "portrait" => Some(RotationMode::Portrait),
            "landscape" => Some(RotationMode::Landscape),
            _ => None,
        }
    }

    /// Every mode, in the canonical order ([`ROTATION_MODES`]).
    pub fn all() -> [RotationMode; 4] {
        ROTATION_MODES
    }

    /// Whether this mode stops the display following its sensor. `Auto` is the
    /// only mode that does not — so `freezes()` is exactly "the rotation lock is
    /// on", from the user's point of view.
    pub fn freezes(self) -> bool {
        !matches!(self, RotationMode::Auto)
    }

    /// The Android `ActivityInfo` requested-orientation code this mode maps to.
    /// Handed verbatim to `Activity#setRequestedOrientation`.
    pub fn requested_orientation(self) -> i32 {
        match self {
            RotationMode::Auto => SCREEN_ORIENTATION_UNSPECIFIED,
            RotationMode::Locked => SCREEN_ORIENTATION_LOCKED,
            RotationMode::Portrait => SCREEN_ORIENTATION_PORTRAIT,
            RotationMode::Landscape => SCREEN_ORIENTATION_LANDSCAPE,
        }
    }

    /// What orientation this mode would settle to, given the display is
    /// **currently** `current`. `Auto` has no settled orientation (the sensor
    /// decides), so it answers `None` — the honest "I cannot say" rather than
    /// echoing the current value as if it were a decision.
    pub fn settled_orientation(self, current: ScreenOrientation) -> Option<ScreenOrientation> {
        match self {
            RotationMode::Auto => None,
            RotationMode::Locked => Some(current),
            RotationMode::Portrait => Some(ScreenOrientation::Portrait),
            RotationMode::Landscape => Some(ScreenOrientation::Landscape),
        }
    }
}

/// The **measured** orientation of the display — a fact, not a choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenOrientation {
    /// Taller than it is wide (a square counts as portrait).
    Portrait,
    /// Wider than it is tall.
    Landscape,
}

impl ScreenOrientation {
    /// Stable wire key.
    pub fn key(self) -> &'static str {
        match self {
            ScreenOrientation::Portrait => "portrait",
            ScreenOrientation::Landscape => "landscape",
        }
    }

    pub fn from_key(s: &str) -> Option<ScreenOrientation> {
        match s {
            "portrait" => Some(ScreenOrientation::Portrait),
            "landscape" => Some(ScreenOrientation::Landscape),
            _ => None,
        }
    }
}

/// The orientation of a `width`×`height` display. Landscape iff strictly wider
/// than tall; a **square** screen counts as portrait, matching
/// `formLayout.ts::homeGrid` (so the home grid and the orientation read never
/// disagree on a square viewport; the two rules are bound by
/// `frontend-ts/src/__tests__/declaredMirrors.test.ts`).
pub fn orientation_of(width: u32, height: u32) -> ScreenOrientation {
    if width > height {
        ScreenOrientation::Landscape
    } else {
        ScreenOrientation::Portrait
    }
}

/// Decode a persisted mode. Absent / unknown / garbage ⇒ [`RotationMode::Auto`]
/// — the un-locked default. A hand-edited store naming a mode that never existed
/// must not leave the display frozen in a way the user cannot see.
pub fn normalize(raw: Option<&str>) -> RotationMode {
    raw.and_then(RotationMode::from_key)
        .unwrap_or(RotationMode::Auto)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_for_every_mode() {
        for m in RotationMode::all() {
            assert_eq!(RotationMode::from_key(m.key()), Some(m));
        }
        assert_eq!(RotationMode::from_key("bogus"), None);
        assert_eq!(RotationMode::from_key(""), None);
    }

    #[test]
    fn the_mode_list_and_its_keys_agree() {
        let keys: Vec<&str> = RotationMode::all().iter().map(|m| m.key()).collect();
        assert_eq!(keys, vec!["auto", "locked", "portrait", "landscape"]);
    }

    #[test]
    fn only_auto_lets_the_sensor_drive() {
        assert!(!RotationMode::Auto.freezes());
        assert!(RotationMode::Locked.freezes());
        assert!(RotationMode::Portrait.freezes());
        assert!(RotationMode::Landscape.freezes());
    }

    #[test]
    fn requested_orientation_matches_the_android_constants() {
        // Pins the mirror against the real `ActivityInfo` values. If Android ever
        // renumbers these (it will not), this is the one failing test.
        assert_eq!(
            RotationMode::Auto.requested_orientation(),
            SCREEN_ORIENTATION_UNSPECIFIED
        );
        assert_eq!(
            RotationMode::Locked.requested_orientation(),
            SCREEN_ORIENTATION_LOCKED
        );
        assert_eq!(
            RotationMode::Portrait.requested_orientation(),
            SCREEN_ORIENTATION_PORTRAIT
        );
        assert_eq!(
            RotationMode::Landscape.requested_orientation(),
            SCREEN_ORIENTATION_LANDSCAPE
        );
        assert_eq!(SCREEN_ORIENTATION_UNSPECIFIED, -1);
        assert_eq!(SCREEN_ORIENTATION_LANDSCAPE, 0);
        assert_eq!(SCREEN_ORIENTATION_PORTRAIT, 1);
        assert_eq!(SCREEN_ORIENTATION_LOCKED, 14);
    }

    #[test]
    fn the_three_forcing_modes_map_to_distinct_codes() {
        let codes: Vec<i32> = [
            RotationMode::Auto,
            RotationMode::Locked,
            RotationMode::Portrait,
            RotationMode::Landscape,
        ]
        .iter()
        .map(|m| m.requested_orientation())
        .collect();
        // Auto(-1) / Locked(14) / Portrait(1) / Landscape(0) are four distinct
        // intents: no two modes may collapse onto one code.
        let mut sorted = codes.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            4,
            "two modes share a requested-orientation code"
        );
    }

    #[test]
    fn locked_settles_to_the_current_orientation_auto_has_none() {
        assert_eq!(
            RotationMode::Locked.settled_orientation(ScreenOrientation::Landscape),
            Some(ScreenOrientation::Landscape)
        );
        assert_eq!(
            RotationMode::Locked.settled_orientation(ScreenOrientation::Portrait),
            Some(ScreenOrientation::Portrait)
        );
        assert_eq!(
            RotationMode::Auto.settled_orientation(ScreenOrientation::Landscape),
            None,
            "auto does not decide an orientation — answering the current one would pretend it did"
        );
    }

    #[test]
    fn forced_modes_settle_regardless_of_the_current_fact() {
        assert_eq!(
            RotationMode::Portrait.settled_orientation(ScreenOrientation::Landscape),
            Some(ScreenOrientation::Portrait)
        );
        assert_eq!(
            RotationMode::Landscape.settled_orientation(ScreenOrientation::Portrait),
            Some(ScreenOrientation::Landscape)
        );
    }

    #[test]
    fn a_square_display_counts_as_portrait() {
        assert_eq!(orientation_of(800, 1200), ScreenOrientation::Portrait);
        assert_eq!(orientation_of(1200, 800), ScreenOrientation::Landscape);
        // Square is the tie: portrait, matching the home-grid rule.
        assert_eq!(orientation_of(1000, 1000), ScreenOrientation::Portrait);
    }

    #[test]
    fn orientation_keys_round_trip() {
        for o in [ScreenOrientation::Portrait, ScreenOrientation::Landscape] {
            assert_eq!(ScreenOrientation::from_key(o.key()), Some(o));
        }
        assert_eq!(ScreenOrientation::from_key("sideways"), None);
    }

    #[test]
    fn normalize_defaults_to_auto_on_absent_or_unknown() {
        assert_eq!(normalize(None), RotationMode::Auto);
        assert_eq!(normalize(Some("bogus")), RotationMode::Auto);
        assert_eq!(normalize(Some("")), RotationMode::Auto);
        assert_eq!(normalize(Some("locked")), RotationMode::Locked);
        assert_eq!(normalize(Some("landscape")), RotationMode::Landscape);
    }
}
