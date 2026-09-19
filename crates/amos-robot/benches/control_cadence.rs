//! Control-loop cadence — micro-benchmark.
//!
//! Why a benchmark and not a test: a test that runs `100 Hz` is silent on
//! the lateness distribution across, say, 100 000 ticks. The bench is what
//! the **docs** on `control.rs` claim ("the loop measures its own cadence
//! instead of claiming one") prove real.
//!
//! Run with `cargo bench -p amos-robot --bench control_cadence`.

use std::time::Duration;

use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::Topic;
use amos_link::node::LinkNode;
use amos_link::qos::Qos;
use amos_link::robot_hal::{AgentAction, MockRobotHal, RobotBridge};
use amos_robot::control::ControlLoop;

async fn build_loop(period: Duration) -> ControlLoop<MockRobotHal> {
    let node = LinkNode::in_process(PeerId::new("bench-01").unwrap(), NodeKind::Robot);
    let subscriber = node
        .subscriber::<AgentAction>(
            Topic::pattern("amos/bench-01/control/*").unwrap(),
            Qos::control(),
        )
        .await
        .unwrap();
    static PLATFORM: amos_link::platform::Platform =
        amos_link::platform::Platform::ground_vehicle();
    let bridge = RobotBridge::for_platform(subscriber, MockRobotHal::new(), &PLATFORM).unwrap();
    ControlLoop::new(bridge, period).unwrap()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    // 1 kHz is a stress test (the loop must measure its own lateness, not
    // pretend it doesn't have any).
    let period = Duration::from_millis(1);
    let mut loop_ = build_loop(period).await;
    let ticks = 1_000;
    let start = std::time::Instant::now();
    let _ = loop_.run_ticks(ticks).await;
    let elapsed = start.elapsed();

    let stats = loop_.stats();
    println!("control loop bench:");
    println!("  period: {:?}", period);
    println!("  ticks:  {ticks}");
    println!("  wall:   {:?}", elapsed);
    println!("  {}", stats.summary());
}
