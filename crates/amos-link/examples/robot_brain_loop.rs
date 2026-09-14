//! `robot_brain_loop` — the exchange AmOS-Link exists for, on one **offline** link.
//!
//! Two agents share one in-process [`Broker`] (the same shape a board and a field server
//! have over Zenoh, but with no sockets so this runs anywhere):
//!
//! ```text
//!   dog1  ──publish stereo frames (best-effort, latest wins)──►  mini-brain
//!   mini-brain  ──publish {"action":"trot"} on the control channel──►  dog1
//!   dog1  ──RobotBridge──► CRC-checked motor frames  ──►  MockRobotHal
//!   dog1  ──publish its mode on the state channel──►  mini-brain
//! ```
//!
//! The last line is the **return path**: the robot reports armed / e-stopped / which gait,
//! so the brain can tell an applied command from a refused one — and so a watchdog torque
//! cut cannot stay invisible to the peer whose link is the thing that died.
//!
//! It prints what each side actually saw — the frame the brain decoded, its measured age
//! (the publisher's clock is in the header), the motor frames the robot wrote, the mode the
//! brain read back, and the latched e-stop path — plus the counters and the link's own
//! verdict. Nothing here is a mock of the *middleware*: the transport, framing, QoS,
//! sequence accounting and HAL are the shipping code paths.
//!
//! Usage:
//! ```text
//! cargo run -p amos-link --example robot_brain_loop
//! ```

use std::sync::Arc;
use std::time::Duration;

use amos_link::broker::Broker;
use amos_link::codec::Clock;
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::health::LinkHealth;
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::pubsub::{Publisher, Received, Subscriber};
use amos_link::qos::Qos;
use amos_link::robot_hal::{
    actuation_topic, ActuationState, AgentAction, BridgeEvent, MockRobotHal, MotorFrame,
    RobotBridge, RobotHal,
};
use serde::{Deserialize, Serialize};

/// The payload a stereo pair publishes. Any `serde` type is a link `Message`; this one
/// stands in for a real depth frame (a few bytes instead of megabytes, so the run is fast).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct DepthFrame {
    seq: u64,
    width: u32,
    height: u32,
    points: Vec<i16>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // One clock per link in production (calibrated by amos-timesync); the host clock here.
    let metrics = Arc::new(LinkMetrics::new());
    let clock = Arc::new(Clock::host());
    let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();

    let robot = LinkNode::with_parts(
        PeerId::new("dog1")?,
        NodeKind::Robot,
        Arc::clone(&transport),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    );
    let brain = LinkNode::with_parts(
        PeerId::new("mini-brain")?,
        NodeKind::Brain,
        Arc::clone(&transport),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    );
    println!(
        "link up: {} + {} over the in-process broker",
        robot.peer(),
        brain.peer()
    );

    // ── the brain watches *every* robot's left camera, best-effort ────────────────
    let mut stereo = Subscriber::<DepthFrame>::subscribe(
        Arc::clone(&transport),
        Topic::pattern("amos/*/sensor/stereo_left")?,
        Qos::sensor(), // depth 1, drop-oldest: a fresh frame beats a queue of stale ones
        Arc::clone(&metrics),
    )
    .await?;

    // ── the robot's control loop: JSON in, motor frames out ───────────────────────
    let control = Subscriber::<AgentAction>::subscribe(
        Arc::clone(&transport),
        Topic::pattern("amos/dog1/control/*")?,
        Qos::control(), // reliable: a motion command must not be dropped
        Arc::clone(&metrics),
    )
    .await?;
    // ── …and the brain watches every robot's *mode* on the state channel ──────────
    // This is the return path. Without it the brain cannot tell an applied command from a
    // refused one, and a watchdog torque cut would be invisible to the very peer whose link
    // just died. `state` is latest-wins: the brain learns the current mode, not a history.
    let mut mode = Subscriber::<ActuationState>::subscribe(
        Arc::clone(&transport),
        Topic::pattern("amos/*/state/actuation")?,
        Qos::for_channel(Channel::State),
        Arc::clone(&metrics),
    )
    .await?;
    // The robot owns its state topic and publishes it itself (`actuation_topic`), which is
    // why the payload carries no peer id — the frame header already names the publisher.
    let mut bridge = RobotBridge::new(control, MockRobotHal::new())
        .reporting(robot.publisher::<ActuationState>(actuation_topic(robot.peer())?));

    // ── the camera publishes three frames; only the newest one reaches the brain ──
    let camera = Publisher::<DepthFrame>::new(
        Arc::clone(&transport),
        Topic::channel_topic("dog1", Channel::Sensor, "stereo_left")?,
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
            .await?;
    }
    let frame = stereo.recv().await?;
    println!(
        "brain <- {} {}x{} seq={} from {} age={}ms (dropped {} stale frame(s): latest wins)",
        frame.topic,
        frame.message.width,
        frame.message.height,
        frame.message.seq,
        frame.publisher,
        frame.age().as_millis(),
        stereo.stats().dropped
    );

    // ── the brain answers on the robot's control channel ──────────────────────────
    // The *topic* names the subject (`amos/dog1/control/action` = dog1's control input,
    // so a wildcard on `amos/dog1/control/*` sees it); the frame's *publisher* is the
    // brain. A field server can therefore command a robot without owning its namespace.
    let commander =
        brain.publisher::<AgentAction>(Topic::channel_topic("dog1", Channel::Control, "action")?);
    let report = commander
        .publish(&AgentAction::new(r#"{"action":"trot","speed":0.8}"#))
        .await?;
    println!(
        "brain -> trot speed=0.8: matched={} subscriber(s)",
        report.matched.unwrap_or(0)
    );

    match bridge.step().await? {
        BridgeEvent::Applied { seq, frames, armed } => {
            println!("dog1 applied action #{seq}: {frames} motor frame(s), armed={armed}");
            for frame in bridge.hal().frames() {
                println!("  {}", render(&frame));
            }
        }
        other => println!("dog1 did not apply the action: {other:?}"),
    }
    println!(
        "dog1 gait: armed={} estop={}",
        bridge.hal().armed(),
        bridge.is_estopped()
    );
    // What the *brain* learned about that mode — read off the link, not from the bridge.
    if let Some(seen) = mode.try_recv()? {
        println!("brain <- mode: {}", render_mode(&seen));
    }

    // ── the e-stop latches, and a later motion command is refused, not executed ──
    commander
        .publish(&AgentAction::new(r#"{"action":"estop"}"#))
        .await?;
    println!("brain -> e-stop: {:?}", bridge.step().await?);
    if let Some(seen) = mode.try_recv()? {
        println!("brain <- mode: {}", render_mode(&seen));
    }
    commander
        .publish(&AgentAction::new(r#"{"action":"trot","speed":1.0}"#))
        .await?;
    println!("motion while e-stopped: {:?}", bridge.step().await?);
    // The refusal is reported too: the commander learns *why* its command did nothing, and
    // how to recover, instead of watching a robot that silently ignores it.
    if let Some(seen) = mode.try_recv()? {
        println!("brain <- mode: {}", render_mode(&seen));
        if let Some(refusal) = seen.message.last_refusal.as_ref() {
            println!("  last refusal: seq {} — {}", refusal.seq, refusal.reason);
        }
    }

    // ── counters, the topic inventory and the link's own verdict ────────────────
    let counts = metrics.snapshot();
    println!(
        "counters: published={} delivered={} dropped={} blocked={} decode_errors={}",
        counts.published, counts.delivered, counts.dropped, counts.blocked, counts.decode_errors
    );
    let mut topics = robot.topics().await;
    topics.sort();
    println!("topics seen by dog1: {topics:?}");
    let status = robot.status().await;
    let health = LinkHealth::evaluate(&status.metrics, &status.peers, status.clock_synced, None);
    println!(
        "health: {} ({})",
        health.summary(),
        if status.clock_synced {
            "latencies are measured"
        } else {
            "latencies are bounds until amos-timesync calibrates the clock"
        }
    );
    // A tool on a quiet link is a normal state, not a failure.
    tokio::time::sleep(Duration::from_millis(1)).await;
    Ok(())
}

/// The mode as the *brain* reads it off the state channel — the same facts the CLI's
/// `state` command prints for an operator.
fn render_mode(seen: &Received<ActuationState>) -> String {
    let state = &seen.message;
    format!(
        "robot={} armed={} estopped={}{} gait={} watchdog={}",
        seen.publisher,
        state.armed,
        state.estopped,
        state
            .estop_reason
            .map(|r| format!("({})", r.key()))
            .unwrap_or_default(),
        state.gait.map(|g| g.key()).unwrap_or("-"),
        state
            .watchdog_ms
            .map(|ms| format!("{ms}ms"))
            .unwrap_or_else(|| "-".to_string()),
    )
}

/// One motor frame the way a bus log shows it: `joint op arg hex`.
fn render(frame: &MotorFrame) -> String {
    format!(
        "joint={:>2} op={:?} arg={:>8} frame={}",
        frame.joint.index(),
        frame.op,
        frame.arg,
        frame.encode_hex()
    )
}
