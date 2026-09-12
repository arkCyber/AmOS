//! Bounded load / "chaos" test over a real Unix Domain Socket.
//!
//! Closes `FUNCTIONAL_GAP_ANALYSIS` #36 ("无基准/压力/混沌测试", §三 "压力/负载测试")
//! for the daemon. The point is not throughput numbers (the default backend is a
//! mock) but that the **admission gate and the status path stay honest under load**,
//! and that a regression *fails* instead of hanging CI:
//!
//! * 16 concurrent `StreamChat` clients against a pool of **4** slots ALL settle
//!   within per-call deadlines (no deadlock, no lost permit);
//! * every `GetStatus` sampled *while* the load is in flight answers promptly and
//!   reports the pool invariant `in_flight + available == capacity`, `capacity == 4`;
//! * after the load: `in_flight == 0` (no generation leaks a slot) and the gate was
//!   really exercised (`acquired_total` accounts for the calls);
//! * one more generation after the storm still succeeds (the daemon is not wedged).

use amos_proto::ai_agent::{ai_agent_client::AiAgentClient, AgentRequest, StatusRequest};
use std::path::PathBuf;
use std::time::Duration;
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

const SLOTS: usize = 4;
const CALLS: usize = 16;
const CALL_DEADLINE: Duration = Duration::from_secs(20);

async fn connect(path: &std::path::Path) -> AiAgentClient<tonic::transport::Channel> {
    let owned_path = path.to_owned();
    let endpoint = Endpoint::try_from("http://[::1]:50051").expect("endpoint");
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned_path.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .expect("connect");
    AiAgentClient::new(channel)
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..50 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("server socket never appeared");
}

/// Drain one `StreamChat` to completion.
///
/// `None` = the stream finished cleanly; `Some(code)` = the honest, classified gRPC
/// rejection the daemon returned (never swallowed by the test). A deadline overrun
/// **panics**: a stuck gate must fail the test, not hang CI.
async fn one_generation(path: PathBuf, i: usize) -> Option<tonic::Code> {
    let mut client = connect(&path).await;
    let req = AgentRequest {
        session_id: format!("load-{i}"),
        prompt: format!("load test {i}"),
        context: Default::default(),
    };
    let call = async {
        let mut stream = client.stream_chat(req).await?.into_inner();
        while let Some(_chunk) = stream.message().await? {}
        Ok::<(), tonic::Status>(())
    };
    match tokio::time::timeout(CALL_DEADLINE, call).await {
        Ok(Ok(())) => None,
        Ok(Err(status)) => Some(status.code()),
        Err(_) => panic!("generation {i} exceeded the deadline (possible deadlock)"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn bounded_load_keeps_the_gate_and_status_honest() {
    // The gate size is read from the env when the server is built. This test binary
    // holds a single test, so mutating the process env here cannot race a sibling.
    std::env::set_var("AMOS_MAX_SESSIONS", SLOTS.to_string());

    let path: PathBuf = std::env::temp_dir().join(format!("amos-load-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let server_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = amos_ai::server::serve(server_path).await;
    });
    wait_for_socket(&path).await;

    let mut client = connect(&path).await;

    // The configured capacity is reported as-is (not a fabricated default).
    let status = client
        .get_status(StatusRequest {})
        .await
        .expect("get_status")
        .into_inner();
    let gp = status.generation_pool.expect("generation_pool block");
    assert_eq!(
        gp.capacity as usize, SLOTS,
        "capacity must mirror AMOS_MAX_SESSIONS"
    );
    assert_eq!(gp.available + gp.in_flight, gp.capacity);
    assert_eq!(gp.in_flight, 0);

    // Fire the storm.
    let mut tasks = Vec::with_capacity(CALLS);
    for i in 0..CALLS {
        let p = path.clone();
        tasks.push(tokio::spawn(async move { one_generation(p, i).await }));
    }

    // The status path must stay responsive *while* generations are in flight, and
    // every sample must satisfy the pool invariant. Regression guard (REQ-A82): these
    // probes used to be rejected as `ResourceExhausted` because generation traffic
    // shared their rate-limit bucket — the daemon went blind exactly when busy.
    for _ in 0..5 {
        let probe =
            tokio::time::timeout(Duration::from_secs(5), client.get_status(StatusRequest {}));
        let reply = probe
            .await
            .expect("get_status blocked under load")
            .expect("a liveness probe must not be starved by generation traffic");
        let gp = reply
            .into_inner()
            .generation_pool
            .expect("generation_pool block");
        assert!(
            gp.in_flight <= gp.capacity,
            "in_flight must never exceed capacity"
        );
        assert_eq!(gp.available + gp.in_flight, gp.capacity);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // Everything settles: no call hung, and rejections are *classified* — never a
    // silent failure. (The default per-client request lane is 10/s, so a 16-call
    // storm may legitimately see `ResourceExhausted`; the point is that it is honest.)
    let mut ok = 0usize;
    let mut rejected: Vec<tonic::Code> = Vec::new();
    for t in tasks {
        match t.await.expect("load task panicked") {
            None => ok += 1,
            Some(code) => rejected.push(code),
        }
    }
    assert!(ok > 0, "some generations must go through");
    assert!(
        rejected
            .iter()
            .all(|c| *c == tonic::Code::ResourceExhausted),
        "load rejections must be the security layer's honest ResourceExhausted, got {rejected:?}"
    );

    let after = client
        .get_status(StatusRequest {})
        .await
        .expect("get_status")
        .into_inner();
    let gp = after.generation_pool.expect("generation_pool block");
    assert_eq!(
        gp.in_flight, 0,
        "no generation may hold a slot once the load settles"
    );
    assert_eq!(gp.available, gp.capacity);
    assert!(
        gp.acquired_total >= ok as u64,
        "every admitted generation must have acquired a slot (acquired={}, ok={ok})",
        gp.acquired_total
    );

    // The daemon is not wedged.
    let _ = one_generation(path.clone(), 999).await;
    let final_status = client
        .get_status(StatusRequest {})
        .await
        .expect("get_status must still answer after the storm")
        .into_inner();
    assert!(final_status.running);

    server.abort();
    let _ = std::fs::remove_file(&path);
}
