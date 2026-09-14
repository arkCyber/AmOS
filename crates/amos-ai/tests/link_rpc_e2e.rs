//! End-to-end: the AmOS-Link control plane as mounted by the daemon (`amos-ai`).
//!
//! A service that is *defined* but never mounted is invisible to every gate — this test
//! is the proof that `serve()` really `add_service`s it on the shared Unix Domain Socket
//! (the same shape as `rpc_test.rs`'s sensor/telephony checks).

use std::path::PathBuf;

use amos_proto::amos_link::robot_link_client::RobotLinkClient;
use tokio::net::UnixStream;
use tonic::transport::{Channel, Endpoint, Uri};
use tower::service_fn;

/// Wait until the daemon has created and bound the socket.
async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..100 {
        if path.exists() && UnixStream::connect(path).await.is_ok() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("socket {path:?} never became connectable");
}

/// Mount the daemon on a private socket and return `(server task, link client)`.
///
/// Both tests below need the same bring-up: the real `serve()` (which mounts every
/// service) plus a *second* raw channel on the same socket for the link client.
async fn mount(path: &std::path::Path) -> (tokio::task::JoinHandle<()>, RobotLinkClient<Channel>) {
    let _ = std::fs::remove_file(path);
    let server_path = path.to_path_buf();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(path).await;

    let owned = path.to_path_buf();
    let endpoint = Endpoint::try_from("http://[::1]:50051").expect("endpoint");
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .expect("connect channel");
    (server, RobotLinkClient::new(channel))
}

/// A private socket path, so two tests can run without racing each other.
fn socket(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("amos-link-{name}-{}.sock", std::process::id()))
}

#[tokio::test(flavor = "multi_thread")]
async fn link_control_plane_is_mounted_on_the_daemon_socket() {
    // The robot middleware's control plane must answer on the SAME UDS as every other
    // daemon service (docs/amos-link.md): the CLI (`--socket`), external tooling, and the
    // System UI's link panel (`amos-tauri::link::link_status`) read it — and a service that
    // is defined but not mounted is exactly the kind of "documented but absent" defect this
    // repo's audit rounds hunt.
    let path = socket("mounted");
    let (server, mut link) = mount(&path).await;

    let status = link
        .get_status(amos_proto::amos_link::Empty {})
        .await
        .expect("GetStatus answers on the daemon UDS")
        .into_inner();
    assert_eq!(
        status.peer, "amos-daemon",
        "the daemon's demo node identity"
    );
    assert_eq!(status.kind, "tool");
    assert_eq!(status.version, amos_link::VERSION);
    assert!(status.metrics.is_some(), "counters are always reported");
    assert!(
        !status.clock_synced,
        "the mounted node uses the host clock until timesync calibrates it"
    );

    // The inventory grows with traffic. (It also carries the node's *own* heartbeat topic
    // once the beat below has fired — a node that reports its own liveness is the point,
    // and `the_daemon_link_node_beats…` pins that half.)
    let before = link
        .list_topics(amos_proto::amos_link::Empty {})
        .await
        .expect("ListTopics")
        .into_inner();

    let reply = link
        .publish(amos_proto::amos_link::PublishRequest {
            topic: "amos/dog1/control/joints".to_string(),
            payload: vec![0, 1, 2, 3],
        })
        .await
        .expect("Publish")
        .into_inner();
    assert_eq!(reply.seq, 1);
    assert_eq!(
        reply.matched, 0,
        "no subscriber is attached to the daemon's broker"
    );

    let after = link
        .list_topics(amos_proto::amos_link::Empty {})
        .await
        .expect("ListTopics #2")
        .into_inner();
    assert!(
        after
            .topics
            .contains(&"amos/dog1/control/joints".to_string()),
        "the injected frame's topic is in the inventory: {:?}",
        after.topics
    );
    assert!(
        after.topics.len() > before.topics.len(),
        "the inventory only grows: {:?} -> {:?}",
        before.topics,
        after.topics
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_link_node_beats_so_the_heartbeat_stream_is_not_silent() {
    // `proto/robot_link.proto` and docs/amos-link.md §5 both promise that
    // `StreamHeartbeats` carries **every** peer's beat *including this node's* — the
    // daemon's own liveness. The daemon mounted a node nobody had started a heartbeat
    // for, so this stream was one that could never yield a single message: the "is the
    // bus alive?" question answered with a silence indistinguishable from a healthy quiet
    // link. The bounded wait IS the assertion — a beat must actually arrive.
    let path = socket("beats");
    let (server, mut link) = mount(&path).await;

    let mut beats = link
        .stream_heartbeats(amos_proto::amos_link::Empty {})
        .await
        .expect("StreamHeartbeats opens")
        .into_inner();

    let beat = tokio::time::timeout(std::time::Duration::from_secs(5), beats.message())
        .await
        .expect("the daemon must publish its own heartbeat (the stream is not silent)")
        .expect("the stream is healthy")
        .expect("a heartbeat");
    assert_eq!(
        beat.peer, "amos-daemon",
        "this node beats, not a synthetic peer"
    );
    assert!(beat.seq >= 1, "beats are numbered from 1: {}", beat.seq);
    assert!(
        beat.stamp_nanos < 1_000_000_000,
        "the stamp is a real wall clock: {}.{}",
        beat.stamp_secs,
        beat.stamp_nanos
    );

    // Now that a beat really was published, the inventory proves it happened on the
    // broker — causal, not sleep-and-hope.
    let topics = link
        .list_topics(amos_proto::amos_link::Empty {})
        .await
        .expect("ListTopics")
        .into_inner();
    assert!(
        topics
            .topics
            .contains(&"amos/amos-daemon/telemetry/beat".to_string()),
        "the beat topic is in the inventory: {:?}",
        topics.topics
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}
