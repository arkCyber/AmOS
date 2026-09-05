//! Daemon e2e: a real `amos_ai::server::serve()` boot under an **overlapping**
//! `AMOS_CPUFREQ_ROOT` sysfs tree.
//!
//! `serve()` is the only boot path that reads `AMOS_CPUFREQ_ROOT` and constructs the
//! resident DVFS driver via `DvfsDriver::from_cpufreq_root(…, OverlapPolicy::Dedupe)`.
//! This file is its own test binary (own process), so setting that env var cannot
//! race the other integration tests. It asserts the observable contract at the
//! daemon boundary: an overlapping/malformed cpufreq tree must **not** crash boot —
//! the daemon still comes online and serves. The exact WARN + Dedupe-domain set for
//! that discovery is pinned in `amos-ai/src/governor.rs`
//! (`dvfs_discovery_dedupes_overlapping_policies_and_warns`).

use amos_proto::amos_governor::governor_client::GovernorClient;
use amos_proto::amos_governor::{AppRef, Empty, MoveAppRequest};
use std::path::PathBuf;
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

async fn connect(
    path: &std::path::Path,
) -> Result<GovernorClient<tonic::transport::Channel>, String> {
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
    Ok(GovernorClient::new(channel))
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn daemon_boots_and_serves_with_overlapping_cpufreq_root() {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);

    // Overlapping sysfs root: cpu0's policy claims "0 1 2" (1.8 GHz) while a stray
    // big policy on cpu2 claims "2 3" (2.5 GHz). Dedupe must keep cpu0 and drop the
    // stray cpu2 owner — and the daemon must boot regardless.
    let root = std::env::temp_dir().join(format!(
        "amos-ai-dvfs-overlap-e2e-{}-{seq}",
        std::process::id()
    ));
    for (cpu, related, max) in [(0u32, "0 1 2", 1_800_000u32), (2u32, "2 3", 2_500_000u32)] {
        let dir = root.join(format!("cpu{cpu}/cpufreq"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cpuinfo_max_freq"), format!("{max}\n")).unwrap();
        std::fs::write(dir.join("related_cpus"), related).unwrap();
        std::fs::write(dir.join("scaling_max_freq"), "999999\n").unwrap();
    }
    // Point the daemon's resident DVFS discovery at that (overlapping) root.
    std::env::set_var("AMOS_CPUFREQ_ROOT", &root);

    let path: PathBuf = std::env::temp_dir().join(format!("amos-ai-dvfs-overlap-e2e-{seq}.sock",));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });

    wait_for_socket(&path).await;
    let mut client = connect(&path).await.expect("connect to daemon");

    // Exercise the governor surface to prove the daemon is alive + serving under the
    // overlapping topology (register + move round-trip over the UDS).
    client
        .register_app(AppRef {
            app_id: "photos".to_string(),
        })
        .await
        .expect("register_app");
    client
        .move_app(MoveAppRequest {
            app_id: "photos".to_string(),
            to: 2, // APP_STATE_BACKGROUND
        })
        .await
        .expect("move_app");
    let state = client
        .get_state(Empty {})
        .await
        .expect("get_state")
        .into_inner();
    assert_eq!(
        state.apps.len(),
        1,
        "daemon served after overlap-tolerant boot"
    );
    assert_eq!(state.apps[0].state, 2); // BACKGROUND

    // Clean shutdown + remove the socket and temp sysfs tree.
    server.abort();
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir_all(&root);
    std::env::remove_var("AMOS_CPUFREQ_ROOT");
}
