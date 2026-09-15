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
//!   pretending they are a rate;
//! * a reading has **no expiry of its own**: `last_seen_ms` is the age *at the moment the
//!   daemon answered*. Dating and re-reading is therefore the reader's job, and this bridge's
//!   only consumer does both — `LinkPage.svelte` prints the read time (`link.probe`), re-reads
//!   every 10 s while it is open and visible, and drops the numbers when a re-read gets no
//!   answer instead of leaving a frozen table on screen.
//!
//! This is the control plane only: the data plane (stereo frames, joint set points)
//! never travels through gRPC, and this bridge does not pretend to read it.

use amos_proto::amos_link::{
    robot_link_client::RobotLinkClient, Actuation as ProtoActuation, Empty, HealthState,
    LinkStatus, Metrics, Peer,
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

/// A command that was refused before it reached the bus, as the robot reported it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkRefusalOut {
    /// The link sequence of the refused action.
    pub seq: u64,
    /// Why it was refused (the robot's own words).
    pub reason: String,
}

/// What one robot says about its own actuation (the control loop's **return path**).
///
/// The reports travel the data plane (`amos/<robot>/state/actuation`); the daemon folds them
/// and hands them back over the control plane, which is how an app that is not on the link —
/// this UI — can show what a robot is *doing*, not just that it exists.
///
/// The proto has no `Option`, so "absent" arrives as `0` / `""` and is turned back into `None`
/// here: a UI must be able to tell "never armed" from "armed with value 0", and an e-stop
/// reason this build does not know stays `None` while `estopped` still says torque was cut.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkActuationOut {
    /// The reporting peer (also the frame's publisher).
    pub robot: String,
    /// The last action it acted on (`None` before any).
    pub seq: Option<u64>,
    /// The last accepted gait (`None` before one was accepted).
    pub gait: Option<String>,
    /// Frames written to the bus for that action.
    pub frames: u64,
    /// Drivers energized (read from the bus by the robot, never inferred here).
    pub armed: bool,
    /// Torque is cut and latched until an explicit arm.
    pub estopped: bool,
    /// `"commanded"` | `"watchdog"` | `None` (none, or a reason this build does not know).
    pub estop_reason: Option<String>,
    /// The deadman period the robot runs under (`None` = no watchdog configured).
    pub watchdog_ms: Option<u64>,
    /// The most recent refusal, if any.
    pub last_refusal: Option<LinkRefusalOut>,
    /// When the robot published the report (ms since the epoch, from its own clock).
    pub stamp_ms: u64,
}

/// Map one folded report. Nothing here invents a value the robot did not report.
pub fn actuation_out(a: &ProtoActuation) -> LinkActuationOut {
    LinkActuationOut {
        robot: a.robot.clone(),
        seq: (a.seq != 0).then_some(a.seq),
        gait: Some(a.gait.clone()).filter(|g| !g.is_empty()),
        frames: u64::from(a.frames),
        armed: a.armed,
        estopped: a.estopped,
        // Only the tokens this build knows: an unknown reason from a newer robot is not
        // guessed at *or* passed through as if it were a verdict of ours — `estopped` still
        // tells the UI that torque was cut, which is the safety fact.
        estop_reason: match a.estop_reason.as_str() {
            "commanded" | "watchdog" => Some(a.estop_reason.clone()),
            _ => None,
        },
        watchdog_ms: (a.watchdog_ms != 0).then_some(a.watchdog_ms),
        last_refusal: (!a.last_refusal.is_empty()).then(|| LinkRefusalOut {
            seq: a.last_refusal_seq,
            reason: a.last_refusal.clone(),
        }),
        stamp_ms: a
            .stamp_secs
            .saturating_mul(1000)
            .saturating_add(u64::from(a.stamp_nanos) / 1_000_000),
    }
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
    /// What each robot says about itself (the return path, folded by the daemon) — sorted by
    /// robot id. Empty means **nobody has reported**, which is not the same as idle.
    pub actuations: Vec<LinkActuationOut>,
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

/// Map a full wire status, with the robots' reports the daemon folded in beside it.
pub fn status_out(status: &LinkStatus, actuations: Vec<LinkActuationOut>) -> LinkStatusOut {
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
        actuations,
    }
}

/// Read the running daemon's AmOS-Link status (identity, counters, peers, verdict) **and** the
/// robots' own actuation reports (the return path, folded by the daemon).
///
/// A daemon that is not running is an `Err` the UI renders as "not connected" — this command
/// never fabricates a link status, and it never claims the data plane.
#[tauri::command]
pub async fn link_status() -> Result<LinkStatusOut, String> {
    let mut client = RobotLinkClient::new(daemon::channel().await?);
    let reply = client
        .get_status(Empty {})
        .await
        .map_err(|e| format!("robot-link status failed: {e}"))?
        .into_inner();
    let robots = client
        .list_actuations(Empty {})
        .await
        .map_err(|e| format!("robot-link ListActuations failed: {e}"))?
        .into_inner()
        .robots;
    Ok(status_out(
        &reply,
        robots.iter().map(actuation_out).collect(),
    ))
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
        let out = status_out(&status(), Vec::new());
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
        assert_eq!(
            status_out(&s, Vec::new()).metrics,
            LinkMetricsOut::default()
        );
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
        let out = status_out(&s, Vec::new());
        assert!(out.peers.is_empty());
        assert_eq!(out.health, "unknown");
        assert!(out.health_reasons.is_empty());
    }

    #[test]
    fn a_folded_report_decodes_without_inventing_anything() {
        // Before any action: the proto's sentinels mean "absent", not "zero".
        let idle = ProtoActuation {
            robot: "dog1".into(),
            seq: 0,
            gait: String::new(),
            frames: 0,
            armed: false,
            estopped: false,
            estop_reason: String::new(),
            watchdog_ms: 0,
            last_refusal_seq: 0,
            last_refusal: String::new(),
            stamp_secs: 7,
            stamp_nanos: 500_000_000,
        };
        let out = actuation_out(&idle);
        assert_eq!(out.robot, "dog1");
        assert_eq!(out.seq, None);
        assert_eq!(out.gait, None);
        assert_eq!(out.estop_reason, None);
        assert_eq!(out.watchdog_ms, None);
        assert_eq!(out.last_refusal, None);
        assert_eq!(out.stamp_ms, 7_500);

        // A real report travels verbatim, refusal and reason included.
        let stopped = ProtoActuation {
            seq: 12,
            gait: "estop".into(),
            frames: 12,
            estopped: true,
            estop_reason: "watchdog".into(),
            watchdog_ms: 1000,
            last_refusal_seq: 13,
            last_refusal: "e-stop latched".into(),
            ..idle.clone()
        };
        let out = actuation_out(&stopped);
        assert_eq!(out.seq, Some(12));
        assert_eq!(out.gait.as_deref(), Some("estop"));
        assert!(out.estopped && !out.armed);
        assert_eq!(out.estop_reason.as_deref(), Some("watchdog"));
        assert_eq!(out.watchdog_ms, Some(1000));
        assert_eq!(out.frames, 12);
        let refusal = out.last_refusal.expect("the refusal travels");
        assert_eq!(refusal.seq, 13);
        assert_eq!(refusal.reason, "e-stop latched");

        // A reason from a newer robot stays unknown while `estopped` still says torque was
        // cut: the UI shows "cut, reason unknown" rather than a guessed reason or "not cut".
        let newer = ProtoActuation {
            estop_reason: "meltdown".into(),
            ..stopped
        };
        let out = actuation_out(&newer);
        assert!(out.estopped, "the safety fact survives an unknown reason");
        assert_eq!(out.estop_reason, None, "an unknown verdict is not invented");
    }
}
