//! One patrol, end to end, with nothing but this crate and `amos-link` — **offline**.
//!
//! What it demonstrates, in the order the data flows:
//!
//! 1. **Plan** an occupancy grid to a goal, with line-of-sight smoothing (`planning`).
//! 2. **Drive** it with pure pursuit through a kinematic vehicle model, printing the commands the
//!    profile receives (this is the loop a real product runs at 10–50 Hz).
//! 3. **Obstruct** the route with a pallet the plan never saw, and drive it again — the same
//!    waypoints, but scored by the dynamic window against a *live* map (`LocalPlanner`), which is
//!    what turns a geometric tracker into one that can react.
//! 4. **Estimate** the attitude from the run's own IMU samples, so the "which way am I pointing"
//!    half of the stack is visible beside the "where am I going" half (`fusion`).
//! 5. **Tick** a real control loop over the wheeled platform profile — a bridge, a control topic,
//!    a mock bus — and print the **measured** cadence (`control`).
//!
//! ```text
//! cargo run -p amos-robot --example patrol_loop
//! ```
//!
//! Honest notes: the vehicle model here is a kinematic bicycle (no slip, no lag), the bus is the
//! middleware's `MockRobotHal`, and the map is a literal. Nothing in this file touches a device,
//! a network, or a wall clock beyond the loop's own timer.

use std::time::Duration;

use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::node::LinkNode;
use amos_link::platform::Platform;
use amos_link::qos::Qos;
use amos_link::robot_hal::{AgentAction, MockRobotHal, RobotBridge, RobotHal};
use amos_robot::control::ControlLoop;
use amos_robot::fusion::{AttitudeEstimator, ImuSample, STANDARD_GRAVITY_M_S2};
use amos_robot::planning::{
    plan, Cell, Connectivity, DriveCommand, DwaLimits, DwaVelocity, Grid, LocalPlanner, Path, Pose,
    PursuitLimits, VehicleGeometry,
};

/// The `ground-vehicle` profile the loop below drives (a `static` because `for_platform` wants a
/// `&'static Platform` — the same thing a deployment does by naming its profile once).
static VEHICLE: Platform = Platform::ground_vehicle();

/// The yard, in 1 m cells: `#` blocked, `.` free.
const YARD: [&str; 10] = [
    "............",
    "............",
    "............",
    ".....###....",
    ".....###....",
    ".....###....",
    "............",
    "............",
    "............",
    "............",
];

/// The patrol: start here, drive to there.
const START: Cell = Cell::new(0, 0);
const GOAL: Cell = Cell::new(11, 9);

/// A pallet that is **not** on the map the route was planned on. It sits on the route's first
/// leg (the line from `START` to the corridor's first corner passes through its centre), in a
/// spot the plan calls clear — which is the situation a reactive layer exists for: the plan is
/// geometrically valid and the world has moved on. It is deliberately **not** placed near the
/// yard's own block: a pallet that lands beside a wall leaves a machine no way past it, and a
/// local method cannot escape that (this is the honest local-minimum boundary, not a bug).
const HAZARD: Cell = Cell::new(1, 4);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let yard = Grid::from_rows(&YARD, 1_000)?;
    // 2 cells of clearance: a grid route is cell-safe, but the vehicle that tracks it cuts
    // corners (see `tests/stack_e2e.rs` for the measured version of that).
    let grid = yard.inflated(2)?;
    let path = plan(&grid, START, GOAL, Connectivity::Eight)?;
    let route = path.simplified(&grid);

    println!(
        "map {}x{} cells at {} mm · {} blocked cell(s) (before inflation) · route {} waypoint(s), \
         grid cost {:?}",
        yard.cols(),
        yard.rows(),
        yard.resolution_mm(),
        yard.blocked_cells(),
        route.len(),
        // `plan` always returns a contiguous route (a step sequence), so this is `Some`. The
        // `simplified` route below is waypoints, and its `cost()` is honestly `None`.
        path.cost()
    );
    print_map(&yard, &route);

    let limits = PursuitLimits {
        lookahead_mm: 1_500,
        // This machine turns in ~2.4 m, so the 400 mm default arrival radius would be
        // unreachable and the patrol would orbit its goal instead of reaching it.
        arrive_radius_mm: 2_500,
        cruise_milli_percent: 20_000,
        ..PursuitLimits::default()
    };
    let (start_north, start_east) = yard
        .cell_centre(START)
        .ok_or("the patrol's start cell is off the map")?;
    let mut vehicle = BikeModel::new(Pose {
        north_mm: start_north,
        east_mm: start_east,
        heading_mrad: 0,
    });
    let mut estimator = AttitudeEstimator::with_gains(1.0, 0.0);
    let dt_s = 0.05;

    println!("\n-- drive (0.05 s steps, pure pursuit) --");
    let mut reached = false;
    for step in 0..2_000 {
        let command = amos_robot::planning::pursuit(&grid, &route, vehicle.pose, &limits)?;
        if command.reached_goal {
            reached = true;
            println!("  step {step:>3}  {}", command.summary());
            break;
        }
        if step % 25 == 0 {
            println!("  step {step:>3}  {}", command.summary());
        }
        let before = vehicle.pose.heading_mrad;
        let pose = vehicle.advance(&command, dt_s);
        let yaw_rate = f64::from(pose.heading_mrad - before) / 1_000.0 / dt_s;
        estimator.update(
            &ImuSample::new(
                [0.0, 0.0, STANDARD_GRAVITY_M_S2],
                [0.0, 0.0, yaw_rate as f32],
            ),
            dt_s as f32,
        )?;
    }
    println!(
        "  reached_goal={reached} at ({}, {}) heading {} mrad",
        vehicle.pose.north_mm, vehicle.pose.east_mm, vehicle.pose.heading_mrad
    );
    let attitude = estimator.estimate();
    println!(
        "  fusion: {} ({} s integrated)",
        attitude.summary(),
        attitude.integrated_s
    );

    // ── the world changes, and the plan cannot ──
    //
    // A pallet appears on the route itself, after the route was planned. The map the route was
    // planned on is now stale, and `pursuit` — which can only see that map — would drive through
    // it. The local planner scores the machine's own reachable velocities against a *live* grid
    // instead, so the same route is followed around an obstacle it has no way to know about.
    if !grid.is_free(HAZARD) {
        return Err(format!(
            "the pallet at ({}, {}) is not on a cell the plan calls free — this demo would be \
             obstructing a wall",
            HAZARD.col, HAZARD.row
        )
        .into());
    }
    let mut live = grid.clone();
    live.set_blocked(HAZARD, true)?;
    println!(
        "\n-- drive (the same route, a pallet on ({}, {}) that the plan never saw) --",
        HAZARD.col, HAZARD.row
    );

    let local = LocalPlanner {
        pursuit: PursuitLimits {
            // The local goal has to be as far ahead as the window can see
            // (`max_v · DWA_HORIZON_STEPS · dt_s` = 1.0 m/s · 20 · 0.3 s = 6 m), or "end on the
            // goal" becomes optimal and the window caps the machine's speed accordingly.
            lookahead_mm: 6_000,
            arrive_radius_mm: 2_500,
            ..PursuitLimits::default()
        },
        dwa: DwaLimits {
            max_v_mm_s: 1_000,
            max_v_reverse_mm_s: 100,
            // The bicycle relation is the binding constraint, not taste: this machine's
            // steering saturates at 40°, so at 1 m/s a yaw rate above
            // `tan 40° · v / L ≈ 420 mrad/s` is a demand it cannot realise.
            max_omega_mrad_s: 400,
            max_accel_mm_s2: 3_000,
            max_alpha_mrad_s2: 4_000,
            // The *predictor's* sub-step, not the control cadence: the commands below are still
            // issued every 50 ms. A 6 s rollout is what lets the window see a swerve that clears.
            dt_s: 0.3,
            cell_mm: 1_000,
        },
        geometry: VehicleGeometry {
            wheelbase_mm: 2_000,
            top_speed_mm_s: 4_000,
        },
    };

    let mut vehicle = BikeModel::new(Pose {
        north_mm: start_north,
        east_mm: start_east,
        heading_mrad: 0,
    });
    let mut velocity = DwaVelocity {
        v_mm_s: 0,
        omega_mrad_s: 0,
    };
    let (hazard_north, hazard_east) = live
        .cell_centre(HAZARD)
        .ok_or("the pallet's cell is off the map")?;
    let mut reached = false;
    let mut hit = false;
    let mut closest_mm = i64::MAX;
    for step in 0..2_000 {
        let command = local.command(&VEHICLE, &grid, &live, &route, vehicle.pose, velocity)?;
        if command.reached_goal {
            reached = true;
            println!("  step {step:>3}  {}", command.summary());
            break;
        }
        if step % 25 == 0 {
            println!("  step {step:>3}  {}", command.summary());
        }
        let before = vehicle.pose.heading_mrad;
        let pose = vehicle.advance(&command, dt_s);
        // The window is hot-started from what the machine actually did.
        velocity = DwaVelocity {
            v_mm_s: (f64::from(command.throttle_milli_percent) / 100_000.0 * 4_000.0).round()
                as i32,
            omega_mrad_s: ((pose.heading_mrad - before) as f64 / dt_s).round() as i32,
        };
        if live.world_to_cell(pose.north_mm, pose.east_mm) == Some(HAZARD) {
            hit = true;
        }
        let north = (pose.north_mm - hazard_north) as f64;
        let east = (pose.east_mm - hazard_east) as f64;
        closest_mm = closest_mm.min((north * north + east * east).sqrt() as i64);
    }
    println!(
        "  reached_goal={reached}, ever inside the pallet cell={hit}, closest pass {closest_mm} mm \
         from the pallet's centre (the route runs through it), ended at ({}, {})",
        vehicle.pose.north_mm, vehicle.pose.east_mm
    );

    // ── the control loop, over the real bridge and the wheeled profile ──
    let node = LinkNode::in_process(PeerId::new("patrol-01")?, NodeKind::Robot);
    let bridge = RobotBridge::for_platform(
        node.subscriber::<AgentAction>(Topic::pattern("amos/patrol-01/control/*")?, Qos::control())
            .await?,
        MockRobotHal::new(),
        &VEHICLE,
    )?;
    let control_topic = node.publisher::<AgentAction>(Topic::channel_topic(
        "patrol-01",
        Channel::Control,
        "action",
    )?);

    println!(
        "\n-- control loop (20 ms, wheeled profile, deadman {:?}) --",
        VEHICLE.envelope().watchdog
    );

    // The commander's duty is to keep the set points flowing: arm once, then one drive command
    // per tick. The reliable control channel holds them, so a tick consumes exactly one.
    let drive = amos_robot::planning::pursuit(&grid, &route, vehicle.pose, &limits)?;
    // `pursuit` builds on the caller's `max_steer_milli_deg`, not the profile's column, so the
    // commander runs the profile check before anything reaches the wire — the join decision 4
    // of the planning module names, shown at the one place a command is actually published.
    drive.check_against(&VEHICLE)?;
    control_topic
        .publish(&AgentAction::new(r#"{"action":"arm"}"#))
        .await?;
    for _ in 0..4 {
        control_topic
            .publish(&AgentAction::new(drive.to_agent_json("hold")))
            .await?;
    }

    let mut control = ControlLoop::new(bridge, Duration::from_millis(20))?;
    control.run_ticks(5).await?;
    println!("  {}", control.stats().summary());
    println!(
        "  {} frame(s) on the mock bus, armed={}",
        control.bridge().hal().applied(),
        control.bridge().hal().armed()
    );

    // …and then the commander goes quiet, which is the case the profile's deadman exists for.
    // Two ticks with nothing to consume: the second one waits out the 100 ms deadman and the
    // vehicle stops itself. The cadence instrument reports it as work, not as a mystery.
    control.run_ticks(2).await?;
    println!(
        "  commander quiet ⇒ armed={} ({} frame(s) total; the deadman stopped it, and the loop \
         reports the 100 ms wait as work)",
        control.bridge().hal().armed(),
        control.bridge().hal().applied()
    );
    Ok(())
}

/// The vehicle model the example drives: a kinematic bicycle, in millimetres and milli-radians.
struct BikeModel {
    pose: Pose,
}

impl BikeModel {
    /// Wheelbase, millimetres.
    const WHEELBASE_MM: f64 = 2_000.0;
    /// Speed at 100% throttle, millimetres per second.
    const TOP_SPEED_MM_S: f64 = 4_000.0;

    fn new(pose: Pose) -> Self {
        Self { pose }
    }

    /// Advance one step under a command, returning the new pose.
    fn advance(&mut self, command: &DriveCommand, dt_s: f64) -> Pose {
        let speed = Self::TOP_SPEED_MM_S * (f64::from(command.throttle_milli_percent) / 100_000.0);
        let steer_rad = (f64::from(command.steer_milli_deg) / 1_000.0).to_radians();
        let heading_rad = f64::from(self.pose.heading_mrad) / 1_000.0;
        let next_heading = heading_rad + speed / Self::WHEELBASE_MM * steer_rad.tan() * dt_s;
        let mean_heading = 0.5 * (heading_rad + next_heading);
        let north = self.pose.north_mm as f64 + speed * mean_heading.cos() * dt_s;
        let east = self.pose.east_mm as f64 + speed * mean_heading.sin() * dt_s;
        self.pose = Pose {
            north_mm: north.round() as i64,
            east_mm: east.round() as i64,
            heading_mrad: (next_heading * 1_000.0).round() as i32,
        };
        self.pose
    }
}

/// Print the map with the route drawn on it (`o` start, `*` goal, `+` a route cell). Row 0 is
/// printed last, so north is at the top of the page — the way a map is read.
fn print_map(map: &Grid, route: &Path) {
    println!("\n-- map (north up; the route is drawn on the un-inflated occupancy) --");
    for row in (0..map.rows()).rev() {
        let mut line = String::new();
        for col in 0..map.cols() {
            let cell = Cell::new(col, row);
            let mark = if map.is_blocked(cell) {
                '#'
            } else if cell == START {
                'o'
            } else if cell == GOAL {
                '*'
            } else if route.cells().contains(&cell) {
                '+'
            } else {
                '.'
            };
            line.push(mark);
        }
        println!("  {line}");
    }
    println!(
        "  (the clearance the route was planned with is what the machine needs, not what the yard has)"
    );
}
