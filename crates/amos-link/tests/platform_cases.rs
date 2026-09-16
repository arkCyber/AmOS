//! Platform-profile tests: the layer that lets one OS serve six machines.
//!
//! Two things are pinned here and they are different in kind:
//!
//! 1. **The reference machine did not change.** `Platform::quadruped()` plans into frames that
//!    are **byte-identical** to the hand-written `robot_hal::plan` for every gait and speed, and
//!    the `Vocabulary::Reference` path (what `RobotBridge::new` uses) is the same behaviour
//!    through the new seam. Without this, "one mechanism, six profiles" would be a claim about
//!    code that only looks alike.
//! 2. **Every profile is self-consistent and its envelope has teeth.** One `Arm` and one `Halt`
//!    per profile, poses that fit their own actuator table, a deadman a report can carry, a
//!    declared manoeuvre for a lost link, and refusals that name the action, the actuator or the
//!    *limit* that was asked to be exceeded (never a silent clamp).

use std::sync::Arc;
use std::time::Duration;

use amos_link::broker::{Broker, Transport};
use amos_link::codec::Clock;
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::platform::{
    ActionSpec, Actuator, ActuatorRole, Failsafe, IntentClass, ParamSpec, Platform, PlatformKind,
    SafetyEnvelope, Unit, Vocabulary,
};
use amos_link::pubsub::{Publisher, Subscriber};
use amos_link::qos::Qos;
use amos_link::robot_hal::{
    parse_command, plan as legacy_plan, ActuationState, AgentAction, BridgeEvent, EstopReason,
    Gait, MockRobotHal, MotorOp, RobotBridge, RobotCommand, RobotHal, JOINTS, MAX_JOINT,
    MAX_TORQUE_MILLI_PERCENT, MAX_WATCHDOG_MS,
};

/// The robot every profile-driven case runs as.
const ROBOT: &str = "case-robot";

/// A link of one process (the shape every case uses).
struct TestLink {
    transport: Arc<dyn Transport>,
    metrics: Arc<LinkMetrics>,
    clock: Arc<Clock>,
}

impl TestLink {
    fn new() -> Self {
        let metrics = Arc::new(LinkMetrics::new());
        Self {
            transport: Broker::with_metrics(Arc::clone(&metrics)).shared(),
            metrics,
            clock: Arc::new(Clock::host()),
        }
    }

    fn node(&self, id: &str, kind: NodeKind) -> Arc<LinkNode> {
        Arc::new(LinkNode::with_parts(
            PeerId::new(id).expect("peer id"),
            kind,
            Arc::clone(&self.transport),
            Arc::clone(&self.clock),
            Arc::clone(&self.metrics),
        ))
    }
}

/// A control subscriber for the case robot (what a bridge binds to).
async fn control(link: &TestLink) -> Subscriber<AgentAction> {
    Subscriber::<AgentAction>::subscribe(
        Arc::clone(&link.transport),
        Topic::pattern(format!("amos/{ROBOT}/control/*")).expect("pattern"),
        Qos::control(),
        Arc::clone(&link.metrics),
    )
    .await
    .expect("subscribe the control channel")
}

/// A commander for the case robot.
fn commander(link: &TestLink, robot: &Arc<LinkNode>) -> Publisher<AgentAction> {
    let _ = link;
    robot.publisher::<AgentAction>(
        Topic::channel_topic(ROBOT, Channel::Control, "action").expect("topic"),
    )
}

/// Send one action and return the sequence the frame carried.
async fn send(commander: &Publisher<AgentAction>, json: &str) {
    let report = commander
        .publish(&AgentAction::new(json))
        .await
        .expect("publish the action");
    assert_eq!(report.matched, Some(1), "the bridge must be subscribed");
}

// ── 1. the reference machine is unchanged ──────────────────────────────────────────

#[test]
fn the_quadruped_profile_reproduces_the_shipping_planner() {
    // Byte-for-byte, for every gait and a spread of speeds: the profile layer is the *same*
    // planner expressed as data — not a second opinion about where the joints go.
    let platform = Platform::quadruped();
    for gait in [Gait::Stand, Gait::Trot, Gait::Walk, Gait::Sit] {
        for speed in [0.0f32, 0.25, 0.5, 0.6, 0.8, 1.0] {
            let legacy = legacy_plan(&RobotCommand {
                gait,
                speed,
                duration_ms: 800,
                targets: Vec::new(),
            });
            let intent = platform
                .parse_intent(&format!(r#"{{"action":"{}","speed":{speed}}}"#, gait.key()))
                .expect("the profile knows this gait");
            let planned = platform.plan(&intent).expect("a plan");
            assert_eq!(
                planned,
                legacy,
                "`{}` at speed {speed}: the profile's frames must be the shipping frames",
                gait.key()
            );
        }
    }

    // …and the two non-motion actions, where the batch *is* the safety action.
    for (key, expected_op) in [("arm", MotorOp::Enable), ("estop", MotorOp::Estop)] {
        let legacy = legacy_plan(&RobotCommand {
            gait: Gait::from_key(key).expect("gait"),
            speed: 0.0,
            duration_ms: 0,
            targets: Vec::new(),
        });
        let intent = platform
            .parse_intent(&format!(r#"{{"action":"{key}"}}"#))
            .expect("the profile knows this action");
        let planned = platform.plan(&intent).expect("a plan");
        assert_eq!(planned, legacy, "`{key}` must be the shipping batch");
        assert_eq!(planned.len(), JOINTS);
        assert!(planned.iter().all(|f| f.op == expected_op));
    }

    // A joint target travels through the profile exactly as it did through `plan`.
    let json = r#"{"action":"trot","speed":0.6,"targets":[{"actuator":1,"arg":-12345}]}"#;
    let legacy = legacy_plan(
        &parse_command(
            r#"{"action":"trot","speed":0.6,"targets":[{"joint":1,"milli_deg":-12345}]}"#,
        )
        .expect("the shipping parser"),
    );
    assert_eq!(
        platform
            .plan(&platform.parse_intent(json).expect("a valid intent"))
            .expect("a plan"),
        legacy,
        "the profile's `actuator` is the shipping `joint`"
    );
}

#[test]
fn the_reference_vocabulary_still_speaks_the_old_vocabulary() {
    // `Vocabulary::Reference` is what `RobotBridge::new` uses; it must be the shipping behaviour
    // through the new seam, including the refusal sentence operators read.
    let vocabulary = Vocabulary::Reference;
    let json = r#"{"action":"trot","speed":0.6,"duration_ms":800}"#;
    let intent = vocabulary.parse(json).expect("a valid reference action");
    assert_eq!(intent.action, "trot");
    assert_eq!(intent.class, IntentClass::Motion);
    assert_eq!(intent.speed, 0.6);
    assert_eq!(intent.duration_ms, 800);
    assert_eq!(
        vocabulary.plan(&intent).expect("a plan"),
        legacy_plan(&parse_command(json).expect("the shipping parser")),
        "the same frames, through the new seam"
    );

    for (json, class) in [
        (r#"{"action":"arm"}"#, IntentClass::Arm),
        (r#"{"action":"estop"}"#, IntentClass::Halt),
        (r#"{"action":"sit"}"#, IntentClass::Motion),
    ] {
        assert_eq!(vocabulary.parse(json).expect("valid").class, class);
    }
    assert_eq!(
        vocabulary.arm_hint(),
        r#"e-stop latched: send {"action":"arm"} to re-arm"#,
        "the operator-facing sentence is unchanged for the reference machine"
    );
    assert_eq!(vocabulary.label(), "quadruped");
    assert_eq!(Vocabulary::Reference.arm_key(), "arm");
}

// ── 2. every profile is self-consistent, and its envelope has teeth ────────────────

/// The six profiles, with the name a failure message should use.
fn profiles() -> Vec<(PlatformKind, Platform)> {
    PlatformKind::all()
        .into_iter()
        .map(|kind| (kind, Platform::of_kind(kind)))
        .collect()
}

#[test]
fn every_profile_is_self_consistent() {
    for (kind, platform) in profiles() {
        let label = kind.key();
        assert_eq!(platform.kind(), kind, "{label}: the kind must round-trip");
        // The library's own rule — the same one `Platform::from_parts` runs on a deployment's
        // profile — agrees with the assertions below (two expressions of one invariant: these
        // have the human messages, `validate` is what a hand-written machine meets).
        platform
            .validate()
            .unwrap_or_else(|e| panic!("{label}: the built-in must pass its own rule: {e}"));

        // Actuators: contiguous from 0 (the frame's `id` byte is the index), inside the frame's
        // own argument space, named, and inside the 12-actuator boundary this layer registers.
        assert!(!platform.actuators().is_empty(), "{label}: no actuators");
        let mut names = std::collections::BTreeSet::new();
        for (position, actuator) in platform.actuators().iter().enumerate() {
            assert_eq!(
                usize::from(actuator.index),
                position,
                "{label}: actuator indices must be contiguous from 0"
            );
            assert!(
                names.insert(actuator.name),
                "{label}: duplicate actuator name {}",
                actuator.name
            );
            assert!(
                actuator.index <= MAX_JOINT,
                "{label}: actuator {} exceeds the 12-actuator boundary",
                actuator.index
            );
            let (fmin, fmax) = actuator.unit.frame_bounds();
            assert!(
                actuator.travel.0 >= fmin && actuator.travel.1 <= fmax,
                "{label}: {} travel {:?} exceeds the frame's {fmin}..={fmax} space",
                actuator.name,
                actuator.travel
            );
            assert!(
                actuator.travel.0 <= actuator.travel.1,
                "{label}: {} has an inverted travel",
                actuator.name
            );
            assert!(
                actuator.check(actuator.travel.0).is_ok()
                    && actuator.check(actuator.travel.1).is_ok(),
                "{label}: {} refuses its own boundary",
                actuator.name
            );
            assert!(
                actuator.check(actuator.travel.1.saturating_add(1)).is_err(),
                "{label}: {} accepts a set point past its travel",
                actuator.name
            );
        }

        // Vocabulary: one Arm, one Halt (the safety core's two sentences), unique keys, poses
        // that fit the actuator table, and parameters that are bounded and uniquely named.
        assert!(
            platform.action_of_class(IntentClass::Arm).is_some(),
            "{label}: no Arm action — there is no way to re-arm"
        );
        assert!(
            platform.action_of_class(IntentClass::Halt).is_some(),
            "{label}: no Halt action — there is no way to stop"
        );
        let mut keys = std::collections::BTreeSet::new();
        for action in platform.actions() {
            assert!(
                keys.insert(action.key),
                "{label}: duplicate action {}",
                action.key
            );
            assert!(
                action.pose.is_empty() || action.pose.len() == platform.actuators().len(),
                "{label}: `{}` has {} pose entries for {} actuators",
                action.key,
                action.pose.len(),
                platform.actuators().len()
            );
            assert!(
                !(action.pose.is_empty() && action.speed_scaled),
                "{label}: `{}` asks a speed to scale an absent pose",
                action.key
            );
            if action.class != IntentClass::Motion {
                assert!(
                    action.pose.iter().all(|arg| *arg == 0),
                    "{label}: `{}` is not a motion, so its pose must be inert",
                    action.key
                );
            }
            for (index, arg) in action.pose.iter().enumerate() {
                let actuator = &platform.actuators()[index];
                assert!(
                    actuator.check(*arg).is_ok(),
                    "{label}: `{}` sets {} to {arg}, outside its travel",
                    action.key,
                    actuator.name
                );
            }
            let mut param_names = std::collections::BTreeSet::new();
            for param in action.params {
                assert!(
                    param_names.insert(param.name),
                    "{label}: `{}` declares `{}` twice",
                    action.key,
                    param.name
                );
                assert!(
                    param.range.0 <= param.range.1,
                    "{label}: `{}`'s `{}` has an inverted range",
                    action.key,
                    param.name
                );
            }
        }

        // Envelope: a deadman a report can carry, and a manoeuvre for a lost link that is honest
        // about the machine — a drone may not answer silence with "stop".
        platform.envelope().validate().expect("a usable envelope");
        assert!(
            platform.envelope().watchdog.as_millis() <= u128::from(MAX_WATCHDOG_MS),
            "{label}: deadman too long for a report"
        );
        if kind.must_manoeuvre_when_lost() {
            assert!(
                !platform.envelope().failsafe.is_stop(),
                "{label}: a machine that cannot stop safely must declare a manoeuvre"
            );
        }
    }
}

#[test]
fn a_lost_link_is_answered_by_the_declared_manoeuvre() {
    // The six answers, explicit: this is the table a deployment's mission layer reads before it
    // trusts "the bridge cut the motors".
    let expected = [
        (PlatformKind::Quadruped, Failsafe::Stop),
        (PlatformKind::Manipulator, Failsafe::Hold),
        (PlatformKind::Drone, Failsafe::ReturnToBase),
        (PlatformKind::GroundVehicle, Failsafe::MinimalRiskManoeuvre),
        (PlatformKind::SurfaceVessel, Failsafe::Loiter),
        (PlatformKind::IndustrialCell, Failsafe::Stop),
    ];
    for (kind, failsafe) in expected {
        let platform = Platform::of_kind(kind);
        assert_eq!(platform.envelope().failsafe, failsafe, "{}", kind.key());
        assert_eq!(
            Failsafe::from_key(failsafe.key()),
            Some(failsafe),
            "{}: the manoeuvre's key must round-trip",
            kind.key()
        );
    }
    assert_eq!(PlatformKind::from_key("uav"), Some(PlatformKind::Drone));
    assert_eq!(
        PlatformKind::from_key("agv"),
        Some(PlatformKind::GroundVehicle)
    );
    assert_eq!(Failsafe::from_key("made-up"), None, "never invented");
    assert_eq!(PlatformKind::from_key("submarine"), None);
    assert!(
        PlatformKind::Drone.must_manoeuvre_when_lost()
            && PlatformKind::SurfaceVessel.must_manoeuvre_when_lost()
            && !PlatformKind::Quadruped.must_manoeuvre_when_lost(),
        "an aircraft and a boat cannot answer silence with a torque cut"
    );
}

// ── 3. refusals name what was asked, never a silent clamp ──────────────────────────

#[test]
fn an_unknown_action_names_the_profile_and_its_vocabulary() {
    let err = Platform::drone()
        .parse_intent(r#"{"action":"backflip"}"#)
        .expect_err("a drone has no backflip");
    let message = err.to_string();
    assert!(message.contains("unknown action"), "{message}");
    assert!(message.contains("backflip"), "{message}");
    assert!(message.contains("drone"), "…and which machine: {message}");
    assert!(
        message.contains("takeoff"),
        "…and what it does have: {message}"
    );
    // The reference machine's own parser keeps its own (shorter) message — unchanged. A profile
    // is allowed (and expected) to name the machine and its vocabulary instead.
    assert!(
        Platform::quadruped()
            .parse_intent(r#"{"action":"backflip"}"#)
            .expect_err("no backflip")
            .to_string()
            .contains("for platform quadruped"),
        "the profile names the machine"
    );
    assert_eq!(
        Vocabulary::Reference
            .parse(r#"{"action":"backflip"}"#)
            .expect_err("no backflip")
            .to_string(),
        parse_command(r#"{"action":"backflip"}"#)
            .expect_err("the shipping parser refuses it too")
            .to_string(),
        "…while the shipping bridge's vocabulary says exactly what it always said"
    );

    // A malformed body is a parse failure, not an invented action.
    assert!(Platform::drone()
        .parse_intent("not json")
        .expect_err("not JSON")
        .to_string()
        .contains("not valid JSON"));
    // A speed outside the shared range is refused for every profile.
    assert!(Platform::drone()
        .parse_intent(r#"{"action":"hover","speed":2.0}"#)
        .expect_err("speed 2")
        .to_string()
        .contains("outside [0, 1]"));
}

#[test]
fn a_parameter_outside_the_envelope_is_refused_naming_the_limit() {
    // The geofence: a drone asked to fly outside it is refused, and the sentence carries the
    // number the operator has to argue with.
    let drone = Platform::drone();
    assert!(
        drone
            .parse_intent(r#"{"action":"goto","params":{"north_mm":120000}}"#)
            .is_ok(),
        "inside the fence"
    );
    assert!(
        drone
            .parse_intent(r#"{"action":"goto","params":{"north_mm":-300000}}"#)
            .is_ok(),
        "the fence's own boundary is legal"
    );
    let message = drone
        .parse_intent(r#"{"action":"goto","params":{"north_mm":300001}}"#)
        .expect_err("past the fence")
        .to_string();
    assert!(
        message.contains("north_mm") && message.contains("300001"),
        "{message}"
    );
    assert!(
        message.contains("-300000") && message.contains("300000"),
        "the limit itself is in the sentence: {message}"
    );

    // Each domain's own limit: the layer carries them, the profile declares them.
    let cases = [
        (
            Platform::drone(),
            r#"{"action":"goto","params":{"altitude_mm":200000}}"#,
            "altitude_mm",
        ),
        (
            Platform::ground_vehicle(),
            r#"{"action":"cruise","params":{"speed_mm_s":40000}}"#,
            "speed_mm_s",
        ),
        (
            Platform::ground_vehicle(),
            r#"{"action":"slow","params":{"decel_mm_s2":9000}}"#,
            "decel_mm_s2",
        ),
        (
            Platform::surface_vessel(),
            r#"{"action":"station_keep","params":{"radius_mm":60000}}"#,
            "radius_mm",
        ),
        (
            Platform::industrial_cell(),
            r#"{"action":"cycle","params":{"cycle_ms":50}}"#,
            "cycle_ms",
        ),
        (
            Platform::manipulator(),
            r#"{"action":"move","params":{"speed_milli_percent":200000}}"#,
            "speed_milli_percent",
        ),
    ];
    for (platform, json, name) in cases {
        let message = platform
            .parse_intent(json)
            .expect_err("outside the envelope")
            .to_string();
        assert!(
            message.contains(name),
            "{}: the refusal must name `{name}`: {message}",
            platform.kind().key()
        );
        assert!(
            message.contains("outside the limit"),
            "{}: …and say it is a limit: {message}",
            platform.kind().key()
        );
    }
}

#[test]
fn an_unknown_parameter_is_refused_rather_than_dropped() {
    // An unrecognised limit is not a hint. Silently dropping `ceiling_mm` would send a drone on a
    // mission whose ceiling nobody checked — the failure this layer exists to catch.
    let message = Platform::drone()
        .parse_intent(r#"{"action":"goto","params":{"ceiling_mm":10000}}"#)
        .expect_err("unknown parameter")
        .to_string();
    assert!(message.contains("no parameter `ceiling_mm`"), "{message}");
    assert!(
        message.contains("goto") && message.contains("drone"),
        "{message}"
    );

    // …and a parameter an action cannot use is refused too (a fence on `land` is meaningless).
    assert!(Platform::drone()
        .parse_intent(r#"{"action":"land","params":{"north_mm":1000}}"#)
        .expect_err("land takes no fence")
        .to_string()
        .contains("no parameter `north_mm`"));
}

#[test]
fn a_set_point_outside_the_actuator_travel_is_refused() {
    let drone = Platform::drone();
    let ok = drone
        .parse_intent(r#"{"action":"hover","targets":[{"actuator":4,"arg":30000}]}"#)
        .expect("an elevon at its boundary");
    assert_eq!(ok.set_points[0].arg, 30_000);
    let err = drone
        .parse_intent(r#"{"action":"hover","targets":[{"actuator":4,"arg":30001}]}"#)
        .expect_err("past the elevon's travel");
    assert!(err.to_string().contains("elevon_left"), "{err}");
    let err = drone
        .parse_intent(r#"{"action":"hover","targets":[{"actuator":0,"arg":-1000}]}"#)
        .expect_err("a thruster cannot go negative");
    assert!(err.to_string().contains("thruster_1"), "{err}");
    let err = drone
        .parse_intent(r#"{"action":"hover","targets":[{"actuator":9,"arg":0}]}"#)
        .expect_err("no ninth actuator");
    assert!(
        err.to_string().contains("no actuator 9"),
        "an unknown actuator is named: {err}"
    );
}

#[test]
fn the_halt_of_each_profile_is_that_machines_stop() {
    // One class, six actuations — and the reference machine's is the one it always was.
    let frames = Platform::quadruped().halt_frames().expect("a halt");
    assert_eq!(frames.len(), JOINTS);
    assert!(
        frames.iter().all(|f| f.op == MotorOp::Estop),
        "the reference machine cuts torque on every joint"
    );
    assert!(
        Platform::quadruped()
            .enable_frames()
            .expect("an energize")
            .iter()
            .all(|f| f.op == MotorOp::Enable),
        "…and energizes every joint to re-arm"
    );

    let frames = Platform::ground_vehicle().halt_frames().expect("a halt");
    let brake = frames
        .iter()
        .find(|f| f.joint.index() == 2)
        .expect("the brake is in the batch");
    assert_eq!(
        (brake.op, brake.arg),
        (MotorOp::SetTorque, MAX_TORQUE_MILLI_PERCENT),
        "a car's stop is full braking"
    );
    assert_eq!(
        frames
            .iter()
            .find(|f| f.joint.index() == 1)
            .expect("throttle")
            .op,
        MotorOp::Estop,
        "…and the throttle is cut"
    );

    for kind in PlatformKind::all() {
        let platform = Platform::of_kind(kind);
        let frames = platform.halt_frames().expect("a halt");
        assert_eq!(
            frames.len(),
            platform.actuators().len(),
            "{}: one frame per actuator",
            kind.key()
        );
        for frame in &frames {
            frame
                .validate()
                .unwrap_or_else(|e| panic!("{}: a halt frame must be legal: {e}", kind.key()));
        }
        assert_eq!(
            platform.enable_frames().expect("an energize").len(),
            platform.actuators().len()
        );
    }
}

#[test]
fn a_missing_set_point_is_refused_and_never_zeroed() {
    // The teleop shape: `move` has no pose, so the intent has to name every actuator. A short
    // vector is refused — a zero *is* a set point, and completing a partial command with zeros
    // would command joints nobody mentioned.
    let arm = Platform::manipulator();
    let partial = r#"{"action":"move","targets":[{"actuator":0,"arg":5000},
        {"actuator":1,"arg":-5000},{"actuator":2,"arg":1000}]}"#;
    let message = arm
        .plan(
            &arm.parse_intent(partial)
                .expect("parses: completeness is a planning question"),
        )
        .expect_err("three of seven")
        .to_string();
    assert!(message.contains("every actuator"), "{message}");
    assert!(
        message.contains("j4"),
        "…naming the first missing one: {message}"
    );

    let full = r#"{"action":"move","targets":[{"actuator":0,"arg":5000},{"actuator":1,"arg":-5000},
        {"actuator":2,"arg":1000},{"actuator":3,"arg":0},{"actuator":4,"arg":-2000},
        {"actuator":5,"arg":500},{"actuator":6,"arg":40000}]}"#;
    let frames = arm
        .plan(&arm.parse_intent(full).expect("every actuator is named"))
        .expect("a plan");
    assert_eq!(frames.len(), 7);
    assert_eq!(frames[6].arg, 40_000, "the gripper's own set point");
    assert!(frames[..6].iter().all(|f| f.op == MotorOp::SetPosition));
    assert_eq!(frames[6].op, MotorOp::SetTorque);
}

// ── 4. one safety core: the profile-driven bridge ──────────────────────────────────

/// The drone profile as a `'static` reference (the bridge stores one).
const DRONE: Platform = Platform::drone();
/// The cell profile, whose arm action is `enable` rather than `arm`.
const CELL: Platform = Platform::industrial_cell();

/// The return path as the case's peer reads it.
async fn state_subscriber(link: &TestLink) -> Subscriber<ActuationState> {
    Subscriber::<ActuationState>::subscribe(
        Arc::clone(&link.transport),
        amos_link::robot_hal::actuation_pattern().expect("pattern"),
        Qos::for_channel(Channel::State),
        Arc::clone(&link.metrics),
    )
    .await
    .expect("subscribe the return path")
}

#[tokio::test]
async fn a_profile_bridge_latches_refuses_and_reports() {
    let link = TestLink::new();
    let robot = link.node(ROBOT, NodeKind::Robot);
    let mut bridge = RobotBridge::for_platform(control(&link).await, MockRobotHal::new(), &DRONE)
        .expect("a usable envelope")
        .reporting(robot.publisher::<ActuationState>(
            amos_link::robot_hal::actuation_topic(robot.peer()).expect("the return path's topic"),
        ));
    assert_eq!(bridge.platform_label(), "drone");
    assert_eq!(
        bridge.watchdog(),
        Some(DRONE.envelope().watchdog),
        "the deadman comes from the profile, not from a constructor argument"
    );
    let mut modes = state_subscriber(&link).await;
    let commands = commander(&link, &robot);

    // A set point on disarmed drives is refused — with the profile's own arm key. A drone
    // accepts no motion before it is armed, and the *measured* bus state is what decides.
    send(&commands, r#"{"action":"takeoff"}"#).await;
    match bridge.step().await.expect("one step") {
        BridgeEvent::Refused { reason, .. } => {
            assert!(reason.contains("not armed"), "{reason}");
            assert!(reason.contains(r#"{"action":"arm"}"#), "{reason}");
        }
        other => panic!("expected a refusal while disarmed, got {other:?}"),
    }
    let mode = modes.recv().await.expect("the refusal is reported").message;
    assert!(!mode.armed, "nothing energized the drives");
    assert!(mode.last_refusal.is_some());

    // Arm with the profile's own key …
    send(&commands, r#"{"action":"arm"}"#).await;
    assert_eq!(
        bridge.step().await.expect("the arm step"),
        BridgeEvent::Applied {
            seq: 2,
            frames: 6,
            armed: true
        }
    );
    let mode = modes.recv().await.expect("the arm is reported").message;
    assert!(mode.armed && !mode.estopped);
    assert_eq!(
        mode.watchdog_ms,
        Some(DRONE.envelope().watchdog.as_millis() as u64),
        "the deadman comes from the profile"
    );

    // … and the same action is applied through the *shipping* HAL and frame type.
    send(&commands, r#"{"action":"takeoff"}"#).await;
    assert_eq!(
        bridge.step().await.expect("the takeoff"),
        BridgeEvent::Applied {
            seq: 3,
            frames: 6,
            armed: true
        },
        "four thrusters and two elevons"
    );
    // The bridge's mode (`armed`/`estopped`/`reason`/`gait`/`refusal`) is **unchanged** by
    // this step: a profile's arm step already latched `armed=true, estop_reason=None` and a
    // motion action on an armed, non-estopped profile flips none of them. `gait` is the
    // reference machine's vocabulary and is intentionally `None` for a profile (the report
    // contract documented on `for_platform`). So the right thing to check here is the
    // bridge's local state, not a wire report: the report only fires on mode change, and
    // for a profile arm → motion no mode changes.
    let mode = bridge.state();
    assert!(mode.armed && !mode.estopped);
    assert_eq!(mode.seq, Some(3));
    assert_eq!(mode.frames, 6);
    assert_eq!(
        mode.gait, None,
        "the shared document's `gait` is the reference machine's vocabulary; a profile leaves it empty"
    );

    // Its e-stop latches, and a refusal names the *profile's* arm key.
    send(&commands, r#"{"action":"estop"}"#).await;
    assert_eq!(
        bridge.step().await.expect("the stop"),
        BridgeEvent::Estopped {
            reason: EstopReason::Commanded,
            frames: 6
        }
    );
    let mode = modes.recv().await.expect("the stop is reported").message;
    assert!(mode.estopped && !mode.armed);
    assert_eq!(mode.estop_reason, Some(EstopReason::Commanded));

    send(
        &commands,
        r#"{"action":"goto","params":{"north_mm":10000}}"#,
    )
    .await;
    match bridge.step().await.expect("the refusal") {
        BridgeEvent::Refused { reason, .. } => {
            assert!(reason.contains("e-stop latched"), "{reason}");
            assert!(
                reason.contains(r#"{"action":"arm"}"#),
                "the drone's own arm key: {reason}"
            );
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    let mode = modes.recv().await.expect("the refusal is reported").message;
    assert!(mode.last_refusal.is_some(), "a refusal travels back");
    assert!(mode.estopped, "…and does not clear the latch");

    // Re-arm, then let the link go quiet: the deadman trips, and the manoeuvre is declared.
    send(&commands, r#"{"action":"arm"}"#).await;
    assert_eq!(
        bridge.step().await.expect("the second arm step"),
        BridgeEvent::Applied {
            seq: 6,
            frames: 6,
            armed: true
        }
    );
    let mode = modes.recv().await.expect("the arm is reported").message;
    assert!(mode.armed && !mode.estopped);
    assert!(matches!(
        bridge.step().await.expect("the watchdog step"),
        BridgeEvent::Estopped {
            reason: EstopReason::Watchdog,
            frames: 6
        }
    ));
    let mode = modes.recv().await.expect("the cut is reported").message;
    assert_eq!(mode.estop_reason, Some(EstopReason::Watchdog));
    assert_eq!(
        DRONE.envelope().failsafe,
        Failsafe::ReturnToBase,
        "…and what this machine owes itself is declared, for the mission layer to fly"
    );
}

#[tokio::test]
async fn a_cell_bridge_tells_the_operator_its_own_arm_key() {
    // The sentence must be usable: a cell's arm action is `enable`, and telling its operator to
    // send `arm` would be telling them to send an action this machine does not have.
    let link = TestLink::new();
    let robot = link.node(ROBOT, NodeKind::Robot);
    let mut bridge = RobotBridge::for_platform(control(&link).await, MockRobotHal::new(), &CELL)
        .expect("a usable envelope");
    let commands = commander(&link, &robot);

    send(&commands, r#"{"action":"stop"}"#).await;
    assert!(matches!(
        bridge.step().await.expect("the stop"),
        BridgeEvent::Estopped {
            reason: EstopReason::Commanded,
            frames: 4
        }
    ));
    send(
        &commands,
        r#"{"action":"cycle","params":{"cycle_ms":1000}}"#,
    )
    .await;
    match bridge.step().await.expect("the refusal") {
        BridgeEvent::Refused { reason, .. } => assert!(
            reason.contains(r#"{"action":"enable"}"#),
            "the cell's own arm key: {reason}"
        ),
        other => panic!("expected a refusal, got {other:?}"),
    }
    send(&commands, r#"{"action":"enable"}"#).await;
    assert!(matches!(
        bridge.step().await.expect("the enable step"),
        BridgeEvent::Applied { frames: 4, .. }
    ));
    assert_eq!(Vocabulary::Profile(&CELL).arm_key(), "enable");
}

#[tokio::test]
async fn a_profile_arm_step_does_not_claim_a_reference_gait() {
    // The report contract: a profile's `gait` field is **always** `None`, because the field
    // is the reference machine's vocabulary and putting a profile's action key there would
    // be a payload-schema change. This holds even when the profile's arm_key happens to be
    // one that *aliases* into a reference `Gait` — the drone uses `"arm"` and the cell uses
    // `"enable"`, both of which `Gait::from_key` maps to `Gait::Arm`. The bridge must NOT
    // let that aliasing leak into the report: a `gait=arm` value on a non-quadruped profile
    // would be a UI lie (the machine never executed a quadruped gait).
    for (profile, arm_key) in [(&DRONE, "arm"), (&CELL, "enable")] {
        let link = TestLink::new();
        let robot = link.node(ROBOT, NodeKind::Robot);
        let mut bridge =
            RobotBridge::for_platform(control(&link).await, MockRobotHal::new(), profile)
                .expect("a usable envelope");
        let commands = commander(&link, &robot);

        send(&commands, &format!(r#"{{"action":"{arm_key}"}}"#)).await;
        let event = bridge.step().await.expect("the arm step");
        assert!(
            matches!(event, BridgeEvent::Applied { armed: true, .. }),
            "{profile:?} arm step returns Applied: {event:?}"
        );
        assert_eq!(
            bridge.state().gait,
            None,
            "{profile:?} reports gait=None after arm, even though its arm_key \
             (\"{arm_key}\") aliases into Gait::Arm — the report must not carry a \
             reference-machine gait for a profile"
        );
    }
}

#[tokio::test]
async fn a_lost_link_stops_the_machine_and_the_mission_layer_finishes_the_manoeuvre() {
    // The drone case, asserted: the bridge's deadman cuts the motors — the minimum safe action at
    // this layer — **and** the profile names what the mission layer owes the aircraft. Flying home
    // is that layer's job: it is the only one that knows where home is.
    let link = TestLink::new();
    let robot = link.node(ROBOT, NodeKind::Robot);
    let mut bridge = RobotBridge::for_platform(control(&link).await, MockRobotHal::new(), &DRONE)
        .expect("a usable envelope");
    let commands = commander(&link, &robot);

    // Nothing moves on a disarmed aircraft: the first takeoff is refused, and the refusal names
    // the profile's own arm key.
    send(&commands, r#"{"action":"takeoff"}"#).await;
    match bridge.step().await.expect("the disarmed takeoff") {
        BridgeEvent::Refused { reason, .. } => assert!(reason.contains("not armed"), "{reason}"),
        other => panic!("expected a refusal while disarmed, got {other:?}"),
    }

    send(&commands, r#"{"action":"arm"}"#).await;
    assert_eq!(
        bridge.step().await.expect("arm"),
        BridgeEvent::Applied {
            seq: 2,
            frames: 6,
            armed: true
        }
    );
    send(&commands, r#"{"action":"takeoff"}"#).await;
    assert_eq!(
        bridge.step().await.expect("takeoff"),
        BridgeEvent::Applied {
            seq: 3,
            frames: 6,
            armed: true
        }
    );

    // The link is lost: the deadman stops the machine …
    assert!(matches!(
        bridge.step().await.expect("the watchdog"),
        BridgeEvent::Estopped {
            reason: EstopReason::Watchdog,
            frames: 6
        }
    ));
    // … and the manoeuvre is the *declared* one, not an assumption.
    assert!(PlatformKind::Drone.must_manoeuvre_when_lost());
    assert_eq!(DRONE.envelope().failsafe, Failsafe::ReturnToBase);
    let rtl = DRONE
        .plan(
            &DRONE
                .parse_intent(r#"{"action":"rtl"}"#)
                .expect("rtl is in the vocabulary"),
        )
        .expect("the manoeuvre plans through the same frame type");
    assert_eq!(rtl.len(), 6);
    let hal = MockRobotHal::new();
    hal.apply(&rtl).await.expect("the mission layer flies it");
    assert_eq!(hal.applied(), 6);
    assert!(
        rtl[..4].iter().all(|f| f.op == MotorOp::SetTorque),
        "the return leg is thrust on all four motors"
    );
    assert!(
        rtl[4..]
            .iter()
            .all(|f| f.op == MotorOp::SetPosition && f.arg == 0),
        "…with the elevons levelled, and this is the *same* frame type the bus already takes"
    );
}

// ── 6. the acceptance boundary: nothing is accepted and then dropped ───────────────
//
// The three cases below were found by *measuring* the layer instead of reading it: each used to be
// accepted, validated — and then quietly not used, which is the shape of defect this middleware
// refuses everywhere else (a missing set point is refused, never zeroed; an unknown parameter is
// refused, never dropped). Each pins the refusal **and** the input that must still go through.

#[test]
fn a_speed_that_cannot_be_honoured_is_refused_not_dropped() {
    // Measured before this existed: `{"action":"takeoff","speed":0.0}` and `speed:1.0` planned the
    // **same** four 55 % thrust frames — the number was parsed, range-checked and then dropped, so
    // a ground station asking for a gentle takeoff got full thrust and no indication.
    let drone = Platform::drone();
    let message = drone
        .parse_intent(r#"{"action":"takeoff","speed":0.1}"#)
        .expect_err("`takeoff`'s pose is its thrust, not a multiple of it")
        .to_string();
    assert!(message.contains("takeoff"), "{message}");
    assert!(message.contains("fixed pose"), "{message}");
    assert!(
        message.contains("drone") && message.contains("0.1"),
        "…naming the machine and the number it cannot honour: {message}"
    );

    // A motion that *does* scale still takes a speed: the reference machine's gaits, unchanged.
    let quadruped = Platform::quadruped();
    for speed in [0.0f32, 0.25, 0.6, 1.0] {
        assert!(
            quadruped
                .parse_intent(&format!(r#"{{"action":"trot","speed":{speed}}}"#))
                .is_ok(),
            "the shipping planner's speed must still parse"
        );
    }
    // An out-of-range speed keeps its own sentence (the shared rule fires first)…
    assert!(drone
        .parse_intent(r#"{"action":"takeoff","speed":2.0}"#)
        .expect_err("speed 2")
        .to_string()
        .contains("outside [0, 1]"));
    // …and a cosmetic field still never blocks an energize or a stop (the shipping shape).
    assert!(drone
        .parse_intent(r#"{"action":"arm","speed":0.2}"#)
        .is_ok());
    assert!(drone
        .parse_intent(r#"{"action":"estop","speed":9}"#)
        .is_ok());

    // The general rule, over every action of every profile: an explicit speed is either honoured
    // (`speed_scaled`) or refused — never silently ignored.
    let mut checked = 0usize;
    for kind in PlatformKind::all() {
        let platform = Platform::of_kind(kind);
        for action in platform.actions() {
            if action.class != IntentClass::Motion {
                continue;
            }
            let json = format!(r#"{{"action":"{}","speed":0.25}}"#, action.key);
            assert_eq!(
                platform.parse_intent(&json).is_ok(),
                action.speed_scaled,
                "{}: `{}` must honour a speed or refuse it, not drop it",
                kind.key(),
                action.key
            );
            checked += 1;
        }
    }
    assert!(
        checked >= 20,
        "every profile's motions were covered ({checked})"
    );
}

#[test]
fn two_set_points_for_one_actuator_are_refused_rather_than_first_wins() {
    // `iter().find(|s| s.actuator == …)` returns the **first** match, so the second entry used to
    // vanish: the caller's own field order decided which of two contradicting thrusts a drone flew
    // (measured: `arg:90000` disappeared behind `arg:10000`).
    let drone = Platform::drone();
    let message = drone
        .parse_intent(
            r#"{"action":"hover","targets":[{"actuator":0,"arg":10000},{"actuator":0,"arg":90000}]}"#,
        )
        .expect_err("one actuator, two values")
        .to_string();
    assert!(message.contains("twice"), "{message}");
    assert!(
        message.contains("thruster_1"),
        "…naming the actuator: {message}"
    );

    // One set point per actuator is the shipping shape and stays: the override, two *different*
    // actuators, and the teleop vector that must name all seven.
    assert!(drone
        .parse_intent(r#"{"action":"hover","targets":[{"actuator":0,"arg":10000}]}"#)
        .is_ok());
    assert!(drone
        .parse_intent(
            r#"{"action":"hover","targets":[{"actuator":0,"arg":10000},{"actuator":1,"arg":90000}]}"#
        )
        .is_ok());
    assert!(Platform::manipulator()
        .parse_intent(
            r#"{"action":"move","targets":[{"actuator":0,"arg":1},{"actuator":1,"arg":2},
                {"actuator":2,"arg":3},{"actuator":3,"arg":4},{"actuator":4,"arg":5},
                {"actuator":5,"arg":6},{"actuator":6,"arg":7}]}"#
        )
        .is_ok());
}

#[test]
fn an_action_that_is_its_target_is_refused_without_one() {
    // `{"action":"goto"}` used to be accepted and planned the profile's default 58 % thrust pose: a
    // "go to" that goes nowhere, wearing the action's name — which is how a machine moves because a
    // tool forgot to fill a field.
    let drone = Platform::drone();
    let message = drone
        .parse_intent(r#"{"action":"goto"}"#)
        .expect_err("a target with no target is not a `goto`")
        .to_string();
    assert!(
        message.contains("goto") && message.contains("drone"),
        "{message}"
    );
    assert!(
        message.contains("north_mm")
            && message.contains("east_mm")
            && message.contains("altitude_mm"),
        "…and lists what a target could be: {message}"
    );
    // One coordinate is enough — `0` is a coordinate, not an absent one.
    assert!(drone
        .parse_intent(r#"{"action":"goto","params":{"north_mm":0}}"#)
        .is_ok());
    // A wrong target is refused for being wrong, not for being incomplete (the limit comes first).
    assert!(drone
        .parse_intent(r#"{"action":"goto","params":{"north_mm":400000}}"#)
        .expect_err("past the fence")
        .to_string()
        .contains("outside the limit"));
    // The vessel's `waypoint` is a point too.
    assert!(Platform::surface_vessel()
        .parse_intent(r#"{"action":"waypoint"}"#)
        .expect_err("a point with no coordinates")
        .to_string()
        .contains("x_mm"));
    assert!(Platform::surface_vessel()
        .parse_intent(r#"{"action":"waypoint","params":{"y_mm":-1200}}"#)
        .is_ok());

    // …while an action whose parameter has a documented default still needs none. This is the list
    // that keeps `min_params` from becoming "every action must be given everything".
    for (platform, action) in [
        (Platform::ground_vehicle(), "lane_keep"),
        (Platform::ground_vehicle(), "cruise"),
        (Platform::ground_vehicle(), "slow"),
        (Platform::industrial_cell(), "cycle"),
        (Platform::surface_vessel(), "station_keep"),
        (Platform::surface_vessel(), "loiter"),
        (Platform::manipulator(), "grip"),
    ] {
        let json = format!(r#"{{"action":"{action}"}}"#);
        assert!(
            platform.parse_intent(&json).is_ok(),
            "{}: `{action}` has a documented default and must not need a parameter",
            platform.kind().key()
        );
    }
    // …and the same actions still take one.
    assert!(Platform::industrial_cell()
        .parse_intent(r#"{"action":"cycle","params":{"cycle_ms":1500}}"#)
        .is_ok());
}

// ── 7. a deployment writes its own machine (data, checked) ─────────────────────────

/// One actuator, reusable through struct-update syntax so a longer table stays readable.
const THRUST: Actuator = Actuator {
    index: 0,
    name: "thrust",
    role: ActuatorRole::Thrust,
    unit: Unit::MilliPercent,
    travel: (0, MAX_TORQUE_MILLI_PERCENT),
};

/// The envelope a test profile declares, unless the envelope is the thing being tested.
fn envelope() -> SafetyEnvelope {
    SafetyEnvelope {
        watchdog: Duration::from_millis(250),
        failsafe: Failsafe::Stop,
    }
}

/// Build a profile the way a deployment does: hand over the data, get a checked machine back.
fn built(
    actuators: &'static [Actuator],
    actions: &'static [ActionSpec],
) -> amos_link::Result<Platform> {
    Platform::from_parts(PlatformKind::Drone, actuators, actions, envelope(), false)
}

/// The sentence a misdeclared profile is refused with.
fn refused(actuators: &'static [Actuator], actions: &'static [ActionSpec]) -> String {
    built(actuators, actions)
        .expect_err("a profile that contradicts itself must be refused at construction")
        .to_string()
}

/// One actuator of the valid profile below.
static VALID_ACTUATORS: &[Actuator] = &[Actuator { ..THRUST }];

/// Its vocabulary — note the arm key: a deployment names its own (`enable` here, not `arm`).
static VALID_ACTIONS: &[ActionSpec] = &[
    ActionSpec {
        key: "enable",
        class: IntentClass::Arm,
        pose: &[0],
        speed_scaled: false,
        params: &[],
        min_params: 0,
    },
    ActionSpec {
        key: "hover",
        class: IntentClass::Motion,
        pose: &[50_000],
        speed_scaled: false,
        params: &[],
        min_params: 0,
    },
    ActionSpec {
        key: "stop",
        class: IntentClass::Halt,
        pose: &[0],
        speed_scaled: false,
        params: &[],
        min_params: 0,
    },
];

/// The valid profile, built once and borrowed `'static` — the shape a deployment gets from a
/// `OnceLock`, which is what makes `Vocabulary::Profile(&Platform)` usable at all.
static DEPLOYMENT_PROFILE: std::sync::OnceLock<Platform> = std::sync::OnceLock::new();

/// The valid profile as a `'static` reference.
fn deployment() -> &'static Platform {
    DEPLOYMENT_PROFILE.get_or_init(|| {
        built(VALID_ACTUATORS, VALID_ACTIONS).expect("the valid profile must be accepted")
    })
}

#[test]
fn a_deployment_profile_is_a_usable_machine_not_just_an_accepted_value() {
    let platform = deployment();
    assert_eq!(platform.kind(), PlatformKind::Drone);
    // Its own vocabulary, its own arm key, its own label — and *not* the reference machine's words.
    assert_eq!(Vocabulary::Profile(platform).arm_key(), "enable");
    assert_eq!(Vocabulary::Profile(platform).label(), "drone");
    assert!(!Vocabulary::Profile(platform).self_arms_on_motion());
    assert!(platform.parse_intent(r#"{"action":"hover"}"#).is_ok());
    assert!(platform
        .parse_intent(r#"{"action":"trot"}"#)
        .expect_err("the quadruped's word is not this machine's")
        .to_string()
        .contains("unknown action"));
    // It plans into the **shipping** frames: the same type, the same CRC, the same HAL.
    let intent = platform
        .parse_intent(r#"{"action":"hover"}"#)
        .expect("hover");
    let frames = platform.plan(&intent).expect("a plan");
    assert_eq!(frames.len(), 1);
    assert_eq!((frames[0].op, frames[0].arg), (MotorOp::SetTorque, 50_000));
    assert_eq!(
        frames[0].joint,
        amos_link::robot_hal::JointId::new(0).expect("joint 0")
    );
    // …and its stop is the shared `Halt` rule applied to its own table.
    let halt = platform.halt_frames().expect("a halt");
    assert_eq!((halt[0].op, halt[0].arg), (MotorOp::Estop, 0));
}

/// One action of a broken profile, spelled out. A `const fn` (the valid tables above are raw
/// literals on purpose — that is what a deployment copies) keeps the variants below readable.
const fn action(
    key: &'static str,
    class: IntentClass,
    pose: &'static [i32],
    speed_scaled: bool,
    params: &'static [ParamSpec],
    min_params: usize,
) -> ActionSpec {
    ActionSpec {
        key,
        class,
        pose,
        speed_scaled,
        params,
        min_params,
    }
}

/// One actuator of a broken profile.
const fn actuator(index: u8, name: &'static str, travel: (i32, i32)) -> Actuator {
    Actuator {
        index,
        name,
        role: ActuatorRole::Thrust,
        unit: Unit::MilliPercent,
        travel,
    }
}

/// Actuator tables that break exactly one rule each.
static NO_ACTUATORS: &[Actuator] = &[];
static THIRTEEN: &[Actuator] = &[
    Actuator { ..THRUST },
    actuator(1, "t1", THRUST.travel),
    actuator(2, "t2", THRUST.travel),
    actuator(3, "t3", THRUST.travel),
    actuator(4, "t4", THRUST.travel),
    actuator(5, "t5", THRUST.travel),
    actuator(6, "t6", THRUST.travel),
    actuator(7, "t7", THRUST.travel),
    actuator(8, "t8", THRUST.travel),
    actuator(9, "t9", THRUST.travel),
    actuator(10, "t10", THRUST.travel),
    actuator(11, "t11", THRUST.travel),
    actuator(12, "t12", THRUST.travel),
];
static GAP: &[Actuator] = &[Actuator { ..THRUST }, actuator(2, "pump", THRUST.travel)];
static SAME_NAME: &[Actuator] = &[Actuator { ..THRUST }, actuator(1, "thrust", THRUST.travel)];
static INVERTED_TRAVEL: &[Actuator] = &[actuator(0, "thrust", (4_000, 1_000))];
static PAST_THE_FRAME: &[Actuator] = &[Actuator {
    // ±180° is a legal axis; it is not inside this frame's argument space (a registered boundary).
    travel: (-180_000, 180_000),
    unit: Unit::MilliDegrees,
    role: ActuatorRole::RotaryJoint,
    ..THRUST
}];

/// Vocabulary tables that break exactly one rule each (each is a one-actuator machine).
/// `const` (not `static`): a static may not read another static's value, and these are copied into
/// the tables below.
const HOVER: ActionSpec = action("hover", IntentClass::Motion, &[50_000], false, &[], 0);
const ARM: ActionSpec = action("enable", IntentClass::Arm, &[0], false, &[], 0);
const STOP: ActionSpec = action("stop", IntentClass::Halt, &[0], false, &[], 0);
static NO_ACTIONS: &[ActionSpec] = &[];
static NO_ARM: &[ActionSpec] = &[HOVER, STOP];
static TWO_HALTS: &[ActionSpec] = &[
    ARM,
    HOVER,
    STOP,
    action("emergency", IntentClass::Halt, &[0], false, &[], 0),
];
static TWO_ARMS: &[ActionSpec] = &[
    ARM,
    action("enable_again", IntentClass::Arm, &[0], false, &[], 0),
    HOVER,
    STOP,
];
static DUPLICATE_KEY: &[ActionSpec] = &[
    ARM,
    HOVER,
    action("hover", IntentClass::Motion, &[60_000], false, &[], 0),
    STOP,
];
static SHORT_POSE: &[ActionSpec] = &[
    ARM,
    action(
        "hover",
        IntentClass::Motion,
        &[50_000, 60_000],
        false,
        &[],
        0,
    ),
    STOP,
];
static POSE_OUTSIDE_TRAVEL: &[ActionSpec] = &[
    ARM,
    action("hover", IntentClass::Motion, &[100_001], false, &[], 0),
    STOP,
];
static SPEED_WITHOUT_POSE: &[ActionSpec] = &[
    ARM,
    action("move", IntentClass::Motion, &[], true, &[], 0),
    STOP,
];
static HALT_WITH_A_POSE: &[ActionSpec] = &[
    ARM,
    HOVER,
    action("stop", IntentClass::Halt, &[10_000], false, &[], 0),
];
static UNSATISFIABLE: &[ActionSpec] = &[
    ARM,
    action("goto", IntentClass::Motion, &[50_000], false, &[], 1),
    STOP,
];
static DUPLICATE_PARAM: &[ActionSpec] = &[
    ARM,
    action(
        "goto",
        IntentClass::Motion,
        &[50_000],
        false,
        &[
            ParamSpec {
                name: "north_mm",
                unit: "mm",
                range: (-10, 10),
            },
            ParamSpec {
                name: "north_mm",
                unit: "mm",
                range: (-20, 20),
            },
        ],
        1,
    ),
    STOP,
];
static INVERTED_RANGE: &[ActionSpec] = &[
    ARM,
    action(
        "goto",
        IntentClass::Motion,
        &[50_000],
        false,
        &[ParamSpec {
            name: "north_mm",
            unit: "mm",
            range: (10, -10),
        }],
        1,
    ),
    STOP,
];

#[test]
fn a_misdeclared_profile_is_refused_naming_the_rule_it_broke() {
    // Eighteen profiles, one broken rule each. Without this, the only profiles a reviewer can run
    // are the six built-ins — all valid — so every refusal inside `plan` (a pose that does not fit
    // its table, a travel the frame cannot carry) was a sentence no test could reach.
    let cases = [
        (
            "no actuators",
            refused(NO_ACTUATORS, VALID_ACTIONS),
            "declares no actuators",
        ),
        (
            "no actions",
            refused(VALID_ACTUATORS, NO_ACTIONS),
            "declares no actions",
        ),
        (
            "thirteen actuators",
            refused(THIRTEEN, VALID_ACTIONS),
            "12-actuator boundary",
        ),
        (
            "a gap in the indices",
            refused(GAP, VALID_ACTIONS),
            "contiguous from 0",
        ),
        (
            "two actuators, one name",
            refused(SAME_NAME, VALID_ACTIONS),
            "two actuators are called `thrust`",
        ),
        (
            "an inverted travel",
            refused(INVERTED_TRAVEL, VALID_ACTIONS),
            "inverted travel 4000..=1000",
        ),
        (
            "a travel past the frame",
            refused(PAST_THE_FRAME, VALID_ACTIONS),
            "argument space",
        ),
        (
            "no Arm action",
            refused(VALID_ACTUATORS, NO_ARM),
            "needs exactly one `arm` action (it has 0)",
        ),
        (
            "two Arm actions",
            refused(VALID_ACTUATORS, TWO_ARMS),
            "needs exactly one `arm` action (it has 2)",
        ),
        (
            "two Halt actions",
            refused(VALID_ACTUATORS, TWO_HALTS),
            "needs exactly one `halt` action (it has 2)",
        ),
        (
            "a duplicated action key",
            refused(VALID_ACTUATORS, DUPLICATE_KEY),
            "two actions are called `hover`",
        ),
        (
            "a pose too short",
            refused(VALID_ACTUATORS, SHORT_POSE),
            "2 pose entries for 1 actuators",
        ),
        (
            "a pose outside the travel",
            refused(VALID_ACTUATORS, POSE_OUTSIDE_TRAVEL),
            "100001",
        ),
        (
            "a speed to scale an absent pose",
            refused(VALID_ACTUATORS, SPEED_WITHOUT_POSE),
            "scale a pose it does not have",
        ),
        (
            "a Halt that moves",
            refused(VALID_ACTUATORS, HALT_WITH_A_POSE),
            "must be inert",
        ),
        (
            "min_params nothing can satisfy",
            refused(VALID_ACTUATORS, UNSATISFIABLE),
            "requires 1 of its 0 parameters",
        ),
        (
            "a duplicated parameter",
            refused(VALID_ACTUATORS, DUPLICATE_PARAM),
            "declares the parameter `north_mm` twice",
        ),
        (
            "an inverted parameter range",
            refused(VALID_ACTUATORS, INVERTED_RANGE),
            "inverted range 10..=-10",
        ),
    ];
    for (case, message, expected) in cases {
        assert!(
            message.contains(expected),
            "{case}: expected {expected:?} in {message:?}"
        );
        assert!(
            message.contains("platform drone"),
            "{case}: the refusal must name the profile: {message}"
        );
    }

    // The envelope is part of the profile, so it is checked with it — including the bound a
    // *report* imposes (`SafetyEnvelope::validate`, docs/robot-domains.md §5).
    let zero = Platform::from_parts(
        PlatformKind::Drone,
        VALID_ACTUATORS,
        VALID_ACTIONS,
        SafetyEnvelope {
            watchdog: Duration::ZERO,
            failsafe: Failsafe::Stop,
        },
        false,
    )
    .expect_err("a zero deadman is not a watchdog");
    assert!(zero.to_string().contains("zero deadman"), "{zero}");
    let too_long = Platform::from_parts(
        PlatformKind::Drone,
        VALID_ACTUATORS,
        VALID_ACTIONS,
        SafetyEnvelope {
            watchdog: Duration::from_millis(MAX_WATCHDOG_MS + 1),
            failsafe: Failsafe::Stop,
        },
        false,
    )
    .expect_err("past what a report may carry");
    assert!(too_long.to_string().contains("exceeds"), "{too_long}");
}
