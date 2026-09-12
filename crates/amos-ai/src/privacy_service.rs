//! gRPC `PrivacyService` exposing the daemon's authoritative [`PrivacyManager`]
//! over the shared UDS (proto `amos_privacy`, `proto/privacy.proto`).
//!
//! Follows the `governor_service` / `amos-sensor` / `amos-telephony` pattern:
//! the service holds the shared manager and maps tonic RPCs onto the domain
//! core, so a System UI / per-app process host can grant/revoke/ask — while the
//! **daemon stays the single authority** and every `Authorize` decision is
//! audited. When the daemon was started with `AMOS_PRIVACY_PATH`, grants are
//! persisted there (atomic JSON) and each decision is also mirrored to the
//! durable unified audit file at `<AMOS_PRIVACY_PATH>.jsonl`.
//!
//! Honest boundaries: this is the *decision/audit* authority. Enforcing the
//! decision at the OS boundary (intercepting a third-party APK's
//! `AudioRecord`/`Camera.open`, gating a web-bundle bridge) is device/ecosystem
//! work tracked in `docs/permissions-sandbox-audit-plan.md` — not faked here.

use std::path::PathBuf;
use std::sync::Arc;

use amos_proto::amos_privacy::{
    privacy_service_server::{PrivacyService, PrivacyServiceServer},
    AllGrantsReply, AllGrantsRequest, AppGrants, AppRef, AuditQuery, AuditReply, DecisionReply,
    GrantReply, GrantRequest, ResourceRef, TrailReply,
};
use tonic::{Request, Response, Status};

use crate::audit::{AuditFile, Outcome};
use crate::privacy::{AccessDecision, PrivacyManager, Resource};

/// Cap for one `RecentAudit` response (protects the wire from a huge window).
const AUDIT_MAX: usize = 1000;
/// Default audit window when the query's `limit` is 0.
const AUDIT_DEFAULT: usize = 200;

/// The tonic `PrivacyService` implementation wrapping a shared manager.
pub struct PrivacySvc {
    manager: Arc<PrivacyManager>,
    /// When set, grants are persisted here (atomic JSON) after every mutation.
    persist: Option<PathBuf>,
}

impl PrivacySvc {
    pub fn new(manager: Arc<PrivacyManager>, persist: Option<PathBuf>) -> Self {
        Self { manager, persist }
    }

    /// Best-effort persistence after a mutation that changed the grant set.
    async fn persist_save(&self) {
        if let Some(p) = &self.persist {
            if let Err(e) = self.manager.save(p).await {
                tracing::warn!("privacy state save failed: {e:#}");
            }
        }
    }
}

/// Map a resource wire key to a [`Resource`]; reject unknown keys.
fn parse_resource(key: &str) -> Result<Resource, Status> {
    Resource::from_key(key)
        .ok_or_else(|| Status::invalid_argument(format!("unknown resource key '{key}'")))
}

fn proto_audit(
    ts: u64,
    principal: &str,
    op: &str,
    resource: &str,
    outcome: Outcome,
) -> amos_proto::amos_privacy::AuditRecord {
    amos_proto::amos_privacy::AuditRecord {
        ts,
        principal: principal.to_string(),
        op: op.to_string(),
        resource: resource.to_string(),
        outcome: outcome.to_string().to_ascii_lowercase(),
        details: String::new(),
    }
}

/// Map a lowercase wire outcome back to an [`Outcome`]; unknown ⇒ reject.
///
/// An unrecognized outcome is never guessed into the nearest known one — an
/// audit trail that silently reinterprets a decision is worse than no trail.
fn parse_outcome(key: &str) -> Result<Outcome, Status> {
    match key.to_ascii_lowercase().as_str() {
        "success" => Ok(Outcome::Success),
        "granted" => Ok(Outcome::Granted),
        "denied" => Ok(Outcome::Denied),
        "rejected" => Ok(Outcome::Rejected),
        "error" => Ok(Outcome::Error),
        _ => Err(Status::invalid_argument(format!(
            "unknown audit outcome '{key}'"
        ))),
    }
}

/// Unix seconds now (the daemon's own clock; `0` only if the clock is before the
/// epoch, which we report rather than panic on).
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tonic::async_trait]
impl PrivacyService for PrivacySvc {
    async fn grant(&self, req: Request<GrantRequest>) -> Result<Response<GrantReply>, Status> {
        let r = req.into_inner();
        let resource = parse_resource(&r.resource)?;
        self.manager.grant(&r.app_id, resource).await;
        self.persist_save().await;
        Ok(Response::new(GrantReply {
            ok: true,
            message: format!("granted '{}' to '{}'", resource.key(), r.app_id),
        }))
    }

    async fn revoke(&self, req: Request<GrantRequest>) -> Result<Response<GrantReply>, Status> {
        let r = req.into_inner();
        let resource = parse_resource(&r.resource)?;
        self.manager.revoke(&r.app_id, resource).await;
        self.persist_save().await;
        Ok(Response::new(GrantReply {
            ok: true,
            message: String::new(),
        }))
    }

    async fn revoke_all(&self, req: Request<AppRef>) -> Result<Response<GrantReply>, Status> {
        let r = req.into_inner();
        self.manager.revoke_all(&r.app_id).await;
        self.persist_save().await;
        Ok(Response::new(GrantReply {
            ok: true,
            message: String::new(),
        }))
    }

    async fn authorize(
        &self,
        req: Request<ResourceRef>,
    ) -> Result<Response<DecisionReply>, Status> {
        let r = req.into_inner();
        let resource = parse_resource(&r.resource)?;
        let granted = self.manager.authorize(&r.app_id, resource).await == AccessDecision::Granted;
        Ok(Response::new(DecisionReply {
            app_id: r.app_id,
            resource: resource.key().to_string(),
            granted,
        }))
    }

    async fn granted(&self, req: Request<AppRef>) -> Result<Response<AppGrants>, Status> {
        let r = req.into_inner();
        let mut resources: Vec<String> = self
            .manager
            .granted(&r.app_id)
            .await
            .iter()
            .map(|x| x.key().to_string())
            .collect();
        resources.sort();
        Ok(Response::new(AppGrants {
            app_id: r.app_id,
            resources,
        }))
    }

    async fn granted_all(
        &self,
        _req: Request<AllGrantsRequest>,
    ) -> Result<Response<AllGrantsReply>, Status> {
        let apps = self
            .manager
            .grants_snapshot()
            .await
            .into_iter()
            .map(|(app_id, resources)| AppGrants {
                app_id,
                resources: resources.iter().map(|r| r.key().to_string()).collect(),
            })
            .collect();
        Ok(Response::new(AllGrantsReply { apps }))
    }

    async fn recent_audit(&self, req: Request<AuditQuery>) -> Result<Response<AuditReply>, Status> {
        let r = req.into_inner();
        let limit = if r.limit == 0 {
            AUDIT_DEFAULT
        } else {
            (r.limit as usize).min(AUDIT_MAX)
        };
        let records: Vec<amos_proto::amos_privacy::AuditRecord> = self
            .manager
            .recent_audit(limit)
            .await
            .into_iter()
            .filter(|a| {
                (r.app_id.is_empty() || a.app == r.app_id)
                    && (r.resource.is_empty() || a.resource.key() == r.resource)
            })
            .map(|a| {
                proto_audit(
                    a.timestamp,
                    &a.app,
                    "perm.authorize",
                    a.resource.key(),
                    a.decision.into(),
                )
            })
            .collect();
        Ok(Response::new(AuditReply { records }))
    }

    async fn record_audit(
        &self,
        req: Request<amos_proto::amos_privacy::AuditRecord>,
    ) -> Result<Response<GrantReply>, Status> {
        let r = req.into_inner();
        let outcome = parse_outcome(&r.outcome)?;
        if r.principal.trim().is_empty() {
            return Err(Status::invalid_argument("audit record needs a principal"));
        }
        if r.op.trim().is_empty() {
            return Err(Status::invalid_argument("audit record needs an op"));
        }

        // The daemon stamps the time: an audit timestamp is the daemon's
        // authority, not the caller's (a client cannot backdate or forward-date
        // an event in the trail).
        let ts = now_secs();
        let record = crate::audit::AuditRecord {
            ts,
            principal: r.principal,
            op: r.op,
            resource: r.resource,
            outcome,
            details: r.details,
        };
        let recorded = self.manager.record_audit(record).await;
        Ok(Response::new(GrantReply {
            ok: recorded,
            message: if recorded {
                format!("recorded at {ts}")
            } else {
                "no durable audit sink configured (AMOS_PRIVACY_PATH unset)".to_string()
            },
        }))
    }

    async fn recent_trail(&self, req: Request<AuditQuery>) -> Result<Response<TrailReply>, Status> {
        let r = req.into_inner();
        let limit = if r.limit == 0 {
            AUDIT_DEFAULT
        } else {
            (r.limit as usize).min(AUDIT_MAX)
        };
        let principal = (!r.app_id.is_empty()).then_some(r.app_id.as_str());
        let resource = (!r.resource.is_empty()).then_some(r.resource.as_str());

        let (records, durable) = self.manager.recent_trail(limit, principal, resource).await;
        Ok(Response::new(TrailReply {
            records: records
                .into_iter()
                .map(|rec| amos_proto::amos_privacy::AuditRecord {
                    ts: rec.ts,
                    principal: rec.principal,
                    op: rec.op,
                    resource: rec.resource,
                    outcome: rec.outcome.to_string().to_ascii_lowercase(),
                    details: rec.details,
                })
                .collect(),
            durable,
        }))
    }
}

/// Build the tonic server wrapper around a shared manager.
pub fn server(
    manager: Arc<PrivacyManager>,
    persist: Option<PathBuf>,
) -> PrivacyServiceServer<PrivacySvc> {
    PrivacyServiceServer::new(PrivacySvc::new(manager, persist))
}

/// Bootstrap the authoritative manager + persistence from the environment:
/// `AMOS_PRIVACY_PATH` (if set) is loaded if present (else a fresh deny-by-default
/// manager) and every decision is mirrored to the daemon's **shared** durable
/// audit trail (see [`crate::audit::shared_trail_from_env`]): `AMOS_AUDIT_PATH`,
/// else `<AMOS_PRIVACY_PATH>.jsonl`. Unset ⇒ fresh in-memory manager, no
/// persistence and no audit trail.
pub fn bootstrap() -> (Arc<PrivacyManager>, Option<PathBuf>) {
    bootstrap_with_sink(crate::audit::shared_trail_from_env())
}

/// Same as [`bootstrap`], but takes the daemon's shared durable audit sink from
/// the caller instead of resolving it here, so the **same** sink instance is
/// handed to the security layer too — one trail, one read-back.
///
/// `None` ⇒ the manager is memory-only (no trail): callers must surface that
/// honestly (`RecordAudit` answers `ok = false`, `RecentTrail` answers
/// `durable = false`) rather than implying a trail exists.
pub fn bootstrap_with_sink(shared: Option<AuditFile>) -> (Arc<PrivacyManager>, Option<PathBuf>) {
    match std::env::var_os("AMOS_PRIVACY_PATH").map(PathBuf::from) {
        Some(p) => {
            let mut manager = match PrivacyManager::load(&p) {
                Ok(m) => m,
                Err(_) => {
                    tracing::warn!(
                        "no valid privacy state at {}, starting deny-by-default",
                        p.display()
                    );
                    PrivacyManager::new(2048)
                }
            };
            manager = match shared {
                Some(sink) => manager.with_durable_audit(sink),
                None => {
                    tracing::warn!(
                        "no shared audit trail configured; privacy audit is memory-only"
                    );
                    manager
                }
            };
            (Arc::new(manager), Some(p))
        }
        None => {
            // No privacy-state file: grants are ephemeral, but the audit trail can
            // still be durable when `AMOS_AUDIT_PATH` is set.
            let manager = match shared {
                Some(sink) => PrivacyManager::with_audit_file(2048, sink),
                None => PrivacyManager::new(2048),
            };
            (Arc::new(manager), None)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tonic::Request;

    fn svc() -> (PrivacySvc, Arc<PrivacyManager>) {
        let m = Arc::new(PrivacyManager::new(16));
        let s = PrivacySvc::new(Arc::clone(&m), None);
        (s, m)
    }

    #[tokio::test]
    async fn grant_then_authorize_round_trips_over_the_trait() {
        let (s, _m) = svc();
        let gr = s
            .grant(Request::new(GrantRequest {
                app_id: "com.amos.phone".into(),
                resource: "microphone".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(gr.ok);

        let dec = s
            .authorize(Request::new(ResourceRef {
                app_id: "com.amos.phone".into(),
                resource: "microphone".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(dec.granted, "granted app may access the mic");

        // A different (ungranted) resource on the same app is denied.
        let dec2 = s
            .authorize(Request::new(ResourceRef {
                app_id: "com.amos.phone".into(),
                resource: "camera".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(!dec2.granted, "deny-by-default for camera");
    }

    #[tokio::test]
    async fn unknown_resource_key_is_rejected() {
        let (s, _m) = svc();
        let err = s
            .authorize(Request::new(ResourceRef {
                app_id: "a".into(),
                resource: "barometer".into(),
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn local_only_capability_name_is_not_an_os_resource() {
        // `notifications` is a frontend-only (local) capability — it must never
        // become an OS resource at the daemon boundary (no grant/audit path).
        let (s, _m) = svc();
        for bad in ["notifications", "", "NOTIFICATIONS", "microphone "].into_iter() {
            let err = s
                .authorize(Request::new(ResourceRef {
                    app_id: "messages".into(),
                    resource: bad.into(),
                }))
                .await
                .unwrap_err();
            assert_eq!(
                err.code(),
                tonic::Code::InvalidArgument,
                "local-only / malformed resource '{bad}' must be rejected"
            );
        }
    }

    #[tokio::test]
    async fn authorize_audits_and_recent_audit_filters() {
        let (s, m) = svc();
        m.grant("com.a", Resource::Microphone).await;

        s.authorize(Request::new(ResourceRef {
            app_id: "com.a".into(),
            resource: "microphone".into(),
        }))
        .await
        .unwrap();
        s.authorize(Request::new(ResourceRef {
            app_id: "com.b".into(),
            resource: "location".into(),
        }))
        .await
        .unwrap();

        let all = s
            .recent_audit(Request::new(AuditQuery {
                app_id: String::new(),
                resource: String::new(),
                limit: 10,
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(all.records.len(), 2, "both decisions audited, newest first");
        assert_eq!(all.records[0].outcome, "denied");
        assert_eq!(all.records[1].outcome, "granted");

        // Filter by app id.
        let only_a = s
            .recent_audit(Request::new(AuditQuery {
                app_id: "com.a".into(),
                resource: String::new(),
                limit: 10,
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(only_a.records.len(), 1);
        assert_eq!(only_a.records[0].principal, "com.a");
    }

    #[tokio::test]
    async fn granted_all_lists_every_holder_once_in_a_stable_order() {
        let (s, m) = svc();
        // Deny-by-default: nothing granted ⇒ nothing listed.
        let none = s
            .granted_all(Request::new(AllGrantsRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert!(none.apps.is_empty(), "deny-by-default lists nothing");

        m.grant("com.b", Resource::Storage).await;
        m.grant("com.a", Resource::Microphone).await;
        m.grant("com.a", Resource::Camera).await;
        // A revoke leaves an app with nothing ⇒ it must drop out entirely.
        m.grant("com.c", Resource::Location).await;
        m.revoke("com.c", Resource::Location).await;

        let all = s
            .granted_all(Request::new(AllGrantsRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(all.apps.len(), 2, "only holders are listed");
        assert_eq!(all.apps[0].app_id, "com.a", "sorted by app id");
        assert_eq!(
            all.apps[0].resources,
            vec!["camera".to_string(), "microphone".to_string()],
            "resources sorted by stable key"
        );
        assert_eq!(all.apps[1].app_id, "com.b");
        assert_eq!(all.apps[1].resources, vec!["storage".to_string()]);
    }

    #[tokio::test]
    async fn granted_lists_and_revoke_clears() {
        let (s, _m) = svc();
        s.grant(Request::new(GrantRequest {
            app_id: "x".into(),
            resource: "camera".into(),
        }))
        .await
        .unwrap();
        s.grant(Request::new(GrantRequest {
            app_id: "x".into(),
            resource: "storage".into(),
        }))
        .await
        .unwrap();

        let g = s
            .granted(Request::new(AppRef { app_id: "x".into() }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            g.resources,
            vec!["camera".to_string(), "storage".to_string()]
        );

        s.revoke_all(Request::new(AppRef { app_id: "x".into() }))
            .await
            .unwrap();
        let g2 = s
            .granted(Request::new(AppRef { app_id: "x".into() }))
            .await
            .unwrap()
            .into_inner();
        assert!(g2.resources.is_empty(), "revoke_all clears the grant set");
    }

    #[tokio::test]
    async fn record_audit_persists_to_the_unified_sink_and_validates() {
        let dir = std::env::temp_dir().join(format!("amos-priv-rec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.jsonl");
        let sink = AuditFile::open(&path, 16).unwrap();
        let m = Arc::new(PrivacyManager::with_audit_file(16, sink));
        let s = PrivacySvc::new(m, None);

        let reply = s
            .record_audit(Request::new(amos_proto::amos_privacy::AuditRecord {
                ts: 123, // ignored — the daemon stamps its own clock
                principal: "com.amos.devocare".into(),
                op: "devcare.clean".into(),
                resource: "app_cache,log_file".into(),
                outcome: "success".into(),
                details: "planned=3 freed_bytes=512".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(reply.ok, "a durable sink is attached ⇒ recorded");

        // The record really is in the durable file, daemon-stamped.
        let reopened = AuditFile::open(&path, 16).unwrap();
        let recent = reopened.recent(10).await;
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].principal, "com.amos.devocare");
        assert_eq!(recent[0].op, "devcare.clean");
        assert_eq!(recent[0].outcome, Outcome::Success);
        assert_ne!(recent[0].ts, 123, "the daemon stamps the time");

        // An unknown outcome is rejected, never guessed.
        let bad = s
            .record_audit(Request::new(amos_proto::amos_privacy::AuditRecord {
                ts: 0,
                principal: "com.amos.devocare".into(),
                op: "devcare.clean".into(),
                resource: String::new(),
                outcome: "maybe".into(),
                details: String::new(),
            }))
            .await
            .unwrap_err();
        assert_eq!(bad.code(), tonic::Code::InvalidArgument);

        // A nameless principal / op is rejected.
        for (principal, op) in [("  ", "devcare.clean"), ("com.x", "  ")] {
            let err = s
                .record_audit(Request::new(amos_proto::amos_privacy::AuditRecord {
                    ts: 0,
                    principal: principal.into(),
                    op: op.into(),
                    resource: String::new(),
                    outcome: "success".into(),
                    details: String::new(),
                }))
                .await
                .unwrap_err();
            assert_eq!(err.code(), tonic::Code::InvalidArgument);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn record_audit_without_a_durable_sink_reports_not_recorded() {
        // `svc()` builds a manager with NO sink: the honest answer is `ok=false`
        // (never a false "recorded" that would fake a trail).
        let (s, _m) = svc();
        let reply = s
            .record_audit(Request::new(amos_proto::amos_privacy::AuditRecord {
                ts: 0,
                principal: "com.amos.devocare".into(),
                op: "app.uninstall".into(),
                resource: "com.example.game".into(),
                outcome: "success".into(),
                details: String::new(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(!reply.ok, "no sink ⇒ not persisted");
        assert!(reply.message.contains("AMOS_PRIVACY_PATH"));
    }

    #[tokio::test]
    async fn recent_trail_reads_the_unified_sink_and_filters_by_principal() {
        let dir = std::env::temp_dir().join(format!("amos-priv-trail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.jsonl");
        let sink = AuditFile::open(&path, 16).unwrap();
        let m = Arc::new(PrivacyManager::with_audit_file(16, sink));
        let s = PrivacySvc::new(m, None);

        // A privacy decision lands in the *same* unified sink…
        s.authorize(Request::new(ResourceRef {
            app_id: "com.amos.phone".into(),
            resource: "microphone".into(),
        }))
        .await
        .unwrap();

        // …as do ingested device-care actions.
        for (op, resource, outcome, details) in [
            (
                "devcare.clean",
                "app_cache,log_file",
                "success",
                "freed_bytes=175",
            ),
            (
                "app.uninstall",
                "com.android.settings",
                "rejected",
                "protected",
            ),
        ] {
            s.record_audit(Request::new(amos_proto::amos_privacy::AuditRecord {
                ts: 0,
                principal: "com.amos.devocare".into(),
                op: op.into(),
                resource: resource.into(),
                outcome: outcome.into(),
                details: details.into(),
            }))
            .await
            .unwrap();
        }

        // Unfiltered: the whole trail, newest first.
        let all = s
            .recent_trail(Request::new(AuditQuery {
                app_id: String::new(),
                resource: String::new(),
                limit: 10,
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(all.durable, "a sink is attached");
        assert_eq!(all.records.len(), 3, "1 decision + 2 ingested");
        assert_eq!(all.records[0].op, "app.uninstall");
        assert_eq!(all.records[1].op, "devcare.clean");
        assert_eq!(all.records[2].op, "perm.authorize");

        // Filtered by principal (the device-care actor).
        let care = s
            .recent_trail(Request::new(AuditQuery {
                app_id: "com.amos.devocare".into(),
                resource: String::new(),
                limit: 10,
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(care.records.len(), 2);
        assert!(care
            .records
            .iter()
            .all(|r| r.principal == "com.amos.devocare"));
        assert_eq!(
            care.records[0].outcome, "rejected",
            "a refusal must be visible in the trail"
        );
        assert_eq!(care.records[1].outcome, "success");
        assert_eq!(care.records[1].details, "freed_bytes=175");

        // Filtered by resource.
        let by_res = s
            .recent_trail(Request::new(AuditQuery {
                app_id: String::new(),
                resource: "com.android.settings".into(),
                limit: 10,
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(by_res.records.len(), 1);
        assert_eq!(by_res.records[0].op, "app.uninstall");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn recent_trail_without_a_sink_is_honestly_not_durable() {
        // An empty list must never be mistaken for "nothing ever happened".
        let (s, _m) = svc();
        let reply = s
            .recent_trail(Request::new(AuditQuery {
                app_id: String::new(),
                resource: String::new(),
                limit: 10,
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(!reply.durable, "no sink ⇒ a trail cannot exist");
        assert!(reply.records.is_empty());
    }
}
