//! Typed publish/subscribe: the API a domain crate actually uses.
//!
//! [`Publisher<T>`]/[`Subscriber<T>`] wrap a [`Transport`] with the four things every
//! robotics call site needs and none of the things it does not:
//!
//! 1. **types** — `publish(&StereoFrame)` encodes via [`Message`]; nothing is `Vec<u8>`
//!    at the call site;
//! 2. **identity + sequence + clock** — every frame is stamped with the node's peer id,
//!    a per-publisher sequence number and the calibrated [`Clock`], so a receiver can
//!    measure latency and spot gaps without any extra protocol;
//! 3. **tolerance** — a subscriber *skips* a frame it cannot decode (counting it) and
//!    keeps running: one version-skewed producer must not stop a 60 Hz control loop;
//! 4. **visibility** — `stats()` reports what the subscription received, dropped and
//!    failed to decode; `Received::age()` turns the stamp into a lag figure.

use std::marker::PhantomData;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::broker::{Ingress, PublishReport, Subscription, SubscriptionStats, Transport};
use crate::codec::{Clock, Envelope, Message, Timestamp};
use crate::discovery::PeerId;
use crate::error::{LinkError, Result};
use crate::keyexpr::Topic;
use crate::metrics::LinkMetrics;
use crate::qos::Qos;

/// The publishing half of a topic.
///
/// One publisher per (peer, topic): it owns the sequence counter, so the numbers a
/// receiver sees are monotonic per publisher — the cheap way to detect loss without
/// an acknowledgement protocol.
pub struct Publisher<T> {
    topic: Topic,
    peer: PeerId,
    transport: Arc<dyn Transport>,
    clock: Arc<Clock>,
    metrics: Arc<LinkMetrics>,
    seq: AtomicU64,
    _payload: PhantomData<fn(T)>,
}

impl<T: Message> Publisher<T> {
    /// Build a publisher for one concrete topic of one peer.
    pub fn new(
        transport: Arc<dyn Transport>,
        topic: Topic,
        peer: PeerId,
        clock: Arc<Clock>,
        metrics: Arc<LinkMetrics>,
    ) -> Self {
        Self {
            topic,
            peer,
            transport,
            clock,
            metrics,
            seq: AtomicU64::new(0),
            _payload: PhantomData,
        }
    }

    /// The topic being published.
    pub fn topic(&self) -> &Topic {
        &self.topic
    }

    /// The publishing peer.
    pub fn peer(&self) -> &PeerId {
        &self.peer
    }

    /// How many frames this publisher has sent (also the last stamped sequence).
    pub fn seq(&self) -> u64 {
        self.seq.load(Ordering::Relaxed)
    }

    /// Encode, stamp and hand one message to the transport.
    pub async fn publish(&self, message: &T) -> Result<PublishReport> {
        let payload = match message.encode() {
            Ok(p) => p,
            Err(e) => {
                self.metrics.record_encode_error();
                return Err(e);
            }
        };
        // One saturating sequence source for the whole crate (see `telemetry::next_seq`):
        // a wrapped counter would let later frames reuse sequence numbers, which reads as
        // a publisher restart to every consumer's gap accounting.
        let seq = crate::telemetry::next_seq(&self.seq);
        let envelope = Envelope::new(&self.topic, &self.peer, seq, self.clock.now(), payload);
        let wire = envelope.encode()?;
        let frame: Arc<[u8]> = Arc::from(wire.into_boxed_slice());
        self.transport.publish(&self.topic, frame).await
    }
}

/// A frame as a subscriber received it: payload + the metadata it travelled with.
#[derive(Debug)]
pub struct Received<T> {
    /// The decoded payload.
    pub message: T,
    /// The concrete topic this frame was published on (wildcard subscribers need it).
    ///
    /// This is the transport's **routing key**, not the header's claim: the two must agree
    /// or the frame is refused ([`decode_ingress`]), so a consumer can dispatch on
    /// `Received::topic` without being spoofed into believing another publisher's topic.
    pub topic: Topic,
    /// The publisher's peer id.
    pub publisher: PeerId,
    /// The publisher's sequence number (1-based; a gap means a dropped frame).
    pub seq: u64,
    /// The publisher's clock at publish time.
    pub stamp: Timestamp,
    /// The framed size on the wire (header + payload + CRC).
    pub frame_len: usize,
}

impl<T> Received<T> {
    /// How long ago the frame was published, measured against the local clock.
    ///
    /// With a calibrated `Clock` (the supervisor's `timesync` instance) this is true
    /// one-way latency; with an unsynced host clock it is a bound — which is why the
    /// node reports `clock_synced` beside it.
    pub fn age(&self) -> Duration {
        Timestamp::now().since(&self.stamp)
    }
}

/// The subscribing half of a topic pattern.
pub struct Subscriber<T> {
    subscription: Subscription,
    metrics: Arc<LinkMetrics>,
    _payload: PhantomData<fn(T)>,
}

impl<T: Message> Subscriber<T> {
    /// Register a subscription (the QoS is validated by the transport).
    pub async fn subscribe(
        transport: Arc<dyn Transport>,
        pattern: Topic,
        qos: Qos,
        metrics: Arc<LinkMetrics>,
    ) -> Result<Self> {
        let subscription = transport.subscribe(&pattern, qos).await?;
        Ok(Self {
            subscription,
            metrics,
            _payload: PhantomData,
        })
    }

    /// The registered pattern.
    pub fn pattern(&self) -> &Topic {
        self.subscription.pattern()
    }

    /// The QoS in force.
    pub fn qos(&self) -> Qos {
        self.subscription.qos()
    }

    /// What this subscription received / dropped / failed to decode.
    pub fn stats(&self) -> SubscriptionStats {
        self.subscription.stats()
    }

    /// True once the transport side is gone.
    pub fn is_closed(&self) -> bool {
        self.subscription.is_closed()
    }

    /// True when a frame is already queued (never blocks, consumes nothing).
    ///
    /// The cheap “should I call `try_recv`?” check for a control loop that must not
    /// await the network. A `true` does not promise the frame decodes into `T` — that
    /// is what `try_recv` decides (and counts when it does not).
    pub fn has_pending(&self) -> bool {
        self.subscription.has_pending()
    }

    /// Wait for the next decodable frame.
    ///
    /// A frame that does not decode into `T` is counted, logged and **skipped**: a
    /// mismatched producer (another crate's version of the topic) must not take down
    /// the consumer. Ends with [`LinkError::Closed`] when the subscription closes.
    pub async fn recv(&mut self) -> Result<Received<T>> {
        // Terminates on the first decodable frame, or with `Closed` when the
        // subscription shuts down.
        loop {
            let ingress = self
                .subscription
                .recv()
                .await
                .ok_or_else(|| LinkError::Closed("subscription closed".to_string()))?;
            if let Some(frame) = decode_ingress::<T>(&ingress, &self.subscription, &self.metrics) {
                return Ok(frame);
            }
        }
    }

    /// The next decodable frame if one is already queued (poll, never block).
    pub fn try_recv(&mut self) -> Result<Option<Received<T>>> {
        let Some(ingress) = self.subscription.try_recv() else {
            return Ok(None);
        };
        Ok(decode_ingress::<T>(
            &ingress,
            &self.subscription,
            &self.metrics,
        ))
    }
}

/// How many decode failures one subscription reports at `warn` before dropping to
/// `debug`: a rogue producer must not be able to flood the log through a healthy link.
const DECODE_WARN_BUDGET: u64 = 3;

/// Decode one ingress frame; `None` (after counting) when it is not a valid `T`.
///
/// The **routing key wins**, and the frame's own header copy is *checked against it* —
/// never believed. A frame that routes on one topic but claims another in its header is
/// refused (and counted), because the header is a publisher-chosen string: trusting it
/// would let a peer deliver `amos/evil/control/x` while telling a wildcard consumer it is
/// `amos/dog1/control/joints`. The two agreeing is the invariant every transport enforces
/// implicitly (a publisher stamps the topic it publishes on), so a disagreement is either
/// a bug or an attack — and the honest answer to both is the same.
fn decode_ingress<T: Message>(
    ingress: &Ingress,
    subscription: &Subscription,
    metrics: &Arc<LinkMetrics>,
) -> Option<Received<T>> {
    let envelope = match Envelope::decode(&ingress.frame) {
        Ok(e) => e,
        Err(e) => {
            report_decode_error(subscription, metrics, &ingress.topic, &e.to_string());
            return None;
        }
    };
    if envelope.header.topic != ingress.topic.as_str() {
        report_decode_error(
            subscription,
            metrics,
            &ingress.topic,
            &format!(
                "frame routed on `{}` claims topic `{}`",
                ingress.topic, envelope.header.topic
            ),
        );
        return None;
    }
    let message = match T::decode(&envelope.payload) {
        Ok(m) => m,
        Err(e) => {
            report_decode_error(subscription, metrics, &ingress.topic, &e.to_string());
            return None;
        }
    };
    Some(Received {
        message,
        topic: ingress.topic.clone(),
        publisher: envelope.header.publisher,
        seq: envelope.header.seq,
        stamp: envelope.header.stamp,
        frame_len: ingress.frame.len(),
    })
}

/// Count a decode failure and log it with a bounded budget.
///
/// The counter is the *subscription's*, so the first few failures of each subscription
/// are loud (a version skew is worth seeing) and a high-rate stream of garbage degrades
/// to `debug` instead of drowning the log — the alternative, refusing the subscription,
/// would let one bad producer take a consumer off the bus.
fn report_decode_error(
    subscription: &Subscription,
    metrics: &Arc<LinkMetrics>,
    topic: &Topic,
    error: &str,
) {
    subscription.record_decode_error();
    metrics.record_decode_error();
    let seen = subscription.stats().decode_errors;
    if seen <= DECODE_WARN_BUDGET {
        tracing::warn!(topic = %topic, errors = seen, error, "skipping an undecodable link frame");
    } else {
        tracing::debug!(topic = %topic, errors = seen, error, "skipping an undecodable link frame");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::Broker;
    use crate::keyexpr::Channel;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct Depth {
        seq: u64,
        points: Vec<i16>,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct Odd {
        text: String,
    }

    struct Rig {
        transport: Arc<dyn Transport>,
        metrics: Arc<LinkMetrics>,
        clock: Arc<Clock>,
        peer: PeerId,
    }

    fn rig() -> Rig {
        let metrics = Arc::new(LinkMetrics::new());
        let broker = Broker::with_metrics(Arc::clone(&metrics));
        Rig {
            transport: broker.shared(),
            metrics,
            clock: Arc::new(Clock::host()),
            peer: PeerId::new("dog1").expect("peer"),
        }
    }

    fn sensor_topic() -> Topic {
        Topic::channel_topic("dog1", Channel::Sensor, "stereo_left").expect("topic")
    }

    fn depth_publisher(r: &Rig, topic: Topic) -> Publisher<Depth> {
        Publisher::<Depth>::new(
            Arc::clone(&r.transport),
            topic,
            r.peer.clone(),
            Arc::clone(&r.clock),
            Arc::clone(&r.metrics),
        )
    }

    #[tokio::test]
    async fn typed_round_trip_carries_every_metadata_field() {
        let r = rig();
        let topic = sensor_topic();
        let mut sub = Subscriber::<Depth>::subscribe(
            Arc::clone(&r.transport),
            Topic::pattern("amos/**/sensor/stereo_left").expect("pattern"),
            Qos::sensor(),
            Arc::clone(&r.metrics),
        )
        .await
        .expect("subscribe");
        let pubr = depth_publisher(&r, topic.clone());

        assert_eq!(pubr.topic().as_str(), topic.as_str());
        assert_eq!(pubr.peer().as_str(), "dog1");
        let msg = Depth {
            seq: 1,
            points: vec![-3, 4],
        };
        let report = pubr.publish(&msg).await.expect("publish");
        assert_eq!(report.matched, Some(1));
        assert_eq!(report.delivered, 1);
        assert_eq!(pubr.seq(), 1);

        let got = sub.recv().await.expect("recv");
        assert_eq!(got.message, msg);
        assert_eq!(got.topic, topic, "the concrete topic travels in the header");
        assert_eq!(got.publisher.as_str(), "dog1");
        assert_eq!(got.seq, 1);
        assert!(got.frame_len > 0);
        // The stamp is the publisher's clock, so the age is a latency bound.
        assert!(got.age().as_secs() < 5, "age {:?}", got.age());
        assert_eq!(sub.pattern().as_str(), "amos/**/sensor/stereo_left");
        assert_eq!(sub.qos(), Qos::sensor());
        assert!(!sub.is_closed());
        assert_eq!(sub.stats().received, 1);
        assert_eq!(sub.stats().decode_errors, 0);
        assert!(sub.try_recv().expect("poll").is_none());
    }

    #[tokio::test]
    async fn one_pattern_receives_from_several_peers_with_their_own_sequences() {
        let r = rig();
        let mut sub = Subscriber::<Depth>::subscribe(
            Arc::clone(&r.transport),
            Topic::pattern("amos/*/sensor/stereo_left").expect("pattern"),
            Qos::state(),
            Arc::clone(&r.metrics),
        )
        .await
        .expect("subscribe");

        for (peer, topic) in [
            ("dog1", "amos/dog1/sensor/stereo_left"),
            ("dog2", "amos/dog2/sensor/stereo_left"),
        ] {
            let pubr = Publisher::<Depth>::new(
                Arc::clone(&r.transport),
                Topic::new(topic).expect("topic"),
                PeerId::new(peer).expect("peer"),
                Arc::clone(&r.clock),
                Arc::clone(&r.metrics),
            );
            pubr.publish(&Depth {
                seq: 1,
                points: vec![1],
            })
            .await
            .expect("publish");
            let got = sub.recv().await.expect("recv");
            assert_eq!(got.publisher.as_str(), peer);
            assert_eq!(got.topic.as_str(), topic);
            assert_eq!(got.seq, 1, "each publisher numbers its own stream");
        }
        assert_eq!(sub.stats().received, 2);
    }

    #[tokio::test]
    async fn a_mismatched_payload_is_skipped_not_fatal() {
        let r = rig();
        let topic = sensor_topic();
        let mut sub = Subscriber::<Depth>::subscribe(
            Arc::clone(&r.transport),
            Topic::pattern("amos/**").expect("pattern"),
            Qos::state(),
            Arc::clone(&r.metrics),
        )
        .await
        .expect("subscribe");

        // A producer speaking a different payload type on the same topic.
        let odd = Publisher::<Odd>::new(
            Arc::clone(&r.transport),
            topic.clone(),
            PeerId::new("dog1").expect("peer"),
            Arc::clone(&r.clock),
            Arc::clone(&r.metrics),
        );
        odd.publish(&Odd {
            text: "who am i".to_string(),
        })
        .await
        .expect("publish");

        // A valid frame arrives afterwards; the subscriber must skip the bad one and
        // still deliver this one (the 60 Hz loop never sees the error).
        let good = depth_publisher(&r, topic);
        let msg = Depth {
            seq: 42,
            points: vec![7],
        };
        // Publish from a clone-equivalent publisher (same rig, same topic).
        good.publish(&msg).await.expect("publish");
        let got = sub.recv().await.expect("recv");
        assert_eq!(got.message, msg);
        assert_eq!(got.seq, 1, "the good publisher's own numbering");
        assert!(sub.stats().decode_errors >= 1, "the bad frame was counted");
        assert!(r.metrics.snapshot().decode_errors >= 1);
    }

    #[tokio::test]
    async fn a_frame_whose_header_claims_another_topic_is_refused() {
        // The spoofing shape: route on your own topic, claim someone else's in the header.
        // A wildcard consumer must not be told it received a frame for another robot.
        let r = rig();
        let mut sub = Subscriber::<Depth>::subscribe(
            Arc::clone(&r.transport),
            Topic::pattern("amos/**").expect("pattern"),
            Qos::state(),
            Arc::clone(&r.metrics),
        )
        .await
        .expect("subscribe");

        let spoofed = Envelope::new(
            &Topic::new("amos/dog1/control/joints").expect("topic"),
            &PeerId::new("evil").expect("peer"),
            1,
            r.clock.now(),
            Depth {
                seq: 1,
                points: vec![],
            }
            .encode()
            .expect("encode"),
        )
        .encode()
        .expect("encode");
        r.transport
            .publish(
                &Topic::new("amos/evil/sensor/imu").expect("topic"),
                Arc::from(spoofed.into_boxed_slice()),
            )
            .await
            .expect("publish");

        // A legitimate frame afterwards: the subscriber skips the spoof and keeps working.
        let good = depth_publisher(&r, sensor_topic());
        good.publish(&Depth {
            seq: 2,
            points: vec![],
        })
        .await
        .expect("publish");
        let got = sub.recv().await.expect("recv");
        assert_eq!(
            got.topic.as_str(),
            "amos/dog1/sensor/stereo_left",
            "the consumer sees the routing key, not the claim"
        );
        assert_eq!(got.message.seq, 2);
        assert!(sub.stats().decode_errors >= 1, "the spoof was counted");
        assert!(r.metrics.snapshot().decode_errors >= 1);
    }

    #[tokio::test]
    async fn latest_only_subscribers_read_the_last_frame_and_close_deterministically() {
        let r = rig();
        let mut sub = Subscriber::<Depth>::subscribe(
            Arc::clone(&r.transport),
            Topic::pattern("amos/**").expect("pattern"),
            Qos::sensor(),
            Arc::clone(&r.metrics),
        )
        .await
        .expect("subscribe");
        let pubr = depth_publisher(&r, sensor_topic());
        for seq in 1..=3u64 {
            pubr.publish(&Depth {
                seq,
                points: vec![],
            })
            .await
            .expect("publish");
        }
        assert_eq!(pubr.seq(), 3);
        let got = sub.recv().await.expect("recv");
        assert_eq!(got.message.seq, 3, "the newest frame wins");
        assert_eq!(sub.stats().dropped, 2);
    }

    #[tokio::test]
    async fn the_publisher_counter_saturates_instead_of_wrapping() {
        // A counter at `u64::MAX` must not stamp 1 again: a consumer's `SeqTracker` would
        // read that as "the publisher restarted" — a story invented for a number that ran
        // out. Saturating keeps the metadata honest (and the tracker already reports a
        // repeated sequence as `Stale`).
        let r = rig();
        let pubr = depth_publisher(&r, sensor_topic());
        pubr.seq.store(u64::MAX, Ordering::Relaxed);
        pubr.publish(&Depth {
            seq: 1,
            points: vec![],
        })
        .await
        .expect("publish");
        assert_eq!(pubr.seq(), u64::MAX, "the counter saturates");
        pubr.publish(&Depth {
            seq: 2,
            points: vec![],
        })
        .await
        .expect("publish");
        assert_eq!(pubr.seq(), u64::MAX, "and stays there");
    }

    #[tokio::test]
    async fn a_typed_subscriber_can_poll_before_it_sleeps() {
        let r = rig();
        let mut sub = Subscriber::<Depth>::subscribe(
            Arc::clone(&r.transport),
            Topic::pattern("amos/**").expect("pattern"),
            Qos::state(),
            Arc::clone(&r.metrics),
        )
        .await
        .expect("subscribe");
        assert!(!sub.has_pending(), "nothing published yet");

        let pubr = depth_publisher(&r, sensor_topic());
        pubr.publish(&Depth {
            seq: 1,
            points: vec![],
        })
        .await
        .expect("publish");
        assert!(sub.has_pending(), "the typed layer sees the queued frame");
        assert_eq!(sub.try_recv().expect("recv").expect("frame").message.seq, 1);
        assert!(!sub.has_pending(), "draining clears the report");
    }
}
