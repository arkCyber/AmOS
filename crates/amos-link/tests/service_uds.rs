//! End-to-end: the link's own control plane over a real Unix Domain Socket.
//!
//! The unit tests cover every part in isolation; this is the integration that a
//! *deployment* depends on — a tonic server mounted on a UDS, a real client on the
//! other side, and the four RPCs of `proto/robot_link.proto` answering from a live
//! [`LinkNode`]. It mirrors `crates/amos-ai/tests/rpc_test.rs` (the daemon's other
//! services), so the link plane is proven the same way the sensor/telephony ones are.

use std::path::PathBuf;
use std::sync::Arc;

use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::node::LinkNode;
use amos_link::service;
use amos_link::telemetry::Heartbeat;
use amos_proto::amos_link::robot_link_client::RobotLinkClient;
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

    server.abort();
    let _ = std::fs::remove_file(&socket);
}
