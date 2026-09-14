//! Peer discovery: who else is on the link, without an IP list.
//!
//! ROS 2 solves discovery with DDS's multicast SPDP; AmOS-Link splits the problem in
//! two, so the *policy* is testable without a network and the *wire* is trivial:
//!
//! ```text
//!   announce ──►  Discovery (a channel: LAN UDP beacon today, Zenoh scouting)  ──► next_beacon
//!                      │
//!                      ▼
//!                 PeerRegistry   ← pure state machine: upsert by PeerId, expire by TTL
//! ```
//!
//! * [`Beacon`] is the message: a tiny bincode struct carrying a [`PeerInfo`] and the
//!   sender's [`Timestamp`], framed with its own magic (`AMLB`) so a stray datagram on
//!   the beacon port is ignored, not misparsed — plus a length and a CRC32, because an
//!   announcement is *who a peer is and where to reach it*: a corrupted one must be
//!   detected, not registered.
//! * [`PeerRegistry`] holds the *truth*: one entry per [`PeerId`], refreshed on each
//!   beacon, evicted when the TTL passes. `observe`/`peers`/`prune` take "now" as a
//!   parameter, so every expiry rule is unit-testable without sleeping.
//! * [`MockDiscovery`] (always compiled) is the offline channel: tests and the CLI's
//!   demo mode push beacons into it. `src/lan.rs` (feature `lan`) is the real UDP one.

use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::task::JoinHandle;

use crate::codec::Timestamp;
use crate::error::{LinkError, Result};
use crate::keyexpr::{Channel, Topic, ROOT};
use crate::node::LinkNode;
use crate::pubsub::{Publisher, Subscriber};
use crate::qos::Qos;

/// Beacon frame magic ("AMos Link Beacon").
pub const BEACON_MAGIC: [u8; 4] = *b"AMLB";
/// Beacon frame version.
///
/// **v2** added the length + CRC32 to the frame (v1 was `magic │ version │ bincode`). A
/// beacon announces *who a peer is and where to reach it*, so a corrupted datagram must
/// be **detected**, not trusted — the same reasoning that gives every data frame a CRC32.
/// The version byte is what makes the change honest: a v1 peer is refused with a typed
/// error instead of being fed a v2 body to misparse.
pub const BEACON_VERSION: u8 = 2;
/// Fixed beacon frame prefix: `magic(4) │ version(1) │ body_len(4) │ crc32(4)`.
pub const BEACON_PREFIX_LEN: usize = 4 + 1 + 4 + 4;
/// Largest accepted beacon frame.
///
/// A beacon is an id, a role, a timestamp and a few endpoints — a few dozen bytes. The
/// ceiling is enforced on **both** sides, before `bincode` sees anything, so a hostile
/// datagram can neither make a receiver allocate nor reach the decoder at all.
pub const MAX_BEACON_BYTES: usize = 512;
/// Largest number of endpoints one peer may advertise in a beacon.
pub const MAX_ENDPOINTS: usize = 8;
/// Longest accepted single endpoint string.
pub const MAX_ENDPOINT_LEN: usize = 128;

/// A stable, human-readable node identifier (`dog1`, `mini-brain`, `cam-front`).
///
/// This is the "hostname" of the middleware: it appears in every topic
/// (`amos/<peer>/…`), in every frame header and in the peer table. It is validated
/// once, at construction, so the rest of the crate can treat it as a safe token.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PeerId(String);

impl PeerId {
    /// Longest accepted id.
    pub const MAX_LEN: usize = 63;

    /// Validate a peer id: `A-Za-z0-9._-`, 1..=63 bytes.
    pub fn new(id: impl Into<String>) -> Result<Self> {
        let id = id.into();
        if id.is_empty() {
            return Err(LinkError::KeyExpr {
                expr: id,
                reason: "empty peer id".to_string(),
            });
        }
        if id.len() > Self::MAX_LEN {
            return Err(LinkError::KeyExpr {
                expr: id,
                reason: format!("peer id longer than {} bytes", Self::MAX_LEN),
            });
        }
        if !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        {
            return Err(LinkError::KeyExpr {
                expr: id,
                reason: "peer ids allow only A-Za-z0-9._-".to_string(),
            });
        }
        Ok(PeerId(id))
    }

    /// The raw id.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PeerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for PeerId {
    type Err = LinkError;

    fn from_str(s: &str) -> Result<Self> {
        PeerId::new(s)
    }
}

impl AsRef<str> for PeerId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl Default for PeerId {
    /// The identity a node assumes when no name was given (the daemon's demo mount, a
    /// scratch tool). It is a *valid* id by construction — see
    /// `default_peer_id_is_valid` — so it can never produce a topic a validator refuses.
    fn default() -> Self {
        PeerId("amos-node".to_string())
    }
}

/// What a peer *is* — the role half of the topology.
///
/// The `serde` names are the same stable keys as [`NodeKind::key`], so a status JSON a
/// script parses and the protobuf the daemon serves cannot disagree about "robot".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    /// The mobile robot itself (the RK3576 board: cameras, motors, IMU).
    Robot,
    /// The compute server (a Mac mini running the models).
    Brain,
    /// A bare sensor node (a fixed camera, a lidar on the wall).
    Sensor,
    /// An actuator node (a gripper, an arm controller).
    Actuator,
    /// Tooling: the CLI, a laptop, a test harness.
    Tool,
}

impl NodeKind {
    /// Every kind, in documentation order.
    pub const ALL: [NodeKind; 5] = [
        NodeKind::Robot,
        NodeKind::Brain,
        NodeKind::Sensor,
        NodeKind::Actuator,
        NodeKind::Tool,
    ];

    /// Stable wire/CLI key.
    pub fn key(self) -> &'static str {
        match self {
            NodeKind::Robot => "robot",
            NodeKind::Brain => "brain",
            NodeKind::Sensor => "sensor",
            NodeKind::Actuator => "actuator",
            NodeKind::Tool => "tool",
        }
    }

    /// Parse a key; `None` for an unknown string.
    pub fn from_key(s: &str) -> Option<NodeKind> {
        NodeKind::ALL.into_iter().find(|k| k.key() == s)
    }
}

/// A peer as announced: id, role, and the endpoints it can be reached on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerInfo {
    /// The peer's stable id.
    pub id: PeerId,
    /// The peer's role.
    pub kind: NodeKind,
    /// Transport endpoints (e.g. `tcp/10.0.0.7:7447`) — empty when the transport
    /// self-discovers (Zenoh scouting) and no address needs to be advertised.
    pub endpoints: Vec<String>,
}

impl PeerInfo {
    /// A peer with no advertised endpoints.
    pub fn new(id: PeerId, kind: NodeKind) -> Self {
        Self {
            id,
            kind,
            endpoints: Vec::new(),
        }
    }

    /// Advertise one more endpoint (builder form).
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoints.push(endpoint.into());
        self
    }

    /// The first advertised endpoint, if any.
    pub fn endpoint(&self) -> Option<&str> {
        self.endpoints.first().map(String::as_str)
    }

    /// Check the advertisement against the beacon frame's bounds.
    ///
    /// Enforced on **both** sides (`Beacon::encode` and `Beacon::decode`), so this crate
    /// never emits a beacon another node would refuse, and never accepts one padded past
    /// the frame ceiling an attacker controls.
    pub fn validate(&self) -> Result<()> {
        if self.endpoints.len() > MAX_ENDPOINTS {
            return Err(LinkError::Frame(format!(
                "peer `{}` advertises {} endpoints (the ceiling is {MAX_ENDPOINTS})",
                self.id,
                self.endpoints.len()
            )));
        }
        if let Some(bad) = self.endpoints.iter().find(|e| e.len() > MAX_ENDPOINT_LEN) {
            return Err(LinkError::Frame(format!(
                "peer `{}` endpoint of {} bytes exceeds the {MAX_ENDPOINT_LEN}-byte ceiling",
                self.id,
                bad.len()
            )));
        }
        Ok(())
    }
}

/// The discovery message: "I am here, reachable like this, at this time".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Beacon {
    /// Format version (refused if it is not [`BEACON_VERSION`]).
    pub version: u8,
    /// Who is announcing.
    pub peer: PeerInfo,
    /// The sender's clock when the beacon was emitted.
    pub stamp: Timestamp,
}

impl Beacon {
    /// Build a version-current beacon.
    pub fn new(peer: PeerInfo, stamp: Timestamp) -> Self {
        Self {
            version: BEACON_VERSION,
            peer,
            stamp,
        }
    }

    /// Encode for the wire: `magic │ version │ body_len │ crc32 │ bincode(beacon)`.
    ///
    /// The prefix is what lets a receiver drop a stray datagram (or a beacon from
    /// another format version) with a *typed* error instead of a parse guess; the length
    /// and CRC32 are what make a **corrupted** announcement a refusal rather than a
    /// silently wrong peer (id, role or endpoint). Both the frame ceiling and the
    /// endpoint bounds are checked *before* a byte is written, so this side can never
    /// emit something [`Beacon::decode`] — or another board — would have to refuse.
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.peer.validate()?;
        let body = bincode::serialize(self).map_err(|e| LinkError::Codec(e.to_string()))?;
        let frame_len = BEACON_PREFIX_LEN + body.len();
        if frame_len > MAX_BEACON_BYTES {
            return Err(LinkError::Frame(format!(
                "beacon of {frame_len} bytes exceeds the {MAX_BEACON_BYTES}-byte frame ceiling"
            )));
        }
        let body_len = u32::try_from(body.len())
            .map_err(|e| LinkError::Frame(format!("beacon body length: {e}")))?;
        let mut out = Vec::with_capacity(frame_len);
        out.extend_from_slice(&BEACON_MAGIC);
        out.push(BEACON_VERSION);
        out.extend_from_slice(&body_len.to_le_bytes());
        out.extend_from_slice(&crc32fast::hash(&body).to_le_bytes());
        out.extend_from_slice(&body);
        Ok(out)
    }

    /// Decode a beacon, refusing a foreign frame, an unknown version, an oversized
    /// frame, a length that disagrees with the bytes present, a CRC mismatch, or an
    /// out-of-bounds peer advertisement.
    ///
    /// The order matters: every check that can be made from the header alone is made
    /// **before** the body is handed to `bincode`, so a hostile datagram never reaches
    /// the decoder and a forged length can never make a receiver allocate.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < BEACON_PREFIX_LEN {
            return Err(LinkError::Frame(format!(
                "beacon of {} bytes is too short (the frame prefix is {BEACON_PREFIX_LEN})",
                bytes.len()
            )));
        }
        if bytes.len() > MAX_BEACON_BYTES {
            return Err(LinkError::Frame(format!(
                "beacon of {} bytes exceeds the {MAX_BEACON_BYTES}-byte frame ceiling",
                bytes.len()
            )));
        }
        if bytes[..4] != BEACON_MAGIC {
            return Err(LinkError::Frame("bad beacon magic".to_string()));
        }
        if bytes[4] != BEACON_VERSION {
            return Err(LinkError::Frame(format!(
                "beacon version {} is not supported (this build speaks {BEACON_VERSION})",
                bytes[4]
            )));
        }
        let body_len = u32::from_le_bytes([bytes[5], bytes[6], bytes[7], bytes[8]]) as usize;
        // Bounded before it is added to anything: a forged 4 GiB claim is a refusal,
        // not an overflow (or an allocation) on a 32-bit board.
        if body_len > MAX_BEACON_BYTES {
            return Err(LinkError::Frame(format!(
                "beacon body of {body_len} bytes exceeds the {MAX_BEACON_BYTES}-byte frame ceiling"
            )));
        }
        if BEACON_PREFIX_LEN + body_len != bytes.len() {
            return Err(LinkError::Frame(format!(
                "beacon claims a {body_len}-byte body but carries {} bytes",
                bytes.len() - BEACON_PREFIX_LEN
            )));
        }
        let body = &bytes[BEACON_PREFIX_LEN..];
        let expected = u32::from_le_bytes([bytes[9], bytes[10], bytes[11], bytes[12]]);
        let actual = crc32fast::hash(body);
        if expected != actual {
            return Err(LinkError::Frame(format!(
                "beacon crc mismatch (frame says {expected:#010x}, computed {actual:#010x})"
            )));
        }
        let beacon: Beacon =
            bincode::deserialize(body).map_err(|e| LinkError::Frame(e.to_string()))?;
        if beacon.version != BEACON_VERSION {
            return Err(LinkError::Frame(
                "beacon version field disagrees with its framing".to_string(),
            ));
        }
        beacon.peer.validate()?;
        Ok(beacon)
    }
}

/// One registry entry, plus what this node has seen of that peer.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Seen {
    info: PeerInfo,
    /// When this node last had *evidence* of the peer: a beacon, or (for a hand-declared
    /// peer) the moment it was learned.
    evidence: Timestamp,
    /// `true` once a beacon has arrived: the entry is now governed by the TTL. `false` =
    /// **static** (declared by hand), which has no beacon to miss and so never expires.
    beacon_driven: bool,
    beacons: u64,
}

/// True when the entry may stay in the fresh view: a static peer always, a beacon-driven
/// one only while its last beacon is inside the TTL (age == ttl is still fresh).
fn is_fresh(seen: &Seen, now: Timestamp, ttl: Duration) -> bool {
    !seen.beacon_driven || now.since(&seen.evidence) <= ttl
}

/// The age of the last evidence, in milliseconds.
fn age_ms(seen: &Seen, now: Timestamp) -> u64 {
    u64::try_from(now.since(&seen.evidence).as_millis()).unwrap_or(0)
}

/// A peer as the registry reports it: identity + freshness.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerView {
    /// The peer's identity (id, role, endpoints).
    pub info: PeerInfo,
    /// How long ago this node last had *evidence* of the peer, in milliseconds: a beacon
    /// for a beacon-driven peer, the declaration for a static one (`beacons == 0`).
    pub last_seen_ms: u64,
    /// How many beacons this node has accepted from the peer (0 = learned by hand, so
    /// the entry is static and never expires on its own).
    pub beacons: u64,
}

impl PeerView {
    /// The peer's id.
    pub fn id(&self) -> &PeerId {
        &self.info.id
    }

    /// True for a peer that was declared by hand (no beacon has ever arrived from it).
    pub fn is_static(&self) -> bool {
        self.beacons == 0
    }
}

/// The live peer table: upsert on beacon, evict on TTL.
///
/// Deliberately *pure*: every method that depends on time takes `now` as an argument,
/// so expiry is unit-tested with no sleeps and no clock mocking — the same discipline
/// the rest of the workspace uses for policy cores.
#[derive(Debug)]
pub struct PeerRegistry {
    ttl: Duration,
    peers: BTreeMap<PeerId, Seen>,
}

impl PeerRegistry {
    /// The default beacon TTL: three missed beacons at the default 1 Hz cadence.
    pub const DEFAULT_TTL: Duration = Duration::from_secs(3);

    /// A registry that forgets a peer after `ttl` without a beacon.
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            peers: BTreeMap::new(),
        }
    }

    /// The eviction TTL.
    pub fn ttl(&self) -> Duration {
        self.ttl
    }

    /// Number of peers currently tracked (including ones that just expired but have
    /// not been pruned yet — `peers()`/`prune()` are the freshness-aware views).
    pub fn len(&self) -> usize {
        self.peers.len()
    }

    /// True when no peer has ever been seen.
    pub fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }

    /// Record a beacon. Returns `true` when this is the first time the peer is seen
    /// (the caller logs that once, instead of on every beacon).
    ///
    /// A beacon also **converts a static entry to a beacon-driven one**: from here on the
    /// entry is governed by the TTL (a peer that talks must keep talking, or it expires —
    /// which is the liveness signal the whole registry exists for).
    pub fn observe(&mut self, beacon: &Beacon, now: Timestamp) -> bool {
        match self.peers.get_mut(&beacon.peer.id) {
            Some(seen) => {
                seen.info = beacon.peer.clone();
                seen.evidence = now;
                seen.beacon_driven = true;
                seen.beacons += 1;
                false
            }
            None => {
                self.peers.insert(
                    beacon.peer.id.clone(),
                    Seen {
                        info: beacon.peer.clone(),
                        evidence: now,
                        beacon_driven: true,
                        beacons: 1,
                    },
                );
                true
            }
        }
    }

    /// Learn a peer without a beacon (an operator-specified static peer). Returns
    /// `true` when it was not known before.
    ///
    /// A static peer has **no TTL to miss**, so it stays in the table until a beacon
    /// converts it to beacon-driven or [`PeerRegistry::forget`] removes it. That is the
    /// point of a static list on a locked-down robot network: no multicast, no beacons,
    /// and a peer table that does not silently empty itself three seconds after boot.
    ///
    /// Learning also never erases *measured* freshness: an operator correcting a peer's
    /// endpoints must not reset the age of its last beacon (only the advertised facts are
    /// replaced).
    pub fn learn(&mut self, info: PeerInfo, now: Timestamp) -> bool {
        match self.peers.get_mut(&info.id) {
            Some(seen) => {
                seen.info = info;
                false
            }
            None => {
                self.peers.insert(
                    info.id.clone(),
                    Seen {
                        info,
                        evidence: now,
                        beacon_driven: false,
                        beacons: 0,
                    },
                );
                true
            }
        }
    }

    /// Drop a peer from the table (an operator-configurable list needs a removal path —
    /// a static entry cannot expire, so without this it could never leave).
    pub fn forget(&mut self, id: &PeerId) -> bool {
        self.peers.remove(id).is_some()
    }

    /// The fresh peers, most recent evidence first (a static peer is always included).
    pub fn peers(&self, now: Timestamp) -> Vec<PeerView> {
        let mut out: Vec<PeerView> = self
            .peers
            .values()
            .filter(|s| is_fresh(s, now, self.ttl))
            .map(|s| PeerView {
                info: s.info.clone(),
                last_seen_ms: age_ms(s, now),
                beacons: s.beacons,
            })
            .collect();
        out.sort_by(|a, b| {
            a.last_seen_ms
                .cmp(&b.last_seen_ms)
                .then(a.info.id.cmp(&b.info.id))
        });
        out
    }

    /// Drop every **beacon-driven** peer whose last beacon is older than the TTL; returns
    /// their ids so the caller can log the departure (a silently shrinking table is a bug
    /// magnet). Static peers are never evicted.
    pub fn prune(&mut self, now: Timestamp) -> Vec<PeerId> {
        let expired: Vec<PeerId> = self
            .peers
            .iter()
            .filter(|(_, s)| !is_fresh(s, now, self.ttl))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            self.peers.remove(id);
        }
        expired
    }

    /// The ids currently tracked, fresh or not (diagnostics).
    pub fn ids(&self) -> Vec<PeerId> {
        self.peers.keys().cloned().collect()
    }
}

impl Default for PeerRegistry {
    fn default() -> Self {
        Self::new(Self::DEFAULT_TTL)
    }
}

/// The topic beacons travel on: `amos/<peer>/telemetry/beacon`.
pub const BEACON_TOPIC: &str = "beacon";

/// The pattern that matches every peer's beacon (`amos/*/telemetry/beacon`).
pub fn beacon_pattern() -> Result<Topic> {
    Topic::pattern(format!(
        "{ROOT}/*/{}/{BEACON_TOPIC}",
        Channel::Telemetry.key()
    ))
}

/// Discovery **over the link's own transport** — the channel that works everywhere.
///
/// [`MockDiscovery`] is for tests and `src/lan.rs` is the profile that ships its own
/// UDP beacons; this one is the important middle: it exchanges the *same* [`Beacon`] as
/// data-plane frames, on the link's own transport. Two consequences a deployment feels:
///
/// * over the in-process [`Broker`](crate::broker::Broker) two nodes on one machine find
///   each other with no sockets at all (which is what a test can assert deterministically);
/// * over the `zenoh` transport a board's peer table is finally populated **on the same
///   path its data takes** — before this, a Zenoh-linked node discovered the *session* but
///   the middleware's own table stayed empty (an honest gap the docs used to state).
///
/// Self-beacons are the caller's business (see [`spawn_federation`]): a node must not
/// register *itself* as a peer, so the task filters them and counts what it filtered.
pub struct BusDiscovery {
    topic: Topic,
    pattern: Topic,
    publisher: Publisher<Beacon>,
    subscriber: AsyncMutex<Subscriber<Beacon>>,
}

impl BusDiscovery {
    /// Attach to a node: subscribe to every peer's beacon and prepare our own topic.
    ///
    /// The beacon topic uses [`Qos::state`] (best-effort, short history) on purpose: a
    /// lost beacon is one second of slower discovery, and a beacon must never
    /// back-pressure the data plane.
    pub async fn attach(node: &Arc<LinkNode>) -> Result<Self> {
        let topic = node.topic(Channel::Telemetry, BEACON_TOPIC)?;
        let pattern = beacon_pattern()?;
        let subscriber = node
            .subscriber::<Beacon>(pattern.clone(), Qos::state())
            .await?;
        let publisher = node.publisher::<Beacon>(topic.clone());
        Ok(Self {
            topic,
            pattern,
            publisher,
            subscriber: AsyncMutex::new(subscriber),
        })
    }

    /// The topic this node announces on.
    pub fn topic(&self) -> &Topic {
        &self.topic
    }

    /// The pattern every node's beacon matches.
    pub fn pattern(&self) -> &Topic {
        &self.pattern
    }

    /// Publish one beacon (the [`Discovery::announce`] body, without the trait).
    pub async fn announce(&self, beacon: &Beacon) -> Result<()> {
        self.publisher.publish(beacon).await?;
        Ok(())
    }

    /// Wait for the next beacon from any peer.
    pub async fn next_beacon(&self) -> Result<Beacon> {
        Ok(self.subscriber.lock().await.recv().await?.message)
    }
}

#[async_trait]
impl Discovery for BusDiscovery {
    async fn announce(&self, beacon: &Beacon) -> Result<()> {
        BusDiscovery::announce(self, beacon).await
    }

    async fn next_beacon(&self) -> Result<Beacon> {
        BusDiscovery::next_beacon(self).await
    }

    fn name(&self) -> &'static str {
        "bus"
    }
}

/// The discovery channel: announce myself, receive what others announce.
///
/// A trait (not a concrete UDP client) for the same reason every AmOS domain core has
/// a seam: the *policy* above it ([`PeerRegistry`]) must be testable offline, and the
/// real wire must be swappable — the bus ([`BusDiscovery`]), UDP beacons
/// (`src/lan.rs`), or a static list on a locked-down robot network.
#[async_trait]
pub trait Discovery: Send + Sync + 'static {
    /// Emit one beacon (best-effort: a lost announce is just a slower discovery).
    async fn announce(&self, beacon: &Beacon) -> Result<()>;

    /// Wait for the next beacon. `Err(LinkError::Closed)` once the channel is shut
    /// down, so the caller's loop can end instead of spinning.
    async fn next_beacon(&self) -> Result<Beacon>;

    /// Which implementation this is (`"mock"`, `"lan"`, …) — reported in the CLI.
    fn name(&self) -> &'static str;
}

/// An offline discovery channel: a queue a test (or the CLI's demo mode) pushes into.
///
/// Also the reference implementation of the [`Discovery`] contract: `announce` records
/// into an outbox the caller can inspect, `next_beacon` waits on a [`Notify`] and ends
/// with `Closed` after [`MockDiscovery::close`] — the same shutdown shape the UDP and
/// Zenoh channels must honour.
#[derive(Debug, Default)]
pub struct MockDiscovery {
    inbox: Mutex<VecDeque<Beacon>>,
    outbox: Mutex<Vec<Beacon>>,
    notify: Notify,
    closed: AtomicBool,
}

impl MockDiscovery {
    /// An empty channel.
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a beacon as if it had arrived from the network.
    pub fn push(&self, beacon: Beacon) {
        if let Ok(mut q) = self.inbox.lock() {
            q.push_back(beacon);
        }
        self.notify.notify_waiters();
    }

    /// Beacons that were *announced* through this channel (the sent side).
    pub fn announced(&self) -> Vec<Beacon> {
        self.outbox.lock().map(|o| o.clone()).unwrap_or_default()
    }

    /// Beacons still waiting to be received.
    pub fn pending(&self) -> usize {
        self.inbox.lock().map(|q| q.len()).unwrap_or(0)
    }

    /// Take the next queued beacon without waiting.
    pub fn try_next(&self) -> Option<Beacon> {
        self.inbox.lock().ok().and_then(|mut q| q.pop_front())
    }

    /// Shut the channel down: pending receivers wake up with `Closed`.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// True once [`MockDiscovery::close`] ran.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl Discovery for MockDiscovery {
    async fn announce(&self, beacon: &Beacon) -> Result<()> {
        let mut outbox = self
            .outbox
            .lock()
            .map_err(|_| LinkError::Closed("mock discovery outbox poisoned".to_string()))?;
        outbox.push(beacon.clone());
        Ok(())
    }

    async fn next_beacon(&self) -> Result<Beacon> {
        // Terminates as soon as a beacon is available, or with `Closed` after
        // `close()` — the caller's shutdown path, never a spin.
        loop {
            if let Some(b) = self.try_next() {
                return Ok(b);
            }
            if self.is_closed() {
                return Err(LinkError::Closed("mock discovery closed".to_string()));
            }
            self.notify.notified().await;
        }
    }

    fn name(&self) -> &'static str {
        "mock"
    }
}

/// A running federation task: the handle that stops it on shutdown.
#[derive(Debug)]
pub struct FederationTask {
    handle: JoinHandle<()>,
}

impl FederationTask {
    /// True once the task ended (the link closed, or the task was aborted).
    pub fn is_finished(&self) -> bool {
        self.handle.is_finished()
    }

    /// Stop the task and wait for it (the shutdown path: no orphaned publishers).
    pub async fn stop(self) {
        self.handle.abort();
        if let Err(e) = self.handle.await {
            tracing::debug!(error = %e, "federation task ended");
        }
    }
}

/// Join the peer federation: announce this node every `period` and ingest every peer's
/// beacon into its [`PeerRegistry`].
///
/// One task, both directions, because they belong together: a node that announces but
/// never listens populates *other* tables and stays blind itself. Two behaviours that
/// matter in the field:
///
/// * **self-beacons are filtered** (a node is not its own peer). Counting them rather
///   than dropping them silently means a test can prove the filter is active.
/// * the registry's TTL still governs *expiry*: a robot that is switched off disappears
///   from its peers' tables after [`PeerRegistry::DEFAULT_TTL`], which is exactly the
///   "is this link still alive" question a brain server asks.
///
/// The returned task runs until it is stopped or the link closes.
pub fn spawn_federation(node: &Arc<LinkNode>, period: Duration) -> Result<FederationTask> {
    // A zero period would panic inside the spawned task (`tokio::time::interval(0)`), and
    // the caller would hold a handle to a task that never announced anything — refuse it
    // here, where the error is still visible to the caller.
    if period.is_zero() {
        return Err(LinkError::Unsupported(
            "federation period must be non-zero (a zero-period timer cannot be scheduled)"
                .to_string(),
        ));
    }
    // Refuse a period a peer's own TTL would under-cut: announcing less often than
    // three times the TTL means every other table sees this peer appear and expire
    // forever, which looks exactly like a flapping link. Catching the misconfiguration
    // here is cheaper than debugging it on a robot.
    let ttl = node.peer_ttl();
    if period.saturating_mul(3) > ttl {
        return Err(LinkError::Unsupported(format!(
            "federation period {}ms is too long for a peer TTL of {}ms (at most one third \
             of the TTL)",
            period.as_millis(),
            ttl.as_millis()
        )));
    }
    let node = Arc::clone(node);
    let peer = node.peer().clone();
    let kind = node.kind();
    let handle = tokio::spawn(async move {
        let discovery = match BusDiscovery::attach(&node).await {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(peer = %peer, error = %e, "federation not started");
                return;
            }
        };
        // `Delay`, not `Burst`: beacons are announcements, not a backlog — a burst after a
        // stall would look like a flapping peer to every other table on the link.
        let mut ticker = tokio::time::interval(period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let self_beacons = AtomicU64::new(0);
        // Runs until `stop()` aborts it (shutdown), or the link closes (a `recv` error
        // ends the loop instead of spinning on a dead subscription).
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let beacon = Beacon::new(
                        PeerInfo::new(peer.clone(), kind),
                        node.clock().now(),
                    );
                    if let Err(e) = discovery.announce(&beacon).await {
                        tracing::debug!(peer = %peer, error = %e, "beacon announce failed");
                    }
                }
                received = discovery.next_beacon() => {
                    match received {
                        Ok(beacon) if beacon.peer.id == peer => {
                            // Our own beacon came back to us: never a peer.
                            let n = self_beacons.fetch_add(1, Ordering::Relaxed) + 1;
                            tracing::trace!(peer = %peer, count = n, "filtered our own beacon");
                        }
                        Ok(beacon) => {
                            if node.observe(&beacon).await {
                                tracing::info!(
                                    peer = %beacon.peer.id,
                                    kind = beacon.peer.kind.key(),
                                    "peer joined the link"
                                );
                            }
                        }
                        Err(e) => {
                            tracing::debug!(peer = %peer, error = %e, "federation stopped: link closed");
                            return;
                        }
                    }
                }
            }
        }
    });
    Ok(FederationTask { handle })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str) -> PeerInfo {
        PeerInfo::new(PeerId::new(id).expect("peer id"), NodeKind::Robot)
            .with_endpoint("tcp/10.0.0.7:7447")
    }

    fn stamp(secs: u64) -> Timestamp {
        Timestamp::new(secs, 0).expect("timestamp")
    }

    #[test]
    fn peer_ids_are_validated() {
        assert!(PeerId::new("dog1").is_ok());
        assert!(PeerId::new("mini-brain_2.local").is_ok());
        assert!(PeerId::new("").is_err());
        assert!(PeerId::new("dog 1").is_err());
        assert!(PeerId::new("x".repeat(64)).is_err());
        assert_eq!("Dog1".parse::<PeerId>().unwrap().as_str(), "Dog1");
        assert_eq!(PeerId::new("dog1").unwrap().to_string(), "dog1");
    }

    #[test]
    fn default_peer_id_is_valid() {
        // The fallback identity must itself pass validation, or every topic built from
        // it would be refused later.
        let default = PeerId::default();
        assert_eq!(PeerId::new(default.as_str()).expect("valid"), default);
        assert_eq!(default.as_str(), "amos-node");
    }

    /// Build a beacon frame by hand — a valid magic, version, length and CRC32 around a
    /// body this crate's `encode` would refuse. That is the shape an attacker (or a
    /// misbehaving node) can put on the wire, and the only way to prove `decode` does
    /// not merely trust what `encode` already checked.
    fn frame_of(b: &Beacon) -> Vec<u8> {
        let body = bincode::serialize(b).expect("serialize");
        let mut out = Vec::new();
        out.extend_from_slice(&BEACON_MAGIC);
        out.push(BEACON_VERSION);
        out.extend_from_slice(&u32::try_from(body.len()).expect("body len").to_le_bytes());
        out.extend_from_slice(&crc32fast::hash(&body).to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn beacons_round_trip_and_refuse_foreign_frames() {
        let b = Beacon::new(peer("dog1"), stamp(100));
        let wire = b.encode().expect("encode");
        assert_eq!(&wire[..4], &BEACON_MAGIC);
        assert_eq!(wire[4], BEACON_VERSION);
        assert_eq!(
            u32::from_le_bytes([wire[5], wire[6], wire[7], wire[8]]) as usize,
            wire.len() - BEACON_PREFIX_LEN,
            "the length field describes exactly the bytes that follow it"
        );
        assert_eq!(Beacon::decode(&wire).expect("decode"), b);

        assert!(Beacon::decode(b"short").is_err(), "shorter than the prefix");
        let mut bad_magic = wire.clone();
        bad_magic[1] = b'X';
        assert!(Beacon::decode(&bad_magic).is_err());
        // A peer speaking another *version* is refused by version, never fed a body of
        // one format to misparse as another.
        let mut bad_version = wire.clone();
        bad_version[4] = BEACON_VERSION + 1;
        assert!(Beacon::decode(&bad_version).is_err());

        // One flipped body byte is caught by the CRC: without it, a corrupted
        // announcement would register as a silently wrong peer (id, role or endpoint).
        let mut bad_crc = wire.clone();
        let last = bad_crc.len() - 1;
        bad_crc[last] ^= 0xff;
        let err = Beacon::decode(&bad_crc).expect_err("a crc mismatch must be refused");
        assert!(matches!(err, LinkError::Frame(_)), "got: {err:?}");

        // A forged length never reaches the decoder (and cannot allocate): it is
        // refused from the header alone.
        let mut liar = wire.clone();
        liar[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(Beacon::decode(&liar).is_err());

        // A frame past the ceiling is refused outright.
        let huge = vec![0u8; MAX_BEACON_BYTES + 1];
        assert!(Beacon::decode(&huge).is_err());
    }

    #[test]
    fn a_beacon_that_breaks_the_frame_bounds_is_refused_on_both_sides() {
        // Emitting: a peer may not advertise an unbounded endpoint list...
        let mut greedy = peer("dog1");
        for i in 0..=MAX_ENDPOINTS {
            greedy = greedy.with_endpoint(format!("tcp/10.0.0.{i}:7447"));
        }
        assert!(matches!(
            Beacon::new(greedy, stamp(100)).encode(),
            Err(LinkError::Frame(_))
        ));

        // ...nor one endpoint longer than the ceiling.
        let long = peer("dog1").with_endpoint("tcp/".to_string() + &"x".repeat(MAX_ENDPOINT_LEN));
        assert!(Beacon::new(long, stamp(100)).encode().is_err());

        // Receiving: the same bounds hold for a frame built by hand (valid framing, so
        // the advertisement itself is the only reason to refuse it).
        let mut over = PeerInfo::new(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        for i in 0..=MAX_ENDPOINTS {
            over = over.with_endpoint(format!("tcp/10.0.0.{i}:7447"));
        }
        assert!(matches!(
            Beacon::decode(&frame_of(&Beacon::new(over, stamp(100)))),
            Err(LinkError::Frame(_))
        ));

        // The largest *legal* advertisement still round-trips.
        let mut full = PeerInfo::new(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        for i in 0..MAX_ENDPOINTS {
            full = full.with_endpoint(format!("tcp/10.0.0.{i}:7447"));
        }
        let ok = Beacon::new(full, stamp(100));
        assert_eq!(
            Beacon::decode(&ok.encode().expect("encode")).expect("decode"),
            ok
        );
    }

    /// A deterministic totality sweep for the beacon decoder: 2 000 pseudo-random byte
    /// strings plus random single-byte mutations of a real frame must all come back as
    /// `Err` (or decode consistently) — **never** as a panic. This decoder is fed raw
    /// datagrams straight off the network, so “total on arbitrary input” is the property
    /// that matters, and a fixed seed makes it reproducible forever without a fuzzer.
    #[test]
    fn decoding_arbitrary_beacon_bytes_never_panics() {
        let mut seed: u64 = 0x1234_5678_9ABC_DEF0;
        let mut next = move || {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            (seed >> 33) as u32
        };

        let valid = Beacon::new(peer("dog1"), stamp(100))
            .encode()
            .expect("encode");
        for _ in 0..2_000 {
            let len = (next() % 180) as usize;
            let bytes: Vec<u8> = (0..len).map(|_| (next() & 0xff) as u8).collect();
            if let Ok(decoded) = Beacon::decode(&bytes) {
                assert_eq!(
                    decoded.encode().expect("re-encode").len(),
                    bytes.len(),
                    "a decoded beacon must re-encode to the same frame length"
                );
            }
        }
        // One byte at a time, across the whole frame (magic, version, length, CRC, body).
        for _ in 0..500 {
            let mut mutated = valid.clone();
            let index = (next() as usize) % mutated.len();
            mutated[index] ^= 1 << (next() % 8);
            let _ = Beacon::decode(&mutated);
        }
        // A frame claiming the maximum accepted size is handled, not special-cased.
        assert!(Beacon::decode(&vec![0u8; MAX_BEACON_BYTES]).is_err());
    }

    #[test]
    fn registry_upserts_learns_and_expires() {
        let mut reg = PeerRegistry::new(Duration::from_secs(3));
        assert!(reg.is_empty());
        assert_eq!(reg.ttl(), Duration::from_secs(3));

        let b = Beacon::new(peer("dog1"), stamp(100));
        assert!(reg.observe(&b, stamp(100)), "first beacon is a new peer");
        assert!(!reg.observe(&b, stamp(101)), "second beacon is not");
        assert_eq!(reg.len(), 1);
        let views = reg.peers(stamp(101));
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id().as_str(), "dog1");
        assert_eq!(views[0].beacons, 2);
        assert_eq!(views[0].last_seen_ms, 0);
        assert_eq!(views[0].info.endpoint(), Some("tcp/10.0.0.7:7447"));

        // A static peer learned by hand has no beacons but is tracked like any other.
        assert!(reg.learn(peer("cam-front"), stamp(101)));
        assert!(!reg.learn(peer("cam-front"), stamp(101)), "already known");
        assert_eq!(reg.peers(stamp(101)).len(), 2);
        assert_eq!(reg.ids().len(), 2);

        // Just inside the TTL: the beacon-driven peer is still fresh (age == ttl counts
        // as fresh, > ttl does not).
        assert_eq!(reg.peers(stamp(104)).len(), 2);
        // Past the TTL only the *beacon-driven* peer expires; the hand-declared one has no
        // beacon to miss, so it stays (that is what a static list is for).
        let at_105 = reg.peers(stamp(105));
        assert_eq!(at_105.len(), 1);
        assert_eq!(at_105[0].id().as_str(), "cam-front");
        assert!(at_105[0].is_static());
        assert_eq!(
            reg.len(),
            2,
            "the expired entry waits in the map for `prune`"
        );
        let gone = reg.prune(stamp(105));
        assert_eq!(gone.len(), 1, "only the beacon-driven peer expired");
        assert_eq!(gone[0].as_str(), "dog1");
        assert_eq!(reg.ids(), vec![peer("cam-front").id], "cam-front stayed");
    }

    #[test]
    fn static_peers_survive_any_ttl_and_a_beacon_takes_over() {
        // A locked-down robot network has no multicast: a hand-declared peer must stay in
        // the table indefinitely, or the operator's list silently empties three seconds
        // after boot. Once it *does* beacon, the TTL governs it — a peer that talks must
        // keep talking, which is the liveness signal the registry exists for.
        let mut reg = PeerRegistry::new(Duration::from_secs(3));
        assert!(reg.learn(peer("cam-front"), stamp(100)));
        let much_later = stamp(100 + 10_000);

        let views = reg.peers(much_later);
        assert_eq!(views.len(), 1, "a static peer never expires");
        assert!(views[0].is_static());
        assert_eq!(views[0].beacons, 0);
        assert_eq!(
            views[0].last_seen_ms, 10_000_000,
            "the age reported is since the declaration"
        );
        assert!(reg.prune(much_later).is_empty(), "prune never evicts it");
        assert_eq!(reg.len(), 1);

        // A beacon converts it to a beacon-driven entry.
        assert!(!reg.observe(&Beacon::new(peer("cam-front"), stamp(200)), stamp(200)));
        let views = reg.peers(stamp(200));
        assert!(!views[0].is_static(), "it talks now");
        assert_eq!(views[0].beacons, 1);
        assert_eq!(views[0].last_seen_ms, 0);
        assert_eq!(reg.peers(stamp(203)).len(), 1, "age == ttl is fresh");
        assert_eq!(reg.peers(stamp(204)).len(), 0, "past the TTL it expires");
        assert_eq!(reg.prune(stamp(204)).len(), 1);
    }

    #[test]
    fn learning_never_erases_measured_freshness() {
        // An operator correcting a peer's endpoints must not reset the age of its last
        // beacon — otherwise a config reload would make a dead board look alive.
        let mut reg = PeerRegistry::new(Duration::from_secs(300));
        reg.observe(&Beacon::new(peer("dog1"), stamp(100)), stamp(100));

        let corrected = PeerInfo::new(PeerId::new("dog1").expect("peer"), NodeKind::Robot)
            .with_endpoint("tcp/10.0.0.9:7447");
        assert!(!reg.learn(corrected, stamp(300)), "it was already known");

        let views = reg.peers(stamp(300));
        assert_eq!(views.len(), 1);
        assert_eq!(
            views[0].info.endpoint(),
            Some("tcp/10.0.0.9:7447"),
            "the advertised facts were replaced"
        );
        assert_eq!(views[0].beacons, 1, "the beacon count survived");
        assert_eq!(
            views[0].last_seen_ms, 200_000,
            "and so did the measured age"
        );
        assert!(
            !views[0].is_static(),
            "learning must not demote a live peer"
        );
    }

    #[test]
    fn a_static_entry_can_be_removed_by_hand() {
        // Nothing else can remove it (it never expires), so `forget` is the operator's
        // removal path — without it a static entry would be permanent.
        let mut reg = PeerRegistry::new(Duration::from_secs(3));
        assert!(reg.learn(peer("cam-front"), stamp(100)));
        let id = peer("cam-front").id;
        assert!(reg.forget(&id));
        assert!(!reg.forget(&id), "already gone");
        assert!(reg.is_empty());
        assert!(reg.peers(stamp(101)).is_empty());
    }

    #[test]
    fn peers_are_ordered_by_freshness() {
        let mut reg = PeerRegistry::default();
        reg.observe(&Beacon::new(peer("old"), stamp(100)), stamp(100));
        reg.observe(&Beacon::new(peer("new"), stamp(102)), stamp(102));
        let views = reg.peers(stamp(102));
        assert_eq!(views[0].id().as_str(), "new");
        assert_eq!(views[1].id().as_str(), "old");
        assert_eq!(views[1].last_seen_ms, 2000);
    }

    #[test]
    fn node_kind_keys_round_trip() {
        for k in NodeKind::ALL {
            assert_eq!(NodeKind::from_key(k.key()), Some(k));
        }
        assert_eq!(NodeKind::from_key("nope"), None);
    }

    #[tokio::test]
    async fn mock_discovery_delivers_and_closes() {
        use std::sync::Arc;

        let disc = Arc::new(MockDiscovery::new());
        assert_eq!(disc.name(), "mock");
        assert_eq!(disc.pending(), 0);

        let b = Beacon::new(peer("dog1"), stamp(100));
        disc.push(b.clone());
        assert_eq!(disc.pending(), 1);
        assert_eq!(disc.try_next(), Some(b.clone()));
        assert_eq!(disc.try_next(), None);

        // `announce` records into the outbox (what the sender's own announce did).
        disc.announce(&b).await.expect("announce");
        assert_eq!(disc.announced(), vec![b.clone()]);

        // A waiter wakes up when a beacon arrives.
        let waiter = {
            let disc = Arc::clone(&disc);
            tokio::spawn(async move { disc.next_beacon().await })
        };
        tokio::task::yield_now().await;
        disc.push(b.clone());
        let got = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("beacon delivered")
            .expect("join")
            .expect("ok");
        assert_eq!(got, b);

        // ...and ends with `Closed` after shutdown instead of hanging.
        assert!(!disc.is_closed());
        let waiter = {
            let disc = Arc::clone(&disc);
            tokio::spawn(async move { disc.next_beacon().await })
        };
        tokio::task::yield_now().await;
        disc.close();
        let err = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("no hang")
            .expect("join")
            .expect_err("closed");
        assert!(matches!(err, LinkError::Closed(_)));
        assert!(disc.is_closed());
    }

    #[tokio::test]
    async fn the_bus_channel_carries_beacons_over_the_link_transport() {
        use crate::broker::Broker;
        use crate::codec::Clock;
        use crate::metrics::LinkMetrics;

        // Two nodes on one transport: the same shape as two boards on a Zenoh session,
        // but with no sockets, so the assertion is deterministic.
        let metrics = Arc::new(LinkMetrics::new());
        let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
        let clock = Arc::new(Clock::host());
        let dog = Arc::new(LinkNode::with_parts(
            PeerId::new("dog1").expect("peer"),
            NodeKind::Robot,
            Arc::clone(&transport),
            Arc::clone(&clock),
            Arc::clone(&metrics),
        ));
        let brain = Arc::new(LinkNode::with_parts(
            PeerId::new("mini-brain").expect("peer"),
            NodeKind::Brain,
            Arc::clone(&transport),
            Arc::clone(&clock),
            Arc::clone(&metrics),
        ));

        let disc = BusDiscovery::attach(&dog).await.expect("attach");
        assert_eq!(disc.name(), "bus");
        assert_eq!(
            disc.topic().as_str(),
            "amos/dog1/telemetry/beacon",
            "the announcement topic names the node"
        );
        assert_eq!(disc.pattern().as_str(), "amos/*/telemetry/beacon");

        let outbound = Beacon::new(
            PeerInfo::new(PeerId::new("dog1").expect("peer"), NodeKind::Robot)
                .with_endpoint("tcp/10.0.0.7:7447"),
            clock.now(),
        );
        // The peer subscribes *before* the announcement — the realistic order (a board
        // joins the link and then hears whoever is already talking), and the only order
        // in which a fresh best-effort subscriber can receive a frame.
        let mut brain_sub = brain
            .subscriber::<Beacon>(beacon_pattern().expect("pattern"), crate::qos::Qos::state())
            .await
            .expect("subscribe");
        disc.announce(&outbound).await.expect("announce");

        // The announcer hears its own beacon on the shared bus (which is exactly why the
        // federation task filters self-beacons)...
        let heard = tokio::time::timeout(std::time::Duration::from_secs(2), disc.next_beacon())
            .await
            .expect("a beacon arrives")
            .expect("recv");
        assert_eq!(heard, outbound);
        // ...and so does the other node, on its own subscription.
        let brain_heard = tokio::time::timeout(std::time::Duration::from_secs(2), brain_sub.recv())
            .await
            .expect("the peer hears the beacon")
            .expect("recv");
        assert_eq!(brain_heard.message, outbound);
        assert_eq!(brain_heard.publisher.as_str(), "dog1");
        assert_eq!(brain_heard.topic.as_str(), "amos/dog1/telemetry/beacon");

        // The trait object is the same channel (what a node actually holds).
        let as_trait: &dyn Discovery = &disc;
        assert_eq!(as_trait.name(), "bus");
    }

    #[tokio::test]
    async fn federation_refuses_a_period_the_peer_ttl_would_undercut() {
        use crate::broker::Broker;
        use crate::codec::Clock;
        use crate::metrics::LinkMetrics;

        let metrics = Arc::new(LinkMetrics::new());
        let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
        let node = Arc::new(
            LinkNode::with_parts(
                PeerId::new("dog1").expect("peer"),
                NodeKind::Robot,
                transport,
                Arc::new(Clock::host()),
                metrics,
            )
            .with_peer_ttl(Duration::from_secs(3)),
        );
        assert_eq!(node.peer_ttl(), Duration::from_secs(3));

        // A period at most a third of the TTL is fine...
        let ok = node
            .spawn_federation(Duration::from_secs(1))
            .expect("1s is fine");
        ok.stop().await;
        // ...and a longer one is refused with a message an operator can act on, instead
        // of a peer that flaps in and out of every table.
        let err = node
            .spawn_federation(Duration::from_secs(2))
            .expect_err("2s > ttl/3 must be refused");
        assert!(matches!(err, LinkError::Unsupported(_)));
        assert!(err.to_string().contains("one third"), "got: {err}");
    }

    /// Every peer's beacon reaches the whole table, and each node filters its own echo.
    #[tokio::test]
    async fn federation_fills_the_peer_table_and_never_registers_itself() {
        use crate::broker::Broker;
        use crate::codec::Clock;
        use crate::metrics::LinkMetrics;

        let metrics = Arc::new(LinkMetrics::new());
        let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
        let clock = Arc::new(Clock::host());
        let dog = Arc::new(LinkNode::with_parts(
            PeerId::new("dog1").expect("peer"),
            NodeKind::Robot,
            Arc::clone(&transport),
            Arc::clone(&clock),
            Arc::clone(&metrics),
        ));
        let brain = Arc::new(LinkNode::with_parts(
            PeerId::new("mini-brain").expect("peer"),
            NodeKind::Brain,
            Arc::clone(&transport),
            Arc::clone(&clock),
            Arc::clone(&metrics),
        ));

        // A zero period and a period longer than a third of the TTL are both *refused*,
        // each with its own message: the first would panic inside the spawned task, the
        // second would make every other table see this peer flap.
        let zero = dog
            .spawn_federation(std::time::Duration::ZERO)
            .expect_err("a zero period must be refused");
        assert!(format!("{zero}").contains("non-zero"), "got: {zero}");
        let too_long = dog
            .spawn_federation(std::time::Duration::from_secs(60))
            .expect_err("a period beyond a third of the TTL must be refused");
        assert!(
            format!("{too_long}").contains("too long"),
            "got: {too_long}"
        );

        let dog_task = dog
            .spawn_federation(std::time::Duration::from_millis(20))
            .expect("federate");
        let brain_task = brain
            .spawn_federation(std::time::Duration::from_millis(20))
            .expect("federate");

        // Both tables converge on exactly one peer: the *other* node.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let dog_peers = dog.peers().await;
            let brain_peers = brain.peers().await;
            if dog_peers.len() == 1 && brain_peers.len() == 1 {
                assert_eq!(
                    dog_peers[0].info.id.as_str(),
                    "mini-brain",
                    "a node must never register itself as its own peer"
                );
                assert_eq!(brain_peers[0].info.id.as_str(), "dog1");
                assert_eq!(brain_peers[0].info.kind, NodeKind::Robot);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "federation did not converge: dog={:?} brain={:?}",
                dog_peers
                    .iter()
                    .map(|p| p.info.id.clone())
                    .collect::<Vec<_>>(),
                brain_peers
                    .iter()
                    .map(|p| p.info.id.clone())
                    .collect::<Vec<_>>()
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        // The status JSON reports the peer table (what the control plane serves).
        let status = dog.status().await;
        assert!(status.has_peers());
        assert_eq!(status.peers.len(), 1);

        dog_task.stop().await;
        brain_task.stop().await;
    }
}
