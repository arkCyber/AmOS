//! Daemon e2e: the egress network-guard `Toggle` / `Status` / audit feed /
//! app-egress declarations over a real UDS.
//!
//! Boots the real `amos_ai::server::serve()` (own test binary so its socket name
//! can't race the other integration tests) with `AMOS_NETGUARD_ALLOW_INJECT=1`,
//! then drives the `NetGuardService` client: asserts a fresh guard is disarmed and
//! honest (`backend=mock`, `enforced=false`), that arming records intent without
//! ever claiming enforcement, and that folding metadata egress events through the
//! env-gated `NoteEgress` feed is reflected in `Status.top_egress`. This proves
//! the daemon → System-UI gRPC path the `amos-tauri` bridge + `NetGuardPage`
//! consume, including the audit counter that backs the "Top egress" list.
//!
//! Honest scope: `NoteEgress` is a test/demo feed that the daemon only serves when
//! explicitly opted in via the env var (off on every production boot — see
//! `proto/netguard.proto` + `netguard_service.rs`). A real device producer
//! (VpnService / nftables observability) feeds the same counter directly and
//! needs no RPC. With `AMOS_NETGUARD_STATE_PATH` set, `serve()` also persists the
//! armed *intent* atomically, so the toggle survives a daemon restart; this test
//! asserts the state file is written through the real boot path.

use amos_proto::amos_netguard::net_guard_service_client::NetGuardServiceClient;
use amos_proto::amos_netguard::net_guard_service_server::NetGuardService;
use amos_proto::amos_netguard::{
    NoteEgressRequest, RevokeAppEgressRequest, SetAppEgressRequest, StatusRequest, ToggleRequest,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

static SEQ: AtomicU64 = AtomicU64::new(0);

async fn connect(
    path: &std::path::Path,
) -> Result<NetGuardServiceClient<tonic::transport::Channel>, String> {
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
    Ok(NetGuardServiceClient::new(channel))
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
async fn netguard_toggle_status_and_audit_feed_over_uds() {
    // Opt in to the test/demo feed RPC and give the daemon a durable intent path.
    // `serve()` reads both env vars when it constructs the netguard service.
    std::env::set_var("AMOS_NETGUARD_ALLOW_INJECT", "1");

    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let path: PathBuf = std::env::temp_dir().join(format!("amos-ai-netguard-e2e-{seq}.sock"));
    let _ = std::fs::remove_file(&path);
    let state_path: PathBuf = std::env::temp_dir().join(format!("amos-ai-netguard-e2e-{seq}.json"));
    let _ = std::fs::remove_file(&state_path);
    std::env::set_var("AMOS_NETGUARD_STATE_PATH", &state_path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });

    wait_for_socket(&path).await;
    assert!(path.exists(), "daemon socket came up");

    let mut client = connect(&path).await.expect("connect to daemon");

    // Fresh guard: disarmed, mock backend, never enforced, no audit yet.
    let fresh = client
        .status(StatusRequest {})
        .await
        .expect("status")
        .into_inner();
    assert!(!fresh.enabled);
    assert_eq!(fresh.backend, "mock");
    assert!(!fresh.enforced, "mock backend must never report enforced");
    assert!(fresh.top_egress.is_empty());

    // Arming records intent on the mock backend — it must not claim enforcement.
    let on = client
        .toggle(ToggleRequest { enabled: true })
        .await
        .expect("arm")
        .into_inner();
    assert!(on.enabled);
    let armed = client
        .status(StatusRequest {})
        .await
        .expect("status")
        .into_inner();
    assert!(armed.enabled);
    assert!(
        !armed.enforced,
        "arming on the mock backend never fabricates a block"
    );
    // The armed *intent* was persisted (durable state path was set for serve()).
    let persisted = std::fs::read_to_string(&state_path).expect("state file written");
    assert!(
        persisted.contains("\"enabled\":true"),
        "toggle persisted armed intent, got: {persisted}"
    );

    // Feed metadata egress events through the env-gated NoteEgress path.
    client
        .note_egress(NoteEgressRequest {
            ts_ms: 1,
            uid: 1000,
            app: "com.amos.phone".into(),
            domain: "telemetry.vendor.example".into(),
            bytes: 2500,
            kind: 2, // TLS (SNI)
        })
        .await
        .expect("NoteEgress should be allowed with AMOS_NETGUARD_ALLOW_INJECT=1");
    client
        .note_egress(NoteEgressRequest {
            ts_ms: 2,
            uid: 2000,
            app: "com.amos.mail".into(),
            domain: "cdn.example".into(),
            bytes: 1000,
            kind: 1, // DNS
        })
        .await
        .expect("second NoteEgress");

    let after = client
        .status(StatusRequest {})
        .await
        .expect("status")
        .into_inner();
    assert!(
        !after.top_egress.is_empty(),
        "audit feed populated top_egress"
    );
    // Top domain is the higher-bytes destination.
    assert_eq!(after.top_egress[0].domain, "telemetry.vendor.example");
    assert_eq!(after.top_egress[0].bytes, 2500);

    // App egress declarations over the real UDS: an app with its own uid
    // contributes rules, a shared-uid bundle is recorded without one, and a
    // revoke drops exactly that app. This is the path the PWA opener uses.
    let declared = client
        .set_app_egress(SetAppEgressRequest {
            app_id: "org.amos.phone".into(),
            uid: 10_123,
            allow_domains: vec!["api.example.com".into(), "cdn.example.org".into()],
        })
        .await
        .expect("SetAppEgress")
        .into_inner();
    assert_eq!(declared.policy_rules, 2);
    assert_eq!(declared.declared_apps, 1);

    let shared = client
        .set_app_egress(SetAppEgressRequest {
            app_id: "org.amos.pwa".into(),
            uid: 0,
            allow_domains: vec!["api.example.com".into()],
        })
        .await
        .expect("SetAppEgress (shared uid)")
        .into_inner();
    assert_eq!(
        shared.policy_rules, 2,
        "a uid-0 bundle adds no rule (it cannot be isolated at the packet layer)"
    );
    assert_eq!(shared.declared_apps, 2, "but its declaration is recorded");

    // A malformed host is refused at the seam, not stored.
    let refused = client
        .set_app_egress(SetAppEgressRequest {
            app_id: "org.amos.bad".into(),
            uid: 7,
            allow_domains: vec!["*.example.com".into()],
        })
        .await
        .expect_err("a wildcard host is not in the allow-list grammar");
    assert_eq!(refused.code(), tonic::Code::InvalidArgument);

    let revoked = client
        .revoke_app_egress(RevokeAppEgressRequest {
            app_id: "org.amos.phone".into(),
        })
        .await
        .expect("RevokeAppEgress")
        .into_inner();
    assert_eq!(revoked.policy_rules, 0, "the phone app's rules are gone");
    assert_eq!(
        revoked.declared_apps, 1,
        "the shared-uid declaration remains"
    );

    let final_status = client
        .status(StatusRequest {})
        .await
        .expect("status")
        .into_inner();
    assert_eq!(final_status.policy_rules, 0);
    assert_eq!(final_status.declared_apps, 1);
    // Recording declarations never turns into an enforcement claim.
    assert!(
        !final_status.enforced,
        "mock backend still does not enforce"
    );

    // A reboot: the daemon persisted intent *and* the declared registry to
    // `AMOS_NETGUARD_STATE_PATH`. The same `bootstrap()` `serve()` uses restores
    // both — the shared-uid declaration comes back (re-validated), still as a
    // declaration and never a rule, and enforcement is still not fabricated.
    let rebooted = amos_ai::netguard_service::bootstrap();
    assert!(rebooted.enabled(), "armed intent survived the restart");
    let restored = rebooted
        .status(tonic::Request::new(StatusRequest {}))
        .await
        .expect("status")
        .into_inner();
    assert_eq!(
        restored.declared_apps, 1,
        "the shared-uid declaration was restored from disk"
    );
    assert_eq!(
        restored.policy_rules, 0,
        "uid-0 restores as a declaration, never a fabricated rule"
    );
    assert!(
        !restored.enforced,
        "a restart never fabricates enforcement from the file"
    );

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&state_path);
    server.abort();
}
