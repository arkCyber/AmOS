//! Multi-display domain (pure `std`) — which screen a window lives on, and what that
//! screen's **usable** area is.
//!
//! The desktop shell has always computed its geometry from *one* rectangle (the
//! measured shell window). That is exact on a single-screen machine and wrong on a
//! multi-screen one: a window sitting on a secondary display would be snapped to the
//! primary's halves, and the window manager had no vocabulary for "a second screen"
//! at all. This module supplies that vocabulary as pure geometry — it is
//! transport- and platform-agnostic exactly like [`crate::layout`] and [`crate::snap`]:
//! the `amos-tauri` adapter enumerates the platform's monitors and maps them into
//! [`Display`]s, and this module answers the *placement* questions over them.
//!
//! Coordinate space: every rectangle is expressed in **whatever space the caller
//! supplies** — the host converts the platform's physical pixels to its logical space
//! before constructing a [`Display`]. The rules below are therefore pure geometry and
//! hold in any space, which is what lets them be unit-tested without a monitor.
//!
//! Honest boundary: on a mixed-DPI setup the *relative* placement of displays is only
//! as good as the caller's per-display scaling — a rectangle cannot express two scale
//! factors at once. The host documents that limit; this module never guesses a scale.

use serde::{Deserialize, Serialize};

use crate::layout::Bounds;

/// One display's geometry, in the caller's coordinate space.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Display {
    /// Full display rectangle (may have a non-zero origin; global coordinates).
    pub bounds: Bounds,
    /// The **usable** rectangle: `bounds` minus whatever the platform reserves at its
    /// edges (menu bar, Dock, taskbar). Equal to `bounds` when the platform reports no
    /// reserved area — never a fabricated inset.
    pub work_area: Bounds,
    /// DPI scale factor mapping logical pixels to physical pixels (`1.0` when unknown).
    /// Reported, never applied by this module.
    pub scale: f64,
    /// True for the platform's primary display. At most one display carries it; a set
    /// where none does is still usable ([`DisplaySet::primary`] falls back to the first).
    pub primary: bool,
    /// Human-readable name the platform gave ("Built-in Retina Display", …), if any.
    pub name: Option<String>,
}

impl Display {
    /// The point at the centre of `rect` — the single sample this module uses to decide
    /// "which display is this window on".
    ///
    /// Centre rather than the top-left corner on purpose: a window dragged halfway off
    /// the right edge of one display and onto the next is *mostly* on the display that
    /// owns its centre, and that is the one a snap should tile it within.
    fn center_of(rect: Bounds) -> (i64, i64) {
        (
            rect.x as i64 + i64::from(rect.width) / 2,
            rect.y as i64 + i64::from(rect.height) / 2,
        )
    }
}

fn contains_point(bounds: Bounds, x: i64, y: i64) -> bool {
    x >= i64::from(bounds.x)
        && x < bounds.right()
        && y >= i64::from(bounds.y)
        && y < bounds.bottom()
}

/// The displays a host can see, in the platform's own order.
///
/// A `DisplaySet` is a plain list, not a table keyed by id: the platform's ids are not
/// stable across hot-plug, and every question this module answers ("which display is
/// this on", "what is the primary") is a *search*, not a lookup. An empty set is legal
/// and means "the platform told us nothing" — every query then returns `None`, which
/// the host reads as "keep using the measured single screen".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DisplaySet {
    pub displays: Vec<Display>,
}

impl DisplaySet {
    pub fn new(displays: Vec<Display>) -> Self {
        Self { displays }
    }

    pub fn is_empty(&self) -> bool {
        self.displays.is_empty()
    }

    pub fn len(&self) -> usize {
        self.displays.len()
    }

    pub fn iter(&self) -> std::slice::Iter<'_, Display> {
        self.displays.iter()
    }

    /// The primary display, or the **first** when the platform named none.
    ///
    /// Falling back to the first rather than returning `None` matches how a single
    /// unnamed monitor behaves: it is the screen everything is on. A set that is
    /// non-empty but has no primary is not an error, it is a platform that did not
    /// answer that question — and the first display is the only honest default.
    pub fn primary(&self) -> Option<&Display> {
        self.displays
            .iter()
            .find(|d| d.primary)
            .or_else(|| self.displays.first())
    }

    /// The display whose `bounds` contain `rect`'s centre, if any.
    ///
    /// `None` for an empty set, and also for a rectangle whose centre falls in the gap
    /// between displays (possible when a caller passes an absurd rect) — never a
    /// guessed neighbour. Callers that need "some display" use [`Self::work_area_for`],
    /// which has a documented fallback.
    pub fn containing(&self, rect: Bounds) -> Option<&Display> {
        let (x, y) = Display::center_of(rect);
        self.displays
            .iter()
            .find(|d| contains_point(d.bounds, x, y))
    }

    /// The work area a window currently at `rect` should be laid out in.
    ///
    /// The rule, in order: the work area of the display containing `rect`'s centre;
    /// otherwise the primary display's work area (a window whose centre is off every
    /// display — e.g. below the screen after a shrink — is brought back to the
    /// primary, which is where the shell lives). `None` only when the set is empty.
    pub fn work_area_for(&self, rect: Bounds) -> Option<Bounds> {
        self.containing(rect)
            .or_else(|| self.primary())
            .map(|d| d.work_area)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(x: i32, y: i32, w: u32, h: u32, primary: bool) -> Display {
        // Work area inset by the platform's reserved strips (menu bar at the top, Dock
        // at the bottom), the shape a real desktop monitor reports.
        let bounds = Bounds::new(x, y, w, h);
        let work_area = Bounds::new(x, y + 25, w, h - 25 - 60);
        Display {
            bounds,
            work_area,
            scale: 1.0,
            primary,
            name: None,
        }
    }

    fn two_displays() -> DisplaySet {
        // A primary at the origin and a secondary to its left (negative origin, the
        // arrangement macOS and X11 both produce for "display #2 on the left").
        DisplaySet::new(vec![
            display(0, 0, 1920, 1080, true),
            display(-2560, 0, 2560, 1440, false),
        ])
    }

    #[test]
    fn a_single_display_owns_every_rect_and_is_its_own_primary() {
        let set = DisplaySet::new(vec![display(0, 0, 800, 600, false)]);
        assert_eq!(set.len(), 1);
        let d = set.primary().expect("a non-empty set has a primary");
        assert_eq!(d.bounds, Bounds::new(0, 0, 800, 600));
        // No `primary` flag anywhere: the first display is the honest default.
        assert!(set.containing(Bounds::new(10, 10, 100, 100)).is_some());
    }

    #[test]
    fn an_empty_set_answers_none_to_every_question() {
        let set = DisplaySet::default();
        assert!(set.is_empty());
        assert_eq!(set.primary(), None);
        assert_eq!(set.containing(Bounds::new(0, 0, 10, 10)), None);
        assert_eq!(set.work_area_for(Bounds::new(0, 0, 10, 10)), None);
    }

    #[test]
    fn a_rect_is_owned_by_the_display_containing_its_center() {
        let set = two_displays();
        // A window fully on the secondary (negative origin).
        let on_secondary = Bounds::new(-2000, 100, 800, 600);
        let d = set
            .containing(on_secondary)
            .expect("centre is on the secondary");
        assert_eq!(d.bounds.x, -2560);
        assert!(!d.primary);

        // A window fully on the primary.
        let on_primary = Bounds::new(100, 100, 800, 600);
        assert_eq!(set.containing(on_primary).map(|d| d.bounds.x), Some(0));
    }

    #[test]
    fn a_window_straddling_the_edge_is_owned_by_the_display_holding_its_center() {
        let set = two_displays();
        // Mostly on the primary: the rect spills past the primary's right edge (1920)
        // but its centre (1700 + 200 = 1900) is still inside [0, 1920).
        let mostly_primary = Bounds::new(1700, 100, 400, 600); // centre x = 1900
        assert_eq!(set.containing(mostly_primary).map(|d| d.bounds.x), Some(0));

        // Mirrored: hanging off the primary's left edge, centre on the secondary.
        let mostly_secondary = Bounds::new(-300, 100, 400, 600); // centre x = -100
        assert_eq!(
            set.containing(mostly_secondary).map(|d| d.bounds.x),
            Some(-2560)
        );
    }

    #[test]
    fn work_area_for_follows_the_containing_display_then_falls_back_to_primary() {
        let set = two_displays();
        let secondary_area = set
            .work_area_for(Bounds::new(-2000, 100, 400, 300))
            .expect("secondary work area");
        assert_eq!(secondary_area.x, -2560, "the secondary's own area");
        assert_eq!(secondary_area.y, 25, "its own reserved strip is honoured");

        // These two displays tile the whole axis (the secondary ends exactly where the
        // primary begins), so a rect in the *gap* is impossible — instead exercise the
        // fallback with a rect below both displays, whose centre is on neither.
        let below = Bounds::new(500, 5000, 100, 100);
        assert_eq!(
            set.work_area_for(below),
            set.primary().map(|d| d.work_area),
            "an off-screen rect falls back to the primary's work area"
        );
    }

    #[test]
    fn the_work_area_never_exceeds_its_display_and_keeps_its_origin() {
        let set = two_displays();
        for d in set.iter() {
            assert_eq!(d.work_area.x, d.bounds.x);
            assert!(d.work_area.right() <= d.bounds.right());
            assert!(d.work_area.bottom() <= d.bounds.bottom());
        }
    }
}
