//! One patrol, end to end, with nothing but this crate and `amos-link` — **offline**.
//!
//! What it demonstrates, in the order the data flows:
//!
//! 1. **Plan** an occupancy grid to a goal, with line-of-sight smoothing (`planning`).
//! 2. **Drive** it with pure pursuit through a kinematic vehicle model, printing the commands the
//!    profile receives (this is the loop a real product runs at 10–50 Hz).
//! 3. **Estimate** the attitude from the run's own IMU samples, so the "which way am I pointing"
//!    half of the stack is visible beside the "where am I going" half (`fusion`).
//! 4. **Tick** a real control loop over the wheeled platform profile — a bridge, a control topic,
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
    plan, Cell, Connectivity, DriveCommand, Grid, Path, Pose, PursuitLimits,
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
