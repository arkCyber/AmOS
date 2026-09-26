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

/// Largest log-odds a cell can carry (positive — a saturated "occupied" cell).
///
/// // chosen: half `i16::MAX`, so the clamp sits well inside the type's range and a
/// saturating add can never reach the edge — a bound this module picked for headroom, not a
/// figure from any paper.
pub const OCCUPANCY_MAX_BOUND: i16 = i16::MAX / 2;
/// Smallest log-odds a cell can carry (negative — a saturated "free" cell).
///
/// // chosen: the mirror of [`OCCUPANCY_MAX_BOUND`], for the same headroom reason.
pub const OCCUPANCY_MIN_BOUND: i16 = -(i16::MAX / 2);
/// Log-odds increment for a single "occupied" hit (positive).
///
/// // chosen: a policy log-odds step, not a measured likelihood. `80` clears the
/// `Occupied` threshold (`OCCUPANCY_DEFAULT_HIT / 2`) in one hit, which is what a
/// per-cell accumulator should do when a scanner names the cell directly.
pub const OCCUPANCY_DEFAULT_HIT: i16 = 80;
/// Log-odds decrement for a single "free" miss (negative).
///
/// // chosen: deliberately **half** the hit magnitude (−40 vs +80), a policy ratio rather
/// than a sensor figure — it takes two free sweeps to neutralise one hit, so a single
/// spurious return is not erased by the next ray that grazes the cell.
pub const OCCUPANCY_DEFAULT_MISS: i16 = -40;

/// One cell's accumulated log-odds (a saturated `i16`).
pub type OccupancyLogodds = i16;

/// Occupancy state per cell — three values (occupied, free, unknown), kept as an enum so
/// callers never compare against a magic number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OccupancyCell {
    /// `L ≥ OCCUPANCY_DEFAULT_HIT / 2` (positive): the cell is occupied.
    Occupied,
    /// `L ≤ OCCUPANCY_DEFAULT_MISS / 2` (negative — `OCCUPANCY_DEFAULT_MISS` is itself
    /// negative, so this is `L ≤ −20`, not `L ≤ +20`): the cell is free.
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
    /// The resolution was zero. Zero millimetres per cell makes every world-to-cell
    /// division undefined, so the grid cannot exist. It is its own variant because it is
    /// not a size problem — reporting it as `TooLarge` (with a fabricated `0,0` payload)
    /// told a caller nothing about what to fix.
    ZeroResolution,
}

impl std::fmt::Display for OccupancyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OccupancyError::OutOfBounds { col, row } => write!(
                f,
                "cell ({col}, {row}) is outside the grid: a hit or miss list may only name \
                 cells the map holds"
            ),
            OccupancyError::TooLarge { cols, rows } => write!(
                f,
                "a {cols}x{rows} grid exceeds the {}-cell ceiling",
                crate::planning::MAX_GRID_CELLS
            ),
            OccupancyError::ZeroResolution => write!(
                f,
                "the resolution is 0 mm per cell: every world-to-cell division would be \
                 undefined"
            ),
        }
    }
}

impl std::error::Error for OccupancyError {}

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
            return Err(OccupancyError::ZeroResolution);
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

    /// Move the world origin: the millimetre coordinates of cell `(0, 0)`'s north-west
    /// **corner** — the *same* convention as [`crate::planning::Grid::with_origin`], which is
    /// the layer that owns world↔cell conversion, so a value read here and passed there lands
    /// where it was meant to.
    ///
    /// A **corner**, not a centre: [`crate::planning::Grid::cell_centre`] adds the half-cell
    /// offset back, and [`crate::planning::Grid::world_to_cell`] floors `position − origin`,
    /// so cell `(0, 0)` is the half-open box `[origin, origin + res)`. An earlier revision of
    /// this doc called it the cell's **centre** *while claiming it matched the planner* — the
    /// two cannot both be true, and a caller who believed the "centre" reading would place a
    /// handed-over map half a cell (resolution / 2) off, the same half-cell class the planner's
    /// `cell_centre` doc warns about.
    pub fn with_origin(mut self, north_mm: i64, east_mm: i64) -> Self {
        self.origin_north_mm = north_mm;
        self.origin_east_mm = east_mm;
        self
    }

    /// The world origin `(north_mm, east_mm)` — the millimetre coordinates of cell
    /// `(0, 0)`'s north-west **corner** (see [`OccupancyGrid::with_origin`]). Read it to
    /// carry the placement into a [`crate::planning::Grid`] (`Grid::new(..).with_origin(..)`),
    /// which is the layer that owns world↔cell conversion; this mapper stores only the origin
    /// and reinterprets it the same way the planner does.
    pub fn origin(&self) -> (i64, i64) {
        (self.origin_north_mm, self.origin_east_mm)
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

    /// True when the grid has no cells. Unreachable through [`new`](Self::new) (a
    /// zero-dimension grid allocates zero cells only if `cols == 0 || rows == 0`, which
    /// `checked_mul` accepts but which no caller requests), so it exists for the
    /// `clippy::len_without_is_empty` contract rather than as a state the mapper produces.
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

    /// Add a miss (each listed cell is marked free).
    ///
    /// A ray cast is the *real* update, but the bounded inner loop says "no Bresenham
    /// here" — the caller passes the intermediate cells (`bresenham_line`) and this routine
    /// just walks them. The split keeps the inner loop bounded by `O(radius)` and the
    /// caller's job easy to test in isolation.
    ///
    /// **All cells are validated before any is written.** A list containing an
    /// out-of-bounds cell is refused with the grid untouched — the same "validate the whole
    /// batch before mutating" rule the drivers and `ControlLoop` keep — so a caller that
    /// reads `Err` can rely on nothing having changed, rather than wondering which prefix of
    /// the ray was applied.
    pub fn add_miss(&mut self, cells: &[(u32, u32)]) -> Result<(), OccupancyError> {
        // ① Validate the whole batch before mutating anything.
        for &(col, row) in cells {
            if self.index(col, row).is_none() {
                return Err(OccupancyError::OutOfBounds { col, row });
            }
        }
        // ② Apply. Every index was validated above, so the write cannot fail.
        for &(col, row) in cells {
            if let Some(idx) = self.index(col, row) {
                if let Some(slot) = self.cells.get_mut(idx) {
                    *slot = slot
                        .saturating_add(OCCUPANCY_DEFAULT_MISS)
                        .clamp(OCCUPANCY_MIN_BOUND, OCCUPANCY_MAX_BOUND);
                }
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
    ///
    /// The walk is bounded even though the loop has no counter: each iteration advances
    /// `x` or `y` toward the endpoint (the Bresenham error term guarantees at least one
    /// axis moves), and the walk stops at the endpoint or on the first step outside the
    /// grid. It can therefore take no more than `dx + dy ≤ cols + rows` steps — the grid
    /// extent — so a hostile pair of endpoints cannot spin the loop.
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

    /// The classified map as a **row-major `bool` mask** (`true` = occupied), in the order
    /// the private `index` helper uses — the exact shape
    /// [`crate::planning::Grid::from_occupancy`] takes, so a mapped world can be handed to
    /// the planner in one call. `Free` and `Unknown` both map to `false`: the planner treats
    /// anything not proven blocked as traversable-unknown, and it is the caller's job to
    /// inflate a footprint.
    ///
    /// This is the bridge the module doc names ("consumed by
    /// [`crate::planning::Grid`]"); before it, the only way across was a hand-rolled
    /// `classify` loop over every cell, which no test or example did.
    pub fn occupied_mask(&self) -> Vec<bool> {
        self.cells
            .iter()
            .map(|v| *v >= OCCUPANCY_DEFAULT_HIT / 2)
            .collect()
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

    /// A zero resolution is its own error — not `TooLarge` with a fabricated `0,0` payload.
    #[test]
    fn a_zero_resolution_is_refused_with_its_own_error() {
        let g = OccupancyGrid::new(4, 4, 0);
        assert!(
            matches!(g, Err(OccupancyError::ZeroResolution)),
            "got {g:?}"
        );
    }

    /// Every variant renders one operator-facing line — the contract the sibling error types
    /// hold, and one this enum lacked entirely (`{:?}` was the only option).
    #[test]
    fn every_occupancy_error_renders_its_cause() {
        let rendered = [
            OccupancyError::OutOfBounds { col: 9, row: 4 },
            OccupancyError::TooLarge {
                cols: 4096,
                rows: 4096,
            },
            OccupancyError::ZeroResolution,
        ]
        .map(|e| e.to_string());
        for line in &rendered {
            assert!(!line.is_empty(), "every error needs a message");
            assert!(
                !line.contains("OccupancyError"),
                "the message must describe the cause, not the type: {line}"
            );
        }
        for (i, a) in rendered.iter().enumerate() {
            for b in rendered.iter().skip(i + 1) {
                assert_ne!(a, b, "two distinct faults must not render identically");
            }
        }
        assert!(
            rendered[0].contains('9') && rendered[0].contains('4'),
            "the out-of-bounds cell must name itself: {}",
            rendered[0]
        );
        assert!(
            rendered[1].contains("4096x4096"),
            "the size message must name the shape that was asked for: {}",
            rendered[1]
        );
        assert!(
            rendered[1].contains(&crate::planning::MAX_GRID_CELLS.to_string()),
            "…and quote the real ceiling, so the caller knows what to shrink to: {}",
            rendered[1]
        );
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
        // **One** miss is already enough: `classify`'s free threshold is
        // `OCCUPANCY_DEFAULT_MISS / 2 = −40 / 2 = −20`, and a single miss drops the cell to
        // −40 ≤ −20. (An earlier comment here said "two misses" while the body called
        // `add_miss` three times; neither matched the threshold.)
        g.add_miss(&[(0, 0)]).expect("miss");
        assert_eq!(g.classify(0, 0).unwrap(), OccupancyCell::Free);
    }

    /// The `Occupied` boundary is **inclusive**: a hit (+80) followed by a miss (−40) leaves
    /// the cell at exactly `+40`, which equals `OCCUPANCY_DEFAULT_HIT / 2`, and `classify`
    /// reads `v >= threshold` — so the cell stays `Occupied` by a margin of zero. (An earlier
    /// comment here reasoned "still above the threshold (40/2 = 20)", which is not the rule:
    /// the threshold is `OCCUPANCY_DEFAULT_HIT / 2 = 40`, and the cell sits *on* it.)
    #[test]
    fn a_hit_and_a_miss_leave_the_cell_exactly_on_the_occupied_boundary() {
        let mut g = OccupancyGrid::new(2, 2, 100).expect("grid");
        g.add_hit(0, 0).expect("hit");
        g.add_miss(&[(0, 0)]).expect("miss");
        assert_eq!(g.get(0, 0).unwrap(), OCCUPANCY_DEFAULT_HIT / 2);
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

    /// `index`'s bounds check has **two axes**, and both must be refused.
    ///
    /// **Correction (REQ-A877 / F-SH-283).** This test used to exercise the `col` axis only —
    /// `add_hit(2, 0)` is caught by `col >= self.cols`, and `classify(0, 9)` (col 0 in range,
    /// row 9 over a 2-row map) *looks* like a row case but is not the deciding one: `get`
    /// reads the map through `self.cells.get(idx)`, whose own `Option` refuses an
    /// out-of-range index, so `index`'s `row >= self.rows` leaf is shadowed on that path.
    /// Neutralising the leaf (`row >= self.rows` → `false`) left all 19 `slam::occupancy`
    /// tests green.
    #[test]
    fn out_of_bounds_is_refused() {
        let mut g = OccupancyGrid::new(2, 2, 100).expect("grid");
        // The `col` axis, both bound forms.
        assert_eq!(
            g.add_hit(2, 0),
            Err(OccupancyError::OutOfBounds { col: 2, row: 0 })
        );
        assert_eq!(
            g.classify(0, 9),
            Err(OccupancyError::OutOfBounds { col: 0, row: 9 })
        );
        // The `row` axis, with `col` in range — the axis the sibling leaves are *not*
        // shadowed by (`add_miss`/`bresenham_line` below are where the leaf is the only
        // refusal).
        assert_eq!(
            g.add_hit(0, 2),
            Err(OccupancyError::OutOfBounds { col: 0, row: 2 })
        );
        assert_eq!(
            g.classify(0, 2),
            Err(OccupancyError::OutOfBounds { col: 0, row: 2 })
        );
    }

    /// The update must be atomic: a list with a bad cell anywhere is refused with the grid
    /// **untouched**, so a caller that reads `Err` need not wonder what half-applied. This
    /// is the same "validate the whole batch before mutating" rule the drivers and
    /// `ControlLoop` keep; an `add_miss` that wrote its valid prefix first would leave the
    /// map in a state no error message describes.
    ///
    /// The out-of-range cell is a **row**-only case (`(0, 2)`) on purpose: `add_miss`
    /// validates through `index` alone — unlike `get`/`add_hit`, it has no `cells.get(idx)`
    /// backstop on the *refusal* path (its write loop silently skips a `None` slot) — so
    /// `index`'s `row >= self.rows` leaf is the **only** thing that refuses this batch.
    /// Neutralised, `add_miss` returns `Ok(())` and drops the cell without writing it,
    /// contradicting the "refused with the grid untouched" promise above.
    #[test]
    fn a_miss_list_with_a_bad_cell_leaves_the_grid_untouched() {
        let mut g = OccupancyGrid::new(2, 2, 100).expect("grid");
        g.add_hit(0, 0).expect("hit");
        let before = g.get(0, 0).expect("cell");
        // (0, 0) is valid; (9, 9) is over the `col` bound, (0, 2) over the `row` bound.
        assert_eq!(
            g.add_miss(&[(0, 0), (9, 9)]),
            Err(OccupancyError::OutOfBounds { col: 9, row: 9 })
        );
        assert_eq!(
            g.add_miss(&[(0, 0), (0, 2)]),
            Err(OccupancyError::OutOfBounds { col: 0, row: 2 }),
            "a row-only out-of-range cell must be refused, not silently skipped"
        );
        assert_eq!(
            g.get(0, 0).expect("cell"),
            before,
            "a refused batch must not have applied its valid prefix"
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

    /// Both endpoint axes are refused, and on **both** ends of the segment.
    ///
    /// The `col` case (`(0, 0) → (4, 0)`) was the only one here, and it is the one
    /// `index`'s `col >= self.cols` leaf decides. `bresenham_line` validates each endpoint
    /// through `index` and has no secondary `cells.get` backstop, so the `row >= self.rows`
    /// leaf is the sole refusal for a row-out-of-range endpoint — neutralised,
    /// `bresenham_line((0, 0), (0, 2))` returns `Ok` on a 2-row map (REQ-A877 / F-SH-283).
    #[test]
    fn bresenham_refuses_out_of_bounds_endpoints() {
        let g = OccupancyGrid::new(3, 3, 100).expect("grid");
        // `col` over the bound, on the `to` and on the `from` end.
        assert!(g.bresenham_line((0, 0), (4, 0)).is_err());
        assert!(g.bresenham_line((4, 0), (0, 0)).is_err());
        // `row` over the bound, `col` in range, on the `to` and on the `from` end.
        assert!(g.bresenham_line((0, 0), (0, 4)).is_err());
        assert!(g.bresenham_line((0, 4), (0, 0)).is_err());
    }

    #[test]
    fn a_grid_over_the_cell_ceiling_is_refused() {
        // 2048² = 4,194,304 cells, over `planning::MAX_GRID_CELLS` (1 << 20 = 1,048,576).
        // (An earlier name here read "a_4x4_grid_is_the_largest_in_the_construction_call",
        // which describes neither this body nor any 4×4 grid.)
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

    #[test]
    fn every_cell_state_has_a_stable_key() {
        assert_eq!(OccupancyCell::Occupied.key(), "occupied");
        assert_eq!(OccupancyCell::Free.key(), "free");
        assert_eq!(OccupancyCell::Unknown.key(), "unknown");
    }

    #[test]
    fn the_shape_getters_report_what_was_asked_for() {
        let g = OccupancyGrid::new(3, 5, 250).expect("grid");
        assert_eq!(g.cols(), 3);
        assert_eq!(g.rows(), 5);
        assert_eq!(g.resolution_mm(), 250);
        assert_eq!(g.len(), 15);
        assert!(!g.is_empty());
    }

    /// `with_origin` used to be write-only: nothing read the two fields it set, so a caller
    /// could believe the grid was placed in the world when it was not. The value must be
    /// readable, and the default must be the origin cell centre `(0, 0)`.
    #[test]
    fn the_origin_is_readable_and_defaults_to_zero() {
        let g = OccupancyGrid::new(2, 2, 100).expect("grid");
        assert_eq!(g.origin(), (0, 0));
        let placed = g.clone().with_origin(-1_000, 500);
        assert_eq!(placed.origin(), (-1_000, 500));
        // And it is the *only* difference — the cells are untouched by placement.
        assert_eq!(placed.get(0, 0), g.get(0, 0));
    }

    /// `with_origin` promises the value carries over to `planning::Grid::with_origin`
    /// unchanged, so the two must agree on what the number *means*. The planner defines it as
    /// the north-west **corner** of cell `(0, 0)` (`Grid::with_origin`, `Grid::cell_centre`),
    /// so cell `(0, 0)` *is* `[origin, origin + res)` and its centre lies half a cell in. This
    /// module's doc once called it the cell's **centre** while claiming the conventions
    /// matched — a half-cell lie in the same family as the planner's own `cell_centre` fix.
    /// The test fails if the planner ever changes its convention; it cannot fail on a doc
    /// edit, since docs are not executable (that half of the fix is prose only, recorded as
    /// such).
    #[test]
    fn the_origin_agrees_with_the_planners_corner_convention() {
        use crate::planning::{Cell, Grid};
        let map = OccupancyGrid::new(2, 2, 500)
            .expect("map")
            .with_origin(1_000, -2_000);
        let (north, east) = map.origin();
        let grid = Grid::new(2, 2, 500).expect("grid").with_origin(north, east);
        // If the origin were the cell's *centre*, cell (0, 0) would centre on it; as a
        // *corner*, the centre is half a cell (250 mm) north and east of it.
        assert_eq!(grid.cell_centre(Cell::new(0, 0)), Some((1_250, -1_750)));
        // …and a world point exactly at the origin is inside cell (0, 0), not half a cell
        // away, because the cell is the half-open box `[origin, origin + res)`.
        assert_eq!(grid.world_to_cell(1_000, -2_000), Some(Cell::new(0, 0)));
    }

    /// The bridge the module doc names: the mask is exactly what `classify` says, cell for
    /// cell, and the planner accepts it at the same shape. `Free` **and** `Unknown` both map
    /// to `false` — the planner's rule is "not proven blocked", not "proven free".
    #[test]
    fn the_occupied_mask_matches_classify_and_feeds_the_planner() {
        let mut g = OccupancyGrid::new(3, 2, 500).expect("grid");
        // (1, 0) occupied; (0, 1) free; everything else unknown.
        for _ in 0..50 {
            g.add_hit(1, 0).expect("hit");
        }
        for _ in 0..50 {
            g.add_miss(&[(0, 1)]).expect("miss");
        }
        let mask = g.occupied_mask();
        assert_eq!(mask.len(), 6, "one bool per cell");
        // Row-major, column fastest — the order `Grid::from_occupancy` uses.
        assert_eq!(mask, vec![false, true, false, false, false, false]);

        // Every cell's mask bit agrees with its classification (occupied <=> true).
        for row in 0..2u32 {
            for col in 0..3u32 {
                let occupied = g.classify(col, row).expect("classify") == OccupancyCell::Occupied;
                assert_eq!(mask[(row * 3 + col) as usize], occupied);
            }
        }

        // The planner accepts the mask at this shape, and sees exactly the blocked cell —
        // which is the whole point of the bridge.
        let grid = crate::planning::Grid::from_occupancy(&mask, 3, 2, 500).expect("shape");
        assert!(grid.is_blocked(crate::planning::Cell::new(1, 0)));
        assert_eq!(grid.blocked_cells(), 1);
        // The free cell is traversable-unknown, not blocked: a mapper's "free" does not
        // become the planner's "obstacle".
        assert!(!grid.is_blocked(crate::planning::Cell::new(0, 1)));
    }
}
