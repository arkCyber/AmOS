//! gRPC `NetGuardService` exposing the egress network-guard over the shared UDS
//! (proto `amos_netguard`, `proto/netguard.proto`).
//!
//! Follows the `privacy_service` / `governor_service` pattern: the service holds a
//! small, shared guard state (armed intent + a policy [`RuleSet`] + an egress
//! [`EgressCounter`]) and maps tonic RPCs onto the `amos-network-guard` domain
//! core, so the System UI can arm/disarm and read a status + audit summary.
//!
//! Honest boundaries (see `docs/anti-telemetry-egress-guard.md` §3.1/§3.2): the
//! default host build backs the guard with the **in-process Mock**, so
//! `StatusReply.enforced` is **false** and arming records **intent**, not an actual
//! firewall rule. Real enforcement is a device/AOSP step — the rootless
//! `VpnService` path or an AOSP/rooted nftables path (`amos-network-guard`
//! features `vpn` / `nftables`). No code here claims to "block" traffic it cannot.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use amos_network_guard::audit::EgressCounter;
use amos_network_guard::policy::RuleSet;
use amos_proto::amos_netguard::{
    net_guard_service_server::{NetGuardService, NetGuardServiceServer},
    EgressSample, StatusReply, StatusRequest, ToggleReply, ToggleRequest,
};
use tonic::{Request, Response, Status};

/// How many top egress domains `Status` reports.
const TOP_EGRESS_N: usize = 5;

/// The tonic `NetGuardService` implementation wrapping shared guard state.
pub struct NetGuardSvc {
    /// User intent: is the guard armed?
    enabled: AtomicBool,
    /// Backend name reported to callers. Default host build = in-process Mock.
    backend: &'static str,
    /// The egress policy rules the guard holds (empty until rules are configured).
    rules: Mutex<RuleSet>,
    /// Rolling egress audit counter (empty until a capture feed is wired).
    counter: Mutex<EgressCounter>,
}

impl NetGuardSvc {
    /// A fresh, disarmed guard on the (not-yet-enforcing) mock backend.
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            backend: "mock",
            rules: Mutex::new(RuleSet::new()),
            counter: Mutex::new(EgressCounter::new()),
        }
    }

    /// Current armed state.
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Fold one observed egress event into the audit counter (daemon capture feed).
    pub fn note_egress(&self, event: amos_network_guard::EgressEvent) {
        lock(&self.counter).record(&event);
    }
}

impl Default for NetGuardSvc {
    fn default() -> Self {
        Self::new()
    }
}

#[tonic::async_trait]
impl NetGuardService for NetGuardSvc {
    async fn toggle(&self, req: Request<ToggleRequest>) -> Result<Response<ToggleReply>, Status> {
        let enabled = req.into_inner().enabled;
        self.enabled.store(enabled, Ordering::Relaxed);
        let message = if enabled {
            "guard armed (intent recorded); backend=mock — not enforced (device/AOSP step)"
                .to_string()
        } else {
            "guard disarmed".to_string()
        };
        Ok(Response::new(ToggleReply { enabled, message }))
    }

    async fn status(&self, _req: Request<StatusRequest>) -> Result<Response<StatusReply>, Status> {
        let top_egress: Vec<EgressSample> = lock(&self.counter)
            .top_domains(TOP_EGRESS_N)
            .into_iter()
            .map(|(domain, bytes)| EgressSample { domain, bytes })
            .collect();
        Ok(Response::new(StatusReply {
            enabled: self.enabled.load(Ordering::Relaxed),
            backend: self.backend.to_string(),
            // Only a real enforcement backend reports `enforced = true`; the
            // default Mock never lies about blocking traffic.
            enforced: false,
            policy_rules: lock(&self.rules).len() as u64,
            top_egress,
        }))
    }
}

/// Build the tonic server wrapper around a fresh guard.
pub fn server() -> NetGuardServiceServer<NetGuardSvc> {
    NetGuardServiceServer::new(NetGuardSvc::new())
}

/// Lock a `Mutex`, recovering from poison instead of panicking (P0-1 gate).
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_network_guard::audit::{EgressEvent, EgressKind};

    async fn svc() -> NetGuardSvc {
        NetGuardSvc::new()
    }

    #[tokio::test]
    async fn fresh_guard_is_disarmed_on_mock_backend() {
        let s = svc().await;
        let reply = s
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert!(!reply.enabled);
        assert_eq!(reply.backend, "mock");
        assert!(!reply.enforced, "mock backend must never report enforced");
        assert_eq!(reply.policy_rules, 0);
        assert!(reply.top_egress.is_empty());
    }

    #[tokio::test]
    async fn toggle_records_intent_and_never_claims_enforcement() {
        let s = svc().await;
        let on = s
            .toggle(Request::new(ToggleRequest { enabled: true }))
            .await
            .unwrap()
            .into_inner();
        assert!(on.enabled);
        assert!(
            on.message.contains("mock"),
            "arming on the mock backend must be honest about not enforcing"
        );

        let reply = s
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert!(reply.enabled);
        assert!(!reply.enforced);

        let off = s
            .toggle(Request::new(ToggleRequest { enabled: false }))
            .await
            .unwrap()
            .into_inner();
        assert!(!off.enabled);
    }

    #[tokio::test]
    async fn audit_counter_is_reflected_in_status() {
        let s = svc().await;
        s.note_egress(EgressEvent {
            ts_ms: 1,
            uid: 10,
            app: "a".into(),
            domain: Some("tracker.example".into()),
            bytes: 500,
            kind: EgressKind::Tls,
        });
        s.note_egress(EgressEvent {
            ts_ms: 2,
            uid: 10,
            app: "a".into(),
            domain: Some("cdn.example".into()),
            bytes: 100,
            kind: EgressKind::Dns,
        });
        let reply = s
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        let first = &reply.top_egress[0];
        assert_eq!(first.domain, "tracker.example");
        assert_eq!(first.bytes, 500);
    }
}
