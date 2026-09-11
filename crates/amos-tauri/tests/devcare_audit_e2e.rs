//! Headless end-to-end: the device-care bridge's **hop to a real daemon**.
//!
//! This is the link neither the bridge unit tests (which stop at the events and
//! the rows) nor the daemon e2e (which drives the generated client directly)
//! prove: the *actual* Tauri-side functions the UI calls, against a *real*
//! `amos-ai` PrivacyService on a UDS with a *real* `AMOS_PRIVACY_PATH`.
//!
//! ```text
//!   devcare::record_audit(&events)            ← the bridge entry point
//!        → privacy_client::perm_record_audit  ← the real gRPC client
//!        → PrivacyService.RecordAudit         ← the real daemon
//!        → amos-ai::audit::AuditFile          ← the real JSON-lines file
//!   privacy_client::perm_recent_trail(...)    ← the read side the UI uses
//!   privacy_client::perm_grants_all()         ← the permission *authority*
//!        → devcare::permission_review_from    ← the domain shapes the review
//! ```
//!
//! Then it checks the bytes on disk. No GUI, no WebView, and no mock on either
//! side of the wire.
//!
//! Own test binary/process: the socket path and `AMOS_PRIVACY_PATH` are
//! process-global env vars, so this must not share a binary with other tests.

use amos_ai::privacy_service;
use amos_devocare::audit;
use amos_devocare::{CleanFailure, CleanOutcome, JunkItem, JunkKind, UninstallVerdict};
use amos_tauri_lib::{devcare, privacy_client};
use tokio_stream::wrappers::UnixListenerStream;

/// A principal that never acted — used to prove the actor filter works.
const OTHER_ACTOR: &str = "com.example.other";

/// The trail shapes that must be distinguishable: an aggregate clean, a
/// failed item, a **refused** uninstall, and a memory boost (aggregate + a
/// failed reclaim) — every device-care op that must survive the real wire.
fn care_events() -> Vec<audit::CareAuditEvent> {
    let outcome = CleanOutcome {
        removed: vec![JunkItem::new("/root/a.log", JunkKind::LogFile, 100)],
        freed_bytes: 100,
        failures: vec![CleanFailure {
            uri: "/root/b.log".to_string(),
            kind: JunkKind::LogFile,
            size_bytes: 50,
            message: "locked".to_string(),
        }],
    };
    let mut events = audit::clean_events(audit::ACTOR, &[JunkKind::LogFile], &outcome);
    events.push(audit::uninstall_refused(
        audit::ACTOR,
        "com.android.settings",
        UninstallVerdict::Protected,
    ));
    // The boost ops go through the same daemon: a partial boost (1 of 2
    // reclaimed) must land as `error` on the real wire, not just in unit tests.
    let requested = vec!["com.bg".to_string(), "com.stuck".to_string()];
    let attempts = vec![
        audit::BoostReclaim {
            id: "com.bg".to_string(),
            ok: true,
            message: String::new(),
        },
        audit::BoostReclaim {
            id: "com.stuck".to_string(),
            ok: false,
            message: "governor refused".to_string(),
        },
    ];
    events.extend(audit::boost_events(audit::ACTOR, &requested, &attempts));
    events
}

#[tokio::test(flavor = "multi_thread")]
async fn the_bridge_talks_to_a_real_daemon_end_to_end() {
    let dir = std::env::temp_dir().join(format!("amos-devcare-audit-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let state = dir.join("privacy.json");
    let sock = dir.join("daemon.sock");

    // `bootstrap()` reads these, so set them before building the service.
    std::env::set_var("AMOS_SOCKET", &sock);
    std::env::set_var("AMOS_PRIVACY_PATH", &state);

    let (manager, persist) = privacy_service::bootstrap();
    assert!(
        persist.is_some(),
        "AMOS_PRIVACY_PATH is set ⇒ the daemon has a durable sink"
    );

    let listener = tokio::net::UnixListener::bind(&sock).expect("bind uds");
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(privacy_service::server(manager, persist))
            .serve_with_incoming(UnixListenerStream::new(listener))
            .await
            .expect("serve privacy service");
    });
    for _ in 0..200 {
        if tokio::net::UnixStream::connect(&sock).await.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    // 1. The bridge writes through the real client to the real daemon.
    let status = devcare::record_audit(&care_events()).await;
    assert_eq!(
        status.attempted, 5,
        "clean aggregate + failed item + refusal + boost aggregate + boost item"
    );
    assert_eq!(
        status.recorded, 5,
        "all persisted (reason: {:?})",
        status.reason
    );
    assert!(status.reason.is_none(), "no degradation expected");

    // 2. …and reads it back through the same path the UI uses.
    let trail = privacy_client::perm_recent_trail(Some(audit::ACTOR.to_string()), None, 10)
        .await
        .expect("read the trail over the bridge");
    assert!(trail.durable, "the daemon has a durable sink");
    assert_eq!(trail.records.len(), 5, "newest first");
    assert_eq!(trail.records[0].op, audit::OP_BOOST_ITEM);
    assert_eq!(trail.records[0].resource, "com.stuck");
    assert_eq!(trail.records[0].outcome, "error");
    assert_eq!(trail.records[1].op, audit::OP_BOOST);
    assert_eq!(
        trail.records[1].outcome, "error",
        "a partial boost is never recorded as a success"
    );
    assert!(
        trail.records[1].details.contains("requested=2")
            && trail.records[1].details.contains("attempted=2")
            && trail.records[1].details.contains("reclaimed=1")
            && trail.records[1].details.contains("failed=1"),
        "the boost aggregate accounts for every request: {}",
        trail.records[1].details
    );
    assert_eq!(trail.records[2].op, audit::OP_UNINSTALL);
    assert_eq!(trail.records[2].outcome, "rejected");
    assert_eq!(trail.records[2].resource, "com.android.settings");
    assert_eq!(trail.records[3].op, "devcare.clean.item");
    assert_eq!(trail.records[4].op, audit::OP_CLEAN);
    assert_eq!(
        trail.records[4].outcome, "error",
        "a partially failed clean is never recorded as a success"
    );
    assert!(trail.records.iter().all(|r| r.principal == audit::ACTOR));

    // 3. The actor filter really filters (no other principal's records leak in).
    let other = privacy_client::perm_recent_trail(Some(OTHER_ACTOR.to_string()), None, 10)
        .await
        .expect("read another principal's slice");
    assert!(other.records.is_empty());

    // 4. The permission review reads the **daemon authority**, not a local cache.
    let none_yet = privacy_client::perm_grants_all().await.expect("grants-all");
    assert!(none_yet.is_empty(), "deny-by-default ⇒ nothing is granted");
    assert!(devcare::permission_review_from(&none_yet).is_empty());

    privacy_client::perm_grant("com.amos.phone".to_string(), "microphone".to_string())
        .await
        .expect("grant the mic");
    privacy_client::perm_grant("com.amos.camera".to_string(), "camera".to_string())
        .await
        .expect("grant the camera");

    let granted = privacy_client::perm_grants_all().await.expect("grants-all");
    let review = devcare::permission_review_from(&granted);
    assert_eq!(review.len(), 2, "only holders, sorted by app id");
    assert_eq!(review[0].app_id, "com.amos.camera");
    assert_eq!(review[0].resources, vec!["camera".to_string()]);
    assert_eq!(review[1].app_id, "com.amos.phone");
    assert_eq!(review[1].resources, vec!["microphone".to_string()]);

    // 5. The bytes are on disk, daemon-stamped, one JSON object per line.
    let raw = std::fs::read_to_string(state.with_extension("jsonl")).expect("audit file exists");
    let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(lines.len(), 5, "5 JSON-lines records: {raw}");
    assert!(lines.iter().all(|l| l.starts_with('{')));
    assert!(lines
        .iter()
        .any(|l| l.contains("devcare.clean") && l.contains("com.amos.devocare")));
    assert!(
        lines.iter().any(|l| l.contains("devcare.boost")),
        "the boost ops persist to the same file: {raw}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.contains("governor refused") && l.contains("com.stuck")),
        "the failed reclaim lands item by item: {raw}"
    );
    assert!(
        lines.iter().any(|l| l.contains("\"rejected\"")),
        "the refusal is persisted, not just returned: {raw}"
    );
    // The daemon stamps the time (the bridge sends ts = 0 as a placeholder).
    assert!(
        !lines.iter().any(|l| l.contains("\"ts\":0")),
        "the daemon must stamp its own timestamp: {raw}"
    );

    std::env::remove_var("AMOS_SOCKET");
    std::env::remove_var("AMOS_PRIVACY_PATH");
    let _ = std::fs::remove_dir_all(&dir);
    server.abort();
}
