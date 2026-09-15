//! [`LinkNode`] — one participant of the middleware, and the object everything else
//! is built on.
//!
//! A node owns five things and nothing else:
//!
//! ```text
//!   LinkNode
//!     ├── identity   PeerId + NodeKind        (who I am, on which topics)
//!     ├── transport  Arc<dyn Transport>       (broker today, Zenoh across boards)
//!     ├── clock      Arc<Clock>               (amos-timesync calibrated stamps)
//!     ├── metrics    Arc<LinkMetrics>         (never-faked counters)
//!     └── registry   PeerRegistry             (who else is on the link)
//! ```
//!
//! Typed publishers/subscribers are minted from it (`publisher::<T>` /
//! `subscriber::<T>`), so identity, clock and counters are wired once instead of at
//! every call site. The control plane (`src/service.rs`) and the CLI are both thin
//! shells over this type — which is why `amos-ai` mounts the middleware with a single
//! `.add_service(amos_link::service::server(node))`.
//!
//! Defaults are honest: [`LinkNode::in_process`] gets the in-process [`Broker`] and
//! the **host** clock (`clock_synced == false` until the supervisor's timekeeper
//! calibrates it or a caller injects a loaded
//! [`SyncedClock`](amos_timesync::SyncedClock)).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::broker::{Broker, Transport};
use crate::codec::{Clock, Message, Timestamp};
use crate::discovery::{
    Beacon, FederationTask, NodeKind, PeerId, PeerInfo, PeerRegistry, PeerView,
};
use crate::error::Result;
use crate::health::LinkHealth;
use crate::keyexpr::{Channel, Topic};
use crate::metrics::LinkMetrics;
use crate::pubsub::{Publisher, Subscriber};
use crate::qos::Qos;
use crate::telemetry::{next_seq, Heartbeat, HeartbeatTask, NodeStatus};

/// The link's own crate version, reported by the control plane.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// One AmOS-Link participant.
pub struct LinkNode {
    peer: PeerId,
    kind: NodeKind,
    transport: Arc<dyn Transport>,
    clock: Arc<Clock>,
    metrics: Arc<LinkMetrics>,
    registry: Mutex<PeerRegistry>,
    /// The registry's TTL, kept beside it so the federation can validate its period
    /// without taking the lock.
    peer_ttl: Duration,
    started: Timestamp,
    beat_seq: AtomicU64,
}

impl LinkNode {
    /// A standalone in-process node: [`Broker`] transport, host clock, fresh counters.
    ///
    /// This is what a test, the CLI and a single-board bring-up use. Two nodes made
    /// this way are **not** connected (each owns its own broker) — deliberately so:
    /// `in_process` never silently opens a socket.
    pub fn in_process(peer: PeerId, kind: NodeKind) -> Arc<Self> {
        let metrics = Arc::new(LinkMetrics::new());
        let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
        Arc::new(Self::with_parts(
            peer,
            kind,
            transport,
            Arc::new(Clock::host()),
            metrics,
        ))
    }

    /// A node over a caller-provided transport (a shared broker, the Zenoh transport)
    /// with a caller-provided clock and counter set.
    pub fn with_parts(
        peer: PeerId,
        kind: NodeKind,
        transport: Arc<dyn Transport>,
        clock: Arc<Clock>,
        metrics: Arc<LinkMetrics>,
    ) -> Self {
        let started = clock.now();
        // The table knows whose node this is: a node is not its own peer (a multicast
        // announcement reaches its own sender by default).
        let registry = Mutex::new(PeerRegistry::with_local(
            PeerRegistry::DEFAULT_TTL,
            peer.clone(),
        ));
        Self {
            peer,
            kind,
            transport,
            clock,
            metrics,
            registry,
            peer_ttl: PeerRegistry::DEFAULT_TTL,
            started,
            beat_seq: AtomicU64::new(0),
        }
    }

    /// Override how long a peer stays in the table without a beacon (builder form).
    ///
    /// Does not take effect by accident: [`crate::discovery::spawn_federation`] refuses a
    /// beacon period that is longer than a third of this TTL, because a peer announced
    /// less often than it expires would flap in and out of every other node's table.
    pub fn with_peer_ttl(self, ttl: Duration) -> Self {
        Self {
            registry: Mutex::new(PeerRegistry::with_local(ttl, self.peer.clone())),
            peer_ttl: ttl,
            ..self
        }
    }

    /// How long a peer is kept without a beacon.
    pub fn peer_ttl(&self) -> Duration {
        self.peer_ttl
    }

    /// This node's id.
    pub fn peer(&self) -> &PeerId {
        &self.peer
    }

    /// This node's role.
    pub fn kind(&self) -> NodeKind {
        self.kind
    }

    /// The transport in use.
    pub fn transport(&self) -> &Arc<dyn Transport> {
        &self.transport
    }

    /// The transport's implementation name (`"broker"`, `"zenoh"`).
    pub fn transport_name(&self) -> &'static str {
        self.transport.name()
    }

    /// The node's clock.
    pub fn clock(&self) -> &Arc<Clock> {
        &self.clock
    }

    /// The node's counters.
    pub fn metrics(&self) -> &Arc<LinkMetrics> {
        &self.metrics
    }

    /// Milliseconds since the node was created.
    pub fn uptime_ms(&self) -> u64 {
        u64::try_from(self.clock.now().since(&self.started).as_millis()).unwrap_or(0)
    }

    /// A typed publisher on one concrete topic of this node.
    pub fn publisher<T: Message>(&self, topic: Topic) -> Publisher<T> {
        Publisher::new(
            Arc::clone(&self.transport),
            topic,
            self.peer.clone(),
            Arc::clone(&self.clock),
            Arc::clone(&self.metrics),
        )
    }

    /// A typed subscriber for a pattern (wildcards allowed).
    pub async fn subscriber<T: Message>(&self, pattern: Topic, qos: Qos) -> Result<Subscriber<T>> {
        Subscriber::subscribe(
            Arc::clone(&self.transport),
            pattern,
            qos,
            Arc::clone(&self.metrics),
        )
        .await
    }

    /// The conventional topic of one channel of *this* node.
    pub fn topic(&self, channel: Channel, name: &str) -> Result<Topic> {
        Topic::channel_topic(self.peer.as_str(), channel, name)
    }

    /// The pattern matching every topic of this node.
    pub fn own_pattern(&self) -> Result<Topic> {
        Topic::peer_pattern(self.peer.as_str())
    }

    /// The route a heartbeat travels on (`amos/<peer>/telemetry/beat`).
    pub fn heartbeat_topic(&self) -> Result<Topic> {
        self.topic(Channel::Telemetry, "beat")
    }

    /// Record a discovery beacon. Returns `true` when the peer is new to the table.
    ///
    /// A beacon naming **this node** is refused and counted
    /// ([`LinkNode::self_entries_refused`]) — a node is not its own peer, and a multicast
    /// announcement reaches its own sender by default.
    pub async fn observe(&self, beacon: &Beacon) -> bool {
        let now = self.clock.now();
        let mut registry = self.registry.lock().await;
        let is_new = registry.observe(beacon, now);
        let expired = registry.prune(now);
        drop(registry);
        for id in expired {
            tracing::info!(peer = %id, "peer expired (no beacon within the TTL)");
        }
        is_new
    }

    /// Register a peer without waiting for its beacon (a static/operator peer).
    ///
    /// A static peer is **never evicted by the TTL** (it has no beacon to miss), so the
    /// peer table of a locked-down network — no multicast, no beacons — keeps the
    /// operator's list. It leaves when [`LinkNode::forget_peer`] is called, or when a
    /// beacon from it makes the entry beacon-driven.
    ///
    /// Declaring **this node** is refused and counted: a static entry for itself would sit
    /// in the table forever (nothing evicts a static peer).
    pub async fn learn_peer(&self, info: PeerInfo) -> bool {
        let now = self.clock.now();
        self.registry.lock().await.learn(info, now)
    }

    /// Drop a peer from the table (the removal path a static entry needs, since nothing
    /// else can remove it). Returns `true` when it was there.
    pub async fn forget_peer(&self, id: &PeerId) -> bool {
        let forgotten = self.registry.lock().await.forget(id);
        if forgotten {
            tracing::info!(peer = %id, "peer removed from the table");
        }
        forgotten
    }

    /// How many attempts to record **this node** as its own peer the table has refused
    /// (its own beacons coming back, or a static entry naming it).
    ///
    /// The count is what makes the filter auditable: a table that silently ignores traffic
    /// looks exactly like a link that carried none.
    pub async fn self_entries_refused(&self) -> u64 {
        self.registry.lock().await.self_entries_refused()
    }

    /// The fresh peers, most recent evidence first (expired beacon-driven ones are
    /// dropped first; static peers are always listed).
    pub async fn peers(&self) -> Vec<PeerView> {
        let now = self.clock.now();
        let expired = self.registry.lock().await.prune(now);
        for id in expired {
            tracing::info!(peer = %id, "peer expired (no beacon within the TTL)");
        }
        self.registry.lock().await.peers(now)
    }

    /// Concrete topics the transport has seen *published* traffic on.
    pub async fn topics(&self) -> Vec<String> {
        self.transport.topics().await
    }

    /// True when [`LinkNode::topics`] is the whole truth (a network transport says `false`
    /// — it cannot enumerate what other nodes publish; the in-process broker says `false`
    /// once its bounded inventory is full).
    pub async fn topics_complete(&self) -> bool {
        self.transport.topics_complete().await
    }

    /// The full self-description (what the control plane and the JSON output carry).
    pub async fn status(&self) -> NodeStatus {
        let peers = self.peers().await;
        let topics = self.topics().await;
        let metrics = self.metrics.snapshot();
        let clock_synced = self.clock.synced();
        NodeStatus {
            peer: self.peer.clone(),
            kind: self.kind,
            version: VERSION.to_string(),
            uptime_ms: self.uptime_ms(),
            clock_synced,
            metrics,
            // The node-level verdict: its own counters and peer table, no consumer-side
            // sequence summary (a node cannot see one; a consumer can enrich it).
            health: LinkHealth::evaluate(&metrics, &peers, clock_synced, None),
            peers,
            topics,
        }
    }

    /// One heartbeat for this node (advancing the shared sequence number).
    pub fn heartbeat(&self) -> Heartbeat {
        Heartbeat::new(
            self.peer.clone(),
            next_seq(&self.beat_seq),
            self.clock.now(),
            self.uptime_ms(),
        )
    }

    /// How many heartbeats this node has emitted.
    pub fn heartbeat_seq(&self) -> u64 {
        self.beat_seq.load(Ordering::Relaxed)
    }

    /// Start publishing heartbeats on `amos/<peer>/telemetry/beat`.
    ///
    /// Refuses a zero period (see [`crate::telemetry::spawn_heartbeat`]).
    pub fn spawn_heartbeat(self: &Arc<Self>, period: Duration) -> Result<HeartbeatTask> {
        let topic = self.heartbeat_topic()?;
        crate::telemetry::spawn_heartbeat(self, topic, period)
    }

    /// Join the peer federation over this node's own transport
    /// (`amos/*/telemetry/beacon`, see [`crate::discovery::spawn_federation`]).
    ///
    /// This is what fills [`LinkNode::peers`] on a real deployment, whatever the
    /// transport is: over the in-process broker it links two nodes in one process, and
    /// over the `zenoh` transport it links boards and a field server on the same path
    /// the data takes.
    pub fn spawn_federation(self: &Arc<Self>, period: Duration) -> Result<FederationTask> {
        crate::discovery::spawn_federation(self, period)
    }

    /// The default federation period (1 Hz, like the heartbeat: cheap and fast enough
    /// that a [`PeerRegistry`] TTL of three periods notices a dead board in seconds).
    pub const FEDERATION_PERIOD: Duration = Duration::from_secs(1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{Beacon, PeerInfo};
    use crate::telemetry::DEFAULT_HEARTBEAT_PERIOD;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct MotorCmd {
        joint: u8,
        micros: i32,
    }

    fn node(peer: &str, kind: NodeKind) -> Arc<LinkNode> {
        LinkNode::in_process(PeerId::new(peer).expect("peer"), kind)
    }

    #[tokio::test]
    async fn node_mints_topics_from_its_own_identity() {
        let n = node("dog1", NodeKind::Robot);
        assert_eq!(n.peer().as_str(), "dog1");
        assert_eq!(n.kind(), NodeKind::Robot);
        assert_eq!(n.transport_name(), "broker");
        assert_eq!(
            n.topic(Channel::Control, "joints").expect("topic").as_str(),
            "amos/dog1/control/joints"
        );
        assert_eq!(n.own_pattern().expect("pattern").as_str(), "amos/dog1/**");
        assert_eq!(
            n.heartbeat_topic().expect("topic").as_str(),
            "amos/dog1/telemetry/beat"
        );
        assert!(n.uptime_ms() < 60_000);
        assert!(!n.clock().synced(), "the in-process node starts unsynced");
        assert_eq!(n.metrics().snapshot().published, 0);
        // The status reports the crate version and no peers yet.
        let status = n.status().await;
        assert_eq!(status.version, VERSION);
        assert!(!status.has_peers());
        assert!(status.to_json().expect("json").contains("dog1"));
    }

    #[tokio::test]
    async fn typed_pub_sub_through_the_node() {
        let n = node("dog1", NodeKind::Robot);
        let mut sub = n
            .subscriber::<MotorCmd>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        let pubr = n.publisher::<MotorCmd>(n.topic(Channel::Control, "joints").expect("topic"));
        pubr.publish(&MotorCmd {
            joint: 3,
            micros: 1500,
        })
        .await
        .expect("publish");
        let got = sub.recv().await.expect("recv");
        assert_eq!(
            got.message,
            MotorCmd {
                joint: 3,
                micros: 1500
            }
        );
        assert_eq!(got.topic.as_str(), "amos/dog1/control/joints");
        assert_eq!(
            n.topics().await,
            vec!["amos/dog1/control/joints".to_string()]
        );
    }

    #[tokio::test]
    async fn a_node_never_lists_itself_as_a_peer() {
        // The registry-level invariant, through the node's own API: a node's table must not
        // contain that node — its own beacons (a multicast loop) and an operator's
        // `learn_peer` naming it are both refused, and the refusals are countable.
        let n = node("dog1", NodeKind::Robot);
        let me = PeerInfo::new(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let own = Beacon::new(me.clone(), n.clock().now());

        assert!(!n.observe(&own).await, "our own beacon is not a peer");
        assert!(
            !n.learn_peer(me).await,
            "…and neither is a static entry for it"
        );
        assert!(n.peers().await.is_empty(), "the table stays empty");
        assert_eq!(n.self_entries_refused().await, 2);
        assert!(
            n.status().await.peers.is_empty(),
            "the status document (what the control plane serves) agrees"
        );

        // A foreign peer still lands, and the count does not move for it.
        let other = PeerInfo::new(PeerId::new("mini-brain").expect("peer"), NodeKind::Brain);
        assert!(n.observe(&Beacon::new(other, n.clock().now())).await);
        assert_eq!(n.peers().await.len(), 1);
        assert_eq!(n.self_entries_refused().await, 2);
    }

    #[tokio::test]
    async fn beacons_are_learned_expire_and_can_be_static() {
        let n = node("dog1", NodeKind::Robot);
        let other = PeerInfo::new(PeerId::new("mini-brain").expect("peer"), NodeKind::Brain)
            .with_endpoint("tcp/10.0.0.9:7447");
        let beacon = Beacon::new(other.clone(), n.clock().now());
        assert!(n.observe(&beacon).await, "first beacon is a new peer");
        assert!(!n.observe(&beacon).await, "repeat is not");
        let peers = n.peers().await;
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].info.endpoint(), Some("tcp/10.0.0.9:7447"));

        // A static peer is learned without a beacon, and the TTL never evicts it.
        let cam = PeerInfo::new(PeerId::new("cam-front").expect("peer"), NodeKind::Sensor);
        assert!(n.learn_peer(cam).await);
        let peers = n.peers().await;
        assert_eq!(peers.len(), 2);
        assert_eq!(n.status().await.peers.len(), 2);
        let static_peer = peers
            .iter()
            .find(|p| p.id().as_str() == "cam-front")
            .expect("the static peer is listed");
        assert!(
            static_peer.is_static(),
            "no beacon has ever arrived from it"
        );
        assert_eq!(static_peer.beacons, 0);

        // …and it leaves only when asked (the beacon-driven peer above stays too: its
        // beacon is fresh). `forget_peer` is that removal path.
        assert!(n.forget_peer(static_peer.id()).await);
        assert!(!n.forget_peer(static_peer.id()).await, "already gone");
        assert_eq!(n.peers().await.len(), 1);
    }

    #[tokio::test]
    async fn heartbeats_are_stamped_numbered_and_stoppable() {
        let n = node("dog1", NodeKind::Robot);
        let mut sub = n
            .subscriber::<Heartbeat>(
                Topic::pattern("amos/*/telemetry/beat").expect("pattern"),
                Qos::sensor(),
            )
            .await
            .expect("subscribe");

        let first = n.heartbeat();
        assert_eq!(first.seq, 1);
        assert_eq!(first.peer.as_str(), "dog1");
        assert_eq!(n.heartbeat_seq(), 1);
        assert!(first.age().as_secs() < 5);
        let second = n.heartbeat();
        assert_eq!(second.seq, 2, "each beat advances the shared counter");
        assert_eq!(second.peer, first.peer);
        assert!(second.stamp >= first.stamp);

        // A zero period is *refused*, not handed to the runtime: `interval(0)` panics
        // inside the spawned task, which would leave the caller holding a handle to a task
        // that is already dead.
        let err = n
            .spawn_heartbeat(Duration::ZERO)
            .expect_err("a zero period must be refused");
        assert!(matches!(err, crate::error::LinkError::Unsupported(_)));
        assert!(n.spawn_heartbeat(Duration::from_nanos(1)).is_ok());

        let task = n.spawn_heartbeat(Duration::from_millis(20)).expect("spawn");
        let got = tokio::time::timeout(Duration::from_secs(2), sub.recv())
            .await
            .expect("a heartbeat arrives")
            .expect("recv");
        assert_eq!(got.publisher.as_str(), "dog1");
        assert!(got.message.seq >= 2, "the task keeps numbering");
        assert!(DEFAULT_HEARTBEAT_PERIOD.as_secs() >= 1);
        task.stop().await;
        assert!(
            n.status().await.metrics.published >= 1,
            "the heartbeat task published on the link"
        );
    }
}
