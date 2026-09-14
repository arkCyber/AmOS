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
//!   either side leaves the UI reading `undefined` with no error anywhere.

use std::path::PathBuf;

use amos_tauri_lib::link::link_status;
use tokio_stream::wrappers::UnixListenerStream;

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

    // The exact key set `lib/link.ts`'s `LinkStatus` interface promises.
    let json = serde_json::to_value(&status).expect("serialize the snapshot");
    let obj = json.as_object().expect("a JSON object");
    let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
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
