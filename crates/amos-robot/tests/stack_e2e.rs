//! The stack end to end, offline: **planner → set points → the profile's own JSON → the
//! control topic → the safety core → frames on a bus**, plus a closed-loop simulation that
//! says whether the planner and the pursuit law actually arrive.
//!
//! Why these live here and not in `src/`: every one of them needs `amos-link` (a node, a
//! broker, a bridge, a profile), and the point of the test is the *join* between the two
//! crates — a unit test on either side cannot fail when the join breaks. There is no device,
//! no network and no wall clock anywhere in this file: the one loop is a plain `for`
//! advanced by an explicit `dt_s`, and the vehicle model below is an explicit fixture, not a
//! simulator claim.

use std::sync::Arc;

use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::node::LinkNode;
use amos_link::platform::Platform;
use amos_link::qos::Qos;
use amos_link::robot_hal::{AgentAction, BridgeEvent, MockRobotHal, RobotBridge, RobotHal};
use amos_robot::fusion::{AttitudeEstimator, GravityCorrection, ImuSample, STANDARD_GRAVITY_M_S2};
use amos_robot::planning::{
    plan, pursuit, Cell, Connectivity, DwaLimits, DwaVelocity, Grid, LocalPlanner, Path, Pose,
    PursuitLimits, VehicleGeometry,
};

/// The `ground-vehicle` profile, in a `static` because `RobotBridge::for_platform` wants a
/// `&'static Platform` — the same requirement a real deployment satisfies by naming its
/// profile in a `const`/`static`.
static VEHICLE: Platform = Platform::ground_vehicle();

/// The map the closed-loop test drives on, in 1 m cells: a 12×10 m yard with a 3×3 m block in
/// the middle. The free space is deliberately generous — a grid planner says nothing about a
/// machine's turning radius, and a fixture that pretended otherwise would be testing the
/// fixture.
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

/// The vehicle model this file uses for its closed-loop run: a kinematic bicycle, in
/// millimetres and milli-radians.
///
/// It exists so the assertion can be "the route was driven and the goal was reached" rather
/// than "the numbers looked plausible". It is explicitly **not** a claim about a real car
/// (no slip, no mass, no tyre model, no actuator lag) — the honest boundary of this test is
/// *geometry*, not dynamics.
struct BikeModel {
    pose: Pose,
    /// Distance between the axles, millimetres.
    wheelbase_mm: f64,
    /// Top speed at 100% throttle, millimetres per second.
    top_speed_mm_s: f64,
}

impl BikeModel {
    fn new(pose: Pose) -> Self {
        Self {
            pose,
            wheelbase_mm: 2_000.0,
            top_speed_mm_s: 4_000.0,
        }
    }

    /// Advance one step under a command, sampling the swept position.
    ///
    /// `dt_s` is the step the model is integrated with; the caller keeps it equal to the
    /// command cadence so the geometry (not the integrator) is what is under test.
    fn advance(&mut self, steer_milli_deg: i32, throttle_milli_percent: i32, dt_s: f64) -> Pose {
        let speed_mm_s = self.top_speed_mm_s * (f64::from(throttle_milli_percent) / 100_000.0);
        // Milli-degrees → degrees → radians: the steering command is the profile's unit.
        let steer_rad = (f64::from(steer_milli_deg) / 1_000.0).to_radians();
        let heading_rad = f64::from(self.pose.heading_mrad) / 1_000.0;
        let next_heading = heading_rad + speed_mm_s / self.wheelbase_mm * steer_rad.tan() * dt_s;
        // Midpoint integration: the position advances along the average heading.
        let mean_heading = 0.5 * (heading_rad + next_heading);
        let north = self.pose.north_mm as f64 + speed_mm_s * mean_heading.cos() * dt_s;
        let east = self.pose.east_mm as f64 + speed_mm_s * mean_heading.sin() * dt_s;
        self.pose = Pose {
            north_mm: north.round() as i64,
            east_mm: east.round() as i64,
            heading_mrad: (next_heading * 1_000.0).round() as i32,
        };
        self.pose
    }
}

/// A robot node with a bridge for the wheeled profile, and a commander on the same node.
async fn wheeled_robot() -> (
    RobotBridge<MockRobotHal>,
    amos_link::pubsub::Publisher<AgentAction>,
    Arc<LinkNode>,
) {
    let node = LinkNode::in_process(PeerId::new("yard-01").expect("peer"), NodeKind::Robot);
    let subscriber = node
        .subscriber::<AgentAction>(
            Topic::pattern("amos/yard-01/control/*").expect("pattern"),
            Qos::control(),
        )
        .await
        .expect("subscribe");
    let publisher = node.publisher::<AgentAction>(
        Topic::channel_topic("yard-01", Channel::Control, "action").expect("topic"),
    );
    let bridge = RobotBridge::for_platform(subscriber, MockRobotHal::new(), &VEHICLE)
        .expect("the profile's envelope is valid");
    (bridge, publisher, node)
}

/// A straight corridor, 24 m east by 9 m north, all free.
///
/// The route runs along the middle row. What makes it an *avoidance* fixture is the order of
/// operations in the test: the route is planned on this map, and only then is a cell of it
/// blocked. A planner cannot anticipate an obstacle that appears after it planned, which is
/// exactly the situation a reactive layer exists for.
const CORRIDOR: [&str; 9] = ["........................"; 9];

/// The cell of [`CORRIDOR`] that is set down on top of the route *after* it was planned.
const POP_UP: Cell = Cell::new(12, 4);

/// The machine the avoidance test drives: a small steered vehicle, deliberately nimbler than
/// the [`BikeModel`] default (a 1 m wheelbase turns in `1/tan 40° ≈ 1.19 m`), because the
/// point of the test is the *join* between the window and the profile's columns, not how tight
/// a particular car can turn.
const AVOID_GEOMETRY: VehicleGeometry = VehicleGeometry {
    wheelbase_mm: 1_000,
    top_speed_mm_s: 2_000,
};

/// The route-tracking limits the avoidance test uses.
///
/// The **lookahead is the local goal's distance**, and it is not free: DWA's progress term
/// measures the distance from a rollout's end to the goal, so a goal closer than one rollout
/// (i.e. `max_v · DWA_HORIZON_STEPS · dt_s` = 4.5 m here) makes "end exactly on the goal"
/// optimal, and the window caps the machine's speed at `lookahead / horizon` — measured, a
/// 1.5 m lookahead with a 3 s horizon held the vehicle at 380–500 mm/s for the whole corridor.
/// The goal has to be as far ahead as the planner can see, or the planner is asked to solve a
/// problem it cannot express.
///
/// The arrival radius must exceed the fixture's turn radius (`1/tan 40°` of a 1 m wheelbase
/// ≈ 1.19 m), or the pursuer orbits the goal instead of reaching it — the constraint
/// [`PursuitLimits::arrive_radius_mm`] names.
fn avoid_pursuit_limits() -> PursuitLimits {
    PursuitLimits {
        lookahead_mm: 4_500,
        arrive_radius_mm: 1_500,
        slow_radius_mm: 3_000,
        max_steer_milli_deg: 40_000,
        cruise_milli_percent: 30_000,
    }
}

/// The dynamic window the avoidance test scores with.
///
/// Two numbers are sized rather than picked, and both are what make the fixture an avoidance
/// test instead of a stall:
///
/// * **The rollout sub-step.** The lookahead is `DWA_HORIZON_STEPS · dt_s`, and an arc that
///   rounds a 1 m obstacle with a 1.19 m turn radius is a metre and a half of lateral travel —
///   so a 20-step horizon needs about 3 s of rollout to *see* a swerve that clears. At the
///   50 ms sub-step the control loop ticks at, the window sees 1 s (≈ 1.5 m at cruise), every
///   forward arc ends inside the obstacle, and DWA picks its degenerate zero-velocity
///   candidate (which is collision-free precisely because it goes nowhere) and stalls. This
///   0.2 s sub-step is the *predictor's* granularity, not the control cadence: the machine is
///   still commanded every 50 ms.
/// * **`max_omega_mrad_s`.** The bicycle relation `ω = v·tan δ / L` makes the machine's real
///   yaw-rate ceiling speed-dependent, and [`DriveCommand::from_velocity`] saturates a demand
///   past the steering travel. The test asserts below that the *selected* candidate was never
///   one the machine could not realise, which is what makes the window's score transfer to the
///   machine rather than staying a fiction.
fn avoid_dwa_limits() -> DwaLimits {
    DwaLimits {
        max_v_mm_s: 1_500,
        max_v_reverse_mm_s: 100,
        max_omega_mrad_s: 900,
        max_accel_mm_s2: 3_000,
        max_alpha_mrad_s2: 4_000,
        dt_s: 0.2,
        cell_mm: 1_000,
    }
}

/// What one run of the corridor did.
struct CorridorRun {
    /// The route's goal was reported reached.
    reached: bool,
    /// The vehicle occupied [`POP_UP`] at some tick.
    entered: bool,
    /// The velocity→set-point conversion had to move the steering demand by more than a
    /// milli-degree of rounding to fit the column. On the avoidance run this must stay `false`:
    /// a saturated steer means the arc DWA scored is not the arc the machine drove.
    saturated: bool,
    /// Steps taken, for the "it actually drove" assertion.
    steps: usize,
}

/// Drive the corridor once, with the command built from the same pieces a caller would use:
/// [`pursuit`] for the goal, [`dwa`] for the command, [`DriveCommand::from_velocity`] for the
/// set points.
///
/// The join is written out here rather than hidden behind [`LocalPlanner`] so the test can see
/// the window's own choice — which is the only way to assert that the arc that was *scored* is
/// the arc that was *driven*.
///
/// `avoid` picks the command source and nothing else, so the two runs differ in exactly the
/// claim under test:
///
/// * `false` — [`pursuit`] on the map the route was planned on, i.e. a tracker that cannot see
///   the pop-up. This is the negative control: it must drive into the cell.
/// * `true` — the route's aim point scored by the window against the *live* map.
fn drive_corridor(avoid: bool) -> CorridorRun {
    let plan_grid = Grid::from_rows(&CORRIDOR, 1_000).expect("the corridor parses");
    let start = Cell::new(0, 4);
    let goal = Cell::new(23, 4);
    let route = plan(&plan_grid, start, goal, Connectivity::Four)
        .expect("the corridor is open")
        .simplified(&plan_grid);
    // The pop-up goes in *after* the plan, in a copy of the map the planner never saw.
    let mut world = plan_grid.clone();
    world
        .set_blocked(POP_UP, true)
        .expect("the pop-up is in bounds");

    let limits = avoid_pursuit_limits();
    let dwa_limits = avoid_dwa_limits();
    let planner = LocalPlanner {
        pursuit: limits,
        dwa: dwa_limits,
        geometry: AVOID_GEOMETRY,
    };

    let (start_north, start_east) = plan_grid.cell_centre(start).expect("start centre");
    let mut vehicle = BikeModel::new(Pose {
        north_mm: start_north,
        east_mm: start_east,
        // North is 0 and clockwise is positive, so east is a quarter turn.
        heading_mrad: 1_571,
    });
    vehicle.wheelbase_mm = f64::from(AVOID_GEOMETRY.wheelbase_mm);
    vehicle.top_speed_mm_s = f64::from(AVOID_GEOMETRY.top_speed_mm_s);

    let dt_s = 0.05;
    let mut run = CorridorRun {
        reached: false,
        entered: false,
        saturated: false,
        steps: 0,
    };
    let mut velocity = DwaVelocity {
        v_mm_s: 0,
        omega_mrad_s: 0,
    };
    for _ in 0..4_000 {
        let nominal = pursuit(&plan_grid, &route, vehicle.pose, &limits).expect("a command");
        let command = if nominal.reached_goal {
            run.reached = true;
            break;
        } else if avoid {
            // The diagnostic first: the window's own choice, so the test can assert that the
            // arc that was *scored* is an arc the conversion could *realise*. (It is the same
            // call `LocalPlanner::command` makes below — deterministic, and worth the second
            // evaluation to keep the assertion about the geometry rather than about the
            // wrapper agreeing with itself.)
            let score = amos_robot::planning::dwa(
                &world,
                vehicle.pose,
                nominal.target,
                velocity,
                &dwa_limits,
            )
            .expect("the window is well-formed");
            if !score.safe {
                panic!(
                    "no safe trajectory at step {}: stopping instead of driving",
                    run.steps
                );
            }
            // The demand before the column's saturation, in milli-degrees.
            let v = f64::from(score.velocity.v_mm_s);
            let demand = (f64::from(score.velocity.omega_mrad_s) / 1_000.0
                * f64::from(AVOID_GEOMETRY.wheelbase_mm)
                / v)
                .atan()
                .to_degrees();
            if demand.abs() > 40.0 {
                run.saturated = true;
            }
            // And the production path: the same window, through the wrapper a deployment calls.
            planner
                .command(&VEHICLE, &plan_grid, &world, &route, vehicle.pose, velocity)
                .expect("the wrapper must produce a command for every tick it is driven")
        } else {
            // The blind tracker: the route's own map, which does not contain the pop-up.
            nominal
        };
        let before = vehicle.pose;
        let pose = vehicle.advance(
            command.steer_milli_deg,
            command.throttle_milli_percent,
            dt_s,
        );
        run.steps += 1;
        // The window is hot-started from what the machine *actually did*, not from what it was
        // asked: a conversion bug shows up here as a growing mismatch, not as silence.
        let v_mm_s = (f64::from(command.throttle_milli_percent) / 100_000.0
            * vehicle.top_speed_mm_s)
            .round() as i32;
        let omega_mrad_s = ((pose.heading_mrad - before.heading_mrad) as f64 / dt_s).round() as i32;
        velocity = DwaVelocity {
            v_mm_s,
            omega_mrad_s,
        };
        let cell = world
            .world_to_cell(pose.north_mm, pose.east_mm)
            .expect("the vehicle stays on the map");
        if cell == POP_UP {
            run.entered = true;
        }
    }
    run
}

/// The join the audit found missing (REQ-A672): `dwa` was implemented and unit-tested, and no code
/// outside its own tests ever called it — there was no `(v, ω)` → set-point conversion at all.
/// This drives it in a loop — and, in the same fixture, drives the blind tracker that shows the
/// loop is not passing for free.
#[test]
fn the_local_planner_steers_around_an_obstacle_the_route_does_not_know() {
    let run = drive_corridor(true);
    assert!(
        !run.entered,
        "the local planner drove into the pop-up at ({}, {})",
        POP_UP.col, POP_UP.row
    );
    assert!(run.reached, "the local planner must still arrive");
    assert!(
        !run.saturated,
        "a saturating steer means the arc DWA scored is not the arc that was driven"
    );
    assert!(
        run.steps > 50,
        "{} step(s) is not a driven route, it is a lucky straight line",
        run.steps
    );
}

/// The negative control for the test above: with the *same* fixture, the route's own map and
/// the same pursuer, and only the reactive layer removed, the machine drives into the pop-up.
///
/// Without this, "it reached the goal without hitting anything" could be a property of the
/// corridor (wide, straight, obstacle nowhere near the line) rather than of the planner.
#[test]
fn the_negative_control_drives_into_the_obstacle_the_route_does_not_know() {
    let run = drive_corridor(false);
    assert!(
        run.entered,
        "the blind pursuer must hit the pop-up — otherwise the avoidance test proves nothing"
    );
}

#[tokio::test]
async fn a_planned_command_reaches_the_bus_through_the_profiles_own_json() {
    let (mut bridge, publisher, _node) = wheeled_robot().await;
    let grid = Grid::from_rows(&["."; 10], 1_000).expect("map");
    let path = plan(&grid, Cell::new(0, 0), Cell::new(0, 9), Connectivity::Four).expect("route");
    let command = amos_robot::planning::pursuit(
        &grid,
        &path,
        Pose {
            north_mm: 0,
            east_mm: 0,
            heading_mrad: 0,
        },
        &PursuitLimits::default(),
    )
    .expect("a command");

    // The commander sends two actions: arm (this profile does not arm on motion) and the drive.
    publisher
        .publish(&AgentAction::new(r#"{"action":"arm"}"#))
        .await
        .expect("publish arm");
    let json = command.to_agent_json("hold");
    publisher
        .publish(&AgentAction::new(json.clone()))
        .await
        .expect("publish drive");

    // Tick 1: arming is applied.
    match bridge.step().await.expect("step") {
        BridgeEvent::Applied { .. } => {}
        other => panic!("an arm must be applied, got {other:?}"),
    }
    // Tick 2: the drive command is applied as the profile's own set points.
    match bridge.step().await.expect("step") {
        BridgeEvent::Applied { frames, armed, .. } => {
            assert!(armed, "the vehicle was armed on the previous tick");
            let intent = VEHICLE.parse_intent(&json).expect("the profile accepts it");
            let expected = VEHICLE.plan(&intent).expect("plan").len();
            assert_eq!(
                frames, expected,
                "the frames on the bus must be the profile's own plan of the same set points"
            );
        }
        other => panic!("the drive command must be applied, got {other:?}"),
    }
    assert!(bridge.hal().applied() > 0, "frames reached the bus");
    assert_eq!(bridge.hal().name(), "mock");
}

#[tokio::test]
async fn the_route_is_actually_driven_and_the_goal_is_reached() {
    // The composition claim of this crate: a grid route plus the pursuit law drives a kinematic
    // vehicle from start to goal *around* an obstacle, the machine's swept path stays out of the
    // **real** obstacles, and a 6-DOF estimator fed the run's own IMU tracks the heading while
    // it happens.
    let yard = Grid::from_rows(&YARD, 1_000).expect("the yard map parses");
    // The planner cannot know a footprint, and pure pursuit demonstrably cuts a corner: on a
    // map like this one, routing on the raw occupancy puts the vehicle in the cell diagonally
    // beside the block (measured on this fixture's earlier 10×8 shape: cell (4, 3) at
    // (3875, 4007)). So the map is inflated 2 cells (~2 m) — which is what a deployment does
    // with a machine whose turning radius is not zero (a 2 m wheelbase at 40° of steering turns
    // in 2.38 m).
    let grid = yard
        .inflated(2)
        .expect("a 2-cell footprint is a legal inflation");
    let start = Cell::new(0, 0);
    let goal = Cell::new(11, 9);
    let path: Path = plan(&grid, start, goal, Connectivity::Eight).expect("a route exists");
    let route = path.simplified(&grid);

    let limits = PursuitLimits {
        // A shorter lookahead than the default: the overshoot of a pure-pursuit tracker on a
        // curve scales like `lookahead² / (2 · turn radius)`, which for this fixture's 2.38 m
        // radius is ≈ 1.9 m at the default 3 m — more than the 2 m of clearance the inflated
        // map reserves. 1.5 m brings that to ≈ 0.5 m, i.e. inside the budget with margin.
        lookahead_mm: 1_500,
        // The machine in this test turns in ~2.4 m, so the 400 ms default arrival radius is
        // unreachable and the pursuer would orbit the goal instead of reaching it. 2.5 m is the
        // smallest honest value for this fixture — see `PursuitLimits::arrive_radius_mm`.
        arrive_radius_mm: 2_500,
        cruise_milli_percent: 20_000,
        ..PursuitLimits::default()
    };
    let (start_north, start_east) = yard.cell_centre(start).expect("start centre");
    let mut vehicle = BikeModel::new(Pose {
        north_mm: start_north,
        east_mm: start_east,
        heading_mrad: 0,
    });
    let mut estimator = AttitudeEstimator::with_gains(1.0, 0.0);
    let level_gravity = [0.0, 0.0, STANDARD_GRAVITY_M_S2];

    let dt_s = 0.05;
    let mut visited: Vec<Cell> = Vec::new();
    let mut reached = false;
    for _ in 0..2_000 {
        let command =
            amos_robot::planning::pursuit(&grid, &route, vehicle.pose, &limits).expect("command");
        if command.reached_goal {
            reached = true;
            break;
        }
        // The model advances; the estimator is fed the yaw rate that implies, which is what a
        // real IMU would report for a level body (z up).
        let before = vehicle.pose.heading_mrad;
        let pose = vehicle.advance(
            command.steer_milli_deg,
            command.throttle_milli_percent,
            dt_s,
        );
        let yaw_rate = f64::from(pose.heading_mrad - before) / 1_000.0 / dt_s;
        estimator
            .update(
                &ImuSample::new(level_gravity, [0.0, 0.0, yaw_rate as f32]),
                dt_s as f32,
            )
            .expect("a level, 50 ms IMU sample is integrable");
        let cell = yard.world_to_cell(pose.north_mm, pose.east_mm);
        let Some(cell) = cell else {
            panic!(
                "the vehicle left the map at ({}, {}), heading {} mrad",
                pose.north_mm, pose.east_mm, pose.heading_mrad
            );
        };
        assert!(
            yard.is_free(cell),
            "the vehicle entered the obstacle at ({}, {}) from ({}, {})",
            cell.col,
            cell.row,
            pose.north_mm,
            pose.east_mm
        );
        visited.push(cell);
    }
    assert!(reached, "the route must be driven to its end: {visited:?}");
    assert!(
        visited.len() > route.len(),
        "a route of {} kept cell(s) cannot be driven in {} step(s)",
        route.len(),
        visited.len()
    );
    // The estimator saw the same motion: its yaw tracks the model's heading.
    let attitude = estimator.estimate();
    assert_eq!(attitude.correction, GravityCorrection::Applied);
    let heading_deg = (f64::from(vehicle.pose.heading_mrad) / 1_000.0).to_degrees();
    // Both are angles, and they use different domains: the model's heading accumulates
    // without bound while `yaw_rad` is wrapped to `(-180, 180]`. Wrap the difference so a
    // net turn past ±180° over the route cannot masquerade as a huge "drift".
    let raw = f64::from(attitude.yaw_rad.to_degrees()) - heading_deg;
    let drift = ((raw + 180.0).rem_euclid(360.0) - 180.0).abs();
    assert!(
        drift < 3.0,
        "the estimator must track the heading it was fed: drift {drift} deg, heading {} mrad, \
         yaw {} rad",
        vehicle.pose.heading_mrad,
        attitude.yaw_rad
    );
}
