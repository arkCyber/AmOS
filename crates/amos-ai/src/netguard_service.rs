//! gRPC `NetGuardService` exposing the egress network-guard over the shared UDS
//! (proto `amos_netguard`, `proto/netguard.proto`).
//!
//! Follows the `privacy_service` / `governor_service` pattern: the service holds a
//! small, shared guard state (armed intent + a policy [`RuleSet`] + an egress
//! [`EgressCounter`]) **and an instantiated [`NetworkGuard`] seam**, and maps tonic
//! RPCs onto the `amos-network-guard` domain core, so the System UI can arm/disarm
//! and read a status + audit summary. Arming drives [`NetworkGuard::apply`] and
//! disarming drives [`NetworkGuard::flush`]; `StatusReply.enforced` is the
//! backend's own [`NetworkGuard::enforces`] claim, so it reads `false` for the
//! default mock (a real `VpnService` / nftables backend overrides it once wired).
//!
//! `SetAppEgress` / `RevokeAppEgress` hold each app's declared egress (the hosts
//! an installed bundle says it may reach) and flatten it into the guard's rule
//! set, so `StatusReply.policy_rules` / `declared_apps` are real measurements. A
//! declaration is not an enforcement claim: an app with `uid == 0` (a shared-uid
//! hosted bundle) is recorded but contributes no rule, because `Policy` is
//! uid-scoped and one uid cannot isolate one bundle from another.
//!
//! Honest boundaries (see `docs/anti-telemetry-egress-guard.md` §3.1/§3.2): the
//! default host build backs the guard with the **in-process Mock**, so
//! `StatusReply.enforced` is **false** and arming records **intent**, not an actual
//! firewall rule. Real enforcement is a device/AOSP step — the rootless
//! `VpnService` path or an AOSP/rooted nftables path (`amos-network-guard`
//! features `vpn` / `nftables`). No code here claims to "block" traffic it cannot.
//! When started with `AMOS_NETGUARD_STATE_PATH`, the armed *intent* **and the
//! declared egress registry** are persisted there atomically, so both survive a
//! daemon restart (a restored armed guard re-applies its restored rules). The
//! file is outside the trust boundary, so a restored registry is re-validated
//! before it becomes rules. Enforcement and the live audit counter stay
//! runtime-only and are never fabricated from the file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use amos_network_guard::audit::{EgressCounter, EgressEvent, EgressKind};
use amos_network_guard::guard::{MockNetworkGuard, NetworkGuard};
use amos_network_guard::policy::{is_valid_egress_host, Destination, Policy, RuleSet};
use amos_proto::amos_netguard::{
    net_guard_service_server::{NetGuardService, NetGuardServiceServer},
    EgressSample, NoteEgressReply, NoteEgressRequest, RevokeAppEgressReply, RevokeAppEgressRequest,
    SetAppEgressReply, SetAppEgressRequest, StatusReply, StatusRequest, ToggleReply, ToggleRequest,
};
use serde::{Deserialize, Serialize};
use tonic::{Request, Response, Status};

/// How many top egress domains `Status` reports.
const TOP_EGRESS_N: usize = 5;

/// Ceiling on an app id at the `SetAppEgress` seam (bytes). Ids are short
/// identifiers; this refuses a paste-sized one before it becomes a map key.
const MAX_APP_ID_BYTES: usize = 256;

/// Ceiling on declared hosts per app. Mirrors the manifest's `allowed_domains`
/// cap (`amos-appstore::pwa`), so a set the manifest accepted is never refused
/// for size here.
const MAX_DOMAINS_PER_APP: usize = 64;

/// Ceiling on one declared host (bytes). RFC 1035 caps a domain at 253 B; a
/// longer "host" is not one.
const MAX_DOMAIN_BYTES: usize = 253;

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
    /// The enforcement seam. Arming drives [`NetworkGuard::apply`]; disarming
    /// drives [`NetworkGuard::flush`]. Default host build = [`MockNetworkGuard`].
    guard: Box<dyn NetworkGuard>,
    /// Per-app declared egress, keyed by app id (`BTreeMap` so the flattened rule
    /// order is deterministic). Populated by `SetAppEgress` / `RevokeAppEgress`;
    /// this is what makes `StatusReply.policy_rules` and `declared_apps` real
    /// measurements rather than reserved zeros.
    apps: Mutex<BTreeMap<String, AppEgress>>,
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
    /// durable state path for intent persistence. Uses the in-process
    /// [`MockNetworkGuard`] (the honest default host backend).
    pub fn new_with_options(allow_inject: bool, enabled: bool, persist: Option<PathBuf>) -> Self {
        Self::with_parts(
            allow_inject,
            enabled,
            persist,
            Box::new(MockNetworkGuard::new()),
            "mock",
        )
    }

    /// A guard backed by an injected [`NetworkGuard`] and its reported backend
    /// name. This is the seam a wired `VpnService` / nftables backend plugs into
    /// (`StatusReply.backend` then names it and `enforced` follows the backend's
    /// own [`NetworkGuard::enforces`] claim).
    pub fn with_parts(
        allow_inject: bool,
        enabled: bool,
        persist: Option<PathBuf>,
        guard: Box<dyn NetworkGuard>,
        backend: &'static str,
    ) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            backend,
            guard,
            apps: Mutex::new(BTreeMap::new()),
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

    /// Best-effort persist of armed *intent* **and** the declared egress registry
    /// (no-op without a path). Enforcement and the audit counter are never written:
    /// they are runtime-only facts, and a restart must not resurrect them.
    fn persist_snapshot(&self, apps: &BTreeMap<String, AppEgress>) {
        if let Some(path) = &self.persist {
            persist_state(path, self.enabled.load(Ordering::Relaxed), apps);
        }
    }

    /// Fold one observed egress event into the audit counter. This is the seam a
    /// real device producer (VpnService / nftables observability) calls; the
    /// env-gated `NoteEgress` RPC drives the same path for tests/demo.
    pub fn record_egress(&self, event: EgressEvent) {
        lock(&self.counter).record(&event);
    }

    /// Record (or replace) one app's declared egress and, when armed, push the
    /// resulting rule set to the backend.
    ///
    /// The declaration is committed **only if the backend accepts it** while the
    /// guard is armed: a refusing backend rolls the change back so the reported
    /// counts can never drift from what the guard actually holds (the same rule
    /// `toggle` follows for armed intent). Returns the post-change rule count.
    fn commit_app_egress(
        &self,
        app_id: String,
        egress: AppEgress,
    ) -> Result<(u64, u64), amos_network_guard::Error> {
        let mut apps = lock(&self.apps);
        let previous = apps.insert(app_id.clone(), egress);
        if let Err(e) = self.apply_if_armed(&apps) {
            match previous {
                Some(prev) => {
                    apps.insert(app_id, prev);
                }
                None => {
                    apps.remove(&app_id);
                }
            }
            return Err(e);
        }
        self.persist_snapshot(&apps);
        Ok((flatten_rules(&apps).len() as u64, apps.len() as u64))
    }

    /// Drop one app's declared egress (a no-op for an absent app) and re-apply
    /// when armed. Returns the post-change totals. Never removes a *different*
    /// app's rules, so one uninstall cannot silently widen another app's grant.
    fn remove_app_egress(&self, app_id: &str) -> Result<(u64, u64), amos_network_guard::Error> {
        let mut apps = lock(&self.apps);
        let removed = apps.remove(app_id);
        if let Err(e) = self.apply_if_armed(&apps) {
            if let Some(prev) = removed {
                apps.insert(app_id.to_string(), prev);
            }
            return Err(e);
        }
        self.persist_snapshot(&apps);
        Ok((flatten_rules(&apps).len() as u64, apps.len() as u64))
    }

    /// Push the current declared rules to the backend **iff** the guard is armed.
    /// Disarmed means "intent only": nothing is applied, and no error is possible.
    fn apply_if_armed(
        &self,
        apps: &BTreeMap<String, AppEgress>,
    ) -> Result<(), amos_network_guard::Error> {
        if !self.enabled() {
            return Ok(());
        }
        self.guard.apply(flatten_rules(apps).rules())
    }

    /// Map a backend apply failure while delivering an egress change onto a
    /// truthful `Unavailable`. The change has already been rolled back, so the
    /// error says so rather than leaving a caller to guess.
    fn egress_apply_failed(&self, e: amos_network_guard::Error) -> Status {
        Status::unavailable(format!(
            "netguard backend '{}' could not apply the egress change (rolled back): {e}",
            self.backend
        ))
    }
}

/// One app's declared egress set.
#[derive(Clone, Debug, PartialEq, Eq)]
struct AppEgress {
    /// The app's Android uid; `0` = unknown (declaration only, no packet rule).
    uid: u32,
    /// Declared hosts, normalized + de-duplicated, in declaration order.
    domains: Vec<String>,
}

/// Flatten every app's declaration into the guard's rule set, in a deterministic
/// (app-id, then declaration) order.
///
/// An app with `uid == 0` contributes **no** rule: `Policy` is uid-scoped, so a
/// shared-uid bundle cannot be expressed — `Policy::allow(0, …)` would be a rule
/// about "uid 0", not about that bundle, and inventing a uid would be exactly the
/// fabrication this seam exists to prevent. Such an app still counts in
/// `declared_apps`.
fn flatten_rules(apps: &BTreeMap<String, AppEgress>) -> RuleSet {
    let mut set = RuleSet::new();
    for app in apps.values() {
        if app.uid == 0 {
            continue;
        }
        for host in &app.domains {
            set.insert(Policy::allow(app.uid, Destination::domain(host.clone())));
        }
    }
    set
}

/// Validate and normalize a `SetAppEgress` request into an [`AppEgress`], or a
/// truthful `InvalidArgument` naming the refused field.
fn validate_app_egress(req: SetAppEgressRequest) -> Result<(String, AppEgress), Status> {
    let app_id = req.app_id.trim().to_string();
    if app_id.is_empty() {
        return Err(Status::invalid_argument("app_id must not be empty"));
    }
    if app_id.len() > MAX_APP_ID_BYTES {
        return Err(Status::invalid_argument(format!(
            "app_id too long: {} bytes (max {MAX_APP_ID_BYTES})",
            app_id.len()
        )));
    }
    if app_id.chars().any(char::is_control) {
        return Err(Status::invalid_argument(
            "app_id must not contain control characters",
        ));
    }
    if req.allow_domains.len() > MAX_DOMAINS_PER_APP {
        return Err(Status::invalid_argument(format!(
            "{} declared hosts exceeds the {MAX_DOMAINS_PER_APP} cap",
            req.allow_domains.len()
        )));
    }
    let mut domains: Vec<String> = Vec::with_capacity(req.allow_domains.len());
    for host in &req.allow_domains {
        if host.len() > MAX_DOMAIN_BYTES {
            return Err(Status::invalid_argument(format!(
                "declared host too long: {} bytes (max {MAX_DOMAIN_BYTES})",
                host.len()
            )));
        }
        if !is_valid_egress_host(host) {
            return Err(Status::invalid_argument(format!(
                "declared host {host:?} is not a fully-qualified lowercase host \
                 (no wildcard, no scheme, no port, no path)"
            )));
        }
        // De-duplicate preserving declaration order: a host declared twice is one
        // rule, not two (and would otherwise inflate `policy_rules`).
        if !domains.iter().any(|d| d == host) {
            domains.push(host.clone());
        }
    }
    Ok((
        app_id,
        AppEgress {
            uid: req.uid,
            domains,
        },
    ))
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
        // Drive the seam: arming (re)applies the held rules, disarming clears any
        // rules this guard installed. A backend that cannot act must fail here
        // rather than let a fake "armed" state stand.
        let outcome = if enabled {
            self.guard.apply(flatten_rules(&lock(&self.apps)).rules())
        } else {
            self.guard.flush()
        };
        if let Err(e) = outcome {
            let verb = if enabled { "arm" } else { "disarm" };
            return Err(Status::unavailable(format!(
                "netguard backend '{}' could not {verb}: {e}",
                self.backend
            )));
        }
        self.enabled.store(enabled, Ordering::Relaxed);
        // Persist the *intent* so a restart keeps it; enforcement stays runtime-only.
        self.persist_snapshot(&lock(&self.apps));
        let message = if enabled {
            format!(
                "guard armed (intent recorded); backend={} — not enforced (device/AOSP step)",
                self.backend
            )
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
        // Read both counts under **one** lock: `std::sync::Mutex` is not
        // re-entrant, so a second `lock(&self.apps)` in the same statement would
        // self-deadlock (the first temporary guard lives to the end of the
        // statement, not the sub-expression).
        let (policy_rules, declared_apps) = {
            let apps = lock(&self.apps);
            (flatten_rules(&apps).len() as u64, apps.len() as u64)
        };
        Ok(Response::new(StatusReply {
            enabled: self.enabled.load(Ordering::Relaxed),
            backend: self.backend.to_string(),
            // `enforced` is the *backend's own* claim: the default Mock (and any
            // backend that only records) reports `false`, so this can never read
            // "enforcing" off a guard that is not dropping traffic.
            enforced: self.guard.enforces(),
            policy_rules,
            top_egress,
            declared_apps,
        }))
    }

    /// REQ-A734 (F-SH-191): record an app's declared egress set, then feed it to the
    /// armed backend. `policy_rules` is the *configured* count the guard now holds —
    /// a real measurement, not the constant 0 that F-SH-075② registered.
    async fn set_app_egress(
        &self,
        req: Request<SetAppEgressRequest>,
    ) -> Result<Response<SetAppEgressReply>, Status> {
        let (app_id, egress) = validate_app_egress(req.into_inner())?;
        let (policy_rules, declared_apps) = self
            .commit_app_egress(app_id, egress)
            .map_err(|e| self.egress_apply_failed(e))?;
        Ok(Response::new(SetAppEgressReply {
            policy_rules,
            declared_apps,
        }))
    }

    async fn revoke_app_egress(
        &self,
        req: Request<RevokeAppEgressRequest>,
    ) -> Result<Response<RevokeAppEgressReply>, Status> {
        let app_id = req.into_inner().app_id.trim().to_string();
        if app_id.is_empty() {
            return Err(Status::invalid_argument("app_id must not be empty"));
        }
        let (policy_rules, declared_apps) = self
            .remove_app_egress(&app_id)
            .map_err(|e| self.egress_apply_failed(e))?;
        Ok(Response::new(RevokeAppEgressReply {
            policy_rules,
            declared_apps,
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
/// persisted armed *intent* + declared egress registry from
/// `AMOS_NETGUARD_STATE_PATH` (if any), so both survive a restart. Restoring
/// *declarations* is restoring user configuration; the file never carries
/// enforcement or audit facts — a real backend still re-earns its `enforces()`
/// claim, and the mock still reports `enforced = false`.
pub fn bootstrap() -> NetGuardSvc {
    let persist = state_path_from_env();
    let state = persist.as_deref().map(load_state).unwrap_or_default();
    let svc = NetGuardSvc::new_with_options(injection_env_allowed(), state.enabled, persist);
    if !state.apps.is_empty() {
        *lock(&svc.apps) = state_to_registry(state);
    }
    // If the restored intent is armed, (re)apply the restored rules so "armed"
    // means the same thing after a restart as before it. A refusing backend logs
    // the failure here (bootstrap has no caller to return a `Status` to); intent
    // is kept, and `enforced` still follows `enforces()`, so nothing is claimed
    // that is not so.
    if svc.enabled() {
        if let Err(e) = svc.guard.apply(flatten_rules(&lock(&svc.apps)).rules()) {
            tracing::warn!(
                "netguard re-arm at bootstrap failed (backend '{}'): {e}",
                svc.backend
            );
        }
    }
    svc
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

/// Read the persisted state (armed intent + declared registry). A missing,
/// unreadable or corrupt file yields the honest default: disarmed, no apps.
fn load_state(path: &Path) -> NetGuardState {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<NetGuardState>(&bytes).ok())
        .unwrap_or_default()
}

/// Write the state to `path` atomically; best-effort, never panics.
fn persist_state(path: &Path, enabled: bool, apps: &BTreeMap<String, AppEgress>) {
    let state = NetGuardState {
        enabled,
        apps: apps
            .iter()
            .map(|(id, e)| PersistedApp {
                id: id.clone(),
                uid: e.uid,
                domains: e.domains.clone(),
            })
            .collect(),
    };
    match serde_json::to_vec(&state) {
        Ok(bytes) => {
            if let Err(e) = atomic_write(path, &bytes) {
                tracing::warn!("netguard state save failed: {e}");
            }
        }
        Err(e) => tracing::warn!("netguard state serialize failed: {e}"),
    }
}

/// REQ-A742 (F-SH-199): rebuild the declared registry from persisted state,
/// **re-validating** every id and host: the state file is outside the trust
/// boundary, so a hand-edited or corrupt entry must not slip an unvalidated host
/// into the rule set. Invalid entries are dropped (not silently widened), and a
/// duplicate host collapses.
fn state_to_registry(state: NetGuardState) -> BTreeMap<String, AppEgress> {
    let mut map = BTreeMap::new();
    for p in state.apps {
        if p.id.is_empty() || p.id.len() > MAX_APP_ID_BYTES || p.id.chars().any(char::is_control) {
            continue;
        }
        let mut domains: Vec<String> = Vec::new();
        for host in p.domains {
            if host.len() <= MAX_DOMAIN_BYTES
                && is_valid_egress_host(&host)
                && !domains.contains(&host)
            {
                domains.push(host);
            }
        }
        domains.truncate(MAX_DOMAINS_PER_APP);
        map.insert(
            p.id,
            AppEgress {
                uid: p.uid,
                domains,
            },
        );
    }
    map
}

/// On-disk snapshot of the guard's durable state (atomic JSON). `apps` is
/// `#[serde(default)]` so a file written by the intent-only version still loads
/// (it simply has no declarations).
#[derive(Default, Serialize, Deserialize)]
struct NetGuardState {
    enabled: bool,
    #[serde(default)]
    apps: Vec<PersistedApp>,
}

/// One app's declared egress, as written to disk.
#[derive(Serialize, Deserialize)]
struct PersistedApp {
    id: String,
    uid: u32,
    domains: Vec<String>,
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
    use amos_network_guard::policy::Policy;

    /// A [`NetworkGuard`] spy: records how many policies it was asked to apply,
    /// whether it was flushed, and whether it claims to enforce. Lets a test see
    /// that arming/disarming actually drives the seam.
    struct SpyGuard {
        applied_policies: Mutex<usize>,
        flushes: Mutex<usize>,
        enforces: bool,
        /// Flippable so a test can arm cleanly, then make the backend start
        /// refusing — the exact shape an egress rollback has to survive.
        fail_apply: AtomicBool,
    }

    impl SpyGuard {
        fn new() -> Self {
            Self {
                applied_policies: Mutex::new(0),
                flushes: Mutex::new(0),
                enforces: false,
                fail_apply: AtomicBool::new(false),
            }
        }

        fn refuse_apply(&self) {
            self.fail_apply.store(true, Ordering::Relaxed);
        }
    }

    impl NetworkGuard for SpyGuard {
        fn apply(&self, policies: &[Policy]) -> amos_network_guard::Result<()> {
            if self.fail_apply.load(Ordering::Relaxed) {
                return Err(amos_network_guard::Error::NotOnDevice(
                    "spy refuses to apply",
                ));
            }
            *lock(&self.applied_policies) += policies.len();
            Ok(())
        }
        fn flush(&self) -> amos_network_guard::Result<()> {
            *lock(&self.flushes) += 1;
            Ok(())
        }
        fn enforces(&self) -> bool {
            self.enforces
        }
    }

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

    /// REQ-A744 (F-SH-202): a persistence feature is only real if a production
    /// launcher turns it on. The daemon reads `AMOS_NETGUARD_STATE_PATH` and its
    /// own default is honest in-memory, so the on-device init rc is the thing
    /// that must set it. This binds the two: dropping the `setenv` line — which
    /// would silently put the device back in memory without failing anything —
    /// turns this red.
    #[test]
    fn the_on_device_launcher_wires_the_persistence_it_documents() {
        let rc = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../deploy/android/amos.rc"),
        )
        .expect("the provided init.rc template is readable");
        // The rc creates the "socket + any shared state" directory it advertises...
        assert!(
            rc.contains("mkdir /data/amos"),
            "the rc must create the shared-state directory it advertises"
        );
        // ...and the guard's durable state must live under it, not be left unset.
        let line = rc
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("setenv AMOS_NETGUARD_STATE_PATH "))
            .expect(
                "the launcher must set AMOS_NETGUARD_STATE_PATH (unset => device is in-memory)",
            );
        let path = line
            .trim_start_matches("setenv AMOS_NETGUARD_STATE_PATH ")
            .trim();
        assert!(
            path.starts_with("/data/amos/"),
            "the state file must live under the dir the rc creates, got: {path}"
        );
    }

    #[test]
    fn load_state_defaults_to_false_on_missing_or_garbage() {
        let missing = tmp_state_path("missing");
        let _ = std::fs::remove_file(&missing);
        assert!(!load_state(&missing).enabled, "missing file => disarmed");

        let garbage = tmp_state_path("garbage");
        std::fs::write(&garbage, "{ not json").unwrap();
        let loaded = load_state(&garbage);
        assert!(!loaded.enabled, "corrupt file => disarmed (never crashes)");
        assert!(loaded.apps.is_empty(), "corrupt file => no declarations");
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
        let restored =
            NetGuardSvc::new_with_options(false, load_state(&path).enabled, Some(path.clone()));
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

    #[tokio::test]
    async fn arming_drives_the_guard_seam_and_disarming_flushes_it() {
        // The seam used to be reported but never instantiated; arming must now
        // actually reach the backend (apply), and disarming must flush it.
        let spy = std::sync::Arc::new(SpyGuard::new());
        let s = NetGuardSvc::with_parts(false, false, None, Box::new(SpyClone(spy.clone())), "spy");

        s.toggle(Request::new(ToggleRequest { enabled: true }))
            .await
            .unwrap();
        assert_eq!(
            *lock(&spy.applied_policies),
            0,
            "empty rule set applied (0 rules)"
        );
        s.toggle(Request::new(ToggleRequest { enabled: false }))
            .await
            .unwrap();
        assert_eq!(*lock(&spy.flushes), 1, "disarming must flush the backend");
    }

    /// Tiny `Box<dyn NetworkGuard>` wrapper so a test keeps an `Arc` handle to a
    /// spy while the service owns the trait object.
    struct SpyClone(std::sync::Arc<SpyGuard>);

    impl NetworkGuard for SpyClone {
        fn apply(&self, policies: &[Policy]) -> amos_network_guard::Result<()> {
            self.0.apply(policies)
        }
        fn flush(&self) -> amos_network_guard::Result<()> {
            self.0.flush()
        }
        fn enforces(&self) -> bool {
            self.0.enforces()
        }
    }

    #[tokio::test]
    async fn enforced_follows_the_backends_own_claim() {
        // A backend that says it enforces is believed; the default mock is not.
        let spy = std::sync::Arc::new(SpyGuard {
            applied_policies: Mutex::new(0),
            flushes: Mutex::new(0),
            enforces: true,
            fail_apply: AtomicBool::new(false),
        });
        let s = NetGuardSvc::with_parts(false, true, None, Box::new(SpyClone(spy.clone())), "vpn");
        let reply = s
            .status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert!(
            reply.enforced,
            "a backend that enforces must be reported as such"
        );
        assert_eq!(reply.backend, "vpn");
    }

    #[tokio::test]
    async fn a_backend_that_cannot_arm_never_reports_armed() {
        // If the backend refuses to apply, the toggle must fail loudly and NOT
        // leave a fake "armed" intent behind.
        let spy = std::sync::Arc::new(SpyGuard {
            applied_policies: Mutex::new(0),
            flushes: Mutex::new(0),
            enforces: false,
            fail_apply: AtomicBool::new(true),
        });
        let s = NetGuardSvc::with_parts(false, false, None, Box::new(SpyClone(spy)), "spy");
        let err = s
            .toggle(Request::new(ToggleRequest { enabled: true }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unavailable);
        assert!(!s.enabled(), "a failed arm must not record armed intent");
    }

    /// Drive `SetAppEgress` and unwrap the reply (the common test shape).
    async fn set_app(
        s: &NetGuardSvc,
        app_id: &str,
        uid: u32,
        domains: &[&str],
    ) -> Result<SetAppEgressReply, Status> {
        s.set_app_egress(Request::new(SetAppEgressRequest {
            app_id: app_id.to_string(),
            uid,
            allow_domains: domains.iter().map(|d| d.to_string()).collect(),
        }))
        .await
        .map(|r| r.into_inner())
    }

    async fn status_of(s: &NetGuardSvc) -> StatusReply {
        s.status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner()
    }

    /// A declared app is written to the state file alongside armed intent, so a
    /// restart can restore it — the registry is durable, not runtime-only.
    #[tokio::test]
    async fn declared_egress_is_persisted_with_the_guard_state() {
        let path = tmp_state_path("persist-apps");
        let _ = std::fs::remove_file(&path);
        let s = NetGuardSvc::new_with_options(false, false, Some(path.clone()));
        set_app(&s, "org.amos.phone", 10_123, &["api.example.com"])
            .await
            .unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("\"org.amos.phone\""),
            "app id persisted: {raw}"
        );
        assert!(raw.contains("api.example.com"), "host persisted: {raw}");

        // Round-trip through the real loader + re-validator.
        let registry = state_to_registry(load_state(&path));
        let egress = registry.get("org.amos.phone").expect("app restored");
        assert_eq!(egress.uid, 10_123);
        assert_eq!(egress.domains, vec!["api.example.com".to_string()]);
        let _ = std::fs::remove_file(&path);
    }

    /// The state file is outside the trust boundary: a hand-edited or corrupt
    /// entry must be re-validated on restore, never slipping an unvalidated host
    /// (or a blank id) into the rule set.
    #[tokio::test]
    async fn a_restored_registry_revalidates_ids_and_hosts() {
        let path = tmp_state_path("revalidate");
        std::fs::write(
            &path,
            r#"{"enabled":true,"apps":[
                {"id":"org.amos.good","uid":4242,"domains":["api.example.com","bad_host","*.wild.com","api.example.com"]},
                {"id":"","uid":1,"domains":["x.example.com"]}
            ]}"#,
        )
        .unwrap();
        let registry = state_to_registry(load_state(&path));
        assert_eq!(registry.len(), 1, "the blank-id app is dropped");
        let good = registry.get("org.amos.good").expect("good app kept");
        assert_eq!(
            good.domains,
            vec!["api.example.com".to_string()],
            "invalid + duplicate hosts are dropped on restore"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A restored registry is *held* only: it never claims enforcement, and a
    /// uid-0 declaration still contributes no rule.
    #[tokio::test]
    async fn restored_apps_are_held_without_claiming_enforcement() {
        let path = tmp_state_path("restore-hold");
        std::fs::write(
            &path,
            r#"{"enabled":false,"apps":[
                {"id":"org.amos.phone","uid":7000,"domains":["api.example.com","cdn.example.org"]},
                {"id":"org.amos.pwa","uid":0,"domains":["api.example.com"]}
            ]}"#,
        )
        .unwrap();
        let s = NetGuardSvc::new_with_options(false, load_state(&path).enabled, Some(path.clone()));
        *lock(&s.apps) = state_to_registry(load_state(&path));
        let reply = status_of(&s).await;
        assert_eq!(reply.declared_apps, 2);
        assert_eq!(
            reply.policy_rules, 2,
            "only the uid-7000 app contributes rules"
        );
        assert!(
            !reply.enforced,
            "a restored registry never fabricates enforcement"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn fresh_status_reports_no_declarations() {
        let reply = status_of(&svc().await).await;
        assert_eq!(reply.policy_rules, 0);
        assert_eq!(reply.declared_apps, 0);
    }

    #[tokio::test]
    async fn set_app_egress_records_the_declaration_and_reports_totals() {
        let s = svc().await;
        let reply = set_app(
            &s,
            "org.amos.web",
            10_123,
            &["api.example.com", "cdn.example.org"],
        )
        .await
        .unwrap();
        assert_eq!(reply.policy_rules, 2);
        assert_eq!(reply.declared_apps, 1);

        // Status agrees with the reply, and a declaration is still not an
        // enforcement claim.
        let status = status_of(&s).await;
        assert_eq!(status.policy_rules, 2);
        assert_eq!(status.declared_apps, 1);
        assert!(!status.enforced);
    }

    #[tokio::test]
    async fn set_app_egress_replaces_rather_than_appends() {
        let s = svc().await;
        set_app(&s, "org.amos.web", 1, &["a.example.com"])
            .await
            .unwrap();
        let second = set_app(&s, "org.amos.web", 1, &["b.example.org"])
            .await
            .unwrap();
        assert_eq!(second.policy_rules, 1, "a re-set replaces, never appends");
        assert_eq!(second.declared_apps, 1);
    }

    #[tokio::test]
    async fn uid_zero_is_recorded_but_contributes_no_rule() {
        // A hosted bundle shares the shell uid, so it cannot be isolated at the
        // packet layer. It must be recorded (visible, truthful) without this
        // seam inventing a uid to make a rule out of.
        let s = svc().await;
        let reply = set_app(&s, "org.amos.pwa", 0, &["api.example.com"])
            .await
            .unwrap();
        assert_eq!(reply.policy_rules, 0, "no uid => no packet rule");
        assert_eq!(reply.declared_apps, 1, "but the declaration is recorded");
    }

    #[tokio::test]
    async fn revoke_app_egress_drops_only_that_app_and_is_a_no_op_when_absent() {
        let s = svc().await;
        set_app(&s, "app.a", 7, &["a.example.com"]).await.unwrap();
        set_app(&s, "app.b", 7, &["b.example.com"]).await.unwrap();

        let revoked = s
            .revoke_app_egress(Request::new(RevokeAppEgressRequest {
                app_id: "app.a".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(revoked.policy_rules, 1);
        assert_eq!(revoked.declared_apps, 1);

        // Revoking an app that was never declared changes nothing.
        let absent = s
            .revoke_app_egress(Request::new(RevokeAppEgressRequest {
                app_id: "app.zzz".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(absent.policy_rules, 1);
        assert_eq!(absent.declared_apps, 1);
    }

    #[tokio::test]
    async fn duplicate_declared_hosts_are_one_rule() {
        let s = svc().await;
        let reply = set_app(&s, "a.id", 5, &["x.example.com", "x.example.com"])
            .await
            .unwrap();
        assert_eq!(reply.policy_rules, 1, "a host declared twice is one rule");
    }

    #[tokio::test]
    async fn set_app_egress_refuses_bad_ids_and_hosts() {
        let s = svc().await;
        for (app_id, host) in [
            ("", "api.example.com"),          // empty id
            ("   ", "api.example.com"),       // whitespace-only id
            ("ok.id", ""),                    // empty host
            ("ok.id", "*.example.com"),       // wildcard (matches nothing)
            ("ok.id", "https://example.com"), // scheme
            ("ok.id", "example.com:443"),     // port
            ("ok.id", "example.com/path"),    // path
            ("ok.id", "Example.com"),         // uppercase
            ("ok.id", "localhost"),           // dotless (reaches this machine)
        ] {
            let err = set_app(&s, app_id, 1, &[host])
                .await
                .expect_err("bad input must be refused");
            assert_eq!(
                err.code(),
                tonic::Code::InvalidArgument,
                "app_id={app_id:?} host={host:?}"
            );
        }
        // An over-long app id is refused, and a refused call records nothing.
        let long_id = "a".repeat(MAX_APP_ID_BYTES + 1);
        assert_eq!(
            set_app(&s, &long_id, 1, &["api.example.com"])
                .await
                .unwrap_err()
                .code(),
            tonic::Code::InvalidArgument
        );
        let status = status_of(&s).await;
        assert_eq!(status.policy_rules, 0);
        assert_eq!(status.declared_apps, 0, "no refused call was recorded");
    }

    #[tokio::test]
    async fn set_app_egress_refuses_more_than_the_domain_cap() {
        let s = svc().await;
        let hosts: Vec<String> = (0..=MAX_DOMAINS_PER_APP)
            .map(|i| format!("h{i}.example.com"))
            .collect();
        let err = s
            .set_app_egress(Request::new(SetAppEgressRequest {
                app_id: "a.id".into(),
                uid: 1,
                allow_domains: hosts,
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn armed_guard_reapplies_on_change_and_rolls_back_on_refusal() {
        let spy = std::sync::Arc::new(SpyGuard::new());
        let s = NetGuardSvc::with_parts(false, false, None, Box::new(SpyClone(spy.clone())), "spy");

        // Disarmed: a declaration is recorded without touching the backend.
        set_app(&s, "a.id", 9, &["api.example.com"]).await.unwrap();
        assert_eq!(*lock(&spy.applied_policies), 0, "disarmed means no apply");

        s.toggle(Request::new(ToggleRequest { enabled: true }))
            .await
            .unwrap();
        let after_arm = *lock(&spy.applied_policies);
        assert_eq!(after_arm, 1, "arming applies the one held rule");

        // Armed: a change is pushed straight to the backend.
        set_app(&s, "a.id", 9, &["api.example.com", "cdn.example.org"])
            .await
            .unwrap();
        assert_eq!(
            *lock(&spy.applied_policies),
            after_arm + 2,
            "the re-set rules were applied while armed"
        );

        // A backend that starts refusing must roll the declaration back, so the
        // reported counts never drift from what the guard actually holds.
        spy.refuse_apply();
        let err = set_app(&s, "b.id", 9, &["blocked.example.com"])
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unavailable);

        let status = status_of(&s).await;
        assert_eq!(
            status.declared_apps, 1,
            "the refused declaration rolled back"
        );
        assert_eq!(status.policy_rules, 2);
    }

    /// The wire → audit mapping is the production path that builds `EgressEvent`s
    /// (including `EgressKind::Dns`). It carries the request's own `app`/`bytes`
    /// and folds an empty domain to `None` — which is exactly why the library's
    /// DNS convenience constructor is not used here (it hardcodes
    /// `app: ""`/`bytes: 0`, so wiring it would drop fields). Pinning this keeps
    /// the unwired-baseline reason for `audit.rs`'s constructor true.
    #[test]
    fn event_from_req_maps_kind_and_carries_app_and_bytes() {
        let dns_event = event_from_req(NoteEgressRequest {
            ts_ms: 7,
            uid: 42,
            app: "com.example".into(),
            domain: "tracker.example".into(),
            bytes: 1234,
            kind: 1,
        });
        assert_eq!(dns_event.kind, EgressKind::Dns);
        assert_eq!(dns_event.app, "com.example");
        assert_eq!(dns_event.bytes, 1234);
        assert_eq!(dns_event.domain.as_deref(), Some("tracker.example"));

        let tls = event_from_req(NoteEgressRequest {
            kind: 2,
            ..Default::default()
        });
        assert_eq!(tls.kind, EgressKind::Tls);

        // The 0 "unspecified" default and any unknown tag are honestly `Other`.
        let other = event_from_req(NoteEgressRequest {
            kind: 0,
            ..Default::default()
        });
        assert_eq!(other.kind, EgressKind::Other);

        // An absent domain is `None`, never an empty string.
        let no_domain = event_from_req(NoteEgressRequest {
            domain: String::new(),
            ..Default::default()
        });
        assert_eq!(no_domain.domain, None);
    }
}
