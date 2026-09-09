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
//! When started with `AMOS_NETGUARD_STATE_PATH`, the armed *intent* is persisted
//! there atomically so a toggle survives a daemon restart; enforcement and the
//! live audit counter stay runtime-only and are never fabricated from the file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use amos_network_guard::audit::{EgressCounter, EgressEvent, EgressKind};
use amos_network_guard::policy::RuleSet;
use amos_proto::amos_netguard::{
    net_guard_service_server::{NetGuardService, NetGuardServiceServer},
    EgressSample, NoteEgressReply, NoteEgressRequest, StatusReply, StatusRequest, ToggleReply,
    ToggleRequest,
};
use serde::{Deserialize, Serialize};
use tonic::{Request, Response, Status};

/// How many top egress domains `Status` reports.
const TOP_EGRESS_N: usize = 5;

/// Env var that opts a process into serving the test/demo `NoteEgress` feed RPC.
/// Off on every production boot (mirrors `AMOS_SPY_ALLOW_INJECT`).
const INJECT_ENV: &str = "AMOS_NETGUARD_ALLOW_INJECT";

/// Env var pointing at the durable state file for armed *intent* (atomic JSON).
/// Absent => the guard starts disarmed and never persists (pure in-memory).
const STATE_ENV: &str = "AMOS_NETGUARD_STATE_PATH";

/// The tonic `NetGuardService` implementation wrapping shared guard state.
pub struct NetGuardSvc {
    /// User intent: is the guard armed?
    enabled: AtomicBool,
    /// Backend name reported to callers. Default host build = in-process Mock.
    backend: &'static str,
    /// The egress policy rules the guard holds (empty until rules are configured).
    rules: Mutex<RuleSet>,
    /// Rolling egress audit counter backing `StatusReply.top_egress`.
    counter: Mutex<EgressCounter>,
    /// Whether the test/demo `NoteEgress` feed RPC is enabled (env-gated).
    allow_inject: bool,
    /// When set, armed *intent* is persisted here atomically on every toggle so
    /// it survives a daemon restart (runtime-only enforcement/audit never written).
    persist: Option<PathBuf>,
}

impl NetGuardSvc {
    /// A fresh, read-only guard (feed injection disabled) on the mock backend.
    pub fn new() -> Self {
        Self::new_with_options(false, false, None)
    }

    /// A fresh guard, optionally enabling the test/demo `NoteEgress` feed RPC.
    pub fn new_with_inject(allow_inject: bool) -> Self {
        Self::new_with_options(allow_inject, false, None)
    }

    /// A fully-configured guard: feed flag + starting armed intent + optional
    /// durable state path for intent persistence.
    pub fn new_with_options(allow_inject: bool, enabled: bool, persist: Option<PathBuf>) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            backend: "mock",
            rules: Mutex::new(RuleSet::new()),
            counter: Mutex::new(EgressCounter::new()),
            allow_inject,
            persist,
        }
    }

    /// Current armed state.
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Whether the test/demo feed RPC is enabled on this instance.
    pub fn allow_inject(&self) -> bool {
        self.allow_inject
    }

    /// Best-effort persist of the current armed *intent* (no-op without a path).
    fn persist_intent(&self) {
        if let Some(path) = &self.persist {
            persist_enabled(path, self.enabled.load(Ordering::Relaxed));
        }
    }

    /// Fold one observed egress event into the audit counter. This is the seam a
    /// real device producer (VpnService / nftables observability) calls; the
    /// env-gated `NoteEgress` RPC drives the same path for tests/demo.
    pub fn record_egress(&self, event: EgressEvent) {
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
        // Persist the *intent* so a restart keeps it; enforcement stays runtime-only.
        self.persist_intent();
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

    async fn note_egress(
        &self,
        req: Request<NoteEgressRequest>,
    ) -> Result<Response<NoteEgressReply>, Status> {
        // Feed is test/demo only: a production boot never serves it, and a denied
        // call must not mutate the audit counter.
        if !self.allow_inject {
            return Err(Status::permission_denied(format!(
                "netguard egress feed disabled (set {INJECT_ENV}=1)"
            )));
        }
        self.record_egress(event_from_req(req.into_inner()));
        Ok(Response::new(NoteEgressReply {}))
    }
}

/// Map a wire `NoteEgressRequest` onto the domain audit [`EgressEvent`] (pure).
fn event_from_req(req: NoteEgressRequest) -> EgressEvent {
    // Wire enum is carried as an `i32`; 1=DNS, 2=TLS, anything else = Other
    // (including the 0 "unspecified" default).
    let kind = match req.kind {
        1 => EgressKind::Dns,
        2 => EgressKind::Tls,
        _ => EgressKind::Other,
    };
    EgressEvent {
        ts_ms: req.ts_ms,
        uid: req.uid,
        app: req.app,
        domain: if req.domain.is_empty() {
            None
        } else {
            Some(req.domain)
        },
        bytes: req.bytes,
        kind,
    }
}

/// Parse the opt-in feed env flag. Only `"1"` or `"true"` enables it.
fn injection_env_allowed() -> bool {
    matches!(std::env::var(INJECT_ENV).as_deref(), Ok("1") | Ok("true"))
}

/// Build the guard the daemon mounts: honor the env-gated feed flag and re-hydrate
/// persisted armed *intent* from `AMOS_NETGUARD_STATE_PATH` (if any), so a toggle
/// survives a restart. Never fabricates enforcement from the file — the mock
/// backend still reports `enforced = false`.
pub fn bootstrap() -> NetGuardSvc {
    let persist = state_path_from_env();
    let enabled = persist.as_deref().map(load_state).unwrap_or(false);
    NetGuardSvc::new_with_options(injection_env_allowed(), enabled, persist)
}

/// Build the tonic server wrapper around a freshly bootstrapped guard.
pub fn server() -> NetGuardServiceServer<NetGuardSvc> {
    NetGuardServiceServer::new(bootstrap())
}

/// Resolve the durable state path from `AMOS_NETGUARD_STATE_PATH` (empty => none).
fn state_path_from_env() -> Option<PathBuf> {
    std::env::var(STATE_ENV)
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Read the persisted armed *intent* (default false on missing/corrupt file).
fn load_state(path: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<NetGuardState>(&bytes).ok())
        .map(|s| s.enabled)
        .unwrap_or(false)
}

/// Write the armed *intent* to `path` atomically; best-effort, never panics.
fn persist_enabled(path: &Path, enabled: bool) {
    match serde_json::to_vec(&NetGuardState { enabled }) {
        Ok(bytes) => {
            if let Err(e) = atomic_write(path, &bytes) {
                tracing::warn!("netguard state save failed: {e}");
            }
        }
        Err(e) => tracing::warn!("netguard state serialize failed: {e}"),
    }
}

/// On-disk snapshot of the guard's armed *intent* (atomic JSON). Fields are kept
/// minimal and stable so a rename never silently changes what we restore.
#[derive(Serialize, Deserialize)]
struct NetGuardState {
    enabled: bool,
}

/// Write `bytes` to `path` atomically: write a temp sibling, then rename over the
/// target so a crash mid-write never leaves a truncated state file.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = tmp_path_for(path);
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// A `<path>.tmp` sibling used by [`atomic_write`].
fn tmp_path_for(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
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
        s.record_egress(EgressEvent {
            ts_ms: 1,
            uid: 10,
            app: "a".into(),
            domain: Some("tracker.example".into()),
            bytes: 500,
            kind: EgressKind::Tls,
        });
        s.record_egress(EgressEvent {
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

    #[tokio::test]
    async fn note_egress_feed_is_denied_when_injection_off() {
        let s = NetGuardSvc::new(); // read-only default
        assert!(!s.allow_inject());
        let err = s
            .note_egress(Request::new(NoteEgressRequest {
                ts_ms: 1,
                uid: 10,
                app: String::new(),
                domain: "tracker.example".into(),
                bytes: 100,
                kind: 1, // DNS
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::PermissionDenied);
        // A denied feed must not mutate the audit counter.
        let reply = s
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert!(reply.top_egress.is_empty());
    }

    #[tokio::test]
    async fn note_egress_feed_populates_top_egress_when_enabled() {
        let s = NetGuardSvc::new_with_inject(true);
        assert!(s.allow_inject());
        let req = NoteEgressRequest {
            ts_ms: 1,
            uid: 10,
            app: "a".into(),
            domain: "telemetry.vendor.example".into(),
            bytes: 2500,
            kind: 2, // TLS (SNI)
        };
        s.note_egress(Request::new(req)).await.unwrap();

        let reply = s
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(reply.top_egress.len(), 1);
        assert_eq!(reply.top_egress[0].domain, "telemetry.vendor.example");
        assert_eq!(reply.top_egress[0].bytes, 2500);
    }

    use std::sync::atomic::AtomicU64;

    fn tmp_state_path(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "amos-netguard-{tag}-{n}-{}.json",
            std::process::id()
        ))
    }

    #[test]
    fn load_state_defaults_to_false_on_missing_or_garbage() {
        let missing = tmp_state_path("missing");
        let _ = std::fs::remove_file(&missing);
        assert!(!load_state(&missing), "missing file => disarmed");

        let garbage = tmp_state_path("garbage");
        std::fs::write(&garbage, "{ not json").unwrap();
        assert!(
            !load_state(&garbage),
            "corrupt file => disarmed (never crashes)"
        );
        let _ = std::fs::remove_file(&garbage);
    }

    #[tokio::test]
    async fn armed_intent_persists_and_restores_across_instances() {
        let path = tmp_state_path("roundtrip");
        let _ = std::fs::remove_file(&path);

        let s = NetGuardSvc::new_with_options(false, false, Some(path.clone()));
        s.toggle(Request::new(ToggleRequest { enabled: true }))
            .await
            .unwrap();
        assert!(
            path.exists(),
            "toggle with a state path must persist intent"
        );
        assert!(
            !tmp_path_for(&path).exists(),
            "atomic write leaves no temp sibling behind"
        );

        // A fresh daemon re-hydrates the armed intent from the same file...
        let restored = NetGuardSvc::new_with_options(false, load_state(&path), Some(path.clone()));
        assert!(restored.enabled(), "armed intent survived a restart");
        // ...but enforcement is never fabricated from the file (mock backend).
        let reply = restored
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert!(reply.enabled);
        assert!(
            !reply.enforced,
            "persisting intent must not fabricate enforcement"
        );

        let _ = std::fs::remove_file(&path);
    }
}
