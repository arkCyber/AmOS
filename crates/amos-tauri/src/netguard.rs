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

use crate::error::{AmosError, ErrorCode};

async fn build_channel() -> Result<crate::daemon::DaemonChannel, String> {
    crate::daemon::channel().await
}

/// Wire vocabulary for the netguard / network-guard module. The UI i18n layer
/// branches on these; renaming a variant is a wire break.
pub mod codes {
    /// Network-guard toggle RPC failed (daemon unreachable / rejected).
    pub const TOGGLE_FAILED: &str = "amos.netguard.toggle_failed";
    /// Network-guard status RPC failed.
    pub const STATUS_FAILED: &str = "amos.netguard.status_failed";
}

/// Upper bound on a single top-egress sample's domain (bytes).
///
/// Real domains are ≤ 253 B (RFC 1035); 512 B is a generous ceiling that still
/// refuses a paste-sized payload before the JSON serialiser allocates a
/// megabyte-class `String`. The sample count is bounded by what the daemon
/// reports; this caps one sample.
pub const MAX_EGRESS_DOMAIN_BYTES: usize = 512;

/// Saturating byte count → UI field. Network-guard bytes are u64 on the wire;
/// the JSON serialiser does not need anything more than that, but a defensive
/// upper bound here keeps `top_egress[].bytes` from being abused as an
/// attacker-controlled storage primitive (the daemon is trusted today, but the
/// wire field has historically been a place where a stub returns `u64::MAX`
/// to "indicate error" — `1 EiB` is not a meaningful audit number).
pub const MAX_REPORTED_EGRESS_BYTES: u64 = 1 << 60; // 1 EiB

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
            .filter_map(|s| {
                // Refuse over-long domains here (the daemon validates its own
                // payload, but the wire field has historically been a place
                // where a stub returns garbage); cap a single sample's domain
                // size to keep `top_egress` from becoming a JSON megabyte-class
                // data sink.
                if s.domain.len() > MAX_EGRESS_DOMAIN_BYTES {
                    tracing::warn!(
                        target: "amos::netguard",
                        code = codes::STATUS_FAILED,
                        bytes = s.domain.len(),
                        limit = MAX_EGRESS_DOMAIN_BYTES,
                        "dropping an oversized top-egress domain"
                    );
                    return None;
                }
                let bytes = s.bytes.min(MAX_REPORTED_EGRESS_BYTES);
                Some(NetGuardEgressSample {
                    domain: s.domain.clone(),
                    bytes,
                })
            })
            .collect(),
    }
}

/// Arm or disarm the daemon's egress guard (records intent in the daemon).
///
/// Returns a typed [`AmosError`] so the UI can branch on
/// [`ErrorCode::NetGuardToggleFailed`] (e.g. to render "daemon not connected"
/// in the user's locale) without parsing the message.
#[tauri::command]
pub async fn netguard_toggle(enabled: bool) -> Result<NetGuardToggle, AmosError> {
    let mut client = NetGuardServiceClient::new(build_channel().await.map_err(|e| {
        AmosError::with_cause(ErrorCode::NetGuardToggleFailed, codes::TOGGLE_FAILED, e)
    })?);
    let reply = client
        .toggle(ToggleRequest { enabled })
        .await
        .map_err(|e| {
            AmosError::with_cause(ErrorCode::NetGuardToggleFailed, codes::TOGGLE_FAILED, e)
        })?
        .into_inner();
    Ok(to_toggle(&reply))
}

/// Current armed state + backend + small audit summary from the daemon.
#[tauri::command]
pub async fn netguard_status() -> Result<NetGuardStatus, AmosError> {
    let mut client = NetGuardServiceClient::new(build_channel().await.map_err(|e| {
        AmosError::with_cause(ErrorCode::NetGuardStatusFailed, codes::STATUS_FAILED, e)
    })?);
    let reply = client
        .status(StatusRequest {})
        .await
        .map_err(|e| {
            AmosError::with_cause(ErrorCode::NetGuardStatusFailed, codes::STATUS_FAILED, e)
        })?
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

    #[test]
    fn netguard_codes_are_stable_string_keys() {
        assert_eq!(codes::TOGGLE_FAILED, "amos.netguard.toggle_failed");
        assert_eq!(codes::STATUS_FAILED, "amos.netguard.status_failed");
    }

    #[test]
    fn oversized_top_egress_domain_is_dropped_not_blown_up() {
        // A daemon-side stub returning a megabyte-class `domain` would inflate
        // the JSON payload. The bridge refuses it; the rest of the sample row
        // survives (one bad row does not poison the table).
        let huge = "x".repeat(MAX_EGRESS_DOMAIN_BYTES + 1);
        let s = to_status(&StatusReply {
            enabled: true,
            backend: "mock".into(),
            enforced: false,
            policy_rules: 0,
            top_egress: vec![
                amos_proto::amos_netguard::EgressSample {
                    domain: huge,
                    bytes: 100,
                },
                amos_proto::amos_netguard::EgressSample {
                    domain: "tracker.example".into(),
                    bytes: 900,
                },
            ],
        });
        assert_eq!(s.top_egress.len(), 1, "the over-long row was dropped");
        assert_eq!(s.top_egress[0].domain, "tracker.example");
    }

    #[test]
    fn pathological_egress_byte_count_is_clamped_not_passed_through() {
        // The wire is u64; the previous code forwarded the field verbatim. A
        // stub returning `u64::MAX` would render "1.15 EiB" in the UI. The cap
        // clamps it to a known ceiling so the field remains a *reportable*
        // number even when the daemon hands us junk.
        let s = to_status(&StatusReply {
            enabled: true,
            backend: "mock".into(),
            enforced: false,
            policy_rules: 0,
            top_egress: vec![amos_proto::amos_netguard::EgressSample {
                domain: "a".into(),
                bytes: u64::MAX,
            }],
        });
        assert_eq!(s.top_egress[0].bytes, MAX_REPORTED_EGRESS_BYTES);
        assert!(s.top_egress[0].bytes < u64::MAX);
    }
}
