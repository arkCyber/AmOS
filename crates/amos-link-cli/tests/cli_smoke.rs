//! End-to-end smoke of the *shipped binary*: `cargo test` builds `amos-link-cli`, and
//! these tests run it exactly as an operator would — argv in, exit code + stdout out.
//!
//! This is deliberately not a unit test of `run()`: the release contract
//! (`scripts/release-artifacts.sh` checks `--version`, a wrapper script checks exit
//! codes) is about the **process**, and only a process-level test proves it.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

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
    let verdict = ["degraded", "healthy", "unknown"]
        .iter()
        .any(|v| stdout.contains(&format!("\"health\": \"{v}\"")));
    assert!(verdict, "a verdict is always named, got: {stdout}");

    let (code, stdout, stderr) = run(&["status", "--socket", &socket]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("remote="), "got: {stdout}");
    assert!(stdout.contains("peer=amos-daemon"), "got: {stdout}");

    let (code, stdout, stderr) = run(&["topics", "--socket", &socket]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("seen by the daemon's transport"),
        "the inventory says whose it is, got: {stdout}"
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

#[test]
fn discover_lists_the_seeded_peer_table() {
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
    assert!(stdout.contains("dog1"), "got: {stdout}");
    assert!(stdout.contains("mini-brain"), "got: {stdout}");
    assert!(
        stdout.contains("seen(ms)"),
        "the table has a header, got: {stdout}"
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
    assert!(
        stdout.contains("health=degraded: no_peers, clock_unsynced"),
        "the verdict names its reasons, got: {stdout}"
    );

    // `--json` carries the same facts in the machine-readable form (compact, so a log
    // line stays one line an operator can pipe).
    let (code, stdout, stderr) = run(&["watch", "--seconds", "1", "--json"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("\"event\":\"status\""), "got: {stdout}");
    assert!(stdout.contains("\"peer\":\"link-watch\""), "got: {stdout}");
    assert!(stdout.contains("\"peers\":0"), "got: {stdout}");
}
