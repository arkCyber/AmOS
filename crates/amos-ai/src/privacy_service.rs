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
    AppGrants, AppRef, AuditQuery, AuditReply, DecisionReply, GrantReply, GrantRequest,
    ResourceRef,
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
/// manager) and every decision is mirrored to the durable unified audit file at
/// `<path>.jsonl`. Unset ⇒ fresh in-memory manager, no persistence.
pub fn bootstrap() -> (Arc<PrivacyManager>, Option<PathBuf>) {
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
            let audit_path = p.with_extension("jsonl");
            let sink = match AuditFile::open(&audit_path, 2048) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(
                        "could not open privacy audit {}: {e:#}; memory-only",
                        audit_path.display()
                    );
                    AuditFile::memory(2048)
                }
            };
            manager = manager.with_durable_audit(sink);
            (Arc::new(manager), Some(p))
        }
        None => (Arc::new(PrivacyManager::new(2048)), None),
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
}
