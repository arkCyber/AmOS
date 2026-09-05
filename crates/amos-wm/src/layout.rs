//! Desktop geometry domain (pure `std`): window bounds with a **minimum-size**
//! constraint, free-resize clamping, and **split-screen** pane math.
//!
//! This is the decision logic for the multi-window OS features on the roadmap
//! ("自由缩放 / 分屏导航"). Like [`crate::WindowManager`] it is transport- and
//! platform-agnostic: it only answers *geometry* questions (sizes, positions,
//! whether two min-sized panes fit a screen) — the `amos-tauri` host adapter maps
//! the returned [`Bounds`] onto the real backend.
//!
//! ```text
//! [ split_panes(…) ]   [ enforce_min(…) ]   [ clamp_into(…) ]
//!        │                    │                    │
//!        └──────────► Bounds { x, y, w, h } ◄───────┘
//! ```

/// A non-negative size (pixels).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

impl Size {
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    pub fn area(self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }
}

/// A window frame: top-left `(x, y)` plus `width` × `height`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Bounds {
    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Right edge as a signed 64-bit coordinate (avoids overflow when adding).
    pub fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    /// Bottom edge as a signed 64-bit coordinate (avoids overflow when adding).
    pub fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    /// Grow the frame up to `min` (origin preserved) — the "free resize never
    /// shrinks a window below its minimum" rule.
    pub fn enforce_min(self, min: Size) -> Bounds {
        Bounds {
            x: self.x,
            y: self.y,
            width: self.width.max(min.width.max(1)),
            height: self.height.max(min.height.max(1)),
        }
    }

    /// Slide the frame so it sits entirely inside `screen` (size unchanged), used
    /// to keep a window on-screen after a free resize/drag. No-op if it fits.
    pub fn clamp_into(self, screen: Bounds) -> Bounds {
        let mut x = self.x;
        let mut y = self.y;
        let s_right = screen.right();
        let s_bottom = screen.bottom();
        if self.right() > s_right {
            x = (s_right - i64::from(self.width)) as i32;
        }
        if self.bottom() > s_bottom {
            y = (s_bottom - i64::from(self.height)) as i32;
        }
        if x < screen.x {
            x = screen.x;
        }
        if y < screen.y {
            y = screen.y;
        }
        Bounds { x, y, ..self }
    }
}

/// Split orientation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SplitAxis {
    /// Two panes left/right (classic split screen).
    Vertical,
    /// Two panes top/bottom.
    Horizontal,
}
/// Split `screen` into two panes along `axis`, separated by `gap`, with the first
/// pane taking `percent` (1..=99) of the usable extent. Every pane is at least
/// `min`. Returns `None` when the screen cannot host two minimum panes + the gap
/// (honest — never a zero/negative pane).
pub fn split_panes(
    screen: Bounds,
    axis: SplitAxis,
    gap: u32,
    percent: u32,
    min: Size,
) -> Option<(Bounds, Bounds)> {
    if !(1..=99).contains(&percent) {
        return None;
    }
    let min_w = min.width.max(1) as u64;
    let min_h = min.height.max(1) as u64;
    let gap = u64::from(gap);

    match axis {
        SplitAxis::Vertical => {
            let screen_w = u64::from(screen.width);
            let screen_h = u64::from(screen.height);
            let usable = screen_w.saturating_sub(gap);
            if usable < min_w.saturating_mul(2) || screen_h < min_h {
                return None;
            }
            let first = ((usable * u64::from(percent)) / 100).clamp(min_w, usable - min_w);
            let second = usable - first;
            if first < min_w || second < min_w {
                return None;
            }
            let left = Bounds::new(screen.x, screen.y, first as u32, screen.height);
            let right = Bounds::new(
                screen.x + (first + gap) as i32,
                screen.y,
                second as u32,
                screen.height,
            );
            Some((left, right))
        }
        SplitAxis::Horizontal => {
            let screen_w = u64::from(screen.width);
            let screen_h = u64::from(screen.height);
            let usable = screen_h.saturating_sub(gap);
            if usable < min_h.saturating_mul(2) || screen_w < min_w {
                return None;
            }
            let first = ((usable * u64::from(percent)) / 100).clamp(min_h, usable - min_h);
            let second = usable - first;
            if first < min_h || second < min_h {
                return None;
            }
            let top = Bounds::new(screen.x, screen.y, screen.width, first as u32);
            let bottom = Bounds::new(
                screen.x,
                screen.y + (first + gap) as i32,
                screen.width,
                second as u32,
            );
            Some((top, bottom))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_and_bounds_math() {
        assert_eq!(Size::new(4, 3).area(), 12);
        let b = Bounds::new(10, 20, 640, 480);
        assert_eq!(b.right(), 650);
        assert_eq!(b.bottom(), 500);
    }

    #[test]
    fn vertical_split_covers_screen_minus_gap_and_respects_min() {
        let screen = Bounds::new(0, 0, 1000, 600);
        let min = Size::new(300, 200);
        let (l, r) = split_panes(screen, SplitAxis::Vertical, 8, 50, min).unwrap();
        assert_eq!(l.x, 0);
        assert_eq!(l.height, 600);
        assert!(l.width >= 300 && r.width >= 300);
        assert_eq!(r.right(), 1000, "right pane reaches the screen edge");
        assert_eq!(l.right() + 8, i64::from(r.x), "8px divider gap");
        assert_eq!(u64::from(l.width) + u64::from(r.width) + 8, 1000);
    }

    #[test]
    fn horizontal_split_analogous_top_bottom() {
        let screen = Bounds::new(0, 0, 800, 1000);
        let min = Size::new(200, 300);
        let (t, b) = split_panes(screen, SplitAxis::Horizontal, 10, 40, min).unwrap();
        assert_eq!(t.x, 0);
        assert_eq!(t.width, 800);
        assert_eq!(b.bottom(), 1000);
        assert_eq!(u64::from(t.height) + u64::from(b.height) + 10, 1000);
        assert!(t.height >= 300 && b.height >= 300);
    }

    #[test]
    fn split_returns_none_when_screen_cannot_hold_two_min_panes() {
        let screen = Bounds::new(0, 0, 100, 100);
        // min 80+80 + gap 20 > 100 → cannot split.
        assert_eq!(
            split_panes(screen, SplitAxis::Vertical, 20, 50, Size::new(80, 50)),
            None
        );
        // Invalid percent refused.
        assert!(split_panes(screen, SplitAxis::Vertical, 0, 0, Size::new(10, 10)).is_none());
        assert!(split_panes(screen, SplitAxis::Vertical, 0, 100, Size::new(10, 10)).is_none());
    }

    #[test]
    fn enforce_min_never_shrinks_below_minimum() {
        let b = Bounds::new(5, 5, 100, 100).enforce_min(Size::new(120, 80));
        assert_eq!(b.width, 120);
        assert_eq!(b.height, 100, "height already ≥ min stays");
        assert_eq!(b.x, 5, "origin preserved");
        // enforce_min never returns a zero-size window.
        assert_eq!(
            Bounds::new(0, 0, 0, 0).enforce_min(Size::new(0, 0)).width,
            1
        );
    }

    #[test]
    fn clamp_into_keeps_a_window_on_screen() {
        let screen = Bounds::new(0, 0, 800, 600);
        let off = Bounds::new(790, 590, 200, 200).clamp_into(screen);
        assert!(off.right() <= 800, "right edge within screen");
        assert!(off.bottom() <= 600, "bottom edge within screen");
        let neg = Bounds::new(-50, -30, 100, 100).clamp_into(screen);
        assert_eq!(neg.x, 0);
        assert_eq!(neg.y, 0);
        let inside = Bounds::new(10, 10, 100, 100).clamp_into(screen);
        assert_eq!(inside, Bounds::new(10, 10, 100, 100));
    }
}
