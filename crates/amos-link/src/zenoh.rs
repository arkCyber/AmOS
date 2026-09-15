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
//! * **QoS is mapped, not invented.** The local queue depth becomes the FIFO handler's
//!   capacity and `Reliability::Reliable` is what Zenoh's reliable link mode means.
//!   Drop policies describe *our consumer queue*, not the network.
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

/// Forward every sample of a declared Zenoh subscriber into the typed subscriber's
/// channel.
///
/// A macro rather than a function because Zenoh's handler types (`FifoChannelHandler`,
/// `RingChannelHandler`, …) share no common trait for `recv_async`, yet the forwarding
/// loop is identical for all of them. The task ends when the typed subscriber is dropped
/// (its receiver closes and `send` fails) or when the session closes — no orphan.
macro_rules! forward_samples {
    ($subscriber:expr, $tx:expr) => {
        tokio::spawn(async move {
            let subscriber = $subscriber;
            let tx = $tx;
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
                if tx.send(Ingress { topic, frame }).await.is_err() {
                    tracing::debug!("typed subscriber dropped: forwarding task ends");
                    return;
                }
            }
        });
    };
}

/// A [`Transport`] over a Zenoh session.
#[derive(Debug, Clone)]
pub struct ZenohTransport {
    session: Session,
}

impl ZenohTransport {
    /// Open a session with the default config (peer mode + multicast scouting) plus the
    /// `AMOS_LINK_ZENOH_ENDPOINT` override, if set.
    pub async fn open() -> Result<Self> {
        Self::open_with(config_from_env()?).await
    }

    /// Open a session with a caller-provided config.
    pub async fn open_with(config: zenoh::Config) -> Result<Self> {
        let session = zenoh::open(config)
            .await
            .map_err(|e| LinkError::Transport(format!("opening the Zenoh session: {e}")))?;
        Ok(Self { session })
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
        Ok(PublishReport {
            matched: None,
            delivered: 1,
            dropped: 0,
            blocked: 0,
        })
    }

    async fn subscribe(&self, pattern: &Topic, qos: Qos) -> Result<Subscription> {
        qos.validate()?;
        let (tx, rx) = mpsc::channel(qos.depth().min(FORWARD_CHANNEL));
        let counters = Subscription::counters();
        let capacity = qos.depth().min(FORWARD_CHANNEL);

        // The handler implements the subscriber's QoS at the Zenoh boundary:
        // `RingChannel` drops when full (best-effort — a stale stereo frame is worth
        // less than the newest one), `FifoChannel` blocks the Zenoh thread (reliable —
        // a set point must not be lost). Both are then handed to the *same* forwarding
        // task, which is why the loop lives in a macro instead of naming two handler
        // types.
        match qos.reliability {
            Reliability::BestEffort => {
                let subscriber = self
                    .session
                    .declare_subscriber(pattern.as_str())
                    .with(RingChannel::new(capacity))
                    .await
                    .map_err(|e| {
                        LinkError::Transport(format!("declaring subscriber {pattern}: {e}"))
                    })?;
                forward_samples!(subscriber, tx);
            }
            Reliability::Reliable => {
                let subscriber = self
                    .session
                    .declare_subscriber(pattern.as_str())
                    .with(FifoChannel::new(capacity))
                    .await
                    .map_err(|e| {
                        LinkError::Transport(format!("declaring subscriber {pattern}: {e}"))
                    })?;
                forward_samples!(subscriber, tx);
            }
        }
        Ok(Subscription::remote(pattern.clone(), qos, rx, counters))
    }

    async fn topics(&self) -> Vec<String> {
        // Documented boundary: a network bus does not know the topics others publish.
        Vec::new()
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
        let port = free_tcp_port();
        let listens = format!("tcp/127.0.0.1:{port}");
        let listener = ZenohTransport::open_with(peer_config("listen/endpoints", &listens))
            .await
            .expect("the listening session opens");
        let dialer = ZenohTransport::open_with(peer_config("connect/endpoints", &listens))
            .await
            .expect("the connecting session opens");
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
        let port = free_tcp_port();
        let listens = format!("tcp/127.0.0.1:{port}");
        let listener = ZenohTransport::open_with(peer_config("listen/endpoints", &listens))
            .await
            .expect("the listening session opens");
        let dialer = ZenohTransport::open_with(peer_config("connect/endpoints", &listens))
            .await
            .expect("the connecting session opens");

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
