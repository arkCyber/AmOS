//! Daemon e2e: the OS-permissions (PrivacyManager) gRPC service over a real UDS.
//!
//! Boots the real `amos_ai::server::serve()` (own test binary / process so its
//! socket name can't race the other integration tests), then drives the
//! generated `PrivacyServiceClient` to prove the daemon is the authoritative
//! grant/revoke/ask/audit surface: grant a mic, Authorize → granted, a different
//! resource → denied (deny-by-default), and the decision shows up in RecentAudit.
//!
//! Honest scope: `serve()` here is fresh/in-memory (no `AMOS_PRIVACY_PATH`), so
//! grants don't survive this test — persistence is pinned by unit tests in
//! `amos-ai/src/privacy.rs` (save/load) and `privacy_service.rs`.

use amos_proto::amos_privacy::privacy_service_client::PrivacyServiceClient;
use amos_proto::amos_privacy::{AppRef, AuditQuery, GrantRequest, ResourceRef};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

static SEQ: AtomicU64 = AtomicU64::new(0);

async fn connect(
    path: &std::path::Path,
) -> Result<PrivacyServiceClient<tonic::transport::Channel>, String> {
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
    Ok(PrivacyServiceClient::new(channel))
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..200 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn privacy_service_authorizes_and_audits_over_uds() {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let path: PathBuf = std::env::temp_dir().join(format!("amos-ai-privacy-rpc-e2e-{seq}.sock"));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });

    wait_for_socket(&path).await;
    assert!(path.exists(), "daemon socket came up");

    let mut client = connect(&path).await.expect("connect to daemon");

    // Unknown resource keys are rejected — deny-by-default is never weakened.
    let bad = client
        .authorize(ResourceRef {
            app_id: "com.x".into(),
            resource: "barometer".into(),
        })
        .await;
    assert!(bad.is_err(), "unknown resource key must be rejected");

    // Grant mic to an app, then verify the decision.
    client
        .grant(GrantRequest {
            app_id: "com.amos.phone".into(),
            resource: "microphone".into(),
        })
        .await
        .expect("grant mic");

    let mic = client
        .authorize(ResourceRef {
            app_id: "com.amos.phone".into(),
            resource: "microphone".into(),
        })
        .await
        .expect("authorize mic")
        .into_inner();
    assert!(mic.granted, "granted mic is accessible");

    let cam = client
        .authorize(ResourceRef {
            app_id: "com.amos.phone".into(),
            resource: "camera".into(),
        })
        .await
        .expect("authorize camera")
        .into_inner();
    assert!(!cam.granted, "camera is deny-by-default");

    // Granted() reflects the single grant, sorted.
    let grants = client
        .granted(AppRef {
            app_id: "com.amos.phone".into(),
        })
        .await
        .expect("list grants")
        .into_inner();
    assert_eq!(grants.resources, vec!["microphone".to_string()]);

    // RecentAudit shows both decisions, newest first.
    let audit = client
        .recent_audit(AuditQuery {
            app_id: "com.amos.phone".into(),
            resource: String::new(),
            limit: 10,
        })
        .await
        .expect("recent audit")
        .into_inner();
    assert_eq!(audit.records.len(), 2, "both decisions audited");
    assert_eq!(audit.records[0].outcome, "denied"); // camera (newest)
    assert_eq!(audit.records[1].outcome, "granted"); // mic

    let _ = std::fs::remove_file(&path);
    server.abort();
}
