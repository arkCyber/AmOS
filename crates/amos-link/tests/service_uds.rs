//! End-to-end: the link's own control plane over a real Unix Domain Socket.
//!
//! The unit tests cover every part in isolation; this is the integration that a
//! *deployment* depends on — a tonic server mounted on a UDS, a real client on the
//! other side, and the four RPCs of `proto/robot_link.proto` answering from a live
//! [`LinkNode`]. It mirrors `crates/amos-ai/tests/rpc_test.rs` (the daemon's other
//! services), so the link plane is proven the same way the sensor/telephony ones are.

use std::path::PathBuf;
use std::sync::Arc;

use amos_link::broker::Broker;
use amos_link::codec::Clock;
use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::metrics::LinkMetrics;
use amos_link::node::LinkNode;
use amos_link::robot_hal::{
    actuation_topic, ActuationState, AgentAction, MockRobotHal, RobotBridge,
};
use amos_link::service::{self, LinkService};
use amos_link::telemetry::Heartbeat;
use amos_proto::amos_link::robot_link_client::RobotLinkClient;
use amos_proto::amos_link::robot_link_server::RobotLinkServer;
use amos_proto::amos_link::Empty;
use tokio::net::UnixStream;
use tokio_stream::StreamExt;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

/// Wait until the server has created and bound the socket.
async fn wait_for_socket(path: &PathBuf) {
    for _ in 0..200 {
        if path.exists() && UnixStream::connect(path).await.is_ok() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("socket {path:?} never became connectable");
}

#[tokio::test]
async fn control_plane_answers_over_a_unix_domain_socket() {
    let path: PathBuf = std::env::temp_dir().join(format!(
        "amos-link-{}-{}.sock",
        std::process::id(),
        // A unique suffix per test run keeps parallel runs from clashing.
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_file(&path);
    let socket = path.clone();
    let peer = PeerId::new("dog1").expect("peer");
    let node = LinkNode::in_process(peer.clone(), NodeKind::Robot);

    // One heartbeat on the link, so the streaming RPC has something to carry.
    let beat = node.heartbeat();
    assert_eq!(beat.seq, 1);
    assert_eq!(beat.peer.as_str(), "dog1");

    let server_node = Arc::clone(&node);
    let server_path = socket.clone();
    // The other peer that will beat on the same link (its own id, its own topic).
    let dog2 = PeerId::new("dog2").expect("peer");
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(service::server(server_node))
            .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(
                tokio::net::UnixListener::bind(server_path).expect("bind uds"),
            ))
            .await
    });
    wait_for_socket(&socket).await;

    let owned = socket.clone();
    let channel = Endpoint::try_from("http://[::1]:50051")
        .expect("endpoint")
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .expect("connect the channel");
    let mut client = RobotLinkClient::new(channel);

    // 1. GetStatus: identity, role, version, counters, and the (empty) peer table.
    let status = client
        .get_status(Empty {})
        .await
        .expect("get_status")
        .into_inner();
    assert_eq!(status.peer, "dog1");
    assert_eq!(status.kind, "robot");
    assert_eq!(status.version, amos_link::VERSION);
    assert!(
        !status.clock_synced,
        "the in-process node uses the host clock"
    );
    let metrics = status.metrics.expect("metrics are always present");
    assert_eq!(metrics.peers, 0, "no beacon has been observed");
    assert_eq!(
        status.health,
        amos_proto::amos_link::HealthState::HealthUnknown as i32,
        "nothing has been published or seen: no verdict may be invented"
    );
    assert!(
        status.health_reasons.is_empty(),
        "and no reason can be claimed: {:?}",
        status.health_reasons
    );
    assert_eq!(
        metrics.encode_errors, 0,
        "the counters travel on the wire, not just in the JSON status"
    );
    assert_eq!(
        metrics.blocked, 0,
        "nothing waited: there is no reliable subscriber here"
    );

    // 2. Publish: the daemon stamps the frame and reports the fan-out.
    let reply = client
        .publish(amos_proto::amos_link::PublishRequest {
            topic: "amos/dog1/control/joints".to_string(),
            payload: vec![1, 2, 3],
        })
        .await
        .expect("publish")
        .into_inner();
    assert_eq!(reply.seq, 1);
    assert_eq!(reply.delivered, 0, "no subscriber is attached");

    // The topic inventory now knows the topic (the broker records publishes).
    let topics = client
        .list_topics(Empty {})
        .await
        .expect("list_topics")
        .into_inner();
    assert_eq!(topics.topics, vec!["amos/dog1/control/joints".to_string()]);
    // The list arrives with its own limit: the caller is *not* on this node's transport, so
    // `complete` is the only way it can tell "these are all the topics" from "this is what the
    // node happened to see, and its inventory may have stopped growing".
    assert!(
        topics.complete,
        "a fresh broker that has not hit its ceiling is the whole truth"
    );

    // …and the node now has evidence, so its verdict stops being `UNKNOWN` and names why:
    // no peer has beaconed on this link, and the clock was never calibrated.
    let status = client
        .get_status(Empty {})
        .await
        .expect("get_status")
        .into_inner();
    assert_eq!(
        status.health,
        amos_proto::amos_link::HealthState::HealthDegraded as i32,
        "a published frame is evidence, and this link has two caveats"
    );
    assert_eq!(
        status.health_reasons,
        vec!["no_peers".to_string(), "clock_unsynced".to_string()],
        "the verdict carries its reasons, not just a label"
    );

    // 3. A refused topic is an InvalidArgument, not an Internal error.
    let err = client
        .publish(amos_proto::amos_link::PublishRequest {
            topic: "amos//bad".to_string(),
            payload: vec![],
        })
        .await
        .expect_err("invalid topic refused");
    assert_eq!(err.code(), tonic::Code::InvalidArgument);

    // 4. StreamHeartbeats: the RPC carries the beats the node publishes (not a
    //    synthetic counter). Publishing happens from a task because the node is busy
    //    being the server.
    let mut stream = client
        .stream_heartbeats(Empty {})
        .await
        .expect("stream_heartbeats")
        .into_inner();
    let beater = {
        let node = Arc::clone(&node);
        tokio::spawn(async move {
            let topic = Topic::channel_topic("dog1", Channel::Telemetry, "beat").expect("topic");
            let publisher = node.publisher::<Heartbeat>(topic);
            let _ = publisher.publish(&node.heartbeat()).await;
        })
    };
    let received = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
        .await
        .expect("a heartbeat arrives")
        .expect("the stream yields an item")
        .expect("the item is Ok");
    assert_eq!(received.peer, "dog1");
    assert!(received.seq >= 1);
    assert!(received.stamp_secs > 0);
    beater.await.expect("beater task");

    // 5. …and it is the **link's** liveness view, not this node's own counter: a beat from
    //    another peer (a different peer id, on its own topic) travels the same stream.
    let peer_beater = {
        let node = Arc::clone(&node);
        tokio::spawn(async move {
            let topic = Topic::channel_topic("dog2", Channel::Telemetry, "beat").expect("topic");
            let publisher = amos_link::pubsub::Publisher::<Heartbeat>::new(
                Arc::clone(node.transport()),
                topic,
                dog2.clone(),
                Arc::new(amos_link::codec::Clock::host()),
                Arc::new(amos_link::metrics::LinkMetrics::new()),
            );
            let beat = Heartbeat::new(dog2.clone(), 7, amos_link::codec::Timestamp::now(), 42);
            let _ = publisher.publish(&beat).await;
        })
    };
    let peer_beat = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
        .await
        .expect("a peer's heartbeat arrives")
        .expect("the stream yields an item")
        .expect("the item is Ok");
    assert_eq!(
        peer_beat.peer, "dog2",
        "another peer's beat is streamed too"
    );
    assert_eq!(peer_beat.seq, 7);
    assert_eq!(peer_beat.uptime_ms, 42);
    peer_beater.await.expect("peer beater task");

    // 6. A beat whose **payload** names a peer other than the frame's publisher never reaches
    //    a client. The stream *is* the answer to "which robots are alive", so a frame carrying
    //    two identities would put the payload's claim in front of every operator while the
    //    framing said something else (and the CLI's `watch`, which reads the same beats
    //    locally, would print one identity while counting gaps against the other).
    let decode_errors_before = client
        .get_status(Empty {})
        .await
        .expect("get_status")
        .into_inner()
        .metrics
        .expect("metrics")
        .decode_errors;
    // A fresh binding for the same id: the one above was moved into the step-5 task.
    let dog2 = PeerId::new("dog2").expect("peer");
    let forger = {
        let node = Arc::clone(&node);
        let claimed = dog2.clone();
        tokio::spawn(async move {
            let topic = Topic::channel_topic("dog2", Channel::Telemetry, "beat").expect("topic");
            // The topic is dog2's, the payload claims dog2 — only the *frame* says otherwise.
            let publisher = amos_link::pubsub::Publisher::<Heartbeat>::new(
                Arc::clone(node.transport()),
                topic,
                PeerId::new("impostor").expect("peer"),
                Arc::new(Clock::host()),
                Arc::new(LinkMetrics::new()),
            );
            let beat = Heartbeat::new(claimed, 99, amos_link::codec::Timestamp::now(), 999);
            let _ = publisher.publish(&beat).await;
        })
    };
    forger.await.expect("forger task");

    // The refusal is **counted** first, and only then is an honest beat published: the two
    // facts are ordered, so the latest-wins beat subscription cannot be blamed for the forged
    // frame's absence. `decode_errors` is the same number `GetStatus` has always reported for
    // a frame this node could not accept.
    let mut decode_errors = decode_errors_before;
    for _ in 0..200 {
        decode_errors = client
            .get_status(Empty {})
            .await
            .expect("get_status")
            .into_inner()
            .metrics
            .expect("metrics")
            .decode_errors;
        if decode_errors > decode_errors_before {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        decode_errors > decode_errors_before,
        "the forged beat was refused and counted ({decode_errors_before} ⇒ {decode_errors})"
    );

    // …and the next item the stream yields is the honest beat, not the liar.
    let honest_beater = {
        let node = Arc::clone(&node);
        tokio::spawn(async move {
            let topic = Topic::channel_topic("dog2", Channel::Telemetry, "beat").expect("topic");
            let publisher = amos_link::pubsub::Publisher::<Heartbeat>::new(
                Arc::clone(node.transport()),
                topic,
                dog2.clone(),
                Arc::new(Clock::host()),
                Arc::new(LinkMetrics::new()),
            );
            let beat = Heartbeat::new(dog2.clone(), 8, amos_link::codec::Timestamp::now(), 43);
            let _ = publisher.publish(&beat).await;
        })
    };
    let after = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
        .await
        .expect("the honest beat arrives")
        .expect("the stream yields an item")
        .expect("the item is Ok");
    assert_eq!(after.peer, "dog2");
    assert_eq!(
        after.seq, 8,
        "the forged claim (seq 99) never reached a client"
    );
    assert_eq!(after.uptime_ms, 43, "nor did its uptime");
    honest_beater.await.expect("honest beater task");

    server.abort();
    let _ = std::fs::remove_file(&socket);
}

/// The **full chain** of the control loop's return path, over a real UDS:
/// `RobotBridge` → `amos/dog1/state/actuation` → the daemon's control-plane fold → gRPC.
///
/// This is what lets a caller that is not on the link — the System UI's panel — show what a
/// robot is *doing*, not just that it exists: the reports travel the **data plane**, and the
/// control plane folds them. Two nodes share one broker — the mounted `amos-daemon` (which
/// watches) and `dog1` (which drives a real bridge) — the shape a board and a field server
/// have over Zenoh.
#[tokio::test]
async fn the_control_plane_folds_in_a_robots_actuation_reports() {
    let path: PathBuf = std::env::temp_dir().join(format!(
        "amos-link-actuation-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_file(&path);

    // One link (broker), two nodes on it: the daemon that mounts the control plane, and the
    // robot whose bridge reports.
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

    // The robot's control loop, reporting its mode on its own state topic.
    let dog1 = PeerId::new("dog1").expect("peer");
    let control = robot
        .subscriber::<AgentAction>(
            Topic::pattern("amos/dog1/control/*").expect("pattern"),
            amos_link::qos::Qos::control(),
        )
        .await
        .expect("subscribe control");
    let mut bridge = RobotBridge::new(control, MockRobotHal::new())
        .reporting(robot.publisher::<ActuationState>(actuation_topic(&dog1).expect("topic")))
        // A short refresh: the daemon's watcher subscribes *asynchronously*, so the loop
        // below converges instead of depending on one lucky publish.
        .with_report_refresh(std::time::Duration::from_millis(20));
    let commander = robot.publisher::<AgentAction>(
        Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
    );

    // Mount the control plane on the same UDS the daemon uses, watcher included.
    let socket = path.clone();
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(RobotLinkServer::new(LinkService::with_heartbeat(Arc::new(
                daemon,
            ))))
            .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(
                tokio::net::UnixListener::bind(socket).expect("bind uds"),
            ))
            .await
    });
    wait_for_socket(&path).await;

    let owned = path.clone();
    let channel = Endpoint::try_from("http://[::1]:50051")
        .expect("endpoint")
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .expect("connect the channel");
    let mut client = RobotLinkClient::new(channel);

    // ── nobody has reported yet: the list is empty, never a fabricated zero ──────────
    let list = client
        .list_actuations(Empty {})
        .await
        .expect("list_actuations")
        .into_inner();
    assert!(
        list.robots.is_empty(),
        "an unreported robot is absent, not an invented idle one"
    );

    // ── drive the robot until the control plane has folded a report in ───────────────
    let mut trotting = None;
    for _ in 0..60 {
        commander
            .publish(&AgentAction::new(r#"{"action":"trot","speed":0.5}"#))
            .await
            .expect("publish trot");
        bridge.step().await.expect("step");
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let list = client
            .list_actuations(Empty {})
            .await
            .expect("list_actuations")
            .into_inner();
        if let Some(found) = list.robots.into_iter().find(|r| r.robot == "dog1") {
            trotting = Some(found);
            break;
        }
    }
    let trotting = trotting.expect("the control plane folds in the robot's report");
    assert_eq!(trotting.gait, "trot");
    assert!(trotting.armed, "the drivers are energized");
    assert!(!trotting.estopped);
    assert!(trotting.seq >= 1, "the report names the action it reflects");
    assert!(trotting.frames > 0);
    assert!(trotting.stamp_secs > 0, "the robot's own publish time");
    assert_eq!(trotting.estop_reason, "", "nothing was cut");

    // ── the e-stop, and the refusal that follows it, both reach the control plane ────
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
        let list = client
            .list_actuations(Empty {})
            .await
            .expect("list_actuations")
            .into_inner();
        let robot = list.robots.into_iter().find(|r| r.robot == "dog1");
        if robot.as_ref().is_some_and(|r| !r.last_refusal.is_empty()) {
            stopped = robot;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    let stopped = stopped.expect("the refusal is folded in too");
    assert!(stopped.estopped, "the control plane knows torque was cut");
    assert_eq!(stopped.estop_reason, "commanded");
    assert!(!stopped.armed);
    assert_eq!(stopped.gait, "estop");
    assert!(
        stopped.last_refusal.contains("re-arm"),
        "the refusal says how to recover: {}",
        stopped.last_refusal
    );
    assert!(stopped.last_refusal_seq > 0);

    server.abort();
    let _ = std::fs::remove_file(&path);
}
