//! Tauri ⇄ daemon AmOS-Link control-plane bridge (robot-middleware status).
//!
//! The daemon mounts `RobotLink` (`proto/robot_link.proto`) on the shared UDS beside
//! AiAgent / Sensor / Telephony; this module exposes one read-only command, so the
//! System UI can answer the operator's question — *is the robot on the link, who else
//! is, and can the latency numbers be trusted?* — without a terminal. Before this
//! existed the control plane's only callers were the CLI (`--socket`) and external
//! tooling, and `docs/amos-link.md` §6 recorded the missing GUI consumer as a boundary.
//!
//! Honest boundaries (mirrored by the page, `link.boundary`):
//! * the verdict is the **daemon's own** `health` fold; `unknown` means *no evidence
//!   yet* (`HEALTH_UNKNOWN`), which is deliberately not the same as healthy, and the
//!   reasons travel with it so the UI never shows a bare "OK";
//! * `clock_synced: false` means the link's latency numbers are **bounds**, not
//!   measurements (`amos-timesync` has not calibrated the clock);
//! * the counters are cumulative and never reset — the page says so rather than
//!   pretending they are a rate.
//!
//! This is the control plane only: the data plane (stereo frames, joint set points)
//! never travels through gRPC, and this bridge does not pretend to read it.

use amos_proto::amos_link::{
    robot_link_client::RobotLinkClient, Empty, HealthState, LinkStatus, Metrics, Peer,
};
use serde::Serialize;

use crate::daemon;

/// One peer in the link's table, serializable for the WebView.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkPeerOut {
    /// Stable peer id (`amos/<id>/…`).
    pub id: String,
    /// `robot` | `brain` | `sensor` | `actuator` | `tool` | `unknown`.
    pub kind: String,
    /// Transport endpoint when the beacon carried one (`None`, never `""`).
    pub endpoint: Option<String>,
    /// Age of the last evidence in ms.
    pub last_seen_ms: u64,
    /// Beacons observed; `0` means the peer was declared by hand (static, never expires).
    pub beacons: u64,
}

/// Cumulative link counters, as the daemon reports them (never reset, never faked).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct LinkMetricsOut {
    pub published: u64,
    pub delivered: u64,
    pub dropped: u64,
    pub blocked: u64,
    pub decode_errors: u64,
    pub encode_errors: u64,
}

/// Serializable mirror of the daemon's `LinkStatus` (prost structs are not `Serialize`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkStatusOut {
    /// This node's peer id.
    pub peer: String,
    /// This node's kind.
    pub kind: String,
    /// `amos-link` crate version the daemon runs.
    pub version: String,
    pub uptime_ms: u64,
    /// True only when a calibrated clock is in use (else latencies are bounds).
    pub clock_synced: bool,
    /// `"unknown"` | `"healthy"` | `"degraded"` | `"unrecognized"`.
    pub health: String,
    /// Why that verdict, one token per reason (empty for a healthy link).
    pub health_reasons: Vec<String>,
    pub metrics: LinkMetricsOut,
    pub peers: Vec<LinkPeerOut>,
}

/// Map the wire enum to a stable display token.
///
/// An enum value this build does not know (a newer daemon) is reported as
/// `"unrecognized"` rather than being folded into one of the three it does know —
/// guessing a verdict is exactly what this bridge must not do.
pub fn health_str(raw: i32) -> String {
    match raw {
        raw if raw == HealthState::HealthUnknown as i32 => "unknown",
        raw if raw == HealthState::HealthHealthy as i32 => "healthy",
        raw if raw == HealthState::HealthDegraded as i32 => "degraded",
        _ => "unrecognized",
    }
    .to_string()
}

/// Map one wire peer, turning an absent endpoint into `None` (not an empty string).
pub fn peer_out(peer: &Peer) -> LinkPeerOut {
    LinkPeerOut {
        id: peer.id.clone(),
        kind: peer.kind.clone(),
        endpoint: Some(peer.endpoint.clone()).filter(|e| !e.is_empty()),
        last_seen_ms: peer.last_seen_ms,
        beacons: peer.beacons,
    }
}

/// Map the wire metrics block; an absent block is all-zero (the daemon always sends
/// one, but a missing field must not become an invented reading).
pub fn metrics_out(metrics: Option<&Metrics>) -> LinkMetricsOut {
    match metrics {
        Some(m) => LinkMetricsOut {
            published: m.published,
            delivered: m.delivered,
            dropped: m.dropped,
            blocked: m.blocked,
            decode_errors: m.decode_errors,
            encode_errors: m.encode_errors,
        },
        None => LinkMetricsOut::default(),
    }
}

/// Map a full wire status.
pub fn status_out(status: &LinkStatus) -> LinkStatusOut {
    LinkStatusOut {
        peer: status.peer.clone(),
        kind: status.kind.clone(),
        version: status.version.clone(),
        uptime_ms: status.uptime_ms,
        clock_synced: status.clock_synced,
        health: health_str(status.health),
        health_reasons: status.health_reasons.clone(),
        metrics: metrics_out(status.metrics.as_ref()),
        peers: status.peers.iter().map(peer_out).collect(),
    }
}

/// Read the running daemon's AmOS-Link status (identity, counters, peers, verdict).
///
/// A daemon that is not running is an `Err` the UI renders as "not connected" — this
/// command never fabricates a link status, and it never claims the data plane.
#[tauri::command]
pub async fn link_status() -> Result<LinkStatusOut, String> {
    let mut client = RobotLinkClient::new(daemon::channel().await?);
    let reply = client
        .get_status(Empty {})
        .await
        .map_err(|e| format!("robot-link status failed: {e}"))?
        .into_inner();
    Ok(status_out(&reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status() -> LinkStatus {
        LinkStatus {
            peer: "amos-daemon".into(),
            kind: "brain".into(),
            version: "0.1.0".into(),
            uptime_ms: 4200,
            clock_synced: false,
            metrics: Some(Metrics {
                published: 12,
                delivered: 12,
                dropped: 0,
                decode_errors: 0,
                peers: 1,
                encode_errors: 0,
                blocked: 0,
            }),
            peers: vec![Peer {
                id: "dog1".into(),
                kind: "robot".into(),
                endpoint: "tcp/10.0.0.7:7447".into(),
                last_seen_ms: 300,
                beacons: 7,
            }],
            health: HealthState::HealthDegraded as i32,
            health_reasons: vec!["no_peers".into(), "clock_unsynced".into()],
        }
    }

    #[test]
    fn maps_a_status_verbatim() {
        let out = status_out(&status());
        assert_eq!(out.peer, "amos-daemon");
        assert_eq!(out.kind, "brain");
        assert_eq!(out.uptime_ms, 4200);
        assert!(!out.clock_synced);
        assert_eq!(out.health, "degraded");
        assert_eq!(out.health_reasons, vec!["no_peers", "clock_unsynced"]);
        assert_eq!(out.metrics.published, 12);
        assert_eq!(out.metrics.dropped, 0);
        assert_eq!(out.peers.len(), 1);
        assert_eq!(out.peers[0].id, "dog1");
        assert_eq!(out.peers[0].kind, "robot");
        assert_eq!(out.peers[0].beacons, 7);
    }

    #[test]
    fn an_absent_endpoint_is_none_not_an_empty_string() {
        // "no endpoint" and "an endpoint that is the empty string" must not look alike.
        let mut p = Peer {
            id: "tool".into(),
            kind: "tool".into(),
            endpoint: String::new(),
            last_seen_ms: 0,
            beacons: 0,
        };
        assert_eq!(peer_out(&p).endpoint, None);
        p.endpoint = "tcp/1.2.3.4:7447".into();
        assert_eq!(peer_out(&p).endpoint.as_deref(), Some("tcp/1.2.3.4:7447"));
    }

    #[test]
    fn unknown_enum_bits_are_never_guessed_into_a_verdict() {
        // A newer daemon's verdict this build does not know must not be folded into
        // "healthy" (which would be a false all-clear) or "degraded".
        assert_eq!(health_str(99), "unrecognized");
        assert_eq!(health_str(-1), "unrecognized");
        assert_eq!(health_str(HealthState::HealthUnknown as i32), "unknown");
        assert_eq!(health_str(HealthState::HealthHealthy as i32), "healthy");
        assert_eq!(health_str(HealthState::HealthDegraded as i32), "degraded");
    }

    #[test]
    fn a_missing_metrics_block_reads_as_all_zero_not_a_guess() {
        assert_eq!(metrics_out(None), LinkMetricsOut::default());
        let mut s = status();
        s.metrics = None;
        assert_eq!(status_out(&s).metrics, LinkMetricsOut::default());
    }

    #[test]
    fn an_empty_link_is_representable() {
        let s = LinkStatus {
            peer: "amos-daemon".into(),
            kind: "brain".into(),
            version: "0.1.0".into(),
            uptime_ms: 0,
            clock_synced: false,
            metrics: None,
            peers: Vec::new(),
            health: HealthState::HealthUnknown as i32,
            health_reasons: Vec::new(),
        };
        let out = status_out(&s);
        assert!(out.peers.is_empty());
        assert_eq!(out.health, "unknown");
        assert!(out.health_reasons.is_empty());
    }
}
