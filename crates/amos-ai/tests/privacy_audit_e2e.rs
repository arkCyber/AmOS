//! Daemon e2e: **device-care audit ingest over a real UDS, onto real disk**.
//!
//! Boots the real `amos_ai::server::serve()` with `AMOS_PRIVACY_PATH` set (its own
//! test binary/process, so the env var and the socket name cannot race the other
//! integration tests), then drives `RecordAudit` exactly as the Tauri bridge
//! does — proving the daemon genuinely appends device-care actions to the
//! **unified durable sink** rather than only holding them in memory.
//!
//! The honest boundary this pins: the record's timestamp is the **daemon's**, an
//! unknown outcome is rejected over the wire, and the bytes really are in the
//! JSON-lines file (re-read through `AuditFile::open`, i.e. as a restart would).

use amos_ai::audit::{AuditFile, Outcome};
use amos_proto::amos_privacy::privacy_service_client::PrivacyServiceClient;
use amos_proto::amos_privacy::{AuditQuery, AuditRecord, GrantRequest};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

static SEQ: AtomicU64 = AtomicU64::new(0);

async fn connect(path: &Path) -> Result<PrivacyServiceClient<tonic::transport::Channel>, String> {
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

async fn wait_for_socket(path: &Path) {
    for _ in 0..200 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

fn device_care_record(op: &str, resource: &str, outcome: &str, details: &str) -> AuditRecord {
    AuditRecord {
        ts: 0, // ignored: the daemon stamps its own clock
        principal: "com.amos.devocare".to_string(),
        op: op.to_string(),
        resource: resource.to_string(),
        outcome: outcome.to_string(),
        details: details.to_string(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn device_care_actions_are_persisted_to_the_unified_sink_over_uds() {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!("amos-ai-audit-e2e-{seq}"));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let state = dir.join("privacy.json");
    let sock = dir.join("daemon.sock");
    let audit_path = state.with_extension("jsonl");

    // The durable sink only exists when the daemon is told where its privacy
    // state lives; the test binary owns this env var.
    std::env::set_var("AMOS_PRIVACY_PATH", &state);

    let server_sock = sock.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_sock).await.unwrap();
    });
    wait_for_socket(&sock).await;
    assert!(sock.exists(), "daemon socket came up");

    let mut client = connect(&sock).await.expect("connect to daemon");

    // The service is otherwise the usual one (sanity check the socket is live).
    client
        .grant(GrantRequest {
            app_id: "com.amos.phone".into(),
            resource: "microphone".into(),
        })
        .await
        .expect("grant over the same channel");

    // 1. A clean is recorded.
    let clean_reply = client
        .record_audit(device_care_record(
            "devcare.clean",
            "app_cache,apk_installer,log_file",
            "success",
            "planned=3 freed_bytes=175 removed=3 failed=0",
        ))
        .await
        .expect("record a clean")
        .into_inner();
    assert!(clean_reply.ok, "a durable sink is configured ⇒ recorded");

    // 2. A *refused* uninstall is recorded too — refusals must be visible.
    let refused = client
        .record_audit(device_care_record(
            "app.uninstall",
            "com.android.settings",
            "rejected",
            "protected",
        ))
        .await
        .expect("record a refusal")
        .into_inner();
    assert!(refused.ok);

    // 3. An unknown outcome is rejected over the wire (never guessed).
    let bad = client
        .record_audit(device_care_record(
            "devcare.clean",
            "app_cache",
            "maybe",
            "",
        ))
        .await;
    assert!(bad.is_err(), "unknown outcome must be rejected");

    // 4. The bytes are really on disk, daemon-stamped — re-read as a restart would.
    let sink = AuditFile::open(&audit_path, 64).expect("reopen the audit log");
    let recent = sink.recent(10).await;
    assert_eq!(recent.len(), 2, "both device-care records persisted");
    assert_eq!(recent[0].op, "app.uninstall");
    assert_eq!(recent[0].principal, "com.amos.devocare");
    assert_eq!(
        recent[0].outcome,
        Outcome::Rejected,
        "the refusal is visible"
    );
    assert_eq!(recent[0].details, "protected");
    assert_eq!(recent[1].op, "devcare.clean");
    assert_eq!(recent[1].outcome, Outcome::Success);
    assert!(recent[1].ts > 0, "the daemon stamped a real time");
    assert_eq!(recent[1].resource, "app_cache,apk_installer,log_file");

    // 5. The trail **reads back** over the same UDS — the loop the manager UI
    //    needs — newest first, filtered by the device-care principal.
    let trail = client
        .recent_trail(AuditQuery {
            app_id: "com.amos.devocare".into(),
            resource: String::new(),
            limit: 10,
        })
        .await
        .expect("read the unified trail")
        .into_inner();
    assert!(trail.durable, "a sink is attached");
    assert_eq!(trail.records.len(), 2);
    assert_eq!(trail.records[0].op, "app.uninstall");
    assert_eq!(trail.records[0].outcome, "rejected");
    assert_eq!(trail.records[1].op, "devcare.clean");
    assert_eq!(trail.records[1].outcome, "success");
    assert!(trail
        .records
        .iter()
        .all(|r| r.principal == "com.amos.devocare"));

    std::env::remove_var("AMOS_PRIVACY_PATH");
    let _ = std::fs::remove_dir_all(&dir);
    server.abort();
}
