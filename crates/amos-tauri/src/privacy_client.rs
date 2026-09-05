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
use amos_proto::amos_privacy::{AppRef, AuditQuery, GrantRequest, ResourceRef};
use serde::Serialize;

async fn build_channel() -> Result<tonic::transport::Channel, String> {
    crate::daemon::channel().await
}

/// Serializable mirror of one normalized daemon audit record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PermissionAudit {
    pub ts: u64,
    pub principal: String,
    pub op: String,
    pub resource: String,
    pub outcome: String, // "granted" | "denied" | "success" | "rejected" | "error"
    pub details: String,
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
    Ok(reply
        .records
        .into_iter()
        .map(|r| PermissionAudit {
            ts: r.ts,
            principal: r.principal,
            op: r.op,
            resource: r.resource,
            outcome: r.outcome,
            details: r.details,
        })
        .collect())
}
