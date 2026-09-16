//! `uav_mission` — domain case ④: **a multirotor flies a mission on the same OS**.
//!
//! Cases ①–③ are the reference quadruped. This one is a different machine entirely — four
//! thrusters, two elevons, a 300 ms deadman and a **geofence** — and it runs on the *same*
//! middleware, the *same* frame type and the *same* safety core (`RobotBridge`), because what
//! changed is the machine's [`Platform`] profile, not the OS:
//!
//! ```text
//!   gcs ──{"action":"takeoff|goto|rtl|land|arm|estop"}──►  uav-01
//!   uav-01 ──its mode on amos/uav-01/state/actuation──────►  gcs   (the shared return path)
//!   uav-01 ──"docs/robot-domains.md" contract: 4× thrust, 2× elevon, RTL on a lost link
//! ```
//!
//! Five things this case pins, each of which is a domain requirement and not a wire trick:
//!
//! 1. **Nothing moves on a disarmed aircraft.** A set point before `arm` is refused, naming the
//!    profile's own arm action — the drives are read from the bus, not assumed.
//! 2. **The geofence is a parameter with a limit, not a comment.** `goto` carries
//!    `north_mm`/`east_mm`/`altitude_mm`, and a target outside the envelope is refused **with the
//!    limit in the sentence** — never clamped to the fence (which would fly somewhere nobody
//!    asked for).
//! 3. **The deadman stops the aircraft; the mission layer flies it home.** The bridge cuts the
//!    motors (the minimum safe action at that layer) and reports it; the *manoeuvre* the profile
//!    declares (`return-to-base`) is what the application flies, through the same HAL.
//! 4. **A refusal is answerable**: the refusal travels back on the shared return path, and the
//!    operator is told which action re-arms *this* machine.
//! 5. **The envelope is printed, not implied**: the case prints its own actuator table, vocabulary
//!    and safety envelope, so a reader can diff the machine against docs/robot-domains.md.
//!
//! Usage:
//! ```text
//! cargo run -p amos-link --example uav_mission
//! ```

use std::sync::Arc;
use std::time::{Duration, Instant};

use amos_link::broker::Broker;
use amos_link::codec::Clock;
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::platform::Platform;
use amos_link::pubsub::{Publisher, Received, Subscriber};
use amos_link::qos::Qos;
use amos_link::rate::RateTracker;
use amos_link::robot_hal::{
    actuation_pattern, actuation_topic, ActuationState, AgentAction, BridgeEvent, MockRobotHal,
    RobotBridge, RobotHal,
};
use serde::{Deserialize, Serialize};

/// One telemetry sample (the payload type is the application's, not the middleware's).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Telemetry {
    /// Sample index.
    seq: u64,
    /// Barometric altitude, millimetres.
    altitude_mm: i32,
    /// Battery, milli-volt.
    battery_mv: u32,
}

/// The profile this aircraft runs — the whole machine, as data.
const DRONE: Platform = Platform::drone();
/// Suffix of the aircraft's peer id.
const UAV: &str = "uav-01";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("case ④ uav mission — a multirotor on the same OS (docs/robot-domains.md)");
    print_platform(&DRONE);

    let metrics = Arc::new(LinkMetrics::new());
    let clock = Arc::new(Clock::host());
    let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
    let node = |id: &str, kind: NodeKind| -> Result<Arc<LinkNode>, amos_link::LinkError> {
        Ok(Arc::new(LinkNode::with_parts(
            PeerId::new(id)?,
            kind,
            Arc::clone(&transport),
            Arc::clone(&clock),
            Arc::clone(&metrics),
        )))
    };
    let uav = node(UAV, NodeKind::Robot)?;
    let gcs = node("ground-station", NodeKind::Brain)?;
    let uav_fed = uav.spawn_federation(Duration::from_millis(250))?;
    let gcs_fed = gcs.spawn_federation(Duration::from_millis(250))?;

    // ── the aircraft's control loop: the profile's vocabulary, the shipping safety core ──
    let control = Subscriber::<AgentAction>::subscribe(
        Arc::clone(&transport),
        Topic::pattern(format!("amos/{UAV}/control/*"))?,
        Qos::control(),
        Arc::clone(&metrics),
    )
    .await?;
    let mut bridge = RobotBridge::for_platform(control, MockRobotHal::new(), &DRONE)?
        .reporting(uav.publisher::<ActuationState>(actuation_topic(uav.peer())?));
    println!(
        "control loop: vocabulary={} deadman={:?} failsafe={}",
        bridge.platform_label(),
        bridge.watchdog(),
        DRONE.envelope().failsafe.key()
    );

    // ── the ground station: commands out, mode back, telemetry watched ─────────────
    let commands =
        gcs.publisher::<AgentAction>(Topic::channel_topic(UAV, Channel::Control, "action")?);
    let mut modes = Subscriber::<ActuationState>::subscribe(
        Arc::clone(&transport),
        actuation_pattern()?,
        Qos::for_channel(Channel::State),
        Arc::clone(&metrics),
    )
    .await?;
    let mut telemetry = Subscriber::<Telemetry>::subscribe(
        Arc::clone(&transport),
        Topic::pattern("amos/*/sensor/telemetry")?,
        Qos::sensor(),
        Arc::clone(&metrics),
    )
    .await?;
    let telemetry_out = uav.publisher::<Telemetry>(uav.topic(Channel::Sensor, "telemetry")?);

    // ── 1. nothing moves on a disarmed aircraft ────────────────────────────────────
    command(&commands, r#"{"action":"takeoff"}"#).await?;
    read_step(&mut bridge, &mut modes).await?;

    // ── 2. arm, and take off ───────────────────────────────────────────────────────
    command(&commands, r#"{"action":"arm"}"#).await?;
    read_step(&mut bridge, &mut modes).await?;
    // The profile's thrust is its own pose, not a multiple of it: an explicit `speed` here would
    // be refused (`takeoff` has a fixed pose), so the case does not send one.
    command(&commands, r#"{"action":"takeoff"}"#).await?;
    read_step(&mut bridge, &mut modes).await?;

    // ── 3. a waypoint inside the fence is accepted … ───────────────────────────────
    command(
        &commands,
        r#"{"action":"goto","params":{"north_mm":120000,"east_mm":-40000,"altitude_mm":35000}}"#,
    )
    .await?;
    read_step(&mut bridge, &mut modes).await?;

    // ── 4. … and one outside it is refused, naming the limit ───────────────────────
    command(
        &commands,
        r#"{"action":"goto","params":{"north_mm":420000,"altitude_mm":35000}}"#,
    )
    .await?;
    read_step(&mut bridge, &mut modes).await?;

    // ── 5. telemetry keeps arriving at its own rate (latest-wins: stale is worse than none) ──
    let mut rates = RateTracker::new();
    for seq in 1..=6u64 {
        telemetry_out
            .publish(&Telemetry {
                seq,
                altitude_mm: 30_000 + seq as i32 * 500,
                battery_mv: 22_000 - seq as u32 * 20,
            })
            .await?;
        tokio::time::sleep(Duration::from_millis(60)).await;
        if let Some(sample) = telemetry.try_recv()? {
            rates.observe_received(&sample, Instant::now());
        }
    }
    let topic = uav.topic(Channel::Sensor, "telemetry")?;
    match rates.rate(uav.peer(), &topic) {
        Some(reading) => println!(
            "ground station <- telemetry frames={} span={} {} bytes={} (dropped {})",
            reading.frames,
            reading
                .span
                .map(|s| format!("{:.2}s", s.as_secs_f64()))
                .unwrap_or_else(|| "-".to_string()),
            match reading.rate_hz {
                Some(rate) => format!("rate={rate:.1}Hz"),
                // The reason, never a `0 Hz` that would read as "the aircraft stopped publishing".
                None => format!(
                    "rate=unknown({})",
                    reading
                        .evidence()
                        .map(|e| e.detail())
                        .unwrap_or_else(|| "no evidence".to_string())
                ),
            },
            reading.bytes,
            telemetry.stats().dropped
        ),
        None => println!("ground station <- telemetry: no sample was observed"),
    }

    // ── 6. the link is lost: the deadman stops the aircraft, and the mission layer flies RTL ──
    println!("…the ground station stops talking (link presumed lost)");
    read_step(&mut bridge, &mut modes).await?;
    let failsafe = DRONE.envelope().failsafe;
    println!(
        "profile {}: failsafe={} — a torque cut is not a landing, so the *mission layer* flies it",
        DRONE.kind().key(),
        failsafe.key()
    );
    let rtl = DRONE.plan(&DRONE.parse_intent(r#"{"action":"rtl"}"#)?)?;
    let applied = bridge.hal().apply(&rtl).await?;
    println!("mission layer: rtl wrote {applied} frame(s) through the same HAL");
    if let Some(frame) = rtl.first() {
        println!(
            "  first frame: joint={} op={:?} arg={} crc16={}",
            frame.joint.index(),
            frame.op,
            frame.arg,
            &frame.encode_hex()[16..]
        );
    }

    // ── the mission's books ────────────────────────────────────────────────────────
    let counts = metrics.snapshot();
    println!(
        "counters: published={} delivered={} dropped={} blocked={} decode_errors={}",
        counts.published, counts.delivered, counts.dropped, counts.blocked, counts.decode_errors
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = gcs.status().await;
    let peers: Vec<&str> = status.peers.iter().map(|p| p.id().as_str()).collect();
    println!(
        "peer table of the ground station: {peers:?} ({} self-echo(es) filtered)",
        uav_fed.self_echoes() + gcs_fed.self_echoes()
    );
    println!(
        "health: {} — {}",
        status.health.summary(),
        if status.clock_synced {
            "latencies are measured"
        } else {
            "latencies are bounds until amos-timesync calibrates the clock"
        }
    );
    uav_fed.stop().await;
    gcs_fed.stop().await;
    Ok(())
}

/// The machine's own statement about itself: actuators, vocabulary, deadman, manoeuvre.
///
/// Printed by the case (not by the middleware) so a reader can diff it against
/// docs/robot-domains.md and see the case's contract instead of assuming it.
fn print_platform(platform: &Platform) {
    println!(
        "platform {} · failsafe={} · deadman={:?}",
        platform.kind().key(),
        platform.envelope().failsafe.key(),
        platform.envelope().watchdog
    );
    for actuator in platform.actuators() {
        println!(
            "  actuator {:>2} {:<12} {:<12} {:<9} travel {}..={}",
            actuator.index,
            actuator.name,
            actuator.role.key(),
            actuator.unit.key(),
            actuator.travel.0,
            actuator.travel.1
        );
    }
    for action in platform.actions() {
        println!(
            "  action   {:<9} {:<7} params={:?}",
            action.key,
            action.class.key(),
            action
                .params
                .iter()
                .map(|p| format!("{} {}..={}", p.name, p.range.0, p.range.1))
                .collect::<Vec<_>>()
        );
    }
}

/// One motion command from the ground station, with the publisher's own report printed.
async fn command(
    commands: &Publisher<AgentAction>,
    json: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let report = commands.publish(&AgentAction::new(json)).await?;
    println!(
        "gcs -> {json}  [matched={} delivered={}]",
        report
            .matched
            .map(|n| n.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        report.delivered
    );
    Ok(())
}

/// One step of the aircraft's control loop, plus what the ground station read back.
async fn read_step(
    bridge: &mut RobotBridge<MockRobotHal>,
    modes: &mut Subscriber<ActuationState>,
) -> Result<(), Box<dyn std::error::Error>> {
    let event = bridge.step().await?;
    match &event {
        BridgeEvent::Applied { seq, frames, .. } => {
            println!("uav-01: applied #{seq}, {frames} frame(s) on the bus")
        }
        BridgeEvent::Refused { seq, reason } => println!("uav-01: refused #{seq}: {reason}"),
        BridgeEvent::Estopped { reason, frames } => println!(
            "uav-01: stopped ({}) — {frames} frame(s) the bus accepted",
            reason.key()
        ),
    }
    if let Some(seen) = modes.try_recv()? {
        println!("gcs <- mode: {}", render_mode(&seen));
    }
    Ok(())
}

/// The mode as the ground station reads it off the shared return path.
fn render_mode(seen: &Received<ActuationState>) -> String {
    let state = &seen.message;
    format!(
        "robot={} armed={} estopped={}{} watchdog={} frames={} last_refusal={}",
        seen.publisher,
        state.armed,
        state.estopped,
        state
            .estop_reason
            .map(|r| format!("({})", r.key()))
            .unwrap_or_default(),
        state
            .watchdog_ms
            .map(|ms| format!("{ms}ms"))
            .unwrap_or_else(|| "-".to_string()),
        state.frames,
        state
            .last_refusal
            .as_ref()
            .map(|r| format!("#{} {}", r.seq, r.reason))
            .unwrap_or_else(|| "-".to_string()),
    )
}
