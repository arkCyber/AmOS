//! Tauri <-> daemon OS-permissions (PrivacyManager) bridge.
//!
//! The WebView's privacy dashboards and the sensitive-capability gates call
//! these commands; each opens a `PrivacyServiceClient` over the OS daemon's
//! Unix Domain Socket (same socket as `AiAgent`/`Sensor`/…), runs the RPC, and
//! returns a serializable mirror (prost types don't impl `Serialize`). The
//! **daemon is the single authority**: `perm_authorize` is the one chokepoint
//! and every decision is audited there. If the daemon is absent the commands
//! fail with a descriptive error (the UI shows "daemon not connected" rather
//! than silently granting or crashing).
//!
//! Mirrors the `system`/`sensors` bridge shape. Wire contract:
//! `proto/privacy.proto`; resources are stable keys ("microphone" | "camera" |
//! "contacts" | "location" | "storage"); unknown keys are rejected by the daemon.

use amos_proto::amos_privacy::privacy_service_client::PrivacyServiceClient;
use amos_proto::amos_privacy::{
    AllGrantsRequest, AppRef, AuditQuery, AuditRecord as WireAuditRecord, GrantRequest, ResourceRef,
};
use serde::{Deserialize, Serialize};

async fn build_channel() -> Result<crate::daemon::DaemonChannel, String> {
    crate::daemon::channel().await
}

/// Serializable mirror of one normalized daemon audit record.
///
/// `Deserialize` too: it doubles as the **ingest** shape for
/// [`perm_record_audit`], so the device-care bridge sends the same fields the
/// daemon reports back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionAudit {
    pub ts: u64,
    pub principal: String,
    pub op: String,
    pub resource: String,
    pub outcome: String, // "granted" | "denied" | "success" | "rejected" | "error"
    pub details: String,
}

/// A window of the unified durable trail, with whether it can exist at all.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AuditTrail {
    pub records: Vec<PermissionAudit>,
    /// False when the daemon has **no durable sink** — the trail cannot exist,
    /// and an empty `records` must not be read as "nothing ever happened".
    pub durable: bool,
}

/// The authoritative decision for one app+resource access request.
#[tauri::command]
pub async fn perm_authorize(app_id: String, resource: String) -> Result<bool, String> {
    let mut client = PrivacyServiceClient::new(build_channel().await?);
    let reply = client
        .authorize(ResourceRef { app_id, resource })
        .await
        .map_err(|e| format!("permission authorize failed: {e}"))?
        .into_inner();
    Ok(reply.granted)
}

/// Grant one sensitive resource to an app (persists when the daemon has a state file).
#[tauri::command]
pub async fn perm_grant(app_id: String, resource: String) -> Result<(), String> {
    let mut client = PrivacyServiceClient::new(build_channel().await?);
    client
        .grant(GrantRequest { app_id, resource })
        .await
        .map_err(|e| format!("permission grant failed: {e}"))?;
    Ok(())
}

/// Revoke one sensitive resource from an app.
#[tauri::command]
pub async fn perm_revoke(app_id: String, resource: String) -> Result<(), String> {
    let mut client = PrivacyServiceClient::new(build_channel().await?);
    client
        .revoke(GrantRequest { app_id, resource })
        .await
        .map_err(|e| format!("permission revoke failed: {e}"))?;
    Ok(())
}

/// The resources an app currently holds (sorted; empty = deny-by-default).
#[tauri::command]
pub async fn perm_granted(app_id: String) -> Result<Vec<String>, String> {
    let mut client = PrivacyServiceClient::new(build_channel().await?);
    let reply = client
        .granted(AppRef { app_id })
        .await
        .map_err(|e| format!("permission granted-list failed: {e}"))?
        .into_inner();
    Ok(reply.resources)
}

/// Map one wire audit record into the serializable mirror.
fn map_audit(r: WireAuditRecord) -> PermissionAudit {
    PermissionAudit {
        ts: r.ts,
        principal: r.principal,
        op: r.op,
        resource: r.resource,
        outcome: r.outcome,
        details: r.details,
    }
}

/// One app and the sensitive resources the **daemon** says it holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GrantRow {
    pub app_id: String,
    pub resources: Vec<String>,
}

/// Every app holding at least one grant, straight from the daemon authority.
///
/// This is what a permission *review* must read: a frontend-local cache can
/// disagree with the daemon, and deny-by-default means "no rows" really does
/// mean "nothing is granted". One round-trip (not N per-app calls).
#[tauri::command]
pub async fn perm_grants_all() -> Result<Vec<GrantRow>, String> {
    let mut client = PrivacyServiceClient::new(build_channel().await?);
    let reply = client
        .granted_all(AllGrantsRequest {})
        .await
        .map_err(|e| format!("permission grants-all failed: {e}"))?
        .into_inner();
    Ok(reply
        .apps
        .into_iter()
        .map(|a| GrantRow {
            app_id: a.app_id,
            resources: a.resources,
        })
        .collect())
}

/// Recent audited access decisions (newest first). Empty filter = any.
#[tauri::command]
pub async fn perm_recent_audit(
    app_id: Option<String>,
    resource: Option<String>,
    limit: u32,
) -> Result<Vec<PermissionAudit>, String> {
    let mut client = PrivacyServiceClient::new(build_channel().await?);
    let reply = client
        .recent_audit(AuditQuery {
            app_id: app_id.unwrap_or_default(),
            resource: resource.unwrap_or_default(),
            limit,
        })
        .await
        .map_err(|e| format!("permission recent-audit failed: {e}"))?
        .into_inner();
    Ok(reply.records.into_iter().map(map_audit).collect())
}

/// The daemon's **unified durable trail** (newest first) plus its durability.
///
/// Unlike [`perm_recent_audit`] (which reads only the privacy *decision* window),
/// this reads the shared `AuditFile`: privacy decisions **and** every record
/// ingested via `RecordAudit` (device-care cleans, app uninstalls).
///
/// `durable = false` means no sink is attached, so a trail **cannot** exist — the
/// caller must not render the empty list as "nothing ever happened".
#[tauri::command]
pub async fn perm_recent_trail(
    principal: Option<String>,
    resource: Option<String>,
    limit: u32,
) -> Result<AuditTrail, String> {
    let mut client = PrivacyServiceClient::new(build_channel().await?);
    let reply = client
        .recent_trail(AuditQuery {
            app_id: principal.unwrap_or_default(),
            resource: resource.unwrap_or_default(),
            limit,
        })
        .await
        .map_err(|e| format!("permission recent-trail failed: {e}"))?
        .into_inner();
    Ok(AuditTrail {
        records: reply.records.into_iter().map(map_audit).collect(),
        durable: reply.durable,
    })
}

/// The outcome of an audit-ingest batch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AuditIngest {
    /// Records the daemon confirmed **persisted**.
    pub recorded: u32,
    /// Records the bridge asked the daemon to persist.
    pub total: u32,
    /// The first failure, if any. Later records are still attempted: one bad
    /// record must not drop the rest of a trail.
    pub error: Option<String>,
}

/// Append externally-produced audit records (a device-care clean, an app
/// uninstall) to the daemon's **unified durable sink** — the same JSON-lines
/// trail the privacy decisions are mirrored to.
///
/// Reports how many records the daemon confirmed persisted. The daemon answers
/// `ok = false` when it has no durable sink (`AMOS_PRIVACY_PATH` unset), so the
/// caller reports "not audited" instead of assuming a trail it does not have.
///
/// A **transport** failure (daemon absent) is a real `Err`. A per-record
/// rejection is collected into [`AuditIngest::error`] and the loop continues, so
/// a single malformed record can never silently discard the records after it.
/// The daemon's `ts` is authoritative and the `ts` sent here is a placeholder.
#[tauri::command]
pub async fn perm_record_audit(records: Vec<PermissionAudit>) -> Result<AuditIngest, String> {
    let total = records.len() as u32;
    let mut client = PrivacyServiceClient::new(build_channel().await?);
    let mut recorded = 0u32;
    let mut error: Option<String> = None;

    for r in records {
        match client
            .record_audit(WireAuditRecord {
                ts: r.ts,
                principal: r.principal,
                op: r.op,
                resource: r.resource,
                outcome: r.outcome,
                details: r.details,
            })
            .await
        {
            Ok(reply) => {
                if reply.into_inner().ok {
                    recorded += 1;
                }
                // `ok = false` is not an error: the daemon simply has no durable
                // sink, which the caller reports as "not recorded".
            }
            Err(e) => {
                if error.is_none() {
                    error = Some(format!("permission record-audit failed: {e}"));
                }
            }
        }
    }

    Ok(AuditIngest {
        recorded,
        total,
        error,
    })
}
