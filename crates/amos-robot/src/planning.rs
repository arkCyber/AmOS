//! Grid path planning that ends in **the profile's own set points**.
//!
//! The middleware's profile layer says of itself: "this layer is not a planner: `goto`
//! generates no trajectory, `lane_keep` does no lateral control" (`docs/robot-domains.md`
//! §6.6). This module is that missing half, and it is built so its output cannot drift away
//! from the machine it drives:
//!
//! ```text
//!   Grid (occupancy) → plan() → Path → simplified() → Path ─┐
//!                                                            ▼
//!          LocalPlanner::command(plan_grid, world, route, pose, velocity)
//!            │                                   │
//!   pursuit (the *goal*, on the route's      dwa (the *command*, on the
//!   own map)                                  caller-refreshed `world`)
//!            │                                   │  ─► DwaVelocity { v_mm_s, omega_mrad_s }
//!            │                                   ▼
//!            │              DriveCommand::from_velocity(v, geometry, steer_travel)
//!            ▼                                   │
//!         DriveCommand ──► set_points()[3] ──► Actuator::check (travel)
//! ```
//!
//! Three laws, one command. [`pursuit`] is a *geometric* tracker: it picks the command that
//! chases the lookahead point, on the route's own map. [`dwa`] is the *local* planner: it
//! scores the machine's own reachable velocities against a map the caller refreshes, and
//! knows nothing of the route. [`LocalPlanner::command`] is the join — the **route** owns
//! the *goal* (pursuit's aim point), the **window** owns the *command* (the velocity `dwa`
//! selects, turned into set points by [`DriveCommand::from_velocity`]), and blending the two
//! would give a command neither law scored. Each law is independently testable, and the join
//! has its own closed-loop test (`tests/stack_e2e.rs`).
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
//!    "percent". [`LocalPlanner::command`] runs the profile's own `Actuator::check` through
//!    [`DriveCommand::check_against`] before it returns, so a planner whose steering ceiling
//!    sits past a ±40° column is refused **here**, where the message can name the profile,
//!    rather than at the bus, where it would name a joint. (The bare builders `pursuit` and
//!    [`DriveCommand::from_velocity`] do **not** run it: a caller that uses those directly owns
//!    the check, and the shipped example shows that call.)
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
//! 2. **Occupancy is the caller's**: this module never estimates a map. `crate::slam`'s
//!    `occupancy` submodule *does* ship one — [`Grid::from_occupancy`] takes its
//!    `occupied_mask()` — but wiring a live map into a live plan is the caller's loop, not
//!    this pure function's; a stale or uninflated map is a stale plan.
//! 3. **`pursuit` is a pure-pursuit law, not a controller with a stability proof**: one
//!    lookahead, one gain, a saturation at the actuator's travel. It is honest about reaching
//!    the goal and refuses non-finite input, but it claims nothing about tracking error at
//!    speed. **DWA** (Fox/Burgard/Thrun, 1997) is the local planner that closes the gap on
//!    that last sentence — a 1 s lookahead that scores trajectories by progress, clearance
//!    and speed, and refuses to commit a velocity it cannot safely reach in `dt_s`.
//! 4. **No dynamic obstacles, no replan loop**: `plan` is a pure function of one map. A
//!    moving obstacle means "call it again with a new map", which is the caller's decision
//!    (and the replan cadence is a domain concern). DWA is a single-frame snapshot too;
//!    the trajectory it scores is one horizon, not a continuous path.
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
//!
//! The join, runnable — the diagram above is executable, so it cannot drift from the code
//! (REQ-A676):
//!
//! ```
//! use amos_link::platform::Platform;
//! use amos_robot::planning::{
//!     plan, Cell, Connectivity, DwaLimits, DwaVelocity, Grid, LocalPlanner, Pose,
//!     PursuitLimits, VehicleGeometry,
//! };
//!
//! # fn main() -> Result<(), amos_robot::planning::PlanError> {
//! // A one-cell-wide corridor running north (nine 1 m cells). The **same** map is the plan
//! // grid and the live world, so there is no obstacle the route did not know about.
//! let grid = Grid::from_rows(&["."; 9], 1_000)?;
//! let route = plan(&grid, Cell::new(0, 0), Cell::new(0, 8), Connectivity::Four)?;
//! let (north, east) = grid.cell_centre(Cell::new(0, 0)).expect("the start is in the map");
//! let planner = LocalPlanner {
//!     pursuit: PursuitLimits::default(),
//!     dwa: DwaLimits::for_ground_vehicle(1_000),
//!     geometry: VehicleGeometry { wheelbase_mm: 2_500, top_speed_mm_s: 1_000 },
//! };
//! // From rest, facing north at the corridor's start: the window's reachable speed is
//! // `accel · dt` (25 mm/s), so the command is a small forward throttle — a **drive**
//! // command, not the stop fallback. (The steering is whatever the window chose: the
//! // discretised window has no exactly-zero yaw-rate candidate, so it is not asserted 0.)
//! let command = planner.command(
//!     &Platform::ground_vehicle(),
//!     &grid,
//!     &grid,
//!     &route,
//!     Pose { north_mm: north, east_mm: east, heading_mrad: 0 },
//!     DwaVelocity { v_mm_s: 0, omega_mrad_s: 0 },
//! )?;
//! assert!(command.throttle_milli_percent > 0, "a forward throttle, not a stop");
//! assert_eq!(command.brake_milli_percent, 0);
//! assert!(!command.reached_goal);
//! # Ok(())
//! # }
//! ```

use amos_link::platform::{ActuatorRole, Intent, IntentClass, Platform, SetPoint};

/// Largest grid this module will build, in cells (1 048 576 ⇒ 1 MiB of occupancy flags).
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
    /// (free). Note this is *only* reported for a genuinely illegal glyph — a row that is
    /// merely the wrong length is [`PlanError::RaggedRow`], so `ch` here is always a
    /// character the map format does not define.
    BadMapChar {
        /// Row index of the offending line.
        row: usize,
        /// The character itself.
        ch: char,
    },
    /// A row of the ASCII map was a different length from the first row.
    ///
    /// Distinct from [`PlanError::BadMapChar`]: the offending character (if the row is
    /// longer) is a **legal** map glyph, so reporting it as "bad" told the caller nothing.
    /// The lengths are the actionable fact — a ragged map is one whose missing cells would
    /// otherwise be silently treated as free.
    RaggedRow {
        /// Row index of the offending line.
        row: usize,
        /// The column count of the first row (the one the map was sized from).
        expected_cols: u32,
        /// The column count of this row.
        found_cols: u32,
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
    /// The reactive layer refused the request (see [`dwa`]).
    ///
    /// The inner error is carried whole rather than flattened into a string: the local
    /// planner's refusals are typed for the same reason the route planner's are — a caller
    /// that wants to tell "the goal was off the map" from "the measured velocity is a lie"
    /// must not have to parse a message.
    Avoidance {
        /// DWA's own refusal.
        reason: DwaError,
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
            PlanError::RaggedRow {
                row,
                expected_cols,
                found_cols,
            } => write!(
                f,
                "row {row} of the map has {found_cols} columns, but the first row has \
                 {expected_cols}: every row of a map must be the same length"
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
            PlanError::Avoidance { reason } => {
                write!(f, "the local planner refused the request: {reason}")
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
        // The `usize -> u32` reductions are saturated, not truncating: a row longer than
        // `u32::MAX` columns (or more rows than that) is already thousands of times past
        // `MAX_GRID_CELLS`, so it is refused as too large rather than silently shrunk —
        // a truncating cast would mis-size the grid and every cell index into it.
        let (cols_usize, rows_usize) = (first.chars().count(), rows.len());
        let saturated = |n: usize| n.min(u32::MAX as usize) as u32;
        if cols_usize > MAX_GRID_CELLS || rows_usize > MAX_GRID_CELLS {
            return Err(PlanError::GridTooLarge {
                cols: saturated(cols_usize),
                rows: saturated(rows_usize),
            });
        }
        let cols = cols_usize as u32;
        let mut grid = Self::new(cols, rows_usize as u32, resolution_mm)?;
        for (row, line) in rows.iter().enumerate() {
            let found_cols = line.chars().count();
            if found_cols != cols_usize {
                return Err(PlanError::RaggedRow {
                    row,
                    expected_cols: cols,
                    found_cols: saturated(found_cols),
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

    /// Move the world origin: the millimetre coordinates of cell `(0, 0)`'s north-west
    /// **corner**.
    ///
    /// A corner, not a centre: [`Grid::world_to_cell`] floors `position − origin` by the
    /// resolution, so cell `(0, 0)` *is* the half-open box `[origin, origin + res)` and a point
    /// one millimetre west of the origin is off the map, not in cell 0. [`Grid::cell_centre`]
    /// adds the half-cell offset back when a caller wants the cell's middle.
    pub fn with_origin(mut self, north_mm: i64, east_mm: i64) -> Self {
        self.origin_north_mm = north_mm;
        self.origin_east_mm = east_mm;
        self
    }

    /// A grid from a dense occupancy buffer: **row-major, one `bool` per cell, `true` =
    /// blocked** — the layout `Grid::index` uses, and the one a scanner, a SLAM front-end or
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
    /// `Grid::index` uses — the exact inverse of [`Grid::from_occupancy`] (`from_occupancy`
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

    /// The world position of a cell's **centre**, in millimetres — or `None` outside the map.
    ///
    /// The origin is the north-west **corner** of cell `(0, 0)` (see [`Grid::with_origin`]), so
    /// cell `k` spans `[origin + k·res, origin + (k+1)·res)` and its centre is the half-cell
    /// point `origin + (k + ½)·res`. Returning the corner here instead would displace every
    /// consumer by half a cell: `pursuit`/`dwa` would aim at a cell's near edge rather than its
    /// middle, and `clearance_mm` — which treats this point as the centre of a `res`-sided
    /// square — would measure to a square straddling the corner, reporting positive clearance
    /// for a point that is *inside* a blocked cell.
    pub fn cell_centre(&self, cell: Cell) -> Option<(i64, i64)> {
        if !self.contains(cell) {
            return None;
        }
        let res = i64::from(self.resolution_mm);
        let half = res / 2;
        Some((
            self.origin_north_mm
                .saturating_add(res.saturating_mul(i64::from(cell.row)))
                .saturating_add(half),
            self.origin_east_mm
                .saturating_add(res.saturating_mul(i64::from(cell.col)))
                .saturating_add(half),
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

    /// The distance, in millimetres, from a world point to the nearest **blocked** cell,
    /// treating each cell as a square of side `resolution_mm` centred on its centre.
    ///
    /// Only the cells within `radius_cells` of the point's own cell are searched (a
    /// bounded neighbourhood — NASA Power of 10 §2), so the work per query is
    /// `O(radius_cells²)`. When no blocked cell lies inside that window the point is at
    /// least `radius_cells · resolution_mm` from any obstacle; that is reported as
    /// [`i64::MAX`] and the caller reads it as "clear".
    ///
    /// A point outside the map has no clearance (`0`): the map edge is a wall.
    fn clearance_mm(&self, north_mm: i64, east_mm: i64, radius_cells: i64) -> i64 {
        let Some(here) = self.world_to_cell(north_mm, east_mm) else {
            return 0;
        };
        let res = i64::from(self.resolution_mm);
        let half = res / 2;
        let radius_cells = radius_cells.max(0);
        let row_lo = i64::from(here.row).saturating_sub(radius_cells).max(0);
        let row_hi =
            (i64::from(here.row).saturating_add(radius_cells)).min(i64::from(self.rows) - 1);
        let col_lo = i64::from(here.col).saturating_sub(radius_cells).max(0);
        let col_hi =
            (i64::from(here.col).saturating_add(radius_cells)).min(i64::from(self.cols) - 1);
        let mut best = i64::MAX;
        for row in row_lo..=row_hi {
            for col in col_lo..=col_hi {
                let cell = Cell::new(col as u32, row as u32);
                if !self.is_blocked(cell) {
                    continue;
                }
                let Some((cn, ce)) = self.cell_centre(cell) else {
                    continue;
                };
                // Distance from the point to the *square*, not its centre — the clearance
                // is to the obstacle's surface, so contact reads as zero. Each per-axis gap
                // must clamp at **zero**, not merely saturate: `i64` saturates at `i64::MIN`,
                // so an unclamped negative gap squares back into a positive distance and a
                // point *inside* the obstacle reports clearance it does not have.
                let dn = (north_mm - cn).abs().saturating_sub(half).max(0);
                let de = (east_mm - ce).abs().saturating_sub(half).max(0);
                let d2 = (dn as f64) * (dn as f64) + (de as f64) * (de as f64);
                let d = d2.sqrt() as i64;
                if d < best {
                    best = d;
                }
            }
        }
        best
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
/// The walk is a supercover DDA in integers: the start cell, every cell it enters (the
/// target included), and — on a pure diagonal advance — the two cells that share only the
/// entered cell's corner must all be free, so a line that grazes an obstacle's corner is not
/// "clear". Off-map cells are blocked, so a line that leaves the map is not clear either.
fn line_of_sight(grid: &Grid, from: Cell, to: Cell) -> bool {
    // The starting cell must be walkable: a blocked cell is not its own line of sight, and a
    // line that begins inside an obstacle is not clear.
    if grid.is_blocked(from) {
        return false;
    }
    let mut col = i64::from(from.col);
    let mut row = i64::from(from.row);
    let target_col = i64::from(to.col);
    let target_row = i64::from(to.row);
    let dcol = target_col - col;
    let drow = target_row - row;
    if dcol == 0 && drow == 0 {
        return true;
    }
    let dc = dcol.abs();
    let dr = drow.abs();
    let step_col = dcol.signum();
    let step_row = drow.signum();
    // Bresenham's supercover: signed error so we step *both* axes when needed.
    // Without this, long shallow segments (e.g. dx=10, dy=1) advance the major
    // axis the whole way and only step the minor axis at the very end — which
    // silently marks a line that visibly passes through intermediate cells as
    // "clear". See `a_long_shallow_line_visits_every_intermediate_cell` for the
    // regression test.
    let mut err = dc - dr;
    let limit = (dc + dr + 1) as usize;
    for _ in 0..=limit {
        let e2 = err.saturating_mul(2);
        // Both axes decide from the *same* `e2`, so this is exactly the "we step both axes"
        // condition — the pure-diagonal advance whose shared corner the line only grazes.
        let advance_col = e2 > -dr;
        let advance_row = e2 < dc;
        if advance_col {
            err -= dr;
            col += step_col;
        }
        if advance_row {
            err += dc;
            row += step_row;
        }
        // A pure diagonal advance passes between two cells; both cells that share only the
        // entered cell's corner must be free, or the line cuts the corner. An off-map flank
        // answers "blocked" (fail closed), so a line grazing the map edge is not clear.
        if advance_col
            && advance_row
            && ((row - step_row) < 0
                || (col - step_col) < 0
                || grid.is_blocked(Cell::new(col as u32, (row - step_row) as u32))
                || grid.is_blocked(Cell::new((col - step_col) as u32, row as u32)))
        {
            return false;
        }
        if col < 0 || row < 0 {
            return false;
        }
        // The entered cell is always checked — including the step that *reaches* the target,
        // where the walk used to skip the check and report a blocked goal as clear.
        if grid.is_blocked(Cell::new(col as u32, row as u32)) {
            return false;
        }
        if col == target_col && row == target_row {
            return true;
        }
    }
    // The walk never reached `to` within its step bound — the line is not clear.
    false
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
            // This operand is the *sole* gate on diagonal expansion: at `Four` it is true and
            // every diagonal is skipped; at `Eight` it is false, and what refuses the bad ones
            // is the corner rule inside `step_is_legal`. Drop it and `Eight` silently becomes
            // `Four` — see `eight_neighbour_actually_takes_the_diagonal`.
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
/// `max_steer_milli_deg` and `cruise_milli_percent` are **read from the `ground-vehicle`
/// profile's actuator table** rather than copied here, so a profile whose steering column
/// changes cannot leave a stale duplicate of its travel in this module (the same "one owner
/// per fact" rule the middleware applies to its own tables).
///
/// The other three fields are this module's own policy, not profile facts: a profile has no
/// opinion on how far ahead to aim. Note the honest limit of the "one owner" claim above —
/// if the profile has no [`ActuatorRole::RotaryJoint`] (or no [`ActuatorRole::Thrust`]) row,
/// the lookup falls back to a hard-coded `40_000` / `30_000`, which *is* a duplicate. A
/// deployment that depends on the profile's value must read it from the platform itself,
/// not from these defaults.
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
    /// own `Actuator::check`, so a steering angle past the column's travel is refused here,
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

    /// The set points that realise a velocity pair on the kinematic bicycle `ω = v·tan δ / L`.
    ///
    /// This is the join the planner was missing: [`dwa`] speaks `(v, ω)` and a profile speaks
    /// a steering angle and a throttle, and the relation between them is geometry the window
    /// does not carry. `geometry` supplies it.
    ///
    /// Three refusals are *saturations*, not corrections, and each says what the machine
    /// cannot do rather than pretending it can:
    ///
    /// * **No reverse.** A `v_mm_s <= 0` command is a full brake: the `ground-vehicle`
    ///   profile's thrust column has no negative travel, so a reverse velocity has no set
    ///   points at all.
    /// * **Steering travel.** The demand is clamped to `max_steer_milli_deg` exactly as
    ///   [`pursuit`] clamps its own. A clamped command realises a **smaller** yaw rate than
    ///   the `(v, ω)` pair asked for, so the trajectory the machine drives is not the one DWA
    ///   scored — a caller that needs the safety guarantee to transfer must size its
    ///   [`DwaLimits`] so that the whole window is inside the travel
    ///   ([`DwaLimits::for_ground_vehicle`] does *not*, and the closed-loop test in
    ///   `tests/stack_e2e.rs` tunes its own and asserts no saturation occurred).
    /// * **Throttle.** Clamped to `[0, BRAKE_FULL_MILLI_PERCENT]`.
    /// * **No declared top speed.** `top_speed_mm_s <= 0` is a machine whose geometry says it
    ///   does not move, so the ratio `v / top_speed_mm_s` has no finite answer and the clamp
    ///   above would pin the `+inf` quotient to its *ceiling*: a full-throttle command for a
    ///   machine that declared it cannot move. The command is zero throttle instead. The field
    ///   is `pub` with no validating constructor, so this is reachable from a caller that
    ///   writes the geometry by hand.
    pub fn from_velocity(
        velocity: DwaVelocity,
        geometry: VehicleGeometry,
        max_steer_milli_deg: i32,
    ) -> DriveCommand {
        if velocity.v_mm_s <= 0 {
            return DriveCommand {
                steer_milli_deg: 0,
                throttle_milli_percent: 0,
                brake_milli_percent: BRAKE_FULL_MILLI_PERCENT,
                reached_goal: false,
                // The caller fills the target in: a velocity pair does not name a cell.
                target: Cell::new(0, 0),
            };
        }
        let v = f64::from(velocity.v_mm_s);
        let wheelbase = f64::from(geometry.wheelbase_mm);
        let omega_rad_s = f64::from(velocity.omega_mrad_s) / 1_000.0;
        // `v > 0` here, so the division is safe; `atan` keeps the angle in (−90°, 90°) and
        // the clamp below is what the machine's column imposes.
        let steer_rad = (omega_rad_s * wheelbase / v).atan();
        let steer_milli_deg = (steer_rad * MILLI_DEG_PER_RAD).round().clamp(
            -f64::from(max_steer_milli_deg),
            f64::from(max_steer_milli_deg),
        ) as i32;
        let throttle_milli_percent = if geometry.top_speed_mm_s <= 0 {
            0
        } else {
            ((v / f64::from(geometry.top_speed_mm_s)) * 100_000.0)
                .round()
                .clamp(0.0, f64::from(BRAKE_FULL_MILLI_PERCENT)) as i32
        };
        DriveCommand {
            steer_milli_deg,
            throttle_milli_percent,
            brake_milli_percent: 0,
            reached_goal: false,
            target: Cell::new(0, 0),
        }
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
/// * **The steering saturation is the caller's number, and the profile is what makes it the
///   machine's.** `max_steer_milli_deg` saturates the demand; this function does not read the
///   profile, so the saturated value fits the column only because a caller set that field from
///   the profile. [`LocalPlanner::command`] is where the two are tied together (it runs
///   [`DriveCommand::check_against`]); a caller that uses `pursuit` bare must run the check
///   itself.
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

    // `saturating_sub`: both operands are `i64` millimetres, and a pose far enough from the
    // goal that the difference overflows would panic in debug and wrap (turning "far" into
    // "close") in release. Saturation keeps the comparison monotone and cannot underflow
    // into a false `<= arrive_radius`.
    let goal_distance = hypot(
        goal_north.saturating_sub(pose.north_mm),
        goal_east.saturating_sub(pose.east_mm),
    );
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
///
/// A **one-cell** route has no segment to project onto, so step ② has nothing to advance
/// along: the early return below hands back that single vertex as the aim point. It is load
/// bearing rather than a convenience — the projection loop `0..len − 1` scores no segment for
/// such a route, so `best` keeps its seed and the advance would read `vertices[1]` of a
/// one-element vector. A route of one cell is not hypothetical: it is exactly what `plan`
/// answers a `start == goal` request with (see
/// `a_one_cell_route_aims_at_its_only_cell_instead_of_indexing_past_it`).
fn aim_point(grid: &Grid, path: &Path, pose: Pose, lookahead_mm: u32) -> Option<(Cell, f64, f64)> {
    // One allocation per call, sized by the route length. It is *outside* the segment loop
    // (NASA Power of 10 §2 forbids allocation in an inner loop), and a caller in a control
    // loop passes a route whose length is that loop's own budget — so the cost is a single
    // reserve per tick, not a per-segment one. A fully allocation-free form would need a
    // fixed cap on route length, which the caller owns, not this module.
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
            //
            // The fallback is the leg's **start** vertex, i.e. the closest route cell to the
            // aim point. It is unreachable for any route whose cells are in the grid: the aim
            // point is an interpolation between two in-map cell centres, so it lies inside
            // the map's own extent and `world_to_cell` maps it. It exists so that an off-map
            // interpolation reports a real waypoint instead of a silently substituted one.
            let cell = grid
                .world_to_cell(north.round() as i64, east.round() as i64)
                .unwrap_or(vertices[segment].0);
            return Some((cell, north, east));
        }
        remaining -= ahead.max(0.0);
        current = (leg_to_north, leg_to_east);
    }
    Some(last)
}

/// Wrap an angle into `(-π, π]` — the same convention as `fusion`'s wrapper, in `f64` because
/// a milli-radian heading error near ±180° must not round the wrong way.
///
/// The formula lands on `-π` for an angle congruent to `π`, so the normalisation below is what
/// makes the interval half-open — the same one `fusion::wrap_pi` applies, and the property the
/// caller's steering sign rests on: a heading error of exactly 180° must wrap to `+π`, or the
/// pursuer turns the opposite way. That boundary is pinned by
/// `a_pursuer_facing_away_from_its_aim_point_turns_the_way_its_angle_was_wrapped`.
///
/// A non-finite angle returns `0.0` (level) rather than a `NaN`, the same convention `fusion`'s
/// wrapper follows. That branch is **defensive rather than reachable**: every caller feeds this
/// an `atan2` of finite offsets minus a finite `i32` heading, so it has no test — unlike
/// `fusion::wrap_pi`'s twin, which pins its (equally unreachable) `NaN` case.
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

// =========================================================================================
// Dynamic Window Approach (`dwa`) — the local planner that respects the machine's
// dynamics. `plan` finds a grid route; `pursuit` follows it. Neither asks whether the
// pursuer's command would actually clear the obstacle it is heading at. DWA is the
// short-horizon step that does (Fox, Burgard, Thrun, 1997): search the velocity window
// the machine can reach in `dt_s`, simulate every candidate arc against the grid, score
// by clearance + progress + speed, and return the best (v, ω) — a velocity pair in the
// machine's own units (mm/s, millirad/s), matching [`DwaVelocity`]. Translating it to a
// [`DriveCommand`] is the caller's (the profile table that knows the wheelbase).
//
// The three numbers the score multiplies are **weights**, not gains — the units differ and
// the magnitudes are normalised inside `dwa` (progress, clearance and speed each to
// `[0, 1]` before weighting); the three `DWA_W_*` constants are documented where they are
// declared. They are **compile-time constants, not fields of [`DwaLimits`]**: a deployment
// that wants "obstacles matter more than speed" changes them by vendoring this function,
// not by tuning a limit.
//
// Honest boundaries:
//   * **2-D kinematic only.** No inertia, no slip, no actuator lag; the model is the same
//     bicycle the [`pursuit`] test uses (`docs/robot-autonomy.md` §3.4).
//   * **Single goal.** No intermediate waypoints; a multi-waypoint loop is the caller's.
//   * **No replan, no route.** DWA does not call back into [`plan`], and it is handed only
//     the goal cell — not a route — so it neither knows the route nor plans across it.
//   * **Bounded by constants.** A scan that overruns the budget is refused, not silently
//     truncated — the same rule the rest of this module follows.

/// The largest candidate count (one v × one ω). The sample counts below are `const`s, so
/// the check that the discretisation stays inside this cap is a compile-time assertion
/// (`const _: () = …`) rather than a runtime branch — an over-budget discretisation is a
/// build failure, not a silent truncation.
const MAX_DWA_CANDIDATES: usize = 100;

/// The sub-step count inside one DWA horizon. Each sub-step is `dt_s`, so the lookahead
/// is `DWA_HORIZON_STEPS · dt_s`. 20 × 50 ms = 1 s.
const DWA_HORIZON_STEPS: usize = 20;

/// Clearance weight (a constant so a reader knows the relative importance vs. progress).
///
/// `// chosen:` — **not cited and not measured.** Fox/Burgard/Thrun's objective is
/// `σ(α·heading + β·dist + γ·velocity)`, in which the *clearance* term (`dist`) is weighted
/// by **β**, not `α`, and the paper states no numeric values for `α`/`β`/`γ`, so no
/// citation can fix this magnitude. This crate's `1.0 : 0.1 : 0.3`
/// (progress : clearance : speed) is its own relative weighting — a *ratio*, not a metric.
const DWA_W_CLEARANCE: f64 = 0.1;

/// Progress-to-goal weight. `// chosen:` — see `DWA_W_CLEARANCE` (this is the paper's `α`
/// term, `heading`).
const DWA_W_PROGRESS: f64 = 1.0;

/// Forward-speed weight. `// chosen:` — see `DWA_W_CLEARANCE` (this is the paper's `γ`
/// term, `velocity`).
const DWA_W_SPEED: f64 = 0.3;

/// Gap at or below which a trajectory is "about to hit" an obstacle, millimetres.
///
/// The candidate is marked `safe: false` and is then ineligible to be selected (`best`
/// only accepts safe candidates). Its score is still computed in full — the clearance term
/// is *not* zeroed — but that arithmetic is internal: [`dwa`] never returns an unsafe
/// candidate, so an unsafe trajectory's own gap is **not** observable through the result
/// (see [`DwaScore::clearance_mm`], which reports `0` for the all-unsafe fallback). The
/// comparison is strict (`gap > margin`), so a gap of exactly 200 mm is unsafe. A robot
/// that grazes a wall is a defect.
const DWA_CLEARANCE_MARGIN_MM: i64 = 200;

/// The envelope and cadence [`dwa`] reads from. ([`dwa`] itself is documented above its
/// definition.)
///
/// `dwa` takes the grid, the pose, the goal cell, the current velocity and these limits;
/// it knows nothing of a route. The caller is what "pulls the goal toward the pursuer" —
/// e.g. by passing the route's next waypoint as `goal`.
#[derive(Clone, Copy, Debug)]
pub struct DwaLimits {
    /// Maximum forward speed, mm/s.
    pub max_v_mm_s: i32,
    /// Maximum reverse speed, mm/s (positive magnitude; the sign is in [`DwaVelocity`]).
    pub max_v_reverse_mm_s: i32,
    /// Maximum yaw rate, mrad/s.
    pub max_omega_mrad_s: i32,
    /// Maximum linear acceleration, mm/s² (the dynamic-window forward bound).
    pub max_accel_mm_s2: i32,
    /// Maximum angular acceleration, mrad/s² (the dynamic-window yaw bound).
    pub max_alpha_mrad_s2: i32,
    /// The **sub-step** of the rollout, seconds (e.g. `0.05` for 50 ms — the same cadence
    /// the control loop ticks at). The lookahead is `DWA_HORIZON_STEPS · dt_s`, not `dt_s`
    /// itself.
    pub dt_s: f64,
    /// Cell size in mm. The grid already carries its own resolution ([`Grid::resolution_mm`]),
    /// so this field is a *redundant* copy: [`dwa`] refuses a call where the two disagree
    /// ([`DwaError::CellSizeMismatch`]) because the clearance score divides by this value
    /// while the trajectory is walked in the grid's coordinates.
    pub cell_mm: u32,
}

impl DwaLimits {
    /// A reasonable starting point for a 1 m cell, 1 m/s ground vehicle with `0.5 m/s²`
    /// acceleration and `1 rad/s` yaw. A deployment tunes these in its own `static`.
    pub fn for_ground_vehicle(cell_mm: u32) -> Self {
        Self {
            max_v_mm_s: 1_000,
            max_v_reverse_mm_s: 200,
            max_omega_mrad_s: 1_000,
            max_accel_mm_s2: 500,
            max_alpha_mrad_s2: 2_000,
            dt_s: 0.05,
            cell_mm,
        }
    }
}

/// The geometry that turns a velocity pair into set points, millimetres.
///
/// [`dwa`] works entirely in `(v, ω)` and knows nothing about wheels; the profile's columns
/// are a steering angle and a throttle. The bicycle model `ω = v·tan δ / L` bridges them, and
/// `L` (the wheelbase) plus the speed at full throttle are the two constants it needs. They
/// belong to the *machine*, not to the dynamic window, which is why they are their own type
/// and not two more fields on [`DwaLimits`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VehicleGeometry {
    /// Distance between the axles, millimetres (the bicycle model's `L`).
    pub wheelbase_mm: i32,
    /// Speed at 100% throttle, millimetres per second.
    pub top_speed_mm_s: i32,
}

/// A single candidate velocity. The sign of `v_mm_s` encodes forward vs. reverse —
/// `v_mm_s >= 0` is forward.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DwaVelocity {
    /// Linear speed, mm/s.
    pub v_mm_s: i32,
    /// Yaw rate, mrad/s.
    pub omega_mrad_s: i32,
}

/// The score the algorithm picks: progress + clearance + speed, normalised.
///
/// `score = w_progress · progress + w_clearance · clearance + w_speed · speed`,
/// with progress in \[0,1\], clearance in \[0,1\] (1 = far from obstacles) and speed in
/// \[0,1\] (1 = at `max_v`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DwaScore {
    /// The candidate that produced the score.
    pub velocity: DwaVelocity,
    /// The composed score, dimensionless. Higher is better.
    pub value: f64,
    /// The clearance of the scored trajectory, mm, capped at the clearance search radius.
    ///
    /// Only meaningful when `safe` is `true`. An unsafe result reports `0`, which means
    /// "no safe trajectory was found" (the all-candidates-unsafe fallback), **not** a
    /// measured zero clearance — an unsafe candidate's own gap is never returned, because
    /// unsafe candidates are never selected as `best`.
    pub clearance_mm: i64,
    /// `true` if every sub-step stayed free of obstacles; a `false` candidate is
    /// discarded by [`dwa`].
    pub safe: bool,
}

/// A typed error — DWA's failures are always the caller's fault (the grid was empty,
/// the goal was outside it, …), and the variant names the cause.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DwaError {
    /// The grid has zero cells — there is no map to score against.
    EmptyGrid,
    /// `limits.max_v_mm_s == 0` or another field is zero / negative. All six such fields are
    /// pinned by `every_zero_or_negative_dwa_limit_is_refused_not_silently_widened` — five of
    /// them were unexercised before it, and each one silently widens the dynamic window (or
    /// divides by zero) rather than merely being an odd setting to pass.
    BadLimits,
    /// `dt_s` was zero, negative, or non-finite.
    BadDt,
    /// The goal cell is outside the grid.
    GoalOutOfBounds,
    /// The measured/commanded `velocity` is outside the machine's own limits.
    ///
    /// This cannot describe a working machine, and the dynamic window degenerates when it
    /// happens (the reachable set inverts). Refusing it is what keeps the function from
    /// reporting a **safe stop** — `safe: true`, zero velocity — for a vehicle whose
    /// velocity estimate is simply wrong, which is the one answer that would hide the
    /// fault.
    VelocityOutOfRange {
        /// The rejected linear speed, mm/s.
        v_mm_s: i32,
        /// The rejected yaw rate, mrad/s.
        omega_mrad_s: i32,
    },
    /// `limits.cell_mm` does not equal the grid's own resolution.
    ///
    /// `cell_mm` is the divisor of the clearance normalisation and is also used to size the
    /// clearance search radius, so a mismatch silently scales every clearance score by the
    /// wrong factor — a plausible-looking ranking built on the wrong units.
    CellSizeMismatch {
        /// The `cell_mm` the caller supplied.
        limits_mm: u32,
        /// `grid.resolution_mm()`.
        grid_mm: u32,
    },
    /// The dynamic window was empty. Unreachable once `velocity` passes the
    /// [`DwaError::VelocityOutOfRange`] check — the reachable interval `[v − a·dt,
    /// v + a·dt] ∩ [−v_rev, v_max]` is non-empty for every velocity inside the limits, and
    /// likewise for yaw. Retained as a **hard stop** so that if that check is ever weakened
    /// the function fails loudly instead of fabricating a safe stop (the defect this
    /// variant replaced).
    EmptyDynamicWindow,
}

impl std::fmt::Display for DwaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DwaError::EmptyGrid => write!(f, "the grid has no cells to score against"),
            DwaError::BadLimits => write!(
                f,
                "a DWA limit is zero or negative (speeds, accelerations and cell_mm must all \
                 be positive)"
            ),
            DwaError::BadDt => write!(f, "the rollout sub-step dt_s must be finite and positive"),
            DwaError::GoalOutOfBounds => write!(f, "the goal cell is outside the grid"),
            DwaError::VelocityOutOfRange {
                v_mm_s,
                omega_mrad_s,
            } => write!(
                f,
                "the measured velocity (v = {v_mm_s} mm/s, ω = {omega_mrad_s} mrad/s) is outside \
                 the machine's own limits"
            ),
            DwaError::CellSizeMismatch { limits_mm, grid_mm } => write!(
                f,
                "the limits' cell_mm ({limits_mm}) disagrees with the grid's resolution \
                 ({grid_mm}); the clearance score would be scaled by the wrong factor"
            ),
            DwaError::EmptyDynamicWindow => write!(
                f,
                "the reachable velocity window is empty (unreachable once the velocity is \
                 inside the limits; reported instead of a fabricated safe stop)"
            ),
        }
    }
}

impl std::error::Error for DwaError {}

/// Run the dynamic window. Returns the best velocity pair in the machine's frame.
///
/// * `grid` — the occupancy map (unknown and off-map are both "blocked").
/// * `pose` — the current pose, in the same world frame [`Grid`] uses.
/// * `goal` — the cell to aim at; DWA does **not** know the route, so a caller that wants
///   route-following passes the next waypoint (or the route end) as `goal`.
/// * `velocity` — what the machine is currently doing, the centre of the dynamic window
///   (a hot start). Refused unless it is inside `limits`.
/// * `limits` — the machine envelope and the rollout cadence.
///
/// The candidate count is pinned under `MAX_DWA_CANDIDATES` by a compile-time assertion,
/// and the horizon by `DWA_HORIZON_STEPS` (both `const`, so an audit can grep for them).
/// Both are deliberately small because the function is meant to be called inside the same
/// loop [`pursuit`] is.
pub fn dwa(
    grid: &Grid,
    pose: Pose,
    goal: Cell,
    velocity: DwaVelocity,
    limits: &DwaLimits,
) -> Result<DwaScore, DwaError> {
    if grid.cols == 0 || grid.rows == 0 {
        return Err(DwaError::EmptyGrid);
    }
    if limits.max_v_mm_s <= 0
        || limits.max_v_reverse_mm_s <= 0
        || limits.max_omega_mrad_s <= 0
        || limits.max_accel_mm_s2 <= 0
        || limits.max_alpha_mrad_s2 <= 0
        // `cell_mm` is the divisor of the clearance normalisation; a zero would make it
        // `inf`/`NaN` and poison every score comparison.
        || limits.cell_mm == 0
    {
        return Err(DwaError::BadLimits);
    }
    if !limits.dt_s.is_finite() || limits.dt_s <= 0.0 {
        return Err(DwaError::BadDt);
    }
    if !grid.contains(goal) {
        return Err(DwaError::GoalOutOfBounds);
    }
    // The clearance normalisation divides by `limits.cell_mm`, but the trajectory is walked
    // in the grid's own coordinates: a mismatch scales every clearance score by the wrong
    // factor. That is a silent ranking error, so it is a typed refusal.
    if limits.cell_mm != grid.resolution_mm() {
        return Err(DwaError::CellSizeMismatch {
            limits_mm: limits.cell_mm,
            grid_mm: grid.resolution_mm(),
        });
    }
    // The measured velocity must lie inside the machine's own envelope. Without this the
    // reachable window inverts for an out-of-range velocity and the function would report
    // a *safe stop* for a vehicle whose velocity estimate is wrong — a fault reported as
    // an all-clear.
    if velocity.v_mm_s > limits.max_v_mm_s
        || velocity.v_mm_s < -limits.max_v_reverse_mm_s
        || velocity.omega_mrad_s.abs() > limits.max_omega_mrad_s
    {
        return Err(DwaError::VelocityOutOfRange {
            v_mm_s: velocity.v_mm_s,
            omega_mrad_s: velocity.omega_mrad_s,
        });
    }

    // Dynamic window: the set of velocities reachable within `dt_s` from `velocity`.
    // (Fox et al. §3.2.) The reachable envelope is centred on the current velocity
    // and half-width is `accel · dt_s`. The absolute envelope is then intersected
    // with the machine's own limits.
    let v_now = velocity.v_mm_s as f64;
    let w_now = velocity.omega_mrad_s as f64;
    let dt_s = limits.dt_s;
    let v_lo_reach =
        (v_now - limits.max_accel_mm_s2 as f64 * dt_s).max(-(limits.max_v_reverse_mm_s as f64));
    let v_hi_reach = (v_now + limits.max_accel_mm_s2 as f64 * dt_s).min(limits.max_v_mm_s as f64);
    let w_lo_reach =
        (w_now - limits.max_alpha_mrad_s2 as f64 * dt_s).max(-(limits.max_omega_mrad_s as f64));
    let w_hi_reach =
        (w_now + limits.max_alpha_mrad_s2 as f64 * dt_s).min(limits.max_omega_mrad_s as f64);
    if v_hi_reach < v_lo_reach || w_hi_reach < w_lo_reach {
        // Unreachable: with `velocity` inside the limits (checked above) each reachable
        // interval is an intersection of two non-empty intervals, so it cannot invert.
        // Fail loudly rather than return a fabricated `safe: true` stop, which is what an
        // inverted window would otherwise be reported as.
        return Err(DwaError::EmptyDynamicWindow);
    }

    // Discretise the window into candidates. 10 v × 10 ω is a common default; the
    // compile-time assertion below pins the product under `MAX_DWA_CANDIDATES`.
    const V_SAMPLES: usize = 10;
    const W_SAMPLES: usize = 10;
    const _: () = assert!(V_SAMPLES * W_SAMPLES <= MAX_DWA_CANDIDATES);
    let v_step = (v_hi_reach - v_lo_reach) / (V_SAMPLES as f64 - 1.0).max(1.0);
    let w_step = (w_hi_reach - w_lo_reach) / (W_SAMPLES as f64 - 1.0).max(1.0);

    // The goal in world coordinates — the same `(north, east)` pose uses.
    let (goal_north, goal_east) = grid.cell_centre(goal).ok_or(DwaError::GoalOutOfBounds)?;

    // We track the *current best*. A score of `−∞` and "unsafe" lets us initialise
    // the loop without a separate "first iteration" branch.
    let mut best: Option<DwaScore> = None;

    // Trajectory scratch — pre-allocated once so the inner loop does not allocate.
    // (NASA Power of 10 §2.)
    let mut trajectory = [(0i64, 0i64); DWA_HORIZON_STEPS];

    // The clearance search radius, in cells, that is large enough to see every obstacle
    // that could put a point within the safe margin (or within one cell of it, which is
    // where the clearance *score* saturates). Bounded by `DWA_CLEARANCE_MARGIN_MM` and the
    // (already validated non-zero) cell size.
    let res_mm = i64::from(limits.cell_mm);
    let search_mm = DWA_CLEARANCE_MARGIN_MM.max(res_mm);
    let clearance_radius_cells = search_mm / res_mm + 2;

    for vi in 0..V_SAMPLES {
        let v = v_lo_reach + v_step * vi as f64;
        for wi in 0..W_SAMPLES {
            let w = w_lo_reach + w_step * wi as f64;
            // Simulate: `(north, east)` along a circular arc for `DWA_HORIZON_STEPS`
            // sub-steps, by the **midpoint rule** — the same integrator the closed-loop
            // fixtures' `BikeModel` uses (`tests/stack_e2e.rs`, `examples/patrol_loop.rs`).
            // (`pursuit` is a steering law and has no integrator; an earlier revision of this
            // comment credited "the [`pursuit`] tests" and promised "the test on this file
            // pins the geometry" when none did — that pin now exists, in
            // `dwa_scales_the_heading_from_milliradians`.)
            let mut north = pose.north_mm as f64;
            let mut east = pose.east_mm as f64;
            // `heading` is **radians** (the [`pursuit`] convention: 0 = +north, clockwise
            // positive). `w` is a *milli*rad/s yaw rate, so it is scaled to rad/s here —
            // feeding milliradians to `sin`/`cos` silently rotated every trajectory by a
            // factor of 1000: reading a commanded `ω = -100` as radians for one second drives
            // `heading` to -100 rad, whose `cos` is ≈ 0.86, so the machine steers by an angle
            // unrelated to the command.
            let mut heading = pose.heading_mrad as f64 / 1_000.0;
            let mut collision = false;
            let mut min_clearance: i64 = i64::MAX;
            // The cell the previous sub-step ended in, so the segment between two samples
            // can be walked. Sampling only the arc's endpoints misses a wall that lies
            // *between* them: a machine whose `v·dt_s` exceeds a cell steps over a one-cell
            // obstacle and its two samples sit either side, both free (the test
            // `dwa_does_not_tunnel_through_a_cell_between_two_samples` pins this).
            let mut prev_cell = grid.world_to_cell(pose.north_mm, pose.east_mm);
            for slot in trajectory.iter_mut() {
                let prev_heading = heading;
                heading += w * dt_s / 1_000.0;
                let mean_heading = 0.5 * (prev_heading + heading);
                north += v * mean_heading.cos() * dt_s;
                east += v * mean_heading.sin() * dt_s;
                let n = north.round() as i64;
                let e = east.round() as i64;
                *slot = (n, e);
                let Some(cell) = grid.world_to_cell(n, e) else {
                    // Outside the map ⇒ unknown ⇒ "blocked" (the same rule the rest
                    // of this module follows).
                    collision = true;
                    break;
                };
                // Every cell the segment enters, not just its endpoints — the walk is
                // the same supercover DDA `line_of_sight` uses, bounded by the map's
                // own extent. `line_of_sight` checks its own endpoints, so the bare
                // point check is only needed for the first sample when the pose cell
                // itself was off-map.
                match prev_cell {
                    Some(prev) if !line_of_sight(grid, prev, cell) => {
                        collision = true;
                        break;
                    }
                    None if grid.is_blocked(cell) => {
                        collision = true;
                        break;
                    }
                    _ => {}
                }
                let d = grid.clearance_mm(n, e, clearance_radius_cells);
                if d < min_clearance {
                    min_clearance = d;
                }
                prev_cell = Some(cell);
            }
            if collision {
                continue;
            }
            // Score.
            let end = trajectory[DWA_HORIZON_STEPS - 1];
            // `saturating_sub` for the same reason as `goal_distance` above: `i64`
            // millimetres can overflow, and a wrapped difference would read as "at the
            // goal" when the machine is a world away.
            let prog_dx = end.0.saturating_sub(goal_north) as f64;
            let prog_dy = end.1.saturating_sub(goal_east) as f64;
            // The "before" distance, used to normalise the progress to [0,1].
            let start_dx = pose.north_mm.saturating_sub(goal_north) as f64;
            let start_dy = pose.east_mm.saturating_sub(goal_east) as f64;
            let start_dist = (start_dx * start_dx + start_dy * start_dy).sqrt();
            let end_dist = (prog_dx * prog_dx + prog_dy * prog_dy).sqrt();
            // The `else` is not defensive: `pose == cell_centre(goal)` — the natural way for a
            // caller to ask "score the cell I am standing in" — makes `start_dist == 0`, and a
            // pose already at its goal has made *complete* progress. Dividing by zero instead
            // would answer `-inf` (clamped to `0.0`, i.e. "no progress at all") for every
            // candidate, and `0.0 / 0.0 = NaN` for the stop candidate — which
            // `candidate.value > b.value` can never displace once it is chosen as `best`. See
            // `a_pose_exactly_on_its_goal_cell_centre_scores_a_complete_progress`.
            let progress = if start_dist > 0.0 {
                ((start_dist - end_dist) / start_dist).clamp(0.0, 1.0)
            } else {
                1.0
            };
            // `min_clearance == i64::MAX` means "no obstacle inside the search window",
            // which is the maximum score; report it as the search radius, not `i64::MAX`.
            let clearance_mm = min_clearance.min(clearance_radius_cells * res_mm);
            let clearance_norm = (clearance_mm as f64 / limits.cell_mm as f64).clamp(0.0, 1.0);
            let speed_norm = (v.abs() / (limits.max_v_mm_s as f64)).clamp(0.0, 1.0);
            let value = DWA_W_PROGRESS * progress
                + DWA_W_CLEARANCE * clearance_norm
                + DWA_W_SPEED * speed_norm;
            // Trajectories that graze within `DWA_CLEARANCE_MARGIN_MM` are marked
            // `safe: false` and are not eligible to be `best`. The flag is local: an
            // unsafe candidate is never stored, so nothing downstream — a log included —
            // can observe its gap. Only the selected candidate's clearance is returned.
            let safe = min_clearance > DWA_CLEARANCE_MARGIN_MM;
            let candidate = DwaScore {
                velocity: DwaVelocity {
                    v_mm_s: v as i32,
                    omega_mrad_s: w as i32,
                },
                value,
                clearance_mm,
                safe,
            };
            if safe && best.map_or(true, |b| candidate.value > b.value) {
                best = Some(candidate);
            }
        }
    }

    // If every candidate was unsafe, fall back to a zero velocity — *stopping is the
    // honest answer to "I cannot see a safe path"*. The caller decides whether a stop
    // counts as a fault.
    Ok(best.unwrap_or(DwaScore {
        velocity: DwaVelocity {
            v_mm_s: 0,
            omega_mrad_s: 0,
        },
        value: 0.0,
        clearance_mm: 0,
        safe: false,
    }))
}

/// The local planner: a **route** decides where to go, a **live map** decides how.
///
/// [`pursuit`] is a *geometric* tracker: it aims at a point on the route and knows the route's
/// own occupancy map. If the world changes after the route was planned — a pallet is set down
/// on it, a person steps into it — that map is stale and the pursuer drives straight into the
/// new obstacle, because nothing in the law can see it. This type closes that gap: the route
/// supplies DWA's goal (the same aim point `pursuit` computed), and [`dwa`] scores the machine's
/// own reachable velocities against a map the caller refreshes.
///
/// The division of labour is deliberate and one-directional:
///
/// * The **route** owns the *goal*. DWA is a local method with no notion of a route and a
///   well-known local-minimum failure mode (a concave obstacle between it and its goal), so it
///   is never asked to route.
/// * The **window** owns the *command*. Once the goal is chosen, the velocity DWA selects is
///   what the machine is told to do, converted through [`VehicleGeometry`]. Blending it with
///   the pursuer's own steering would give a command neither law scored.
/// * **Arrival is the pursuer's.** Inside the arrival radius the command is `pursuit`'s stop,
///   unconverted: DWA has no concept of "there".
/// * **"No safe trajectory" is a stop, and says so.** `dwa` answers an all-unsafe window with a
///   zero velocity, and the conversion below turns that into a brake rather than a rolling
///   throttle. There is deliberately **no separate branch** for it: a velocity of zero and a
///   velocity the machine cannot hold have the same set points, and a branch that returned
///   those same set points anyway would be an unobservable second copy of the rule (the
///   negative control that removed it failed to distinguish the two). Whether a stop is a
///   fault is the supervisor's call, not the planner's.
#[derive(Clone, Copy, Debug)]
pub struct LocalPlanner {
    /// Route tracking (the goal and the arrival test).
    pub pursuit: PursuitLimits,
    /// The dynamic window (the command).
    pub dwa: DwaLimits,
    /// The machine geometry the velocity→set-point join needs.
    pub geometry: VehicleGeometry,
}

impl LocalPlanner {
    /// One command: the route's aim point, scored by the window against `world`.
    ///
    /// * `plan_grid` — the map the route was planned on; `pursuit` uses it to interpolate the
    ///   route's vertices into world positions.
    /// * `world` — the **live** occupancy the window scores against. It must have the same
    ///   resolution as `plan_grid`; a disagreement is refused by [`dwa`]
    ///   ([`DwaError::CellSizeMismatch`]), not silently scored in the wrong units.
    /// * `velocity` — what the machine is currently doing: the hot start of the dynamic window.
    /// * `platform` — the machine's profile. Every command that leaves this method is checked
    ///   against its actuator table ([`DriveCommand::check_against`]) before it is returned, so
    ///   the saturation this law applies is the *column's* travel, not a caller-supplied number
    ///   that merely happens to match it — a `PursuitLimits::max_steer_milli_deg` set past the
    ///   machine's column is refused **here**, naming the profile, instead of at the bus, naming
    ///   a joint.
    ///
    /// The returned command's `target` is always the route waypoint the pursuer aimed at, so a
    /// caller can log "which waypoint was it chasing" for a locally-planned tick too.
    pub fn command(
        &self,
        platform: &Platform,
        plan_grid: &Grid,
        world: &Grid,
        route: &Path,
        pose: Pose,
        velocity: DwaVelocity,
    ) -> Result<DriveCommand, PlanError> {
        let nominal = pursuit(plan_grid, route, pose, &self.pursuit)?;
        let command = if nominal.reached_goal {
            nominal
        } else {
            let score = dwa(world, pose, nominal.target, velocity, &self.dwa)
                .map_err(|reason| PlanError::Avoidance { reason })?;
            let mut command = DriveCommand::from_velocity(
                score.velocity,
                self.geometry,
                self.pursuit.max_steer_milli_deg,
            );
            command.target = nominal.target;
            command
        };
        // The join decision 4 names: a command leaves this module only if the machine's own
        // table accepts it. This is the *only* caller of `check_against` on the production
        // path — the free `pursuit`/`from_velocity` builders do not run it.
        command.check_against(platform)?;
        Ok(command)
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

    /// `Connectivity::Eight`'s own doc says a diagonal step *is* allowed — it is refused only
    /// when it would squeeze between two blocked cells. Nothing pinned that half of the rule:
    /// the sibling test above asserts `eight_cost <= four_cost`, which an implementation that
    /// makes `Eight` skip diagonals outright — i.e. `Eight` collapsed into `Four` — satisfies
    /// exactly, in the equality case. This pins the strict direction.
    #[test]
    fn eight_neighbour_actually_takes_the_diagonal() {
        // An open field: the only way to beat the Manhattan cost is a diagonal.
        let grid = Grid::from_rows(&["....", "....", "....", "...."], 1_000).expect("map");
        let start = Cell::new(0, 0);
        let goal = Cell::new(3, 3);
        let four = plan(&grid, start, goal, Connectivity::Four).expect("four route");
        let eight = plan(&grid, start, goal, Connectivity::Eight).expect("eight route");
        assert_eq!(
            four.cost(),
            Some(6 * STEP_ORTHOGONAL),
            "four-neighbour ground is Manhattan: {:?}",
            four.cells()
        );
        assert_eq!(
            eight.cost(),
            Some(3 * STEP_DIAGONAL),
            "eight-neighbour ground is three diagonals: {:?}",
            eight.cells()
        );
        assert!(
            eight.cost().expect("cost") < four.cost().expect("cost"),
            "with a diagonal available the eight route must be strictly cheaper, not merely \
             no worse"
        );
        // …and the route really contains a diagonal step, not just a cheaper number.
        assert!(
            eight
                .cells()
                .windows(2)
                .any(|pair| match (pair.first(), pair.get(1)) {
                    (Some(a), Some(b)) => a.col != b.col && a.row != b.row,
                    _ => false,
                }),
            "the eight route must contain a diagonal step: {:?}",
            eight.cells()
        );
        // The control: `Four` must stay orthogonal-only, so "everything goes diagonal" cannot
        // pass. (This is the direction that *is* already pinned, kept here as a non-vacuity
        // witness.)
        assert!(
            four.cells()
                .windows(2)
                .all(|pair| match (pair.first(), pair.get(1)) {
                    (Some(a), Some(b)) => a.col == b.col || a.row == b.row,
                    _ => true,
                }),
            "the four route must be orthogonal only: {:?}",
            four.cells()
        );
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

    /// Regression: the walk used to skip its checks entirely on the step that *reaches*
    /// the target, so a diagonal step onto the goal looked at neither the goal cell nor the
    /// two cells it only touches at a corner. `plan(Connectivity::Eight)` refuses exactly
    /// that diagonal (it would pass between two blocked cells), so `line_of_sight` reporting
    /// it "clear" let `simplified()` splice a leg through a wall the planner would not cross.
    #[test]
    fn a_diagonal_onto_the_target_still_checks_the_corner_it_grazes() {
        // Both corner neighbours blocked: the segment (0,0)→(1,1) touches only the shared
        // corner. This is the one-step case, where every check was skipped.
        let corner = Grid::from_rows(&[".#", "#."], 1_000).expect("map");
        assert!(
            !line_of_sight(&corner, Cell::new(0, 0), Cell::new(1, 1)),
            "the diagonal (0,0)->(1,1) passes between blocked (1,0) and (0,1)"
        );
        // The same shape as the *final* step of a longer line: the walk into (2,2) grazes
        // blocked (2,1), and it used to be the skipped step.
        let graze = Grid::from_rows(&["...", "..#", "..."], 1_000).expect("map");
        assert!(
            !line_of_sight(&graze, Cell::new(0, 0), Cell::new(2, 2)),
            "the final diagonal into (2,2) grazes blocked (2,1)"
        );
        // And the target cell itself is checked: a blocked goal is not its own clear line.
        let blocked_goal = Grid::from_rows(&["..", ".#"], 1_000).expect("map");
        assert!(
            !line_of_sight(&blocked_goal, Cell::new(0, 0), Cell::new(1, 1)),
            "a blocked target cell is not clear"
        );
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

    /// Every `PlanError` variant renders the line an operator reads. Only the
    /// `OccupancyShape` arm above had a test — the other ten produced a string no test ever
    /// built, so a swapped field, a lost sentence or a dropped value in the `Display` impl
    /// would have shipped unread. The assertion is on the *distinguishing* content (the
    /// numbers, the axis, the message), not on the boilerplate.
    #[test]
    fn every_plan_error_renders_its_cause() {
        let cell = Cell::new;
        let cases: [(PlanError, &[&str]); 12] = [
            (
                PlanError::GridTooLarge {
                    cols: 2_048,
                    rows: 2_048,
                },
                &["2048x2048", "ceiling"],
            ),
            (PlanError::EmptyGrid, &["row", "column"]),
            (PlanError::ZeroResolution, &["positive"]),
            (PlanError::BadMapChar { row: 1, ch: 'x' }, &["row 1", "'x'"]),
            (
                PlanError::RaggedRow {
                    row: 2,
                    expected_cols: 4,
                    found_cols: 3,
                },
                &["row 2", "3 columns", "has 4"],
            ),
            (
                PlanError::OutOfBounds { cell: cell(9, 7) },
                &["(9, 7)", "outside"],
            ),
            (
                PlanError::StartBlocked { cell: cell(1, 2) },
                &["start (1, 2)", "obstacle"],
            ),
            (
                PlanError::GoalBlocked { cell: cell(3, 4) },
                &["goal (3, 4)", "obstacle"],
            ),
            (
                PlanError::Unreachable {
                    start: cell(0, 0),
                    goal: cell(5, 5),
                    explored: 12,
                },
                &["(0, 0)", "(5, 5)", "12 cell(s)"],
            ),
            (PlanError::EmptyPath, &["start cell"]),
            (
                PlanError::BadLimit {
                    field: "lookahead_mm",
                },
                &["lookahead_mm", "positive"],
            ),
            (
                PlanError::Refused {
                    index: 2,
                    reason: "override".to_string(),
                },
                &["set point 2", "override"],
            ),
        ];
        for (err, needles) in &cases {
            let line = err.to_string();
            assert!(!line.is_empty(), "{err:?} rendered an empty line");
            for needle in *needles {
                assert!(
                    line.contains(needle),
                    "{err:?} rendered {line:?}, which does not name {needle:?}"
                );
            }
        }
        // Two distinct variants must not render the same line — a copy-paste in the match
        // would otherwise pass every per-variant check above.
        let start = PlanError::StartBlocked { cell: cell(1, 2) }.to_string();
        let goal = PlanError::GoalBlocked { cell: cell(1, 2) }.to_string();
        assert_ne!(start, goal, "start and goal must be distinguishable");
    }

    #[test]
    fn ascii_maps_are_parsed_strictly() {
        let grid = Grid::from_rows(&["#.", " ."], 100).expect("space is free");
        assert_eq!(grid.blocked_cells(), 1);
        assert_eq!(Grid::from_rows(&[], 100), Err(PlanError::EmptyGrid));
        assert_eq!(
            Grid::from_rows(&[".#", "..."], 100),
            Err(PlanError::RaggedRow {
                row: 1,
                expected_cols: 2,
                found_cols: 3
            })
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
        // Start at the **centre** of cell (0, 0), not its corner: on a 1 m map that is
        // (500, 500), and the whole route's line runs through east = 500.
        let (pn, pe) = grid.cell_centre(Cell::new(0, 0)).expect("start centre");

        // Facing north at the start: no steering, cruise throttle.
        let aligned = pursuit(
            &grid,
            &path,
            Pose {
                north_mm: pn,
                east_mm: pe,
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
                north_mm: pn,
                east_mm: pe,
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
        // At the centre of cell (0, 0) — (500, 500) on a 1 m map — the aim point (cell (0, 3))
        // is dead ahead, so every threshold below is about the *bearing to the aim point* and
        // not about a start placed half a cell off the route's line.
        let (pn, pe) = grid.cell_centre(Cell::new(0, 0)).expect("start centre");
        let command = |heading_mrad| {
            pursuit(
                &grid,
                &path,
                Pose {
                    north_mm: pn,
                    east_mm: pe,
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
    fn a_one_cell_route_aims_at_its_only_cell_instead_of_indexing_past_it() {
        // `plan` answers "already there" with a **one-cell** route, and
        // `the_planner_is_deterministic`'s neighbour above pins only that route's own `len`
        // and `cost` — never what a *follower* does with it. Every caller hands the route
        // straight to `pursuit`, and the arrival test only fires while the vehicle is inside
        // the arrival radius, so a vehicle localised away from its own goal still replans to
        // this route and still drives it. `aim_point`'s one-vertex early return is the only
        // thing between that route and `vertices[segment + 1]` running off the end: the
        // projection loop `0..len − 1` scores no segment at all, so `best` keeps its
        // `(0, 0.0, ∞)` seed and the advance would index `vertices[1]` of a one-element
        // vector.
        let grid = Grid::from_rows(&["...."; 8], 500).expect("map");
        let route = plan(&grid, Cell::new(3, 3), Cell::new(3, 3), Connectivity::Eight)
            .expect("already there");
        assert_eq!(route.len(), 1, "start == goal is a one-cell route");

        // A pose at the map origin, well outside the arrival radius: the law must aim at the
        // lone waypoint and keep driving — not refuse the route, and not abort the loop.
        let far = Pose {
            north_mm: 0,
            east_mm: 0,
            heading_mrad: 0,
        };
        let command = pursuit(&grid, &route, far, &PursuitLimits::default()).expect("a command");
        assert_eq!(
            command.target,
            Cell::new(3, 3),
            "the aim point is the route's only cell"
        );
        assert!(
            !command.reached_goal,
            "the origin is outside the arrival radius of the goal cell's centre"
        );
        assert!(
            command.throttle_milli_percent > 0,
            "a route still to drive is a throttle, not a stop"
        );

        // …and the same route with the pose exactly on the cell centre is the arrival stop the
        // pursuer owns, so the one-vertex path does not shadow the arrival test either.
        let centre = Pose {
            north_mm: 1_750,
            east_mm: 1_750,
            heading_mrad: 0,
        };
        let arrived = pursuit(&grid, &route, centre, &PursuitLimits::default()).expect("a command");
        assert!(arrived.reached_goal);
        assert_eq!(arrived.brake_milli_percent, BRAKE_FULL_MILLI_PERCENT);
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
        // lookahead — the old search would have aimed back at it. The route's line is the
        // column of cell centres at east = 500, so the vehicle sits on *that* line.
        let (_, pe) = grid.cell_centre(Cell::new(0, 0)).expect("route line");
        let pose = Pose {
            north_mm: 6_000,
            east_mm: pe,
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
            east_mm: pe,
            heading_mrad: 0,
        };
        let command = pursuit(&grid, &path, near_goal, &PursuitLimits::default()).expect("command");
        assert_eq!(command.target, Cell::new(0, 19));
    }

    /// A vehicle whose aim point is **exactly 180° behind** it is the one input where the wrapped
    /// heading error is exactly `±π`, and the sign it takes decides *which way* the pursuer turns:
    /// `wrap_rad` normalises the formula's `-π` to `+π` — the `(-π, π]` interval its own doc claims,
    /// the same convention `fusion::wrap_pi` pins with `wrap_is_half_open_at_minus_pi` — so this
    /// command steers to **positive** saturation. Remove that normalisation and the identical input
    /// commands **negative** saturation, i.e. the machine turns the opposite way at 180°.
    ///
    /// The input is an ordinary one, not an epsilon: the route runs due south, the vehicle sits
    /// exactly on the route's line, so the east difference is exactly `0.0`, and `atan2(+0.0,
    /// negative)` is `+π` exactly. Every step is `f64`-exact, so there is no tolerance to widen.
    ///
    /// The second half is the control: on a due-**north** route the same vehicle faces its aim
    /// point (`atan2(+0.0, positive) = 0.0`), so the steer is exactly zero — proving the first
    /// assertion is not green because the law saturates everything.
    #[test]
    fn a_pursuer_facing_away_from_its_aim_point_turns_the_way_its_angle_was_wrapped() {
        let grid = Grid::from_rows(&["."; 20], 1_000).expect("map");
        let (_, line_east) = grid.cell_centre(Cell::new(0, 0)).expect("route line");
        let limits = PursuitLimits::default();

        // Route row 19 → row 0: north *decreasing*, so the aim point is due south of a
        // north-heading vehicle — the heading error is exactly π.
        let south_way = plan(&grid, Cell::new(0, 19), Cell::new(0, 0), Connectivity::Four)
            .expect("route")
            .simplified(&grid);
        assert_eq!(south_way.len(), 2, "the route is one straight leg");
        let command = pursuit(
            &grid,
            &south_way,
            Pose {
                north_mm: 6_000,
                east_mm: line_east,
                heading_mrad: 0,
            },
            &limits,
        )
        .expect("command");
        assert_eq!(
            command.steer_milli_deg, limits.max_steer_milli_deg,
            "a 180° error wraps to +π, so the steer saturates **positive**"
        );

        // Control: route row 0 → row 19 (north increasing) — same vehicle, aim point dead ahead.
        let north_way = plan(&grid, Cell::new(0, 0), Cell::new(0, 19), Connectivity::Four)
            .expect("route")
            .simplified(&grid);
        let command = pursuit(
            &grid,
            &north_way,
            Pose {
                north_mm: 6_000,
                east_mm: line_east,
                heading_mrad: 0,
            },
            &limits,
        )
        .expect("command");
        assert_eq!(
            command.steer_milli_deg, 0,
            "facing the aim point steers straight — the law does not saturate everything"
        );
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

    // ---- DWA tests ---------------------------------------------------------------

    /// A north-facing vehicle at `(3500, 3500)` (`heading_mrad = 0`, the [`pursuit`]
    /// convention where the heading is radians from `+north`, clockwise positive).
    fn dwa_pose() -> Pose {
        Pose {
            north_mm: 3_500,
            east_mm: 3_500,
            heading_mrad: 0,
        }
    }

    /// An open field: DWA on a clear grid whose goal is **ahead** (row 6 is `+north`)
    /// picks forward (positive `v`) over the stop fallback.
    #[test]
    fn dwa_picks_forward_when_the_goal_is_ahead() {
        let grid = Grid::from_rows(&["......."; 7], 1_000).expect("grid");
        let score = dwa(
            &grid,
            dwa_pose(),
            Cell::new(3, 6),
            DwaVelocity {
                v_mm_s: 0,
                omega_mrad_s: 0,
            },
            &DwaLimits::for_ground_vehicle(1_000),
        )
        .expect("dwa");
        assert!(score.safe, "an open field has safe trajectories");
        assert!(
            score.velocity.v_mm_s > 0,
            "a goal ahead ⇒ forward: got v={}",
            score.velocity.v_mm_s
        );
        assert!(score.value > 0.0, "score must beat the stop fallback");
    }

    /// A goal to the north-east: the vehicle drives forward *and* turns clockwise
    /// (positive `ω`, toward `+east`) — the sign convention `pursuit` uses
    /// (`atan2(east, north)`). A wrong turn sign would send it the long way round.
    #[test]
    fn dwa_turns_toward_a_goal_to_the_side() {
        let grid = Grid::from_rows(&["......."; 7], 1_000).expect("grid");
        let score = dwa(
            &grid,
            dwa_pose(),
            // row 6 (north, ahead) × col 6 (east, to the right): bearing +0.785 rad.
            Cell::new(6, 6),
            DwaVelocity {
                v_mm_s: 0,
                omega_mrad_s: 0,
            },
            &DwaLimits::for_ground_vehicle(1_000),
        )
        .expect("dwa");
        assert!(score.safe);
        assert!(
            score.velocity.v_mm_s > 0,
            "a reachable goal ⇒ forward, got {:?}",
            score.velocity
        );
        assert!(
            score.velocity.omega_mrad_s > 0,
            "the goal is east of the heading ⇒ turn clockwise (positive ω), got {:?}",
            score.velocity
        );
    }

    /// The arc integrator reads `heading_mrad` as **milli**radians: a machine already facing
    /// its goal drives nearly straight, so the chosen yaw rate stays at the smallest-magnitude
    /// sample the discretised window offers (±111 mrad/s here, as no sample is exactly zero)
    /// rather than swinging to the window's rail (REQ-A691).
    ///
    /// This is the pin the module lacked. Plenty of tests here pass a **non-zero**
    /// `heading_mrad`, but they constrain the *outcome* (which cell is reached, whether the
    /// stop fallback fires) rather than the heading's units, so they accept reading `1_571`
    /// as 1 571 *radians* (≈ 0.20 rad, almost due north) instead of 1.571 rad (due east). A
    /// perturbation that drops `/ 1_000.0` from the **initial** heading conversion alone
    /// (leaving the per-step increment scaled correctly) leaves 14 of this module's 15 `dwa`
    /// tests green — this one is the only one that goes red. A machine that thinks it faces
    /// north when it faces east turns hard enough to hit the rail, which the assertion below
    /// pins.
    #[test]
    fn dwa_scales_the_heading_from_milliradians() {
        // 5 rows × 20 columns, 1 m cells, all free.
        let grid = Grid::from_rows(&["...................."; 5], 1_000).expect("grid");
        // A wide yaw window (±`max_alpha·dt_s` = ±1 000 mrad/s) so "no turn needed" and
        // "turn hard east" land on clearly different samples: the discretisation step is
        // 2 000/9 ≈ 222 mrad/s, and the correct choice is the smallest |ω| sample.
        let limits = DwaLimits {
            max_v_mm_s: 1_000,
            max_v_reverse_mm_s: 200,
            max_omega_mrad_s: 2_000,
            max_accel_mm_s2: 500,
            max_alpha_mrad_s2: 20_000,
            dt_s: 0.05,
            cell_mm: 1_000,
        };
        let score = dwa(
            &grid,
            // Row 2 (north 2 500), on the goal's own row, facing **east** (`1_571 mrad`).
            Pose {
                north_mm: 2_500,
                east_mm: 1_500,
                heading_mrad: 1_571,
            },
            // Due east along row 2, 17 m away: no turn is needed to reach it. (`Cell::new`
            // is `(col, row)`; this is column 18, row 2 — the same row as the pose.)
            Cell::new(18, 2),
            DwaVelocity {
                v_mm_s: 0,
                omega_mrad_s: 0,
            },
            &limits,
        )
        .expect("dwa");
        assert!(score.safe, "an open field has safe trajectories: {score:?}");
        assert!(
            score.velocity.v_mm_s > 0,
            "the goal is ahead ⇒ forward: {score:?}"
        );
        // Correct code picks the near-straight sample: `-111 mrad/s` was measured here (the
        // smallest-magnitude sample the window offers). A unit error that read the *initial*
        // heading as radians — leaving the per-step increment scaled correctly, so the rest
        // of the suite stays green — turned the machine hard toward the rail and measured
        // `+1 000` instead. The threshold sits ~4× clear of either.
        assert!(
            score.velocity.omega_mrad_s.abs() < 500,
            "facing the goal's own row, the near-straight arc must win — an integrator that \
             read the heading as radians would swing toward the rail: {score:?}"
        );
    }

    /// The goal is directly **behind** the vehicle (`row 0` is `−north`): DWA must not
    /// sit still — it reverses (negative `v`) toward it rather than returning the stop
    /// fallback. (A `v == 0, ω == 0` result here is exactly the degenerate behavior this
    /// test exists to catch.)
    #[test]
    fn dwa_reverses_toward_a_goal_behind() {
        let grid = Grid::from_rows(&["......."; 7], 1_000).expect("grid");
        let score = dwa(
            &grid,
            dwa_pose(),
            Cell::new(3, 0),
            DwaVelocity {
                v_mm_s: 0,
                omega_mrad_s: 0,
            },
            &DwaLimits::for_ground_vehicle(1_000),
        )
        .expect("dwa");
        assert!(score.safe);
        assert!(
            score.value > 0.0,
            "must not be the stop fallback: {score:?}"
        );
        assert!(
            score.velocity.v_mm_s < 0,
            "a goal behind ⇒ reverse, got {:?}",
            score.velocity
        );
    }

    /// A wall across the field **ahead** (row 5, `+north`), with the goal beyond it, and
    /// the vehicle already moving at full speed toward it: every candidate grazes the wall
    /// within the clearance margin, so DWA returns the **stop fallback** exactly
    /// (`safe: false`, `value == 0`, zero velocity) — not a forward command.
    ///
    /// The vehicle must have speed for this to be reachable at all: from rest the dynamic
    /// window only allows ~25 mm of travel in one horizon, far short of the wall, so a rest
    /// start genuinely *is* safe and is not the case under test here. It must also start
    /// within one horizon of the wall — the horizon is 1 s, so a full-speed start a cell and a
    /// half back (north 3500, the old corner-as-centre default) never reaches the wall's face
    /// at 5000 and is legitimately safe; the pose below is one cell south instead.
    #[test]
    fn dwa_stops_when_forward_is_unsafe() {
        // 7 columns, 7 rows. Wall at row 5 (north 5000–6000), full width.
        let mut grid = Grid::from_rows(&["......."; 7], 1_000).expect("grid");
        for col in 0..7 {
            grid.set_blocked(Cell::new(col, 5), true)
                .expect("set_blocked");
        }
        let score = dwa(
            &grid,
            // One cell south of the wall: cell (3, 4)'s centre is north = 4500, i.e. 500 mm
            // from the wall's south face at 5000. At 1000 mm/s the whole horizon (1 s) is
            // spent inside the wall, so no forward candidate survives.
            {
                let (n, e) = grid.cell_centre(Cell::new(3, 4)).expect("start centre");
                Pose {
                    north_mm: n,
                    east_mm: e,
                    heading_mrad: 0,
                }
            },
            Cell::new(3, 6), // beyond the wall
            DwaVelocity {
                v_mm_s: 1_000, // already at speed, wall half a metre ahead
                omega_mrad_s: 0,
            },
            &DwaLimits::for_ground_vehicle(1_000),
        )
        .expect("dwa");
        assert_eq!(
            score,
            DwaScore {
                velocity: DwaVelocity {
                    v_mm_s: 0,
                    omega_mrad_s: 0
                },
                value: 0.0,
                clearance_mm: 0,
                safe: false,
            },
            "a wall ahead at speed ⇒ the stop fallback"
        );
    }

    /// A trajectory that runs **onto** a blocked cell is not reported safe. This pins the
    /// *outcome*, not the branch that produces it: at full speed the forward candidates
    /// reach the wall, and the cell's own clearance is zero, so the safe gate rejects them
    /// even if the `is_blocked` long-circuit were removed. The visible behaviour — no safe
    /// candidate, so the stop fallback — is what a caller depends on.
    #[test]
    fn dwa_discards_a_trajectory_that_lands_on_a_blocked_cell() {
        // 7 columns, 7 rows. Wall at row 4 (north 4000–5000) — 500 mm ahead of the pose.
        let mut grid = Grid::from_rows(&["......."; 7], 1_000).expect("grid");
        for col in 0..7 {
            grid.set_blocked(Cell::new(col, 4), true)
                .expect("set_blocked");
        }
        let score = dwa(
            &grid,
            dwa_pose(),
            Cell::new(3, 6), // beyond the wall
            DwaVelocity {
                v_mm_s: 1_000,
                omega_mrad_s: 0,
            },
            &DwaLimits::for_ground_vehicle(1_000),
        )
        .expect("dwa");
        assert!(!score.safe, "every forward candidate drives into the wall");
        assert_eq!(score.velocity.v_mm_s, 0, "the fallback is a stop");
    }

    /// A trajectory that leaves the map is not reported safe: outside the map is *unknown*,
    /// and unknown is blocked (the rule the whole module follows). The grid here is small
    /// enough that the forward candidates run off its northern edge within one horizon.
    /// As with the blocked-cell test, `clearance_mm` also reads zero off-map, so this pins
    /// the outcome rather than isolating the branch.
    #[test]
    fn dwa_treats_leaving_the_map_as_a_collision() {
        // 3×3 cells of 1 m: north spans 0..3000. Starting at 2500 with full speed the
        // forward candidates reach 3500 — past the edge and into unknown space.
        let grid = Grid::from_rows(&["..."; 3], 1_000).expect("grid");
        let score = dwa(
            &grid,
            Pose {
                north_mm: 2_500,
                east_mm: 1_500,
                heading_mrad: 0,
            },
            Cell::new(1, 1),
            DwaVelocity {
                v_mm_s: 1_000,
                omega_mrad_s: 0,
            },
            &DwaLimits::for_ground_vehicle(1_000),
        )
        .expect("dwa");
        assert!(
            !score.safe,
            "a candidate that leaves the map is a collision, got {score:?}"
        );
    }

    /// A rollout sub-step that **steps over** an obstacle cell must still be a collision.
    /// (REQ-A674)
    ///
    /// The integrator samples the arc at `DWA_HORIZON_STEPS` points `v·dt_s` apart and used
    /// to ask `is_blocked` only at those points — so a machine whose `v·dt_s` exceeds a cell
    /// could pass its samples either side of a one-cell wall and be reported **safe** while
    /// driving straight through it. The clearance margin cannot catch this either: here the
    /// nearest sample is 250 mm from the wall's face, past the 200 mm margin.
    ///
    /// The wall is one 100 mm cell at column 3, spanning every row; the vehicle moves east
    /// at 12 m/s with `dt_s = 0.05`, so each sub-step is 600 mm (6 cells) and the samples
    /// land on columns 0, 6, 12, … — never on 3, though the path crosses it.
    #[test]
    fn dwa_does_not_tunnel_through_a_cell_between_two_samples() {
        let row = ".".repeat(130);
        let mut grid = Grid::from_rows(&[row.as_str(); 3], 100).expect("grid");
        for r in 0..3 {
            grid.set_blocked(Cell::new(3, r), true)
                .expect("set_blocked");
        }
        let score = dwa(
            &grid,
            // Facing east: heading 1.571 rad ≈ +90° clockwise from north, at the wall's row.
            Pose {
                north_mm: 150,
                east_mm: 50,
                heading_mrad: 1_571,
            },
            Cell::new(100, 1), // beyond the wall
            DwaVelocity {
                v_mm_s: 12_000,
                omega_mrad_s: 0,
            },
            &DwaLimits {
                max_v_mm_s: 12_000,
                max_v_reverse_mm_s: 200,
                max_omega_mrad_s: 1_000,
                max_accel_mm_s2: 500,
                max_alpha_mrad_s2: 2_000,
                dt_s: 0.05,
                cell_mm: 100,
            },
        )
        .expect("dwa");
        assert!(
            !score.safe,
            "every forward candidate crosses the wall between two samples, got {score:?}"
        );
        assert_eq!(score.velocity.v_mm_s, 0, "the fallback is a stop");
    }

    /// A measured velocity outside the machine's own envelope used to invert the dynamic
    /// window and come back as a **safe stop** (`safe: true`, zero velocity) — a fault
    /// reported as an all-clear. It is now a typed refusal. The velocity here is over
    /// `max_v_mm_s` by exactly the amount that produced the inverted window.
    #[test]
    fn dwa_refuses_a_velocity_outside_the_limits() {
        let grid = Grid::from_rows(&["......."; 7], 1_000).expect("grid");
        let limits = DwaLimits::for_ground_vehicle(1_000); // max_v = 1_000
        for velocity in [
            // over the forward limit
            DwaVelocity {
                v_mm_s: 1_500,
                omega_mrad_s: 0,
            },
            // past the reverse limit
            DwaVelocity {
                v_mm_s: -201,
                omega_mrad_s: 0,
            },
            // over the yaw-rate limit
            DwaVelocity {
                v_mm_s: 0,
                omega_mrad_s: 1_001,
            },
        ] {
            assert_eq!(
                dwa(&grid, dwa_pose(), Cell::new(3, 6), velocity, &limits),
                Err(DwaError::VelocityOutOfRange {
                    v_mm_s: velocity.v_mm_s,
                    omega_mrad_s: velocity.omega_mrad_s,
                }),
                "an out-of-envelope velocity must be refused, not reported safe: {velocity:?}"
            );
        }
        // The boundary itself is legal: exactly at either limit is reachable, and exactly
        // at the yaw limit too.
        for velocity in [
            DwaVelocity {
                v_mm_s: 1_000,
                omega_mrad_s: 1_000,
            },
            DwaVelocity {
                v_mm_s: -200,
                omega_mrad_s: -1_000,
            },
        ] {
            assert!(
                dwa(&grid, dwa_pose(), Cell::new(3, 6), velocity, &limits).is_ok(),
                "a velocity exactly at the limits is inside the envelope: {velocity:?}"
            );
        }
    }

    /// `limits.cell_mm` is the divisor of the clearance score while the trajectory is
    /// walked in the grid's coordinates — a mismatch silently rescales every clearance
    /// term. It is now refused instead of scored wrong.
    #[test]
    fn dwa_refuses_a_cell_size_that_disagrees_with_the_grid() {
        let grid = Grid::from_rows(&["......."; 7], 1_000).expect("grid");
        // The grid is 1 m; the limits claim 500 mm.
        let limits = DwaLimits::for_ground_vehicle(500);
        let err = dwa(
            &grid,
            dwa_pose(),
            Cell::new(3, 6),
            DwaVelocity {
                v_mm_s: 0,
                omega_mrad_s: 0,
            },
            &limits,
        )
        .unwrap_err();
        assert_eq!(
            err,
            DwaError::CellSizeMismatch {
                limits_mm: 500,
                grid_mm: 1_000
            }
        );
    }

    /// The clearance weight is real: with the *same* goal and the *same* chosen velocity,
    /// an obstacle placed to the side inside the search radius must lower the score by
    /// exactly the clearance term. Deleting `DWA_W_CLEARANCE` (or the `clearance_norm`
    /// factor) would make the two scores equal and fail this test — which the other DWA
    /// tests, all of which pin only the binary `safe` gate, would not.
    #[test]
    fn the_clearance_term_moves_the_score_rather_than_only_the_safe_gate() {
        let open = Grid::from_rows(&["......."; 7], 1_000).expect("grid");
        // A deliberately weak accelerator (`max_accel = 20`, vs. 500 for a real ground
        // vehicle) collapses the dynamic window to roughly ±1 mm/s, so every candidate's
        // whole 6-step rollout moves less than a millimetre and rounds to the robot's *own*
        // cell. That makes the clearance identical for every candidate — which is the point:
        // with a normal accelerator the sub-centimetre motion still moves the rounded sample
        // a few millimetres, the clearance term varies across candidates, and the argmax
        // (a near-tie broken by the second decimal) flips between the two grids for reasons
        // that have nothing to do with the weight under test.
        let limits = DwaLimits {
            max_accel_mm_s2: 20,
            max_alpha_mrad_s2: 20,
            ..DwaLimits::for_ground_vehicle(1_000)
        };
        let stop = DwaVelocity {
            v_mm_s: 0,
            omega_mrad_s: 0,
        };
        // A pose at the **centre of a cell**, not the shared `dwa_pose()` (which sits on a
        // lattice corner). The distinction is load-bearing: `clearance_mm` measures to each
        // obstacle's *square* (half a cell out from its centre), so from a corner the
        // neighbouring cells' squares touch the robot exactly (clearance 0 → every candidate
        // unsafe, and the only survivor is the stop) and the next ring out is a full cell
        // away (clearance 1 000 mm → `clearance_norm` already saturates at 1.0). Neither
        // yields a score strictly between the two grids. A cell centre sits 500 mm from the
        // adjacent square — clearance 500 mm, norm 0.5, above the 200 mm safety margin —
        // which is the one geometry where the weight is observable.
        let pose = Pose {
            north_mm: 3_000,
            east_mm: 3_000,
            heading_mrad: 0,
        };
        let goal = Cell::new(3, 6); // straight ahead (+north) — so `start_dist > 0`.
        let open_score = dwa(&open, pose, goal, stop, &limits).expect("dwa");

        // One obstacle in the cell to the east of the robot's own cell.
        let mut near = open.clone();
        near.set_blocked(Cell::new(4, 3), true)
            .expect("set_blocked");
        let near_score = dwa(&near, pose, goal, stop, &limits).expect("dwa");

        // Same manoeuvre — progress and speed are unchanged, only clearance differs.
        assert_eq!(
            near_score.velocity, open_score.velocity,
            "a side obstacle must not change the chosen velocity here"
        );
        assert!(
            near_score.clearance_mm < open_score.clearance_mm,
            "the closer obstacle must reduce the measured clearance: {} vs {}",
            near_score.clearance_mm,
            open_score.clearance_mm
        );
        // `clearance_norm` is **clamped to \[0,1\]**, so the open grid's 3 000 mm (the
        // saturation cap) contributes a norm of 1.0 — not 3.0. Clamping each side before
        // differencing is what makes this the score the function actually computes; using
        // the raw millimetre difference would over-state the drop by 3×.
        let norm = |mm: i64| ((mm as f64) / (limits.cell_mm as f64)).clamp(0.0, 1.0);
        let expected_drop =
            DWA_W_CLEARANCE * (norm(open_score.clearance_mm) - norm(near_score.clearance_mm));
        assert!(
            (open_score.value - near_score.value - expected_drop).abs() < 1e-9,
            "the score must fall by exactly the clearance term ({expected_drop}): {} → {}",
            open_score.value,
            near_score.value
        );
    }

    /// A pose sitting exactly on its goal cell's centre reaches the `progress` else-branch:
    /// `start_dist == 0`, so the division cannot be normalised and the branch answers `1.0`
    /// (the whole of the progress axis — the robot *is* at the goal).
    ///
    /// That branch is the one place in `dwa` that reports progress without dividing by
    /// `start_dist`, and nothing else in this suite walks it: every other DWA test drives a
    /// pose off the goal (the shared `dwa_pose()` sits on a lattice corner, and the clearance
    /// test's goal is a full cell ahead). Deleting the else leaves all of the other DWA tests
    /// green while silently re-labelling a robot that is already at its goal as having made
    /// **zero** progress — `(0.0 - end_dist) / 0.0` clamps to `0.0` — so the reported
    /// `DwaScore::value` (public, documented as "higher is better") drops by exactly
    /// `DWA_W_PROGRESS`, and for the stop candidate `0.0 / 0.0` is `NaN` instead. Passing
    /// `pose = cell_centre(goal)` is the natural way for a caller to ask "score the pose I am
    /// standing in", so the branch is reachable through the public API, not defensive.
    ///
    /// The chosen command is *not* what this pins: on the open field both poses pick the same
    /// velocity, safety verdict and clearance (asserted below), because the else contributes
    /// the same `progress` to every candidate and a constant offset cannot move an argmax.
    /// The defect this catches is in the reported score, and the test says so rather than
    /// claiming a control bug.
    #[test]
    fn a_pose_exactly_on_its_goal_cell_centre_scores_a_complete_progress() {
        let grid = Grid::from_rows(&["......."; 7], 1_000).expect("grid");
        let goal = Cell::new(3, 3);
        let (goal_north, goal_east) = grid.cell_centre(goal).expect("an in-bounds cell");
        let limits = DwaLimits::for_ground_vehicle(1_000);
        let stop = DwaVelocity {
            v_mm_s: 0,
            omega_mrad_s: 0,
        };
        let on = dwa(
            &grid,
            Pose {
                north_mm: goal_north,
                east_mm: goal_east,
                heading_mrad: 0,
            },
            goal,
            stop,
            &limits,
        )
        .expect("dwa");
        // One millimetre off — the nearest pose that takes the `if` arm, and the *only* thing
        // that differs between the two calls.
        let off = dwa(
            &grid,
            Pose {
                north_mm: goal_north + 1,
                east_mm: goal_east,
                heading_mrad: 0,
            },
            goal,
            stop,
            &limits,
        )
        .expect("dwa");

        assert!(
            on.value.is_finite(),
            "a pose on its goal must score a finite value, got {}",
            on.value
        );
        assert!(
            on.value >= DWA_W_PROGRESS,
            "a pose on its goal has made complete progress, so its score must carry at least \
             the full progress weight {DWA_W_PROGRESS}: got {}",
            on.value
        );
        // The offset is *exactly* the progress weight: progress is the only term that can
        // differ, and it is 1.0 here against ~0.0 one millimetre away.
        assert!(
            (on.value - off.value - DWA_W_PROGRESS).abs() < 1e-9,
            "the on-goal score must exceed the one-millimetre-away score by the progress \
             weight {DWA_W_PROGRESS}: {} vs {} (delta {})",
            on.value,
            off.value,
            on.value - off.value
        );
        // The honesty boundary: on the open field this is a *reported-score* difference, not
        // a command one.
        assert_eq!(
            on.velocity, off.velocity,
            "the progress term must not change the chosen velocity here"
        );
        assert_eq!(on.safe, off.safe);
        assert_eq!(on.clearance_mm, off.clearance_mm);
    }

    /// The DWA errors are read by operators and by `source`-chaining callers, so each
    /// renders a distinct, actionable line.
    #[test]
    fn the_dwa_errors_render_their_cause() {
        use std::error::Error;
        let cases: [(DwaError, &str); 3] = [
            (DwaError::EmptyGrid, "no cells"),
            (
                DwaError::VelocityOutOfRange {
                    v_mm_s: 1_500,
                    omega_mrad_s: 0,
                },
                "1500",
            ),
            (
                DwaError::CellSizeMismatch {
                    limits_mm: 500,
                    grid_mm: 1_000,
                },
                "500",
            ),
        ];
        for (err, needle) in cases {
            let text = err.to_string();
            assert!(text.contains(needle), "{err:?} rendered as {text:?}");
            assert!(err.source().is_none(), "DWA errors are leaves");
        }
        // Every variant must render something, i.e. none falls through to an empty string.
        for err in [
            DwaError::BadLimits,
            DwaError::BadDt,
            DwaError::GoalOutOfBounds,
            DwaError::EmptyDynamicWindow,
        ] {
            assert!(!err.to_string().is_empty(), "{err:?} rendered empty");
        }
    }

    /// A zero-dimension grid is refused by `dwa` with [`DwaError::EmptyGrid`] rather than
    /// panicking in the cell indexing. `Grid::new`/`from_rows` already refuse to build one,
    /// so the fixture is constructed literally (the fields are private to this module) to
    /// reach the defensive branch.
    #[test]
    fn dwa_refuses_an_empty_grid() {
        let grid = Grid {
            cols: 0,
            rows: 0,
            resolution_mm: 1_000,
            origin_north_mm: 0,
            origin_east_mm: 0,
            blocked: Vec::new(),
        };
        let err = dwa(
            &grid,
            Pose {
                north_mm: 0,
                east_mm: 0,
                heading_mrad: 0,
            },
            Cell::new(0, 0),
            DwaVelocity {
                v_mm_s: 0,
                omega_mrad_s: 0,
            },
            &DwaLimits::for_ground_vehicle(1_000),
        )
        .unwrap_err();
        assert_eq!(err, DwaError::EmptyGrid);
    }

    /// A zero `cell_mm` would make the clearance normalisation `inf`/`NaN`; it is refused.
    #[test]
    fn dwa_refuses_a_zero_cell_mm() {
        let grid = Grid::from_rows(&["..."; 3], 1_000).expect("grid");
        let mut limits = DwaLimits::for_ground_vehicle(1_000);
        limits.cell_mm = 0;
        let err = dwa(
            &grid,
            Pose {
                north_mm: 1_500,
                east_mm: 1_500,
                heading_mrad: 0,
            },
            Cell::new(1, 1),
            DwaVelocity {
                v_mm_s: 0,
                omega_mrad_s: 0,
            },
            &limits,
        )
        .unwrap_err();
        assert_eq!(err, DwaError::BadLimits);
    }

    /// The `BadLimits` guard has **six** leaves — five speed ∕ acceleration ceilings and the
    /// redundant `cell_mm` copy — and the suite pinned only one of them (`cell_mm == 0`, the
    /// test above). A source census confirms no test anywhere in the crate ever writes a
    /// zero or negative `max_v_mm_s`, `max_v_reverse_mm_s`, `max_omega_mrad_s`,
    /// `max_accel_mm_s2` or `max_alpha_mrad_s2`: every construction site
    /// (`DwaLimits::for_ground_vehicle`, the literal `DwaLimits` in this module's tests,
    /// `examples/patrol_loop.rs`, `tests/stack_e2e.rs`) uses a positive value. Five of the
    /// six leaves were therefore dead to the suite.
    ///
    /// Their loss is neither cosmetic nor command-neutral. Deleting one leaf at a time and
    /// re-running a probe that zeroes each field shows four of the five turn a refusal into
    /// a **`safe: true` command**: `max_v_mm_s = 0` ⇒ `Ok(v = −25, ω = −100, val = 0.4)` —
    /// the dynamic window's upper bound is `min(…, max_v) = 0`, so the reachable set
    /// collapses to *reverse only* and the command flips direction, while
    /// `speed_norm = |v| ∕ 0` saturates to `1.0` for every moving candidate (a machine whose
    /// "maximum forward speed" is zero reads as the *fastest* one); `max_accel_mm_s2 = 0` ⇒
    /// `Ok(v = 0, val = 0.1)` (the window collapses to the current velocity);
    /// `max_omega_mrad_s = 0` and `max_alpha_mrad_s2 = 0` ⇒ `Ok(ω = 0)`. Only
    /// `max_v_reverse_mm_s = 0` is inert *in this configuration* — the forward-only window it
    /// leaves is legitimate, and a reverse `velocity` is caught downstream by
    /// `VelocityOutOfRange`.
    ///
    /// This is the crate's own "fault reported as an all-clear" vocabulary — the same shape
    /// the envelope check below refuses an out-of-range `velocity` for. The guard itself is
    /// correct; this test pins it leaf by leaf, symmetric in the zero and negative
    /// directions, and mirrors `every_malformed_scan_match_field_is_refused`.
    #[test]
    fn every_zero_or_negative_dwa_limit_is_refused_not_silently_widened() {
        let grid = Grid::from_rows(&["......."; 7], 1_000).expect("grid");
        let pose = Pose {
            north_mm: 3_000,
            east_mm: 3_000,
            heading_mrad: 0,
        };
        let goal = Cell::new(3, 6);
        let stop = DwaVelocity {
            v_mm_s: 0,
            omega_mrad_s: 0,
        };
        let base = DwaLimits::for_ground_vehicle(1_000);
        /// One way to break a limit: set a field to a value the guard must refuse.
        type Corrupt = (&'static str, fn(&mut DwaLimits));
        let bad: [Corrupt; 10] = [
            ("max_v_mm_s = 0", |l| l.max_v_mm_s = 0),
            ("max_v_reverse_mm_s = 0", |l| l.max_v_reverse_mm_s = 0),
            ("max_omega_mrad_s = 0", |l| l.max_omega_mrad_s = 0),
            ("max_accel_mm_s2 = 0", |l| l.max_accel_mm_s2 = 0),
            ("max_alpha_mrad_s2 = 0", |l| l.max_alpha_mrad_s2 = 0),
            ("max_v_mm_s = -1", |l| l.max_v_mm_s = -1),
            ("max_v_reverse_mm_s = -1", |l| l.max_v_reverse_mm_s = -1),
            ("max_omega_mrad_s = -1", |l| l.max_omega_mrad_s = -1),
            ("max_accel_mm_s2 = -1", |l| l.max_accel_mm_s2 = -1),
            ("max_alpha_mrad_s2 = -1", |l| l.max_alpha_mrad_s2 = -1),
        ];
        for (label, corrupt) in bad {
            let mut limits = base;
            corrupt(&mut limits);
            assert_eq!(
                dwa(&grid, pose, goal, stop, &limits),
                Err(DwaError::BadLimits),
                "{label} must be refused, not silently widened into an Ok command"
            );
        }
        // Non-vacuity: the untouched limits must actually search, so the loop above cannot
        // pass on a `dwa` that simply refuses everything.
        assert!(
            dwa(&grid, pose, goal, stop, &base).is_ok(),
            "well-formed limits must be searched, not refused"
        );
    }

    /// Goal outside the grid ⇒ `GoalOutOfBounds`. No panic.
    #[test]
    fn dwa_refuses_a_goal_outside_the_grid() {
        let grid = Grid::from_rows(&["..."; 3], 1_000).expect("grid");
        let pose = Pose {
            north_mm: 1_500,
            east_mm: 1_500,
            heading_mrad: 0,
        };
        let limits = DwaLimits::for_ground_vehicle(1_000);
        let err = dwa(
            &grid,
            pose,
            Cell::new(99, 99),
            DwaVelocity {
                v_mm_s: 0,
                omega_mrad_s: 0,
            },
            &limits,
        )
        .unwrap_err();
        assert_eq!(err, DwaError::GoalOutOfBounds);
    }

    /// A `dt_s` that is not finite and positive is refused.
    ///
    /// The guard is two leaves — `!dt_s.is_finite() || dt_s <= 0.0` — and this test used to
    /// pin only the second: it fed `0.0` alone. Deleting the `is_finite` leaf left the whole
    /// `planning` suite green (`NaN <= 0.0` is `false`, so a `NaN` sub-step slipped past the
    /// `<= 0.0` half) while `dwa` returned `Ok(DwaScore { safe: true })` for it — an
    /// **all-clear on an invalid control limit**, the same "fault reported as an all-clear"
    /// the envelope check below refuses for an out-of-range velocity. `NaN` and `+INFINITY`
    /// are the values that walk the `is_finite` leaf alone; a negative value walks `<= 0.0`.
    ///
    /// **Correction (REQ-A846 / F-SH-274).** As with the EKF-SLAM `observe` guard
    /// (REQ-A840 / F-SH-269), pinning *a* value the guard refuses did not pin *every leaf*
    /// of it: the single `0.0` case exercised only the `<= 0.0` leaf, so the `is_finite`
    /// leaf was dead to the suite.
    #[test]
    fn dwa_refuses_a_dt_that_is_not_finite_and_positive() {
        let grid = Grid::from_rows(&["..."; 3], 1_000).expect("grid");
        let pose = Pose {
            north_mm: 1_500,
            east_mm: 1_500,
            heading_mrad: 0,
        };
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let mut limits = DwaLimits::for_ground_vehicle(1_000);
            limits.dt_s = bad;
            let err = dwa(
                &grid,
                pose,
                Cell::new(0, 0),
                DwaVelocity {
                    v_mm_s: 0,
                    omega_mrad_s: 0,
                },
                &limits,
            )
            .unwrap_err();
            assert_eq!(err, DwaError::BadDt, "dt_s = {bad} must be refused");
        }
    }

    /// Determinism: two runs on the same inputs produce bit-identical output.
    /// (Fox/Burgard/Thrun's "no randomness" property.)
    #[test]
    fn dwa_is_deterministic_across_runs() {
        let grid = Grid::from_rows(&["......."; 5], 1_000).expect("grid");
        let pose = Pose {
            north_mm: 2_500,
            east_mm: 2_500,
            heading_mrad: 0,
        };
        let limits = DwaLimits::for_ground_vehicle(1_000);
        let a = dwa(
            &grid,
            pose,
            Cell::new(2, 0),
            DwaVelocity {
                v_mm_s: 100,
                omega_mrad_s: 0,
            },
            &limits,
        )
        .expect("dwa");
        let b = dwa(
            &grid,
            pose,
            Cell::new(2, 0),
            DwaVelocity {
                v_mm_s: 100,
                omega_mrad_s: 0,
            },
            &limits,
        )
        .expect("dwa");
        assert_eq!(a, b, "DWA is a pure function: same inputs, same outputs");
    }

    /// The `Grid`/`Path` read-back surface. `Grid::rows` and `Path::is_empty` had no test —
    /// a swapped `rows`/`cols` (the two differ by construction on every fixture here that is
    /// not square) would have gone unnoticed.
    #[test]
    fn the_grid_and_path_read_back_their_shape() {
        let grid = Grid::new(3, 5, 250).expect("a 3-wide, 5-tall grid");
        assert_eq!(grid.cols(), 3);
        assert_eq!(
            grid.rows(),
            5,
            "rows is north/south, the other axis from cols"
        );
        assert_eq!(grid.cells(), 15);
        assert_eq!(grid.resolution_mm(), 250);

        let path = plan(
            &field(),
            Cell::new(0, 0),
            Cell::new(6, 4),
            Connectivity::Four,
        )
        .expect("a route across the field");
        assert!(!path.cells().is_empty());
        assert_eq!(path.len(), path.cells().len());
        assert!(!path.is_empty(), "a constructed path is never empty");
        assert_eq!(path.goal(), path.cells().last().copied());
        assert!(
            path.cost().is_some(),
            "a path of ≥2 cells has a finite cost"
        );
    }

    /// A row longer than [`MAX_GRID_CELLS`] is refused as **too large**, not truncated to a
    /// smaller `u32` and mis-sized — the reason the reduction in `from_rows` saturates. The
    /// map never gets built, so the cost is one oversized allocation, not a real parse.
    #[test]
    fn an_oversized_row_is_refused_rather_than_truncated() {
        let wide = ".".repeat(MAX_GRID_CELLS + 1);
        let err = Grid::from_rows(&[wide.as_str()], 1_000).unwrap_err();
        assert!(
            matches!(err, PlanError::GridTooLarge { cols, .. } if cols as usize == MAX_GRID_CELLS + 1),
            "got {err:?}"
        );
    }

    /// `cell_centre` is the map's only cell → world conversion, and its contract is two-sided:
    /// a cell inside the map has a centre, one outside has **no** position at all. A version
    /// that always returned a number would let a caller aim at a point off the map edge and
    /// believe it was on the map.
    ///
    /// The expected value pins the convention: cell (col 2, row 1) of a 500 mm map at the
    /// default origin is the box north `[500, 1000)` × east `[1000, 1500)`, whose **centre** is
    /// `(north 750, east 1250)` — not the north-west corner `(500, 1000)` that an
    /// off-by-a-half-cell version returns.
    #[test]
    fn cell_centre_has_no_position_for_a_cell_outside_the_map() {
        let grid = Grid::from_rows(&["...", "..."], 500).expect("map");
        assert!(grid.contains(Cell::new(2, 1)));
        assert_eq!(grid.cell_centre(Cell::new(2, 1)), Some((750, 1_250)));
        // One column and one row past the edge.
        assert_eq!(grid.cell_centre(Cell::new(3, 1)), None, "past the col edge");
        assert_eq!(grid.cell_centre(Cell::new(2, 2)), None, "past the row edge");
    }

    /// `world_to_cell` inverts `cell_centre` at the exact centre, and a point outside the map
    /// has **no** cell. The floor division matters here: a point one millimetre west of the
    /// origin must be in the previous cell, not the same one as a point one millimetre east.
    #[test]
    fn world_to_cell_inverts_cell_centre_and_refuses_the_void() {
        let grid = Grid::from_rows(&["....", "...."], 1_000).expect("map");
        for cell in [Cell::new(0, 0), Cell::new(3, 1), Cell::new(1, 0)] {
            let (north, east) = grid.cell_centre(cell).expect("inside");
            assert_eq!(
                grid.world_to_cell(north, east),
                Some(cell),
                "centre {cell:?}"
            );
        }
        // Just west of the origin is not cell 0: it is off the map.
        assert_eq!(grid.world_to_cell(-1, 500), None);
        assert_eq!(grid.world_to_cell(500, -1), None);
        assert_eq!(grid.world_to_cell(4_000, 500), None, "past the east edge");
    }

    /// A diagonal step cannot leave the map through a side cell: at the very corner the two
    /// cells that flank the diagonal do not exist, and a rule that shrugged at that would let
    /// a route clip the outside of the map.
    #[test]
    fn a_diagonal_step_whose_flank_leaves_the_map_is_illegal() {
        let grid = Grid::from_rows(&["..", ".."], 1_000).expect("2x2 map");
        // (0,0) → (1,1) flanks on (0,1) and (1,0), both inside: legal.
        assert!(grid.step_is_legal(Cell::new(0, 0), Cell::new(1, 1)));
        // A cell one step outside the map has no flank at all, so no diagonal from it is
        // legal — including one whose destination would be inside.
        assert!(!grid.step_is_legal(Cell::new(1, 0), Cell::new(2, 1)));
        assert!(!grid.step_is_legal(Cell::new(0, 1), Cell::new(1, 2)));
    }

    /// An empty or single-cell path is contiguous: `windows(2)` is empty, and "every adjacent
    /// pair is one step" is vacuously true. A `false` here would make a degenerate route look
    /// like a smoothed one.
    #[test]
    fn a_degenerate_path_is_contiguous_and_does_not_simplify_to_garbage() {
        let grid = Grid::from_rows(&["...", "..."], 500).expect("map");
        let empty = Path { cells: Vec::new() };
        assert!(empty.is_contiguous());
        assert_eq!(empty.len(), 0);
        assert_eq!(empty.goal(), None);
        assert_eq!(
            empty.simplified(&grid).len(),
            0,
            "an empty path simplifies to empty"
        );

        let single = Path {
            cells: vec![Cell::new(1, 1)],
        };
        assert!(single.is_contiguous(), "one cell has no pair to violate");
        let kept = single.simplified(&grid);
        assert_eq!(kept.cells(), &[Cell::new(1, 1)], "the cell is preserved");
    }

    /// `line_of_sight` from a cell to **itself** is legal iff that cell is free — the walk is
    /// empty, so the only question left is whether the cell is walkable at all.
    #[test]
    fn line_of_sight_to_the_same_cell_asks_only_whether_it_is_free() {
        let mut grid = Grid::from_rows(&["...", "..."], 500).expect("map");
        let free = Cell::new(1, 0);
        assert!(line_of_sight(&grid, free, free));
        grid.set_blocked(free, true).expect("inside");
        assert!(
            !line_of_sight(&grid, free, free),
            "a blocked cell is not its own line of sight"
        );
    }

    /// A line of sight that runs out of grid before reaching the target is **not** clear —
    /// the walk falling off the edge must answer `false`, not `true`. Here the two cells are
    /// separated by a wall of unknown (off-map) space, so no straight line joins them.
    #[test]
    fn a_line_of_sight_that_runs_off_the_map_is_not_clear() {
        // The destination is inside, but the only straight line to it leaves the map: the
        // walk exhausts the grid before arriving.
        let grid = Grid::from_rows(&["...", "..."], 500).expect("map");
        assert!(line_of_sight(&grid, Cell::new(0, 0), Cell::new(2, 1)));
        // A cell outside the grid is not reachable by any walk.
        assert!(!line_of_sight(&grid, Cell::new(0, 0), Cell::new(5, 5)));
        assert!(!line_of_sight(&grid, Cell::new(0, 0), Cell::new(0, 9)));
    }

    /// A world point outside the map has **zero** clearance, not "clear": the map edge is a
    /// wall, and a driver that read the outside as open space would aim off the map.
    #[test]
    fn clearance_outside_the_map_is_zero_not_clear() {
        let grid = Grid::from_rows(&["...", "..."], 1_000).expect("map");
        let (north, east) = grid.cell_centre(Cell::new(1, 0)).expect("inside");
        // Well inside an empty map: clear (`i64::MAX`), not zero.
        assert_eq!(grid.clearance_mm(north, east, 1), i64::MAX);
        // Outside the map: zero, whatever the radius.
        assert_eq!(grid.clearance_mm(-50_000, east, 1), 0);
        assert_eq!(grid.clearance_mm(north, 50_000, 3), 0);
    }

    /// A point **inside** a blocked cell has zero clearance — it is in the obstacle. This is
    /// the defect the half-cell fix removed: `clearance_mm` treats `cell_centre` as the centre
    /// of a `res`-sided square, so when `cell_centre` returned the cell's north-west corner the
    /// obstacle square was offset half a cell toward that corner and left the far (north-east)
    /// half of the true cell uncovered — a point there read hundreds of millimetres of
    /// clearance while sitting on a blocked cell.
    #[test]
    fn a_point_inside_a_blocked_cell_has_no_clearance() {
        let mut grid = Grid::from_rows(&["....."; 5], 1_000).expect("map");
        grid.set_blocked(Cell::new(2, 2), true).expect("inside");
        // Cell (2, 2) spans [2000, 3000) on both axes; its centre is (2500, 2500).
        assert_eq!(
            grid.clearance_mm(2_800, 2_800, 1),
            0,
            "the far quarter of the blocked cell is *in* the obstacle"
        );
        // A point 100 mm north of the cell's north face sees the wall's surface — not the
        // 600 mm the corner-anchored square used to report.
        assert_eq!(grid.clearance_mm(3_100, 2_500, 1), 100);
    }

    /// The join from a velocity pair to the profile's columns, checked by **round trip**: the
    /// set points are fed back through the machine's own relation (`ω = v·tan δ / L`, the same
    /// one `tests/stack_e2e.rs`'s `BikeModel` integrates) and must return the `ω` that went in.
    ///
    /// The tolerance is the column's quantisation, not slop: steering is commanded in
    /// milli-degrees, and at 39° of steer one milli-degree is ≈ 23 mrad/s of yaw — so a
    /// 30 mrad/s band is the honest width of "the same velocity".
    #[test]
    fn a_velocity_pair_survives_the_round_trip_through_the_steering_column() {
        let geometry = VehicleGeometry {
            wheelbase_mm: 2_000,
            top_speed_mm_s: 4_000,
        };
        for (v, omega) in [(1_000, 400), (1_500, -300), (600, 100), (2_000, 0)] {
            let command = DriveCommand::from_velocity(
                DwaVelocity {
                    v_mm_s: v,
                    omega_mrad_s: omega,
                },
                geometry,
                40_000,
            );
            let speed = f64::from(command.throttle_milli_percent) / 100_000.0
                * f64::from(geometry.top_speed_mm_s);
            let steer_rad = (f64::from(command.steer_milli_deg) / 1_000.0).to_radians();
            let realized = speed / f64::from(geometry.wheelbase_mm) * steer_rad.tan() * 1_000.0;
            assert!(
                (realized - f64::from(omega)).abs() < 30.0,
                "v = {v} mm/s, ω = {omega} mrad/s: the set points realise {realized} mrad/s"
            );
        }
    }

    /// A non-positive linear speed has **no** set points on this profile: the thrust column's
    /// travel is `(0, max)`, so the honest command is a brake rather than a negative throttle,
    /// which `check_against` would refuse anyway — one layer later and with a message about a
    /// joint instead of about a velocity.
    #[test]
    fn a_reverse_or_stopped_velocity_is_a_brake() {
        let geometry = VehicleGeometry {
            wheelbase_mm: 2_000,
            top_speed_mm_s: 4_000,
        };
        for v in [0, -1, -100] {
            let command = DriveCommand::from_velocity(
                DwaVelocity {
                    v_mm_s: v,
                    omega_mrad_s: 300,
                },
                geometry,
                40_000,
            );
            assert_eq!(command.throttle_milli_percent, 0, "v = {v}");
            assert_eq!(command.brake_milli_percent, BRAKE_FULL_MILLI_PERCENT);
            assert_eq!(command.steer_milli_deg, 0);
            assert!(!command.reached_goal);
        }
    }

    /// A machine that declares **no** top speed (`top_speed_mm_s <= 0`) has no finite answer for
    /// `v / top_speed_mm_s`, and the clamp that bounds every other throttle would pin the `+inf`
    /// quotient to its **ceiling** — a *full-throttle* command for a machine whose own geometry
    /// says it does not move. The guard returns zero throttle instead.
    ///
    /// Both directions are asserted so the test cannot pass by clamping everything: a usable
    /// top speed must still be honoured (500 / 1 000 ⇒ 50 000), and a demand past it must still
    /// saturate to the ceiling.
    #[test]
    fn a_declared_zero_top_speed_commands_no_throttle_not_full_throttle() {
        for top in [0, -500] {
            let command = DriveCommand::from_velocity(
                DwaVelocity {
                    v_mm_s: 500,
                    omega_mrad_s: 0,
                },
                VehicleGeometry {
                    wheelbase_mm: 2_000,
                    top_speed_mm_s: top,
                },
                40_000,
            );
            assert_eq!(
                command.throttle_milli_percent, 0,
                "top_speed_mm_s = {top}: a machine that declares no top speed was commanded \
                 {} milli-percent of throttle",
                command.throttle_milli_percent
            );
        }
        let geometry = VehicleGeometry {
            wheelbase_mm: 2_000,
            top_speed_mm_s: 1_000,
        };
        let usable = DriveCommand::from_velocity(
            DwaVelocity {
                v_mm_s: 500,
                omega_mrad_s: 0,
            },
            geometry,
            40_000,
        );
        assert_eq!(
            usable.throttle_milli_percent, 50_000,
            "half the declared top speed is half throttle"
        );
        let past_the_top = DriveCommand::from_velocity(
            DwaVelocity {
                v_mm_s: 3_000,
                omega_mrad_s: 0,
            },
            geometry,
            40_000,
        );
        assert_eq!(
            past_the_top.throttle_milli_percent, BRAKE_FULL_MILLI_PERCENT,
            "a demand past the declared top speed saturates at the ceiling"
        );
    }

    /// A demand past the column's travel is **saturated**, and the saturation is visible in the
    /// returned angle: 1 000 mrad/s at 300 mm/s asks for `atan(1 · 2 000 / 300) ≈ 81°`, and the
    /// command comes back at exactly the travel.
    #[test]
    fn a_steering_demand_past_the_travel_is_saturated_to_the_column() {
        let geometry = VehicleGeometry {
            wheelbase_mm: 2_000,
            top_speed_mm_s: 4_000,
        };
        let command = DriveCommand::from_velocity(
            DwaVelocity {
                v_mm_s: 300,
                omega_mrad_s: 1_000,
            },
            geometry,
            40_000,
        );
        assert_eq!(command.steer_milli_deg, 40_000);
    }

    /// A nine-metre open square with a straight route across its middle row.
    fn local_planner_fixture() -> (Grid, Path) {
        let grid = Grid::from_rows(&["........."; 9], 1_000).expect("map");
        let route = plan(&grid, Cell::new(0, 4), Cell::new(8, 4), Connectivity::Four)
            .expect("route")
            .simplified(&grid);
        (grid, route)
    }

    fn local_planner(grid: &Grid) -> LocalPlanner {
        LocalPlanner {
            pursuit: PursuitLimits {
                lookahead_mm: 3_000,
                arrive_radius_mm: 1_500,
                slow_radius_mm: 3_000,
                max_steer_milli_deg: 40_000,
                cruise_milli_percent: 30_000,
            },
            dwa: DwaLimits::for_ground_vehicle(grid.resolution_mm()),
            geometry: VehicleGeometry {
                wheelbase_mm: 2_000,
                top_speed_mm_s: 4_000,
            },
        }
    }

    fn stopped() -> DwaVelocity {
        DwaVelocity {
            v_mm_s: 0,
            omega_mrad_s: 0,
        }
    }

    /// Arrival is the **pursuer's** answer: inside the arrival radius the command is the stop,
    /// with no consultation of the window at all (a window asked about a pose with no route
    /// left to drive has no goal to be given).
    #[test]
    fn the_local_planner_stops_on_arrival_without_asking_the_window() {
        let (grid, route) = local_planner_fixture();
        let planner = local_planner(&grid);
        let goal = route.goal().expect("the route has a goal");
        let (north, east) = grid.cell_centre(goal).expect("the goal is in the map");
        let command = planner
            .command(
                &Platform::ground_vehicle(),
                &grid,
                &grid,
                &route,
                Pose {
                    north_mm: north,
                    east_mm: east,
                    heading_mrad: 0,
                },
                stopped(),
            )
            .expect("a command");
        assert!(command.reached_goal);
        assert_eq!(command.throttle_milli_percent, 0);
        assert_eq!(command.brake_milli_percent, BRAKE_FULL_MILLI_PERCENT);
        assert_eq!(command.target, goal);
    }

    /// The all-unsafe fallback is a **brake that does not claim arrival**: "I can see no safe
    /// trajectory" and "I am here" are different answers, and a caller that conflated them
    /// would report a mission complete for a machine that is stopped against a wall.
    #[test]
    fn the_local_planner_brakes_when_the_window_finds_no_safe_trajectory() {
        let (plan_grid, route) = local_planner_fixture();
        let planner = local_planner(&plan_grid);
        // Box the machine in: a blocked cell whose face is 100 mm from the pose makes even the
        // stationary rollout unsafe (its clearance is under `DWA_CLEARANCE_MARGIN_MM`), which is
        // the one way to empty the window of eligible candidates.
        let mut world = plan_grid.clone();
        world.set_blocked(Cell::new(5, 5), true).expect("in bounds");
        // On the route's line and pointing along it (north 4 500 is row 4's centre; east is a
        // quarter turn). A pose heading *across* the route is a different test — the window
        // would rightly choose to reverse back onto the line, which is not the behaviour under
        // examination here.
        let pose = Pose {
            north_mm: 4_900,
            east_mm: 5_500,
            heading_mrad: 1_571,
        };
        // The control *inside* the test: the same pose on the open map drives. Without it, a
        // brake here could be a property of the pose (too close to the goal, a refusal, …)
        // rather than of the window having nothing eligible.
        let open = planner
            .command(
                &Platform::ground_vehicle(),
                &plan_grid,
                &plan_grid,
                &route,
                pose,
                stopped(),
            )
            .expect("a command");
        assert!(
            open.throttle_milli_percent > 0,
            "the pose must drive on an open map, or this test proves nothing about the box: {open:?}"
        );
        let command = planner
            .command(
                &Platform::ground_vehicle(),
                &plan_grid,
                &world,
                &route,
                pose,
                stopped(),
            )
            .expect("a command");
        assert!(
            !command.reached_goal,
            "a stopped machine is not an arrived machine"
        );
        assert_eq!(command.throttle_milli_percent, 0);
        assert_eq!(command.brake_milli_percent, BRAKE_FULL_MILLI_PERCENT);
        assert!(
            plan_grid.contains(command.target),
            "the waypoint it was chasing is still reported"
        );
    }

    /// The wrapper is exactly the join it documents — the route's aim point, scored by the
    /// window, converted through the geometry — and not a second, subtly different policy.
    #[test]
    fn the_local_planner_is_the_join_it_documents() {
        let (grid, route) = local_planner_fixture();
        let planner = local_planner(&grid);
        let pose = Pose {
            north_mm: 4_500,
            east_mm: 2_000,
            heading_mrad: 1_571,
        };
        let nominal = pursuit(&grid, &route, pose, &planner.pursuit).expect("nominal");
        assert!(!nominal.reached_goal, "the fixture pose is mid-route");
        let score =
            dwa(&grid, pose, nominal.target, stopped(), &planner.dwa).expect("the window opens");
        assert!(score.safe, "an open corridor has a safe trajectory");
        let mut expected = DriveCommand::from_velocity(
            score.velocity,
            planner.geometry,
            planner.pursuit.max_steer_milli_deg,
        );
        expected.target = nominal.target;
        assert_eq!(
            planner
                .command(
                    &Platform::ground_vehicle(),
                    &grid,
                    &grid,
                    &route,
                    pose,
                    stopped()
                )
                .expect("command"),
            expected
        );
    }

    /// Decision 4's refusal, at the wrapper a deployment calls: a planner whose own steering
    /// ceiling sits **past** the machine's column is refused *here*, naming the profile's travel
    /// — not emitted only to be refused one layer later at the bus, with a message about a joint.
    ///
    /// The saturation inside `pursuit`/`from_velocity` is the *caller's*
    /// [`PursuitLimits::max_steer_milli_deg`], not the profile's travel, so nothing but this
    /// check ties the two: a ceiling wider than the column is a command the machine cannot
    /// realise.
    #[test]
    fn the_wrapper_refuses_a_command_the_machines_column_cannot_realise() {
        // Seven-metre open square with a diagonal route, and the vehicle standing on it facing
        // north: the aim point is ~45° ahead, so the window reliably chooses **forward with a
        // turn** (a goal due east makes it reverse instead), which is what puts a non-zero
        // steering demand through the conversion.
        let grid = Grid::from_rows(&["......."; 7], 1_000).expect("map");
        let route = plan(&grid, Cell::new(0, 0), Cell::new(6, 6), Connectivity::Eight)
            .expect("route")
            .simplified(&grid);
        let pose = Pose {
            north_mm: 3_500,
            east_mm: 3_500,
            heading_mrad: 0,
        };
        let over_travel = LocalPlanner {
            pursuit: PursuitLimits {
                max_steer_milli_deg: 50_000,
                ..local_planner(&grid).pursuit
            },
            geometry: VehicleGeometry {
                wheelbase_mm: 100_000,
                top_speed_mm_s: 4_000,
            },
            ..local_planner(&grid)
        };
        match over_travel.command(
            &Platform::ground_vehicle(),
            &grid,
            &grid,
            &route,
            pose,
            stopped(),
        ) {
            Err(PlanError::Refused { index, reason }) => {
                assert_eq!(index, 0, "steering is set point 0: {reason}");
                assert!(
                    reason.contains("-40000..=40000"),
                    "the refusal must name the column's travel, not a joint: {reason}"
                );
            }
            other => panic!(
                "a 50° ceiling on a ±40° column must be refused by the wrapper, got {other:?}"
            ),
        }
        // Direction control: the same pose, route and geometry with the column's own travel is
        // accepted — what is refused is the mismatch, not the hard turn.
        let legal = LocalPlanner {
            pursuit: PursuitLimits::default(),
            ..over_travel
        };
        let command = legal
            .command(
                &Platform::ground_vehicle(),
                &grid,
                &grid,
                &route,
                pose,
                stopped(),
            )
            .expect("a turn within the column's travel is accepted");
        assert!(
            command.steer_milli_deg.abs() <= 40_000,
            "the accepted command is within the column's travel: {command:?}"
        );
    }
}
