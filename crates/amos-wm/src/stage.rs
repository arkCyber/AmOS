//! Stage Manager **rail** geometry (pure `std`).
//!
//! [`crate::form::LayoutPolicy::stage_work_area`] answers "where may app windows
//! live while Stage Manager is on". This module answers the two questions the host
//! asks *after* the user has moved a real window:
//!
//!   1. does this rect now intrude into the rail band ([`overlaps_rail`])?
//!   2. if so, where should it be put back ([`reflow_out_of_rail`])?
//!
//! `reflow_out_of_rail` returns `None` for "nothing to do", which is not a failure —
//! it is the discipline that keeps the host from calling `set_position` on a window
//! every time the platform reports a `Moved` event for a window that was already
//! fine (the same shape `WmState::reclamp_target` uses). A caller that gets `None`
//! must **not** move the window, emit an event, or remember a new geometry.
//!
//! Like the rest of this crate it is transport- and platform-agnostic: an
//! `amos-tauri` host maps the returned [`Bounds`] onto a real `WebviewWindow`.

use crate::layout::{Bounds, Size};

/// Does `rect` intrude into the rail band — the strip `rail` px wide down the left
/// edge of `area`?
///
/// `rail == 0` (a class with no rail, or an area too narrow to afford one — see
/// [`crate::form::LayoutPolicy::stage_work_area`]) is never an overlap, so a disabled
/// Stage mode makes every caller a no-op with **zero** platform work. A rect that is
/// entirely above or below `area` does not overlap the band either: the rail is a
/// strip, not a half-plane.
pub fn overlaps_rail(rect: Bounds, area: Bounds, rail: u32) -> bool {
    if rail == 0 {
        return false;
    }
    let rail_right = area.x as i64 + i64::from(rail);
    let horiz = rect.right() > area.x as i64 && (rect.x as i64) < rail_right;
    let vert = rect.bottom() > area.y as i64 && (rect.y as i64) < area.bottom();
    horiz && vert
}

/// Where `rect` must go so it no longer intrudes into the rail band, or `None` when
/// there is nothing to do.
///
/// `None` means **"leave it alone"** and is returned for every case where a move
/// would be churn or a lie:
///
/// * `rail == 0` — Stage mode is off (or this class has no rail);
/// * `rect` does not overlap the band at all ([`overlaps_rail`]) — the overwhelmingly
///   common case, once per `Moved` event on a desktop where the user is dragging a
///   window anywhere else;
/// * there is no room to reflow into: the work area beside the rail is narrower than
///   `min_pane`, so the honest answer is "this cannot be fixed by moving", and the
///   caller reports that instead of shuffling the window forever.
///
/// The returned rect keeps `rect`'s height, and its width **unless** the window is
/// wider than the whole work area — which can only happen to a window that was
/// already hanging off the screen. Shrinking is the lesser evil there: moving alone
/// would put its right edge past the work area, and clamping it back would drop it
/// straight into the rail again.
pub fn reflow_out_of_rail(rect: Bounds, area: Bounds, rail: u32, min_pane: Size) -> Option<Bounds> {
    if !overlaps_rail(rect, area, rail) {
        return None;
    }
    let avail_w = area.width.saturating_sub(rail);
    if avail_w < min_pane.width {
        return None;
    }
    let width = if rect.width > avail_w {
        avail_w
    } else {
        rect.width
    };
    let moved = Bounds::new(
        area.x
            .saturating_add(i32::try_from(rail).unwrap_or(i32::MAX)),
        rect.y,
        width,
        rect.height,
    )
    .enforce_min(min_pane)
    .clamp_into(area);
    Some(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> Bounds {
        Bounds::new(0, 0, 1000, 800)
    }

    #[test]
    fn a_window_clear_of_the_band_never_overlaps_it() {
        let a = area();
        // Exactly at the band's right edge is already clear — `>` not `>=`.
        assert!(!overlaps_rail(Bounds::new(180, 0, 400, 300), a, 180));
        assert!(overlaps_rail(Bounds::new(179, 0, 400, 300), a, 180));
        // Touching the band's left edge from outside is still an overlap.
        assert!(overlaps_rail(Bounds::new(-50, 0, 60, 300), a, 180));
    }

    #[test]
    fn a_rect_entirely_above_or_below_the_area_does_not_overlap_the_band() {
        let a = area();
        // The rail is a strip down the left edge, not a half-plane: a window that is
        // not beside it at all is not covering it.
        assert!(!overlaps_rail(Bounds::new(0, -200, 100, 100), a, 180));
        assert!(!overlaps_rail(Bounds::new(0, 800, 100, 100), a, 180));
        assert!(overlaps_rail(Bounds::new(0, 799, 100, 100), a, 180));
    }

    #[test]
    fn a_class_with_no_rail_makes_every_question_a_no_op() {
        let a = area();
        assert!(!overlaps_rail(Bounds::new(0, 0, 400, 300), a, 0));
        assert_eq!(
            reflow_out_of_rail(Bounds::new(0, 0, 400, 300), a, 0, Size::new(360, 480)),
            None,
            "rail 0 = Stage mode off: not one platform call"
        );
    }

    #[test]
    fn reflow_moves_only_a_rect_that_intrudes() {
        let a = area();
        let min = Size::new(360, 480);

        // Clear of the band: `None`, so the host neither moves nor re-remembers it.
        assert_eq!(
            reflow_out_of_rail(Bounds::new(200, 100, 400, 300), a, 180, min),
            None
        );

        // Intruding: left edge lands exactly on the band's right edge, size kept.
        let moved = reflow_out_of_rail(Bounds::new(40, 100, 500, 500), a, 180, min)
            .expect("an intruding rect has an answer");
        assert_eq!((moved.x, moved.y), (180, 100));
        assert_eq!(
            (moved.width, moved.height),
            (500, 500),
            "a move, not a resize"
        );

        // A rect the platform let fall below `min_pane` is grown, not left unusable —
        // the host enforces the minimum on resize, so this is the defensive half.
        let grown = reflow_out_of_rail(Bounds::new(40, 100, 500, 300), a, 180, min)
            .expect("still an answer");
        assert_eq!(grown.height, 480, "grown to the class minimum");

        // A rect that has been dragged so far left that it is mostly off-screen is
        // the one case that shrinks: it must end up inside the work area, not merely
        // outside the band.
        let wide = reflow_out_of_rail(Bounds::new(-400, 50, 1200, 300), a, 180, min)
            .expect("still an answer");
        assert_eq!(wide.width, 820, "capped to the work area's width");
        assert!(wide.x >= 180 && wide.right() <= a.right(), "{wide:?}");

        // A work area that cannot hold a pane at all is refused, not shuffled.
        let narrow = Bounds::new(0, 0, 200, 800);
        assert_eq!(
            reflow_out_of_rail(Bounds::new(0, 0, 100, 100), narrow, 180, min),
            None,
            "no room beside the rail is not something a move can fix"
        );
    }

    #[test]
    fn reflow_always_lands_a_window_clear_of_the_band_and_on_screen() {
        let min = Size::new(360, 480);
        for a in [
            area(),
            Bounds::new(-500, -300, 1000, 800),
            Bounds::new(0, 0, 640, 480),
        ] {
            for rail in [0u32, 1, 180, 400] {
                for rect in [
                    Bounds::new(-100, -100, 200, 200),
                    Bounds::new(a.x, a.y, 100, 100),
                    Bounds::new(a.x + 900, a.y + 700, 500, 500),
                    Bounds::new(a.x, a.y, a.width, a.height),
                ] {
                    if let Some(out) = reflow_out_of_rail(rect, a, rail, min) {
                        assert!(!overlaps_rail(out, a, rail), "{rect:?} → {out:?}");
                        assert!(out.width >= 1 && out.height >= 1, "{out:?}");
                        assert!(
                            out.right() <= a.right() && out.bottom() <= a.bottom(),
                            "{rect:?} escaped {a:?}: {out:?}"
                        );
                    }
                }
            }
        }
    }
}
