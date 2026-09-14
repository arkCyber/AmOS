//! End-to-end: the robot↔brain loop the middleware exists for.
//!
//! Two agents on one link (the same shape as a board and a field server; the in-process
//! [`Broker`](amos_link::broker::Broker) stands in for the Zenoh session so the test is
//! offline and deterministic):
//!
//! ```text
//!   robot  ──publish stereo frame (best-effort, latest wins)──►  brain
//!   brain  ──publish {"action":"trot"} on the control channel──►  robot
//!   robot  ──RobotBridge──► motor frames (CRC-checked)  ──►  MockRobotHal
//! ```
//!
//! It asserts the properties a robotics integration depends on: the brain measures
//! latency from the stamp, a wildcard subscription sees *every* robot, the control path
//! is reliable, and a slow brain never makes the camera wait.

use std::sync::Arc;
use std::time::Duration;

use amos_link::broker::Broker;
use amos_link::codec::Clock;
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::pubsub::{Publisher, Subscriber};
use amos_link::qos::Qos;
use amos_link::robot_hal::{
    actuation_topic, ActuationState, AgentAction, BridgeEvent, EstopReason, Gait, MockRobotHal,
    MotorOp, RobotBridge, RobotHal, JOINTS,
};
use amos_link::sequence::{SeqEvent, SeqTracker};
use serde::{Deserialize, Serialize};

/// The depth frame a stereo pair publishes (a stand-in for the real payload type: any
/// `serde` type is a link `Message`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct DepthFrame {
    seq: u64,
    width: u32,
    height: u32,
    points: Vec<i16>,
}

/// The robot↔brain exchange: stereo out, control back, motor frames applied.
#[tokio::test]
async fn robot_and_brain_exchange_frames_and_control() {
    let metrics = Arc::new(LinkMetrics::new());
    let clock = Arc::new(Clock::host());
    let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();

    let robot = LinkNode::with_parts(
        PeerId::new("dog1").expect("peer"),
        NodeKind::Robot,
        Arc::clone(&transport),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    );
    let brain = LinkNode::with_parts(
        PeerId::new("mini-brain").expect("peer"),
        NodeKind::Brain,
        Arc::clone(&transport),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    );

    // ── the brain subscribes to every robot's left camera ────────────────────────
    let mut stereo = Subscriber::<DepthFrame>::subscribe(
        Arc::clone(&transport),
        Topic::pattern("amos/*/sensor/stereo_left").expect("pattern"),
        Qos::sensor(),
        Arc::clone(&metrics),
    )
    .await
    .expect("subscribe stereo");

    // ── the robot's control loop: JSON actions on the wire, frames on the bus ────
    let control = Subscriber::<AgentAction>::subscribe(
        Arc::clone(&transport),
        Topic::pattern("amos/dog1/control/*").expect("pattern"),
        Qos::control(),
        Arc::clone(&metrics),
    )
    .await
    .expect("subscribe control");
    let mut bridge = RobotBridge::new(control, MockRobotHal::new());

    // ── the camera publishes three frames; only the newest is kept ──────────────
    let camera = Publisher::<DepthFrame>::new(
        Arc::clone(&transport),
        Topic::channel_topic("dog1", Channel::Sensor, "stereo_left").expect("topic"),
        robot.peer().clone(),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    );
    for seq in 1..=3u64 {
        camera
            .publish(&DepthFrame {
                seq,
                width: 1280,
                height: 720,
                points: vec![seq as i16; 4],
            })
            .await
            .expect("publish depth");
    }

    let frame = stereo.recv().await.expect("frame");
    assert_eq!(
        frame.message.seq, 3,
        "latest-wins: the newest frame arrives"
    );
    assert_eq!(frame.publisher.as_str(), "dog1");
    assert_eq!(frame.topic.as_str(), "amos/dog1/sensor/stereo_left");
    assert!(
        frame.age() < Duration::from_secs(5),
        "the stamp is the publisher's clock, so the brain can measure lag"
    );
    assert!(stereo.stats().dropped >= 2, "the stale frames were dropped");

    // ── the brain answers on the robot's control channel ────────────────────────
    // The *topic* names the subject (the robot's control input, so a wildcard on
    // `amos/dog1/control/*` sees it); the *publisher* is the brain — that separation is
    // what lets a field server command a robot without owning the robot's namespace.
    let commander = brain.publisher::<AgentAction>(
        Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
    );
    let report = commander
        .publish(&AgentAction::new(
            r#"{"action":"trot","speed":0.8,"duration_ms":500}"#,
        ))
        .await
        .expect("publish action");
    assert_eq!(report.matched, Some(1), "the robot's bridge is subscribed");

    let applied = bridge.step().await.expect("the bridge drives the bus");
    assert_eq!(
        applied,
        BridgeEvent::Applied {
            seq: 1,
            frames: JOINTS + 1,
            armed: true,
        },
        "the brain's action reached the robot's bus"
    );
    let frames = bridge.hal().frames();
    assert_eq!(frames.len(), JOINTS + 1);
    assert!(bridge.hal().armed(), "the gait energized the drivers");
    assert!(frames.iter().any(|f| f.op == MotorOp::SetPosition));

    // ── the e-stop path reaches every joint without a gait pose ─────────────────
    commander
        .publish(&AgentAction::new(r#"{"action":"estop"}"#))
        .await
        .expect("publish estop");
    assert_eq!(
        bridge.step().await.expect("estop applied"),
        BridgeEvent::Estopped {
            reason: EstopReason::Commanded,
            frames: JOINTS,
        }
    );
    assert!(!bridge.hal().armed(), "an e-stop disarms the drivers");
    assert!(bridge.is_estopped(), "the e-stop is latched");

    // ── a stale motion command after the e-stop is REFUSED, not executed ────────
    let frames_before = bridge.hal().frames().len();
    commander
        .publish(&AgentAction::new(r#"{"action":"trot","speed":1.0}"#))
        .await
        .expect("publish trot");
    match bridge.step().await.expect("step") {
        BridgeEvent::Refused { reason, .. } => {
            assert!(reason.contains("latched"), "got: {reason}");
        }
        other => panic!("motion must be refused while e-stopped, got {other:?}"),
    }
    assert_eq!(
        bridge.hal().frames().len(),
        frames_before,
        "a refused action writes nothing to the bus"
    );

    // ── and only an explicit arm clears it ─────────────────────────────────────
    commander
        .publish(&AgentAction::new(r#"{"action":"arm"}"#))
        .await
        .expect("publish arm");
    assert_eq!(
        bridge.step().await.expect("arm applied"),
        BridgeEvent::Applied {
            seq: 4,
            frames: JOINTS,
            armed: true,
        }
    );
    assert!(!bridge.is_estopped(), "arm clears the latch");
    assert!(bridge.hal().armed());

    // ── the counters tell the story an operator would read ─────────────────────
    let snapshot = metrics.snapshot();
    assert_eq!(
        snapshot.published, 7,
        "3 depth frames + 4 actions (trot, estop, a refused trot, arm)"
    );
    assert_eq!(
        snapshot.delivered, 5,
        "one depth frame reached the brain (latest-wins) and all four actions the robot \
         — a *refused* action was still delivered: the frame arrived, the safety layer \
         declined it, which is a different fact from a lost frame"
    );
    assert_eq!(
        snapshot.dropped, 2,
        "the two stale depth frames were dropped by the best-effort policy"
    );
    assert_eq!(snapshot.decode_errors, 0);
    // Both nodes see the same counters (they share the transport's metrics).
    assert_eq!(robot.metrics().snapshot(), snapshot);
}

/// Loss visibility: a best-effort consumer that lagged does not see stale frames, and the
/// gap in the publisher's own counter is what tells an operator how many are gone.
#[tokio::test]
async fn a_best_effort_lag_is_visible_as_a_sequence_gap() {
    let node = LinkNode::in_process(PeerId::new("mini-brain").expect("peer"), NodeKind::Brain);
    let mut stereo = node
        .subscriber::<DepthFrame>(
            Topic::pattern("amos/*/sensor/stereo_left").expect("pattern"),
            Qos::sensor(),
        )
        .await
        .expect("subscribe");
    let camera = node.publisher::<DepthFrame>(
        Topic::channel_topic("dog1", Channel::Sensor, "stereo_left").expect("topic"),
    );
    let frame = |seq: u64| DepthFrame {
        seq,
        width: 1,
        height: 1,
        points: vec![],
    };

    // Ten frames while the brain was busy: only the newest survives (latest-wins), which
    // the subscription reports as nine drops.
    for seq in 1..=10 {
        camera.publish(&frame(seq)).await.expect("publish");
    }
    let mut tracker = SeqTracker::new();
    let first = stereo.recv().await.expect("recv");
    assert_eq!(
        first.message.seq, 10,
        "the newest frame is the one delivered"
    );
    // The first frame a consumer sees can only be a *start*: there is nothing yet to
    // compare it against, so no gap is fabricated for the nine it never saw.
    assert_eq!(
        tracker.observe_received(&first),
        SeqEvent::First { seq: 10 }
    );
    assert_eq!(stereo.stats().dropped, 9);

    // Now the lag is measurable: the consumer reads #12 after #10, so #11 is a *gap*.
    camera.publish(&frame(11)).await.expect("publish");
    camera.publish(&frame(12)).await.expect("publish");
    let second = stereo.recv().await.expect("recv");
    assert_eq!(second.message.seq, 12);
    assert_eq!(
        tracker.observe_received(&second),
        SeqEvent::Gap {
            expected: 11,
            seq: 12,
            missing: 1
        }
    );

    // The summary an operator reads: one stream, one in-order frame, one gap of one frame.
    let summary = tracker.summary();
    assert_eq!(summary.streams, 1);
    assert_eq!(summary.in_order, 1);
    assert_eq!(summary.gaps, 1);
    assert_eq!(summary.missing, 1);
    assert_eq!(summary.stale, 0);
    assert!(summary.has_loss());
    assert!(summary.loss_ratio() > 0.0);
    // The stream is keyed by *publisher*, not by topic: `amos/dog1/…` is published here by
    // the brain node (`mini-brain`), which is exactly how a decentralized bus stays honest
    // about who is talking.
    assert_eq!(
        tracker.highest(&PeerId::new("mini-brain").expect("peer")),
        Some(12)
    );
    assert_eq!(tracker.streams(), 1);
}

/// A back-pressured control subscriber must not slow an unrelated sensor topic.
#[tokio::test]
async fn a_subscriber_that_is_gone_does_not_stall_an_unrelated_topic() {
    let metrics = Arc::new(LinkMetrics::new());
    let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
    let node = LinkNode::with_parts(
        PeerId::new("dog1").expect("peer"),
        NodeKind::Robot,
        Arc::clone(&transport),
        Arc::new(Clock::host()),
        Arc::clone(&metrics),
    );

    // A reliable, one-slot subscriber on the control topic whose consumer never reads.
    let control = node
        .subscriber::<AgentAction>(
            Topic::pattern("amos/dog1/control/*").expect("pattern"),
            Qos::new(
                amos_link::qos::Reliability::Reliable,
                1,
                amos_link::qos::DropPolicy::DropOldest,
            ),
        )
        .await
        .expect("subscribe");
    let high_rate = node.publisher::<DepthFrame>(
        Topic::channel_topic("dog1", Channel::Sensor, "imu").expect("topic"),
    );
    // The sensor topic has its own subscribers: publishing there must never wait for the
    // back-pressured control subscriber.
    for seq in 1..=50u64 {
        tokio::time::timeout(
            Duration::from_millis(200),
            high_rate.publish(&DepthFrame {
                seq,
                width: 1,
                height: 1,
                points: vec![],
            }),
        )
        .await
        .expect("a sensor publish is never blocked by another topic")
        .expect("publish");
    }
    assert_eq!(high_rate.seq(), 50);
    drop(control);
    assert!(metrics.snapshot().published >= 50);
}

/// The **return path**: the brain learns the robot stopped, without asking it.
///
/// The scenario a field deployment actually hits — the link goes quiet mid-gait, the
/// robot's deadman cuts torque, and the peer whose link is the thing that died is **told**.
/// Before the return path existed `RobotBridge::step` returned `Estopped` to its *local*
/// caller only, so the field server kept believing its `trot` was still running.
///
/// It also pins the topic doctrine of `docs/amos-link.md` §2 on the wire: the topic
/// `amos/dog1/state/actuation` belongs to the robot and is published by the robot — the
/// envelope's `publisher` says so, which is why the payload does not repeat it.
#[tokio::test]
async fn the_brain_observes_a_watchdog_torque_cut_on_the_state_channel() {
    let metrics = Arc::new(LinkMetrics::new());
    let clock = Arc::new(Clock::host());
    let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();

    let robot = LinkNode::with_parts(
        PeerId::new("dog1").expect("peer"),
        NodeKind::Robot,
        Arc::clone(&transport),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    );
    let brain = LinkNode::with_parts(
        PeerId::new("mini-brain").expect("peer"),
        NodeKind::Brain,
        Arc::clone(&transport),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    );
    let dog1 = PeerId::new("dog1").expect("peer");

    // The robot's control loop, reporting its actuation state (same node = same identity).
    let control = robot
        .subscriber::<AgentAction>(
            Topic::pattern("amos/dog1/control/*").expect("pattern"),
            Qos::control(),
        )
        .await
        .expect("subscribe control");
    let mut bridge =
        RobotBridge::with_watchdog(control, MockRobotHal::new(), Duration::from_millis(30))
            .reporting(robot.publisher::<ActuationState>(actuation_topic(&dog1).expect("topic")));

    // The field server watches every robot's mode on the `state` channel.
    let mut reports = brain
        .subscriber::<ActuationState>(
            Topic::pattern("amos/*/state/actuation").expect("pattern"),
            Qos::for_channel(Channel::State),
        )
        .await
        .expect("subscribe state");

    // ── the brain commands a trot; the robot applies it and reports the new mode ──
    brain
        .publisher::<AgentAction>(
            Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
        )
        .publish(&AgentAction::new(r#"{"action":"trot","speed":0.6}"#))
        .await
        .expect("publish trot");
    assert_eq!(
        bridge.step().await.expect("step"),
        BridgeEvent::Applied {
            seq: 1,
            frames: JOINTS + 1,
            armed: true
        }
    );
    let trotting = reports.recv().await.expect("a state report");
    assert_eq!(trotting.message.gait, Some(Gait::Trot));
    assert!(trotting.message.armed);
    assert!(!trotting.message.estopped);
    // The robot is the publisher of its own state topic — not the brain that commanded it.
    assert_eq!(
        trotting.publisher, dog1,
        "the state topic belongs to (and is published by) the robot"
    );
    assert_eq!(trotting.topic, actuation_topic(&dog1).expect("topic"));

    // ── the link dies mid-gait: the deadman cuts torque, and the brain is told ──
    assert_eq!(
        bridge.step().await.expect("step"),
        BridgeEvent::Estopped {
            reason: EstopReason::Watchdog,
            frames: JOINTS,
        }
    );
    let stopped = reports.recv().await.expect("a state report").message;
    assert!(stopped.estopped, "the commander learns torque was cut");
    assert_eq!(stopped.estop_reason, Some(EstopReason::Watchdog));
    assert!(!stopped.armed);
    assert_eq!(stopped.watchdog_ms, Some(30));
    // …and the robot is latched: a stale `trot` from a queue cannot revive it.
    brain
        .publisher::<AgentAction>(
            Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
        )
        .publish(&AgentAction::new(r#"{"action":"trot"}"#))
        .await
        .expect("publish stale trot");
    assert!(matches!(
        bridge.step().await.expect("step"),
        BridgeEvent::Refused { .. }
    ));
    let refusal = reports.recv().await.expect("a state report").message;
    assert!(
        refusal
            .last_refusal
            .as_ref()
            .expect("refusal")
            .reason
            .contains("re-arm"),
        "the brain is told why its command did nothing, and how to recover"
    );
}
