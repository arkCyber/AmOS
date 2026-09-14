//! Headless e2e for the System UI's robot-link bridge: mount the daemon's **real**
//! AmOS-Link control plane (`amos_link::service::mock_server`) on a UDS, point the
//! bridge at it through `AMOS_SOCKET`, then call the **actual command body**
//! `link::link_status()` — no Tauri app, no WebView (mirrors `translate_command_e2e`).
//!
//! What this pins that the unit tests cannot:
//! * the wire → `LinkStatusOut` mapping over a real socket (the daemon side is already
//!   covered by `amos-ai/tests/link_rpc_e2e.rs`; this is the *client* half);
//! * the failure mode that would silently blank the panel — the serialized JSON must use
//!   exactly the snake_case keys `frontend-ts/src/lib/link.ts` declares
//!   (`clock_synced`, `health_reasons`, `last_seen_ms`, `decode_errors`, …). A rename on
//!   either side leaves the UI reading `undefined` with no error anywhere;
//! * the **return path**: a robot's `RobotBridge` report travels the data plane, the daemon
//!   folds it, and `link_status` hands it to the panel — so the UI can show what a robot is
//!   *doing*, which is what the `ListActuations` RPC was added for.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use amos_link::broker::Broker;
use amos_link::codec::Clock;
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::qos::Qos;
use amos_link::robot_hal::{
    actuation_topic, ActuationState, AgentAction, MockRobotHal, RobotBridge,
};
use amos_link::service::LinkService;
use amos_proto::amos_link::robot_link_server::RobotLinkServer;
use amos_tauri_lib::link::link_status;
use tokio_stream::wrappers::UnixListenerStream;

/// `AMOS_SOCKET` is **process-global**, so the two scenarios below must not interleave: one
/// would talk to the other's socket. Tests in one binary run in parallel by default, hence an
/// explicit (async) lock rather than a hopeful `sleep`.
fn env_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Serve the daemon's control plane (its own heartbeat included) on a private UDS.
async fn spawn_link_control_plane(path: &PathBuf) -> tokio::task::JoinHandle<()> {
    let listener = tokio::net::UnixListener::bind(path).expect("bind the uds");
    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(amos_link::service::mock_server())
            .serve_with_incoming(UnixListenerStream::new(listener))
            .await
            .expect("the control plane served");
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn link_status_reads_a_real_control_plane_and_serializes_the_ui_contract() {
    let _guard = env_lock().lock().await;
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-tauri-link-e2e-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    // `daemon::channel()` resolves the daemon socket from here (the same variable the
    // product uses), so this is the real UDS path, not a stub.
    std::env::set_var("AMOS_SOCKET", &path);

    let server = spawn_link_control_plane(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    let status = link_status()
        .await
        .expect("link_status answers over a real control plane");
    assert_eq!(status.peer, "amos-daemon");
    assert!(!status.kind.is_empty(), "the daemon reports its kind");
    assert!(
        ["unknown", "healthy", "degraded"].contains(&status.health.as_str()),
        "the verdict must be one the UI can render, got {:?}",
        status.health
    );
    // A freshly mounted node has no peers, and a clean in-process link has dropped
    // nothing and failed to decode nothing — real zeros, never invented readings.
    assert!(status.peers.is_empty(), "a fresh node has no peers");
    assert_eq!(status.metrics.dropped, 0);
    assert_eq!(status.metrics.decode_errors, 0);
    // Nobody has reported an actuation: an empty list, not an invented idle robot.
    assert!(
        status.actuations.is_empty(),
        "an unreported fleet stays absent"
    );

    // The exact key set `lib/link.ts`'s `LinkStatus` interface promises.
    let json = serde_json::to_value(&status).expect("serialize the snapshot");
    let obj = json.as_object().expect("a JSON object");
    let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "actuations",
            "clock_synced",
            "health",
            "health_reasons",
            "kind",
            "metrics",
            "peer",
            "peers",
            "uptime_ms",
            "version",
        ],
        "the bridge's JSON keys are the UI's contract"
    );
    let metrics = obj["metrics"].as_object().expect("a metrics object");
    let mut mkeys: Vec<&str> = metrics.keys().map(|k| k.as_str()).collect();
    mkeys.sort_unstable();
    assert_eq!(
        mkeys,
        vec![
            "blocked",
            "decode_errors",
            "delivered",
            "dropped",
            "encode_errors",
            "published",
        ],
        "the metrics' JSON keys are the UI's contract"
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}

/// The **return path**, end to end, as the Settings panel sees it: a robot's `RobotBridge`
/// reports its mode on `amos/dog1/state/actuation`, the daemon's control plane folds it in,
/// and `link_status` (the command the panel calls) hands it back with the link status.
///
/// This is the piece that turns "the robot exists" into "the robot is trotting / has cut
/// torque / refused my last command".
#[tokio::test(flavor = "multi_thread")]
async fn link_status_carries_the_robots_own_actuation_reports() {
    let _guard = env_lock().lock().await;
    let path: PathBuf = std::env::temp_dir().join(format!(
        "amos-tauri-link-robots-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::env::set_var("AMOS_SOCKET", &path);

    // One link, two nodes: the daemon that mounts the control plane (and watches the return
    // path), and the robot whose bridge reports.
    let metrics = Arc::new(LinkMetrics::new());
    let clock = Arc::new(Clock::host());
    let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
    let daemon = LinkNode::with_parts(
        PeerId::new("amos-daemon").expect("peer"),
        NodeKind::Tool,
        Arc::clone(&transport),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    );
    let robot = LinkNode::with_parts(
        PeerId::new("dog1").expect("peer"),
        NodeKind::Robot,
        Arc::clone(&transport),
        Arc::clone(&clock),
        Arc::clone(&metrics),
    );

    let dog1 = PeerId::new("dog1").expect("peer");
    let control = robot
        .subscriber::<AgentAction>(
            Topic::pattern("amos/dog1/control/*").expect("pattern"),
            Qos::control(),
        )
        .await
        .expect("subscribe control");
    let mut bridge = RobotBridge::new(control, MockRobotHal::new())
        .reporting(robot.publisher::<ActuationState>(actuation_topic(&dog1).expect("topic")))
        // Short refresh: the daemon's watcher subscribes asynchronously, and the bridge
        // re-announces an unchanged mode for exactly this reason.
        .with_report_refresh(Duration::from_millis(20));
    let commander = robot.publisher::<AgentAction>(
        Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
    );

    let socket = path.clone();
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(RobotLinkServer::new(LinkService::with_heartbeat(Arc::new(
                daemon,
            ))))
            .serve_with_incoming(UnixListenerStream::new(
                tokio::net::UnixListener::bind(socket).expect("bind uds"),
            ))
            .await
            .expect("the control plane served");
    });
    tokio::time::sleep(Duration::from_millis(200)).await;

    // ── drive the robot until the panel's command can see it ─────────────────────────
    let mut trotting = None;
    for _ in 0..60 {
        commander
            .publish(&AgentAction::new(r#"{"action":"trot","speed":0.5}"#))
            .await
            .expect("publish trot");
        bridge.step().await.expect("step");
        tokio::time::sleep(Duration::from_millis(30)).await;
        let status = link_status().await.expect("link_status");
        if let Some(found) = status.actuations.into_iter().find(|a| a.robot == "dog1") {
            trotting = Some(found);
            break;
        }
    }
    let trotting = trotting.expect("the panel can see what the robot reports");
    assert_eq!(trotting.gait.as_deref(), Some("trot"));
    assert!(trotting.armed, "the drivers are energized");
    assert!(!trotting.estopped);
    assert!(trotting.seq.is_some(), "the report names the action");
    assert!(trotting.frames > 0);
    assert!(trotting.stamp_ms > 0, "the robot's own publish time");
    assert_eq!(trotting.watchdog_ms, None, "no deadman was configured");
    assert_eq!(trotting.estop_reason, None);
    assert_eq!(trotting.last_refusal, None);

    // ── the e-stop and the refusal it causes reach the panel too ────────────────────
    commander
        .publish(&AgentAction::new(r#"{"action":"estop"}"#))
        .await
        .expect("publish estop");
    bridge.step().await.expect("step");
    commander
        .publish(&AgentAction::new(r#"{"action":"trot"}"#))
        .await
        .expect("publish a stale trot");
    bridge.step().await.expect("step");

    let mut stopped = None;
    for _ in 0..20 {
        let status = link_status().await.expect("link_status");
        let robot = status.actuations.into_iter().find(|a| a.robot == "dog1");
        if robot.as_ref().is_some_and(|a| a.last_refusal.is_some()) {
            stopped = robot;
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let stopped = stopped.expect("the refusal reaches the panel");
    assert!(stopped.estopped, "the panel knows torque was cut");
    assert_eq!(stopped.estop_reason.as_deref(), Some("commanded"));
    assert!(!stopped.armed);
    assert_eq!(stopped.gait.as_deref(), Some("estop"));
    let refusal = stopped.last_refusal.expect("a refusal travels");
    assert!(refusal.seq > 0);
    assert!(
        refusal.reason.contains("re-arm"),
        "the panel can tell the user how to recover: {}",
        refusal.reason
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}
