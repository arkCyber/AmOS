//! The stack end to end, offline: **planner → set points → the profile's own JSON → the
//! control topic → the safety core → frames on a bus**, plus a closed-loop simulation that
//! says whether the planner and the pursuit law actually arrive.
//!
//! Why these live here and not in `src/`: every one of them needs `amos-link` (a node, a
//! broker, a bridge, a profile), and the point of the test is the *join* between the two
//! crates — a unit test on either side cannot fail when the join breaks. There is no device,
//! no network and no wall clock anywhere in this file: the one loop uses `tokio::time` only
//! for its ticks, and the vehicle model below is an explicit fixture, not a simulator claim.

use std::sync::Arc;

use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::node::LinkNode;
use amos_link::platform::Platform;
use amos_link::qos::Qos;
use amos_link::robot_hal::{AgentAction, BridgeEvent, MockRobotHal, RobotBridge, RobotHal};
use amos_robot::fusion::{AttitudeEstimator, GravityCorrection, ImuSample, STANDARD_GRAVITY_M_S2};
use amos_robot::planning::{plan, Cell, Connectivity, Grid, Path, Pose, PursuitLimits};

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
    let drift = (f64::from(attitude.yaw_rad.to_degrees()) - heading_deg).abs();
    assert!(
        drift < 3.0,
        "the estimator must track the heading it was fed: drift {drift} deg, heading {} mrad, \
         yaw {} rad",
        vehicle.pose.heading_mrad,
        attitude.yaw_rad
    );
}
