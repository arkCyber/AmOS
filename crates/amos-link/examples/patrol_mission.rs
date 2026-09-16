//! `patrol_mission` — robot application case ①: **one patrol, end to end**.
//!
//! The catalogue (docs/robot-apps.md) lists the applications a robot OS has to carry. This
//! is the first one, and it is the whole control loop of a patrol robot in one process:
//!
//! ```text
//!   field server ──{"action":"stand|trot|sit"} on the control channel──►  patrol-01
//!   patrol-01    ──stereo frames (best-effort, latest wins)─────────────►  field server
//!   patrol-01    ──RobotBridge──► CRC16 motor frames ──►  MockRobotHal (the servo bus)
//!   patrol-01    ──its mode on amos/patrol-01/state/actuation───────────►  field server
//! ```
//!
//! Five things the case is here to show, each of which the middleware has to get right
//! *before* an application can be written on top of it:
//!
//! 1. **The sensor stream is latest-wins** (`Qos::sensor()`): a brain that was busy keeps the
//!    newest depth frame and counts what it threw away — not a queue of stale ones.
//! 2. **The control stream is reliable** (`Qos::control()`): a motion command is not dropped
//!    under load; if the consumer cannot keep up, the publisher is told (`blocked`).
//! 3. **The deadman watchdog is real**: when the link goes quiet the bridge cuts torque —
//!    and the peer whose link died *sees it*, because the mode is reported (the frame count
//!    comes back from the bus, not from a guess).
//! 4. **A refusal is an answer, not silence**: a motion command while e-stopped is refused
//!    with a reason the commander can read and act on.
//! 5. **The figures an operator reads are checkable**: the per-stream line prints
//!    `frames`/`span`/`rate`/`bytes`/`bw` from **one** window, and says *why* when it cannot
//!    state a rate instead of printing `0 Hz`.
//!
//! The clock here is the host clock, so every latency shown is a **bound** until
//! `amos-timesync` calibrates it — the case prints that caveat rather than a number that
//! would read as measured.
//!
//! Usage:
//! ```text
//! cargo run -p amos-link --example patrol_mission
//! ```

use std::sync::Arc;
use std::time::{Duration, Instant};

use amos_link::broker::{Broker, PublishReport};
use amos_link::codec::Clock;
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::pubsub::{Publisher, Received, Subscriber};
use amos_link::qos::Qos;
use amos_link::rate::{RateTracker, StreamRate};
use amos_link::robot_hal::{
    actuation_pattern, actuation_topic, ActuationState, AgentAction, BridgeEvent, MockRobotHal,
    RobotBridge,
};
use serde::{Deserialize, Serialize};

/// The payload a stereo pair publishes. Any `serde` type is a link `Message`; this one
/// stands in for a real depth frame (a few bytes instead of megabytes, so the case is fast).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct StereoFrame {
    seq: u64,
    width: u32,
    height: u32,
    points: Vec<i16>,
}

/// The deadman period of this robot: short enough that the case runs in about a second,
/// long enough that a command still on its way is not mistaken for a dead link.
const WATCHDOG: Duration = Duration::from_millis(300);
/// The camera's cadence in this case (10 Hz), and how many frames the patrol takes.
const CAMERA_PERIOD: Duration = Duration::from_millis(100);
const CAMERA_FRAMES: u64 = 6;
/// Both nodes announce themselves four times a second, so the peer table is populated by
/// the time the mission ends (a beacon is discovery, not authentication — §6.2).
const FEDERATION: Duration = Duration::from_millis(250);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("case ① patrol mission — one robot, one closed loop (docs/robot-apps.md)");
    let metrics = Arc::new(LinkMetrics::new());
    let clock = Arc::new(Clock::host());
    let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();

    let robot = Arc::new(LinkNode::with_parts(
        PeerId::new("patrol-01")?,
        NodeKind::Robot,
        Arc::clone(&transport),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    ));
    let server = Arc::new(LinkNode::with_parts(
        PeerId::new("field-server")?,
        NodeKind::Brain,
        Arc::clone(&transport),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    ));
    let robot_fed = robot.spawn_federation(FEDERATION)?;
    let server_fed = server.spawn_federation(FEDERATION)?;
    println!(
        "link up: {} (robot) + {} (brain) over the in-process broker",
        robot.peer(),
        server.peer()
    );

    // ── the robot's control loop: JSON intent in, motor frames out ─────────────────
    let control = Subscriber::<AgentAction>::subscribe(
        Arc::clone(&transport),
        Topic::pattern("amos/patrol-01/control/*")?,
        Qos::control(), // reliable: a motion command must not be dropped
        Arc::clone(&metrics),
    )
    .await?;
    let mut bridge = RobotBridge::with_watchdog(control, MockRobotHal::new(), WATCHDOG)
        .reporting(robot.publisher::<ActuationState>(actuation_topic(robot.peer())?));

    // ── the field server: a camera view, a control publisher, and the return path ──
    let mut camera = Subscriber::<StereoFrame>::subscribe(
        Arc::clone(&transport),
        Topic::pattern("amos/*/sensor/stereo_left")?,
        Qos::sensor(), // depth 1, drop-oldest: a fresh frame beats a queue of stale ones
        Arc::clone(&metrics),
    )
    .await?;
    // The return path, read the same way the CLI's `state` command reads it.
    let mut modes = Subscriber::<ActuationState>::subscribe(
        Arc::clone(&transport),
        actuation_pattern()?,
        Qos::for_channel(Channel::State),
        Arc::clone(&metrics),
    )
    .await?;
    let action_topic = Topic::channel_topic("patrol-01", Channel::Control, "action")?;
    let camera_topic = Topic::channel_topic("patrol-01", Channel::Sensor, "stereo_left")?;
    let commander = server.publisher::<AgentAction>(action_topic);
    let camera_out = robot.publisher::<StereoFrame>(camera_topic.clone());

    // ── 1. the mission starts: stand up, then trot ─────────────────────────────────
    command(&commander, r#"{"action":"stand"}"#).await?;
    step_and_read(&mut bridge, &mut modes).await?;
    command(
        &commander,
        r#"{"action":"trot","speed":0.6,"duration_ms":800}"#,
    )
    .await?;
    step_and_read(&mut bridge, &mut modes).await?;

    // ── 2. the camera runs its cadence, and the brain measures it ─────────────────
    // The rate comes from **our own monotonic arrival instants**, never from the frame's
    // stamp: that number would inherit the publisher's clock error (§3.19).
    let mut rates = RateTracker::new();
    for seq in 1..=CAMERA_FRAMES {
        camera_out
            .publish(&StereoFrame {
                seq,
                width: 1280,
                height: 720,
                points: vec![seq as i16; 4],
            })
            .await?;
        tokio::time::sleep(CAMERA_PERIOD).await;
        if let Some(frame) = camera.try_recv()? {
            rates.observe_received(&frame, Instant::now());
        }
    }
    let tracked = rates.rate(robot.peer(), &camera_topic);
    println!(
        "field server <- camera {}",
        match tracked {
            Some(reading) => render_stream(&reading),
            None => "no arrival was observed".to_string(),
        }
    );

    // ── 3. the camera stalls and then bursts: latest wins, and the loss is counted ──
    for seq in CAMERA_FRAMES + 1..=CAMERA_FRAMES + 3 {
        camera_out
            .publish(&StereoFrame {
                seq,
                width: 1280,
                height: 720,
                points: vec![seq as i16; 4],
            })
            .await?;
    }
    if let Some(frame) = camera.try_recv()? {
        println!(
            "field server <- camera seq={} (of a burst of 3; {} stale frame(s) dropped: latest wins)",
            frame.message.seq,
            camera.stats().dropped
        );
    }

    // ── 4. the link goes quiet: the deadman watchdog cuts torque, and reports it ────
    println!("…the field server stops talking (link presumed lost)");
    step_and_read(&mut bridge, &mut modes).await?;

    // ── 5. motion while e-stopped is refused — with a reason, not with silence ──────
    command(&commander, r#"{"action":"trot","speed":0.8}"#).await?;
    step_and_read(&mut bridge, &mut modes).await?;

    // ── 6. the operator re-arms, and the mission continues ─────────────────────────
    command(&commander, r#"{"action":"arm"}"#).await?;
    step_and_read(&mut bridge, &mut modes).await?;
    command(&commander, r#"{"action":"sit"}"#).await?;
    step_and_read(&mut bridge, &mut modes).await?;

    // ── the mission's books: counters, inventory, peer table, verdict ──────────────
    let counts = metrics.snapshot();
    println!(
        "counters: published={} delivered={} dropped={} blocked={} decode_errors={}",
        counts.published, counts.delivered, counts.dropped, counts.blocked, counts.decode_errors
    );
    let mut topics = server.topics().await;
    topics.sort();
    println!("topics seen by the field server: {topics:?}");

    // Give the federation a beat to have filled the table on both sides.
    tokio::time::sleep(FEDERATION).await;
    let status = server.status().await;
    let peers: Vec<&str> = status.peers.iter().map(|p| p.id().as_str()).collect();
    println!(
        "peer table of the field server: {peers:?} (this node is never its own peer: {} self-echo(es) filtered)",
        robot_fed.self_echoes() + server_fed.self_echoes()
    );
    println!(
        "health: {} — {} ({} reason(s))",
        status.health.summary(),
        if status.clock_synced {
            "latencies are measured"
        } else {
            "latencies are bounds until amos-timesync calibrates the clock"
        },
        status.health.reasons().len()
    );

    // A tool that leaves stops announcing; the links it opened go with it.
    robot_fed.stop().await;
    server_fed.stop().await;
    Ok(())
}

/// One motion command from the field server, with the publisher's own report printed —
/// `matched=0` on a control topic is a real finding (nobody is listening), not noise.
async fn command(
    commander: &Publisher<AgentAction>,
    json: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let report = commander.publish(&AgentAction::new(json)).await?;
    println!("field server -> {json}  [{}]", render_report(&report));
    Ok(())
}

/// One step of the robot's control loop, plus what the *field server* learned from it.
async fn step_and_read(
    bridge: &mut RobotBridge<MockRobotHal>,
    modes: &mut Subscriber<ActuationState>,
) -> Result<BridgeEvent, Box<dyn std::error::Error>> {
    let event = bridge.step().await?;
    println!("patrol-01: {}", render_event(&event));
    if let Some(seen) = modes.try_recv()? {
        println!("field server <- mode: {}", render_mode(&seen));
    }
    Ok(event)
}

/// The mode as the field server reads it off the state channel (the CLI's `state` line).
fn render_mode(seen: &Received<ActuationState>) -> String {
    let state = &seen.message;
    format!(
        "robot={} armed={} estopped={}{} gait={} watchdog={} last_refusal={}",
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
        state
            .last_refusal
            .as_ref()
            .map(|r| format!("#{} {}", r.seq, r.reason))
            .unwrap_or_else(|| "-".to_string()),
    )
}

/// What one step did, in one line.
fn render_event(event: &BridgeEvent) -> String {
    match event {
        BridgeEvent::Applied { seq, frames, armed } => {
            format!("applied action #{seq}: {frames} motor frame(s), armed={armed}")
        }
        BridgeEvent::Refused { seq, reason } => format!("refused action #{seq}: {reason}"),
        BridgeEvent::Estopped { reason, frames } => format!(
            "torque cut ({}) — {frames} frame(s) the bus accepted",
            reason.key()
        ),
    }
}

/// What a publish was seen to do by this transport (`unknown` = it cannot know, e.g. Zenoh).
fn render_report(report: &PublishReport) -> String {
    format!(
        "matched={} delivered={} dropped={} blocked={}",
        report
            .matched
            .map(|n| n.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        report.delivered,
        report.dropped,
        report.blocked
    )
}

/// One stream's reading: `frames`/`span`/`rate`/`bytes`/`bw` from one window, or the reason
/// the figures cannot be stated — never a placeholder zero (§3.19/§3.20).
fn render_stream(reading: &StreamRate) -> String {
    let span = reading
        .span
        .map(|s| format!("{:.2}s", s.as_secs_f64()))
        .unwrap_or_else(|| "-".to_string());
    match reading.rate_hz {
        Some(rate) => format!(
            "publisher={} topic={} frames={} span={} rate={:.1}Hz bytes={} bw={}/s",
            reading.publisher,
            reading.topic,
            reading.frames,
            span,
            rate,
            reading.bytes,
            render_bytes(reading.bytes_per_sec.unwrap_or(0.0))
        ),
        None => format!(
            "publisher={} topic={} frames={} span={} rate=unknown({}) bytes={} bw=unknown",
            reading.publisher,
            reading.topic,
            reading.frames,
            span,
            reading
                .evidence()
                .map(|e| e.detail())
                .unwrap_or_else(|| "no evidence".to_string()),
            reading.bytes
        ),
    }
}

/// Binary-prefix byte count (the CLI's formatter, in one shape).
fn render_bytes(per_sec: f64) -> String {
    if !per_sec.is_finite() {
        return "unknown".to_string();
    }
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = per_sec;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1}{}", UNITS[unit])
}
