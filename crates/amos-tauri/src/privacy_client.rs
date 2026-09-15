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

/// Maximum bytes in an `app_id` / `resource` string handed in from the WebView.
///
/// Real ids are reverse-DNS (`org.amos.app`, ~16 chars); real resource names
/// are one of a fixed small set (`microphone`, `camera`, …, ≤16 chars). 128 B is
/// comfortably above any real value and prevents a paste-sized caller from
/// shipping a 10 MB string into the daemon's gRPC header.
pub const MAX_PRIVACY_ID_BYTES: usize = 128;

/// Maximum `limit` value for `perm_recent_audit` / `perm_recent_trail`.
///
/// The daemon returns at most this many records; an unbounded `limit` would be
/// a vector an attacker can pump to gigabytes via repeated calls. 1 000 covers
/// a generous UI review surface; anything larger must be paginated.
pub const MAX_PRIVACY_AUDIT_LIMIT: u32 = 1000;

/// Upper bound on the number of records a single `perm_record_audit` call may
/// ship (`Vec<PermissionAudit>`). Symmetric with [`MAX_PRIVACY_AUDIT_LIMIT`]
/// (the read-side cap) so the daemon never sees a write batch larger than the
/// read window it serves.
pub const MAX_PRIVACY_AUDIT_BATCH: usize = 1000;

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
    check_privacy_id(&app_id)?;
    check_privacy_id(&resource)?;
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
    check_privacy_id(&app_id)?;
    check_privacy_id(&resource)?;
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
    check_privacy_id(&app_id)?;
    check_privacy_id(&resource)?;
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
    check_privacy_id(&app_id)?;
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
    if let Some(s) = app_id.as_deref() {
        check_privacy_id(s)?;
    }
    if let Some(s) = resource.as_deref() {
        check_privacy_id(s)?;
    }
    check_privacy_limit(limit)?;
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
    if let Some(s) = principal.as_deref() {
        check_privacy_id(s)?;
    }
    if let Some(s) = resource.as_deref() {
        check_privacy_id(s)?;
    }
    check_privacy_limit(limit)?;
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
    // Bound the batch at the seam: a runaway caller shipping thousands of
    // records in one `invoke` would block the daemon's gRPC thread (each record
    // is a separate unary call here). 1000 mirrors `MAX_PRIVACY_AUDIT_LIMIT` —
    // the read side's batch ceiling — and is the natural symmetric write cap.
    if records.len() > MAX_PRIVACY_AUDIT_BATCH {
        return Err(format!(
            "perm_record_audit batch too large: {} records (max {MAX_PRIVACY_AUDIT_BATCH})",
            records.len()
        ));
    }
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

/// Bound an `app_id` / `resource` string and refuse NUL/control characters and
/// path-traversal shapes. Mirrors the spirit of [`crate::appstore::check_appstore_id`]
/// (a resource id is a routing key, not a path segment — but a paste-sized id
/// reaching the daemon's gRPC header is enough of a concern to bound it at the
/// command seam). The same `valid_id` regex the daemon enforces is documented but
/// not duplicated here; the seam is `len() ≤ MAX` + no NUL/control.
fn check_privacy_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("privacy id is empty".to_string());
    }
    if id.len() > MAX_PRIVACY_ID_BYTES {
        return Err(format!(
            "privacy id too long: {} bytes (max {MAX_PRIVACY_ID_BYTES})",
            id.len()
        ));
    }
    if id.chars().any(|c| c == '\0' || c.is_control()) {
        return Err("privacy id contains control characters".to_string());
    }
    Ok(())
}

/// Cap the `limit` field of audit/trail queries so a caller cannot ask for an
/// unbounded number of records. The daemon itself enforces a per-call ceiling,
/// but the bridge clamps here so an over-limit request is rejected with a clear
/// reason instead of the daemon's generic "bad request".
fn check_privacy_limit(limit: u32) -> Result<(), String> {
    if limit > MAX_PRIVACY_AUDIT_LIMIT {
        return Err(format!(
            "limit too large: {limit} (max {MAX_PRIVACY_AUDIT_LIMIT})"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{check_privacy_id, check_privacy_limit, MAX_PRIVACY_AUDIT_LIMIT};

    #[test]
    fn privacy_id_accepts_normal_shapes() {
        for ok in [
            "org.amos.app",
            "microphone",
            "x".repeat(super::MAX_PRIVACY_ID_BYTES).as_str(),
        ] {
            assert!(
                check_privacy_id(ok).is_ok(),
                "{ok:?} is a legitimate privacy id"
            );
        }
    }

    #[test]
    fn privacy_id_rejects_nul_and_oversized() {
        // The byte cap, not the char cap, is the authoritative bounds check —
        // a multi-byte glyph id still fits if its UTF-8 length is within the cap.
        let huge = "x".repeat(super::MAX_PRIVACY_ID_BYTES + 1);
        assert!(check_privacy_id(&huge).is_err());
        assert!(check_privacy_id("a\0b").is_err(), "NUL must be refused");
        assert!(check_privacy_id("a\nb").is_err(), "newline control refused");
    }

    #[test]
    fn privacy_limit_caps_huge_values() {
        // The cap has headroom for the UI's "review all" surface (1000 rows)
        // but rejects the obvious memory pumping shapes.
        assert!(check_privacy_limit(MAX_PRIVACY_AUDIT_LIMIT).is_ok());
        assert!(check_privacy_limit(u32::MAX).is_err());
    }
}
