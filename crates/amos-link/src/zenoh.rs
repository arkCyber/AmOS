//! The Zenoh-backed transport (feature `zenoh`) — the *inter-node* bus.
//!
//! The in-process [`Broker`](crate::broker::Broker) links tasks inside one process; a
//! robot needs more than that: the RK3576 board publishing a stereo stream, a compute
//! server subscribing to it and publishing control back, a laptop joining as a tool.
//! Zenoh (Eclipse's Rust data bus) is the substrate for exactly that — a few hundred KB
//! of binary, no DDS, and **scouting** so peers find each other on the LAN with no
//! address list, over TCP/UDP/Wi-Fi/5G with the same key-expression grammar this crate
//! already validated in [`crate::keyexpr`].
//!
//! ```text
//!   Publisher<T> ──► ZenohTransport ──► session.put("amos/dog1/sensor/…", frame)
//!                                            │   scouting (multicast LAN) / connect endpoint
//!   Subscriber<T> ◄── forwarding task ◄── declare_subscriber("amos/**/sensor/…")
//! ```
//!
//! Four honest notes:
//!
//! * **`topics()` is empty and `matched` is `None`.** A network bus cannot enumerate
//!   the topics someone else published, nor count remote subscribers — the control
//!   plane reports "unknown" rather than a fabricated zero. The in-process broker is
//!   what knows its subscribers; over Zenoh the *peer table* is the inventory.
//! * **QoS is mapped, not invented.** The typed subscriber's **sink** is chosen by the profile
//!   exactly as the broker chooses it — a one-slot latest-wins queue for `DropOldest` + depth 1,
//!   a bounded queue otherwise — and the handler capacity follows `depth` (capped at
//!   [`FORWARD_CHANNEL`]). `Reliability::Reliable` is the reliable variant of that sink *and* the
//!   Zenoh handler that blocks instead of dropping. Drop policies describe **our consumer
//!   queue**, not the network (round 17 closed the gap where they were ignored here:
//!   `docs/amos-link.md` §3.18).
//! * **The default config is peer mode + multicast scouting** (`zenoh::Config::default`),
//!   which is what makes LAN discovery work with no configuration. A deployment that
//!   needs a fixed endpoint sets `AMOS_LINK_ZENOH_ENDPOINT=tcp/10.0.0.7:7447` (or
//!   `$ZENOH_CONFIG`, which Zenoh itself reads).
//! * **The key expression is handed over unchanged — including its length.** The syntax
//!   claim ("the same grammar as `keyexpr.rs`") was cross-checked from the start; the
//!   *length* was not, and a ceiling there would be the worst kind of boundary: a key that
//!   validates locally and then fails on the wire. Measured against the pinned Zenoh
//!   (1.10.1): the longest key this crate accepts (32 segments, ~2 KiB) and a pattern of the
//!   same shape both cross a real session
//!   (`the_longest_key_expression_we_accept_crosses_a_real_session`), so the identity claim
//!   holds for the whole local domain — and a future Zenoh that reintroduced a limit
//!   (Zenoh 0.x capped key expressions at 255 bytes) would turn that test red instead of
//!   silently dropping frames in the field.

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use zenoh::handlers::{FifoChannel, RingChannel};
use zenoh::sample::Sample;
use zenoh::Session;

use crate::broker::{Ingress, PublishReport, Subscription, Transport};
use crate::error::{LinkError, Result};
use crate::keyexpr::Topic;
use crate::qos::{Qos, Reliability};

/// Environment override for the Zenoh connect endpoint(s), comma-separated.
pub const ENV_ENDPOINT: &str = "AMOS_LINK_ZENOH_ENDPOINT";
/// Capacity of the channel between the Zenoh subscriber and the typed subscriber.
const FORWARD_CHANNEL: usize = 64;

/// Forward every sample of a declared Zenoh subscriber into the typed subscriber's **buffered**
/// queue, applying the subscriber's QoS at that boundary (round 17).
///
/// `$reliable` decides the policy exactly as the broker does in-process: a **best-effort** queue
/// drops the arriving frame when it is full and *counts it*, a **reliable** one waits for room
/// (`send().await`). Before this, the loop did a blocking `send` for *every* reliability, so
/// `DropPolicy::DropNewest` never fired on the network path — a depth-2 best-effort subscription
/// back-pressured the link instead of dropping, and `stats().dropped` read `0` while frames went
/// missing (`docs/amos-link.md` §3.18).
///
/// A macro rather than a function because Zenoh's handler types (`FifoChannelHandler`,
/// `RingChannelHandler`, …) share no common trait for `recv_async`, yet the forwarding loop is
/// identical for all of them. The task ends when the typed subscriber is dropped (its receiver
/// closes) or when the session closes — no orphan.
macro_rules! forward_samples {
    ($subscriber:expr, $tx:expr, $relay:expr, $reliable:expr) => {{
        // Everything is evaluated in the **caller's** scope and then moved into the task: a
        // `&self.metrics` borrow evaluated *inside* the `'static` task would escape the method
        // body (the compiler caught exactly that while round 15 was being written).
        let subscriber = $subscriber;
        let tx = $tx;
        let relay = $relay;
        let reliable = $reliable;
        tokio::spawn(async move {
            // Runs while the typed subscriber lives or the session is up.
            loop {
                let sample: Sample = match subscriber.recv_async().await {
                    Ok(sample) => sample,
                    Err(e) => {
                        tracing::debug!(error = %e, "zenoh subscriber closed");
                        return;
                    }
                };
                let key = sample.key_expr().as_str().to_string();
                let Ok(topic) = Topic::new(key.clone()) else {
                    tracing::debug!(key, "ignoring a Zenoh sample on a foreign key expression");
                    continue;
                };
                let frame: Arc<[u8]> =
                    Arc::from(sample.payload().to_bytes().to_vec().into_boxed_slice());
                let ingress = Ingress { topic, frame };
                if reliable {
                    // `try_send` first, then wait: only the *counters* need the distinction
                    // between "accepted now" and "had to wait", and it is what the broker does.
                    // (A network node's `blocked` stays 0 by design: this is *our* consumer
                    // waiting, not our publish path — see `network_reliability_note`.)
                    match tx.try_send(ingress) {
                        Ok(()) => relay.stored(),
                        Err(mpsc::error::TrySendError::Full(ingress)) => {
                            match tx.send(ingress).await {
                                Ok(()) => relay.stored(),
                                Err(_) => {
                                    relay.lost();
                                    tracing::debug!("typed subscriber dropped: relay ends");
                                    return;
                                }
                            }
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => {
                            relay.lost();
                            tracing::debug!("typed subscriber dropped: relay ends");
                            return;
                        }
                    }
                } else {
                    // Best-effort: a full queue *is* the policy working — drop and say so, never
                    // throttle the link.
                    match tx.try_send(ingress) {
                        Ok(()) => relay.stored(),
                        Err(_) => relay.lost(),
                    }
                }
            }
        });
    }};
}

/// Forward every sample into a **one-slot latest-only** queue (the sensor profile), the network
/// twin of what the broker does in-process (round 17).
///
/// `$reliable` picks the store, exactly like the broker: best-effort overwrites the pending frame
/// ([`LatestSlot::offer`], which counts the replaced frame on the subscription) and reliable
/// waits for the consumer ([`LatestSlot::offer_blocking`]). See [`forward_samples`] for why this
/// is a macro.
macro_rules! forward_latest {
    ($subscriber:expr, $slot:expr, $relay:expr, $reliable:expr) => {{
        let subscriber = $subscriber;
        let slot = $slot;
        let relay = $relay;
        let reliable = $reliable;
        tokio::spawn(async move {
            loop {
                let sample: Sample = match subscriber.recv_async().await {
                    Ok(sample) => sample,
                    Err(e) => {
                        tracing::debug!(error = %e, "zenoh subscriber closed");
                        return;
                    }
                };
                let key = sample.key_expr().as_str().to_string();
                let Ok(topic) = Topic::new(key.clone()) else {
                    tracing::debug!(key, "ignoring a Zenoh sample on a foreign key expression");
                    continue;
                };
                let frame: Arc<[u8]> =
                    Arc::from(sample.payload().to_bytes().to_vec().into_boxed_slice());
                let ingress = Ingress { topic, frame };
                if reliable {
                    match slot.offer_blocking(ingress).await {
                        Ok(_waited) => relay.stored(),
                        Err(_) => {
                            relay.lost();
                            tracing::debug!("typed subscriber dropped: relay ends");
                            return;
                        }
                    }
                } else if slot.offer(ingress) {
                    relay.stored();
                } else {
                    // The slot recorded the subscription-side drop for the frame it replaced;
                    // this moves the node's counter only (see `RelayCounters::replaced`).
                    relay.replaced();
                }
            }
        });
    }};
}

/// A [`Transport`] over a Zenoh session.
///
/// It owns a counter set — the same [`LinkMetrics`] the node over it reports
/// (`LinkNode::with_parts`) — because a transport is where "this frame reached the wire" is
/// known. Until round 15 it held none: `record_published`/`record_delivered` were called by the
/// in-process broker **and by nothing else**, so every node on a real network (`--transport
/// zenoh`, i.e. every board in the field) reported `published=0 delivered=0` for its whole life
/// while frames crossed the session in front of it — and `status`, `watch`, the health fold and
/// the System UI's 「机器人链路」 page all read those numbers.
#[derive(Debug, Clone)]
pub struct ZenohTransport {
    session: Session,
    /// The counters this transport reports into (shared with its node — see the type docs).
    metrics: Arc<crate::metrics::LinkMetrics>,
}

impl ZenohTransport {
    /// Open a session with the default config (peer mode + multicast scouting) plus the
    /// `AMOS_LINK_ZENOH_ENDPOINT` override, if set, reporting into a **fresh** counter set.
    ///
    /// A caller that also builds a [`LinkNode`](crate::node::LinkNode) over this transport must
    /// hand it *these* counters ([`ZenohTransport::metrics`]) — or use
    /// [`ZenohTransport::open_with_metrics`] — so the node's `status` counts what the transport
    /// really did.
    pub async fn open() -> Result<Self> {
        Self::open_with(config_from_env()?).await
    }

    /// The counters this transport reports into.
    pub fn metrics(&self) -> &Arc<crate::metrics::LinkMetrics> {
        &self.metrics
    }

    /// Adopt a counter set (builder form) — the node's, so one set describes one node.
    pub fn with_metrics(mut self, metrics: Arc<crate::metrics::LinkMetrics>) -> Self {
        self.metrics = metrics;
        self
    }

    /// Open a session with a caller-provided config, reporting into `metrics`.
    ///
    /// This is the constructor a deployment wants: the counters a node reports and the counters
    /// its transport writes must be **the same set**, or the node's `published` stays 0 while
    /// frames leave the machine.
    pub async fn open_with_metrics(
        config: zenoh::Config,
        metrics: Arc<crate::metrics::LinkMetrics>,
    ) -> Result<Self> {
        Ok(Self::open_with(config).await?.with_metrics(metrics))
    }

    /// Open a session with a caller-provided config (fresh counters — see
    /// [`ZenohTransport::open_with_metrics`]).
    pub async fn open_with(config: zenoh::Config) -> Result<Self> {
        let session = zenoh::open(config)
            .await
            .map_err(|e| LinkError::Transport(format!("opening the Zenoh session: {e}")))?;
        Ok(Self {
            session,
            metrics: Arc::new(crate::metrics::LinkMetrics::new()),
        })
    }

    /// The underlying session (for query/reply and liveliness, which this crate's pub/sub
    /// path does not need but a caller might).
    pub fn session(&self) -> &Session {
        &self.session
    }

    /// This transport as the `Arc<dyn Transport>` a [`LinkNode`] holds.
    ///
    /// [`LinkNode`]: crate::node::LinkNode
    pub fn shared(self) -> Arc<dyn Transport> {
        Arc::new(self)
    }
}

/// Build the Zenoh config: default (peer + scouting) plus the documented env override.
pub fn config_from_env() -> Result<zenoh::Config> {
    let mut config = zenoh::Config::default();
    if let Ok(endpoint) = std::env::var(ENV_ENDPOINT) {
        let endpoint = endpoint.trim();
        if !endpoint.is_empty() {
            // One `tcp/host:port` value, or a comma-separated list of them.
            let list = endpoint
                .split(',')
                .map(|e| format!("\"{}\"", e.trim()))
                .collect::<Vec<_>>()
                .join(",");
            config
                .insert_json5("connect/endpoints", &format!("[{list}]"))
                .map_err(|e| {
                    LinkError::Transport(format!("{ENV_ENDPOINT} `{endpoint}` is not usable: {e}"))
                })?;
        }
    }
    Ok(config)
}

/// What this crate's reliability *means* on the network path.
///
/// Zenoh's per-call `Reliability` knob lives behind its `unstable` feature, which this
/// crate deliberately does not enable (the dependency surface has to stay affordable on
/// a robot image). What that means in practice, stated rather than implied:
///
/// * the **link** reliability is Zenoh's default for the negotiated transport (reliable
///   over TCP/UDS, best-effort over UDP);
/// * the QoS this crate *does* enforce remotely is the **consumer queue**: `depth`
///   becomes the FIFO handler's capacity, and a full queue drops at that local boundary
///   the way [`Qos`](crate::qos::Qos) says.
///
/// Enabling `zenoh/unstable` later would turn this into a real mapping; the seam is here
/// so that change stays local to this module.
pub fn network_reliability_note(reliability: crate::qos::Reliability) -> &'static str {
    match reliability {
        crate::qos::Reliability::BestEffort => {
            "best-effort consumer queue (drops at the local FIFO when full)"
        }
        crate::qos::Reliability::Reliable => {
            "reliable consumer queue (the local FIFO back-pressures the forwarding task)"
        }
    }
}

#[async_trait]
impl Transport for ZenohTransport {
    /// Put one framed payload on the bus.
    ///
    /// `Session::put` is the session-level path (no long-lived publisher handle): a
    /// control topic published once a second does not need one, and the data-plane
    /// frames are large enough that the extra declaration would cost more than it saves.
    async fn publish(&self, topic: &Topic, frame: Arc<[u8]>) -> Result<PublishReport> {
        self.session
            .put(topic.as_str(), frame.to_vec())
            .await
            .map_err(|e| LinkError::Transport(format!("publishing on {topic}: {e}")))?;
        // A network transport cannot count remote subscribers: report the local truth
        // (the frame went out) and leave `matched` unknown. `put` either returns once the
        // frame is handed to the session or fails, so nothing here was back-pressured on
        // *our* side — the network's own flow control is not ours to count.
        //
        // The counters move here, where the fact happens: `published` is one for one put that
        // returned `Ok`, and `delivered` follows the report's own meaning for this transport
        // ("put on the wire", see `PublishReport`). Until round 15 this function touched no
        // counter at all, so a node on a network transport reported zeros for its whole life.
        self.metrics.record_published(1);
        self.metrics.record_delivered(1);
        Ok(PublishReport {
            matched: None,
            delivered: 1,
            dropped: 0,
            blocked: 0,
        })
    }

    async fn subscribe(&self, pattern: &Topic, qos: Qos) -> Result<Subscription> {
        qos.validate()?;
        let counters = Subscription::counters();
        let relay =
            crate::broker::RelayCounters::new(Arc::clone(&counters), Arc::clone(&self.metrics));
        // The handler implements the subscriber's QoS at the Zenoh boundary:
        // `RingChannel` never blocks the delivery thread (best-effort — a stale stereo frame is
        // worth less than the newest one), `FifoChannel` blocks it (reliable — a set point must
        // not be lost). The typed subscriber's **sink** is then chosen by the profile, not by
        // the transport: a one-slot latest-wins queue for `DropOldest` depth 1 (the sensor
        // profile), a bounded queue otherwise — the same two shapes the broker builds, so the
        // same QoS means the same thing on both transports (`docs/amos-link.md` §3.18).
        let reliable = qos.reliability == Reliability::Reliable;
        if qos.is_latest_only() {
            let capacity = qos.depth().min(FORWARD_CHANNEL);
            let (subscription, slot) = Subscription::remote_latest(pattern.clone(), qos, counters);
            if reliable {
                let subscriber = self
                    .session
                    .declare_subscriber(pattern.as_str())
                    .with(FifoChannel::new(capacity))
                    .await
                    .map_err(|e| {
                        LinkError::Transport(format!("declaring subscriber {pattern}: {e}"))
                    })?;
                forward_latest!(subscriber, slot, relay, true);
            } else {
                let subscriber = self
                    .session
                    .declare_subscriber(pattern.as_str())
                    .with(RingChannel::new(capacity))
                    .await
                    .map_err(|e| {
                        LinkError::Transport(format!("declaring subscriber {pattern}: {e}"))
                    })?;
                forward_latest!(subscriber, slot, relay, false);
            }
            return Ok(subscription);
        }

        let capacity = qos.depth().min(FORWARD_CHANNEL);
        let (tx, rx) = mpsc::channel(capacity);
        if reliable {
            let subscriber = self
                .session
                .declare_subscriber(pattern.as_str())
                .with(FifoChannel::new(capacity))
                .await
                .map_err(|e| {
                    LinkError::Transport(format!("declaring subscriber {pattern}: {e}"))
                })?;
            forward_samples!(subscriber, tx, relay, true);
        } else {
            let subscriber = self
                .session
                .declare_subscriber(pattern.as_str())
                .with(RingChannel::new(capacity))
                .await
                .map_err(|e| {
                    LinkError::Transport(format!("declaring subscriber {pattern}: {e}"))
                })?;
            forward_samples!(subscriber, tx, relay, false);
        }
        Ok(Subscription::remote(pattern.clone(), qos, rx, counters))
    }

    async fn topics(&self) -> Vec<String> {
        // Documented boundary: a network bus does not know the topics others publish.
        Vec::new()
    }

    /// The counters this transport writes into (see [`Transport::metrics`]) — the same set a
    /// node over it must report: build the transport with
    /// [`ZenohTransport::open_with_metrics`] (or attach them with
    /// [`ZenohTransport::with_metrics`]) and pass that set to
    /// [`LinkNode::with_parts`](crate::node::LinkNode::with_parts).
    fn metrics(&self) -> Arc<crate::metrics::LinkMetrics> {
        Arc::clone(&self.metrics)
    }

    async fn topics_complete(&self) -> bool {
        // …and it must not pretend otherwise: an empty list is *not* a complete one.
        false
    }

    fn name(&self) -> &'static str {
        "zenoh"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A listener/dialer pair on TCP loopback with explicit endpoints (`peer_config`) — the
    /// setup every cross-session test in this module needs, in one place.
    ///
    /// Returns `(listener, dialer)`: the listener is the side a subscription usually lives on
    /// (so a published frame really crosses the session boundary).
    async fn loopback_pair() -> (ZenohTransport, ZenohTransport) {
        loopback_pair_with(Arc::new(crate::metrics::LinkMetrics::new())).await
    }

    /// The same pair, with the **listener** reporting into `metrics`.
    ///
    /// A network relay records into *its transport's* counter set, so a test that wants to read
    /// the node's counters has to hand the transport the same set its subscriber uses — the rule
    /// `docs/amos-link.md` §3.16 states (one counter set per node, `LinkNode::with_parts` warns
    /// when they differ). Building the pair without it is how a test can "prove" that the node's
    /// `dropped` is 0 while its consumer is dropping frames: it is reading the wrong set.
    async fn loopback_pair_with(
        metrics: Arc<crate::metrics::LinkMetrics>,
    ) -> (ZenohTransport, ZenohTransport) {
        let port = free_tcp_port();
        let listens = format!("tcp/127.0.0.1:{port}");
        let listener =
            ZenohTransport::open_with_metrics(peer_config("listen/endpoints", &listens), metrics)
                .await
                .expect("the listening session opens");
        let dialer = ZenohTransport::open_with(peer_config("connect/endpoints", &listens))
            .await
            .expect("the connecting session opens");
        (listener, dialer)
    }

    /// Publish `seq = 1..=count` heartbeats from a *dialer* transport, with a gap between
    /// frames.
    ///
    /// The gap is what makes these tests deterministic: it is longer than a loopback TCP
    /// round trip by three orders of magnitude, so "the consumer was asleep while *n* frames
    /// crossed the session" is a fact rather than a race.
    async fn publish_beats(dialer: &ZenohTransport, topic: &str, count: u64) {
        let shared = dialer.clone().shared();
        let peer = crate::discovery::PeerId::new("dog1").expect("peer");
        let publisher = crate::pubsub::Publisher::new(
            shared,
            Topic::new(topic).expect("topic"),
            peer.clone(),
            Arc::new(crate::codec::Clock::host()),
            Arc::new(crate::metrics::LinkMetrics::new()),
        );
        for seq in 1..=count {
            let beat = crate::telemetry::Heartbeat::new(
                peer.clone(),
                seq,
                crate::codec::Timestamp::now(),
                5,
            );
            publisher.publish(&beat).await.expect("publish the beat");
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// **The sensor profile means the same thing on both transports**: latest sample wins.
    ///
    /// `Qos::sensor()` is `DropOldest` + depth 1, and the reason it exists is the sentence in
    /// `qos.rs`: *"a consumer that was busy for 10 frames wakes up holding frame 10 — never a
    /// backlog of 10 stale ones"*. In-process that is exactly what `LatestSlot` does. Over
    /// Zenoh it **was not**: `ZenohTransport::subscribe` built the remote subscription with no
    /// slot (`Subscription::remote`), so a depth-1 `DropOldest` consumer got a one-slot `mpsc`
    /// fed by a **blocking** `send` — it woke up holding the frame that had been pulled into
    /// the forwarding channel *first* (the oldest of the stall), and every frame replaced in
    /// between was counted **nowhere** (`stats().dropped` stayed 0, and so did the node's
    /// `dropped`: the relay only recorded a delivery, or the terminal "consumer is gone").
    ///
    /// That is the ROS 2 parity question in its sharpest form — KEEP_LAST(1) has to mean "the
    /// most recent sample" whichever transport is underneath — and it is the *camera → brain*
    /// link, i.e. the one this profile was written for (`docs/amos-link.md` §3.18).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_latest_only_subscription_over_a_real_session_keeps_the_newest_frame() {
        let metrics = Arc::new(crate::metrics::LinkMetrics::new());
        let (listener, dialer) = loopback_pair_with(Arc::clone(&metrics)).await;
        let mut sub = crate::pubsub::Subscriber::<crate::telemetry::Heartbeat>::subscribe(
            listener.clone().shared(),
            Topic::pattern("amos/**/telemetry/beat").expect("pattern"),
            Qos::sensor(),
            Arc::clone(&metrics),
        )
        .await
        .expect("subscribe");
        assert!(sub.qos().is_latest_only(), "the profile under test");
        // The session has to be routed before a `put` can reach the subscriber.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        publish_beats(&dialer, "amos/dog1/telemetry/beat", 5).await;

        let got = tokio::time::timeout(std::time::Duration::from_secs(10), sub.recv())
            .await
            .expect("a frame crosses the session")
            .expect("recv");
        assert_eq!(
            got.message.seq, 5,
            "the *newest* frame wins on a network transport too (the broker's contract)"
        );
        assert_eq!(sub.stats().received, 1);
        assert_eq!(
            sub.stats().dropped,
            4,
            "…and the replaced frames are accounted, not silently lost"
        );
        assert_eq!(
            metrics.snapshot().dropped,
            4,
            "…and the node's own counter agrees with the subscription's (the \
             `SubscriptionStats` rule: the two never disagree)"
        );
    }

    /// **A best-effort queue is allowed to drop — and must say how many.** The other half of
    /// the same defect: on the network path the relay did a **blocking** `send` for *every*
    /// reliability, so `DropPolicy::DropNewest` never fired. A depth-2 best-effort subscription
    /// that could hold two frames instead held the whole stream (back-pressure into the
    /// forwarding task), so the consumer's `dropped` read `0` while frames went missing — the
    /// "`0` is not a way to say *unknown*" rule, broken on the transport every board in the
    /// field uses.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_best_effort_queue_over_a_real_session_drops_the_newest_and_counts_it() {
        use crate::qos::DropPolicy;

        let metrics = Arc::new(crate::metrics::LinkMetrics::new());
        let (listener, dialer) = loopback_pair_with(Arc::clone(&metrics)).await;
        let qos = Qos::new(Reliability::BestEffort, 2, DropPolicy::DropNewest);
        let mut sub = crate::pubsub::Subscriber::<crate::telemetry::Heartbeat>::subscribe(
            listener.clone().shared(),
            Topic::pattern("amos/**/telemetry/beat").expect("pattern"),
            qos,
            Arc::clone(&metrics),
        )
        .await
        .expect("subscribe");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        publish_beats(&dialer, "amos/dog1/telemetry/beat", 5).await;

        // The queue kept the *first* two (drop-newest: the arriving frame is the sacrifice)…
        for expected in [1u64, 2] {
            let got = tokio::time::timeout(std::time::Duration::from_secs(5), sub.recv())
                .await
                .unwrap_or_else(|_| panic!("frame {expected} was queued"))
                .expect("recv");
            assert_eq!(got.message.seq, expected);
        }
        // …and the three that did not fit are gone, not waiting.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(400), sub.recv())
                .await
                .is_err(),
            "a full best-effort queue drops; it does not back-pressure the link"
        );
        assert_eq!(
            sub.stats().dropped,
            3,
            "the subscription counts its own loss"
        );
        assert_eq!(
            metrics.snapshot().dropped,
            3,
            "…and so does the node's counter, on a real session"
        );
    }

    #[test]
    fn reliability_is_documented_for_the_network_path() {
        use crate::qos::Reliability;
        assert!(network_reliability_note(Reliability::Reliable).contains("reliable"));
        assert!(network_reliability_note(Reliability::BestEffort).contains("best-effort"));
    }

    #[test]
    fn the_env_override_reaches_the_config() {
        let saved = std::env::var(ENV_ENDPOINT).ok();
        std::env::remove_var(ENV_ENDPOINT);
        let default = config_from_env().expect("default config");
        // We pin **nothing** by default: no connect endpoints (scouting decides, which is
        // what makes LAN discovery configuration-free) and no `mode` override (Zenoh
        // resolves its own default, peer mode, at session open).
        let endpoints = default
            .get_json("connect/endpoints")
            .unwrap_or_else(|_| "<unset>".to_string());
        assert!(
            endpoints.contains("[]") || endpoints.contains("null"),
            "no endpoint is hard-coded by default, got: {endpoints}"
        );
        let mode = default
            .get_json("mode")
            .unwrap_or_else(|_| "<unset>".to_string());
        assert!(
            mode.contains("null"),
            "the crate does not pin the session mode, got: {mode}"
        );

        std::env::set_var(ENV_ENDPOINT, "tcp/10.0.0.7:7447");
        let overridden = config_from_env().expect("override config");
        let endpoints = overridden
            .get_json("connect/endpoints")
            .expect("endpoints are set");
        assert!(endpoints.contains("10.0.0.7:7447"), "got: {endpoints}");

        // A blank value means "no override", not "connect to nothing".
        std::env::set_var(ENV_ENDPOINT, "  ");
        assert!(config_from_env().is_ok());

        match saved {
            Some(v) => std::env::set_var(ENV_ENDPOINT, v),
            None => std::env::remove_var(ENV_ENDPOINT),
        }
    }

    /// A Zenoh config for a peer that talks to exactly one other peer on loopback.
    ///
    /// `key` is `listen/endpoints` or `connect/endpoints`. Scouting is **off** on purpose:
    /// this test is about the session, not about discovery, and leaving multicast scouting on
    /// would make it depend on the network — the property that forced the old test into
    /// `#[ignore]`.
    fn peer_config(key: &str, endpoint: &str) -> zenoh::Config {
        let mut config = zenoh::Config::default();
        config.insert_json5("mode", "\"peer\"").expect("peer mode");
        config
            .insert_json5("scouting/multicast/enabled", "false")
            .expect("scouting off");
        config
            .insert_json5("scouting/gossip/enabled", "false")
            .expect("gossip off");
        config
            .insert_json5(key, &format!("[\"{endpoint}\"]"))
            .expect("endpoint");
        config
    }

    /// A TCP port nobody is listening on right now (probe, release, hand it to the session).
    fn free_tcp_port() -> u16 {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("probe");
        probe.local_addr().expect("probe address").port()
    }

    /// A real session round trip between two sessions in one process, over TCP loopback.
    ///
    /// The previous round left this boundary as "`#[ignore]`d: it opens a real session (peer
    /// mode + multicast scouting) and is environment-dependent". The round trip itself does not
    /// need scouting to be *unpredictable*: two peers with explicit endpoints on loopback are a
    /// real session (real TCP, real handshake, real pub/sub routing) that any host can run, so
    /// the assertion is deterministic and the test no longer needs ignoring. What stays a field
    /// item is *scouting* across hosts (`scouting_finds_a_peer_on_a_real_network`, ignored
    /// below): that one needs a network someone else controls.
    ///
    /// The scheduler is explicit and deliberate: `#[tokio::test]` defaults to the
    /// **current-thread** scheduler, and Zenoh's runtime *panics* on it ("Please use multi
    /// thread scheduler instead"). The previous round's `#[ignore]`d test was written with the
    /// default — so it could not have passed on any machine, and being ignored is why nobody
    /// found out. A test that cannot run is not a boundary; it is a gap with a note on it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_typed_frame_crosses_a_real_session_over_tcp_loopback() {
        let (listener, dialer) = loopback_pair().await;
        assert_eq!(dialer.name(), "zenoh");

        // The subscriber lives on the *listening* side, the publisher on the connecting one:
        // the frame therefore has to cross the session boundary to be seen.
        let mut sub = crate::pubsub::Subscriber::<crate::telemetry::Heartbeat>::subscribe(
            listener.clone().shared(),
            Topic::pattern("amos/**/telemetry/beat").expect("pattern"),
            Qos::sensor(),
            Arc::new(crate::metrics::LinkMetrics::new()),
        )
        .await
        .expect("subscribe on the listening session");
        // A session is asynchronous: the link has to be established before a put is routed.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let shared = dialer.clone().shared();
        let peer = crate::discovery::PeerId::new("dog1").expect("peer");
        let publisher = crate::pubsub::Publisher::new(
            shared,
            Topic::new("amos/dog1/telemetry/beat").expect("topic"),
            peer.clone(),
            Arc::new(crate::codec::Clock::host()),
            Arc::new(crate::metrics::LinkMetrics::new()),
        );
        let beat = crate::telemetry::Heartbeat::new(peer, 1, crate::codec::Timestamp::now(), 5);
        publisher.publish(&beat).await.expect("publish");

        let received = tokio::time::timeout(std::time::Duration::from_secs(10), sub.recv())
            .await
            .expect("a frame crosses the session")
            .expect("recv");
        assert_eq!(received.message, beat, "the payload survives the wire");
        assert_eq!(received.publisher.as_str(), "dog1");
        // A network transport cannot enumerate what other nodes publish: it says so.
        assert!(listener.topics().await.is_empty(), "network bus: unknown");
    }

    /// The longest key expression **our** validator accepts, carried across a real session.
    ///
    /// The docs claim the mapping onto Zenoh is the identity for key expressions ("同一套语法,
    /// 原样交给 Zenoh"). The *grammar* was cross-checked; the **length** never was — and a
    /// length ceiling is exactly the kind of boundary that hides in a claim like that: Zenoh
    /// 0.x capped a key expression at 255 bytes, while this crate's own limits
    /// (`MAX_SEGMENT = 64` × `MAX_SEGMENTS = 32`) allow ~2 KiB. An unverified ceiling there
    /// would mean a key that validates locally and then fails *on the wire* — the failure
    /// mode the whole crate is written to avoid.
    ///
    /// So this pins the property at the largest key the validator accepts: a 32-segment,
    /// ~2 KiB concrete topic and a pattern of the same shape both cross a real TCP session.
    /// If a future Zenoh (or a config) reintroduces a ceiling, this goes red instead of
    /// turning into a "publish silently reaches nobody" report in the field.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_longest_key_expression_we_accept_crosses_a_real_session() {
        let (listener, dialer) = loopback_pair().await;

        // The largest *concrete* key this crate can hold: 32 segments of 64 bytes each.
        let segment = "x".repeat(64);
        let mut long_topic = String::from("amos");
        for _ in 1..32 {
            long_topic.push('/');
            long_topic.push_str(&segment);
        }
        // …and a pattern of the same shape (32 segments, the last one `*`), which matches it.
        // `len() - 65` drops the final `/` **and** its 64-byte segment, so swapping in `*`
        // keeps the segment count at 32 (off-by-one here would test a 33-segment key).
        let long_pattern = format!("{}/{}", &long_topic[..long_topic.len() - 65], "*");
        let topic = Topic::new(long_topic.clone()).expect("our validator accepts it");
        let pattern = Topic::pattern(long_pattern.clone()).expect("our validator accepts it");
        assert_eq!(
            topic.len(),
            32,
            "the segment count this test is about (our maximum)"
        );
        assert!(
            topic.matches(&pattern),
            "the pattern really matches the topic"
        );
        assert!(
            long_topic.len() > 255,
            "the length this test is about is past Zenoh 0.x's 255-byte ceiling: {} bytes",
            long_topic.len()
        );

        // Declared on the *listener* side, published from the connecting one — so the key (and
        // the pattern) both have to survive the session boundary, not just a local lookup.
        let mut sub = crate::pubsub::Subscriber::<crate::telemetry::Heartbeat>::subscribe(
            listener.clone().shared(),
            pattern,
            Qos::sensor(),
            Arc::new(crate::metrics::LinkMetrics::new()),
        )
        .await
        .expect("Zenoh accepts our longest pattern");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let peer = crate::discovery::PeerId::new("dog1").expect("peer");
        let publisher = crate::pubsub::Publisher::new(
            dialer.clone().shared(),
            topic.clone(),
            peer.clone(),
            Arc::new(crate::codec::Clock::host()),
            Arc::new(crate::metrics::LinkMetrics::new()),
        );
        let beat = crate::telemetry::Heartbeat::new(peer, 1, crate::codec::Timestamp::now(), 5);
        publisher
            .publish(&beat)
            .await
            .expect("Zenoh accepts our longest concrete topic");

        let received = tokio::time::timeout(std::time::Duration::from_secs(10), sub.recv())
            .await
            .expect("a frame on the longest key crosses the session")
            .expect("recv");
        assert_eq!(received.message, beat, "the payload survives the wire");
        assert_eq!(
            received.topic.as_str(),
            long_topic,
            "the routing key is the long topic, not a truncated one"
        );
    }

    /// **A node on a real network counts what it publishes.**
    ///
    /// The counters (`published`/`delivered`/`dropped`/`blocked`) are the numbers an operator
    /// reads: `status --json`, the `watch` line, the System UI's 「机器人链路」 page and the
    /// health fold all come from them, and `docs/amos-link.md` promises they are "cumulative,
    /// never reset, never faked". They were recorded by the **in-process broker and by nothing
    /// else** — so a node whose transport is Zenoh (i.e. every board in the field, and the
    /// CLI's `--transport zenoh`) reported `published=0 delivered=0` for its whole life while
    /// frames were crossing the session in front of it.
    ///
    /// The shape under test is the one the CLI builds: one `LinkMetrics` set shared by the
    /// transport and the node (`LinkNode::with_parts`), a real TCP session between two peers.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_node_over_a_real_session_counts_what_it_publishes() {
        let port = free_tcp_port();
        let listens = format!("tcp/127.0.0.1:{port}");

        // The subscriber side: **one** counter set for the transport and the node's
        // subscriber, which is the invariant [`Transport::metrics`] documents (a transport
        // records deliveries, so the node must report its set).
        let subscriber_metrics = Arc::new(crate::metrics::LinkMetrics::new());
        let listener = ZenohTransport::open_with_metrics(
            peer_config("listen/endpoints", &listens),
            Arc::clone(&subscriber_metrics),
        )
        .await
        .expect("the listening session opens");
        let mut sub = crate::pubsub::Subscriber::<crate::telemetry::Heartbeat>::subscribe(
            listener.clone().shared(),
            Topic::pattern("amos/**/telemetry/beat").expect("pattern"),
            Qos::sensor(),
            Arc::clone(&subscriber_metrics),
        )
        .await
        .expect("subscribe");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // The publisher side: a node over the dialing transport, **sharing one counter set**
        // with it — exactly the `build_zenoh_node` shape in the CLI.
        let metrics = Arc::new(crate::metrics::LinkMetrics::new());
        let dialer = ZenohTransport::open_with_metrics(
            peer_config("connect/endpoints", &listens),
            Arc::clone(&metrics),
        )
        .await
        .expect("the connecting session opens");
        let node = crate::node::LinkNode::with_parts(
            crate::discovery::PeerId::new("dog1").expect("peer"),
            crate::discovery::NodeKind::Robot,
            dialer.clone().shared(),
            Arc::new(crate::codec::Clock::host()),
            Arc::clone(&metrics),
        );
        let publisher = node.publisher::<crate::telemetry::Heartbeat>(
            Topic::new("amos/dog1/telemetry/beat").expect("topic"),
        );
        publisher
            .publish(&crate::telemetry::Heartbeat::new(
                crate::discovery::PeerId::new("dog1").expect("peer"),
                1,
                crate::codec::Timestamp::now(),
                5,
            ))
            .await
            .expect("publish");

        let received = tokio::time::timeout(std::time::Duration::from_secs(10), sub.recv())
            .await
            .expect("a frame crosses the session")
            .expect("recv");
        assert_eq!(received.seq, 1);

        // The frame really left this node (a `put` that returned Ok)…
        assert_eq!(
            metrics.snapshot().published,
            1,
            "a node on a network transport must count the frames it publishes — `status` and \
             `watch` show this number, and it used to be 0 forever"
        );
        // …and the peer's forwarding task counted the delivery on its side.
        assert!(
            subscriber_metrics.snapshot().delivered >= 1,
            "the receiving node counts the frame it handed to its subscriber queue: {:?}",
            subscriber_metrics.snapshot()
        );
        // The node's own status document carries the same number (the path an operator reads).
        assert_eq!(node.status().await.metrics.published, 1);
    }

    /// Scouting: two peers that were *not* told about each other find each other on the LAN.
    ///
    /// Ignored because it is the one part that needs the network to cooperate (multicast
    /// scouting, and a second host or at least a second interface): a sandbox or a locked-down
    /// runner cannot promise it. Run it on a real pair of boards/laptops:
    /// `cargo test -p amos-link --features zenoh -- --ignored`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "needs real multicast scouting on the local network; run manually"]
    async fn scouting_finds_a_peer_on_a_real_network() {
        let transport = ZenohTransport::open().await.expect("open session");
        assert_eq!(transport.name(), "zenoh");
        let shared = transport.clone().shared();
        let mut sub = crate::pubsub::Subscriber::<crate::telemetry::Heartbeat>::subscribe(
            Arc::clone(&shared),
            Topic::pattern("amos/**/telemetry/beat").expect("pattern"),
            Qos::sensor(),
            Arc::new(crate::metrics::LinkMetrics::new()),
        )
        .await
        .expect("subscribe");
        let peer = crate::discovery::PeerId::new("dog1").expect("peer");
        let publisher = crate::pubsub::Publisher::new(
            shared,
            Topic::new("amos/dog1/telemetry/beat").expect("topic"),
            peer.clone(),
            Arc::new(crate::codec::Clock::host()),
            Arc::new(crate::metrics::LinkMetrics::new()),
        );
        let beat = crate::telemetry::Heartbeat::new(peer, 1, crate::codec::Timestamp::now(), 5);
        publisher.publish(&beat).await.expect("publish");
        let received = tokio::time::timeout(std::time::Duration::from_secs(5), sub.recv())
            .await
            .expect("a frame arrives over the session")
            .expect("recv");
        assert_eq!(received.message, beat);
    }
}
