//! Case-level tests for the robot application catalogue (`docs/robot-apps.md`).
//!
//! The examples print a transcript a human reads; these tests assert the **properties** those
//! transcripts claim, against the shipping code paths — the same broker, framing, QoS,
//! sequence accounting, HAL and control plane the examples run. They are deliberately
//! deterministic: the deadman tests *await* the watchdog instead of sleeping past it, the
//! rate arithmetic is pinned with **injected instants** (never by measuring this machine's
//! scheduler), and everything that can converge (a peer table, a folded report) is polled
//! with a bound rather than assumed to be ready after a fixed sleep.
//!
//! Cases, one test group each:
//!
//! ① a patrol loop: apply → report → deadman cut → refusal → re-arm (`case_1_*`)
//! ② a fleet console: wildcards, per-robot/per-stream figures, one deadman per robot (`case_2_*`)
//! ③ a caller that is not on the link: the gRPC control plane (`case_3_*`)
//!
//! …plus `the_catalogue_topics_use_the_profile_their_channel_implies`, which pins the case
//! catalogue's contract table to the code so the document cannot drift from the middleware.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use amos_link::broker::{Broker, Transport};
use amos_link::codec::{Clock, Message};
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::pubsub::{Publisher, Subscriber};
use amos_link::qos::{Qos, Reliability};
use amos_link::rate::{RateEvidence, RateTracker};
use amos_link::robot_hal::{
    actuation_pattern, actuation_topic, ActuationState, AgentAction, BridgeEvent, EstopReason,
    Gait, MockRobotHal, RobotBridge, RobotHal, JOINTS,
};
use amos_link::service::LinkService;
use amos_proto::amos_link::robot_link_client::RobotLinkClient;
use amos_proto::amos_link::robot_link_server::RobotLinkServer;
use amos_proto::amos_link::{Actuation, Empty, PublishRequest};
use serde::{Deserialize, Serialize};
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

/// The robot of case ①/③, and the console of case ②.
const ROBOT: &str = "patrol-01";
/// The deadman period the tests use: short (the case is "the link went quiet"), but long
/// enough that a command on its way is never mistaken for silence.
const WATCHDOG: Duration = Duration::from_millis(40);
/// How long a converging property (a peer table, a folded report) may take before a test fails.
const CONVERGE: Duration = Duration::from_secs(3);

/// One depth frame from a robot's stereo pair (the case ① payload).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct StereoFrame {
    seq: u64,
    width: u32,
    height: u32,
    points: Vec<i16>,
}

/// The three objects one link is made of (kept together so a test cannot mix two links).
struct TestLink {
    transport: Arc<dyn Transport>,
    metrics: Arc<LinkMetrics>,
    clock: Arc<Clock>,
}

impl TestLink {
    /// One transport, one counter set, one clock — the shape every case uses.
    fn new() -> Self {
        let metrics = Arc::new(LinkMetrics::new());
        Self {
            transport: Broker::with_metrics(Arc::clone(&metrics)).shared(),
            metrics,
            clock: Arc::new(Clock::host()),
        }
    }

    /// A node on this link (a robot, a brain, a tool).
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

/// The robot's control loop of case ①/③: control channel in, motor frames out, mode reported.
async fn bridge_on(
    link: &TestLink,
    robot_id: &str,
    robot: &Arc<LinkNode>,
) -> RobotBridge<MockRobotHal> {
    let control = Subscriber::<AgentAction>::subscribe(
        Arc::clone(&link.transport),
        Topic::pattern(format!("amos/{robot_id}/control/*")).expect("control pattern"),
        Qos::control(),
        Arc::clone(&link.metrics),
    )
    .await
    .expect("subscribe the control channel");
    RobotBridge::with_watchdog(control, MockRobotHal::new(), WATCHDOG).reporting(
        robot.publisher::<ActuationState>(actuation_topic(robot.peer()).expect("state topic")),
    )
}

/// A brain's control publisher for the case robot.
fn commander(brain: &Arc<LinkNode>) -> Publisher<AgentAction> {
    brain.publisher::<AgentAction>(
        Topic::channel_topic(ROBOT, Channel::Control, "action").expect("control topic"),
    )
}

/// Publish one action — and assert it really reached the robot's control loop (a `matched` of
/// zero would make every assertion below pass for the wrong reason).
async fn send(commander: &Publisher<AgentAction>, json: &str) {
    let report = commander
        .publish(&AgentAction::new(json))
        .await
        .expect("publish the action");
    assert_eq!(
        report.matched,
        Some(1),
        "the robot's control loop must be subscribed to {json}"
    );
    assert_eq!(report.delivered, 1, "the action reaches its one consumer");
}

/// The return path as the case's peer reads it: one mode report off the link.
async fn read_mode(modes: &mut Subscriber<ActuationState>) -> ActuationState {
    modes.recv().await.expect("a mode report arrives").message
}

/// Poll an awaitable `$check` until `$done` accepts the value or `CONVERGE` passes, then return
/// the last value — for facts that settle asynchronously (a peer table filling up, a report
/// being folded by the control plane). The expression is written at the call site (rather than
/// a generic `FnMut() -> Future` helper) because these checks borrow the client they call.
macro_rules! eventually {
    ($check:expr, $done:expr) => {{
        let deadline = Instant::now() + CONVERGE;
        let mut value = $check;
        while !$done(&value) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
            value = $check;
        }
        value
    }};
}

/// A brain's view of the return path (the pattern the CLI's `state` command subscribes to).
async fn state_subscriber(link: &TestLink) -> Subscriber<ActuationState> {
    Subscriber::<ActuationState>::subscribe(
        Arc::clone(&link.transport),
        actuation_pattern().expect("actuation pattern"),
        Qos::for_channel(Channel::State),
        Arc::clone(&link.metrics),
    )
    .await
    .expect("subscribe the state channel")
}

// ── case ①: the patrol mission ─────────────────────────────────────────────────────

#[tokio::test]
async fn case_1_the_patrol_loop_applies_refuses_and_reports() {
    let link = TestLink::new();
    let robot = link.node(ROBOT, NodeKind::Robot);
    let brain = link.node("field-server", NodeKind::Brain);
    let mut bridge = bridge_on(&link, ROBOT, &robot).await;
    let mut modes = state_subscriber(&link).await;
    let commands = commander(&brain);

    // (1) a patrol command: validated, expanded into motor frames, written to the bus.
    send(
        &commands,
        r#"{"action":"trot","speed":0.6,"duration_ms":800}"#,
    )
    .await;
    assert_eq!(
        bridge.step().await.expect("one control step"),
        BridgeEvent::Applied {
            seq: 1,
            frames: JOINTS + 1,
            armed: true
        },
        "one gait = one Enable + one position frame per joint"
    );
    let mode = read_mode(&mut modes).await;
    assert_eq!(mode.seq, Some(1), "the report names the action it acted on");
    assert_eq!(mode.gait, Some(Gait::Trot));
    assert_eq!(
        mode.frames,
        JOINTS + 1,
        "the count is what the bus accepted"
    );
    assert!(mode.armed && !mode.estopped, "the drivers are energized");
    assert_eq!(
        mode.watchdog_ms,
        Some(WATCHDOG.as_millis() as u64),
        "the report carries the deadman period it is actually running with"
    );
    assert!(mode.last_refusal.is_none());

    // (2) the link goes quiet: the deadman cuts torque, and the cut is *measured*.
    match bridge.step().await.expect("the watchdog step") {
        BridgeEvent::Estopped { reason, frames } => {
            assert_eq!(reason, EstopReason::Watchdog);
            assert_eq!(frames, JOINTS, "the mock's cut is one frame per joint");
        }
        other => panic!("expected a watchdog torque cut, got {other:?}"),
    }
    let mode = read_mode(&mut modes).await;
    assert!(mode.estopped && !mode.armed, "torque is gone and latched");
    assert_eq!(mode.estop_reason, Some(EstopReason::Watchdog));

    // (3) motion while e-stopped is refused — and the reason reaches the commander.
    send(&commands, r#"{"action":"trot","speed":0.8}"#).await;
    let refused_seq = match bridge.step().await.expect("the refusal step") {
        BridgeEvent::Refused { seq, reason } => {
            assert!(
                reason.contains("e-stop"),
                "the refusal names the latch: {reason}"
            );
            seq
        }
        other => panic!("expected a refusal, got {other:?}"),
    };
    let mode = read_mode(&mut modes).await;
    let refusal = mode.last_refusal.expect("the refusal is on the link");
    assert_eq!(refusal.seq, refused_seq, "…and it points at that action");
    assert!(
        refusal.reason.contains("arm"),
        "…and says how to recover: {}",
        refusal.reason
    );
    assert!(mode.estopped, "a refusal does not clear the latch");
    assert_eq!(
        mode.gait,
        Some(Gait::Trot),
        "the last accepted gait is still what the robot believes it runs"
    );

    // (4) the operator re-arms, and the mission can continue.
    send(&commands, r#"{"action":"arm"}"#).await;
    assert_eq!(
        bridge.step().await.expect("the arm step"),
        BridgeEvent::Applied {
            seq: 3,
            frames: JOINTS,
            armed: true
        },
        "arming energizes every joint and sends no position frame"
    );
    let mode = read_mode(&mut modes).await;
    assert!(mode.armed && !mode.estopped, "the latch is cleared");
    assert_eq!(mode.gait, Some(Gait::Arm));
    assert!(mode.last_refusal.is_none(), "arming clears the refusal too");
}

#[tokio::test]
async fn case_1_a_malformed_intent_never_reaches_the_bus() {
    let link = TestLink::new();
    let robot = link.node(ROBOT, NodeKind::Robot);
    let brain = link.node("field-server", NodeKind::Brain);
    let mut bridge = bridge_on(&link, ROBOT, &robot).await;
    let commands = commander(&brain);

    // A gait this build does not know is refused, with the JSON that named it.
    send(&commands, r#"{"action":"backflip"}"#).await;
    match bridge.step().await.expect("the refusal step") {
        BridgeEvent::Refused { reason, .. } => {
            assert!(
                reason.contains("unknown action") && reason.contains("backflip"),
                "the reason quotes the command it refused: {reason}"
            );
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(
        bridge.hal().applied(),
        0,
        "nothing reached the bus: a refusal is not a partially applied command"
    );
    assert!(!bridge.hal().armed(), "and no driver was energized");

    // The same holds for JSON that is not a command at all.
    send(&commands, "not json").await;
    match bridge.step().await.expect("the second refusal step") {
        BridgeEvent::Refused { reason, .. } => assert!(
            reason.contains("not valid JSON"),
            "the reason names the parse failure: {reason}"
        ),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(bridge.hal().applied(), 0);
}

#[tokio::test]
async fn case_1_the_camera_stream_is_latest_wins_and_the_loss_is_counted() {
    let link = TestLink::new();
    let robot = link.node(ROBOT, NodeKind::Robot);
    let camera =
        robot.publisher::<StereoFrame>(robot.topic(Channel::Sensor, "stereo_left").expect("topic"));
    let mut view = Subscriber::<StereoFrame>::subscribe(
        Arc::clone(&link.transport),
        Topic::pattern("amos/*/sensor/stereo_left").expect("pattern"),
        Qos::sensor(),
        Arc::clone(&link.metrics),
    )
    .await
    .expect("subscribe the camera stream");

    // Three frames published while the brain was busy: one slot, newest wins, two counted away.
    for seq in 1..=3u64 {
        camera
            .publish(&StereoFrame {
                seq,
                width: 1280,
                height: 720,
                points: vec![seq as i16; 4],
            })
            .await
            .expect("publish a frame");
    }
    let received = view.recv().await.expect("the newest frame arrives");
    assert_eq!(
        received.message.seq, 3,
        "the consumer wakes up holding the newest frame, not the oldest"
    );
    assert_eq!(
        view.stats().dropped,
        2,
        "…and the two it missed are counted"
    );
    assert_eq!(view.stats().received, 1, "one frame reached this consumer");
    assert_eq!(
        received.publisher.as_str(),
        ROBOT,
        "the frame names who published it"
    );
}

#[tokio::test]
async fn case_1_the_stream_figures_are_checkable_arithmetic() {
    // The case's `hz`-style line, with the arrival instants injected: the figures are the
    // middleware's own arithmetic, not this machine's scheduler (§3.19/§3.20).
    let mut rates = RateTracker::new();
    let robot = PeerId::new(ROBOT).expect("peer");
    let camera = Topic::channel_topic(ROBOT, Channel::Sensor, "stereo_left").expect("topic");
    let t0 = Instant::now();
    for n in 0..6u32 {
        rates.observe(
            &robot,
            &camera,
            t0 + Duration::from_millis(100) * n,
            130, // the framed size of one small depth frame (header + CRC + payload)
        );
    }

    let reading = rates.rate(&robot, &camera).expect("the stream is tracked");
    assert_eq!(reading.frames, 6);
    assert_eq!(reading.span, Some(Duration::from_millis(500)));
    assert_eq!(
        reading.rate_hz,
        Some(10.0),
        "five intervals over 500 ms — `frames / span` would have read 12 Hz"
    );
    assert_eq!(reading.bytes, 6 * 130);
    assert_eq!(
        reading.bytes_per_sec,
        Some(1560.0),
        "the printed byte total over the printed span: what a reader can re-check"
    );

    // One frame is not a rate — and the reading says *why* instead of printing `0 Hz`.
    let mut single = RateTracker::new();
    single.observe(&robot, &camera, t0, 130);
    let reading = single.rate(&robot, &camera).expect("the stream is tracked");
    assert_eq!(reading.frames, 1);
    assert_eq!(
        reading.rate_hz, None,
        "0 Hz would read as `the robot stopped`"
    );
    assert_eq!(reading.bytes_per_sec, None);
    assert_eq!(reading.evidence(), Some(RateEvidence::SingleFrame));
    assert_eq!(
        reading.evidence().map(|e| e.key()),
        Some("single-frame"),
        "the machine token a script branches on"
    );
}

// ── case ②: the fleet console ──────────────────────────────────────────────────────

#[tokio::test]
async fn case_2_a_console_sees_every_robot_and_never_itself() {
    let link = TestLink::new();
    let console = link.node("fleet-console", NodeKind::Tool);
    let mut feds = vec![console
        .spawn_federation(Duration::from_millis(20))
        .expect("the console announces itself")];
    for id in ["patrol-01", "patrol-02", "patrol-03"] {
        let robot = link.node(id, NodeKind::Robot);
        feds.push(
            robot
                .spawn_federation(Duration::from_millis(20))
                .expect("a robot announces itself"),
        );
    }

    let peers = eventually!(console.status().await.peers, |peers: &Vec<
        amos_link::discovery::PeerView,
    >| peers.len() == 3);
    let ids: BTreeSet<String> = peers.iter().map(|p| p.id().as_str().to_string()).collect();
    assert_eq!(
        ids,
        BTreeSet::from([
            "patrol-01".to_string(),
            "patrol-02".to_string(),
            "patrol-03".to_string()
        ]),
        "one wildcard console, every robot — and the console is not in its own table"
    );
    assert!(
        peers.iter().all(|p| p.beacons > 0 && !p.is_static()),
        "these entries came from beacons (they expire on TTL, unlike a declared peer)"
    );
    assert!(
        feds.iter().map(|f| f.self_echoes()).sum::<u64>() > 0,
        "the self-beacon filter is active and counted, not assumed"
    );

    for fed in feds {
        fed.stop().await;
    }
}

#[tokio::test]
async fn case_2_every_robot_reports_its_own_deadman() {
    let link = TestLink::new();
    let mut modes = state_subscriber(&link).await;

    let robots: Vec<Arc<LinkNode>> = ["patrol-01", "patrol-02"]
        .iter()
        .map(|id| link.node(id, NodeKind::Robot))
        .collect();
    let mut bridges = Vec::new();
    for (id, robot) in ["patrol-01", "patrol-02"].iter().zip(robots.iter()) {
        bridges.push((*id, bridge_on(&link, id, robot).await));
    }

    // Nobody commands them: each robot's own deadman decides, at the same moment.
    let (first, second) = {
        let (head, tail) = bridges.split_at_mut(1);
        tokio::join!(head[0].1.step(), tail[0].1.step())
    };
    for event in [
        first.expect("the first robot's step"),
        second.expect("the second robot's step"),
    ] {
        match event {
            BridgeEvent::Estopped { reason, frames } => {
                assert_eq!(reason, EstopReason::Watchdog);
                assert_eq!(frames, JOINTS);
            }
            other => panic!("expected a watchdog cut on every robot, got {other:?}"),
        }
    }

    // The console reads both reports off one wildcard subscription, attributed by publisher.
    let mut reports = Vec::new();
    for _ in 0..2 {
        reports.push(modes.recv().await.expect("a robot reports its mode"));
    }
    let publishers: BTreeSet<String> = reports
        .iter()
        .map(|r| r.publisher.as_str().to_string())
        .collect();
    assert_eq!(
        publishers,
        BTreeSet::from(["patrol-01".to_string(), "patrol-02".to_string()]),
        "two robots, two reports, each attributed to the frame's publisher"
    );
    for report in &reports {
        assert!(report.message.estopped && !report.message.armed);
        assert_eq!(report.message.estop_reason, Some(EstopReason::Watchdog));
        assert_eq!(
            report.message.gait, None,
            "no action was ever applied, so there is no last gait to claim"
        );
    }
}

#[tokio::test]
async fn case_2_the_figures_are_per_robot_and_per_stream() {
    // The console's table, with injected instants: three robots, four streams, one window
    // each — and a stream that stopped says so instead of reading as `0 Hz`.
    let mut rates = RateTracker::new();
    let fast = PeerId::new("patrol-01").expect("peer");
    let slow = PeerId::new("patrol-02").expect("peer");
    let dead = PeerId::new("patrol-03").expect("peer");
    let camera =
        |robot: &str| Topic::channel_topic(robot, Channel::Sensor, "stereo_left").expect("topic");
    let state = Topic::channel_topic("patrol-02", Channel::State, "actuation").expect("topic");
    let t0 = Instant::now();

    for n in 0..6u32 {
        rates.observe(
            &fast,
            &camera("patrol-01"),
            t0 + Duration::from_millis(100) * n,
            130,
        );
    }
    for n in 0..3u32 {
        rates.observe(
            &slow,
            &camera("patrol-02"),
            t0 + Duration::from_millis(250) * n,
            130,
        );
    }
    rates.observe(&dead, &camera("patrol-03"), t0, 130);
    rates.observe(&slow, &state, t0, 127);

    let fast_reading = rates.rate(&fast, &camera("patrol-01")).expect("tracked");
    assert_eq!(fast_reading.rate_hz, Some(10.0));
    assert_eq!(fast_reading.bytes, 780);
    assert_eq!(fast_reading.bytes_per_sec, Some(1560.0));

    let slow_reading = rates.rate(&slow, &camera("patrol-02")).expect("tracked");
    assert_eq!(
        slow_reading.rate_hz,
        Some(4.0),
        "two intervals over 500 ms: a camera sampled every 250 ms"
    );
    assert_eq!(slow_reading.bytes, 390);

    let dead_reading = rates.rate(&dead, &camera("patrol-03")).expect("tracked");
    assert_eq!(dead_reading.frames, 1);
    assert_eq!(dead_reading.rate_hz, None);
    assert_eq!(dead_reading.evidence(), Some(RateEvidence::SingleFrame));

    // Three streams did not share a window with each other or with the state channel.
    assert_eq!(rates.streams(), 4);
    assert_eq!(rates.frames(), 11);
    assert_eq!(rates.bytes(), 780 + 390 + 130 + 127);
    assert!(
        rates.is_complete(),
        "nothing was refused: no stream is missing"
    );
    let order: Vec<(String, String)> = rates
        .rates()
        .iter()
        .map(|r| (r.publisher.to_string(), r.topic.to_string()))
        .collect();
    assert_eq!(
        order,
        vec![
            (
                "patrol-01".to_string(),
                "amos/patrol-01/sensor/stereo_left".to_string()
            ),
            (
                "patrol-02".to_string(),
                "amos/patrol-02/sensor/stereo_left".to_string()
            ),
            (
                "patrol-02".to_string(),
                "amos/patrol-02/state/actuation".to_string()
            ),
            (
                "patrol-03".to_string(),
                "amos/patrol-03/sensor/stereo_left".to_string()
            ),
        ],
        "a reader can diff two readings because the order is stable"
    );
}

// ── case ③: a caller that is not on the link (the gRPC control plane) ──────────────

#[tokio::test]
async fn case_3_injection_is_a_real_frame_the_robot_decodes() {
    let link = TestLink::new();
    let robot = link.node(ROBOT, NodeKind::Robot);
    let mut control = Subscriber::<AgentAction>::subscribe(
        Arc::clone(&link.transport),
        Topic::pattern(format!("amos/{ROBOT}/control/*")).expect("pattern"),
        Qos::control(),
        Arc::clone(&link.metrics),
    )
    .await
    .expect("subscribe the control channel");
    let (socket, server) = mount_control_plane(&robot, "inject").await;
    let mut client = RobotLinkClient::new(connect(&socket).await.expect("connect the channel"));

    let action = AgentAction::new(r#"{"action":"trot","speed":0.5,"duration_ms":600}"#);
    let reply = client
        .publish(PublishRequest {
            topic: control_topic(),
            payload: action.encode().expect("encode the action"),
        })
        .await
        .expect("the plane publishes")
        .into_inner();
    assert_eq!(
        reply.seq, 1,
        "the plane stamps the frame with its own sequence"
    );
    assert_eq!(
        reply.matched, 1,
        "the in-process broker counts the robot's subscription"
    );
    assert_eq!(reply.delivered, 1);

    // The robot's *typed* subscriber decodes it: the injection is not a special path.
    let received = control.recv().await.expect("the injected frame arrives");
    assert_eq!(
        received.publisher.as_str(),
        ROBOT,
        "the frame names the node that published it"
    );
    assert_eq!(received.seq, 1);
    let command = received
        .message
        .parse()
        .expect("the payload decodes as the typed message");
    assert_eq!(command.gait, Gait::Trot);
    assert!((command.speed - 0.5).abs() < f32::EPSILON);
    assert_eq!(command.duration_ms, 600);

    server.abort();
    std::fs::remove_file(&socket).ok();
}

#[tokio::test]
async fn case_3_the_deadman_is_visible_from_outside_the_link() {
    let link = TestLink::new();
    let robot = link.node(ROBOT, NodeKind::Robot);
    let mut bridge = bridge_on(&link, ROBOT, &robot).await;
    let (socket, server) = mount_control_plane(&robot, "deadman").await;
    let mut client = RobotLinkClient::new(connect(&socket).await.expect("connect the channel"));

    // The brain injects the action through the plane…
    let reply = client
        .publish(PublishRequest {
            topic: control_topic(),
            payload: AgentAction::new(r#"{"action":"trot","speed":0.5}"#)
                .encode()
                .expect("encode"),
        })
        .await
        .expect("inject")
        .into_inner();
    assert_eq!(reply.delivered, 1, "the robot's bridge is subscribed");
    assert_eq!(
        bridge.step().await.expect("the robot applies it"),
        BridgeEvent::Applied {
            seq: 1,
            frames: JOINTS + 1,
            armed: true
        }
    );

    // …and reads the robot's mode back *through the plane* (never from the bridge).
    let list = eventually!(
        client
            .list_actuations(Empty {})
            .await
            .expect("list actuations")
            .into_inner()
            .robots,
        |robots: &Vec<Actuation>| robots.len() == 1 && robots[0].gait == "trot"
    );
    assert_eq!(list.len(), 1, "one robot has reported");
    assert_eq!(
        list[0].robot, ROBOT,
        "attributed by the frame's publisher, not by the payload"
    );
    assert!(list[0].armed && !list[0].estopped);
    assert_eq!(list[0].frames, (JOINTS + 1) as u32);

    // The brain goes quiet: the deadman trips and the cut is reported…
    match bridge.step().await.expect("the watchdog step") {
        BridgeEvent::Estopped {
            reason: EstopReason::Watchdog,
            ..
        } => {}
        other => panic!("expected a watchdog torque cut, got {other:?}"),
    }

    // …so the caller that caused it — and is not on the link — can see it.
    let list = eventually!(
        client
            .list_actuations(Empty {})
            .await
            .expect("list actuations")
            .into_inner()
            .robots,
        |robots: &Vec<Actuation>| robots.first().is_some_and(|r| r.estopped)
    );
    assert!(list[0].estopped && !list[0].armed, "torque is gone");
    assert_eq!(list[0].estop_reason, "watchdog");
    assert_eq!(list[0].watchdog_ms, WATCHDOG.as_millis() as u64);
    assert_eq!(
        list[0].gait, "trot",
        "the last accepted gait is still what the robot reports it runs"
    );

    server.abort();
    std::fs::remove_file(&socket).ok();
}

// ── the catalogue's contract table, pinned to the code ─────────────────────────────

#[test]
fn the_catalogue_topics_use_the_profile_their_channel_implies() {
    // `docs/robot-apps.md` §2 states this table as the cases' contract. A document that
    // disagrees with the middleware is the defect this pins: the channel a case names decides
    // the profile, and nobody picks it per call site.
    for (channel, profile) in [
        (Channel::Sensor, Qos::sensor()),
        (Channel::Control, Qos::control()),
        (Channel::State, Qos::state()),
    ] {
        let topic = Topic::channel_topic(ROBOT, channel, "x").expect("topic");
        assert_eq!(
            topic.channel(),
            Some(channel),
            "the topic names its channel"
        );
        assert_eq!(
            Qos::for_channel(channel),
            profile,
            "…and the channel implies exactly this profile"
        );
    }
    assert!(
        Qos::for_channel(Channel::Sensor).is_latest_only(),
        "a sensor stream is one slot, newest wins"
    );
    assert_eq!(
        Qos::for_channel(Channel::Control).reliability,
        Reliability::Reliable,
        "a control stream back-pressures instead of dropping"
    );
    assert_eq!(
        Qos::for_channel(Channel::State).depth,
        8,
        "a state channel keeps a short history (a mode, not a stream)"
    );
    assert_eq!(
        actuation_topic(&PeerId::new(ROBOT).expect("peer"))
            .expect("the return path's topic")
            .channel(),
        Some(Channel::State),
        "the return path is a state topic — latest-wins in the sense that a reader wants \
         the current mode, not every mode it ever had"
    );
}

// ── the harnesses the cases share ──────────────────────────────────────────────────

/// The robot's control topic, as a brain addresses it.
fn control_topic() -> String {
    Topic::channel_topic(ROBOT, Channel::Control, "action")
        .expect("control topic")
        .as_str()
        .to_string()
}

/// Mount the control plane on a fresh Unix domain socket (the daemon's shape).
async fn mount_control_plane(
    node: &Arc<LinkNode>,
    tag: &str,
) -> (
    PathBuf,
    tokio::task::JoinHandle<Result<(), tonic::transport::Error>>,
) {
    let socket = socket_path(tag);
    if socket.exists() {
        std::fs::remove_file(&socket).ok();
    }
    let listener =
        tokio::net::UnixListener::bind(&socket).expect("bind the control plane's socket");
    let service = RobotLinkServer::new(LinkService::with_heartbeat(Arc::clone(node)));
    let handle = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(service)
            .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(listener))
            .await
    });
    wait_for_socket(&socket).await;
    (socket, handle)
}

/// A per-run socket path (unique, so parallel test binaries cannot clash).
fn socket_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "amos-link-cases-{tag}-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

/// Wait until the server has created and bound the socket.
async fn wait_for_socket(path: &Path) {
    let deadline = Instant::now() + CONVERGE;
    while Instant::now() < deadline {
        if path.exists() && UnixStream::connect(path).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the control plane's socket never became connectable: {path:?}");
}

/// A tonic channel over the control plane's Unix domain socket.
async fn connect(path: &Path) -> Result<tonic::transport::Channel, Box<dyn std::error::Error>> {
    let owned = path.to_path_buf();
    let channel = Endpoint::try_from("http://[::1]:50051")?
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await?;
    Ok(channel)
}
