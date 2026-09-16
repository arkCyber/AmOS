//! `fleet_console` — robot application case ②: **a console that watches a fleet**.
//!
//! One supervisor, three robots, no command channel from the console's *reading* path: a
//! fleet console answers "which robot is doing what, and which stream stopped?" — the
//! question an operator asks before touching anything:
//!
//! ```text
//!   patrol-01 ──mode+camera──┐
//!   patrol-02 ──mode+camera──┼──►  fleet-console  (subscribes amos/*/state/actuation
//!   patrol-03 ──mode only  ──┘                      and amos/*/sensor/stereo_left)
//! ```
//!
//! What the case adds over case ① (one robot, one loop):
//!
//! 1. **Wildcards are how a fleet is addressed**: the console subscribes `amos/*/state/actuation`
//!    and `amos/*/sensor/stereo_left` once, and every robot that joins is covered — no
//!    per-robot wiring, and a robot that is switched off simply stops appearing.
//! 2. **Per-robot, per-stream figures**: `RateTracker` keeps one arrival window per
//!    `(publisher, topic)`, so the same table shows a 10 Hz camera and a dead one — and the
//!    dead one reads `frames=1 rate=unknown(…)`, never `0 Hz`.
//! 3. **The console prints the table twice**: a figure that is *moving* and a figure that is
//!    *stuck* look identical in a single reading. The second table is what tells an operator
//!    which stream stopped, which is the whole reason a console samples instead of snapshotting.
//! 4. **A deadman that trips is visible from the console**: the moment the duty commander
//!    stops talking, every robot cuts torque — and every robot *says so* on the state channel,
//!    so the console can tell "parked on purpose" from "the link died".
//! 5. **A console that is slow under-reports, and says so**: the sensor profile is
//!    latest-wins, so the frames a busy console missed are counted (`dropped`) beside the
//!    rates — the reading is this process's, not the publisher's (§3.19 boundary).
//!
//! Usage:
//! ```text
//! cargo run -p amos-link --example fleet_console
//! ```

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use amos_link::broker::Broker;
use amos_link::codec::Clock;
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::pubsub::Subscriber;
use amos_link::qos::Qos;
use amos_link::rate::{RateTracker, StreamRate};
use amos_link::robot_hal::{
    actuation_pattern, actuation_topic, ActuationState, AgentAction, MockRobotHal, RobotBridge,
};
use serde::{Deserialize, Serialize};

/// One depth frame from a robot's stereo pair (a few bytes instead of megabytes).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct StereoFrame {
    seq: u64,
    width: u32,
    height: u32,
    points: Vec<i16>,
}

/// The fleet of this case: two robots with a live camera, one whose camera has died.
const ROBOTS: [&str; 3] = ["patrol-01", "patrol-02", "patrol-03"];
/// Every robot's deadman period (the console commands once, so every one of them must trip).
const WATCHDOG: Duration = Duration::from_millis(200);
/// The duty commander of `patrol-01`: a real control loop runs at 50–100 Hz; 80 ms keeps the
/// case short while still being "fast enough that the watchdog never trips".
const DUTY_PERIOD: Duration = Duration::from_millis(80);
/// A camera that is running (10 Hz) and a camera that is slower (5 Hz) — one table, two rates.
const CAMERA_FAST: Duration = Duration::from_millis(100);
const CAMERA_SLOW: Duration = Duration::from_millis(200);
/// The two robots with a camera also boot a moment after their node, so a console that
/// subscribes at startup sees the whole stream — the link keeps **no history** (§6.4), so a
/// frame published before a subscription exists is not late, it is absent.
const CAMERA_STARTUP: Duration = Duration::from_millis(250);
/// Beacons every 250 ms, so the peer table is filled by the time the first table prints.
const FEDERATION: Duration = Duration::from_millis(250);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("case ② fleet console — three robots, one pair of eyes (docs/robot-apps.md)");
    // One transport, one counter set: that is what makes this *one link* rather than three.
    let metrics = Arc::new(LinkMetrics::new());
    let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
    let clock = Arc::new(Clock::host());

    let node = |id: &str, kind: NodeKind| -> Result<Arc<LinkNode>, amos_link::LinkError> {
        Ok(Arc::new(LinkNode::with_parts(
            PeerId::new(id)?,
            kind,
            Arc::clone(&transport),
            Arc::clone(&clock),
            Arc::clone(&metrics),
        )))
    };
    let console = node("fleet-console", NodeKind::Tool)?;

    // ── the robots: each owns its control loop, its camera and its report ──────────
    let mut handles = Vec::new();
    let mut stops = Vec::new();
    let mut feds = vec![console.spawn_federation(FEDERATION)?];
    for (index, id) in ROBOTS.iter().enumerate() {
        let robot = node(id, NodeKind::Robot)?;
        feds.push(robot.spawn_federation(FEDERATION)?);
        let stop = Arc::new(AtomicBool::new(false));
        stops.push(Arc::clone(&stop));
        let (robot_node, camera_node) = (Arc::clone(&robot), Arc::clone(&robot));
        let (robot_stop, camera_stop) = (Arc::clone(&stop), Arc::clone(&stop));
        // The camera of the third robot publishes exactly one frame and dies — late enough
        // that it does not race the other two for the console's one-slot sensor queue, so the
        // reading shows *the stream that stopped* instead of a frame the policy dropped.
        let (period, limit, delay) = match index {
            0 => (CAMERA_FAST, None, CAMERA_STARTUP),
            1 => (CAMERA_SLOW, None, CAMERA_STARTUP),
            _ => (CAMERA_FAST, Some(1u64), CAMERA_STARTUP * 2),
        };
        handles.push(tokio::spawn(run_robot(robot_node, robot_stop)));
        handles.push(tokio::spawn(run_camera(
            camera_node,
            camera_stop,
            period,
            limit,
            delay,
        )));
    }

    // ── the console: one pattern per signal, and a table an operator reads ─────────
    let mut modes = Subscriber::<ActuationState>::subscribe(
        Arc::clone(&transport),
        actuation_pattern()?,
        Qos::for_channel(Channel::State),
        Arc::clone(&metrics),
    )
    .await?;
    let mut cameras = Subscriber::<StereoFrame>::subscribe(
        Arc::clone(&transport),
        Topic::pattern("amos/*/sensor/stereo_left")?,
        Qos::sensor(),
        Arc::clone(&metrics),
    )
    .await?;

    // ── the fleet is put on duty: one command each, and a live control loop for patrol-01 ──
    for id in ROBOTS {
        console
            .publisher::<AgentAction>(Topic::channel_topic(id, Channel::Control, "action")?)
            .publish(&AgentAction::new(r#"{"action":"stand"}"#))
            .await?;
    }
    let duty_stop = Arc::new(AtomicBool::new(false));
    let duty = tokio::spawn(run_duty(
        Arc::clone(&console),
        Arc::clone(&duty_stop),
        "patrol-01",
    ));

    // ── reading 1: everything the fleet is doing right now ────────────────────────
    let mut rates = RateTracker::new();
    let mut latest: BTreeMap<String, ActuationState> = BTreeMap::new();
    drain_for(
        Duration::from_millis(700),
        &mut cameras,
        &mut modes,
        &mut rates,
        &mut latest,
    )
    .await?;
    println!(
        "\nreading 1 — the fleet 700 ms after one `stand` each: patrol-01 has a control loop, \
         patrol-02/03 were commanded once and their deadman has already tripped"
    );
    print_table(&latest, &rates, &cameras, console.peer());

    // ── the duty commander stops: every robot's deadman trips, and every robot says so ──
    duty_stop.store(true, Ordering::Relaxed);
    if tokio::time::timeout(Duration::from_secs(2), duty)
        .await
        .is_err()
    {
        println!("warn: the duty commander did not stop within the grace period");
    }
    drain_for(
        Duration::from_millis(400),
        &mut cameras,
        &mut modes,
        &mut rates,
        &mut latest,
    )
    .await?;
    println!("\nreading 2 — same console, same patterns, 400 ms after the control loop stopped");
    print_table(&latest, &rates, &cameras, console.peer());

    // ── the console's own books: what it moved, what it missed, who is on the link ──
    let counts = metrics.snapshot();
    println!(
        "\ncounters: published={} delivered={} dropped={} blocked={} decode_errors={}",
        counts.published, counts.delivered, counts.dropped, counts.blocked, counts.decode_errors
    );
    let mut topics = console.topics().await;
    topics.sort();
    println!(
        "topics seen by the console: {} concrete topic(s)",
        topics.len()
    );
    let status = console.status().await;
    let peers: Vec<&str> = status.peers.iter().map(|p| p.id().as_str()).collect();
    println!(
        "peer table of the console: {peers:?} (a console is never its own peer; {} self-echo(es) filtered)",
        feds.iter().map(|f| f.self_echoes()).sum::<u64>()
    );
    println!(
        "health: {} ({})",
        status.health.summary(),
        if status.clock_synced {
            "latencies are measured"
        } else {
            "latencies are bounds until amos-timesync calibrates the clock"
        }
    );

    // ── shutdown: stop the robots' loops (each wakes within its watchdog) ───────────
    for stop in &stops {
        stop.store(true, Ordering::Relaxed);
    }
    for handle in handles {
        if tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .is_err()
        {
            println!("warn: a robot loop did not stop within the grace period");
        }
    }
    for fed in feds {
        fed.stop().await;
    }
    Ok(())
}

/// One robot's control loop: wait for the next action (or for the deadman period), act, report.
///
/// This is the loop a real machine runs at 50–100 Hz; here it is one step per action, which is
/// exactly what makes the watchdog visible — no action, no motion, and a torque cut that is
/// **reported** on the state channel.
async fn run_robot(node: Arc<LinkNode>, stop: Arc<AtomicBool>) -> Result<(), amos_link::LinkError> {
    let control = Subscriber::<AgentAction>::subscribe(
        Arc::clone(node.transport()),
        Topic::pattern(format!("amos/{}/control/*", node.peer()))?,
        Qos::control(),
        Arc::clone(node.metrics()),
    )
    .await?;
    let mut bridge = RobotBridge::with_watchdog(control, MockRobotHal::new(), WATCHDOG)
        .reporting(node.publisher::<ActuationState>(actuation_topic(node.peer())?));
    while !stop.load(Ordering::Relaxed) {
        // A transport failure ends the task (the link is gone); the case's shutdown is the
        // stop flag, which the loop notices within one watchdog period.
        if bridge.step().await.is_err() {
            return Ok(());
        }
    }
    Ok(())
}

/// One robot's camera: publish depth frames at `period` until stopped — or, with `limit`,
/// until it has published that many (the camera that died is a stream that stopped).
async fn run_camera(
    node: Arc<LinkNode>,
    stop: Arc<AtomicBool>,
    period: Duration,
    limit: Option<u64>,
    delay: Duration,
) -> Result<(), amos_link::LinkError> {
    let camera = node.publisher::<StereoFrame>(node.topic(Channel::Sensor, "stereo_left")?);
    // A camera that boots with the robot, not before the console can see it.
    tokio::time::sleep(delay).await;
    let mut seq = 0u64;
    while !stop.load(Ordering::Relaxed) {
        seq += 1;
        camera
            .publish(&StereoFrame {
                seq,
                width: 640,
                height: 480,
                points: vec![seq as i16; 4],
            })
            .await?;
        if limit.is_some_and(|n| seq >= n) {
            return Ok(());
        }
        tokio::time::sleep(period).await;
    }
    Ok(())
}

/// A robot's duty commander: keep the control stream alive so its deadman never trips.
async fn run_duty(
    node: Arc<LinkNode>,
    stop: Arc<AtomicBool>,
    robot: &str,
) -> Result<(), amos_link::LinkError> {
    let commander =
        node.publisher::<AgentAction>(Topic::channel_topic(robot, Channel::Control, "action")?);
    while !stop.load(Ordering::Relaxed) {
        commander
            .publish(&AgentAction::new(r#"{"action":"trot","speed":0.4}"#))
            .await?;
        tokio::time::sleep(DUTY_PERIOD).await;
    }
    Ok(())
}

/// Watch the link for `window`, folding every arrival into the rate table and keeping each
/// robot's newest mode. Draining as fast as frames arrive is what makes the arrival instants
/// the tracker sees the *real* ones — a console that sampled on a timer would measure its own
/// timer (and would drop sensor frames without saying so).
async fn drain_for(
    window: Duration,
    cameras: &mut Subscriber<StereoFrame>,
    modes: &mut Subscriber<ActuationState>,
    rates: &mut RateTracker,
    latest: &mut BTreeMap<String, ActuationState>,
) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        tokio::select! {
            frame = cameras.recv() => match frame {
                Ok(frame) => {
                    rates.observe_received(&frame, Instant::now());
                }
                Err(_) => break,
            },
            seen = modes.recv() => match seen {
                Ok(seen) => {
                    rates.observe_received(&seen, Instant::now());
                    latest.insert(seen.publisher.as_str().to_string(), seen.message);
                }
                Err(_) => break,
            },
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }
    Ok(())
}

/// The console's table: each robot's mode, then each stream's window, in a stable order.
fn print_table(
    latest: &BTreeMap<String, ActuationState>,
    rates: &RateTracker,
    cameras: &Subscriber<StereoFrame>,
    console: &PeerId,
) {
    for (robot, state) in latest {
        println!(
            "  mode   {robot:<11} armed={:<5} estopped={:<5}{} gait={:<5} frames={:<3} watchdog={:<6} last_refusal={}",
            state.armed,
            state.estopped,
            state
                .estop_reason
                .map(|r| format!("({})", r.key()))
                .unwrap_or_default(),
            state.gait.map(|g| g.key()).unwrap_or("-"),
            state.frames,
            state
                .watchdog_ms
                .map(|ms| format!("{ms}ms"))
                .unwrap_or_else(|| "-".to_string()),
            state
                .last_refusal
                .as_ref()
                .map(|r| format!("#{} {}", r.seq, r.reason))
                .unwrap_or_else(|| "-".to_string()),
        );
    }
    for reading in rates.rates() {
        println!("  stream {}", render_stream(&reading));
    }
    println!(
        "  note   {console} received these arrivals; it missed {} sensor frame(s) \
         (latest-wins drops them and counts them: this reading is *this process's*)",
        cameras.stats().dropped
    );
}

/// One stream's window: `frames`/`span`/`rate`/`bytes`/`bw`, or the reason a rate cannot be
/// stated — never `0 Hz` for a stream that stopped (§3.19/§3.20).
fn render_stream(reading: &StreamRate) -> String {
    let span = reading
        .span
        .map(|s| format!("{:.2}s", s.as_secs_f64()))
        .unwrap_or_else(|| "-".to_string());
    match reading.rate_hz {
        Some(rate) => format!(
            "{:<11} {:<40} frames={:<4} span={:<6} rate={:>6.1}Hz bytes={:<7} bw={}/s",
            reading.publisher,
            reading.topic,
            reading.frames,
            span,
            rate,
            reading.bytes,
            render_bytes(reading.bytes_per_sec.unwrap_or(0.0))
        ),
        None => format!(
            "{:<11} {:<40} frames={:<4} span={:<6} rate=unknown({}) bytes={}",
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
