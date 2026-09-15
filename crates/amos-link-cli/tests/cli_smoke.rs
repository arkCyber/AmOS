//! End-to-end smoke of the *shipped binary*: `cargo test` builds `amos-link-cli`, and
//! these tests run it exactly as an operator would — argv in, exit code + stdout out.
//!
//! This is deliberately not a unit test of `run()`: the release contract
//! (`scripts/release-artifacts.sh` checks `--version`, a wrapper script checks exit
//! codes) is about the **process**, and only a process-level test proves it.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use amos_proto::amos_link::robot_link_server::RobotLinkServer;

/// Run the built binary and return (exit code, stdout, stderr).
fn run(args: &[&str]) -> (i32, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_amos-link-cli"))
        .args(args)
        .output()
        .expect("the CLI binary runs");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

/// Start the built binary, wait (bounded) for its **first stdout line**, then kill it.
///
/// Returns `(first line, was_still_running, stderr)`. Waiting for a line instead of sleeping
/// a fixed time is what makes this deterministic: the property under test is "the run starts
/// and keeps going", not "it prints within N milliseconds" (a loaded machine would make the
/// latter flaky).
fn run_until_first_line(args: &[&str], wait: Duration) -> (String, bool, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_amos-link-cli"))
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("the CLI binary spawns");
    let stdout = child.stdout.take().expect("piped stdout");
    // A pipe read blocks, so the deadline lives here and the reader lives on its own thread.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        let read = std::io::BufRead::read_line(&mut reader, &mut line);
        let _ = tx.send(match read {
            // `Ok(0)` is EOF (no line at all); an empty line is not a line either.
            Ok(0) | Err(_) => String::new(),
            Ok(_) => line,
        });
    });
    let first = rx.recv_timeout(wait).unwrap_or_default();
    let still_running = child.try_wait().expect("try_wait").is_none();
    let _ = child.kill();
    let _ = child.wait();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr);
    }
    (first, still_running, stderr)
}

/// A live control plane on a private Unix socket: the very service the daemon mounts
/// (`amos_link::service::mock_server`, heartbeat included) served over a real UDS.
///
/// `--socket` is exercised through the shipped binary, so the remote path is proven
/// against real gRPC rather than a stub — the same standard as the rest of this file.
fn start_control_plane() -> (PathBuf, std::thread::JoinHandle<()>) {
    let path = std::env::temp_dir().join(format!(
        "amos-link-cli-remote-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_file(&path);
    let bind = path.clone();
    let handle = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("a tokio runtime");
        let served = runtime.block_on(async move {
            tonic::transport::Server::builder()
                .add_service(amos_link::service::mock_server())
                .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(
                    tokio::net::UnixListener::bind(bind).expect("bind the uds"),
                ))
                .await
        });
        assert!(served.is_ok(), "the control plane served: {served:?}");
    });
    for _ in 0..200 {
        if path.exists() {
            return (path, handle);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the control plane never bound {path:?}");
}

/// A live control plane that **predates `ListActuations`**: it answers `GetStatus` (with a peer
/// in the table) and leaves the return-path RPC unimplemented, which is what an older daemon
/// build does.
///
/// This is the shape `docs/amos-link.md` §6.5 promises a consumer will survive: "老版本的 daemon
/// 没有这个 RPC 时" — the CLI used to fail the whole command here, losing the status, the peer
/// table and the inventory that *were* answered.
struct GetStatusOnly;

#[tonic::async_trait]
impl amos_proto::amos_link::robot_link_server::RobotLink for GetStatusOnly {
    async fn get_status(
        &self,
        _request: tonic::Request<amos_proto::amos_link::Empty>,
    ) -> Result<tonic::Response<amos_proto::amos_link::LinkStatus>, tonic::Status> {
        Ok(tonic::Response::new(amos_proto::amos_link::LinkStatus {
            peer: "amos-daemon".into(),
            kind: "tool".into(),
            version: "0.0.9".into(),
            uptime_ms: 42,
            clock_synced: false,
            metrics: None,
            health: amos_proto::amos_link::HealthState::HealthUnknown as i32,
            health_reasons: vec![],
            peers: vec![amos_proto::amos_link::Peer {
                id: "dog1".into(),
                kind: "robot".into(),
                endpoint: "udp/10.0.0.9:7446".into(),
                last_seen_ms: 12,
                beacons: 3,
            }],
        }))
    }

    async fn list_topics(
        &self,
        _request: tonic::Request<amos_proto::amos_link::Empty>,
    ) -> Result<tonic::Response<amos_proto::amos_link::TopicList>, tonic::Status> {
        Ok(tonic::Response::new(amos_proto::amos_link::TopicList {
            topics: vec!["amos/dog1/control/joints".to_string()],
            complete: true,
        }))
    }

    async fn publish(
        &self,
        _request: tonic::Request<amos_proto::amos_link::PublishRequest>,
    ) -> Result<tonic::Response<amos_proto::amos_link::PublishReply>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "an older daemon has no Publish",
        ))
    }

    type StreamHeartbeatsStream = tokio_stream::wrappers::ReceiverStream<
        Result<amos_proto::amos_link::Heartbeat, tonic::Status>,
    >;

    async fn stream_heartbeats(
        &self,
        _request: tonic::Request<amos_proto::amos_link::Empty>,
    ) -> Result<tonic::Response<Self::StreamHeartbeatsStream>, tonic::Status> {
        Err(tonic::Status::unimplemented("no StreamHeartbeats"))
    }

    async fn list_actuations(
        &self,
        _request: tonic::Request<amos_proto::amos_link::Empty>,
    ) -> Result<tonic::Response<amos_proto::amos_link::ActuationList>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "this daemon predates the return path (no ListActuations)",
        ))
    }
}

/// The same UDS harness as [`start_control_plane`], serving [`GetStatusOnly`].
fn start_older_control_plane() -> (PathBuf, std::thread::JoinHandle<()>) {
    let path = std::env::temp_dir().join(format!(
        "amos-link-cli-older-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_file(&path);
    let bind = path.clone();
    let handle = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("a tokio runtime");
        let served = runtime.block_on(async move {
            tonic::transport::Server::builder()
                .add_service(RobotLinkServer::new(GetStatusOnly))
                .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(
                    tokio::net::UnixListener::bind(bind).expect("bind the uds"),
                ))
                .await
        });
        assert!(served.is_ok(), "the older control plane served: {served:?}");
    });
    for _ in 0..200 {
        if path.exists() {
            return (path, handle);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the older control plane never bound {path:?}");
}

/// A live control plane on a private Unix socket, with **peers already in its table**.
///
/// The seeds are the point: `GetStatus` carries a real peer table (`proto.Peer`: id, kind,
/// endpoint, last_seen_ms, beacons), and a consumer that prints only a *count* is throwing away
/// what the daemon answered. `mock_server()` (the shape the daemon mounts) has an empty table, so
/// this variant builds the node itself and mounts `service::server(node)`.
fn start_control_plane_seeded(
    seeds: &[(&str, &str, Option<&str>)],
) -> (PathBuf, std::thread::JoinHandle<()>) {
    let path = std::env::temp_dir().join(format!(
        "amos-link-cli-seeded-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_file(&path);
    let bind = path.clone();
    let seeds: Vec<(String, String, Option<String>)> = seeds
        .iter()
        .map(|(id, kind, endpoint)| {
            (
                id.to_string(),
                kind.to_string(),
                endpoint.map(str::to_string),
            )
        })
        .collect();
    let handle = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("a tokio runtime");
        let served = runtime.block_on(async move {
            let node = amos_link::LinkNode::in_process(
                amos_link::discovery::PeerId::new("amos-daemon").expect("peer"),
                amos_link::discovery::NodeKind::Tool,
            );
            for (id, kind, endpoint) in seeds {
                let mut info = amos_link::discovery::PeerInfo::new(
                    amos_link::discovery::PeerId::new(id).expect("peer"),
                    amos_link::discovery::NodeKind::from_key(&kind).expect("kind"),
                );
                if let Some(endpoint) = endpoint {
                    info = info.with_endpoint(endpoint);
                }
                node.learn_peer(info).await;
            }
            tonic::transport::Server::builder()
                .add_service(amos_link::service::server(node))
                .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(
                    tokio::net::UnixListener::bind(bind).expect("bind the uds"),
                ))
                .await
        });
        assert!(served.is_ok(), "the control plane served: {served:?}");
    });
    for _ in 0..200 {
        if path.exists() {
            return (path, handle);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the control plane never bound {path:?}");
}

/// A control plane whose table already holds one robot's **self-report**, published by that robot.
///
/// Two nodes over one in-process broker: the robot publishes on `amos/<robot>/state/actuation`
/// (the data plane), the daemon's `LinkService::with_heartbeat` watch folds it into the control
/// plane — `GetStatus`/`ListActuations` then carry it, which is the path the System UI and
/// `status --socket` read. The report is re-published every 50 ms while the test runs, because
/// the watch subscribes asynchronously (no retention on a broker: a report published before the
/// subscription exists is gone) and because a robot that reports once is not a robot that keeps
/// reporting.
fn start_control_plane_reported(
    robot: &str,
    report: amos_link::robot_hal::ActuationState,
) -> (PathBuf, std::thread::JoinHandle<()>) {
    use amos_link::codec::Clock;
    use amos_link::discovery::{NodeKind, PeerId};
    use amos_link::metrics::LinkMetrics;

    let path = std::env::temp_dir().join(format!(
        "amos-link-cli-reported-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_file(&path);
    let bind = path.clone();
    let robot = robot.to_string();
    let handle = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("a tokio runtime");
        let served = runtime.block_on(async move {
            // `Broker::with_metrics(..).shared()` is the shared in-process transport the kernel's
            // own e2e tests use: two nodes, one broker.
            let metrics = std::sync::Arc::new(LinkMetrics::new());
            let clock = std::sync::Arc::new(Clock::host());
            let transport =
                amos_link::broker::Broker::with_metrics(std::sync::Arc::clone(&metrics)).shared();
            let daemon = std::sync::Arc::new(amos_link::LinkNode::with_parts(
                PeerId::new("amos-daemon").expect("peer"),
                NodeKind::Tool,
                std::sync::Arc::clone(&transport),
                std::sync::Arc::clone(&clock),
                std::sync::Arc::clone(&metrics),
            ));
            // The daemon's mounted shape (`mock_server()` builds the same thing for a demo
            // node): `with_heartbeat` starts the heartbeat *and* the actuation watch, which is
            // what folds the robot's reports into `ListActuations`.
            let service =
                amos_link::service::LinkService::with_heartbeat(std::sync::Arc::clone(&daemon));
            let publisher = std::sync::Arc::new(amos_link::LinkNode::with_parts(
                PeerId::new(robot).expect("peer"),
                NodeKind::Robot,
                std::sync::Arc::clone(&transport),
                std::sync::Arc::clone(&clock),
                std::sync::Arc::clone(&metrics),
            ));
            let topic = amos_link::keyexpr::Topic::new(format!(
                "amos/{}/state/actuation",
                publisher.peer()
            ))
            .expect("topic");
            let reporter = publisher.publisher::<amos_link::robot_hal::ActuationState>(topic);
            let beat = tokio::spawn(async move {
                loop {
                    let _ = reporter.publish(&report).await;
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            });
            let served = tonic::transport::Server::builder()
                .add_service(RobotLinkServer::new(service))
                .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(
                    tokio::net::UnixListener::bind(bind).expect("bind the uds"),
                ))
                .await;
            beat.abort();
            served
        });
        assert!(served.is_ok(), "the control plane served: {served:?}");
    });
    for _ in 0..200 {
        if path.exists() {
            return (path, handle);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the control plane never bound {path:?}");
}

#[test]
fn version_and_help_are_self_describing() {
    let (code, stdout, _) = run(&["--version"]);
    assert_eq!(code, 0);
    assert!(
        stdout.starts_with("amos-link-cli "),
        "a released artifact must identify itself, got: {stdout}"
    );

    let (code, stdout, _) = run(&["--help"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("USAGE:"), "got: {stdout}");
    assert!(stdout.contains("--transport"), "got: {stdout}");
}

/// The **return path** is dated when it crosses the socket: the daemon folds a robot's report, and
/// the CLI renders the report *with its age*.
///
/// This is the safety-relevant half of the return path: `armed=true` / `estopped=false` are claims
/// about *right now*, and a report that is an hour old is not evidence of either. The robot's own
/// report travels the data plane here (a second node publishing on `amos/dog1/state/actuation`),
/// the daemon's watch folds it, and both forms of `status --socket` must carry the age — the human
/// line (`age=…`) and the JSON (`age_ms`). The *stale* case (an hour-old stamp) is pinned exactly
/// by the unit test; here the point is that a real report carries a real age end to end.
#[test]
fn the_return_path_is_dated_when_it_crosses_the_socket() {
    use amos_link::robot_hal::{ActuationState, Gait};

    let (path, _server) = start_control_plane_reported(
        "dog1",
        ActuationState {
            seq: Some(7),
            gait: Some(Gait::Trot),
            frames: 13,
            armed: true,
            estopped: false,
            estop_reason: None,
            watchdog_ms: Some(1000),
            last_refusal: None,
        },
    );
    let socket = path.to_string_lossy().to_string();

    // Give the watch a moment to fold the first report (it subscribes asynchronously; the robot
    // keeps reporting, so this is a bounded wait, not a race).
    let mut robot = None;
    for _ in 0..40 {
        let (code, stdout, stderr) = run(&["status", "--socket", &socket, "--json"]);
        assert_eq!(code, 0, "stderr: {stderr}");
        let doc: serde_json::Value = serde_json::from_str(&stdout).expect("one JSON document");
        if let Some(first) = doc["actuations"]
            .as_array()
            .and_then(|robots| robots.first().cloned())
        {
            robot = Some((doc, first));
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let (doc, robot) = robot.expect("the daemon folded the robot's report");
    assert_eq!(robot["robot"], "dog1");
    assert_eq!(robot["armed"], true);
    assert_eq!(robot["gait"], "trot");
    let stamp = robot["stamp_ms"].as_u64().expect("the raw stamp travels");
    let age = robot["age_ms"]
        .as_u64()
        .unwrap_or_else(|| panic!("a fresh report carries an age: {doc}"));
    assert!(age < 10_000, "just folded, so young: {age}ms");
    assert!(stamp > 0, "…and the stamp it was derived from: {stamp}");

    // The human form dates it too — that is the whole point (a terminal without this cannot tell
    // a fresh report from an hour-old one).
    let (code, human, stderr) = run(&["status", "--socket", &socket]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        human.contains("robot=dog1 armed=true"),
        "the report is rendered, got: {human}"
    );
    assert!(human.contains("age="), "…and dated, got: {human}");
    assert!(
        !human.contains("age=unknown"),
        "a report published just now has a usable stamp: {human}"
    );

    let _ = std::fs::remove_file(&path);
}

/// `status --socket` reads the **peer table** the daemon answered with — not just its size.
///
/// `GetStatus` returns `repeated Peer peers` (id, kind, endpoint, last_seen_ms, beacons) and the
/// System UI maps every field; the CLI printed `peers={count}` and put that count under the `peers`
/// key of its JSON, so the terminal — the tool an operator uses to find out *who* is on the link —
/// was the one consumer that could not answer.
#[test]
fn the_running_nodes_peer_table_crosses_the_socket() {
    let (path, _server) = start_control_plane_seeded(&[
        ("dog1", "robot", Some("udp/10.0.0.9:7446")),
        ("cam-front", "sensor", None),
    ]);
    let socket = path.to_string_lossy().to_string();

    let (code, stdout, stderr) = run(&["status", "--socket", &socket, "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let doc: serde_json::Value = serde_json::from_str(&stdout).expect("one JSON document");
    let peers = doc["peers"]
        .as_array()
        .unwrap_or_else(|| panic!("`peers` is the table, not a count: {stdout}"));
    assert_eq!(peers.len(), 2, "got: {stdout}");
    let dog = peers
        .iter()
        .find(|peer| peer["id"] == "dog1")
        .expect("dog1 is listed");
    assert_eq!(dog["kind"], "robot");
    assert_eq!(dog["endpoint"], "udp/10.0.0.9:7446");
    assert_eq!(dog["beacons"], 0, "declared by hand: no beacon has arrived");
    assert!(dog["last_seen_ms"].is_u64(), "got: {dog}");
    let cam = peers
        .iter()
        .find(|peer| peer["id"] == "cam-front")
        .expect("cam-front is listed");
    assert_eq!(cam["kind"], "sensor");
    assert_eq!(
        cam["endpoint"],
        serde_json::Value::Null,
        "an unannounced endpoint is `null`, never an empty string"
    );

    // The human form names them too: a count leaves "who?" unanswered.
    let (code, stdout, stderr) = run(&["status", "--socket", &socket]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("dog1") && stdout.contains("cam-front"),
        "the human table names the peers, got: {stdout}"
    );
    assert!(
        stdout.contains("udp/10.0.0.9:7446"),
        "…and their announced endpoints, got: {stdout}"
    );

    let _ = std::fs::remove_file(&path);
}

/// `status` and `status --socket` are one document about one kind of node.
///
/// They used to be two: the remote one flattened the counters to the top level and made `peers` a
/// **number** while a local document makes it an array of objects, and it spelled `health` as a bare
/// string while the local one spells it as an object. Same command, same key names, different
/// *types* — a script written against one mode silently misread the other.
#[test]
fn status_json_is_one_document_locally_and_over_a_socket() {
    let (path, _server) = start_control_plane_seeded(&[("dog1", "robot", None)]);
    let socket = path.to_string_lossy().to_string();

    let keys_of = |stdout: &str| -> Vec<String> {
        let doc: serde_json::Value =
            serde_json::from_str(stdout).unwrap_or_else(|e| panic!("not one document: {e}"));
        let mut keys: Vec<String> = doc
            .as_object()
            .unwrap_or_else(|| panic!("not an object: {stdout}"))
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    };

    let (code, local, stderr) = run(&["status"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let (code, remote, stderr) = run(&["status", "--socket", &socket, "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");

    let mut expected = keys_of(&local);
    expected.push("actuations".to_string());
    expected.push("remote".to_string());
    expected.sort();
    assert_eq!(
        keys_of(&remote),
        expected,
        "the remote document is the local one plus who answered (− nothing)"
    );

    // The two keys that used to change type: `peers` (array vs number) and `health`
    // (object vs string). A reader must not have to know which mode it is in.
    let remote_doc: serde_json::Value = serde_json::from_str(&remote).expect("json");
    let local_doc: serde_json::Value = serde_json::from_str(&local).expect("json");
    for doc in [&local_doc, &remote_doc] {
        assert!(doc["peers"].is_array(), "peers is the table: {doc}");
        assert!(doc["metrics"].is_object(), "counters nest: {doc}");
        assert!(doc["health"].is_object(), "the verdict is an object: {doc}");
        assert!(
            doc["health"]["state"].is_string(),
            "…whose `state` is one of unknown|healthy|degraded: {doc}"
        );
    }
    assert_eq!(
        remote_doc["peers"][0]["id"], "dog1",
        "the seeded peer travels in the same shape: {remote}"
    );

    let _ = std::fs::remove_file(&path);
}

#[test]
fn an_unknown_argument_exits_2_with_the_usage() {
    let (code, _, stderr) = run(&["frobnicate"]);
    assert_eq!(code, 2, "a usage error is exit code 2");
    assert!(stderr.contains("unknown argument"), "got: {stderr}");
    assert!(
        stderr.contains("USAGE:"),
        "the usage is printed for a bad call"
    );
}

#[test]
fn remote_mode_reads_a_running_control_plane_over_a_unix_socket() {
    // `--socket` is the difference between "smoke the middleware" and "look at the robot":
    // the same verbs, but the node answering is the *running* one. Every line names the
    // socket, so an operator can never confuse it with a local node's answer.
    let (path, _server) = start_control_plane();
    let socket = path.to_string_lossy().to_string();

    let (code, stdout, stderr) = run(&["status", "--socket", &socket, "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("\"remote\": "), "got: {stdout}");
    assert!(
        stdout.contains("\"peer\": \"amos-daemon\""),
        "the daemon's own identity answers, got: {stdout}"
    );
    let doc: serde_json::Value = serde_json::from_str(&stdout).expect("one JSON document");
    // The verdict is the same object a *local* `status` prints — not a bare string (this test
    // used to assert `"health": "degraded"`, the remote dialect that no longer exists).
    let state = doc["health"]["state"]
        .as_str()
        .unwrap_or_else(|| panic!("a verdict is always named, got: {stdout}"));
    assert!(
        ["degraded", "healthy", "unknown"].contains(&state),
        "got: {state}"
    );
    assert_eq!(
        state, "degraded",
        "a lone node with an uncalibrated clock: {stdout}"
    );
    assert_eq!(
        doc["health"]["reasons"],
        serde_json::json!(["no_peers", "clock_unsynced"]),
        "…and its reasons are the same tokens the proto carries: {stdout}"
    );
    // The return path is part of the same document: robots that reported are listed, and an
    // empty list is an empty list (not an invented idle robot).
    assert!(
        stdout.contains("\"actuations\": []"),
        "the daemon's folded robot reports are part of `status`, got: {stdout}"
    );

    let (code, stdout, stderr) = run(&["status", "--socket", &socket]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("remote="), "got: {stdout}");
    assert!(stdout.contains("peer=amos-daemon"), "got: {stdout}");
    assert!(
        stdout.contains("robots reported (0): nobody has reported its actuation"),
        "an unreported fleet is named as absent, got: {stdout}"
    );

    let (code, stdout, stderr) = run(&["topics", "--socket", &socket]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("seen by the daemon's transport"),
        "the inventory says whose it is, got: {stdout}"
    );
    // …and whether it is the whole truth. The count alone presented an incomplete list (a
    // broker past `MAX_TRACKED_TOPICS`, or any network transport) exactly like a complete one
    // to a caller that is not on that node's transport and cannot find out any other way.
    assert!(
        stdout.contains("(inventory complete)"),
        "the remote inventory carries its own limit, got: {stdout}"
    );

    let (code, stdout, stderr) = run(&[
        "pub",
        "--socket",
        &socket,
        "--topic",
        "amos/dog1/control/joints",
        "--action",
        "{\"action\":\"trot\",\"speed\":0.5}",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("published via=") && stdout.contains("topic=amos/dog1/control/joints"),
        "got: {stdout}"
    );

    // The heartbeat stream is the liveness claim: a beat must arrive inside the window,
    // and it is the daemon's own node that beats (REQ-A236).
    let (code, stdout, stderr) = run(&["watch", "--socket", &socket, "--seconds", "2"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("beat peer=amos-daemon"),
        "the running node beats, got: {stdout}"
    );
    assert!(stdout.contains("watched 2s:"), "got: {stdout}");

    let _ = std::fs::remove_file(&path);
}

#[test]
fn remote_mode_refuses_commands_that_need_a_local_node_and_bad_sockets() {
    let (path, _server) = start_control_plane();
    let socket = path.to_string_lossy().to_string();

    // A data-plane command must not be silently downgraded into something else.
    let (code, _, stderr) = run(&["bench", "--socket", &socket]);
    assert_eq!(code, 1, "a refusal is a failure exit, not a usage error");
    assert!(
        stderr.contains("needs a local data-plane node"),
        "got: {stderr}"
    );
    assert!(stderr.contains("bench"), "the refusal names it: {stderr}");

    // `state` is a subscription too (the robot's own reports), so it needs a local node —
    // the control plane can answer `status` but not stream the data plane.
    let (code, _, stderr) = run(&["state", "--socket", &socket]);
    assert_eq!(code, 1);
    assert!(stderr.contains("state"), "the refusal names it: {stderr}");
    assert!(
        stderr.contains("needs a local data-plane node"),
        "got: {stderr}"
    );

    // `motor` takes no link at all, so a socket is a mistake, not an instruction.
    let (code, _, stderr) = run(&[
        "motor",
        "--socket",
        &socket,
        "--action",
        "{\"action\":\"trot\"}",
    ]);
    assert_eq!(code, 1);
    assert!(stderr.contains("drop --socket"), "got: {stderr}");

    // A socket nobody is listening on is an error that says *what* it tried to reach.
    let missing = std::env::temp_dir().join("amos-link-cli-no-such-daemon.sock");
    let _ = std::fs::remove_file(&missing);
    let (code, _, stderr) = run(&["status", "--socket", &missing.to_string_lossy()]);
    assert_eq!(code, 1);
    assert!(
        stderr.contains("control plane"),
        "the error names what it could not reach: {stderr}"
    );

    let _ = std::fs::remove_file(&path);
}

#[test]
fn status_and_topics_work_on_a_fresh_node() {
    let (code, stdout, stderr) = run(&["status", "--peer", "dog1", "--kind", "robot"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    // `status` is JSON an operator (or a script) can read.
    assert!(stdout.contains("\"peer\": \"dog1\""), "got: {stdout}");
    assert!(stdout.contains("\"kind\": \"robot\""), "got: {stdout}");
    assert!(stdout.contains("\"clock_synced\": false"), "got: {stdout}");
    // A fresh node has no evidence, so it does **not** claim health — and it says so in the
    // machine-readable status (the verdict is part of the document, not a UI guess).
    assert!(
        stdout.contains("\"health\": {") && stdout.contains("\"state\": \"unknown\""),
        "no evidence must read as unknown, got: {stdout}"
    );

    let (code, stdout, _) = run(&["topics"]);
    assert_eq!(code, 0);
    assert!(
        stdout.contains("no traffic yet"),
        "a fresh node reports an empty inventory, got: {stdout}"
    );
    assert!(
        !stdout.contains("inventory incomplete"),
        "an empty inventory is a *complete* one — the caveat must not fire here, got: {stdout}"
    );
}

#[test]
fn pub_reports_what_it_published() {
    let (code, stdout, stderr) = run(&[
        "pub",
        "--topic",
        "amos/dog1/control/joints",
        "--action",
        r#"{"action":"trot"}"#,
        "--count",
        "2",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("published seq=1"), "got: {stdout}");
    assert!(stdout.contains("published seq=2"), "got: {stdout}");
    assert!(stdout.contains("amos/dog1/control/joints"), "got: {stdout}");

    // A missing payload is a user error with a clear message.
    let (code, _, stderr) = run(&["pub", "--topic", "amos/dog1/control/joints"]);
    assert_eq!(code, 1);
    assert!(stderr.contains("--action"), "got: {stderr}");

    // A wildcard is not a topic a publisher may name.
    let (code, _, stderr) = run(&["pub", "--topic", "amos/*/control/joints", "--text", "hi"]);
    assert_eq!(code, 1);
    assert!(stderr.contains("wildcards"), "got: {stderr}");

    // A rate whose period cannot be scheduled is a *reported* error, not a panic: the
    // tool must not die with a stack trace on a value the user typed.
    for hz in ["1e-300", "1e300"] {
        let (code, _, stderr) = run(&[
            "pub",
            "--topic",
            "amos/dog1/sensor/imu",
            "--text",
            "hi",
            "--hz",
            hz,
        ]);
        assert_eq!(code, 1, "--hz {hz} must be a clean usage failure");
        assert!(
            stderr.contains("cannot be scheduled"),
            "--hz {hz} must explain itself, got: {stderr}"
        );
        assert!(
            !stderr.contains("panicked"),
            "--hz {hz} must not panic, got: {stderr}"
        );
    }
}

#[test]
fn state_watches_the_return_path_and_is_bounded_by_a_timeout() {
    // `state` reads what robots report about themselves (`amos/*/state/actuation`). On a
    // quiet link it must say what it did and exit — and the QoS profile must be *derived*
    // from the pattern's channel (`state`, latest-wins), never remembered by hand.
    let (code, stdout, stderr) = run(&["state", "--timeout-ms", "50"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("watching amos/*/state/actuation"),
        "the default pattern covers every robot, got: {stdout}"
    );
    assert!(
        stdout.contains("from channel state"),
        "the profile is derived from the channel, got: {stdout}"
    );
    assert!(
        stdout.contains("timeout after 50ms with no report"),
        "got: {stdout}"
    );
    assert!(stdout.contains("stats received=0"), "got: {stdout}");

    // `--pattern` narrows it to one robot, and an unusable pattern is refused (not ignored).
    let (code, stdout, stderr) = run(&[
        "state",
        "--pattern",
        "amos/dog1/state/actuation",
        "--timeout-ms",
        "50",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("watching amos/dog1/state/actuation"),
        "got: {stdout}"
    );
    let (code, _, stderr) = run(&["state", "--pattern", "not a pattern"]);
    assert_eq!(
        code, 1,
        "an unusable pattern is a failure, not a silent default"
    );
    assert!(stderr.contains("not a valid pattern"), "got: {stderr}");
}

#[test]
fn sub_times_out_when_nothing_is_published() {
    // The whole point of `--timeout-ms`: a CLI that hangs forever is not debuggable.
    let (code, stdout, stderr) = run(&[
        "sub",
        "--pattern",
        "amos/**",
        "--count",
        "1",
        "--timeout-ms",
        "50",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("subscribed"), "got: {stdout}");
    assert!(stdout.contains("timeout after 50ms"), "got: {stdout}");
    assert!(stdout.contains("stats received=0"), "got: {stdout}");
    // A pattern with no channel in it takes the documented default, and says so.
    assert!(
        stdout.contains("from default (no channel in the pattern)"),
        "the chosen profile is explained, got: {stdout}"
    );
}

#[test]
fn sub_derives_the_qos_profile_from_the_patterns_channel() {
    // A control pattern subscribed best-effort would drop the commands the subscription
    // exists to deliver, so the channel decides — and the CLI prints why.
    let (code, stdout, stderr) = run(&[
        "sub",
        "--pattern",
        "amos/*/control/*",
        "--count",
        "1",
        "--timeout-ms",
        "50",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("qos=reliable/drop-newest from channel control"),
        "a control pattern must be reliable, got: {stdout}"
    );

    // A sensor pattern keeps the latest-wins profile.
    let (code, stdout, _) = run(&[
        "sub",
        "--pattern",
        "amos/*/sensor/**",
        "--count",
        "1",
        "--timeout-ms",
        "50",
    ]);
    assert_eq!(code, 0);
    assert!(
        stdout.contains("qos=best-effort/drop-oldest from channel sensor"),
        "got: {stdout}"
    );

    // An explicit `--qos` still wins over the pattern.
    let (code, stdout, _) = run(&[
        "sub",
        "--pattern",
        "amos/*/control/*",
        "--qos",
        "sensor",
        "--count",
        "1",
        "--timeout-ms",
        "50",
    ]);
    assert_eq!(code, 0);
    assert!(stdout.contains("from --qos"), "got: {stdout}");
}

#[test]
fn hz_reports_a_rate_per_stream_and_never_invents_one() {
    // The missing `ros2 topic hz`-class instrument (round 18): *at what rate is this stream
    // arriving?* On an idle link there is **nothing** to measure — no rate line, no `0.0Hz`, and
    // a summary that says how many streams it actually saw (zero). `0 Hz` would be a claim about
    // the robot ("the camera is publishing nothing") rather than about our window.
    let (code, stdout, stderr) = run(&["hz", "--seconds", "1"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("no frames observed"), "got: {stdout}");
    assert!(
        !stdout.contains("rate="),
        "no rate line without a stream: {stdout}"
    );
    assert!(stdout.contains("summary streams=0"), "got: {stdout}");
    // The profile rule is the same one `sub` prints (`--qos` › the pattern's channel › sensor).
    assert!(
        stdout.contains("from default (no channel in the pattern)"),
        "got: {stdout}"
    );

    // The machine form: a header object and a summary object, and **no** per-stream object —
    // an invented `rate_hz: 0.0` would be exactly the fabrication this command must not make.
    let (code, stdout, stderr) = run(&["hz", "--seconds", "1", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["hz", "--json"], &stdout);
    assert_eq!(rows.len(), 2, "header + summary, got: {stdout}");
    assert_eq!(rows[0]["event"], "measuring");
    assert_eq!(rows[1]["event"], "hz_summary");
    assert_eq!(rows[1]["streams"], 0);
    assert_eq!(rows[1]["frames"], 0);
}

#[test]
fn hz_is_a_local_data_plane_command_and_belongs_to_its_own_flags() {
    // A rate is measured from a *local* subscription: a remote `hz` would have to ask the daemon
    // for per-topic rates, which the control plane does not carry — so it is refused by name
    // rather than silently downgraded (the same rule `sub`/`bench`/`state` follow).
    let (path, _server) = start_control_plane();
    let socket = path.to_string_lossy().to_string();
    let (code, _, stderr) = run(&["hz", "--socket", &socket]);
    assert_eq!(code, 1, "a refusal is a failure exit, not a usage error");
    assert!(stderr.contains("hz"), "the refusal names it: {stderr}");
    assert!(
        stderr.contains("needs a local data-plane node"),
        "got: {stderr}"
    );

    // `--count` is a *publish/subscribe* count, not a measurement window: `hz` runs on
    // `--seconds`, so the count flag stays refused for it (a silently ignored `--count 5` would
    // look like it bounded the measurement).
    let (code, _, stderr) = run(&["hz", "--count", "5"]);
    assert_eq!(code, 2, "a mis-scoped flag is a usage error");
    assert!(stderr.contains("--count"), "got: {stderr}");
    assert!(stderr.contains("hz"), "the refusal names the command: {stderr}");
}

#[test]
fn motor_translates_an_action_into_frames_and_hex() {
    let (code, stdout, stderr) = run(&["motor", "--action", r#"{"action":"trot","speed":0.5}"#]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("gait=trot"), "got: {stdout}");
    assert!(
        stdout.contains("frames=13"),
        "1 enable + 12 joints, got: {stdout}"
    );
    assert!(
        stdout.contains("hex=aa55"),
        "the bus frame starts with the SOF"
    );
    assert!(
        stdout.contains("applied 13 frame(s) to hal=mock armed=true"),
        "got: {stdout}"
    );

    // An action the framework does not know is refused, and nothing is applied.
    let (code, stdout, stderr) = run(&["motor", "--action", r#"{"action":"teleport"}"#]);
    assert_eq!(code, 1);
    assert!(stderr.contains("unknown action"), "got: {stderr}");
    assert!(!stdout.contains("applied"), "got: {stdout}");

    // The e-stop is always accepted (never refused for a cosmetic reason).
    let (code, stdout, stderr) = run(&["motor", "--action", r#"{"action":"estop","speed":9}"#]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("frames=12"),
        "a torque cut per joint, got: {stdout}"
    );
    assert!(stdout.contains("armed=false"), "got: {stdout}");
}
#[cfg(unix)]
#[test]
fn motor_device_writes_real_frames_to_a_listening_controller() {
    // The hardware boundary, end to end and process-level: the *shipped binary* connects to a
    // controller socket and the frames arrive as CRC16-checked motor frames. Nothing here is a
    // mock — the bytes cross a real descriptor, which is what `MockRobotHal` can never prove.
    use std::io::Read;
    use std::os::unix::net::UnixListener;

    let dir = std::env::temp_dir().join(format!("amos-link-cli-motor-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("motor.sock");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).expect("the motor daemon listens");

    let daemon = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().expect("the CLI attaches");
        let mut bytes = Vec::new();
        // Read to EOF: the tool closes the bus when it exits, so the wire length is the
        // frames' length — the test does not have to be told how many were sent.
        socket.read_to_end(&mut bytes).expect("the bus is readable");
        bytes
    });

    let (code, stdout, stderr) = run(&[
        "motor",
        "--action",
        r#"{"action":"stand"}"#,
        "--device",
        path.to_str().expect("utf-8 path"),
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("applied 13 frame(s) to hal=stream armed=true"),
        "the reported line names the real bus and a measured count: {stdout}"
    );
    assert!(
        stdout.contains(path.to_str().expect("utf-8 path")),
        "the report names which device was written: {stdout}"
    );

    let bytes = daemon.join().expect("the daemon thread finishes");
    assert!(!bytes.is_empty(), "the CLI wrote the frames to the bus");
    assert_eq!(
        bytes.len() % 10,
        0,
        "the wire carries whole motor frames, got {} bytes",
        bytes.len()
    );
    let frames: Vec<amos_link::robot_hal::MotorFrame> = bytes
        .chunks(10)
        .map(|chunk| amos_link::robot_hal::MotorFrame::decode(chunk).expect("CRC16 verifies"))
        .collect();
    assert_eq!(frames.len(), 13, "stand = enable + one frame per joint");
    assert_eq!(
        frames.first().map(|f| f.op),
        Some(amos_link::robot_hal::MotorOp::Enable),
        "the batch energizes first"
    );
    assert_eq!(
        frames.last().map(|f| f.op),
        Some(amos_link::robot_hal::MotorOp::SetPosition)
    );
    let _ = std::fs::remove_file(&path);
}

#[cfg(unix)]
#[test]
fn a_device_that_cannot_be_opened_is_a_failure_that_names_it() {
    // A missing bus must be an error, never a silent "applied 13 frames": a robot whose
    // controller is down must not be reported as commanded.
    let missing = std::env::temp_dir().join("amos-link-no-such-motor-bus.sock");
    let _ = std::fs::remove_file(&missing);
    let (code, stdout, stderr) = run(&[
        "motor",
        "--action",
        r#"{"action":"stand"}"#,
        "--device",
        missing.to_str().expect("utf-8 path"),
    ]);
    assert_eq!(code, 1, "a bus that cannot be opened is a failure exit");
    assert!(
        stderr.contains("no-such-motor-bus.sock"),
        "the error names the path: {stderr}"
    );
    assert!(
        !stdout.contains("applied"),
        "nothing was applied, nothing may be reported: {stdout}"
    );
}

#[cfg(unix)]
#[test]
fn device_belongs_to_motor_alone_and_says_so() {
    // `--device` on another command is a *usage* error (exit 2), not a silently ignored flag:
    // an operator must never believe frames went to a bus this run never opened.
    let (code, _, stderr) = run(&["status", "--device", "/tmp/whatever.sock"]);
    assert_eq!(code, 2, "argv shape errors are usage errors");
    assert!(
        stderr.contains("belongs to `motor`"),
        "the refusal names the rule: {stderr}"
    );
}

#[test]
fn discover_lists_the_seeded_peer_table_and_never_the_local_node() {
    let (code, stdout, stderr) = run(&[
        "discover",
        "--peer",
        "mini-brain",
        "--kind",
        "brain",
        "--static",
        "dog1",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("discovery=mock"), "got: {stdout}");
    assert!(
        stdout.contains("dog1"),
        "the operator's static peer is listed, got: {stdout}"
    );
    assert!(
        !stdout.contains("mini-brain"),
        "a node is not its own peer: the local id must never appear as a peer, got: {stdout}"
    );
    assert!(
        stdout.contains("seen(ms)"),
        "the table has a header, got: {stdout}"
    );

    // An operator who names their own node as a peer is told why it is absent — a silent
    // filter would be indistinguishable from a table that received nothing.
    let (code, stdout, stderr) =
        run(&["discover", "--peer", "mini-brain", "--static", "mini-brain"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("filtered 1 entry naming this node itself"),
        "the refusal names itself, got: {stdout}"
    );
    assert!(
        !stdout.contains("mini-brain  "),
        "…and the local node is still not in the table, got: {stdout}"
    );
}

#[test]
fn discover_bus_federates_over_the_link_and_says_what_it_saw() {
    // Offline, one node: federation still runs (announce + self-echo filter), and the
    // output must say so honestly instead of faking a peer.
    let (code, stdout, stderr) = run(&["discover", "--bus", "--seconds", "1"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("discovery=bus"), "got: {stdout}");
    assert!(
        stdout.contains("amos/amos-node/telemetry/beacon"),
        "got: {stdout}"
    );
    assert!(
        stdout.contains("filtered its own echo"),
        "the honest 'no peers' line, got: {stdout}"
    );

    // The two channels are different things; asking for both is a usage error.
    let (code, _, stderr) = run(&["discover", "--bus", "--lan"]);
    assert_eq!(code, 1, "got: {stderr}");
    assert!(stderr.contains("pick one"), "got: {stderr}");
}

/// The **streaming** half of the `--json` contract: `sub`, `state` and `watch` print one JSON
/// object per line, *every* line — including the ones that used to be prose.
///
/// `json_is_honored_by_every_command_that_prints` covers the one-shot commands and stops there,
/// so the three streamers were never checked line by line, and each of them printed a prose
/// header first (`subscribed peer=…`, `watching …`, `watching transport=…`) plus a prose
/// timeout/stats/summary tail. Piping any of them into a JSON parser failed on line 1, which is
/// exactly what USAGE and the README promise it will not do ("one JSON object per line for the
/// commands that stream"). Each of those lines is now an event object; nothing was dropped from
/// the stream — the facts moved from prose into the header/summary events.
#[test]
fn the_streaming_commands_are_json_line_by_line_when_asked() {
    // `sub`: header, timeout, stats — plus the frame line, which is the only one that can be
    // produced without a second process publishing (so it is covered by the human-form test
    // above and by the `event` tag asserted here on the same shape).
    let (code, stdout, stderr) = run(&[
        "sub",
        "--pattern",
        "amos/**",
        "--count",
        "1",
        "--timeout-ms",
        "50",
        "--json",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["sub", "--json"], &stdout);
    assert!(
        rows.iter().all(|row| row["event"].is_string()),
        "every line names its event: {rows:?}"
    );
    assert_eq!(rows[0]["event"], "subscribed");
    assert_eq!(rows[0]["pattern"], "amos/**");
    assert_eq!(
        rows[0]["qos"]["reliability"], "best-effort",
        "a pattern with no channel takes the documented default: {rows:?}"
    );
    assert!(
        rows.iter().any(|row| row["event"] == "timeout"),
        "the timeout is an event, not a prose line: {rows:?}"
    );
    let stats = rows
        .iter()
        .find(|row| row["event"] == "stats")
        .unwrap_or_else(|| panic!("the stats event is printed: {rows:?}"));
    assert_eq!(stats["tracking"], "complete");
    assert_eq!(stats["lost"], serde_json::json!([]));

    // `state`: the header and the tail were prose too.
    let (code, stdout, stderr) = run(&["state", "--timeout-ms", "50", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["state", "--json"], &stdout);
    assert!(rows.iter().all(|row| row["event"].is_string()), "{rows:?}");
    assert_eq!(rows[0]["event"], "watching");
    assert_eq!(rows[0]["pattern"], "amos/*/state/actuation");
    assert_eq!(rows[0]["qos"]["reliability"], "best-effort");
    assert!(rows.iter().any(|row| row["event"] == "timeout"), "{rows:?}");
    assert!(rows.iter().any(|row| row["event"] == "stats"), "{rows:?}");

    // `watch` (local): the same rule for the fourth stream. **This case was added because a
    // negative control passed**: un-gating only the local header left this test green, since it
    // covered `watch --socket` while its name claimed the streaming commands. A test that
    // passes must be one that *could* have failed.
    let (code, stdout, stderr) = run(&["watch", "--seconds", "1", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["watch", "--json"], &stdout);
    assert!(rows.iter().all(|row| row["event"].is_string()), "{rows:?}");
    assert_eq!(rows[0]["event"], "watching");
    assert_eq!(rows[0]["transport"], "broker");
    assert_eq!(rows[0]["beat"], "amos/link-watch/telemetry/beat");
    assert!(
        rows.iter().any(|row| row["event"] == "summary"),
        "the closing summary is an event too: {rows:?}"
    );

    // `watch --socket` streams the daemon's beats: same rule, same two prose lines gone.
    let (path, _server) = start_control_plane();
    let socket = path.to_string_lossy().to_string();
    let (code, stdout, stderr) = run(&["watch", "--socket", &socket, "--seconds", "1", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["watch", "--socket", "--json"], &stdout);
    assert!(rows.iter().all(|row| row["event"].is_string()), "{rows:?}");
    assert_eq!(rows[0]["event"], "watching");
    assert_eq!(rows[0]["remote"], socket.as_str());
    let summary = rows
        .iter()
        .find(|row| row["event"] == "summary")
        .unwrap_or_else(|| panic!("the summary event is printed: {rows:?}"));
    assert_eq!(summary["remote"], socket.as_str());
    assert!(summary["per_peer"].is_object(), "{summary:?}");
    let _ = std::fs::remove_file(&path);
}

/// The `--lan` sweep is the *other* producer that used to build its beacon with
/// `PeerInfo::new`, so the advertisement has to reach this path too — and it is the one path
/// where a node advertises itself to machines it has never spoken to.
#[cfg(feature = "lan")]
#[test]
fn a_lan_sweep_announces_the_endpoints_it_was_given() {
    let (code, stdout, stderr) = run(&[
        "discover",
        "--lan",
        "--peer",
        "dog1",
        "--kind",
        "robot",
        "--endpoint",
        "tcp/10.0.0.7:7447",
        "--seconds",
        "1",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("advertising=tcp/10.0.0.7:7447"),
        "the sweep says where it can be reached, got: {stdout}"
    );

    let (code, stdout, stderr) = run(&[
        "discover",
        "--lan",
        "--peer",
        "dog1",
        "--endpoint",
        "tcp/10.0.0.7:7447,udp/239.0.0.1:7446",
        "--seconds",
        "1",
        "--json",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["discover", "--lan", "--json"], &stdout);
    assert_eq!(
        rows[0]["advertised"],
        serde_json::json!(["tcp/10.0.0.7:7447", "udp/239.0.0.1:7446"]),
        "the document carries the list, not only the primary endpoint: {stdout}"
    );

    // An advertisement this sweep could not emit is refused *before* it spends its window
    // sending nothing (the per-field bounds pass here; the beacon frame does not).
    let wide = (0..8)
        .map(|_| format!("tcp/{}", "9".repeat(123)))
        .collect::<Vec<_>>()
        .join(",");
    let (code, _, stderr) = run(&["discover", "--lan", "--endpoint", &wide, "--seconds", "1"]);
    assert_eq!(code, 1, "got {code}: {stderr}");
    assert!(stderr.contains("beacon of"), "got: {stderr}");
    assert!(
        stderr.contains("advertised endpoint"),
        "the failure names the advertisement as the cause: {stderr}"
    );
}

/// The **age rule** and its wiring, at the process level.
///
/// The skew itself cannot be created from a shell (a `sub` process has one node and one clock,
/// and a node is never its own peer — the same boundary round 12 recorded for its attribution
/// line), so what a process test *can* pin is the wiring the unit tests cannot reach: the
/// `clock_synced` caveat on the lines that carry ages, and the two new `bench` fields. The
/// classification itself is covered by
/// `a_frame_stamped_in_the_future_has_no_age_to_print` /
/// `a_benchmark_never_counts_an_unmeasurable_frame_as_zero_latency` (unit, with two real clocks).
/// **A daemon that predates the return path must not take `status --socket` down.**
///
/// `docs/amos-link.md` §6.5 makes this promise ("老版本的 daemon 没有这个 RPC 时…不报错"), and the
/// CLI used to break it for the whole command: `ListActuations` was called with `?`, so on an
/// older daemon the operator lost the status, the peer table and the inventory — all of which the
/// daemon *had* answered.
///
/// The distinction the terminal now keeps is the same one the System UI's page keeps:
/// `actuations: null` = 「this daemon does not answer that question」, `[]` = 「it answered, and
/// nobody has reported」.
#[test]
fn an_older_daemon_still_answers_the_status_over_a_socket() {
    let (path, _server) = start_older_control_plane();
    let socket = path.to_string_lossy().to_string();

    // ── human form: the answered facts are printed, and the missing one says so ─────────
    let (code, stdout, stderr) = run(&["status", "--socket", &socket]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("remote=") && stdout.contains("peer=amos-daemon"),
        "the status the daemon answered travels: {stdout}"
    );
    assert!(
        stdout.contains("dog1") && stdout.contains("udp/10.0.0.9:7446"),
        "…and so does its peer table: {stdout}"
    );
    assert!(
        stdout.contains("topics (1): inventory complete"),
        "…and its inventory (the count and its completeness; the names are `topics --socket`) \
         {stdout}"
    );
    assert!(
        stdout.contains("robots reported: not answered by this daemon"),
        "the return path is named as unanswered, not as an empty fleet: {stdout}"
    );
    assert!(
        !stdout.contains("nobody has reported its actuation"),
        "…and never as 「nobody reported」: {stdout}"
    );

    // ── machine form: `null`, never `[]` ───────────────────────────────────────────────
    let (code, stdout, stderr) = run(&["status", "--socket", &socket, "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    // `status` prints **one pretty document**, not one object per line (a one-shot command):
    // parse the whole output, the same way the round-10 test does.
    let document: serde_json::Value =
        serde_json::from_str(&stdout).unwrap_or_else(|e| panic!("not one document: {e}"));
    assert_eq!(
        document["actuations"],
        serde_json::Value::Null,
        "not answered is `null`: {stdout}"
    );
    assert_eq!(
        document["peers"].as_array().map(Vec::len),
        Some(1),
        "the answered peer table is still an array: {stdout}"
    );
    assert_eq!(document["remote"], socket.as_str());
    assert_eq!(document["peer"], "amos-daemon");
    assert_eq!(document["version"], "0.0.9", "the older daemon's own build");

    let _ = std::fs::remove_file(&path);
}

#[test]
fn the_age_caveat_and_the_bench_sample_count_are_wired() {
    // `sub`: the header carries the clock caveat — the clause `Received::age()`'s own doc
    // promises "beside it" (an age is measured against *this* clock; uncalibrated ⇒ a bound).
    let (code, stdout, stderr) = run(&[
        "sub",
        "--pattern",
        "amos/**",
        "--count",
        "1",
        "--timeout-ms",
        "50",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("clock_synced=false: ages are bounds, not measurements"),
        "the frame stream must qualify its ages, got: {stdout}"
    );
    // …and the same fact in the machine form.
    let (code, stdout, stderr) = run(&[
        "sub",
        "--pattern",
        "amos/**",
        "--count",
        "1",
        "--timeout-ms",
        "50",
        "--json",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["sub", "--json"], &stdout);
    assert_eq!(rows[0]["clock_synced"], false, "{rows:?}");

    // `watch`: the same caveat on its header.
    let (code, stdout, stderr) = run(&["watch", "--seconds", "1"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("clock_synced=false: ages are bounds, not measurements"),
        "got: {stdout}"
    );

    // `bench`: the latency histogram now says **how many samples it is made of**, and how many
    // frames were excluded because their stamp could not be measured (0 on a healthy local run).
    let (code, stdout, stderr) = run(&["bench", "--count", "20", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["bench", "--json"], &stdout);
    assert_eq!(rows[0]["latency_us"]["samples"], 20, "{rows:?}");
    assert_eq!(rows[0]["skewed"], 0, "{rows:?}");
    assert_eq!(
        rows[0]["received"], 20,
        "received = samples + skewed, so the two numbers cannot silently disagree"
    );

    let (code, stdout, stderr) = run(&["bench", "--count", "20"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("(n=20)"),
        "the human latency line states its sample count, got: {stdout}"
    );
    assert!(
        !stdout.contains("excluded"),
        "a healthy run excludes nothing: {stdout}"
    );
}

#[test]
fn an_advertised_endpoint_is_what_the_node_announces_or_a_usage_error() {
    // (1) The advertisement reaches the node's own account of itself: `watch` prints what it
    // announces, in both forms — a node that says nothing says so in words, never with a
    // blank column (an operator must be able to tell "advertises no address" from "the line
    // forgot to print it").
    let (code, stdout, stderr) = run(&["watch", "--seconds", "1"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("advertising=none (no address announced)"),
        "the default is an explicit 'none', got: {stdout}"
    );

    let (code, stdout, stderr) = run(&[
        "watch",
        "--kind",
        "robot",
        "--endpoint",
        "tcp/10.0.0.7:7447",
        "--seconds",
        "1",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("advertising=tcp/10.0.0.7:7447"),
        "the first line names the advertisement, got: {stdout}"
    );
    assert!(
        stdout
            .lines()
            .any(|line| line.starts_with("watched ")
                && line.contains("advertising=tcp/10.0.0.7:7447")),
        "…and so does the closing summary, got: {stdout}"
    );

    // The machine form carries it as a list: a script reading only `peers` would never learn
    // that this node announces no address at all.
    let (code, stdout, stderr) = run(&[
        "watch",
        "--kind",
        "robot",
        "--endpoint",
        "tcp/10.0.0.7:7447,udp/239.0.0.1:7446",
        "--seconds",
        "1",
        "--json",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["watch", "--endpoint", "--json"], &stdout);
    let status = rows
        .iter()
        .find(|row| row["event"] == "status")
        .unwrap_or_else(|| panic!("the status event is printed, got: {stdout}"));
    assert_eq!(
        status["advertised"],
        serde_json::json!(["tcp/10.0.0.7:7447", "udp/239.0.0.1:7446"]),
        "both endpoints travel, not just the primary one"
    );
    let header = rows
        .iter()
        .find(|row| row["event"] == "watching")
        .unwrap_or_else(|| panic!("the header is an event too, got: {stdout}"));
    assert_eq!(header["transport"], "broker");
    assert_eq!(header["beat"], "amos/link-watch/telemetry/beat");
    let summary = rows
        .iter()
        .find(|row| row["event"] == "summary")
        .unwrap_or_else(|| panic!("the summary is an event too, got: {stdout}"));
    assert_eq!(
        summary["advertised"],
        serde_json::json!(["tcp/10.0.0.7:7447", "udp/239.0.0.1:7446"])
    );

    // (2) A federating sweep announces the same thing, and its document says so.
    let (code, stdout, stderr) = run(&[
        "discover",
        "--bus",
        "--endpoint",
        "tcp/10.0.0.7:7447",
        "--seconds",
        "1",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("advertising=tcp/10.0.0.7:7447"),
        "got: {stdout}"
    );
    let (code, stdout, stderr) = run(&[
        "discover",
        "--bus",
        "--endpoint",
        "tcp/10.0.0.7:7447",
        "--seconds",
        "1",
        "--json",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["discover", "--bus", "--endpoint"], &stdout);
    assert_eq!(rows.len(), 1, "one document, got: {stdout}");
    assert_eq!(
        rows[0]["advertised"],
        serde_json::json!(["tcp/10.0.0.7:7447"])
    );

    // (3) A sweep that announces nothing about this node has no `advertised` key at all: the
    // offline mock is not "advertised: []", it is *this mode announces nothing* — two different
    // facts, and `null` would be a third lie.
    let (code, stdout, stderr) = run(&["discover", "--static", "dog1", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["discover", "--json"], &stdout);
    assert!(rows[0].get("advertised").is_none(), "got: {rows:?}");

    // (4) The two refusals this flag owes an operator, both exit 2 with the fix named.
    let (code, _, stderr) = run(&["status", "--endpoint", "tcp/10.0.0.7:7447"]);
    assert_eq!(code, 2, "got {code}: {stderr}");
    assert!(
        stderr.contains("--endpoint") && stderr.contains("belongs to"),
        "got: {stderr}"
    );
    let (code, _, stderr) = run(&["discover", "--endpoint", "tcp/10.0.0.7:7447"]);
    assert_eq!(code, 2, "got {code}: {stderr}");
    assert!(stderr.contains("announces nothing"), "got: {stderr}");

    // (5) An advertisement that passes the per-field bounds but cannot fit a beacon frame is
    // refused **by the binary** (exit 1, the frame named) rather than producing a node whose
    // every beacon is dropped on the emit path. Eight endpoints of 127 bytes are each legal
    // (the per-field ceiling is 128) and are 1016 bytes of advertisement in a frame that may
    // be 512 — the case a per-field check alone would let through, and the reason the check
    // is made by *encoding the beacon* (`PeerInfo::advertising`).
    let wide = (0..8)
        .map(|_| format!("tcp/{}", "9".repeat(123)))
        .collect::<Vec<_>>()
        .join(",");
    let (code, _, stderr) = run(&["watch", "--endpoint", &wide, "--seconds", "1"]);
    assert_eq!(code, 1, "got {code}: {stderr}");
    assert!(
        stderr.contains("beacon of") && stderr.contains("512-byte"),
        "the refusal names the frame, not the field: {stderr}"
    );
}

#[test]
fn motor_arm_energizes_without_moving_and_estop_is_latched_by_the_bridge() {
    // `arm` = one Enable per joint, no position frame (the CLI prints the op).
    let (code, stdout, stderr) = run(&["motor", "--action", r#"{"action":"arm"}"#]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("gait=arm"), "got: {stdout}");
    assert!(stdout.contains("frames=12"), "got: {stdout}");
    assert!(stdout.contains("op=Enable"), "got: {stdout}");
    assert!(!stdout.contains("op=SetPosition"), "got: {stdout}");
    assert!(stdout.contains("armed=true"), "got: {stdout}");
}

#[test]
fn bench_measures_latency_and_throughput_on_the_in_process_bus() {
    let (code, stdout, stderr) = run(&["bench", "--count", "200", "--size", "64"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("frames=200"), "got: {stdout}");
    assert!(stdout.contains("sent=200"), "got: {stdout}");
    assert!(stdout.contains("throughput="), "got: {stdout}");
    assert!(
        stdout.contains("latency (publish -> decoded"),
        "got: {stdout}"
    );
    // Every frame is accounted for: an unthrottled in-process run keeps them all, and the
    // sequence accounting must agree with that (no gap in the publisher's own counter).
    assert!(
        stdout.contains("dropped=0"),
        "an unthrottled in-process run should not drop, got: {stdout}"
    );
    assert!(
        stdout.contains("gaps=0 missing=0"),
        "a clean run loses nothing and must say so, got: {stdout}"
    );
    // Nothing had to wait for a consumer either: a clean run's back-pressure is zero.
    assert!(
        stdout.contains("blocked=0"),
        "an unthrottled run waits for nobody, got: {stdout}"
    );
}

#[test]
fn watch_reports_real_link_liveness_and_exits_on_its_own() {
    // `watch` is the terminal "link is alive" view the control plane's `StreamHeartbeats`
    // is documented for: it publishes this node's heartbeat and counts the frames that
    // actually come back over the link. Two properties matter at the process level — it
    // is bounded by `--seconds` (the process must exit by itself) and it does not fake a
    // peer it never heard from.
    let (code, stdout, stderr) = run(&["watch", "--seconds", "1"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("watching transport=broker peer=link-watch"),
        "got: {stdout}"
    );
    assert!(
        stdout.contains("beat=amos/link-watch/telemetry/beat"),
        "got: {stdout}"
    );
    assert!(
        stdout.contains("link  peer=link-watch"),
        "the periodic status line is printed, got: {stdout}"
    );
    assert!(
        stdout.contains("peers=0"),
        "a lone broker node has no peers and must say so, got: {stdout}"
    );

    // The node's own beat is a real frame on the link (not a synthetic counter), so the
    // run must report having *seen* at least the one it published.
    let summary = stdout
        .lines()
        .find(|line| line.starts_with("watched "))
        .unwrap_or_else(|| panic!("the run ends with a summary, got: {stdout}"));
    let seen: u64 = summary
        .split("beats_seen=")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| panic!("the summary reports beats_seen, got: {summary}"));
    assert!(
        seen >= 1,
        "the node's own heartbeat came back through the subscription: {summary}"
    );
    // …and the gap accounting is part of that report (0 on a healthy local link).
    assert!(
        summary.contains("beats_missing="),
        "the summary counts missed beats, got: {summary}"
    );

    // The verdict is printed with its reasons: a lone node with an uncalibrated clock is
    // *working* but has two measurable caveats — never a bare "OK".
    //
    // It is asserted on the **summary**, not on a status tick: a tick is a *moment*, and the
    // ticker's first tick is immediate, so under load it can fire before this node's own first
    // beat goes out — where `health=unknown` (no evidence yet) is the honest verdict for that
    // instant but not a conclusion about the run. The summary folds the whole window, so its
    // verdict is the same on every machine (round 18 made that explicit; this assertion used to
    // be a timing race).
    assert!(
        summary.contains("health=degraded: no_peers, clock_unsynced"),
        "the summary names the verdict and its reasons, got: {summary}"
    );
    // …and the periodic line carries the same vocabulary (whatever *that* instant's verdict is).
    assert!(
        stdout.contains(" tracking=complete health="),
        "the status line states a verdict too, got: {stdout}"
    );

    // `--json` carries the same facts in the machine-readable form (compact, so a log
    // line stays one line an operator can pipe).
    let (code, stdout, stderr) = run(&["watch", "--seconds", "1", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("\"event\":\"status\""), "got: {stdout}");
    assert!(stdout.contains("\"peer\":\"link-watch\""), "got: {stdout}");
    assert!(stdout.contains("\"peers\":0"), "got: {stdout}");
}

#[test]
fn arguments_that_used_to_crash_the_process_are_usage_errors_now() {
    // Negative controls, process-level: both of these aborted the *shipped binary* before
    // this round (recorded in the audit): `--seconds u64::MAX` panicked with "overflow when
    // adding duration to instant", and a `--count` of `u64::MAX` panicked with "capacity
    // overflow" inside `Vec::with_capacity`. A bad argument is exit 2 with a message.
    let (code, _, stderr) = run(&["discover", "--bus", "--seconds", "18446744073709551615"]);
    assert_eq!(code, 2, "a bad argument is exit 2, got {code}: {stderr}");
    assert!(
        stderr.contains("beyond what this platform's clock can represent"),
        "the refusal explains itself, got: {stderr}"
    );
    assert!(
        !stderr.contains("panicked"),
        "it must never panic: {stderr}"
    );

    let (code, _, stderr) = run(&["bench", "--size", "16777216"]);
    assert_eq!(code, 2, "an unpublishable payload is exit 2, got {code}");
    assert!(stderr.contains("exceeds the"), "got: {stderr}");
    assert!(
        !stderr.contains("panicked"),
        "it must never panic: {stderr}"
    );
}

#[test]
fn a_huge_count_still_starts_the_benchmark_instead_of_aborting_before_the_first_frame() {
    // The other half of the capacity-overflow defect: a `u64` count is legal and means
    // "keep publishing", so the run must *start* and stay up rather than die while reserving
    // a latency vector it could never fill. The process is killed right after its first line
    // (an unbounded run is the operator's own request).
    let (first, still_running, stderr) = run_until_first_line(
        &["bench", "--count", "18446744073709551615"],
        Duration::from_secs(10),
    );
    assert!(
        first.contains("frames=18446744073709551615"),
        "it announced the run it was asked for, got: {first:?} (stderr: {stderr})"
    );
    assert!(
        still_running,
        "the benchmark must still be running after its banner, stderr: {stderr}"
    );
    assert!(
        !stderr.contains("capacity overflow") && !stderr.contains("panicked"),
        "no abort, no panic: {stderr}"
    );
}

/// Parse every line of `stdout` as one JSON document, naming the command on failure — so a
/// prose line that slipped into a `--json` run is reported as what it is.
fn json_lines(argv: &[&str], stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("{argv:?} printed a non-JSON line {line:?}: {e}"))
        })
        .collect()
}

/// `--json` is honored by **every** command that prints, not only by `sub`/`watch`/
/// `status --socket` (which is all the USAGE used to claim): before this round
/// `topics --json` printed a prose sentence and `motor --json` printed the hex log, so a
/// script that asked for the machine form silently got prose.
#[test]
fn json_is_honored_by_every_command_that_prints() {
    // `topics`: one document, and the inventory's own limit travels with it.
    let (code, stdout, stderr) = run(&["topics", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["topics", "--json"], &stdout);
    assert_eq!(rows.len(), 1, "one document, got: {stdout}");
    assert_eq!(rows[0]["topics"].as_array().map(Vec::len), Some(0));
    assert_eq!(rows[0]["complete"], true);

    // `pub`: one object per published frame, so a `--count` run stays a readable stream.
    let (code, stdout, stderr) = run(&[
        "pub",
        "--topic",
        "amos/dog1/control/joints",
        "--action",
        r#"{"action":"stand"}"#,
        "--count",
        "2",
        "--json",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["pub"], &stdout);
    assert_eq!(rows.len(), 2, "got: {stdout}");
    for (index, row) in rows.iter().enumerate() {
        assert_eq!(row["event"], "published");
        assert_eq!(row["seq"], index as u64 + 1);
        assert_eq!(row["topic"], "amos/dog1/control/joints");
        assert!(row["delivered"].is_number(), "got: {row}");
    }

    // `bench`: one document for the run, with the latency block (a *nested* object, which is
    // what makes it machine-readable rather than a formatted line).
    let (code, stdout, stderr) = run(&["bench", "--count", "20", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["bench"], &stdout);
    assert_eq!(rows.len(), 1, "one document, got: {stdout}");
    assert_eq!(rows[0]["frames"], 20);
    assert_eq!(rows[0]["sent"], 20, "the loopback delivered every frame");
    let latency = &rows[0]["latency_us"];
    assert!(
        latency.is_object() || latency.is_null(),
        "latency is an object (or null when nothing landed), got: {latency}"
    );
    if latency.is_object() {
        assert!(latency["p50"].is_number(), "got: {latency}");
    }
}

/// `motor --json`: one document carrying the frames *and* the bus that accepted them — the
/// machine form of the hex log, with the joint address decoded and the real byte string kept.
#[test]
fn motor_json_carries_the_frames_and_the_bus_that_took_them() {
    let (code, stdout, stderr) = run(&["motor", "--action", r#"{"action":"arm"}"#, "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["motor", "--json"], &stdout);
    assert_eq!(rows.len(), 1, "one document, got: {stdout}");
    let frames = rows[0]["frames"].as_array().expect("frames array");
    assert!(!frames.is_empty(), "an arm action plans frames");
    assert_eq!(
        rows[0]["applied"].as_u64().map(|n| n as usize),
        Some(frames.len()),
        "the count reported is the count applied"
    );
    assert_eq!(rows[0]["hal"], "mock");
    assert_eq!(rows[0]["armed"], true);
    assert_eq!(
        rows[0]["device"],
        serde_json::Value::Null,
        "the mock bus is `null`, never a fake path"
    );
    let first = &frames[0];
    for key in ["joint", "leg", "part", "op", "arg", "hex"] {
        assert!(first.get(key).is_some(), "frame is missing {key}: {first}");
    }
    assert_eq!(
        first["hex"].as_str().map(|hex| hex.starts_with("aa55")),
        Some(true),
        "the hex is the wire bytes, got: {first}"
    );
}

/// `discover --json`: one document (the sweep's result) — no `+ peer` progress lines, and the
/// peer table carries the same flat fields the control plane's `Peer` message does
/// (`id`/`kind`/`endpoint`/`last_seen_ms`/`beacons`) instead of the human layout.
#[test]
fn discover_json_is_one_document_of_the_result() {
    let (code, stdout, stderr) = run(&["discover", "--static", "dog1", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["discover", "--json"], &stdout);
    assert_eq!(rows.len(), 1, "one document, got: {stdout}");
    assert_eq!(rows[0]["discovery"], "mock");
    assert_eq!(rows[0]["ttl_ms"], 3000);
    let peers = rows[0]["peers"].as_array().expect("peers array");
    assert_eq!(peers.len(), 1, "got: {stdout}");
    assert_eq!(peers[0]["id"], "dog1");
    assert_eq!(peers[0]["kind"], "robot");
    assert_eq!(
        peers[0]["beacons"], 0,
        "a hand-seeded peer has never been beaconed (the proto's own \"static\" rule)"
    );
    assert_eq!(
        peers[0]["endpoint"],
        serde_json::Value::Null,
        "no announced endpoint is `null`, not the human `-`"
    );

    // The federating sweep carries the transport that carried it.
    let (code, stdout, stderr) = run(&["discover", "--bus", "--seconds", "1", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["discover", "--bus", "--json"], &stdout);
    assert_eq!(rows.len(), 1, "one document, got: {stdout}");
    assert_eq!(rows[0]["discovery"], "bus");
    assert_eq!(rows[0]["transport"], "broker");
    assert_eq!(rows[0]["seconds"], 1);
}

/// The other half of the audit: a flag a command cannot act on is a *usage* error (exit 2)
/// naming both, never a silently ignored argument. `--device` had this rule already; these
/// are the rest of the parser's surface (before this round every one of them *ran*).
#[test]
fn a_flag_the_command_cannot_use_is_a_usage_error_not_a_silent_no_op() {
    // Every case is *bounded* (`--count`/`--timeout-ms`/`--seconds`), so if one of these
    // flags ever becomes silently honored again the case fails fast instead of hanging —
    // which is what a negative control on this test needs.
    let cases: [&[&str]; 5] = [
        &[
            "sub",
            "--pattern",
            "amos/**",
            "--hz",
            "5",
            "--count",
            "1",
            "--timeout-ms",
            "100",
        ],
        &["bench", "--count", "3", "--pattern", "amos/**"],
        &["topics", "--topic", "amos/dog1/control/joints"],
        &["watch", "--seconds", "1", "--count", "2"],
        &[
            "motor",
            "--action",
            "{\"action\":\"stand\"}",
            "--topic",
            "amos/x",
        ],
    ];
    for argv in cases {
        let (code, _, stderr) = run(argv);
        assert_eq!(code, 2, "{argv:?} must be a usage error, got {code}");
        assert!(
            stderr.contains(argv[0]),
            "{argv:?}: the refusal names the command, got: {stderr}"
        );
        assert!(
            stderr.contains("belongs to"),
            "{argv:?}: the refusal says who reads it, got: {stderr}"
        );
    }

    // `--count 0`: `pub --count 0` used to print *nothing* and exit 0 — a silent no-op that
    // is indistinguishable from a successful publish.
    let (code, stdout, stderr) = run(&[
        "pub",
        "--topic",
        "amos/dog1/control/joints",
        "--action",
        r#"{"action":"stand"}"#,
        "--count",
        "0",
    ]);
    assert_eq!(code, 2, "got {code}: {stderr}");
    assert!(
        stdout.is_empty(),
        "a refused run prints no result: {stdout}"
    );
    assert!(
        stderr.contains("--count 0"),
        "the refusal explains itself, got: {stderr}"
    );
}

/// A local-node flag on a `--socket` run is refused: the daemon's identity is what answers,
/// so `--peer dog1` would look like a filter and filter nothing.
#[test]
fn a_socket_run_refuses_the_flags_that_would_configure_a_local_node() {
    let (path, _server) = start_control_plane();
    let socket = path.to_string_lossy().to_string();

    let (code, _, stderr) = run(&["status", "--socket", &socket, "--peer", "dog1"]);
    assert_eq!(code, 2, "got {code}: {stderr}");
    assert!(
        stderr.contains("--peer") && stderr.contains("--socket"),
        "got: {stderr}"
    );

    // …while what a remote run *does* read stays accepted, in the machine form too.
    let (code, stdout, stderr) = run(&["topics", "--socket", &socket, "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["topics", "--socket"], &stdout);
    assert_eq!(rows.len(), 1, "got: {stdout}");
    assert_eq!(rows[0]["remote"], socket.as_str());
    assert!(rows[0]["complete"].is_boolean(), "got: {stdout}");

    let (code, stdout, stderr) = run(&[
        "pub",
        "--socket",
        &socket,
        "--topic",
        "amos/dog1/control/joints",
        "--action",
        r#"{"action":"trot"}"#,
        "--json",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let rows = json_lines(&["pub", "--socket"], &stdout);
    assert_eq!(rows.len(), 1, "got: {stdout}");
    assert_eq!(rows[0]["event"], "published");
    assert_eq!(rows[0]["via"], socket.as_str());

    let _ = std::fs::remove_file(&path);
}
