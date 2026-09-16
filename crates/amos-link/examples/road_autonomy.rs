//! `road_autonomy` — domain case ⑤: **a road vehicle, on the same OS**.
//!
//! The second domain case, and the one where the *stopping* semantics differ most: a car has no
//! torque to cut. Its profile says so — `estop` is **full braking**, the throttle is cut, and a
//! lost link owes the vehicle a **minimal-risk manoeuvre**, not a coast:
//!
//! ```text
//!   planner ──{"action":"lane_keep|cruise|slow|arm|estop"}──►  car-01   (100 Hz on the wire)
//!   car-01  ──its mode on amos/car-01/state/actuation───────►  planner  (the shared return path)
//! ```
//!
//! Four things this case pins:
//!
//! 1. **The control stream is a stream, not a request.** `lane_keep` arrives at the profile's own
//!    cadence and the deadman is measured against *that* — ten missed set points on a 100 ms
//!    deadman, not one. The case measures the planner's cadence on its own clock.
//! 2. **The envelope carries the road's limits**: `lane_offset_mm` inside the lane,
//!    `speed_mm_s` under the cap, `decel_mm_s2` inside the comfort/authority envelope. Each is
//!    refused *naming the number*, never clamped (a clamped lane offset is a vehicle in another lane).
//! 3. **The stop is the machine's own**: `estop` on this profile plans full braking plus a
//!    throttle cut, and the deadman uses the same halt batch (see the profile-driven bridge).
//! 4. **A refusal is answerable**: it travels back with the action's sequence and the limit, so a
//!    planner can act on it instead of watching a car that silently ignored it.
//!
//! Usage:
//! ```text
//! cargo run -p amos-link --example road_autonomy
//! ```

use std::sync::Arc;
use std::time::{Duration, Instant};

use amos_link::broker::Broker;
use amos_link::codec::Clock;
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::platform::{Failsafe, Platform};
use amos_link::pubsub::{Publisher, Received, Subscriber};
use amos_link::qos::Qos;
use amos_link::rate::RateTracker;
use amos_link::robot_hal::{
    actuation_pattern, actuation_topic, ActuationState, AgentAction, BridgeEvent, MockRobotHal,
    RobotBridge, RobotHal,
};

/// The profile this vehicle runs — a car's stop is braking, not a torque cut.
const VEHICLE: Platform = Platform::ground_vehicle();
/// The vehicle's peer id.
const CAR: &str = "car-01";
/// The control cadence the planner runs in this case (a product runs 50–100 Hz).
const CADENCE: Duration = Duration::from_millis(50);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("case ⑤ road autonomy — a vehicle on the same OS (docs/robot-domains.md)");
    println!(
        "platform {} · failsafe={} · deadman={:?} · stop={:?} + throttle cut",
        VEHICLE.kind().key(),
        VEHICLE.envelope().failsafe.key(),
        VEHICLE.envelope().watchdog,
        VEHICLE
            .halt_frames()?
            .iter()
            .find(|f| f.arg > 0)
            .map(|f| format!("brake {}", f.arg))
            .unwrap_or_else(|| "no brake".to_string())
    );

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
    let car = node(CAR, NodeKind::Robot)?;
    let planner = node("planner", NodeKind::Brain)?;
    // Both ends announce themselves, so the peer table (and the verdict below) has evidence.
    let car_fed = car.spawn_federation(Duration::from_millis(250))?;
    let planner_fed = planner.spawn_federation(Duration::from_millis(250))?;

    let control = Subscriber::<AgentAction>::subscribe(
        Arc::clone(&transport),
        Topic::pattern(format!("amos/{CAR}/control/*"))?,
        Qos::control(),
        Arc::clone(&metrics),
    )
    .await?;
    let mut bridge = RobotBridge::for_platform(control, MockRobotHal::new(), &VEHICLE)?
        .reporting(car.publisher::<ActuationState>(actuation_topic(car.peer())?));
    let mut modes = Subscriber::<ActuationState>::subscribe(
        Arc::clone(&transport),
        actuation_pattern()?,
        Qos::for_channel(Channel::State),
        Arc::clone(&metrics),
    )
    .await?;
    let commands =
        planner.publisher::<AgentAction>(Topic::channel_topic(CAR, Channel::Control, "action")?);
    println!(
        "control loop: vocabulary={} deadman={:?} (the planner runs at {}ms)",
        bridge.platform_label(),
        bridge.watchdog(),
        CADENCE.as_millis()
    );

    // ── 1. arm (a vehicle does not accept set points while its drives are disarmed) ──
    command(&commands, r#"{"action":"arm"}"#).await?;
    read_step(&mut bridge, &mut modes).await?;

    // ── 2. the automated lane keeping: ten set points at the profile's cadence ────
    let mut cadence = RateTracker::new();
    for _ in 0..12u32 {
        command(
            &commands,
            r#"{"action":"lane_keep","params":{"lane_offset_mm":120}}"#,
        )
        .await?;
        cadence.observe(
            car.peer(),
            &Topic::channel_topic(CAR, Channel::Control, "action")?,
            Instant::now(),
            40,
        );
        read_step(&mut bridge, &mut modes).await?;
        tokio::time::sleep(CADENCE).await;
    }
    let topic = Topic::channel_topic(CAR, Channel::Control, "action")?;
    match cadence.rate(car.peer(), &topic) {
        Some(reading) => println!(
            "planner cadence: frames={} span={} rate={} (its own clock; the wire's rate is the broker's business)",
            reading.frames,
            reading
                .span
                .map(|s| format!("{:.2}s", s.as_secs_f64()))
                .unwrap_or_else(|| "-".to_string()),
            match reading.rate_hz {
                Some(rate) => format!("{rate:.1}Hz"),
                None => format!(
                    "unknown({})",
                    reading
                        .evidence()
                        .map(|e| e.detail())
                        .unwrap_or_else(|| "no evidence".to_string())
                ),
            }
        ),
        None => println!("planner cadence: nothing observed"),
    }

    // ── 3. an out-of-envelope request is refused, naming the limit ────────────────
    command(
        &commands,
        r#"{"action":"lane_keep","params":{"lane_offset_mm":4200}}"#,
    )
    .await?;
    read_step(&mut bridge, &mut modes).await?;
    command(
        &commands,
        r#"{"action":"cruise","params":{"speed_mm_s":40000}}"#,
    )
    .await?;
    read_step(&mut bridge, &mut modes).await?;

    // ── 4. a legal withdrawal and a full stop ─────────────────────────────────────
    command(
        &commands,
        r#"{"action":"slow","params":{"decel_mm_s2":3000}}"#,
    )
    .await?;
    read_step(&mut bridge, &mut modes).await?;
    command(&commands, r#"{"action":"estop"}"#).await?;
    read_step(&mut bridge, &mut modes).await?;

    // ── 5. the planner goes quiet: the deadman brakes the vehicle, and the profile owes it MRM ──
    println!("…the planner stops sending set points (its link to the vehicle is gone)");
    read_step(&mut bridge, &mut modes).await?;
    let failsafe = VEHICLE.envelope().failsafe;
    println!(
        "profile {}: failsafe={} — the vehicle reaches a minimal-risk state, it does not coast",
        VEHICLE.kind().key(),
        failsafe.key()
    );
    if failsafe == Failsafe::MinimalRiskManoeuvre {
        // The manoeuvre the mission layer owns: a controlled decel, then the declared halt.
        let mrm = VEHICLE
            .plan(&VEHICLE.parse_intent(r#"{"action":"slow","params":{"decel_mm_s2":4000}}"#)?)?;
        let decel = bridge.hal().apply(&mrm).await?;
        let stop = VEHICLE.halt_frames()?;
        let halting = bridge.hal().apply(&stop).await?;
        println!(
            "mission layer: decel wrote {decel} frame(s), the halt batch wrote {halting} \
             (brake={}, throttle={})",
            stop.iter()
                .find(|f| f.joint.index() == 2)
                .map(|f| f.arg)
                .unwrap_or(0),
            stop.iter()
                .find(|f| f.joint.index() == 1)
                .map(|f| format!("{:?}", f.op))
                .unwrap_or_else(|| "-".to_string())
        );
    }

    // ── the vehicle's books ───────────────────────────────────────────────────────
    let counts = metrics.snapshot();
    println!(
        "counters: published={} delivered={} dropped={} blocked={} decode_errors={}",
        counts.published, counts.delivered, counts.dropped, counts.blocked, counts.decode_errors
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = planner.status().await;
    let peers: Vec<&str> = status.peers.iter().map(|p| p.id().as_str()).collect();
    println!(
        "peer table of the planner: {peers:?} ({} self-echo(es) filtered)",
        car_fed.self_echoes() + planner_fed.self_echoes()
    );
    println!(
        "health: {} — a 100 ms deadman on a 50 ms cadence tolerates {} missed set points",
        status.health.summary(),
        VEHICLE.envelope().watchdog.as_millis() / CADENCE.as_millis()
    );
    car_fed.stop().await;
    planner_fed.stop().await;
    Ok(())
}

/// One set point from the planner, with the publisher's own report printed.
async fn command(
    commands: &Publisher<AgentAction>,
    json: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let report = commands.publish(&AgentAction::new(json)).await?;
    println!(
        "planner -> {json}  [matched={}]",
        report
            .matched
            .map(|n| n.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    );
    Ok(())
}

/// One step of the vehicle's control loop, plus what the planner read back.
async fn read_step(
    bridge: &mut RobotBridge<MockRobotHal>,
    modes: &mut Subscriber<ActuationState>,
) -> Result<(), Box<dyn std::error::Error>> {
    match bridge.step().await? {
        BridgeEvent::Applied { seq, frames, .. } => {
            println!("car-01: applied #{seq}, {frames} frame(s) on the bus")
        }
        BridgeEvent::Refused { seq, reason } => println!("car-01: refused #{seq}: {reason}"),
        BridgeEvent::Estopped { reason, frames } => println!(
            "car-01: stopped ({}) — {frames} frame(s) the bus accepted",
            reason.key()
        ),
    }
    if let Some(seen) = modes.try_recv()? {
        println!("planner <- mode: {}", render_mode(&seen));
    }
    Ok(())
}

/// The mode as the planner reads it off the shared return path.
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
