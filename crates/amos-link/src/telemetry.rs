//! Liveness and status: heartbeats, the node's self-description, and its lag metric.
//!
//! Two audiences, one module: a *robot* needs a cheap "I am alive" beat on the link
//! (the field server watches it and drops a link whose peer went quiet), and an
//! *operator* needs one JSON document that answers "what is this node, who else is
//! here, and is it keeping up".
//!
//! * [`Heartbeat`] is the wire message — peer, sequence, clock, uptime — published on
//!   `amos/<peer>/telemetry/beat` by [`spawn_heartbeat`]. It is a `Message` like any
//!   other, so it travels the same typed pub/sub path (and is visible in `topics`).
//! * [`NodeStatus`] is the local snapshot: identity, uptime, clock freshness, the
//!   cumulative counters and the live peer table. The control plane maps it 1:1 onto
//!   `proto/robot_link.proto`; the CLI prints it as JSON.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use crate::codec::Timestamp;
use crate::discovery::{NodeKind, PeerId, PeerView};
use crate::error::{LinkError, Result};
use crate::health::LinkHealth;
use crate::keyexpr::{Topic, ROOT};
use crate::metrics::MetricsSnapshot;
use crate::node::LinkNode;

/// Default heartbeat cadence (1 Hz): cheap on the wire, fast enough that a
/// three-missed-beat TTL notices a dead board within seconds.
pub const DEFAULT_HEARTBEAT_PERIOD: Duration = Duration::from_secs(1);

/// The liveness message every node publishes on `amos/<peer>/telemetry/beat`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heartbeat {
    /// The emitting peer.
    pub peer: PeerId,
    /// Per-peer monotonic counter (a receiver can spot missed beats).
    pub seq: u64,
    /// The emitting node's clock.
    pub stamp: Timestamp,
    /// Milliseconds since the emitting node started.
    pub uptime_ms: u64,
}

impl Heartbeat {
    /// Build one beat.
    pub fn new(peer: PeerId, seq: u64, stamp: Timestamp, uptime_ms: u64) -> Self {
        Self {
            peer,
            seq,
            stamp,
            uptime_ms,
        }
    }

    /// The age of this beat measured against the local clock.
    pub fn age(&self) -> Duration {
        Timestamp::now().since(&self.stamp)
    }

    /// Re-ask, of a beat that arrived **as bytes**, every question its field types ask
    /// locally — plus the one question the *frame* answers.
    ///
    /// A beat is a **self-description**: it is the one link message whose payload names its
    /// own author. `Heartbeat` derives `Deserialize`, so `PeerId::new` never runs for a beat
    /// off the wire (the hole [`Header::validate`](crate::codec::Header::validate) and
    /// [`PeerInfo::validate`](crate::discovery::PeerInfo::validate) close for the other two
    /// wire types that carry a peer id) and `Timestamp::new` never runs for the payload's
    /// `stamp`, which [`Heartbeat::age`] then measures against the local clock.
    ///
    /// The second check is what makes a beat *attributable*: `attributed` is the frame's own
    /// publisher — the **validated** header field, and the key every consumer's sequence
    /// accounting uses. A beat whose payload names a different peer is refused, because the
    /// two candidate identities ("who published this frame" and "who does this beat claim to
    /// be") must not be rendered side by side as one fact: the CLI's `watch` prints the
    /// payload's `peer` while it computes `missed` from the header's publisher, and the
    /// control plane forwards the payload's claim to every UI (see
    /// [`Subscriber::recv_beat`](crate::pubsub::Subscriber::recv_beat)). The crate's rule for
    /// a self-declaration is older than this method: the actuation fold attributes a report
    /// by the frame's publisher and does not believe what the payload calls itself.
    ///
    /// Non-allocating, so a refused beat costs nothing on the receive path. Honest boundary:
    /// an attribution check is a *consistency* check, not authentication — a peer that already
    /// lies about its own identity in the frame header is out of scope here (the link has no
    /// authentication to appeal to; see the §6 boundary table in `docs/amos-link.md`). What it
    /// does guarantee is the weaker, testable invariant: **one beat, one identity**.
    pub fn validate(&self, attributed: &PeerId) -> Result<()> {
        // The id first, so a beat whose `peer` is not a peer id is refused for *that* reason
        // rather than for disagreeing with the frame (the two are different defects).
        PeerId::validate_str(self.peer.as_str()).map_err(|e| {
            LinkError::Frame(format!("beat peer `{}` is not a peer id: {e}", self.peer))
        })?;
        if self.peer != *attributed {
            return Err(LinkError::Frame(format!(
                "beat claims peer `{}` but the frame that carried it is attributed to `{}`",
                self.peer, attributed
            )));
        }
        if !self.stamp.is_valid() {
            return Err(LinkError::Frame(format!(
                "beat stamp {}.{:09} is not well formed: nanos {} is not a sub-second value",
                self.stamp.secs, self.stamp.nanos, self.stamp.nanos
            )));
        }
        Ok(())
    }
}

/// Everything the node can say about itself, in one value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NodeStatus {
    /// This node's id.
    pub peer: PeerId,
    /// This node's role.
    pub kind: NodeKind,
    /// The `amos-link` version this node was built from.
    pub version: String,
    /// Milliseconds since the node was created.
    pub uptime_ms: u64,
    /// True when a calibrated clock is in use (see [`crate::codec::Clock`]).
    pub clock_synced: bool,
    /// Cumulative counters.
    pub metrics: MetricsSnapshot,
    /// The link's own verdict (see [`crate::health`]): `Unknown` when there is no
    /// evidence yet, `Degraded` with every reason and its number when there is.
    ///
    /// A node cannot see a consumer's sequence gaps, so `frame_loss` appears here only if
    /// the caller evaluates with a [`SeqTracker`](crate::sequence::SeqTracker) summary —
    /// the CLI's `watch` does, a bare `status` cannot.
    pub health: LinkHealth,
    /// The fresh peers in the registry.
    pub peers: Vec<PeerView>,
    /// The topics this transport has seen *published* traffic on.
    pub topics: Vec<String>,
    /// True when [`NodeStatus::topics`] is the whole truth — the inventory's own limit,
    /// travelling **with** the list (see
    /// [`Transport::topics_complete`](crate::broker::Transport::topics_complete)).
    ///
    /// The list and this flag are one value on purpose: this JSON is what the CLI prints and
    /// a machine reads, so an inventory that stopped growing at
    /// [`MAX_TRACKED_TOPICS`](crate::broker::MAX_TRACKED_TOPICS) must not read as "this link
    /// has 4096 topics" from a machine's side, and a network transport (which cannot
    /// enumerate what other nodes publish at all) must not read as "nothing is published".
    pub topics_complete: bool,
}

impl NodeStatus {
    /// True when at least one other peer is fresh on the link.
    pub fn has_peers(&self) -> bool {
        !self.peers.is_empty()
    }

    /// The status as JSON (what the CLI prints and a machine reads).
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string_pretty(self).map_err(|e| LinkError::Codec(e.to_string()))
    }
}

/// The pattern matching **every** node's heartbeat (`amos/*/telemetry/beat`).
///
/// The liveness view of a whole link: a node's own beat is one frame among its peers',
/// so an operator (or the system UI) subscribing to this pattern sees the bus, not just
/// itself. The symmetric helper to [`crate::discovery::beacon_pattern`].
pub fn heartbeat_pattern() -> Result<Topic> {
    Topic::pattern(format!(
        "{ROOT}/*/{}/beat",
        crate::keyexpr::Channel::Telemetry.key()
    ))
}

/// A running heartbeat task: the handle that stops it on shutdown.
#[derive(Debug)]
pub struct HeartbeatTask {
    handle: JoinHandle<()>,
}

impl HeartbeatTask {
    /// True once the task ended (the link closed, or the task was aborted).
    pub fn is_finished(&self) -> bool {
        self.handle.is_finished()
    }

    /// Stop the task and wait for it (the shutdown path: no orphaned publishers).
    pub async fn stop(self) {
        self.handle.abort();
        // An aborted task joins with `Cancelled`; that is the expected path, so it is
        // logged rather than discarded (a silent `let _ =` here would hide a real panic
        // in the heartbeat task).
        if let Err(e) = self.handle.await {
            tracing::debug!(error = %e, "heartbeat task ended");
        }
    }
}

/// Publish this node's heartbeat on `topic` every `period`.
///
/// The returned task runs until it is stopped or the transport closes — a node that
/// is dropped cannot leave a beating phantom behind. Sequence numbers are per node
/// (shared with any other caller of [`LinkNode::heartbeat`]).
///
/// A **zero period is refused** with a typed error rather than handed to the runtime:
/// `tokio::time::interval(0)` panics *inside the spawned task*, so the caller would get a
/// live-looking handle for a task that is already dead — the one failure shape this crate
/// refuses to have (a silent death is not a shutdown).
pub fn spawn_heartbeat(
    node: &Arc<LinkNode>,
    topic: Topic,
    period: Duration,
) -> Result<HeartbeatTask> {
    if period.is_zero() {
        return Err(LinkError::Unsupported(
            "heartbeat period must be non-zero (a zero-period timer cannot be scheduled)"
                .to_string(),
        ));
    }
    let node = Arc::clone(node);
    let handle = tokio::spawn(async move {
        // `Delay`, not the default `Burst`: a missed tick is not replayed. A liveness beat
        // has no history worth catching up on, and a burst of back-to-back beats after a
        // stall would report "many beats" for what was one quiet interval.
        let mut ticker = tokio::time::interval(period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let publisher = node.publisher::<Heartbeat>(topic);
        // Runs until `stop()` aborts it (shutdown), or until a publish fails because
        // the transport is gone — then the task ends by itself.
        loop {
            ticker.tick().await;
            let beat = node.heartbeat();
            match publisher.publish(&beat).await {
                Ok(_) => tracing::trace!(
                    peer = %beat.peer,
                    seq = beat.seq,
                    "heartbeat published"
                ),
                Err(e) => {
                    tracing::warn!(peer = %node.peer(), error = %e, "heartbeat stopped: transport closed");
                    return;
                }
            }
        }
    });
    Ok(HeartbeatTask { handle })
}

/// The next sequence number for a counter (1-based), **saturating** at `u64::MAX`.
///
/// `fetch_add(1) + 1` looks equivalent but is not: at `u64::MAX` the stored value wraps
/// back to 0, so the counter would report a *smaller* number than the frame it just
/// stamped and later frames would reuse sequences 1, 2, … — a consumer's
/// [`SeqTracker`](crate::sequence::SeqTracker) would read that as "the publisher
/// restarted", a story invented for a number that merely ran out. The compare-exchange
/// below stops at the ceiling, so the stamped value and the reported counter agree.
pub(crate) fn next_seq(counter: &AtomicU64) -> u64 {
    // `then_some` would evaluate `value + 1` *eagerly* — overflowing at the very ceiling
    // this function exists to guard. `then(|| …)` is lazy, so the increment only happens
    // where it is representable.
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            (value < u64::MAX).then(|| value + 1)
        })
        .map(|previous| previous + 1)
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::Message;

    /// A beat **as a peer writes one**: a shadow struct with [`Heartbeat`]'s bincode layout,
    /// so `peer` is a plain `String` and `stamp` is whatever bytes were chosen —
    /// `PeerId::new`/`Timestamp::new` are never on an attacker's path.
    #[derive(serde::Serialize)]
    struct WireBeat {
        peer: String,
        seq: u64,
        stamp: Timestamp,
        uptime_ms: u64,
    }

    fn wire_beat(peer: &str, nanos: u32) -> Vec<u8> {
        bincode::serialize(&WireBeat {
            peer: peer.to_string(),
            seq: 3,
            stamp: Timestamp {
                secs: 1_700_000_000,
                nanos,
            },
            uptime_ms: 9,
        })
        .expect("bytes")
    }

    #[test]
    fn a_beat_off_the_wire_is_re_validated_and_must_name_its_publisher() {
        // The defect this pins: `Heartbeat` derives `Deserialize`, so the **third** wire type
        // that carries a peer id was the one nothing re-asked. Its payload `peer` is what the
        // CLI prints and what the control plane forwards to every UI, and its payload `stamp`
        // is what `Heartbeat::age()` measures against.
        let dog1 = PeerId::new("dog1").expect("peer");
        let honest = Heartbeat::decode(&wire_beat("dog1", 500)).expect("bincode decodes it");
        assert!(honest.validate(&dog1).is_ok(), "an honest beat is accepted");
        assert_eq!(honest.peer, dog1, "…and it is the peer the frame names");

        // (1) The id itself, exactly as `Header::validate`/`PeerInfo::validate` ask it.
        for bad in [
            "x".repeat(PeerId::MAX_LEN + 1),
            "dog/1".to_string(),
            "dog 1".to_string(),
            "dog1\n".to_string(),
            String::new(),
        ] {
            let beat =
                Heartbeat::decode(&wire_beat(&bad, 0)).expect("bincode does not validate ids");
            let error = beat
                .validate(&dog1)
                .expect_err("an id `PeerId::new` refuses must be refused here too");
            assert!(
                error.to_string().contains("beat peer"),
                "the refusal names the field it is about: {error}"
            );
        }

        // (2) Attribution: the frame's publisher is the identity, so a beat may not name
        // another one. This is the check that keeps "who is alive" (the payload, printed) and
        // "which stream is this" (the framing, accounted) from being two different answers.
        let impostor = PeerId::new("impostor").expect("peer");
        let error = honest
            .validate(&impostor)
            .expect_err("a beat may not claim another peer");
        assert!(
            error.to_string().contains("dog1") && error.to_string().contains("impostor"),
            "both identities are named: {error}"
        );

        // (3) The payload's stamp obeys the same invariant as the header's: `nanos` below 1e9,
        // or `as_nanos` and `Ord` disagree about the instant `age()` measures from.
        let bad_stamp =
            Heartbeat::decode(&wire_beat("dog1", 4_000_000_000)).expect("bincode decodes it");
        let error = bad_stamp
            .validate(&dog1)
            .expect_err("a stamp is not a sub-second one");
        assert!(error.to_string().contains("sub-second"), "got: {error}");
    }

    #[test]
    fn the_sequence_counter_saturates_at_its_ceiling() {
        // The ceiling is absurd in practice (10^19 frames) but the *behaviour* matters: a
        // wrapped counter would reuse sequence numbers, and every consumer's gap
        // accounting would report a publisher restart that never happened.
        let counter = AtomicU64::new(u64::MAX - 2);
        assert_eq!(next_seq(&counter), u64::MAX - 1);
        assert_eq!(next_seq(&counter), u64::MAX);
        // …and then it stays there: the stamped value and the stored counter agree.
        assert_eq!(next_seq(&counter), u64::MAX);
        assert_eq!(next_seq(&counter), u64::MAX);
        assert_eq!(counter.load(Ordering::Relaxed), u64::MAX);
    }

    #[test]
    fn heartbeat_patterns_name_every_peer_of_the_link() {
        let pattern = heartbeat_pattern().expect("pattern");
        assert!(pattern.is_pattern());
        for peer in ["dog1", "mini-brain", "cam-front"] {
            let topic = Topic::channel_topic(peer, crate::keyexpr::Channel::Telemetry, "beat")
                .expect("topic");
            assert!(topic.matches(&pattern), "{peer} must be watched");
        }
        // It matches *beats*, not the whole telemetry channel or another channel entirely.
        assert!(!Topic::new("amos/dog1/telemetry/status")
            .expect("topic")
            .matches(&pattern));
        assert!(!Topic::new("amos/dog1/sensor/beat")
            .expect("topic")
            .matches(&pattern));
        // …and it is symmetric with the discovery helper.
        let beacons = crate::discovery::beacon_pattern().expect("pattern");
        assert_eq!(
            pattern.len(),
            beacons.len(),
            "same shape, one segment deeper"
        );
    }
}
