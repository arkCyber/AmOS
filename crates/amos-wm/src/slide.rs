//! **Slide Over** session domain: binds one [`WindowId`] to the floating panel of a
//! [`layout::slide_over_pane`] layout.
//!
//! Where [`crate::split::SplitScreen`] divides the screen between two cooperating
//! windows, this module places a **third** window that floats *over* the working
//! surface without resizing it. The panel has two states — shown and slid-off — and
//! the domain tracks both: *where* the panel rests is geometry
//! ([`SlideOver::bounds`]); *whether* it is currently revealed is [`SlideOver::is_hidden`].
//!
//! The off-screen position is deliberately **not** a second rect this module stores.
//! "Hidden" always means "translated fully past the trailing edge", so the only
//! honest way to express it is the flag plus the resting rect; a caller that wants a
//! translated frame composes the two with [`SlideOver::offscreen_bounds`], which reads
//! the same axis and the same rect [`SlideOver::bounds`] returned. Storing a second
//! rect would let the two drift.
//!
//! Like its siblings this is pure `std` and transport-agnostic: the `amos-tauri`
//! host reads [`SlideOver::bounds`] / [`SlideOver::offscreen_bounds`] and applies the
//! real backend geometry.

use crate::layout::{slide_over_pane, Bounds, Size, SplitAxis};
use crate::WindowId;

/// The share of the screen a fresh Slide Over panel takes (percent). A third is the
/// iPadOS-sized panel: wide enough to read a list, narrow enough to leave the app
/// behind it recognisable. A caller may move it within `resize_to`'s feasible band.
pub const DEFAULT_SLIDE_PERCENT: u32 = 33;

/// A one-window Slide Over panel over a screen rect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlideOver {
    /// The floating window.
    pub window: WindowId,
    /// The edge the panel hugs: `Vertical` ⇒ right, `Horizontal` ⇒ bottom.
    pub axis: SplitAxis,
    /// The full screen the panel floats over.
    pub screen: Bounds,
    /// Minimum size the panel must keep.
    pub min: Size,
    /// Inset from every screen edge.
    pub margin: u32,
    /// Panel's share of the screen's extent along `axis` (1..=99).
    percent: u32,
    /// Whether the panel is currently slid off its edge.
    hidden: bool,
}

impl SlideOver {
    /// Build a session at [`DEFAULT_SLIDE_PERCENT`], shown. Returns `None` when the
    /// inset rect cannot hold a `min` panel (honest — never a sliver).
    pub fn new(
        window: WindowId,
        screen: Bounds,
        axis: SplitAxis,
        margin: u32,
        min: Size,
    ) -> Option<Self> {
        let s = Self {
            window,
            axis,
            screen,
            min,
            margin,
            percent: DEFAULT_SLIDE_PERCENT,
            hidden: false,
        };
        s.fits().then_some(s)
    }

    /// Whether the current percent + margin + min fit `screen`.
    pub fn fits(&self) -> bool {
        slide_over_pane(self.screen, self.axis, self.percent, self.min, self.margin).is_some()
    }

    /// The panel's resting rect (its revealed position). `None` only if the screen
    /// has since become too small for it — see [`SlideOver::set_screen`], which
    /// refuses such a screen, so a live session's `bounds()` is always `Some`.
    pub fn bounds(&self) -> Option<Bounds> {
        slide_over_pane(self.screen, self.axis, self.percent, self.min, self.margin)
    }

    /// The rect the panel occupies when hidden: the resting rect moved so its leading
    /// edge sits on the **screen's** trailing edge (right for `Vertical`, bottom for
    /// `Horizontal`). Named against the screen, not against the panel's own extent:
    /// the panel is inset by `margin`, so translating by `width` alone would leave a
    /// margin-wide strip on screen. `None` when [`SlideOver::bounds`] is.
    pub fn offscreen_bounds(&self) -> Option<Bounds> {
        let b = self.bounds()?;
        Some(match self.axis {
            SplitAxis::Vertical => Bounds::new(self.screen.right() as i32, b.y, b.width, b.height),
            SplitAxis::Horizontal => {
                Bounds::new(b.x, self.screen.bottom() as i32, b.width, b.height)
            }
        })
    }

    /// The rect the panel actually occupies *now*, honouring [`SlideOver::is_hidden`].
    pub fn current_bounds(&self) -> Option<Bounds> {
        if self.hidden {
            self.offscreen_bounds()
        } else {
            self.bounds()
        }
    }

    /// Whether the panel is slid off its edge.
    pub fn is_hidden(&self) -> bool {
        self.hidden
    }

    /// Slide the panel off its edge. Idempotent.
    pub fn hide(&mut self) {
        self.hidden = true;
    }

    /// Reveal the panel. Idempotent.
    pub fn show(&mut self) {
        self.hidden = false;
    }

    /// Set the percent so the panel takes `percent` (1..=99). Returns whether the
    /// change was applied. A percent whose geometry the screen cannot honour (the
    /// panel would not fit even grown to `min`) is **rejected**, never silently
    /// clamped, so `percent()` always matches the actual geometry.
    pub fn resize_to(&mut self, percent: u32) -> bool {
        if !(1..=99).contains(&percent) {
            return false;
        }
        if slide_over_pane(self.screen, self.axis, percent, self.min, self.margin).is_none() {
            return false;
        }
        self.percent = percent;
        true
    }

    /// Move the panel's share by `delta` percent points; the result is clamped to the
    /// valid 1..=99 band, then `resize_to`'s feasibility rule applies. Returns whether
    /// it changed.
    pub fn resize_by(&mut self, delta: i32) -> bool {
        let next = (self.percent as i32 + delta).clamp(1, 99) as u32;
        next != self.percent && self.resize_to(next)
    }

    /// Replace the screen rect (e.g. on rotation/resize). Applied **only** if the
    /// current percent is still feasible on the new screen; otherwise the old screen
    /// is kept and `false` is returned — mirroring `SplitScreen::set_screen`.
    pub fn set_screen(&mut self, screen: Bounds) -> bool {
        if slide_over_pane(screen, self.axis, self.percent, self.min, self.margin).is_none() {
            return false;
        }
        self.screen = screen;
        true
    }

    /// Is `id` this panel's window?
    pub fn contains(&self, id: WindowId) -> bool {
        id == self.window
    }

    /// Current share (percent).
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

    fn panel() -> SlideOver {
        SlideOver::new(
            WindowId(7),
            screen(),
            SplitAxis::Vertical,
            12,
            Size::new(200, 300),
        )
        .expect("fits the test screen")
    }

    #[test]
    fn new_builds_shown_at_the_default_share() {
        let s = panel();
        assert_eq!(s.percent(), DEFAULT_SLIDE_PERCENT);
        assert!(!s.is_hidden());
        let b = s.bounds().unwrap();
        assert!(b.width >= 200 && b.height >= 300);
        assert_eq!(
            b.right(),
            1000 - 12,
            "hugs the right edge, inset by the margin"
        );
    }

    #[test]
    fn new_is_none_when_the_inset_rect_is_too_small() {
        let tiny = Bounds::new(0, 0, 120, 100);
        assert!(SlideOver::new(
            WindowId(1),
            tiny,
            SplitAxis::Vertical,
            12,
            Size::new(200, 300)
        )
        .is_none());
    }

    #[test]
    fn hidden_is_fully_off_screen_and_reversible() {
        let mut s = panel();
        let shown = s.bounds().unwrap();
        s.hide();
        assert!(s.is_hidden());
        let off = s.offscreen_bounds().unwrap();
        // Not one pixel left on screen: its left edge starts at the screen's right edge.
        assert_eq!(off.x, 1000);
        assert_eq!(off.y, shown.y);
        assert_eq!(off.width, shown.width);
        s.hide(); // idempotent
        assert!(s.is_hidden());
        s.show();
        assert!(!s.is_hidden());
        assert_eq!(s.current_bounds().unwrap(), shown);
    }

    #[test]
    fn current_bounds_follows_the_hidden_flag() {
        let mut s = panel();
        assert_eq!(s.current_bounds().unwrap(), s.bounds().unwrap());
        s.hide();
        assert_eq!(s.current_bounds().unwrap(), s.offscreen_bounds().unwrap());
    }

    #[test]
    fn horizontal_hidden_translates_downward() {
        let mut s = SlideOver::new(
            WindowId(2),
            Bounds::new(0, 0, 800, 1000),
            SplitAxis::Horizontal,
            10,
            Size::new(300, 200),
        )
        .unwrap();
        let shown = s.bounds().unwrap();
        s.hide();
        let off = s.offscreen_bounds().unwrap();
        assert_eq!(off.y, 1000, "dropped past the bottom edge");
        assert_eq!(off.width, shown.width);
    }

    #[test]
    fn resize_moves_the_share_and_keeps_it_feasible() {
        let mut s = panel();
        assert!(s.resize_to(50));
        assert_eq!(s.percent(), 50);
        // Invalid / infeasible requests are rejected and leave the share unchanged.
        assert!(!s.resize_to(0));
        assert!(!s.resize_to(100));
        assert_eq!(s.percent(), 50);
        assert!(s.resize_by(-10));
        assert_eq!(s.percent(), 40);
    }

    #[test]
    fn set_screen_is_only_applied_when_it_still_fits() {
        let mut s = panel();
        let original = s.screen;
        assert!(!s.set_screen(Bounds::new(0, 0, 120, 100)));
        assert_eq!(s.screen, original, "old screen retained");
        let big = Bounds::new(0, 0, 1400, 900);
        assert!(s.set_screen(big));
        assert_eq!(s.screen, big);
        // The share is preserved (never silently clamped by the new screen).
        assert_eq!(s.percent(), DEFAULT_SLIDE_PERCENT);
    }

    #[test]
    fn contains_answers_only_for_its_own_window() {
        let s = panel();
        assert!(s.contains(WindowId(7)));
        assert!(!s.contains(WindowId(8)));
    }
}
