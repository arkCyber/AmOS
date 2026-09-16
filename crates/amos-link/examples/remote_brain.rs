//! `remote_brain` — robot application case ③: **a brain that is not on the link**.
//!
//! Cases ① and ② put every participant on the same pub/sub bus. A real deployment also has
//! callers that are *not* on it: a fleet dashboard on a laptop, a Python planner, a CI job, the
//! System UI. They talk to the **control plane** — the five RPCs of `proto/robot_link.proto`,
//! mounted on the daemon's Unix socket (`crates/amos-ai/src/server.rs` does the mounting) — and
//! this case drives that path end to end:
//!
//! ```text
//!   client (not on the link) ──gRPC over a UDS──►  RobotLink control plane
//!                                                    │ GetStatus / ListTopics  (reads)
//!                                                    │ Publish                 (inject)
//!                                                    ▼
//!   patrol-01  ──control channel──► RobotBridge ──► motor frames ──► the bus
//!              ──state channel────► folded by the plane's watcher ──► ListActuations
//! ```
//!
//! What the case pins:
//!
//! 1. **Injection is a real frame, not a special path**: `Publish` takes payload bytes, and the
//!    robot's *typed* subscriber decodes them — because the plane wraps them in the same
//!    `Envelope` (own peer id, own sequence, its clock) that every publisher produces.
//! 2. **The return path reaches a caller that is not on the link**: `ListActuations` shows the
//!    robot's self-reported mode, attributed by the **frame's publisher**, not by anything the
//!    payload claims.
//! 3. **A torque cut caused by silence is visible from outside**: the client stops publishing,
//!    the robot's deadman trips, and the *next* `ListActuations` says `estopped=true(watchdog)`
//!    — the failure a remote brain most needs to see, since it is the one it caused.
//! 4. **The inventory travels with its own limit** (`TopicList.complete`): a caller that is not
//!    on that transport can tell "these are all the topics" from "this is what the node saw".
//! 5. **The data plane does not come through here** (§6.5): no depth frame, no joint set point
//!    travels over gRPC — only status, injection and the folded reports do. A dashboard that
//!    wants sensor streams has to be *on* the link (or read a service that is).
//!
//! Usage:
//! ```text
//! cargo run -p amos-link --example remote_brain
//! ```

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use amos_link::codec::{Clock, Message};
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::pubsub::Subscriber;
use amos_link::qos::Qos;
use amos_link::robot_hal::{
    actuation_topic, ActuationState, AgentAction, MockRobotHal, RobotBridge,
};
use amos_link::service::LinkService;
use amos_proto::amos_link::robot_link_client::RobotLinkClient;
use amos_proto::amos_link::robot_link_server::RobotLinkServer;
use amos_proto::amos_link::{Empty, PublishRequest};
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

/// The robot's deadman period: the case has to be short, so this is short too (a product
/// runs 50–100 Hz control with a period of the same order).
const WATCHDOG: Duration = Duration::from_millis(400);
/// The robot answers its control channel at this address, injected through the plane.
const ROBOT: &str = "patrol-01";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("case ③ remote brain — the control plane a caller that is not on the link uses");
    // ── the robot and the daemon-side node, on one in-process link ─────────────────
    let metrics = Arc::new(LinkMetrics::new());
    let clock = Arc::new(Clock::host());
    let node = Arc::new(LinkNode::with_parts(
        PeerId::new(ROBOT)?,
        NodeKind::Robot,
        amos_link::broker::Broker::with_metrics(Arc::clone(&metrics)).shared(),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    ));
    let stop = Arc::new(AtomicBool::new(false));
    let robot = tokio::spawn(run_robot(Arc::clone(&node), Arc::clone(&stop)));

    // ── the control plane, mounted on a UDS exactly as the daemon mounts it ────────
    let socket = socket_path();
    if socket.exists() {
        std::fs::remove_file(&socket)?;
    }
    let service = RobotLinkServer::new(LinkService::with_heartbeat(Arc::clone(&node)));
    // Bind before spawning, so a refused socket surfaces here instead of inside the task.
    let listener = tokio::net::UnixListener::bind(&socket)?;
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(service)
            .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(listener))
            .await
            .map_err(|e| format!("the control plane stopped: {e}"))
    });
    wait_for_socket(&socket).await;
    println!(
        "control plane: {} (gRPC over a Unix domain socket)",
        socket.display()
    );
    let mut client = RobotLinkClient::new(connect(&socket).await?);

    // ── 1. who is behind this socket ───────────────────────────────────────────────
    let status = client.get_status(Empty {}).await?.into_inner();
    let counts = status.metrics.as_ref();
    println!(
        "GetStatus: peer={} kind={} version={} uptime={}ms clock_synced={} health={} peers={}",
        status.peer,
        status.kind,
        status.version,
        status.uptime_ms,
        status.clock_synced,
        health_name(status.health),
        counts.map(|m| m.peers).unwrap_or_default()
    );

    // ── 2. the brain injects an action: payload bytes the *typed* subscriber decodes ──
    let action = AgentAction::new(r#"{"action":"trot","speed":0.5,"duration_ms":600}"#);
    let reply = client
        .publish(PublishRequest {
            topic: control_topic()?,
            payload: action.encode()?,
        })
        .await?
        .into_inner();
    println!(
        "Publish: seq={} matched={} delivered={} dropped={} (a real frame: the robot's \
         AgentAction subscriber decoded it)",
        reply.seq, reply.matched, reply.delivered, reply.dropped
    );

    // ── 3. what the robot did about it — read from *outside* the link ───────────────
    tokio::time::sleep(Duration::from_millis(150)).await;
    report(&mut client, "just after the action").await?;

    // ── 4. the brain falls silent: the deadman trips, and the plane says so ─────────
    println!("…the remote brain stops publishing (its link to the robot is gone)");
    tokio::time::sleep(WATCHDOG + Duration::from_millis(250)).await;
    report(&mut client, "after the deadman period").await?;

    // ── 5. the inventory, with its own limit travelling beside it ──────────────────
    let topics = client.list_topics(Empty {}).await?.into_inner();
    println!(
        "ListTopics: {} topic(s), complete={} (the list tells the caller whether it is the \
         whole truth)",
        topics.topics.len(),
        topics.complete
    );

    // ── honest boundary: what does *not* travel here ───────────────────────────────
    println!(
        "boundary: the data plane (depth frames, joint set points) never crosses this socket \
         — only status, injection and the robots' folded self-reports do (§6.5)"
    );

    // ── shutdown: stop the robot's loop, then the server ───────────────────────────
    stop.store(true, Ordering::Relaxed);
    if tokio::time::timeout(Duration::from_secs(2), robot)
        .await
        .is_err()
    {
        println!("warn: the robot loop did not stop within the grace period");
    }
    server.abort();
    std::fs::remove_file(&socket)?;
    Ok(())
}

/// The robot's control loop, owned by the robot (the plane never drives it directly).
async fn run_robot(node: Arc<LinkNode>, stop: Arc<AtomicBool>) -> Result<(), amos_link::LinkError> {
    let control = Subscriber::<AgentAction>::subscribe(
        Arc::clone(node.transport()),
        Topic::pattern(format!("amos/{ROBOT}/control/*"))?,
        Qos::control(),
        Arc::clone(node.metrics()),
    )
    .await?;
    let mut bridge = RobotBridge::with_watchdog(control, MockRobotHal::new(), WATCHDOG)
        .reporting(node.publisher::<ActuationState>(actuation_topic(node.peer())?));
    while !stop.load(Ordering::Relaxed) {
        if bridge.step().await.is_err() {
            return Ok(());
        }
    }
    Ok(())
}

/// What `ListActuations` says right now — the same call the System UI's link panel makes.
async fn report(
    client: &mut RobotLinkClient<tonic::transport::Channel>,
    when: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let list = client.list_actuations(Empty {}).await?.into_inner();
    if list.robots.is_empty() {
        // `[]` means "answered, and nobody has reported" — never to be read as "all idle".
        println!("ListActuations ({when}): no robot has reported");
        return Ok(());
    }
    for robot in &list.robots {
        println!(
            "ListActuations ({when}): robot={} seq={} gait={} frames={} armed={} estopped={}{} watchdog={}ms last_refusal={}",
            robot.robot,
            robot.seq,
            robot.gait,
            robot.frames,
            robot.armed,
            robot.estopped,
            if robot.estop_reason.is_empty() {
                String::new()
            } else {
                format!("({})", robot.estop_reason)
            },
            robot.watchdog_ms,
            if robot.last_refusal.is_empty() {
                "-".to_string()
            } else {
                format!("#{} {}", robot.last_refusal_seq, robot.last_refusal)
            }
        );
    }
    Ok(())
}

/// The control topic of the robot in this case.
fn control_topic() -> Result<String, amos_link::LinkError> {
    Ok(Topic::channel_topic(ROBOT, Channel::Control, "action")?
        .as_str()
        .to_string())
}

/// A per-run socket path (unique, so parallel runs of the case cannot clash).
fn socket_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "amos-link-remote-brain-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

/// Wait until the server has created and bound the socket.
async fn wait_for_socket(path: &Path) {
    for _ in 0..200 {
        if path.exists() && UnixStream::connect(path).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    println!("warn: the control plane's socket never became connectable");
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

/// The proto enum as a token an operator reads (the plane's own vocabulary).
fn health_name(state: i32) -> &'static str {
    match state {
        1 => "healthy",
        2 => "degraded",
        _ => "unknown",
    }
}
