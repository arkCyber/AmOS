//! Window **snapping** / edge-tiling geometry (pure `std`) — REQ-A616.
//!
//! A desktop-class window can be sent to a named region of the screen — a half, a
//! quarter, or the whole work area — instead of being dragged and resized by hand.
//! This module is the *decision* half of that: given a [`SnapZone`] and the screen's
//! usable rectangle, it returns the [`Bounds`] the window should occupy. The
//! `amos-tauri` host adapter maps the result onto the real window, exactly as it does
//! for [`crate::layout::split_panes`] and [`crate::form`].
//!
//! Two rules make the result usable on a real screen, and both are asserted rather
//! than assumed:
//!
//! * **Halves tile without a seam.** An odd extent is split so the two panes *sum to*
//!   the whole (the left/top takes the floor, the right/bottom the remainder): a
//!   1497-wide work area becomes 748 + 749, never 748 + 748 with a dead column or an
//!   overlapping one.
//! * **The minimum wins, then the frame is pulled back on-screen.** A zone smaller
//!   than a window's minimum size grows to the minimum ([`Bounds::enforce_min`]) and is
//!   then slid back inside the work area ([`Bounds::clamp_into`]) — the same
//!   composition the free-resize path uses, so a snap can never produce a window below
//!   the class minimum or off the edge.

use serde::{Deserialize, Serialize};

use crate::layout::{Bounds, Size};

/// A named region of the screen a window can be snapped to.
///
/// The set is deliberately the one a pointer or a keyboard can name unambiguously:
/// two halves per axis, the four corners that combine them, and the whole area. A
/// value the frontend does not recognise is refused by [`SnapZone::parse`] (`None`,
/// never guessed) — the same rule [`crate::form::FormFactor::parse`] follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SnapZone {
    /// Left half (full height).
    LeftHalf,
    /// Right half (full height).
    RightHalf,
    /// Top half (full width).
    TopHalf,
    /// Bottom half (full width).
    BottomHalf,
    /// Top-left quarter.
    TopLeft,
    /// Top-right quarter.
    TopRight,
    /// Bottom-left quarter.
    BottomLeft,
    /// Bottom-right quarter.
    BottomRight,
    /// The whole work area.
    Maximize,
}

impl SnapZone {
    /// Every zone, in wire order.
    pub const ALL: [SnapZone; 9] = [
        SnapZone::LeftHalf,
        SnapZone::RightHalf,
        SnapZone::TopHalf,
        SnapZone::BottomHalf,
        SnapZone::TopLeft,
        SnapZone::TopRight,
        SnapZone::BottomLeft,
        SnapZone::BottomRight,
        SnapZone::Maximize,
    ];

    /// Stable wire/CLI key (what the UI passes and the host parses back).
    pub fn key(self) -> &'static str {
        match self {
            SnapZone::LeftHalf => "left",
            SnapZone::RightHalf => "right",
            SnapZone::TopHalf => "top",
            SnapZone::BottomHalf => "bottom",
            SnapZone::TopLeft => "top-left",
            SnapZone::TopRight => "top-right",
            SnapZone::BottomLeft => "bottom-left",
            SnapZone::BottomRight => "bottom-right",
            SnapZone::Maximize => "maximize",
        }
    }

    /// Parse a wire key; `None` for anything not in [`SnapZone::ALL`].
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|z| z.key() == value)
    }
}

/// Split `total` into (first, second) that **sum to `total`**: the first takes the
/// floor, the second the remainder, so an odd extent leaves no dead or doubled pixel.
const fn halves(total: u32) -> (u32, u32) {
    let first = total / 2;
    (first, total - first)
}

/// The frame a window occupies when snapped to `zone` inside `work_area`, grown to at
/// least `min` and then pulled back inside `work_area`.
///
/// `work_area` is the **usable** rectangle (the screen minus whatever the platform
/// reserves — menu bar, Dock), not the raw display: a snapped window that covered the
/// menu bar would be a worse default than one that stops at it. Its origin is honoured,
/// so a window on a secondary display snaps to *that* display's area.
pub fn snap_bounds(zone: SnapZone, work_area: Bounds, min: Size) -> Bounds {
    let (left_w, right_w) = halves(work_area.width);
    let (top_h, bottom_h) = halves(work_area.height);
    let x = work_area.x;
    let y = work_area.y;
    let mid_x = x + left_w as i32;
    let mid_y = y + top_h as i32;

    let frame = match zone {
        SnapZone::LeftHalf => Bounds::new(x, y, left_w, work_area.height),
        SnapZone::RightHalf => Bounds::new(mid_x, y, right_w, work_area.height),
        SnapZone::TopHalf => Bounds::new(x, y, work_area.width, top_h),
        SnapZone::BottomHalf => Bounds::new(x, mid_y, work_area.width, bottom_h),
        SnapZone::TopLeft => Bounds::new(x, y, left_w, top_h),
        SnapZone::TopRight => Bounds::new(mid_x, y, right_w, top_h),
        SnapZone::BottomLeft => Bounds::new(x, mid_y, left_w, bottom_h),
        SnapZone::BottomRight => Bounds::new(mid_x, mid_y, right_w, bottom_h),
        SnapZone::Maximize => work_area,
    };
    frame.enforce_min(min).clamp_into(work_area)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A work area with a non-zero origin **and odd extents** (1497 × 881), so every test
    /// would notice both an ignored offset and a half that rounded instead of tile.
    fn work_area() -> Bounds {
        Bounds::new(0, 25, 1497, 881)
    }

    const NO_MIN: Size = Size::new(1, 1);

    #[test]
    fn the_wire_keys_round_trip_and_an_unknown_zone_is_refused() {
        for zone in SnapZone::ALL {
            assert_eq!(SnapZone::parse(zone.key()), Some(zone));
        }
        assert_eq!(SnapZone::parse("left"), Some(SnapZone::LeftHalf));
        assert_eq!(SnapZone::parse("top-left"), Some(SnapZone::TopLeft));
        // Never guessed into a real zone.
        assert_eq!(SnapZone::parse("middle"), None);
        assert_eq!(SnapZone::parse(""), None);
        assert_eq!(SnapZone::parse("Left"), None, "keys are case-sensitive");
    }

    #[test]
    fn the_horizontal_halves_tile_the_work_area_without_a_seam() {
        let w = work_area();
        let left = snap_bounds(SnapZone::LeftHalf, w, NO_MIN);
        let right = snap_bounds(SnapZone::RightHalf, w, NO_MIN);
        assert_eq!(left.x, w.x);
        assert_eq!(left.y, w.y, "a half spans the full height");
        assert_eq!(left.height, w.height);
        assert_eq!(right.height, w.height);
        assert_eq!(right.x, left.right() as i32, "no gap, no overlap");
        assert_eq!(right.right(), w.right(), "the right half reaches the edge");
        assert_eq!(
            u64::from(left.width) + u64::from(right.width),
            u64::from(w.width),
            "an odd extent is split 748 + 749, not 748 + 748"
        );
        assert_eq!(left.width, 748, "the first half takes the floor");
        assert_eq!(right.width, 749, "the second takes the remainder");
    }

    #[test]
    fn the_vertical_halves_tile_the_work_area_and_respect_the_origin() {
        let w = work_area();
        let top = snap_bounds(SnapZone::TopHalf, w, NO_MIN);
        let bottom = snap_bounds(SnapZone::BottomHalf, w, NO_MIN);
        assert_eq!(top.y, w.y, "the menu-bar offset is honoured");
        assert_eq!(top.x, w.x);
        assert_eq!(top.width, w.width, "a half spans the full width");
        assert_eq!(bottom.x, w.x);
        assert_eq!(bottom.y, top.bottom() as i32);
        assert_eq!(bottom.bottom(), w.bottom());
        assert_eq!(
            u64::from(top.height) + u64::from(bottom.height),
            u64::from(w.height)
        );
    }

    #[test]
    fn the_four_quarters_meet_exactly_at_the_midlines() {
        let w = work_area();
        let tl = snap_bounds(SnapZone::TopLeft, w, NO_MIN);
        let tr = snap_bounds(SnapZone::TopRight, w, NO_MIN);
        let bl = snap_bounds(SnapZone::BottomLeft, w, NO_MIN);
        let br = snap_bounds(SnapZone::BottomRight, w, NO_MIN);

        assert_eq!(tl.x, w.x);
        assert_eq!(tl.y, w.y);
        assert_eq!(tr.x, tl.right() as i32, "columns touch");
        assert_eq!(bl.y, tl.bottom() as i32, "rows touch");
        assert_eq!(br.x, bl.right() as i32);
        assert_eq!(br.y, tr.bottom() as i32);
        assert_eq!(
            br.right(),
            w.right(),
            "the bottom-right corner is the far corner"
        );
        assert_eq!(br.bottom(), w.bottom());

        // A top-left + top-right quarter is exactly the top half; same for the bottom.
        assert_eq!(tl.width + tr.width, w.width);
        assert_eq!(tl.height + bl.height, w.height);
    }

    #[test]
    fn maximize_is_the_whole_work_area() {
        let w = work_area();
        assert_eq!(snap_bounds(SnapZone::Maximize, w, NO_MIN), w);
    }

    #[test]
    fn the_minimum_wins_and_the_frame_is_pulled_back_on_screen() {
        // A work area too small for a minimum-sized window in a half: the frame grows to the
        // minimum (never smaller than the class allows) and is then slid back inside — here
        // the minimum is *wider than the whole work area*, so the honest result is a window
        // wider than the screen, anchored at the origin. Clamping only slides; it never
        // shrinks a window below the minimum to make it "fit".
        let w = Bounds::new(0, 0, 400, 300);
        let min = Size::new(500, 280);
        let left = snap_bounds(SnapZone::LeftHalf, w, min);
        assert_eq!(
            left.width, 500,
            "grown to the minimum, not the 200-wide half"
        );
        assert_eq!(left.x, 0, "slid as far left as the work area allows");
        assert_eq!(left.height, 300, "height already exceeds the minimum");

        // A minimum that is a floor rather than a target: a 150-wide minimum leaves the
        // 200-wide half untouched (enforce_min only ever grows).
        assert_eq!(
            snap_bounds(SnapZone::RightHalf, w, Size::new(150, 100)).width,
            200,
            "a minimum below the zone size does not shrink it"
        );

        // When the minimum *does* bind and still fits, the grown frame is slid fully
        // on-screen: the 200-wide right half becomes 300 wide and shifts left to the edge.
        let grown = snap_bounds(SnapZone::RightHalf, w, Size::new(300, 100));
        assert_eq!(grown.width, 300, "grown to the minimum");
        assert_eq!(grown.x, 100, "slid left to stay inside the work area");
        assert_eq!(
            grown.right(),
            w.right(),
            "the right edge anchors the slide-back"
        );
    }

    #[test]
    fn a_zone_on_a_secondary_display_stays_on_that_display() {
        let w = Bounds::new(-1920, 0, 1920, 1080);
        let right = snap_bounds(SnapZone::RightHalf, w, NO_MIN);
        assert_eq!(right.x, -960, "the halves split the *secondary* area");
        assert_eq!(right.right(), w.right());
        let tl = snap_bounds(SnapZone::TopLeft, w, NO_MIN);
        assert_eq!(tl.x, -1920);
        assert_eq!(tl.y, 0);
    }

    #[test]
    fn a_degenerate_work_area_never_yields_a_zero_size_window() {
        let empty = Bounds::new(0, 0, 0, 0);
        let b = snap_bounds(SnapZone::LeftHalf, empty, Size::new(0, 0));
        assert!(b.width >= 1 && b.height >= 1, "enforce_min floors at 1");
    }
}
