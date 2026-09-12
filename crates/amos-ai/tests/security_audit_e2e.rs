//! Daemon e2e: **the security layer's own audit lands in the shared, durable
//! trail** — and `RecentTrail` reads it back.
//!
//! Before this round the security layer built a memory-only `AuditLogger`:
//! `AuditLogger::new_persistent` had no production caller and no env knob could
//! enable it, so a rate-limit rejection / permission denial vanished on restart
//! and could **never** appear in the trail RPC — even though
//! `PrivacyManager::recent_trail` documented that it reads "the shared
//! `AuditFile` that the security layer … also appends to".
//!
//! This test boots the real `serve()` with `AMOS_AUDIT_PATH` (its own test
//! binary, so the process-global env var cannot race another suite), makes the
//! daemon **refuse** a request from an ungranted client, and then checks both
//! halves of the loop: the refusal is a JSON line on disk (survives a restart)
//! *and* it is what `RecentTrail` returns.

use amos_ai::audit::{AuditFile, Outcome};
use amos_proto::ai_agent::{ai_agent_client::AiAgentClient, StatusRequest};
use amos_proto::amos_privacy::privacy_service_client::PrivacyServiceClient;
use amos_proto::amos_privacy::AuditQuery;
use amos_proto::CLIENT_ID_HEADER;
use std::path::{Path, PathBuf};
use tokio::net::UnixStream;
use tonic::metadata::MetadataValue;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

async fn channel(path: &Path) -> tonic::transport::Channel {
    let owned = path.to_owned();
    let endpoint = Endpoint::try_from("http://[::1]:50051").expect("endpoint");
    endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .expect("connect to daemon")
}

async fn wait_for_socket(path: &Path) {
    for _ in 0..200 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_request_is_persisted_and_readable_through_the_shared_trail() {
    let dir: PathBuf =
        std::env::temp_dir().join(format!("amos-ai-sec-audit-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let trail = dir.join("trail.jsonl");
    let sock = dir.join("daemon.sock");

    // The daemon resolves its shared trail from the environment once, when it
    // builds the services. This binary holds a single test, so the process-global
    // env var cannot race a sibling suite.
    std::env::set_var("AMOS_AUDIT_PATH", &trail);

    let server_sock = sock.clone();
    let server = tokio::spawn(async move {
        let _ = amos_ai::server::serve(server_sock).await;
    });
    wait_for_socket(&sock).await;
    assert!(sock.exists(), "daemon socket came up");

    // A client the daemon never granted anything → deny-by-default refusal.
    let mut ai = AiAgentClient::new(channel(&sock).await);
    let mut req = tonic::Request::new(StatusRequest {});
    req.metadata_mut()
        .insert(CLIENT_ID_HEADER, MetadataValue::from_static("intruder"));
    let refused = ai.get_status(req).await;
    assert!(
        refused.is_err(),
        "an ungranted client must be refused, not served"
    );

    // 1. It is on disk: re-read the file exactly as a restart would.
    let sink = AuditFile::open(&trail, 64).expect("reopen the audit trail");
    let records = sink.recent(16).await;
    let hit = records
        .iter()
        .find(|r| r.principal == "intruder")
        .expect("the security layer's refusal is in the durable trail");
    assert_eq!(hit.op, "probe");
    assert_eq!(hit.resource, "global");
    assert_eq!(hit.outcome, Outcome::Rejected);
    assert!(hit.details.contains("permission denied"));
    assert!(hit.ts > 0, "the daemon stamped a real time");

    // 2. And `RecentTrail` reads it back over the same socket — the loop the
    //    privacy/permissions UI needs. Before this round the security half could
    //    not be in this answer at all.
    let mut privacy = PrivacyServiceClient::new(channel(&sock).await);
    let trail_reply = privacy
        .recent_trail(AuditQuery {
            app_id: "intruder".into(),
            resource: String::new(),
            limit: 10,
        })
        .await
        .expect("read the unified trail")
        .into_inner();
    assert!(trail_reply.durable, "a shared sink is attached");
    assert!(
        trail_reply
            .records
            .iter()
            .any(|r| r.op == "probe" && r.principal == "intruder" && r.outcome == "rejected"),
        "the security-layer refusal is visible in the unified trail: {:?}",
        trail_reply.records
    );

    server.abort();
    let _ = std::fs::remove_dir_all(&dir);
}
