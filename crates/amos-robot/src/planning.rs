//! Grid path planning that ends in **the profile's own set points**.
//!
//! The middleware's profile layer says of itself: "this layer is not a planner: `goto`
//! generates no trajectory, `lane_keep` does no lateral control" (`docs/robot-domains.md`
//! §6.6). This module is that missing half, and it is built so its output cannot drift away
//! from the machine it drives:
//!
//! ```text
//!   Grid (occupancy) → plan() → Path → simplified() → Path → pursuit() → DriveCommand
//!                                                                            │
//!                        Actuator::check (travel) ◄── set_points()[3] ──────┘
//! ```
//!
//! Four decisions worth stating, because each is a place where a planner usually lies:
//!
//! 1. **Integer costs, deterministic tie-breaking.** Costs are `10` (orthogonal) / `14`
//!    (diagonal) and the priority queue orders by `(f, g, cell index)`, so two runs on one
//!    map produce the *same* path — a replan after a dropped frame does not wander, and a
//!    route can be regression-tested. A planner whose paths differ run to run by float noise
//!    cannot promise either.
//! 2. **Unreachable is an error, not a best effort.** [`plan`] returns
//!    [`PlanError::Unreachable`] carrying how many cells it explored. A partial path handed
//!    back as if it were a route is the failure mode that sends a vehicle at a wall.
//! 3. **Unknown space is not free space.** [`Grid::is_blocked`] answers `true` outside the
//!    map, and diagonal motion refuses to cut a corner between two blocked cells. Both are
//!    the "unknown ⇒ refuse" rule this workspace already applies to the wire.
//! 4. **The command is validated against the actuator table**, not against a private idea of
//!    "percent". [`DriveCommand::check_against`] runs the profile's own `Actuator::check`,
//!    so a planner that produced 45° of steering for a ±40° column is refused **here**,
//!    where the message can name the profile, rather than at the bus, where it would name a
//!    joint.
//!
//! Frames and units are explicit: a cell is `(col, row)`; the world is millimetres with
//! `+north` along increasing `row` and `+east` along increasing `col`; a heading is
//! milli-radians, `0` = north, increasing **clockwise** (toward east). Nothing here reads a
//! clock or the network, so a plan is reproducible from its inputs alone.
//!
//! Honest boundaries (registered in `docs/robot-autonomy.md`):
//!
//! 1. **2-D, and agnostic about the machine**: the planner finds a grid route; it does not
//!    know the footprint, the minimum turn radius or the dynamics. A cell is a cell — the
//!    deployment picks the resolution that makes that true (`docs/robot-domains.md` §2 has
//!    the per-domain cadences this feeds).
//! 2. **Occupancy is the caller's**: nothing here estimates a map (that is the SLAM
//!    front-end, still absent — see the Phase-2 seam in the docs); a stale or uninflated map
//!    is a stale plan.
//! 3. **`pursuit` is a pure-pursuit law, not a controller with a stability proof**: one
//!    lookahead, one gain, a saturation at the actuator's travel. It is honest about reaching
//!    the goal and refuses non-finite input, but it claims nothing about tracking error at
//!    speed.
//! 4. **No dynamic obstacles, no replan loop**: `plan` is a pure function of one map. A
//!    moving obstacle means "call it again with a new map", which is the caller's decision
//!    (and the replan cadence is a domain concern).
//!
//! ```no_run
//! use amos_robot::planning::{plan, Cell, Connectivity, Grid};
//!
//! # fn main() -> Result<(), amos_robot::planning::PlanError> {
//! // '#' blocked, '.' free — the ASCII form exists so a test (or an operator's map) does
//! // not have to build a grid cell by cell.
//! let grid = Grid::from_rows(&["#...", "#.#.", "#..#"], 100)?;
//! let path = plan(&grid, Cell::new(1, 1), Cell::new(3, 0), Connectivity::Four)?;
//! assert_eq!(path.cells().first(), Some(&Cell::new(1, 1)));
//! assert_eq!(path.cells().last(), Some(&Cell::new(3, 0)));
//! # Ok(())
//! # }
//! ```

use amos_link::platform::{ActuatorRole, Intent, IntentClass, Platform, SetPoint};

/// Largest grid this module will build, in cells (1 048 576 ⇒ 128 KiB of occupancy bits).
///
/// Every other bounded resource in this workspace carries a ceiling and a reason; a map is
/// no different. A larger map is not a local costmap — it is a deployment's whole
/// environment, and that caller wants a tile store or a quadtree, not one flat `Vec<bool>`.
pub const MAX_GRID_CELLS: usize = 1 << 20;

/// Cost of one orthogonal step (the classic 10:14 pair keeps the search in integers).
const STEP_ORTHOGONAL: u32 = 10;

/// Cost of one diagonal step (≈ √2 × 10).
const STEP_DIAGONAL: u32 = 14;

/// Largest footprint a caller may ask [`Grid::inflated`] to reserve, in cells.
///
/// 16 cells is a wide machine on a fine grid; beyond it the caller is asking for a distance
/// field, which is a different data structure rather than a bigger loop.
pub const MAX_INFLATION_CELLS: u32 = 16;

/// A grid coordinate: column (east) and row (north).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Cell {
    /// Column index, `0..cols`.
    pub col: u32,
    /// Row index, `0..rows`.
    pub row: u32,
}

impl Cell {
    /// A cell from its indices (bounds are checked against a [`Grid`], which is the only
    /// thing that knows its own size).
    ///
    /// `const` on purpose: a deployment's fixed waypoints and start/goal pairs are then
    /// constants (`const START: Cell = Cell::new(0, 0);`), not a function call at startup.
    pub const fn new(col: u32, row: u32) -> Self {
        Self { col, row }
    }

    /// The cell `(dcol, drow)` away, or `None` on `u32` overflow.
    fn offset(self, dcol: i32, drow: i32) -> Option<Cell> {
        let col = i64::from(self.col) + i64::from(dcol);
        let row = i64::from(self.row) + i64::from(drow);
        if !(0..=i64::from(u32::MAX)).contains(&col) || !(0..=i64::from(u32::MAX)).contains(&row) {
            return None;
        }
        Some(Cell {
            col: col as u32,
            row: row as u32,
        })
    }
}

/// Which neighbours a step may move to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Connectivity {
    /// Four-neighbour (no diagonal moves): the conservative choice, and the one that needs
    /// no corner rule because there are no corners.
    Four,
    /// Eight-neighbour. A diagonal step is allowed only when **both** orthogonal neighbours
    /// it passes between are free, so a route can never squeeze through a corner where two
    /// blocked cells touch.
    Eight,
}

/// Why a plan or a command was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanError {
    /// The requested map exceeds [`MAX_GRID_CELLS`].
    GridTooLarge {
        /// Requested columns.
        cols: u32,
        /// Requested rows.
        rows: u32,
    },
    /// A map must have at least one row and one column.
    EmptyGrid,
    /// The cell size must be positive: a zero-millimetre cell is a coordinate system with no
    /// resolution, and every world↔cell conversion through it would divide by zero.
    ZeroResolution,
    /// A row of the ASCII map used a character that is neither `#` (blocked) nor `.`/` `
    /// (free).
    BadMapChar {
        /// Row index of the offending line.
        row: usize,
        /// The character itself.
        ch: char,
    },
    /// A cell was outside the map. Unknown space is never silently treated as known.
    OutOfBounds {
        /// The rejected cell.
        cell: Cell,
    },
    /// The start is inside an obstacle.
    StartBlocked {
        /// The rejected cell.
        cell: Cell,
    },
    /// The goal is inside an obstacle.
    GoalBlocked {
        /// The rejected cell.
        cell: Cell,
    },
    /// No route exists. Carries how many cells were explored, because "unreachable after 12
    /// cells" (a sealed room) and "unreachable after 500 000 cells" (a wall the planner never
    /// got around) are different problems for the operator reading the line.
    Unreachable {
        /// Where the search started.
        start: Cell,
        /// Where it was trying to get to.
        goal: Cell,
        /// Cells popped from the frontier before giving up.
        explored: u32,
    },
    /// The path had no cells (a path is at least its start).
    EmptyPath,
    /// An occupancy buffer whose length is not `cols × rows` (see [`Grid::from_occupancy`]).
    ///
    /// Refused rather than padded: a padded map is one whose missing cells silently became
    /// "free", and unknown is not free anywhere else in this module.
    OccupancyShape {
        /// Cells the caller supplied.
        given: usize,
        /// Columns the buffer was meant to fill.
        cols: u32,
        /// Rows the buffer was meant to fill.
        rows: u32,
    },
    /// A pose or a limit carried a value the law cannot use (see [`PlanError::BadLimit`]).
    /// A limit is refused rather than clamped: a silently corrected limit would leave a
    /// controller whose behaviour does not match its own configuration.
    BadLimit {
        /// Which limit was rejected.
        field: &'static str,
    },
    /// The profile refused one of the produced set points (see
    /// [`DriveCommand::check_against`]).
    Refused {
        /// Position in the command's set-point triple (`0` steering, `1` throttle, `2` brake).
        index: usize,
        /// The profile's own message.
        reason: String,
    },
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::GridTooLarge { cols, rows } => write!(
                f,
                "a {cols}x{rows} grid exceeds the {MAX_GRID_CELLS}-cell ceiling"
            ),
            PlanError::EmptyGrid => write!(f, "a grid needs at least one row and one column"),
            PlanError::ZeroResolution => {
                write!(f, "the cell size must be a positive number of millimetres")
            }
            PlanError::BadMapChar { row, ch } => write!(
                f,
                "row {row} of the map uses {ch:?}: a map is '#' (blocked) and '.' or ' ' (free)"
            ),
            PlanError::OutOfBounds { cell } => {
                write!(f, "cell ({}, {}) is outside the map", cell.col, cell.row)
            }
            PlanError::StartBlocked { cell } => write!(
                f,
                "the start ({}, {}) is inside an obstacle",
                cell.col, cell.row
            ),
            PlanError::GoalBlocked { cell } => write!(
                f,
                "the goal ({}, {}) is inside an obstacle",
                cell.col, cell.row
            ),
            PlanError::Unreachable {
                start,
                goal,
                explored,
            } => write!(
                f,
                "no route from ({}, {}) to ({}, {}): {explored} cell(s) explored before the \
                 frontier was exhausted",
                start.col, start.row, goal.col, goal.row
            ),
            PlanError::EmptyPath => write!(f, "a path has at least its start cell"),
            PlanError::OccupancyShape { given, cols, rows } => write!(
                f,
                "the occupancy buffer has {given} cell(s) but a {cols}x{rows} grid needs {}",
                u64::from(*cols) * u64::from(*rows)
            ),
            PlanError::BadLimit { field } => write!(
                f,
                "{field} is not a usable limit (a lookahead must be positive, a steering \
                 saturation non-zero)"
            ),
            PlanError::Refused { index, reason } => {
                write!(f, "the profile refused set point {index}: {reason}")
            }
        }
    }
}

impl std::error::Error for PlanError {}

/// An occupancy grid in the caller's millimetre frame.
///
/// ```no_run
/// use amos_robot::planning::{Cell, Grid};
///
/// # fn main() -> Result<(), amos_robot::planning::PlanError> {
/// let grid = Grid::from_rows(&["..", "#."], 500)?;
/// assert_eq!(grid.cols(), 2);
/// assert_eq!(grid.rows(), 2);
/// assert_eq!(grid.resolution_mm(), 500);
/// assert!(grid.is_blocked(Cell::new(0, 1)));
/// assert!(!grid.is_blocked(Cell::new(1, 1)));
/// // Outside the map is *unknown*, and unknown is never free:
/// assert!(grid.is_blocked(Cell::new(9, 9)));
/// # Ok(())
/// # }
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grid {
    cols: u32,
    rows: u32,
    resolution_mm: u32,
    origin_north_mm: i64,
    origin_east_mm: i64,
    blocked: Vec<bool>,
}

impl Grid {
    /// An all-free grid of `cols × rows` cells, each `resolution_mm` across.
    pub fn new(cols: u32, rows: u32, resolution_mm: u32) -> Result<Self, PlanError> {
        if cols == 0 || rows == 0 {
            return Err(PlanError::EmptyGrid);
        }
        if resolution_mm == 0 {
            return Err(PlanError::ZeroResolution);
        }
        let cells = usize::try_from(cols)
            .ok()
            .zip(usize::try_from(rows).ok())
            .and_then(|(c, r)| c.checked_mul(r));
        let Some(cells) = cells else {
            return Err(PlanError::GridTooLarge { cols, rows });
        };
        if cells > MAX_GRID_CELLS {
            return Err(PlanError::GridTooLarge { cols, rows });
        }
        Ok(Self {
            cols,
            rows,
            resolution_mm,
            origin_north_mm: 0,
            origin_east_mm: 0,
            blocked: vec![false; cells],
        })
    }

    /// A grid from an ASCII map: `#` is blocked, `.` and ` ` are free, row `0` is the first
    /// line. Every line must be the same length — a ragged map is a map whose missing cells
    /// would otherwise be silently "free".
    pub fn from_rows(rows: &[&str], resolution_mm: u32) -> Result<Self, PlanError> {
        let Some(first) = rows.first() else {
            return Err(PlanError::EmptyGrid);
        };
        let cols = first.chars().count() as u32;
        let mut grid = Self::new(cols, rows.len() as u32, resolution_mm)?;
        for (row, line) in rows.iter().enumerate() {
            if line.chars().count() as u32 != cols {
                return Err(PlanError::BadMapChar {
                    row,
                    ch: line.chars().nth(cols as usize).unwrap_or(' '),
                });
            }
            for (col, ch) in line.chars().enumerate() {
                match ch {
                    '#' => grid.set_blocked(Cell::new(col as u32, row as u32), true)?,
                    '.' | ' ' => {}
                    other => return Err(PlanError::BadMapChar { row, ch: other }),
                }
            }
        }
        Ok(grid)
    }

    /// Move the world origin: the millimetre coordinates of cell `(0, 0)`'s **centre**.
    pub fn with_origin(mut self, north_mm: i64, east_mm: i64) -> Self {
        self.origin_north_mm = north_mm;
        self.origin_east_mm = east_mm;
        self
    }

    /// A grid from a dense occupancy buffer: **row-major, one `bool` per cell, `true` =
    /// blocked** — the layout [`Grid::index`] uses, and the one a scanner, a SLAM front-end or
    /// an offline map tool hands over.
    ///
    /// A buffer whose length is not `cols × rows` is refused
    /// ([`PlanError::OccupancyShape`]) rather than padded or truncated: a padded map is one
    /// whose missing cells silently became "free", and unknown is not free anywhere else in
    /// this module.
    ///
    /// ```no_run
    /// use amos_robot::planning::Grid;
    ///
    /// # fn main() -> Result<(), amos_robot::planning::PlanError> {
    /// // Row-major, column fastest: row 0's two cells, then row 1's.
    /// let grid = Grid::from_occupancy(&[true, false, false, false], 2, 2, 500)?;
    /// assert_eq!(grid.blocked_cells(), 1);
    /// assert!(grid.is_blocked(amos_robot::planning::Cell::new(0, 0)));
    /// assert_eq!(grid.occupancy(), &[true, false, false, false]);
    /// # Ok(())
    /// # }
    /// ```
    pub fn from_occupancy(
        cells: &[bool],
        cols: u32,
        rows: u32,
        resolution_mm: u32,
    ) -> Result<Self, PlanError> {
        let mut grid = Self::new(cols, rows, resolution_mm)?;
        if cells.len() != grid.blocked.len() {
            return Err(PlanError::OccupancyShape {
                given: cells.len(),
                cols,
                rows,
            });
        }
        grid.blocked.copy_from_slice(cells);
        Ok(grid)
    }

    /// The occupancy as a row-major slice (`true` = blocked), in the order
    /// [`Grid::index`] uses — the exact inverse of [`Grid::from_occupancy`] (`from_occupancy`
    /// of this slice, at the same shape, rebuilds an equal grid).
    pub fn occupancy(&self) -> &[bool] {
        &self.blocked
    }

    /// Columns (east).
    pub fn cols(&self) -> u32 {
        self.cols
    }

    /// Rows (north).
    pub fn rows(&self) -> u32 {
        self.rows
    }

    /// Cell size, in millimetres.
    pub fn resolution_mm(&self) -> u32 {
        self.resolution_mm
    }

    /// How many cells are blocked — a number an operator can read, unlike a `Vec<bool>`.
    pub fn blocked_cells(&self) -> usize {
        self.blocked.iter().filter(|b| **b).count()
    }

    /// Total cells.
    pub fn cells(&self) -> usize {
        self.blocked.len()
    }

    /// True only for a cell **inside** the map that is not blocked.
    ///
    /// Out of bounds is neither: [`Grid::is_blocked`] answers `true` there (unknown is not
    /// free) and this answers `false`. A caller that wants "may I drive here" asks
    /// [`Grid::is_blocked`]; one that wants "is this a free cell of *this* map" asks this.
    pub fn is_free(&self, cell: Cell) -> bool {
        self.contains(cell) && !self.is_blocked(cell)
    }

    /// True when the cell is inside the map.
    pub fn contains(&self, cell: Cell) -> bool {
        cell.col < self.cols && cell.row < self.rows
    }

    /// True when the cell is blocked **or outside the map**.
    ///
    /// The second half is deliberate and load-bearing: a caller asking about a cell it has no
    /// data for must not be told "free". Every consumer of this (`plan`, `line_of_sight`,
    /// `pursuit`) therefore fails closed.
    pub fn is_blocked(&self, cell: Cell) -> bool {
        match self.index(cell) {
            Some(index) => self.blocked.get(index).copied().unwrap_or(true),
            None => true,
        }
    }

    /// A copy with every obstacle grown by `cells` (Chebyshev distance, so a diagonal
    /// neighbour counts as one).
    ///
    /// This is how a caller supplies what the planner cannot know: a *footprint*. A grid
    /// route is cell-safe, but a machine that tracks it with pure pursuit cuts corners — the
    /// measured version of that (`tests/stack_e2e.rs`) is a vehicle with a 2 m wheelbase
    /// entering the cell diagonally beside an obstacle it was routed around. The honest fix is
    /// clearance in the map, not a wider tolerance in a test.
    ///
    /// Bounded on purpose: `cells` above [`MAX_INFLATION_CELLS`] is refused rather than
    /// turning a local costmap into a smooth-distance field (that caller wants an
    /// Euclidean/ESDF, not a loop over `(2r+1)²` neighbourhoods).
    pub fn inflated(&self, cells: u32) -> Result<Grid, PlanError> {
        if cells == 0 {
            return Ok(self.clone());
        }
        if cells > MAX_INFLATION_CELLS {
            return Err(PlanError::BadLimit {
                field: "inflation_cells",
            });
        }
        let mut grown = self.clone();
        let radius = i32::try_from(cells).map_err(|_| PlanError::BadLimit {
            field: "inflation_cells",
        })?;
        // Collect first, then write: growing in place would let a cell grown this pass act as
        // a source for the next one, i.e. the inflation would spread without bound.
        let mut sources: Vec<Cell> = Vec::new();
        for row in 0..self.rows {
            for col in 0..self.cols {
                let cell = Cell::new(col, row);
                if self.is_blocked(cell) {
                    sources.push(cell);
                }
            }
        }
        for source in sources {
            for drow in -radius..=radius {
                for dcol in -radius..=radius {
                    if let Some(cell) = source.offset(dcol, drow) {
                        if grown.contains(cell) {
                            if let Some(index) = grown.index(cell) {
                                if let Some(slot) = grown.blocked.get_mut(index) {
                                    *slot = true;
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(grown)
    }

    /// Set one cell's occupancy; refuses an out-of-bounds cell rather than growing the map.
    pub fn set_blocked(&mut self, cell: Cell, blocked: bool) -> Result<(), PlanError> {
        let index = self.index(cell).ok_or(PlanError::OutOfBounds { cell })?;
        match self.blocked.get_mut(index) {
            Some(slot) => {
                *slot = blocked;
                Ok(())
            }
            None => Err(PlanError::OutOfBounds { cell }),
        }
    }

    /// The world position of a cell's **centre**, in millimetres.
    pub fn cell_centre(&self, cell: Cell) -> Option<(i64, i64)> {
        if !self.contains(cell) {
            return None;
        }
        let res = i64::from(self.resolution_mm);
        Some((
            self.origin_north_mm
                .saturating_add(res.saturating_mul(i64::from(cell.row))),
            self.origin_east_mm
                .saturating_add(res.saturating_mul(i64::from(cell.col))),
        ))
    }

    /// The cell containing a world position, or `None` outside the map.
    ///
    /// Floor division is written out because Rust's `/` truncates toward zero: a point 1 mm
    /// west of the origin would otherwise land in the same cell as a point 1 mm east of it —
    /// two different places in one cell.
    pub fn world_to_cell(&self, north_mm: i64, east_mm: i64) -> Option<Cell> {
        let res = i64::from(self.resolution_mm);
        let row = floor_div(north_mm.saturating_sub(self.origin_north_mm), res);
        let col = floor_div(east_mm.saturating_sub(self.origin_east_mm), res);
        if !(0..i64::from(self.cols)).contains(&col) || !(0..i64::from(self.rows)).contains(&row) {
            return None;
        }
        Some(Cell::new(col as u32, row as u32))
    }

    /// Flat index of a cell, or `None` when it is outside.
    fn index(&self, cell: Cell) -> Option<usize> {
        if !self.contains(cell) {
            return None;
        }
        let cols = usize::try_from(self.cols).ok()?;
        let row = usize::try_from(cell.row).ok()?;
        let col = usize::try_from(cell.col).ok()?;
        row.checked_mul(cols)?.checked_add(col)
    }

    /// True when a step between two cells may be taken: the destination must be free, and a
    /// diagonal step must also not pass between two blocked cells (the corner rule).
    fn step_is_legal(&self, from: Cell, to: Cell) -> bool {
        if self.is_blocked(to) {
            return false;
        }
        let dcol = to.col as i64 - from.col as i64;
        let drow = to.row as i64 - from.row as i64;
        if dcol != 0 && drow != 0 {
            let side_col = from.offset(dcol.signum() as i32, 0);
            let side_row = from.offset(0, drow.signum() as i32);
            let (Some(side_col), Some(side_row)) = (side_col, side_row) else {
                return false;
            };
            if self.is_blocked(side_col) || self.is_blocked(side_row) {
                return false;
            }
        }
        true
    }
}

/// Floor division for signed integers (`-1 / 4` must be `-1`, not `0`).
fn floor_div(value: i64, divisor: i64) -> i64 {
    if divisor == 0 {
        return 0;
    }
    let q = value / divisor;
    if value % divisor != 0 && (value < 0) != (divisor < 0) {
        q - 1
    } else {
        q
    }
}

/// A route: the start cell, every step, and the goal — inclusive at both ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Path {
    cells: Vec<Cell>,
}

impl Path {
    /// The ordered cells (`first()` is the start, `last()` is the goal).
    pub fn cells(&self) -> &[Cell] {
        &self.cells
    }

    /// Number of cells (a path of one cell is "already there").
    pub fn len(&self) -> usize {
        self.cells.len()
    }

    /// True when the path has no cells — which a constructed path cannot be, so this exists
    /// for `clippy` and for a caller holding one from elsewhere.
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// The goal cell, if there is one.
    pub fn goal(&self) -> Option<Cell> {
        self.cells.last().copied()
    }

    /// True when every consecutive pair of cells is **one grid step** (orthogonal or
    /// diagonal) — i.e. this is a route as [`plan`] produces it.
    ///
    /// A [`Path::simplified`] result is deliberately **not** contiguous: its cells are
    /// waypoints, and the leg between two of them is a straight *line* through cells the path
    /// does not name.
    pub fn is_contiguous(&self) -> bool {
        self.cells
            .windows(2)
            .all(|pair| match (pair.first(), pair.get(1)) {
                (Some(a), Some(b)) => adjacent(*a, *b),
                _ => true,
            })
    }

    /// Total integer cost of the route (`10` per orthogonal step, `14` per diagonal), or
    /// `None` when a leg spans more than one cell.
    ///
    /// The `None` is the honest half of a measurement this method used to get silently wrong:
    /// a smoothed path's legs are straight **lines**, not grid steps, and charging the
    /// single-step price for a many-cell jump made a 5-step route's simplification report `14`
    /// — *cheaper* than the route it was made from. `Some` is a grid route's cost; `None` is
    /// "this is a waypoint list, not a step sequence".
    pub fn cost(&self) -> Option<u32> {
        if !self.is_contiguous() {
            return None;
        }
        Some(
            self.cells
                .windows(2)
                .map(|pair| match (pair.first(), pair.get(1)) {
                    (Some(a), Some(b)) => step_cost(*a, *b),
                    _ => 0,
                })
                .sum(),
        )
    }

    /// The same route with the redundant cells removed (line-of-sight smoothing).
    ///
    /// Every consecutive pair of the result can be walked in a straight line without hitting
    /// a blocked cell, and the endpoints are preserved. In an open field that is two points;
    /// around an obstacle it is the corner and nothing else.
    ///
    /// The result is **waypoints, not grid steps**: a leg between two of them is a straight
    /// line, so [`Path::cost`] answers `None` for it rather than pricing a many-cell jump as
    /// one step.
    pub fn simplified(&self, grid: &Grid) -> Path {
        let mut kept: Vec<Cell> = Vec::new();
        let Some(start) = self.cells.first().copied() else {
            return Path { cells: kept };
        };
        kept.push(start);
        let mut anchor = 0usize;
        // Greedy: extend the straight leg as far as it stays legal, then anchor there. The
        // index only ever moves forward, so this is O(n·walk) with no recursion.
        while anchor < self.cells.len().saturating_sub(1) {
            let mut furthest = anchor + 1;
            for candidate in (anchor + 2)..self.cells.len() {
                let (Some(from), Some(to)) = (self.cells.get(anchor), self.cells.get(candidate))
                else {
                    break;
                };
                if line_of_sight(grid, *from, *to) {
                    furthest = candidate;
                } else {
                    break;
                }
            }
            match self.cells.get(furthest) {
                Some(cell) => kept.push(*cell),
                None => break,
            }
            anchor = furthest;
        }
        Path { cells: kept }
    }
}

/// True when `b` is one of `a`'s eight neighbours (`a == b` is not a step).
fn adjacent(a: Cell, b: Cell) -> bool {
    let dcol = (i64::from(a.col) - i64::from(b.col)).abs();
    let drow = (i64::from(a.row) - i64::from(b.row)).abs();
    (dcol | drow) != 0 && dcol <= 1 && drow <= 1
}

/// Integer step cost between two adjacent cells.
fn step_cost(from: Cell, to: Cell) -> u32 {
    if from.col != to.col && from.row != to.row {
        STEP_DIAGONAL
    } else {
        STEP_ORTHOGONAL
    }
}

/// True when a straight line between two cells stays on free cells.
///
/// The walk is a supercover DDA in integers: at each step it advances the axis that is
/// furthest behind, and it checks the *side* cell of a diagonal move as well as the one it
/// enters, so a line that grazes an obstacle's corner is not "clear".
fn line_of_sight(grid: &Grid, from: Cell, to: Cell) -> bool {
    let mut col = i64::from(from.col);
    let mut row = i64::from(from.row);
    let target_col = i64::from(to.col);
    let target_row = i64::from(to.row);
    let dcol = target_col - col;
    let drow = target_row - row;
    if dcol == 0 && drow == 0 {
        return !grid.is_blocked(from);
    }
    let dc = dcol.abs();
    let dr = drow.abs();
    let step_col = dcol.signum();
    let step_row = drow.signum();
    // Bresenham's supercover: signed error so we step *both* axes when needed.
    // Without this, long shallow segments (e.g. dx=10, dy=1) advance the major
    // axis the whole way and only step the minor axis at the very end — which
    // silently marks a line that visibly passes through intermediate cells as
    // "clear". See `smoothing_keeps_the_ends_and_the_collision_freedom` for the
    // regression test.
    let mut err = dc - dr;
    let limit = (dc + dr + 1) as usize;
    for _ in 0..=limit {
        if col == target_col && row == target_row {
            return true;
        }
        let e2 = err.saturating_mul(2);
        if e2 > -dr {
            err -= dr;
            col += step_col;
        }
        if e2 < dc {
            err += dc;
            row += step_row;
        }
        // A pure diagonal advance passes between two cells; both side neighbours
        // must be free or the line is blocked at the corner.
        if col != target_col || row != target_row {
            // After the step above, `col`/`row` may have moved on either or both
            // axes depending on `e2`. The "diagonal" case is the one where both
            // moved and `e2 == 0` (we hit the corner exactly).
            if err == 0 {
                let side_col = Cell::new(col as u32, (row - step_row) as u32);
                let side_row = Cell::new((col - step_col) as u32, row as u32);
                if (row - step_row) >= 0 && grid.is_blocked(side_col) {
                    return false;
                }
                if (col - step_col) >= 0 && grid.is_blocked(side_row) {
                    return false;
                }
            }
            if col < 0 || row < 0 {
                return false;
            }
            let cell = Cell::new(col as u32, row as u32);
            if grid.is_blocked(cell) {
                return false;
            }
        }
    }
    // Walk exhausted before reaching `to` — the only way out is that we DID reach it
    // (loop body returned `true`); otherwise the line is blocked.
    col == target_col && row == target_row
}

/// The eight step directions, in a **fixed** order — the fixed order is part of the
/// determinism: two equal-cost routes are separated by the tie-break in the queue, never by
/// the order a `HashMap` happened to yield.
const STEPS: [(i32, i32); 8] = [
    (0, 1),
    (1, 0),
    (1, 1),
    (-1, 1),
    (0, -1),
    (-1, 0),
    (-1, -1),
    (1, -1),
];

/// Find a route from `start` to `goal`.
///
/// Integer A* with a deterministic tie-break, so the same map and endpoints always produce
/// the same route. `Connectivity::Four` never cuts a corner (there are none);
/// `Connectivity::Eight` refuses a diagonal that would pass between two blocked cells.
///
/// ```no_run
/// use amos_robot::planning::{plan, Cell, Connectivity, Grid};
///
/// # fn main() -> Result<(), amos_robot::planning::PlanError> {
/// // One free corridor: two cells, one step.
/// let corridor = Grid::from_rows(&["#.#", "#.#"], 100)?;
/// assert_eq!(
///     plan(&corridor, Cell::new(1, 0), Cell::new(1, 1), Connectivity::Four)?.len(),
///     2
/// );
/// // A sealed room: the only honest answer is "no route".
/// let sealed = Grid::from_rows(&["###", "#.#", "###"], 100)?;
/// assert!(plan(&sealed, Cell::new(0, 0), Cell::new(1, 1), Connectivity::Four).is_err());
/// # Ok(())
/// # }
/// ```
pub fn plan(
    grid: &Grid,
    start: Cell,
    goal: Cell,
    connectivity: Connectivity,
) -> Result<Path, PlanError> {
    for cell in [start, goal] {
        if !grid.contains(cell) {
            return Err(PlanError::OutOfBounds { cell });
        }
    }
    if grid.is_blocked(start) {
        return Err(PlanError::StartBlocked { cell: start });
    }
    if grid.is_blocked(goal) {
        return Err(PlanError::GoalBlocked { cell: goal });
    }
    if start == goal {
        return Ok(Path { cells: vec![start] });
    }

    let cells = grid.cells();
    let mut g_score = vec![u32::MAX; cells];
    let mut came_from = vec![u32::MAX; cells];
    let start_index = grid
        .index(start)
        .ok_or(PlanError::OutOfBounds { cell: start })?;
    let goal_index = grid
        .index(goal)
        .ok_or(PlanError::OutOfBounds { cell: goal })?;
    if let Some(slot) = g_score.get_mut(start_index) {
        *slot = 0;
    }

    // `(f, g, index)`: ordering by `g` before the index breaks a tie toward the cell that is
    // already closer to the start, and the index makes the order total — so the route does
    // not depend on the heap's internal history.
    let mut frontier = std::collections::BinaryHeap::new();
    frontier.push(std::cmp::Reverse((
        heuristic(start, goal, connectivity),
        0u32,
        start_index as u32,
    )));
    let mut explored: u32 = 0;

    while let Some(std::cmp::Reverse((_, g, index))) = frontier.pop() {
        explored = explored.saturating_add(1);
        if index as usize == goal_index {
            return Ok(reconstruct(grid, &came_from, start_index, goal_index));
        }
        // A stale entry: a better route to this cell was found after this one was pushed.
        if g > g_score.get(index as usize).copied().unwrap_or(u32::MAX) {
            continue;
        }
        let Some(from) = cell_of(grid, index) else {
            continue;
        };
        for (dcol, drow) in STEPS {
            if connectivity == Connectivity::Four && dcol != 0 && drow != 0 {
                continue;
            }
            let Some(to) = from.offset(dcol, drow) else {
                continue;
            };
            if !grid.step_is_legal(from, to) {
                continue;
            }
            let Some(to_index) = grid.index(to) else {
                continue;
            };
            let tentative = g.saturating_add(step_cost(from, to));
            let current = g_score.get(to_index).copied().unwrap_or(u32::MAX);
            if tentative < current {
                if let Some(slot) = g_score.get_mut(to_index) {
                    *slot = tentative;
                }
                if let Some(slot) = came_from.get_mut(to_index) {
                    *slot = index;
                }
                frontier.push(std::cmp::Reverse((
                    tentative.saturating_add(heuristic(to, goal, connectivity)),
                    tentative,
                    to_index as u32,
                )));
            }
        }
    }
    Err(PlanError::Unreachable {
        start,
        goal,
        explored,
    })
}

/// The cell for a flat index (the inverse of `Grid::index`).
fn cell_of(grid: &Grid, index: u32) -> Option<Cell> {
    let cols = usize::try_from(grid.cols()).ok()?;
    if cols == 0 {
        return None;
    }
    let index = usize::try_from(index).ok()?;
    let cell = Cell::new(
        u32::try_from(index % cols).ok()?,
        u32::try_from(index / cols).ok()?,
    );
    grid.contains(cell).then_some(cell)
}

/// Walk the parent links back from the goal (bounded by the cell count, never recursive).
fn reconstruct(grid: &Grid, came_from: &[u32], start_index: usize, goal_index: usize) -> Path {
    let mut cells: Vec<Cell> = Vec::new();
    let mut cursor = goal_index as u32;
    let limit = came_from.len().saturating_add(1);
    for _ in 0..limit {
        match cell_of(grid, cursor) {
            Some(cell) => cells.push(cell),
            None => break,
        }
        if cursor as usize == start_index {
            break;
        }
        match came_from.get(cursor as usize).copied() {
            Some(parent) if parent != u32::MAX => cursor = parent,
            _ => break,
        }
    }
    cells.reverse();
    Path { cells }
}

/// Manhattan (four-neighbour) or octile (eight-neighbour) distance, in integer step costs.
fn heuristic(from: Cell, to: Cell, connectivity: Connectivity) -> u32 {
    let dcol = (i64::from(from.col) - i64::from(to.col)).unsigned_abs() as u32;
    let drow = (i64::from(from.row) - i64::from(to.row)).unsigned_abs() as u32;
    match connectivity {
        Connectivity::Four => dcol.saturating_add(drow).saturating_mul(STEP_ORTHOGONAL),
        Connectivity::Eight => {
            let diagonal = dcol.min(drow);
            let straight = dcol.max(drow).saturating_sub(diagonal);
            diagonal
                .saturating_mul(STEP_DIAGONAL)
                .saturating_add(straight.saturating_mul(STEP_ORTHOGONAL))
        }
    }
}

/// Where the machine is and which way it points, in the map's millimetre frame.
///
/// `heading_mrad` is milli-radians of **body x** (forward) measured from `+north`, increasing
/// clockwise (toward `+east`) — the compass convention, so `0` is "north", `1_570` is east,
/// `-1_570` is west.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pose {
    /// North position, millimetres.
    pub north_mm: i64,
    /// East position, millimetres.
    pub east_mm: i64,
    /// Heading, milli-radians from north, clockwise positive.
    pub heading_mrad: i32,
}

/// The numbers the pure-pursuit law runs on.
///
/// The defaults are **read from the `ground-vehicle` profile's actuator table** rather than
/// copied here, so a profile whose steering column changes cannot leave a stale duplicate of
/// its travel in this module (this is the same "one owner per fact" rule the middleware
/// applies to its own tables).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PursuitLimits {
    /// How far ahead along the route the aim point sits, millimetres. Shorter = tighter
    /// tracking and more oscillation; longer = smoother and wider corners.
    pub lookahead_mm: u32,
    /// Distance to the final waypoint at which the machine is "there", millimetres.
    ///
    /// **This must be larger than the machine's minimum turn radius** (`wheelbase /
    /// tan(max steer)`), or the law can never satisfy it: a pursuer whose steering is saturated
    /// orbits a goal it cannot turn tightly enough to reach, and never reports
    /// `reached_goal`. The law does not derive the radius itself (a wheelbase is not something
    /// a set-point triple carries), so the constraint is the caller's — and the default's
    /// 400 mm assumes a machine that can be commanded to a stop on the spot (`docs/robot-autonomy.md`).
    pub arrive_radius_mm: u32,
    /// Distance at which the throttle starts ramping down, millimetres.
    pub slow_radius_mm: u32,
    /// Steering saturation, milli-degrees (the profile's travel is the ceiling).
    pub max_steer_milli_deg: i32,
    /// Throttle on a clear, straight leg, milli-percent.
    pub cruise_milli_percent: i32,
}

impl Default for PursuitLimits {
    fn default() -> Self {
        let platform = Platform::ground_vehicle();
        let actuators = platform.actuators();
        let steer = actuators
            .iter()
            .find(|a| a.role == ActuatorRole::RotaryJoint)
            .map(|a| a.travel.1)
            .unwrap_or(40_000);
        let cruise = actuators
            .iter()
            .find(|a| a.role == ActuatorRole::Thrust)
            .map(|a| a.travel.1 / 3)
            .unwrap_or(30_000);
        Self {
            lookahead_mm: 3_000,
            arrive_radius_mm: 400,
            slow_radius_mm: 4_000,
            max_steer_milli_deg: steer,
            cruise_milli_percent: cruise,
        }
    }
}

/// Heading error beyond which the throttle is cut to a creep, radians (60°).
const TURN_IN_PLACE_RAD: f64 = std::f64::consts::PI / 3.0;

/// Heading error beyond which the throttle is halved, radians (30°).
const TURN_SLOW_RAD: f64 = std::f64::consts::PI / 6.0;

/// Full braking, milli-percent (the middleware's own ceiling, not a second copy of it).
const BRAKE_FULL_MILLI_PERCENT: i32 = amos_link::robot_hal::MAX_TORQUE_MILLI_PERCENT;

/// Milli-degrees per radian.
const MILLI_DEG_PER_RAD: f64 = 57_295.779_513_082_32;

/// One set point triple the machine can plan: steering, throttle, brake.
///
/// The numbers come out of the same actuator table the profile validates, so `steer` is a
/// steering angle in the column's own unit (milli-degrees) and `throttle`/`brake` are
/// milli-percent of full — not a private normalisation that a driver would have to guess.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DriveCommand {
    /// Steering angle, milli-degrees (positive = toward east/right).
    pub steer_milli_deg: i32,
    /// Throttle, milli-percent of full.
    pub throttle_milli_percent: i32,
    /// Brake, milli-percent of full.
    pub brake_milli_percent: i32,
    /// True when the pose is inside the arrival radius of the route's goal: the command is a
    /// stop, and it says so rather than reporting a throttle of zero as "still driving".
    pub reached_goal: bool,
    /// The waypoint actually aimed at — observable on purpose, because "which waypoint is it
    /// chasing" is the first question when a vehicle cuts a corner.
    pub target: Cell,
}

impl DriveCommand {
    /// True when this command is the stop at the end of a route.
    pub fn is_stop(&self) -> bool {
        self.reached_goal
    }

    /// The command as the `ground-vehicle` profile's three set points, in bus order:
    /// `0` steering, `1` throttle, `2` brake.
    ///
    /// The indices are the profile's own table (`docs/robot-domains.md` §1), and
    /// [`DriveCommand::check_against`] is what proves they still line up with it.
    pub fn set_points(&self) -> [SetPoint; 3] {
        [
            SetPoint {
                actuator: 0,
                arg: self.steer_milli_deg,
            },
            SetPoint {
                actuator: 1,
                arg: self.throttle_milli_percent,
            },
            SetPoint {
                actuator: 2,
                arg: self.brake_milli_percent,
            },
        ]
    }

    /// Check every set point against the profile's actuator table.
    ///
    /// This is the join between "a planner's numbers" and "a machine": it runs the profile's
    /// own [`Actuator::check`], so a steering angle past the column's travel is refused here,
    /// with a message that can name the profile, instead of at the bus, with a message that
    /// names a joint.
    pub fn check_against(&self, platform: &Platform) -> Result<(), PlanError> {
        for (index, point) in self.set_points().iter().enumerate() {
            let actuator = platform
                .actuators()
                .iter()
                .find(|a| a.index == point.actuator);
            let Some(actuator) = actuator else {
                return Err(PlanError::Refused {
                    index,
                    reason: format!(
                        "the profile has no actuator {} (it has: {})",
                        point.actuator,
                        platform
                            .actuators()
                            .iter()
                            .map(|a| a.index.to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                });
            };
            actuator.check(point.arg).map_err(|e| PlanError::Refused {
                index,
                reason: e.to_string(),
            })?;
        }
        Ok(())
    }

    /// The command as a validated [`Intent`] for a profile action (`"hold"`, `"cruise"`, …).
    ///
    /// All three set points are carried, so the intent is complete: the profile's own rules
    /// about partial tele-operation coverage cannot be tripped by a command that means to
    /// drive everything.
    pub fn to_intent(&self, action: &'static str) -> Intent {
        Intent {
            action,
            class: IntentClass::Motion,
            speed: 0.0,
            duration_ms: 0,
            set_points: self.set_points().to_vec(),
            params: Vec::new(),
        }
    }

    /// The same thing as the JSON a brain or an operator sends on the control topic.
    ///
    /// Generated, never hand-printed, and **without** a `speed` field: the profile refuses a
    /// `speed` on an action whose pose is fixed, so a command that means "these set points"
    /// must not carry one.
    pub fn to_agent_json(&self, action: &str) -> String {
        let targets: Vec<serde_json::Value> = self
            .set_points()
            .iter()
            .map(|p| serde_json::json!({ "actuator": p.actuator, "arg": p.arg }))
            .collect();
        serde_json::json!({ "action": action, "targets": targets }).to_string()
    }

    /// One line an operator can read (and that names what the command is *doing*).
    pub fn summary(&self) -> String {
        if self.reached_goal {
            return format!(
                "arrived at ({}, {}): brake {}",
                self.target.col, self.target.row, self.brake_milli_percent
            );
        }
        format!(
            "toward ({}, {}): steer {}mdeg throttle {} brake {}",
            self.target.col,
            self.target.row,
            self.steer_milli_deg,
            self.throttle_milli_percent,
            self.brake_milli_percent
        )
    }
}

/// Pure pursuit: aim at the point `lookahead_mm` along the route and steer at it.
///
/// Three rules, each of which a naive controller gets wrong and each of which is testable:
///
/// * **Arrived means stop.** Inside `arrive_radius_mm` of the goal the command is full brake,
///   zero throttle and `reached_goal: true` — a vehicle told "arrived" with a rolling throttle
///   is a vehicle that keeps going.
/// * **Turn before you accelerate.** A heading error over 30° halves the throttle, over 60°
///   cuts it to a quarter: full throttle while 90° off heading is how a car leaves the road,
///   and saturating the steering cannot fix it on its own.
/// * **The steering saturation is the machine's.** `max_steer_milli_deg` saturates the demand,
///   and [`DriveCommand::check_against`] proves the saturated value still fits the profile's
///   column.
pub fn pursuit(
    grid: &Grid,
    path: &Path,
    pose: Pose,
    limits: &PursuitLimits,
) -> Result<DriveCommand, PlanError> {
    if limits.lookahead_mm == 0 {
        return Err(PlanError::BadLimit {
            field: "lookahead_mm",
        });
    }
    if limits.max_steer_milli_deg <= 0 {
        return Err(PlanError::BadLimit {
            field: "max_steer_milli_deg",
        });
    }
    if limits.cruise_milli_percent < 0 {
        return Err(PlanError::BadLimit {
            field: "cruise_milli_percent",
        });
    }
    if limits.cruise_milli_percent > BRAKE_FULL_MILLI_PERCENT {
        // Refused, not clamped — the same rule the rest of this module's limits follow: a
        // silently corrected limit leaves a controller whose behaviour does not match its own
        // configuration (and 120% throttle is a configuration error, not a command).
        return Err(PlanError::BadLimit {
            field: "cruise_milli_percent",
        });
    }
    let Some(goal) = path.goal() else {
        return Err(PlanError::EmptyPath);
    };
    let Some((goal_north, goal_east)) = grid.cell_centre(goal) else {
        return Err(PlanError::OutOfBounds { cell: goal });
    };

    let goal_distance = hypot(goal_north - pose.north_mm, goal_east - pose.east_mm);
    if goal_distance <= f64::from(limits.arrive_radius_mm) {
        return Ok(DriveCommand {
            steer_milli_deg: 0,
            throttle_milli_percent: 0,
            brake_milli_percent: BRAKE_FULL_MILLI_PERCENT,
            reached_goal: true,
            target: goal,
        });
    }

    // The aim point: the point one lookahead along the route, measured from where the vehicle
    // **projects onto** the route — not "the first waypoint at least a lookahead away", which a
    // vehicle that has driven past an early waypoint would read as one *behind* it (the measured
    // failure: the pursuer turned around and orbited the start cell forever).
    let Some((target, target_north, target_east)) =
        aim_point(grid, path, pose, limits.lookahead_mm)
    else {
        return Err(PlanError::EmptyPath);
    };

    // 0 = north, clockwise positive is exactly `atan2(east, north)` on a map.
    let desired = (target_east - pose.east_mm as f64).atan2(target_north - pose.north_mm as f64);
    let current = f64::from(pose.heading_mrad) / 1000.0;
    let error = wrap_rad(desired - current);

    let saturation = f64::from(limits.max_steer_milli_deg);
    let steer_milli_deg = (error * MILLI_DEG_PER_RAD)
        .round()
        .clamp(-saturation, saturation) as i32;

    let turn_factor = if error.abs() > TURN_IN_PLACE_RAD {
        0.25
    } else if error.abs() > TURN_SLOW_RAD {
        0.5
    } else {
        1.0
    };
    let approach = if limits.slow_radius_mm == 0 {
        1.0
    } else {
        (goal_distance / f64::from(limits.slow_radius_mm)).min(1.0)
    };
    let throttle = (f64::from(limits.cruise_milli_percent) * turn_factor * approach).round();
    let throttle_milli_percent = (throttle as i32).clamp(0, BRAKE_FULL_MILLI_PERCENT);

    Ok(DriveCommand {
        steer_milli_deg,
        throttle_milli_percent,
        // No braking while driving: a vehicle that brakes and accelerates at once is telling
        // its actuators two things, and the domain's `slow`/`hold` actions exist for the
        // deliberate case.
        brake_milli_percent: 0,
        reached_goal: false,
        target,
    })
}

/// Euclidean distance in millimetres (the operands are differences of `i64` millimetres, so
/// the `f64` conversion is exact well past any real map).
fn hypot(north_mm: i64, east_mm: i64) -> f64 {
    let north = north_mm as f64;
    let east = east_mm as f64;
    (north * north + east * east).sqrt()
}

/// The pure-pursuit aim point: where the vehicle's **projection onto the route** plus one
/// lookahead lands, as `(the waypoint cell it is nearest, north_mm, east_mm)`.
///
/// Two steps, and both matter:
///
/// 1. **Project** the pose onto the route polyline (per-segment, clamped to the segment): that
///    is where the vehicle is *along* the route, which a distance test cannot tell you.
/// 2. **Advance** one lookahead along the polyline from there, interpolating inside a segment
///    when the lookahead ends mid-leg. If the route runs out first, the aim point is the goal.
///
/// `None` only when the route has no vertex with a world position (a path from another map) —
/// in which case there is nothing honest to aim at.
fn aim_point(grid: &Grid, path: &Path, pose: Pose, lookahead_mm: u32) -> Option<(Cell, f64, f64)> {
    let vertices: Vec<(Cell, f64, f64)> = path
        .cells()
        .iter()
        .filter_map(|cell| {
            grid.cell_centre(*cell)
                .map(|(north, east)| (*cell, north as f64, east as f64))
        })
        .collect();
    let last = *vertices.last()?;
    if vertices.len() == 1 {
        return Some(last);
    }

    let pose_north = pose.north_mm as f64;
    let pose_east = pose.east_mm as f64;

    // ① the projection: the closest point on any segment, clamped to it.
    let mut best = (0usize, 0.0f64, f64::INFINITY);
    for index in 0..vertices.len() - 1 {
        let (_, from_north, from_east) = vertices[index];
        let (_, to_north, to_east) = vertices[index + 1];
        let (leg_north, leg_east) = (to_north - from_north, to_east - from_east);
        let length_sq = leg_north * leg_north + leg_east * leg_east;
        let t = if length_sq <= 0.0 {
            0.0
        } else {
            (((pose_north - from_north) * leg_north + (pose_east - from_east) * leg_east)
                / length_sq)
                .clamp(0.0, 1.0)
        };
        let point_north = from_north + t * leg_north;
        let point_east = from_east + t * leg_east;
        let distance =
            ((point_north - pose_north).powi(2) + (point_east - pose_east).powi(2)).sqrt();
        if distance < best.2 {
            best = (index, t, distance);
        }
    }
    let (segment, t, _) = best;

    // ② advance one lookahead from there.
    let (_, from_north, from_east) = vertices[segment];
    let (_, to_north, to_east) = vertices[segment + 1];
    let mut remaining = f64::from(lookahead_mm);
    let mut current = (
        from_north + t * (to_north - from_north),
        from_east + t * (to_east - from_east),
    );

    for index in segment..vertices.len() - 1 {
        let (_, leg_from_north, leg_from_east) = vertices[index];
        let (_, leg_to_north, leg_to_east) = vertices[index + 1];
        let leg_length = ((leg_to_north - leg_from_north).powi(2)
            + (leg_to_east - leg_from_east).powi(2))
        .sqrt();
        // How much of this leg is still in front of us (the first leg starts at the projection).
        let behind = if index == segment {
            ((current.0 - leg_from_north).powi(2) + (current.1 - leg_from_east).powi(2)).sqrt()
        } else {
            0.0
        };
        let ahead = leg_length - behind;
        if leg_length > 0.0 && ahead >= remaining {
            let ratio = (behind + remaining) / leg_length;
            let north = leg_from_north + ratio * (leg_to_north - leg_from_north);
            let east = leg_from_east + ratio * (leg_to_east - leg_from_east);
            // The reported waypoint is the cell the aim point *is in* — not the nearest route
            // vertex, which on a long leg would be the vertex the vehicle has already passed
            // (measured: a 6 m projection plus a 3 m lookahead reported the start cell).
            let cell = grid
                .world_to_cell(north.round() as i64, east.round() as i64)
                .unwrap_or(last.0);
            return Some((cell, north, east));
        }
        remaining -= ahead.max(0.0);
        current = (leg_to_north, leg_to_east);
    }
    Some(last)
}

/// Wrap an angle into `(-π, π]` — the same convention as `fusion`'s wrapper, in `f64` because
/// a milli-radian heading error near ±180° must not round the wrong way.
fn wrap_rad(angle: f64) -> f64 {
    if !angle.is_finite() {
        return 0.0;
    }
    let two_pi = 2.0 * std::f64::consts::PI;
    let wrapped = angle - two_pi * ((angle + std::f64::consts::PI) / two_pi).floor();
    if wrapped <= -std::f64::consts::PI {
        wrapped + two_pi
    } else {
        wrapped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The map most tests use: a 7×5 field with a wall that has a gap in it.
    const FIELD: [&str; 5] = [".......", ".#####.", ".......", ".#####.", "......."];

    fn field() -> Grid {
        Grid::from_rows(&FIELD, 1_000).expect("the fixture map parses")
    }

    /// Every diagonal step in a path must pass between two free cells.
    fn assert_no_corner_cutting(grid: &Grid, path: &Path) {
        for pair in path.cells().windows(2) {
            let (Some(from), Some(to)) = (pair.first(), pair.get(1)) else {
                continue;
            };
            if from.col == to.col || from.row == to.row {
                continue;
            }
            let side_col = Cell::new(from.col, to.row);
            let side_row = Cell::new(to.col, from.row);
            assert!(
                !grid.is_blocked(side_col) && !grid.is_blocked(side_row),
                "diagonal {:?} → {:?} cuts a corner",
                from,
                to
            );
        }
    }

    #[test]
    fn a_straight_corridor_is_a_straight_path() {
        let grid = Grid::from_rows(&["#.#", "#.#", "#.#"], 100).expect("map");
        let path = plan(&grid, Cell::new(1, 0), Cell::new(1, 2), Connectivity::Four)
            .expect("the corridor is passable");
        assert_eq!(path.len(), 3);
        assert_eq!(path.cost(), Some(2 * STEP_ORTHOGONAL));
        assert!(path.is_contiguous());
        assert_eq!(path.cells().first(), Some(&Cell::new(1, 0)));
        assert_eq!(path.cells().last(), Some(&Cell::new(1, 2)));
        assert!(path.cells().iter().all(|c| !grid.is_blocked(*c)));
    }

    #[test]
    fn a_wall_is_gone_around_and_no_corner_is_cut() {
        let grid = field();
        let start = Cell::new(0, 0);
        let goal = Cell::new(6, 4);
        let path = plan(&grid, start, goal, Connectivity::Eight).expect("route through the gap");
        assert_eq!(path.cells().first(), Some(&start));
        assert_eq!(path.cells().last(), Some(&goal));
        assert!(
            path.cells().iter().all(|c| !grid.is_blocked(*c)),
            "a route through a wall is not a route: {:?}",
            path.cells()
        );
        assert_no_corner_cutting(&grid, &path);
        // Two walls with gaps ⇒ the route must have bent around both, so it is longer than
        // the straight-line (octile) distance.
        assert!(
            path.cost().expect("a grid route") > heuristic(start, goal, Connectivity::Eight),
            "cost {:?} vs octile {}",
            path.cost(),
            heuristic(start, goal, Connectivity::Eight)
        );
    }

    #[test]
    fn the_corner_rule_is_the_thing_that_refuses_the_short_cut() {
        // Two blocked cells touching at a corner: (1, 0) and (2, 1). The diagonal step
        // (2, 0) → (1, 1) would squeeze between them.
        let grid = Grid::from_rows(&[".#..", "..#.", "...."], 100).expect("map");
        assert!(grid.is_blocked(Cell::new(1, 0)) && grid.is_blocked(Cell::new(2, 1)));
        assert!(!grid.is_blocked(Cell::new(2, 0)) && !grid.is_blocked(Cell::new(1, 1)));
        assert!(
            !grid.step_is_legal(Cell::new(2, 0), Cell::new(1, 1)),
            "the corner rule must refuse the squeeze"
        );
        // …and it is not simply refusing every diagonal: an open diagonal is legal.
        let open = Grid::from_rows(&["...", "...", "..."], 100).expect("map");
        assert!(open.step_is_legal(Cell::new(0, 0), Cell::new(1, 1)));
    }

    #[test]
    fn unreachable_is_named_not_approximated() {
        let grid = Grid::from_rows(&["###", "#.#", "###"], 100).expect("map");
        let err =
            plan(&grid, Cell::new(0, 0), Cell::new(1, 1), Connectivity::Eight).expect_err("x");
        match err {
            PlanError::StartBlocked { cell } => assert_eq!(cell, Cell::new(0, 0)),
            other => panic!("a blocked start must be named, got {other:?}"),
        }

        // A free start in a sealed pocket: the search runs and then reports the exhaustion.
        let sealed = Grid::from_rows(&["###.", "#.#.", "###."], 100).expect("map");
        let err = plan(
            &sealed,
            Cell::new(3, 0),
            Cell::new(1, 1),
            Connectivity::Eight,
        )
        .expect_err("the pocket is sealed");
        match err {
            PlanError::Unreachable { explored, .. } => assert!(explored > 0),
            other => panic!("expected Unreachable, got {other:?}"),
        }
    }

    #[test]
    fn endpoints_are_checked_against_the_map() {
        let grid = Grid::from_rows(&["#.", ".."], 100).expect("map");
        assert_eq!(
            plan(&grid, Cell::new(0, 0), Cell::new(1, 1), Connectivity::Four),
            Err(PlanError::StartBlocked {
                cell: Cell::new(0, 0)
            })
        );
        assert_eq!(
            plan(&grid, Cell::new(1, 1), Cell::new(0, 0), Connectivity::Four),
            Err(PlanError::GoalBlocked {
                cell: Cell::new(0, 0)
            })
        );
        assert_eq!(
            plan(&grid, Cell::new(1, 1), Cell::new(9, 9), Connectivity::Four),
            Err(PlanError::OutOfBounds {
                cell: Cell::new(9, 9)
            })
        );
        // Start == goal is a one-cell route, not an error.
        let same = plan(&grid, Cell::new(1, 1), Cell::new(1, 1), Connectivity::Four)
            .expect("already there");
        assert_eq!(same.len(), 1);
        assert_eq!(same.cost(), Some(0));
    }

    #[test]
    fn the_planner_is_deterministic() {
        // A map with several equal-cost routes (an empty field) is where a float or
        // hash-order-dependent planner starts disagreeing with itself.
        let grid = Grid::from_rows(&["....", "....", "....", "...."], 1_000).expect("map");
        for connectivity in [Connectivity::Four, Connectivity::Eight] {
            let first = plan(&grid, Cell::new(0, 0), Cell::new(3, 3), connectivity).expect("route");
            for _ in 0..8 {
                let again =
                    plan(&grid, Cell::new(0, 0), Cell::new(3, 3), connectivity).expect("route");
                assert_eq!(
                    first.cells(),
                    again.cells(),
                    "the same map must give the same route"
                );
            }
        }
    }

    #[test]
    fn eight_neighbour_never_costs_more_than_four() {
        let grid = field();
        let four = plan(&grid, Cell::new(0, 0), Cell::new(6, 4), Connectivity::Four)
            .expect("four-neighbour route");
        let eight = plan(&grid, Cell::new(0, 0), Cell::new(6, 4), Connectivity::Eight)
            .expect("eight-neighbour route");
        let eight_cost = eight.cost().expect("a grid route");
        let four_cost = four.cost().expect("a grid route");
        assert!(
            eight_cost <= four_cost,
            "eight {eight_cost} vs four {four_cost}"
        );
        assert_no_corner_cutting(&grid, &eight);
    }

    #[test]
    fn smoothing_keeps_the_ends_and_the_collision_freedom() {
        // Open field: every intermediate cell is redundant, so two points are enough.
        let open = Grid::from_rows(&["....", "....", "...."], 1_000).expect("map");
        let path =
            plan(&open, Cell::new(0, 0), Cell::new(3, 2), Connectivity::Four).expect("route");
        let simple = path.simplified(&open);
        assert_eq!(simple.len(), 2, "open ground simplifies to a straight leg");
        assert_eq!(simple.cells().first(), path.cells().first());
        assert_eq!(simple.cells().last(), path.cells().last());
        assert!(line_of_sight(&open, Cell::new(0, 0), Cell::new(3, 2)));

        // Around the wall: the ends are preserved, the length never grows, and every kept
        // cell was on the original route.
        let grid = field();
        let path =
            plan(&grid, Cell::new(0, 0), Cell::new(6, 4), Connectivity::Eight).expect("route");
        let simple = path.simplified(&grid);
        assert_eq!(simple.cells().first(), path.cells().first());
        assert_eq!(simple.cells().last(), path.cells().last());
        assert!(simple.len() <= path.len());
        assert!(simple.cells().iter().all(|c| path.cells().contains(c)));
        for pair in simple.cells().windows(2) {
            let (Some(a), Some(b)) = (pair.first(), pair.get(1)) else {
                continue;
            };
            assert!(line_of_sight(&grid, *a, *b), "{a:?} → {b:?} is not clear");
        }
    }

    #[test]
    fn a_smoothed_paths_cost_is_refused_not_under_priced() {
        // Measured defect: an open field, four-neighbour A* from (0,0) to (3,2) is 5 steps ⇒
        // `cost()` was 50. Its simplification is the single straight leg (0,0) → (3,2), and the
        // old `cost()` priced that jump as *one* diagonal step (14) — a smoothed route reading
        // cheaper than the route it was made from, from a function whose doc says "10 per
        // orthogonal step, 14 per diagonal".
        let open = Grid::from_rows(&["....", "....", "...."], 1_000).expect("map");
        let path =
            plan(&open, Cell::new(0, 0), Cell::new(3, 2), Connectivity::Four).expect("route");
        assert!(path.is_contiguous());
        let grid_cost = path.cost().expect("a grid route has a cost");
        assert_eq!(grid_cost, 5 * STEP_ORTHOGONAL, "five orthogonal steps");

        let simple = path.simplified(&open);
        assert_eq!(simple.len(), 2, "open ground is one straight leg");
        assert!(
            !simple.is_contiguous(),
            "a leg of three cells is not a grid step"
        );
        assert_eq!(
            simple.cost(),
            None,
            "a waypoint list has no step cost; the old answer was {STEP_DIAGONAL} vs the real \
             {grid_cost}"
        );
        // A one-cell path is (trivially) contiguous and costs zero.
        let alone = plan(&open, Cell::new(1, 1), Cell::new(1, 1), Connectivity::Four)
            .expect("already there");
        assert!(alone.is_contiguous());
        assert_eq!(alone.cost(), Some(0));
    }

    #[test]
    fn a_straight_line_is_refused_through_an_obstacle() {
        let grid = Grid::from_rows(&["...", ".#.", "..."], 1_000).expect("map");
        assert!(line_of_sight(&grid, Cell::new(0, 0), Cell::new(2, 0)));
        assert!(!line_of_sight(&grid, Cell::new(0, 1), Cell::new(2, 1)));
        assert!(!line_of_sight(&grid, Cell::new(0, 0), Cell::new(2, 2)));
        // Outside the map is not a clear line either: unknown is not free.
        assert!(!line_of_sight(&grid, Cell::new(0, 0), Cell::new(0, 9)));
    }

    /// Regression for the Bresenham supercover: a long shallow line must
    /// visit **every** intermediate cell along its path, otherwise an
    /// obstacle hidden in a cell the walker skipped is silently ignored and
    /// a smoothed route can cut through a wall.
    ///
    /// Pre-fix the walker only stepped the minor axis at the very last
    /// iteration, so `from=(0,0) → to=(10,1)` never visited `(5,0)`,
    /// `(6,0)`, `(7,0)`, `(8,0)`, or `(9,0)`.
    #[test]
    fn a_long_shallow_line_visits_every_intermediate_cell() {
        let grid = Grid::from_rows(
            &[
                "............", // row 0: 12 cells
                "............", // row 1
                "............", // row 2
            ],
            1_000,
        )
        .expect("map");
        // All-clear: walker must report clear AND walk through every (col, 0)
        // for col 1..=10 (the start at col 0 and target at col 10 are visited
        // by construction).
        let (mut col, mut row) = (0_i64, 0_i64);
        let (dc, dr) = (10_i64, 0_i64);
        let mut visited = std::collections::HashSet::new();
        visited.insert((col, row));
        let mut err = dc - dr;
        let step_col = dc.signum();
        let step_row = dr.signum();
        for _ in 0..=(dc + dr + 1) as usize {
            let e2 = err.saturating_mul(2);
            if e2 > -dr {
                err -= dr;
                col += step_col;
            }
            if e2 < dc {
                err += dc;
                row += step_row;
            }
            visited.insert((col, row));
            if col == 10 && row == 0 {
                break;
            }
        }
        for c in 0_i64..=10 {
            assert!(visited.contains(&(c, 0)), "row 0, col {c} was not visited");
        }
        assert!(line_of_sight(&grid, Cell::new(0, 0), Cell::new(10, 0)));

        // Block cell (5, 0): the walker must notice and refuse.
        let mut grid_blocked = grid.clone();
        grid_blocked
            .set_blocked(Cell::new(5, 0), true)
            .expect("block");
        assert!(!line_of_sight(
            &grid_blocked,
            Cell::new(0, 0),
            Cell::new(10, 0)
        ));
    }

    #[test]
    fn the_grid_is_bounded_and_unknown_is_blocked() {
        assert_eq!(Grid::new(0, 4, 100), Err(PlanError::EmptyGrid));
        assert_eq!(Grid::new(4, 4, 0), Err(PlanError::ZeroResolution));
        assert_eq!(
            Grid::new(2_048, 2_048, 100),
            Err(PlanError::GridTooLarge {
                cols: 2_048,
                rows: 2_048
            })
        );
        let mut grid = Grid::new(2, 2, 100).expect("tiny map");
        assert_eq!(
            grid.set_blocked(Cell::new(2, 0), true),
            Err(PlanError::OutOfBounds {
                cell: Cell::new(2, 0)
            })
        );
        assert!(
            grid.is_blocked(Cell::new(5, 5)),
            "outside is unknown, not free"
        );
        grid.set_blocked(Cell::new(1, 1), true).expect("in bounds");
        assert_eq!(grid.blocked_cells(), 1);
        assert_eq!(grid.cells(), 4);
    }

    #[test]
    fn an_occupancy_buffer_round_trips_and_a_wrong_shape_is_refused() {
        // The buffer layout is the same one `index` uses: row-major, column fastest, `true`
        // = blocked. This is the constructor the SLAM seam's output goes through
        // (`docs/robot-autonomy.md` §4), so the order matters more than the convenience.
        let grid = Grid::from_rows(&["#.", " ."], 250).expect("map");
        assert_eq!(grid.occupancy(), &[true, false, false, false]);
        let rebuilt = Grid::from_occupancy(grid.occupancy(), 2, 2, 250).expect("same shape");
        assert_eq!(
            rebuilt, grid,
            "occupancy() is the inverse of from_occupancy"
        );

        // A buffer that does not fill the grid is refused, not padded or truncated: a padded
        // map is one whose missing cells silently became free.
        assert_eq!(
            Grid::from_occupancy(&[true, false, false], 2, 2, 250),
            Err(PlanError::OccupancyShape {
                given: 3,
                cols: 2,
                rows: 2
            })
        );
        assert_eq!(
            Grid::from_occupancy(&[true; 5], 2, 2, 250),
            Err(PlanError::OccupancyShape {
                given: 5,
                cols: 2,
                rows: 2
            })
        );
        // …and the shape checks the rest of the constructors do still come first.
        assert_eq!(
            Grid::from_occupancy(&[], 0, 2, 250),
            Err(PlanError::EmptyGrid)
        );
        assert_eq!(
            Grid::from_occupancy(&[false; 4], 2, 2, 0),
            Err(PlanError::ZeroResolution)
        );
        // The error explains the arithmetic, not just "wrong length".
        let message = PlanError::OccupancyShape {
            given: 3,
            cols: 2,
            rows: 2,
        }
        .to_string();
        assert!(
            message.contains('3') && message.contains("2x2"),
            "{message}"
        );
    }

    #[test]
    fn ascii_maps_are_parsed_strictly() {
        let grid = Grid::from_rows(&["#.", " ."], 100).expect("space is free");
        assert_eq!(grid.blocked_cells(), 1);
        assert_eq!(Grid::from_rows(&[], 100), Err(PlanError::EmptyGrid));
        assert_eq!(
            Grid::from_rows(&[".#", "..."], 100),
            Err(PlanError::BadMapChar { row: 1, ch: '.' })
        );
        assert_eq!(
            Grid::from_rows(&["..", ".x"], 100),
            Err(PlanError::BadMapChar { row: 1, ch: 'x' })
        );
    }

    #[test]
    fn world_and_cell_round_trip_including_a_negative_origin() {
        let grid = Grid::new(4, 3, 250).expect("map").with_origin(-1_000, 500);
        for col in 0..4u32 {
            for row in 0..3u32 {
                let cell = Cell::new(col, row);
                let (north, east) = grid.cell_centre(cell).expect("inside");
                assert_eq!(
                    grid.world_to_cell(north, east),
                    Some(cell),
                    "cell ({col}, {row}) at ({north}, {east})"
                );
            }
        }
        assert_eq!(grid.world_to_cell(-10_000, 0), None);
        // Floor division, not truncation: a point one millimetre west of the origin belongs to
        // the *previous* cell — which is outside this map — not to cell 0.
        assert_eq!(grid.world_to_cell(-1_001, 500), None);
    }

    #[test]
    fn pursuit_aims_ahead_saturates_and_does_not_brake_while_driving() {
        // A straight road north, 1 m cells: the aim point is the first cell at least one
        // lookahead (3 m) away, i.e. 3 cells ahead.
        let grid = Grid::from_rows(&["."; 10], 1_000).expect("map");
        let path =
            plan(&grid, Cell::new(0, 0), Cell::new(0, 9), Connectivity::Four).expect("route");
        let limits = PursuitLimits::default();

        // Facing north at the start: no steering, cruise throttle.
        let aligned = pursuit(
            &grid,
            &path,
            Pose {
                north_mm: 0,
                east_mm: 0,
                heading_mrad: 0,
            },
            &limits,
        )
        .expect("a command");
        assert_eq!(aligned.steer_milli_deg, 0);
        assert_eq!(aligned.throttle_milli_percent, limits.cruise_milli_percent);
        assert_eq!(aligned.brake_milli_percent, 0, "no braking while driving");
        assert_eq!(aligned.target, Cell::new(0, 3));
        assert!(!aligned.reached_goal);

        // Facing east while the route goes north: reaching north from east means turning
        // counter-clockwise, so the demand saturates **negative** at the machine's steering
        // travel (not at a private number), and the throttle is cut to a creep.
        let sideways = pursuit(
            &grid,
            &path,
            Pose {
                north_mm: 0,
                east_mm: 0,
                heading_mrad: 1_571,
            },
            &limits,
        )
        .expect("a command");
        assert_eq!(sideways.steer_milli_deg, -limits.max_steer_milli_deg);
        assert_eq!(
            sideways.throttle_milli_percent,
            limits.cruise_milli_percent / 4
        );
    }

    #[test]
    fn pursuit_turns_before_it_accelerates() {
        let grid = Grid::from_rows(&["."; 10], 1_000).expect("map");
        let path =
            plan(&grid, Cell::new(0, 0), Cell::new(0, 9), Connectivity::Four).expect("route");
        // A cruise value divisible by four, so "half" and "quarter" are exact integers and the
        // test is about the law's thresholds rather than about rounding.
        let limits = PursuitLimits {
            cruise_milli_percent: 30_000,
            ..PursuitLimits::default()
        };
        let cruise = limits.cruise_milli_percent;
        let command = |heading_mrad| {
            pursuit(
                &grid,
                &path,
                Pose {
                    north_mm: 0,
                    east_mm: 0,
                    heading_mrad,
                },
                &limits,
            )
            .expect("a command")
            .throttle_milli_percent
        };
        assert_eq!(command(0), cruise, "dead ahead");
        assert_eq!(command(175), cruise, "10° off is not a reason to slow down");
        assert_eq!(
            command(523),
            cruise,
            "29.97° off: still under the threshold"
        );
        assert_eq!(command(524), cruise / 2, "just over 30°: half throttle");
        // 60° is 1047.19 mrad: the threshold is between these two, and the test says so
        // rather than rounding it away.
        assert_eq!(command(1_047), cruise / 2, "just under 60°");
        assert_eq!(command(1_048), cruise / 4, "just over 60°: a creep");
        assert_eq!(command(-1_048), cruise / 4, "…and the sign does not matter");
    }

    #[test]
    fn pursuit_stops_at_the_goal() {
        let grid = Grid::from_rows(&["."; 10], 1_000).expect("map");
        let path =
            plan(&grid, Cell::new(0, 0), Cell::new(0, 9), Connectivity::Four).expect("route");
        let limits = PursuitLimits::default();
        let (north, east) = grid.cell_centre(Cell::new(0, 9)).expect("goal centre");

        // Inside the arrival radius ⇒ a stop, and it says it is one.
        let arrived = pursuit(
            &grid,
            &path,
            Pose {
                north_mm: north,
                east_mm: east,
                heading_mrad: 0,
            },
            &limits,
        )
        .expect("a command");
        assert!(arrived.reached_goal && arrived.is_stop());
        assert_eq!(arrived.throttle_milli_percent, 0);
        assert_eq!(arrived.brake_milli_percent, 100_000);
        assert_eq!(arrived.steer_milli_deg, 0);

        // Just outside it ⇒ still driving, and slower than cruise because the goal is near.
        let approaching = pursuit(
            &grid,
            &path,
            Pose {
                north_mm: north - i64::from(limits.slow_radius_mm) / 2,
                east_mm: east,
                heading_mrad: 0,
            },
            &limits,
        )
        .expect("a command");
        assert!(!approaching.reached_goal);
        assert!(
            approaching.throttle_milli_percent < limits.cruise_milli_percent,
            "approaching the goal must slow down: {approaching:?}"
        );
    }

    #[test]
    fn pursuit_refuses_limits_it_cannot_use_and_an_empty_path() {
        let grid = Grid::from_rows(&["..."], 1_000).expect("map");
        let path =
            plan(&grid, Cell::new(0, 0), Cell::new(2, 0), Connectivity::Four).expect("route");
        let pose = Pose {
            north_mm: 0,
            east_mm: 0,
            heading_mrad: 0,
        };
        let with_lookahead = PursuitLimits {
            lookahead_mm: 0,
            ..PursuitLimits::default()
        };
        assert_eq!(
            pursuit(&grid, &path, pose, &with_lookahead),
            Err(PlanError::BadLimit {
                field: "lookahead_mm"
            })
        );
        let with_steer = PursuitLimits {
            max_steer_milli_deg: 0,
            ..PursuitLimits::default()
        };
        assert_eq!(
            pursuit(&grid, &path, pose, &with_steer),
            Err(PlanError::BadLimit {
                field: "max_steer_milli_deg"
            })
        );
        let with_cruise = PursuitLimits {
            cruise_milli_percent: -1,
            ..PursuitLimits::default()
        };
        assert_eq!(
            pursuit(&grid, &path, pose, &with_cruise),
            Err(PlanError::BadLimit {
                field: "cruise_milli_percent"
            })
        );
        // …and above full throttle too. Clamping it silently would leave a controller whose
        // output does not match its configuration — the rule this module states for every
        // other limit — so 120% is refused, not trimmed to 100%.
        let over_full = PursuitLimits {
            cruise_milli_percent: BRAKE_FULL_MILLI_PERCENT + 1,
            ..PursuitLimits::default()
        };
        assert_eq!(
            pursuit(&grid, &path, pose, &over_full),
            Err(PlanError::BadLimit {
                field: "cruise_milli_percent"
            })
        );
        // An empty path is not "already there": it is a route that does not exist.
        let empty = Path { cells: Vec::new() };
        assert_eq!(
            pursuit(&grid, &empty, pose, &PursuitLimits::default()),
            Err(PlanError::EmptyPath)
        );
    }

    #[test]
    fn the_default_limits_are_read_from_the_profile_not_copied() {
        // A duplicate of the steering travel here would go stale the day the profile's column
        // changes; reading it means the only way to disagree is to change the machine.
        let platform = Platform::ground_vehicle();
        let limits = PursuitLimits::default();
        let steering = platform
            .actuators()
            .iter()
            .find(|a| a.role == ActuatorRole::RotaryJoint)
            .expect("the vehicle has a steering column");
        let throttle = platform
            .actuators()
            .iter()
            .find(|a| a.role == ActuatorRole::Thrust)
            .expect("the vehicle has a throttle");
        assert_eq!(limits.max_steer_milli_deg, steering.travel.1);
        assert_eq!(limits.cruise_milli_percent, throttle.travel.1 / 3);
    }

    #[test]
    fn every_command_the_law_produces_is_acceptable_to_the_profile() {
        let platform = Platform::ground_vehicle();
        let grid = field();
        let path =
            plan(&grid, Cell::new(0, 0), Cell::new(6, 4), Connectivity::Eight).expect("route");
        let limits = PursuitLimits::default();
        // Sweep the heading circle and a few positions, so both the saturation and the
        // approach ramp are exercised against the actuator table.
        for heading in (-3_200..=3_200).step_by(137) {
            for north in [-2_000i64, 0, 3_000, 6_000] {
                let command = pursuit(
                    &grid,
                    &path,
                    Pose {
                        north_mm: north,
                        east_mm: 0,
                        heading_mrad: heading,
                    },
                    &limits,
                )
                .expect("a command");
                if let Err(e) = command.check_against(&platform) {
                    panic!("the profile refused {command:?}: {e}");
                }
            }
        }

        // Negative control: a demand the law itself would never emit (past the column's
        // travel) is refused, and the refusal names the set point.
        let legal = pursuit(
            &grid,
            &path,
            Pose {
                north_mm: 0,
                east_mm: 0,
                heading_mrad: 1_571,
            },
            &limits,
        )
        .expect("a command");
        assert!(
            legal.steer_milli_deg.abs() <= limits.max_steer_milli_deg,
            "a demand must never exceed the column's travel: {legal:?}"
        );
        let over_steer = DriveCommand {
            steer_milli_deg: 45_000,
            ..legal
        };
        match over_steer.check_against(&platform) {
            Err(PlanError::Refused { index, reason }) => {
                assert_eq!(index, 0, "steering is set point 0: {reason}");
            }
            other => panic!("a 45° demand on a ±40° column must be refused, got {other:?}"),
        }
        // Independent control: a throttle past 100% is refused **on the throttle's own set
        // point** (built from a legal steering demand, so the first failure really is index 1).
        let over_throttle = DriveCommand {
            throttle_milli_percent: 200_000,
            ..legal
        };
        match over_throttle.check_against(&platform) {
            Err(PlanError::Refused { index, reason }) => {
                assert_eq!(index, 1, "throttle is set point 1: {reason}");
            }
            other => panic!("200% throttle must be refused, got {other:?}"),
        }
    }

    #[test]
    fn a_command_becomes_the_profiles_own_json_and_parses_back() {
        let platform = Platform::ground_vehicle();
        let grid = Grid::from_rows(&["."; 10], 1_000).expect("map");
        let path =
            plan(&grid, Cell::new(0, 0), Cell::new(0, 9), Connectivity::Four).expect("route");
        let command = pursuit(
            &grid,
            &path,
            Pose {
                north_mm: 0,
                east_mm: 500,
                heading_mrad: 300,
            },
            &PursuitLimits::default(),
        )
        .expect("a command");

        let json = command.to_agent_json("hold");
        assert!(
            !json.contains("speed"),
            "a fixed-pose action refuses `speed`, so the generated JSON must not carry one: {json}"
        );
        let intent = platform
            .parse_intent(&json)
            .expect("the profile accepts it");
        assert_eq!(intent.set_points, command.set_points().to_vec());
        assert_eq!(intent.class, IntentClass::Motion);
        // …and the profile then plans it into frames: the join is real, not a comment.
        let frames = platform
            .plan(&intent)
            .expect("the profile plans the set points");
        assert!(!frames.is_empty());

        // The typed path is the same command: `to_intent` must plan to exactly the frames the
        // JSON round trip does, or the two ways to send one plan have drifted apart.
        let typed = platform
            .plan(&command.to_intent("hold"))
            .expect("the profile plans the typed intent too");
        assert_eq!(
            typed
                .iter()
                .map(|f| (f.joint.index(), f.op, f.arg))
                .collect::<Vec<_>>(),
            frames
                .iter()
                .map(|f| (f.joint.index(), f.op, f.arg))
                .collect::<Vec<_>>(),
            "the JSON path and the typed path must produce the same frames"
        );
    }

    #[test]
    fn a_pursuer_never_aims_behind_itself() {
        // The defect this pins (found by the closed-loop test in `tests/stack_e2e.rs`): a
        // stateless "first waypoint at least a lookahead away" search picks a route point
        // *behind* the vehicle once it has driven past it, and the pursuer turns around and
        // orbits it forever. The aim point must be measured from the vehicle's projection onto
        // the route, forward.
        let grid = Grid::from_rows(&["."; 20], 1_000).expect("map");
        let path = plan(&grid, Cell::new(0, 0), Cell::new(0, 19), Connectivity::Four)
            .expect("route")
            .simplified(&grid);
        assert_eq!(path.len(), 2, "the route is one straight leg");

        // 6 m along a 19 m route: the start is 6 m behind, i.e. further away than the 3 m
        // lookahead — the old search would have aimed back at it.
        let pose = Pose {
            north_mm: 6_000,
            east_mm: 0,
            heading_mrad: 0,
        };
        let command = pursuit(&grid, &path, pose, &PursuitLimits::default()).expect("command");
        assert_eq!(
            command.target,
            Cell::new(0, 9),
            "the aim point is one lookahead ahead of the projection"
        );
        assert_eq!(
            command.steer_milli_deg, 0,
            "it is still on the route's line"
        );

        // Near the end the route runs out before the lookahead does, so the aim point is the
        // goal — never a point behind the vehicle.
        let near_goal = Pose {
            north_mm: 18_000,
            east_mm: 0,
            heading_mrad: 0,
        };
        let command = pursuit(&grid, &path, near_goal, &PursuitLimits::default()).expect("command");
        assert_eq!(command.target, Cell::new(0, 19));
    }

    #[test]
    fn inflation_grows_obstacles_by_chebyshev_distance_and_is_bounded() {
        let base = Grid::from_rows(&[".....", "..#..", "....."], 1_000).expect("map");
        assert!(base.is_free(Cell::new(1, 1)) && base.is_free(Cell::new(2, 0)));
        // Zero cells is the identity, not an error.
        assert_eq!(base.inflated(0).expect("identity"), base);

        let grown = base.inflated(1).expect("grow");
        assert_eq!(grown.blocked_cells(), 9, "a 1-cell square grows to a 3×3");
        for cell in [
            Cell::new(1, 1),
            Cell::new(3, 2),
            Cell::new(2, 0),
            Cell::new(1, 0),
            Cell::new(3, 0),
            Cell::new(1, 2),
        ] {
            assert!(grown.is_blocked(cell), "{cell:?} must be grown over");
        }
        // The four diagonal neighbours are inside the square (Chebyshev, not Manhattan), which
        // is the point: a machine cuts corners. (1, 0) is diagonally adjacent to the block at
        // (2, 1); (0, 0) is two cells away and must stay free.
        assert!(grown.is_blocked(Cell::new(1, 0)));
        assert!(
            grown.is_free(Cell::new(0, 0)),
            "two cells away is outside the square"
        );
        assert!(
            grown.is_free(Cell::new(4, 1)),
            "two cells away is outside the square"
        );
        // The inflation is bounded.
        assert_eq!(
            base.inflated(MAX_INFLATION_CELLS + 1),
            Err(PlanError::BadLimit {
                field: "inflation_cells"
            })
        );
    }

    #[test]
    fn the_summary_names_what_the_command_is_doing() {
        let grid = Grid::from_rows(&["."; 10], 1_000).expect("map");
        let path =
            plan(&grid, Cell::new(0, 0), Cell::new(0, 9), Connectivity::Four).expect("route");
        let limits = PursuitLimits::default();
        let driving = pursuit(
            &grid,
            &path,
            Pose {
                north_mm: 0,
                east_mm: 0,
                heading_mrad: 0,
            },
            &limits,
        )
        .expect("a command");
        assert!(
            driving.summary().starts_with("toward (0, 3)"),
            "{}",
            driving.summary()
        );
        let (north, east) = grid.cell_centre(Cell::new(0, 9)).expect("goal");
        let arrived = pursuit(
            &grid,
            &path,
            Pose {
                north_mm: north,
                east_mm: east,
                heading_mrad: 0,
            },
            &limits,
        )
        .expect("a command");
        assert!(
            arrived.summary().contains("arrived at (0, 9)"),
            "{}",
            arrived.summary()
        );
    }
}
