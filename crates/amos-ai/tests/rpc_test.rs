//! End-to-end test of the amos RPC pipeline over a real Unix Domain Socket:
//! server (amos-ai) + client (as used by the Tauri bridge).

use amos_proto::ai_agent::{ai_agent_client::AiAgentClient, AgentRequest, StatusRequest};
use std::path::PathBuf;
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

async fn connect(
    path: &std::path::Path,
) -> Result<AiAgentClient<tonic::transport::Channel>, String> {
    let owned_path = path.to_owned();
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned_path.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(AiAgentClient::new(channel))
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..50 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stream_chat_delivers_tokens_then_done() {
    let path: PathBuf = std::env::temp_dir().join(format!("amos-test-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    // Spawn the server on a background task.
    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });

    wait_for_socket(&path).await;
    let mut client = connect(&path).await.expect("connect");

    // Status probe.
    let status = client
        .get_status(StatusRequest {})
        .await
        .expect("get_status")
        .into_inner();
    assert!(status.running);
    assert!(!status.model.is_empty());

    // Streaming chat.
    let mut stream = client
        .stream_chat(AgentRequest {
            session_id: "test-session".into(),
            prompt: "你好，Amos".into(),
            context: Default::default(),
        })
        .await
        .expect("stream_chat")
        .into_inner();

    let mut count = 0usize;
    let mut seen_done = false;
    let mut full = String::new();
    while let Ok(Some(chunk)) = stream.message().await {
        if !chunk.token.is_empty() {
            count += 1;
            full.push_str(&chunk.token);
        }
        if chunk.done {
            seen_done = true;
            break;
        }
    }
    assert!(seen_done, "stream must terminate with a done frame");
    assert!(count > 0, "expected multiple token frames");
    assert!(full.contains("Amos"), "reply should reference the prompt");

    server.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn stream_chat_semantic_intent_returns_ui_card() {
    let path: PathBuf = std::env::temp_dir().join(format!("amos-card-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;

    let mut client = connect(&path).await.expect("connect");

    // "查一下钱包余额" maps to a wallet intent → structured UiCard on the done frame.
    let mut stream = client
        .stream_chat(AgentRequest {
            session_id: "card-session".into(),
            prompt: "查一下钱包余额".into(),
            context: Default::default(),
        })
        .await
        .expect("stream_chat")
        .into_inner();

    let mut got_card = None;
    while let Ok(Some(chunk)) = stream.message().await {
        if let Some(card) = chunk.card {
            if !card.kind.is_empty() {
                got_card = Some(card);
            }
        }
        if chunk.done {
            break;
        }
    }

    let card = got_card.expect("stream_chat should attach a UiCard to the done frame");
    assert_eq!(
        card.kind, "wallet",
        "wallet intent should yield a wallet card"
    );
    assert!(
        card.actions.iter().any(|a| a.contains("设置")),
        "wallet card offers an action"
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn get_status_exposes_live_monitoring_metrics() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-test-{}-metrics.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;
    let mut client = connect(&path).await.expect("connect");

    // Every GetStatus passes the gRPC interceptor, so each call must bump the
    // daemon's rpc_total counter seen on the wire.
    let s1 = client
        .get_status(StatusRequest {})
        .await
        .expect("get_status #1")
        .into_inner();
    assert!(s1.running);
    assert!(s1.rpc_total >= 1, "first probe itself is counted");

    // get_status.system (amos-monitor) rides the same reply over the wire: the
    // backing sampler is named and load/battery/process sub-blocks are present.
    // Their values may be "unknown" (None) on hosts without /proc (e.g. macOS dev)
    // — never a fabricated reading.
    let sys = s1.system.expect("system block present on get_status");
    assert!(!sys.sampler.is_empty(), "backing sampler is named");
    assert!(sys.load.is_some(), "load sub-block present");
    assert!(sys.battery.is_some(), "battery sub-block present");
    assert!(sys.processes.is_some(), "process sub-block present");

    // Resource-gate + cache observability ride the same reply (REQ-A43/A44):
    // the pool's capacity is a static nonzero bound with `available + in_flight
    // == capacity` (never an over-admission), and the cache is off by default —
    // reported honestly as enabled=false with zero counters, not a fake block.
    let gp = s1
        .generation_pool
        .expect("generation_pool block present on get_status");
    assert!(gp.capacity >= 1, "pool capacity is a static nonzero bound");
    assert!(
        gp.in_flight <= gp.capacity,
        "in_flight must never exceed capacity"
    );
    assert_eq!(
        gp.available + gp.in_flight,
        gp.capacity,
        "available + in_flight must equal capacity"
    );
    let rc = s1
        .response_cache
        .expect("response_cache block present on get_status");
    assert!(!rc.enabled, "response cache is opt-in (off by default)");
    assert_eq!((rc.hits, rc.misses, rc.stores), (0, 0, 0));
    assert_eq!(rc.capacity, 0, "a disabled cache has no entries bound");

    let s2 = client
        .get_status(StatusRequest {})
        .await
        .expect("get_status #2")
        .into_inner();
    assert!(
        s2.rpc_total > s1.rpc_total,
        "a second probe must advance rpc_total ({} -> {})",
        s1.rpc_total,
        s2.rpc_total
    );
    assert_eq!(s2.running, s1.running);

    server.abort();
    let _ = std::fs::remove_file(&path);
}
#[tokio::test(flavor = "multi_thread")]
async fn sensor_service_mounted_and_profile_exposed() {
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-profile-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;

    // Build a raw channel once, then split it into the two service clients that
    // share the daemon's single UDS (AiAgent + Sensor).
    let owned = path.clone();
    let endpoint = Endpoint::try_from("http://[::1]:50051").unwrap();
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

    let mut ai = AiAgentClient::new(channel.clone());
    let mut sensor = amos_proto::amos_sensor::sensor_client::SensorClient::new(channel);

    // Profile starts empty (present on the wire, no runs yet).
    let s0 = ai
        .get_status(StatusRequest {})
        .await
        .expect("get_status #0")
        .into_inner();
    let p0 = s0.profile.expect("profile field present");
    assert_eq!(p0.decode_runs, 0, "no decode turns before any chat");

    // The sensor service is mounted on the same socket and answers.
    let cameras = sensor
        .list_cameras(amos_proto::amos_sensor::Empty {})
        .await
        .expect("sensor list_cameras over the shared UDS")
        .into_inner();
    assert!(!cameras.cameras.is_empty(), "mock reports cameras");

    // Run one stream_chat turn to completion so decode profiling fires.
    let mut stream = ai
        .stream_chat(AgentRequest {
            session_id: "profile-session".into(),
            prompt: "ping".into(),
            context: Default::default(),
        })
        .await
        .expect("stream_chat")
        .into_inner();
    while let Ok(Some(chunk)) = stream.message().await {
        if chunk.done {
            break;
        }
    }

    // After the turn the daemon reports the decode run + tokens.
    let s1 = ai
        .get_status(StatusRequest {})
        .await
        .expect("get_status #1")
        .into_inner();
    let p1 = s1.profile.expect("profile field present");
    assert!(
        p1.decode_runs >= 1,
        "decode turn recorded (runs={})",
        p1.decode_runs
    );
    assert!(p1.decode_tokens_total > 0, "tokens counted after a turn");

    server.abort();
    let _ = std::fs::remove_file(&path);
}

/// The on-disk log sink is reported over the wire (REQ-A87): an operator must be able
/// to see from `get_status` that the persisted trail exists — and how much of it went
/// missing — without reading the daemon's stderr.
#[tokio::test(flavor = "multi_thread")]
async fn get_status_reports_a_live_log_sink_over_uds() {
    use std::io::Write;
    use tracing_subscriber::fmt::MakeWriter;

    let dir: PathBuf = std::env::temp_dir().join(format!("amos-log-sink-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let sink = amos_ai::logfile::TeeWriter::new(Some(amos_ai::logfile::LogFileConfig {
        dir: dir.clone(),
        max_bytes: 4096,
        keep: 2,
    }));
    // The same writer the daemon's tracing subscriber uses.
    {
        let mut w = sink.make_writer();
        w.write_all(b"daemon started\n").unwrap();
        w.flush().unwrap();
    }
    let handle = sink.handle();

    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-logsink-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let server_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = amos_ai::server::serve_with_log_sink(server_path, Some(handle)).await;
    });
    wait_for_socket(&path).await;
    let mut client = connect(&path).await.expect("connect");

    let status = client
        .get_status(StatusRequest {})
        .await
        .expect("get_status")
        .into_inner();
    let ls = status.log_sink.expect("log_sink block present");
    assert!(ls.enabled, "a live sink must be reported as enabled");
    assert!(ls.path.ends_with("amos-ai.log"), "path: {}", ls.path);
    assert!(
        ls.bytes_written >= 15,
        "bytes that really landed must be counted (got {})",
        ls.bytes_written
    );
    assert_eq!(
        (ls.lost_bytes, ls.write_failures),
        (0, 0),
        "nothing lost yet"
    );
    assert_eq!(ls.rotations, 0);

    server.abort();
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir_all(&dir);
}
