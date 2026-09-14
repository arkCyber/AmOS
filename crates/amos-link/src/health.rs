//! The link's own **verdict**: an honest fold of the counters into “is this link OK?”.
//!
//! Counters answer questions; an operator asks for a judgement. This module is that
//! judgement, and its discipline is the same as everywhere else in the crate: the verdict
//! is a **pure function** of facts the node already has, every reason carries its number,
//! and a state that cannot be justified is not claimed.
//!
//! ```text
//!   LinkHealth::evaluate(metrics, peers, clock_synced, sequence?)
//!     Unknown   ← nothing has been published, delivered or seen: no evidence, no claim
//!     Healthy   ← evidence, and no reason below fired
//!     Degraded  ← evidence, and at least one reason, each with its count
//! ```
//!
//! The reasons, and why each one is a *fact* rather than a judgement:
//!
//! | reason | means | why it is not hidden |
//! |---|---|---|
//! | `encode_errors` | this node failed to produce a frame | a local defect: the peer never saw the traffic |
//! | `decode_errors` | frames arrived that could not be decoded | a version skew or a broken/hostile producer |
//! | `back_pressure` | a reliable consumer was slower than the publisher | the policy working, but the link is not keeping up |
//! | `frame_loss` | the publisher's own counter says a frame never arrived | the only consumer-side loss evidence there is |
//! | `no_peers` | nobody else is on the link | a brain with no robot (or the reverse) is worth saying out loud |
//! | `clock_unsynced` | latency figures are bounds, not measurements | a caveat on the *numbers*, not a fault |
//!
//! **Deliberately not a reason: `dropped`.** For a best-effort stream a drop *is* the
//! policy working (latest-wins overwrites its own queue), so folding it in would make the
//! verdict cry wolf on a perfectly healthy robot. A caller that wants drop accounting has
//! `metrics.dropped` — the verdict will not pretend to interpret it.
//!
//! Honest boundary: a node sees *its own* counters, so it cannot see a consumer's sequence
//! gaps — that is per-subscription state. A caller holding a
//! [`SeqTracker`](crate::sequence::SeqTracker) passes its summary in (the CLI's `watch`
//! does exactly that), and only then can `frame_loss` appear.

use serde::{Deserialize, Serialize};

use crate::discovery::PeerView;
use crate::metrics::MetricsSnapshot;
use crate::sequence::SeqSummary;

/// One measured fact that keeps a link from being called healthy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthReason {
    /// This node failed to encode a frame it was asked to publish.
    EncodeErrors {
        /// How many.
        count: u64,
    },
    /// Frames arrived that this node could not decode.
    DecodeErrors {
        /// How many.
        count: u64,
    },
    /// Publishes that had to wait for a `Reliable` subscriber.
    BackPressure {
        /// How many.
        blocked: u64,
    },
    /// Frames the publisher's own sequence counter says never arrived.
    FrameLoss {
        /// How many frames were skipped.
        missing: u64,
        /// How many separate jumps accounted for them.
        gaps: u64,
    },
    /// No other peer is fresh in the table.
    NoPeers,
    /// The clock was never calibrated, so latencies are bounds.
    ClockUnsynced,
}

impl HealthReason {
    /// Stable key (JSON, CLI, logs).
    pub fn key(&self) -> &'static str {
        match self {
            HealthReason::EncodeErrors { .. } => "encode_errors",
            HealthReason::DecodeErrors { .. } => "decode_errors",
            HealthReason::BackPressure { .. } => "back_pressure",
            HealthReason::FrameLoss { .. } => "frame_loss",
            HealthReason::NoPeers => "no_peers",
            HealthReason::ClockUnsynced => "clock_unsynced",
        }
    }

    /// The reason with its number, as one printable token (`decode_errors=3`).
    pub fn detail(&self) -> String {
        match self {
            HealthReason::EncodeErrors { count } => format!("encode_errors={count}"),
            HealthReason::DecodeErrors { count } => format!("decode_errors={count}"),
            HealthReason::BackPressure { blocked } => format!("back_pressure={blocked}"),
            HealthReason::FrameLoss { missing, gaps } => {
                format!("frame_loss={missing} in {gaps} gap(s)")
            }
            HealthReason::NoPeers => "no_peers".to_string(),
            HealthReason::ClockUnsynced => "clock_unsynced".to_string(),
        }
    }
}

/// The link's verdict.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum LinkHealth {
    /// Nothing has been published, delivered or observed: no evidence to judge on.
    Unknown,
    /// Traffic is flowing and no reason fired.
    Healthy,
    /// The link works, but something measurable is wrong (see the reasons).
    Degraded {
        /// Every reason that fired, in a stable order.
        reasons: Vec<HealthReason>,
    },
}

impl LinkHealth {
    /// Fold the node's facts into a verdict.
    ///
    /// `sequence` is the consumer-side loss evidence, when the caller has it (a node does
    /// not: see the module docs).
    pub fn evaluate(
        metrics: &MetricsSnapshot,
        peers: &[PeerView],
        clock_synced: bool,
        sequence: Option<&SeqSummary>,
    ) -> Self {
        // No evidence at all: a verdict would be invented, so none is given.
        if metrics.published == 0 && metrics.delivered == 0 && peers.is_empty() {
            return LinkHealth::Unknown;
        }
        let mut reasons = Vec::new();
        if metrics.encode_errors > 0 {
            reasons.push(HealthReason::EncodeErrors {
                count: metrics.encode_errors,
            });
        }
        if metrics.decode_errors > 0 {
            reasons.push(HealthReason::DecodeErrors {
                count: metrics.decode_errors,
            });
        }
        if metrics.blocked > 0 {
            reasons.push(HealthReason::BackPressure {
                blocked: metrics.blocked,
            });
        }
        if let Some(sequence) = sequence {
            if sequence.has_loss() {
                reasons.push(HealthReason::FrameLoss {
                    missing: sequence.missing,
                    gaps: sequence.gaps,
                });
            }
        }
        if peers.is_empty() {
            reasons.push(HealthReason::NoPeers);
        }
        if !clock_synced {
            reasons.push(HealthReason::ClockUnsynced);
        }
        if reasons.is_empty() {
            LinkHealth::Healthy
        } else {
            LinkHealth::Degraded { reasons }
        }
    }

    /// Stable label (`"unknown"`, `"healthy"`, `"degraded"`).
    pub fn label(&self) -> &'static str {
        match self {
            LinkHealth::Unknown => "unknown",
            LinkHealth::Healthy => "healthy",
            LinkHealth::Degraded { .. } => "degraded",
        }
    }

    /// The reasons that fired (`[]` for `Unknown`/`Healthy`).
    pub fn reasons(&self) -> &[HealthReason] {
        match self {
            LinkHealth::Degraded { reasons } => reasons,
            _ => &[],
        }
    }

    /// True when the link is working and nothing is measurable wrong.
    pub fn is_healthy(&self) -> bool {
        matches!(self, LinkHealth::Healthy)
    }

    /// True when there is no evidence yet (never a claim of health).
    pub fn is_unknown(&self) -> bool {
        matches!(self, LinkHealth::Unknown)
    }

    /// The verdict as one line (`healthy`, `degraded: decode_errors=1, no_peers`).
    pub fn summary(&self) -> String {
        match self {
            LinkHealth::Unknown => "unknown".to_string(),
            LinkHealth::Healthy => "healthy".to_string(),
            LinkHealth::Degraded { reasons } => format!(
                "degraded: {}",
                reasons
                    .iter()
                    .map(HealthReason::detail)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
}

impl std::fmt::Display for LinkHealth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.summary())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{NodeKind, PeerId, PeerInfo};

    fn peer(id: &str) -> PeerView {
        PeerView {
            info: PeerInfo::new(PeerId::new(id).expect("peer"), NodeKind::Robot),
            last_seen_ms: 0,
            beacons: 1,
        }
    }

    /// The counters of a link that has published and delivered some frames.
    fn busy() -> MetricsSnapshot {
        MetricsSnapshot {
            published: 10,
            delivered: 10,
            ..Default::default()
        }
    }

    fn loss(missing: u64, gaps: u64) -> SeqSummary {
        SeqSummary {
            streams: 1,
            in_order: 1,
            gaps,
            missing,
            stale: 0,
        }
    }

    #[test]
    fn a_silent_node_is_unknown_not_healthy() {
        // The one verdict that must never be invented: with no evidence at all there is
        // nothing to be healthy *about*.
        let empty = MetricsSnapshot::default();
        let health = LinkHealth::evaluate(&empty, &[], false, None);
        assert_eq!(health, LinkHealth::Unknown);
        assert!(health.is_unknown());
        assert!(!health.is_healthy(), "‘no evidence’ is not a clean bill");
        assert!(health.reasons().is_empty());
        assert_eq!(health.summary(), "unknown");
        assert_eq!(health.to_string(), "unknown");
        assert_eq!(health.label(), "unknown");
        // A peer alone is evidence (something answered a beacon).
        assert!(!LinkHealth::evaluate(&empty, &[peer("dog1")], false, None).is_unknown());
    }

    #[test]
    fn traffic_without_a_reason_is_healthy() {
        let health = LinkHealth::evaluate(&busy(), &[peer("dog1")], true, None);
        assert_eq!(health, LinkHealth::Healthy);
        assert!(health.is_healthy());
        assert_eq!(health.summary(), "healthy");
        // …and a clean sequence summary does not spoil it.
        let clean = SeqSummary {
            streams: 2,
            in_order: 9,
            gaps: 0,
            missing: 0,
            stale: 1,
        };
        assert!(LinkHealth::evaluate(&busy(), &[peer("dog1")], true, Some(&clean)).is_healthy());
    }

    #[test]
    fn dropped_frames_alone_do_not_make_the_link_unhealthy() {
        // A best-effort stream *is* supposed to drop (latest-wins overwrites its own
        // queue): calling that degraded would cry wolf on a healthy robot.
        let metrics = MetricsSnapshot {
            dropped: 9_999,
            ..busy()
        };
        assert!(
            LinkHealth::evaluate(&metrics, &[peer("dog1")], true, None).is_healthy(),
            "dropped is the policy working, not a fault"
        );
        // It is still visible as a number — just not as a verdict.
        assert_eq!(metrics.dropped, 9_999);
    }

    #[test]
    fn every_reason_fires_with_its_number_in_a_stable_order() {
        let metrics = MetricsSnapshot {
            encode_errors: 2,
            decode_errors: 3,
            blocked: 4,
            dropped: 7,
            ..busy()
        };
        let health = LinkHealth::evaluate(&metrics, &[], false, Some(&loss(6, 2)));
        let reasons = health.reasons();
        assert_eq!(
            reasons,
            [
                HealthReason::EncodeErrors { count: 2 },
                HealthReason::DecodeErrors { count: 3 },
                HealthReason::BackPressure { blocked: 4 },
                HealthReason::FrameLoss {
                    missing: 6,
                    gaps: 2
                },
                HealthReason::NoPeers,
                HealthReason::ClockUnsynced,
            ],
            "a stable order keeps two reports comparable"
        );
        assert_eq!(
            health.summary(),
            "degraded: encode_errors=2, decode_errors=3, back_pressure=4, \
             frame_loss=6 in 2 gap(s), no_peers, clock_unsynced"
        );
        assert_eq!(health.label(), "degraded");
        assert!(!health.is_healthy());
        for reason in reasons {
            assert!(
                health.summary().contains(reason.key()),
                "every reason names itself: {} vs {}",
                reason.key(),
                health.summary()
            );
        }
    }

    #[test]
    fn frame_loss_is_only_claimed_when_a_consumer_says_so() {
        // A node cannot see a consumer's sequence gaps; without the summary there is no
        // `frame_loss` reason at all — the verdict does not guess on the consumer's behalf.
        let metrics = busy();
        assert!(!LinkHealth::evaluate(&metrics, &[peer("dog1")], true, None)
            .reasons()
            .iter()
            .any(|r| r.key() == "frame_loss"));

        let health = LinkHealth::evaluate(&metrics, &[peer("dog1")], true, Some(&loss(3, 1)));
        assert_eq!(
            health.reasons(),
            [HealthReason::FrameLoss {
                missing: 3,
                gaps: 1
            }]
        );
        assert_eq!(health.summary(), "degraded: frame_loss=3 in 1 gap(s)");
    }

    #[test]
    fn the_verdict_serialises_for_the_status_document() {
        let healthy = LinkHealth::evaluate(&busy(), &[peer("dog1")], true, None);
        let json = serde_json::to_string(&healthy).expect("json");
        assert_eq!(json, r#"{"state":"healthy"}"#);

        let degraded = LinkHealth::evaluate(
            &MetricsSnapshot {
                decode_errors: 1,
                ..busy()
            },
            &[peer("dog1")],
            true,
            None,
        );
        let json = serde_json::to_string(&degraded).expect("json");
        assert!(
            json.contains(r#""state":"degraded""#)
                && json.contains(r#""decode_errors":{"count":1}"#),
            "got: {json}"
        );
        // …and it round-trips (a UI can send it back).
        let back: LinkHealth = serde_json::from_str(&json).expect("round trip");
        assert_eq!(back, degraded);
    }
}
