//! Daemon e2e: the passive telemetry-spy `Watch` stream over a real UDS.
//!
//! Boots the real `amos_ai::server::serve()` (own test binary so its socket name
//! can't race the other integration tests) with `AMOS_SPY_ALLOW_INJECT=1`, then:
//! opens a `TelemetrySpyService.Watch` subscription, publishes a synthetic hit
//! via `SimulateHit`, and asserts that hit arrives on the Watch stream. This
//! proves the full daemon → System-UI gRPC push path end to end over the shared
//! socket (the Rust `amos-tauri` bridge + frontend consume the same stream).
//!
//! Honest scope: `SimulateHit` is a test/demo injection that the daemon only
//! serves when explicitly opted in via the env var (off on every production
//! boot — see `proto/telemetry_spy.proto` + `telemetry_spy_service.rs`). The
//! real pnet capture producer feeding `TelemetrySpySvc::emit` is a device/AOSP
//! step; this test drives the same emit path it would use.

use amos_proto::amos_telemetry_spy::telemetry_spy_service_client::TelemetrySpyServiceClient;
use amos_proto::amos_telemetry_spy::{
    Confidence, EgressHit, Empty, IdentifierHit, IdentifierKind, Protocol,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

static SEQ: AtomicU64 = AtomicU64::new(0);

async fn connect(
    path: &std::path::Path,
) -> Result<TelemetrySpyServiceClient<tonic::transport::Channel>, String> {
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
    Ok(TelemetrySpyServiceClient::new(channel))
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..200 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

fn hit(ts_ms: u64) -> EgressHit {
    EgressHit {
        ts_ms,
        iface: "rmnet_data0".into(),
        src_ip: "10.0.0.2".into(),
        src_port: Some(53000),
        dst_ip: "203.0.113.9".into(),
        dst_port: Some(53),
        protocol: Protocol::Udp as i32,
        hits: vec![IdentifierHit {
            kind: IdentifierKind::KindImei as i32,
            occurrences: 1,
            confidence: Confidence::High as i32,
        }],
        payload_bytes: 40,
        severity: "high".into(),
        confidence: Confidence::High as i32,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn telemetry_spy_watch_delivers_an_injected_hit_over_uds() {
    // Opt in to the test/demo injection RPC for this process only. `serve()`
    // reads the flag when it constructs the telemetry service (after this).
    std::env::set_var("AMOS_SPY_ALLOW_INJECT", "1");

    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let path: PathBuf = std::env::temp_dir().join(format!("amos-ai-telemetry-spy-e2e-{seq}.sock"));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });

    wait_for_socket(&path).await;
    assert!(path.exists(), "daemon socket came up");

    let mut client = connect(&path).await.expect("connect to daemon");

    // Open the Watch subscription before injecting so the hit is delivered here.
    let mut stream = client
        .watch(Empty {})
        .await
        .expect("open telemetry-spy Watch")
        .into_inner();

    // Inject a synthetic high-severity hit through the daemon's emit path.
    client
        .simulate_hit(hit(20260909))
        .await
        .expect("SimulateHit should be allowed with AMOS_SPY_ALLOW_INJECT=1");

    let got = tokio::time::timeout(std::time::Duration::from_secs(5), stream.message())
        .await
        .expect("should receive a hit within the timeout")
        .expect("watch stream should not error")
        .expect("should not end before a hit");
    assert_eq!(got.ts_ms, 20260909);
    assert_eq!(got.iface, "rmnet_data0");
    assert_eq!(got.severity, "high");
    assert_eq!(got.hits.len(), 1);
    assert_eq!(got.hits[0].kind, IdentifierKind::KindImei as i32);

    let _ = std::fs::remove_file(&path);
    server.abort();
}
