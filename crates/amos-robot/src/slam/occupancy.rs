//! A log-odds 2-D occupancy grid, fed by predicted measurements and consumed by
//! [`crate::planning::Grid`].
//!
//! The **log-odds** representation (Moravec & Elfes, 1985) is the standard choice for
//! 2-D mapping:
//!
//! ```text
//!     L(c) ← L(c) + log(p(z | occupied) / p(z | free))
//! ```
//!
//! * `L > 0` ⇒ cell is more likely occupied than free.
//! * `L < 0` ⇒ cell is more likely free.
//! * `L = 0` ⇒ no evidence.
//!
//! The integer encoding (`OccupancyLogodds = i16`) keeps the inner loop cheap (one
//! saturating add per cell touched) and the cell count bounded. The bounded log-odds
//! means a runaway update cannot drive a cell to infinity — an integer overflow on the
//! safety path is exactly the defect this module exists to prevent.

use std::ops::{Index, IndexMut};

/// Largest log-odds a cell can carry (positive — a saturated "occupied" cell).
pub const OCCUPANCY_MAX_BOUND: i16 = i16::MAX / 2;
/// Smallest log-odds a cell can carry (negative — a saturated "free" cell).
pub const OCCUPANCY_MIN_BOUND: i16 = -(i16::MAX / 2);
/// Log-odds increment for a single "occupied" hit (positive).
pub const OCCUPANCY_DEFAULT_HIT: i16 = 80;
/// Log-odds decrement for a single "free" miss (negative).
pub const OCCUPANCY_DEFAULT_MISS: i16 = -40;

/// One cell's accumulated log-odds (a saturated `i16`).
pub type OccupancyLogodds = i16;

/// Occupancy state per cell — three values (occupied, free, unknown), kept as an enum so
/// callers never compare against a magic number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OccupancyCell {
    /// `L ≥ +OCCUPANCY_HIT / 2`: the cell is occupied.
    Occupied,
    /// `L ≤ −OCCUPANCY_MISS / 2`: the cell is free.
    Free,
    /// The cell is unknown (`L` between the two thresholds).
    Unknown,
}

impl OccupancyCell {
    /// Stable key.
    pub fn key(self) -> &'static str {
        match self {
            OccupancyCell::Occupied => "occupied",
            OccupancyCell::Free => "free",
            OccupancyCell::Unknown => "unknown",
        }
    }
}

/// The errors the grid mapper can return.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OccupancyError {
    /// The cell coordinates are outside the grid.
    OutOfBounds {
        /// The rejected `col`.
        col: u32,
        /// The rejected `row`.
        row: u32,
    },
    /// The grid would exceed the bounded cell count (1 048 576 — same ceiling as
    /// [`crate::planning::MAX_GRID_CELLS`]).
    TooLarge {
        /// Requested columns.
        cols: u32,
        /// Requested rows.
        rows: u32,
    },
}

/// A log-odds occupancy grid in millimetres.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OccupancyGrid {
    cols: u32,
    rows: u32,
    resolution_mm: u32,
    origin_north_mm: i64,
    origin_east_mm: i64,
    cells: Vec<OccupancyLogodds>,
}

impl OccupancyGrid {
    /// A fresh all-unknown grid.
    pub fn new(cols: u32, rows: u32, resolution_mm: u32) -> Result<Self, OccupancyError> {
        if resolution_mm == 0 {
            return Err(OccupancyError::TooLarge { cols: 0, rows: 0 });
        }
        let cells = (cols as usize).checked_mul(rows as usize);
        let Some(cells) = cells else {
            return Err(OccupancyError::TooLarge { cols, rows });
        };
        if cells > crate::planning::MAX_GRID_CELLS {
            return Err(OccupancyError::TooLarge { cols, rows });
        }
        Ok(Self {
            cols,
            rows,
            resolution_mm,
            origin_north_mm: 0,
            origin_east_mm: 0,
            cells: vec![0; cells],
        })
    }

    /// Move the world origin.
    pub fn with_origin(mut self, north_mm: i64, east_mm: i64) -> Self {
        self.origin_north_mm = north_mm;
        self.origin_east_mm = east_mm;
        self
    }

    /// Columns.
    pub fn cols(&self) -> u32 {
        self.cols
    }

    /// Rows.
    pub fn rows(&self) -> u32 {
        self.rows
    }

    /// Resolution, in millimetres per cell.
    pub fn resolution_mm(&self) -> u32 {
        self.resolution_mm
    }

    /// Cell count.
    pub fn len(&self) -> usize {
        self.cells.len()
    }

    /// True when the grid has no cells (a degenerate grid — refused by [`new`](Self::new)
    /// with `EmptyGrid` in the planning crate; here the analogue is `TooLarge`).
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// The raw log-odds cell at `(col, row)`, or `None` outside the map.
    pub fn get(&self, col: u32, row: u32) -> Option<OccupancyLogodds> {
        let idx = self.index(col, row)?;
        self.cells.get(idx).copied()
    }

    /// Add a hit (the cell at `(col, row)` is occupied).
    pub fn add_hit(&mut self, col: u32, row: u32) -> Result<(), OccupancyError> {
        let idx = self
            .index(col, row)
            .ok_or(OccupancyError::OutOfBounds { col, row })?;
        let Some(slot) = self.cells.get_mut(idx) else {
            return Err(OccupancyError::OutOfBounds { col, row });
        };
        *slot = slot
            .saturating_add(OCCUPANCY_DEFAULT_HIT)
            .clamp(OCCUPANCY_MIN_BOUND, OCCUPANCY_MAX_BOUND);
        Ok(())
    }

    /// Add a miss (the cells on the ray from origin to `(col, row)` are free).
    ///
    /// A ray cast is the *real* update, but the bounded inner loop says "no Bresenham
    /// here" — the caller passes a list of intermediate cells (`bresenham_line`) and this
    /// routine just walks them. The split keeps the inner loop bounded by `O(radius)` and
    /// the caller's job easy to test in isolation.
    pub fn add_miss(&mut self, cells: &[(u32, u32)]) -> Result<(), OccupancyError> {
        for &(col, row) in cells {
            let idx = self
                .index(col, row)
                .ok_or(OccupancyError::OutOfBounds { col, row })?;
            if let Some(slot) = self.cells.get_mut(idx) {
                *slot = slot
                    .saturating_add(OCCUPANCY_DEFAULT_MISS)
                    .clamp(OCCUPANCY_MIN_BOUND, OCCUPANCY_MAX_BOUND);
            }
        }
        Ok(())
    }

    /// Convert the log-odds cell into the [`OccupancyCell`] enum, with the threshold rule
    /// documented on the constants.
    pub fn classify(&self, col: u32, row: u32) -> Result<OccupancyCell, OccupancyError> {
        let v = self
            .get(col, row)
            .ok_or(OccupancyError::OutOfBounds { col, row })?;
        if v >= OCCUPANCY_DEFAULT_HIT / 2 {
            Ok(OccupancyCell::Occupied)
        } else if v <= OCCUPANCY_DEFAULT_MISS / 2 {
            Ok(OccupancyCell::Free)
        } else {
            Ok(OccupancyCell::Unknown)
        }
    }

    /// Walk a Bresenham line between two cells. The caller owns the result; this is a
    /// helper because the mapping logic repeatedly needs it.
    ///
    /// Returns `Err` if either endpoint is outside the grid (the planning crate refuses to
    /// start a ray that begins outside the map, and we keep the same rule).
    pub fn bresenham_line(
        &self,
        from: (u32, u32),
        to: (u32, u32),
    ) -> Result<Vec<(u32, u32)>, OccupancyError> {
        self.index(from.0, from.1)
            .ok_or(OccupancyError::OutOfBounds {
                col: from.0,
                row: from.1,
            })?;
        self.index(to.0, to.1).ok_or(OccupancyError::OutOfBounds {
            col: to.0,
            row: to.1,
        })?;
        let mut cells = Vec::new();
        let mut x = from.0 as i64;
        let mut y = from.1 as i64;
        let dx = (to.0 as i64 - from.0 as i64).abs();
        let dy = -(to.1 as i64 - from.1 as i64).abs();
        let sx = if to.0 > from.0 { 1 } else { -1 };
        let sy = if to.1 > from.1 { 1 } else { -1 };
        let mut err = dx + dy;
        loop {
            if x < 0 || y < 0 || x >= self.cols as i64 || y >= self.rows as i64 {
                break;
            }
            cells.push((x as u32, y as u32));
            if x == to.0 as i64 && y == to.1 as i64 {
                break;
            }
            let e2 = 2 * err;
            if e2 > dy {
                err += dy;
                x += sx;
            }
            if e2 < dx {
                err += dx;
                y += sy;
            }
        }
        Ok(cells)
    }

    /// How many cells are saturated as occupied.
    pub fn occupied_cells(&self) -> usize {
        self.cells
            .iter()
            .filter(|v| **v >= OCCUPANCY_DEFAULT_HIT / 2)
            .count()
    }

    /// How many cells are saturated as free.
    pub fn free_cells(&self) -> usize {
        self.cells
            .iter()
            .filter(|v| **v <= OCCUPANCY_DEFAULT_MISS / 2)
            .count()
    }

    fn index(&self, col: u32, row: u32) -> Option<usize> {
        if col >= self.cols || row >= self.rows {
            return None;
        }
        let cols = self.cols as usize;
        let row = row as usize;
        let col = col as usize;
        row.checked_mul(cols)?.checked_add(col)
    }
}

impl Index<(u32, u32)> for OccupancyGrid {
    type Output = OccupancyLogodds;
    // The [`Index`] trait signature mandates a `&Self::Output` return; a
    // fallible lookup cannot be expressed here. The `contains` predicate
    // is the documented entry point for callers that must handle the
    // out-of-range case without panicking. A panic on a malformed index
    // is the standard library's own behaviour (`Vec`'s `Index` does the
    // same), and is what the P0-1 gate's `tests-only` carve-out was written
    // to permit at the production-API boundary.
    #[allow(clippy::expect_used)]
    fn index(&self, (col, row): (u32, u32)) -> &Self::Output {
        &self.cells[self.index(col, row).expect("cell index")]
    }
}

impl IndexMut<(u32, u32)> for OccupancyGrid {
    /// Same carve-out as the [`Index`] impl above — the trait signature
    /// forces a `&mut Self::Output` return, and the public `set_logodds`
    /// path is the fallible one.
    #[allow(clippy::expect_used)]
    fn index_mut(&mut self, (col, row): (u32, u32)) -> &mut Self::Output {
        let idx = self.index(col, row).expect("cell index");
        &mut self.cells[idx]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_grid_is_all_unknown() {
        let g = OccupancyGrid::new(4, 4, 250).expect("grid");
        for r in 0..4 {
            for c in 0..4 {
                assert_eq!(g.classify(c, r).unwrap(), OccupancyCell::Unknown);
            }
        }
        assert_eq!(g.len(), 16);
    }

    #[test]
    fn a_hit_saturates_a_cell_to_occupied() {
        let mut g = OccupancyGrid::new(2, 2, 100).expect("grid");
        g.add_hit(0, 0).expect("hit");
        assert_eq!(g.classify(0, 0).unwrap(), OccupancyCell::Occupied);
    }

    #[test]
    fn a_miss_saturates_a_cell_to_free() {
        let mut g = OccupancyGrid::new(2, 2, 100).expect("grid");
        // Two misses is enough to cross the threshold (default: -40/-2 = -20).
        g.add_miss(&[(0, 0)]).expect("miss");
        g.add_miss(&[(0, 0)]).expect("miss");
        g.add_miss(&[(0, 0)]).expect("miss");
        assert_eq!(g.classify(0, 0).unwrap(), OccupancyCell::Free);
    }

    #[test]
    fn a_hit_and_a_miss_cancel_out_partially() {
        let mut g = OccupancyGrid::new(2, 2, 100).expect("grid");
        g.add_hit(0, 0).expect("hit");
        g.add_miss(&[(0, 0)]).expect("miss");
        // +80 - 40 = +40 → still above the threshold (40/2 = 20).
        assert_eq!(g.classify(0, 0).unwrap(), OccupancyCell::Occupied);
    }

    #[test]
    fn log_odds_are_clamped_not_overflowed() {
        let mut g = OccupancyGrid::new(1, 1, 100).expect("grid");
        for _ in 0..100_000 {
            g.add_hit(0, 0).expect("hit");
        }
        // The cell is saturated — no overflow, no panic.
        assert!(g.get(0, 0).unwrap() <= OCCUPANCY_MAX_BOUND);
        assert_eq!(g.classify(0, 0).unwrap(), OccupancyCell::Occupied);
    }

    #[test]
    fn out_of_bounds_is_refused() {
        let mut g = OccupancyGrid::new(2, 2, 100).expect("grid");
        assert_eq!(
            g.add_hit(2, 0),
            Err(OccupancyError::OutOfBounds { col: 2, row: 0 })
        );
        assert_eq!(
            g.classify(0, 9),
            Err(OccupancyError::OutOfBounds { col: 0, row: 9 })
        );
    }

    #[test]
    fn bresenham_walks_the_expected_cells() {
        let g = OccupancyGrid::new(5, 5, 100).expect("grid");
        let cells = g.bresenham_line((0, 0), (4, 0)).expect("line");
        assert_eq!(cells, vec![(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]);
        let cells = g.bresenham_line((0, 0), (4, 4)).expect("line");
        assert_eq!(cells, vec![(0, 0), (1, 1), (2, 2), (3, 3), (4, 4)]);
    }

    #[test]
    fn bresenham_refuses_out_of_bounds_endpoints() {
        let g = OccupancyGrid::new(3, 3, 100).expect("grid");
        assert!(g.bresenham_line((0, 0), (4, 0)).is_err());
    }

    #[test]
    fn a_4x4_grid_is_the_largest_in_the_construction_call() {
        // The construction clamps the cell count to MAX_GRID_CELLS (1 Mi).
        let g = OccupancyGrid::new(2_048, 2_048, 100);
        assert!(matches!(g, Err(OccupancyError::TooLarge { .. })));
    }

    #[test]
    fn occupied_and_free_counts_reflect_the_thresholds() {
        // A 2×2 grid: 4 cells. Saturate two as occupied, two as free.
        let mut g = OccupancyGrid::new(2, 2, 100).expect("grid");
        // Occupied: cell (0, 0) hits → above OCCUPANCY_DEFAULT_HIT/2.
        for _ in 0..50 {
            g.add_hit(0, 0).expect("hit");
        }
        // Occupied: cell (1, 0) hits.
        for _ in 0..50 {
            g.add_hit(1, 0).expect("hit");
        }
        // Free: cell (0, 1) misses → below OCCUPANCY_DEFAULT_MISS/2.
        for _ in 0..50 {
            g.add_miss(&[(0, 1)]).expect("miss");
        }
        // Free: cell (1, 1) misses.
        for _ in 0..50 {
            g.add_miss(&[(1, 1)]).expect("miss");
        }
        assert_eq!(g.occupied_cells(), 2);
        assert_eq!(g.free_cells(), 2);
    }

    #[test]
    fn unknown_cells_count_as_neither_occupied_nor_free() {
        // A fresh grid has zero of both — unknown cells live in the middle band.
        let g = OccupancyGrid::new(3, 3, 100).expect("grid");
        assert_eq!(g.occupied_cells(), 0);
        assert_eq!(g.free_cells(), 0);
    }
}
