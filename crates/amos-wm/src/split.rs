//! **Split-screen session** domain: binds two [`WindowId`]s to the two panes of a
//! [`layout::split_panes`] layout and tracks the divider.
//!
//! `amos-wm`'s [`crate::WindowManager`] owns *which window is visible/focused*;
//! this module owns *where two of them sit* in a split. It is pure `std` and
//! transport-agnostic — the `amos-tauri` host reads [`SplitScreen::bounds`] /
//! [`SplitScreen::bounds_for`] and applies the real backend geometry.

use crate::layout::{split_panes, Bounds, Size, SplitAxis};
use crate::WindowId;

/// A two-window split-screen session over one screen rect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitScreen {
    /// Occupies the first pane (left / top).
    pub primary: WindowId,
    /// Occupies the second pane (right / bottom).
    pub secondary: WindowId,
    /// Split orientation.
    pub axis: SplitAxis,
    /// The full screen the two panes share.
    pub screen: Bounds,
    /// Divider width between the panes.
    pub gap: u32,
    /// Minimum size every pane must honour.
    pub min: Size,
    /// First pane's share of the usable extent (1..=99).
    percent: u32,
}

impl SplitScreen {
    /// Build a session at a 50/50 divider. Returns `None` if the two minimum panes
    /// + gap cannot fit `screen` (honest — never a zero/negative pane).
    pub fn new(
        primary: WindowId,
        secondary: WindowId,
        screen: Bounds,
        axis: SplitAxis,
        gap: u32,
        min: Size,
    ) -> Option<Self> {
        let s = Self {
            primary,
            secondary,
            axis,
            screen,
            gap,
            min,
            percent: 50,
        };
        s.fits().then_some(s)
    }

    /// Whether the current divider + min + gap fit `screen`.
    pub fn fits(&self) -> bool {
        split_panes(self.screen, self.axis, self.gap, self.percent, self.min).is_some()
    }

    /// Both pane rects (first pane = `primary`).
    pub fn bounds(&self) -> Option<(Bounds, Bounds)> {
        split_panes(self.screen, self.axis, self.gap, self.percent, self.min)
    }

    /// The pane rect occupied by `id`, if `id` is in this split.
    pub fn bounds_for(&self, id: WindowId) -> Option<Bounds> {
        let (a, b) = self.bounds()?;
        if id == self.primary {
            Some(a)
        } else if id == self.secondary {
            Some(b)
        } else {
            None
        }
    }

    /// Set the divider so the first pane takes `percent` (1..=99). Returns whether
    /// the change was applied. A percent whose requested share would leave either
    /// pane below `min` is **rejected** (never silently clamped), so `percent()`
    /// always matches the actual divider geometry.
    pub fn resize_to(&mut self, percent: u32) -> bool {
        if !(1..=99).contains(&percent) {
            return false;
        }
        if !Self::percent_feasible(self.screen, self.axis, self.gap, percent, self.min) {
            return false;
        }
        self.percent = percent;
        true
    }

    /// Is `percent` a share that (without clamping) leaves both panes ≥ `min`?
    fn percent_feasible(
        screen: Bounds,
        axis: SplitAxis,
        gap: u32,
        percent: u32,
        min: Size,
    ) -> bool {
        let extent = match axis {
            SplitAxis::Vertical => u64::from(screen.width),
            SplitAxis::Horizontal => u64::from(screen.height),
        };
        let gap = u64::from(gap);
        let usable = extent.saturating_sub(gap);
        let first = usable * u64::from(percent) / 100;
        let second = usable - first;
        let min_len = match axis {
            SplitAxis::Vertical => u64::from(min.width.max(1)),
            SplitAxis::Horizontal => u64::from(min.height.max(1)),
        };
        first >= min_len && second >= min_len
    }

    /// Move the divider by `delta` percent points toward the first pane when
    /// negative, the second when positive. Clamped to valid; returns whether it
    /// changed.
    pub fn resize_by(&mut self, delta: i32) -> bool {
        let next = (self.percent as i32 + delta).clamp(1, 99) as u32;
        next != self.percent && self.resize_to(next)
    }

    /// Swap which window is in the first (primary) pane.
    pub fn swap(&mut self) {
        std::mem::swap(&mut self.primary, &mut self.secondary);
    }

    /// Replace the screen rect (e.g. on rotation/resize). Applied **only** if the
    /// current divider percent is still feasible (no pane would drop below `min` on
    /// the new screen); otherwise the old screen is kept and `false` is returned.
    /// This mirrors `resize_to`'s honesty — a new screen is never accepted by
    /// silently clamping the divider ratio.
    pub fn set_screen(&mut self, screen: Bounds) -> bool {
        if !Self::percent_feasible(screen, self.axis, self.gap, self.percent, self.min) {
            return false;
        }
        self.screen = screen;
        true
    }

    /// Is `id` one of the two split windows?
    pub fn contains(&self, id: WindowId) -> bool {
        id == self.primary || id == self.secondary
    }

    /// The partner window of `id` in the split, if any.
    pub fn other(&self, id: WindowId) -> Option<WindowId> {
        if id == self.primary {
            Some(self.secondary)
        } else if id == self.secondary {
            Some(self.primary)
        } else {
            None
        }
    }

    /// Current divider share (first pane percent).
    pub fn percent(&self) -> u32 {
        self.percent
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> Bounds {
        Bounds::new(0, 0, 1000, 600)
    }

    fn split() -> SplitScreen {
        SplitScreen::new(
            WindowId(1),
            WindowId(2),
            screen(),
            SplitAxis::Vertical,
            8,
            Size::new(300, 200),
        )
        .expect("fits the test screen")
    }

    #[test]
    fn new_builds_when_two_min_panes_fit() {
        let s = split();
        assert_eq!(s.percent(), 50);
        let (l, r) = s.bounds().unwrap();
        assert!(l.width >= 300 && r.width >= 300);
        assert!(l.height >= 200 && r.height >= 200);
    }

    #[test]
    fn new_is_none_when_screen_too_small() {
        let tiny = Bounds::new(0, 0, 200, 100);
        assert!(SplitScreen::new(
            WindowId(1),
            WindowId(2),
            tiny,
            SplitAxis::Vertical,
            8,
            Size::new(120, 80)
        )
        .is_none());
    }

    #[test]
    fn bounds_for_returns_the_right_pane_per_window() {
        let s = split();
        let (l, r) = s.bounds().unwrap();
        assert_eq!(s.bounds_for(WindowId(1)), Some(l));
        assert_eq!(s.bounds_for(WindowId(2)), Some(r));
        assert_eq!(s.bounds_for(WindowId(99)), None, "foreign id has no pane");
    }

    #[test]
    fn resize_moves_the_divider_and_keeps_it_valid() {
        let mut s = split(); // screen 1000 wide, gap 8 → usable 992, min width 300
        assert_eq!(s.percent(), 50);

        assert!(s.resize_to(35));
        assert_eq!(s.percent(), 35);
        let (l, r) = s.bounds().unwrap();
        assert!(l.width >= 300 && r.width >= 300);
        assert_eq!(u64::from(l.width) + u64::from(r.width) + 8, 1000);

        // Invalid / infeasible values are rejected and leave the divider unchanged.
        assert!(!s.resize_to(0));
        assert!(!s.resize_to(100));
        assert!(!s.resize_to(10), "10% (~99px) < 300px min → not applied");
        assert!(!s.resize_to(90), "90% leaves the other pane < 300px");
        assert_eq!(
            s.percent(),
            35,
            "rejected requests must not move the divider"
        );

        // Relative moves work and clamp at the feasible band.
        assert!(s.resize_by(15));
        assert_eq!(s.percent(), 50);
        assert!(!s.resize_by(-45), "-45 → 5% is below min");
        assert_eq!(s.percent(), 50);
    }

    #[test]
    fn swap_flips_which_window_is_primary() {
        let mut s = split();
        let (l_before, r_before) = s.bounds().unwrap();
        s.swap();
        let (l_after, r_after) = s.bounds().unwrap();
        // Geometry is identical; only the window→pane mapping flips.
        assert_eq!(l_before, l_after);
        assert_eq!(r_before, r_after);
        assert_eq!(s.bounds_for(WindowId(1)), Some(r_before));
        assert_eq!(s.bounds_for(WindowId(2)), Some(l_before));
        assert_eq!(s.other(WindowId(1)), Some(WindowId(2)));
    }

    #[test]
    fn set_screen_is_only_applied_when_it_still_fits() {
        let mut s = split();
        let original = s.screen;
        let small = Bounds::new(0, 0, 200, 100);
        assert!(!s.set_screen(small), "too small to hold two min panes");
        assert_eq!(s.screen, original, "old screen retained");

        let tall = Bounds::new(0, 0, 1000, 1000);
        assert!(s.set_screen(tall));
        assert_eq!(s.screen, tall);
        assert!(s.fits());
    }

    #[test]
    fn set_screen_never_silently_clamps_the_divider() {
        // Move the divider to 35% (feasible on the 1000px-wide screen: 0.35×992 ≥ 300).
        let mut s = split();
        assert!(s.resize_to(35));
        let original = s.screen;

        // A 800px-wide screen: usable 792, 35% ≈ 277 < 300px min → must be rejected,
        // keeping the old screen so `percent()` never disagrees with the geometry.
        let narrow = Bounds::new(0, 0, 800, 600);
        assert!(
            !s.set_screen(narrow),
            "35% is not feasible on the narrower screen"
        );
        assert_eq!(s.screen, original, "old screen + divider preserved");

        // A 900px-wide screen (usable 892, 35% ≈ 312 ≥ 300) is feasible → applied.
        let ok = Bounds::new(0, 0, 900, 600);
        assert!(s.set_screen(ok));
        assert_eq!(s.screen, ok);
    }
}
