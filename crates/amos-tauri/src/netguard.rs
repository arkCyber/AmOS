//! Tauri <-> daemon egress "network guard" (`NetGuardService`) bridge.
//!
//! The WebView's privacy/security settings surface calls these commands to arm /
//! disarm the daemon's egress guard and read its status + small audit summary.
//! Each command opens a `NetGuardServiceClient` over the OS daemon's Unix Domain
//! Socket (same socket as `AiAgent`/`Sensor`/`PrivacyService`), runs the RPC, and
//! returns a serializable mirror (prost types don't impl `Serialize`).
//!
//! Honest boundaries (see `proto/netguard.proto` + `crates/amos-network-guard`):
//! the default host build backs the guard with the in-process **Mock**, so
//! `NetGuardStatus.enforced` is `false` and arming records **intent**, never a
//! fabricated "blocked". The mirror carries that through unchanged — the UI never
//! shows a firewall as enforcing when no real backend (rootless `VpnService` or
//! AOSP/rooted nftables) is installed. If the daemon is absent the commands fail
//! with a descriptive error (the UI shows "daemon not connected" rather than
//! pretending to arm or crash).
//!
//! Mirrors the `privacy_client` / `system` bridge shape. Wire contract:
//! `proto/netguard.proto`.

use amos_proto::amos_netguard::net_guard_service_client::NetGuardServiceClient;
use amos_proto::amos_netguard::{StatusReply, StatusRequest, ToggleReply, ToggleRequest};
use serde::Serialize;

async fn build_channel() -> Result<tonic::transport::Channel, String> {
    crate::daemon::channel().await
}

/// Serializable mirror of one daemon `ToggleReply`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NetGuardToggle {
    pub enabled: bool,
    pub message: String,
}

/// One top egress domain (by bytes) from the daemon's rolling counter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NetGuardEgressSample {
    pub domain: String,
    pub bytes: u64,
}

/// Serializable mirror of one daemon `StatusReply`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NetGuardStatus {
    /// User intent: is the guard armed?
    pub enabled: bool,
    /// The enforcement backend in use: `"mock"` (default host) | `"vpn"` | `"nftables"`.
    pub backend: String,
    /// True ONLY when a real backend is actually enforcing on this device.
    pub enforced: bool,
    /// Number of egress policy rules the guard holds.
    pub policy_rules: u64,
    /// Top domains by bytes in the current audit window (empty when no data).
    pub top_egress: Vec<NetGuardEgressSample>,
}

/// Map a daemon `ToggleReply` onto its serializable mirror (pure; unit-tested).
fn to_toggle(r: &ToggleReply) -> NetGuardToggle {
    NetGuardToggle {
        enabled: r.enabled,
        message: r.message.clone(),
    }
}

/// Map a daemon `StatusReply` onto its serializable mirror (pure; unit-tested).
fn to_status(r: &StatusReply) -> NetGuardStatus {
    NetGuardStatus {
        enabled: r.enabled,
        backend: r.backend.clone(),
        // Deliberately forwarded verbatim from the daemon: a Mock backend reports
        // `false` here, so the UI can never claim a firewall is enforcing when
        // only user intent was recorded.
        enforced: r.enforced,
        policy_rules: r.policy_rules,
        top_egress: r
            .top_egress
            .iter()
            .map(|s| NetGuardEgressSample {
                domain: s.domain.clone(),
                bytes: s.bytes,
            })
            .collect(),
    }
}

/// Arm or disarm the daemon's egress guard (records intent in the daemon).
#[tauri::command]
pub async fn netguard_toggle(enabled: bool) -> Result<NetGuardToggle, String> {
    let mut client = NetGuardServiceClient::new(build_channel().await?);
    let reply = client
        .toggle(ToggleRequest { enabled })
        .await
        .map_err(|e| format!("network-guard toggle failed: {e}"))?
        .into_inner();
    Ok(to_toggle(&reply))
}

/// Current armed state + backend + small audit summary from the daemon.
#[tauri::command]
pub async fn netguard_status() -> Result<NetGuardStatus, String> {
    let mut client = NetGuardServiceClient::new(build_channel().await?);
    let reply = client
        .status(StatusRequest {})
        .await
        .map_err(|e| format!("network-guard status failed: {e}"))?
        .into_inner();
    Ok(to_status(&reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_toggle_reply() {
        let t = to_toggle(&ToggleReply {
            enabled: true,
            message: "armed (intent)".into(),
        });
        assert!(t.enabled);
        assert_eq!(t.message, "armed (intent)");
    }

    #[test]
    fn maps_status_verbatim_including_not_enforced() {
        let s = to_status(&StatusReply {
            enabled: true,
            backend: "mock".into(),
            // A mock backend must surface as NOT enforcing — never a fabricated block.
            enforced: false,
            policy_rules: 3,
            top_egress: vec![amos_proto::amos_netguard::EgressSample {
                domain: "tracker.example".into(),
                bytes: 900,
            }],
        });
        assert!(s.enabled);
        assert_eq!(s.backend, "mock");
        assert!(!s.enforced);
        assert_eq!(s.policy_rules, 3);
        assert_eq!(s.top_egress.len(), 1);
        assert_eq!(s.top_egress[0].domain, "tracker.example");
        assert_eq!(s.top_egress[0].bytes, 900);
    }

    #[test]
    fn maps_an_enforcing_status_with_empty_egress() {
        let s = to_status(&StatusReply {
            enabled: true,
            backend: "nftables".into(),
            enforced: true,
            policy_rules: 0,
            top_egress: vec![],
        });
        assert!(s.enforced);
        assert!(s.top_egress.is_empty());
    }
}
