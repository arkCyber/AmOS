//! Real LAN discovery over UDP beacons (feature `lan`).
//!
//! The channel [`Discovery`] promises, implemented with the simplest thing that works
//! on a robot LAN and can be debugged with `tcpdump`: a datagram beacon, multicast to a
//! group so no peer needs an address list.
//!
//! ```text
//!   announcer ──► 239.255.42.99:7446 (AMOS_LINK_BEACON_ADDR overrides)
//!                    │
//!   every listener ◄─┘  bind 0.0.0.0:7446 + join the group → next_beacon()
//! ```
//!
//! Honest boundaries, stated where they matter:
//!
//! * **One listener per host port.** `SO_REUSEADDR`/`SO_REUSEPORT` are set so several
//!   *processes* on one host can share the port (the daemon and a CLI on one machine),
//!   but a deployment that cannot rely on that sets a distinct port via
//!   `AMOS_LINK_BEACON_ADDR`.
//! * **Plaintext, unauthenticated.** A beacon carries an id, a role and endpoints —
//!   nothing secret. Identity is *advertised*, not proven; a hostile LAN can forge it.
//!   (The daemon's UDS service bus is the authenticated path; this is the discovery
//!   *hint* that tells a peer where to connect.)
//! * **Best-effort.** A lost datagram is a slower discovery, never an error: a robot on
//!   flaky Wi-Fi must not fail to boot because one beacon vanished.
//! * **Repeated, not one-shot.** A beacon is *evidence*, and evidence expires (a receiver
//!   drops a peer after its TTL). One `announce()` at boot is discoverable only by a peer
//!   that was already listening, which is the opposite of the LAN question ("who is out
//!   there?") — so [`spawn_announcer`] repeats the announcement on a cadence, the same way
//!   the bus federation does ([`crate::discovery::spawn_federation`]).

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket as StdUdpSocket};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

use crate::codec::Timestamp;
use crate::discovery::{Beacon, Discovery, PeerInfo};
use crate::error::{LinkError, Result};

/// The default multicast group + port of the AmOS-Link beacon channel.
pub const DEFAULT_BEACON_ADDR: &str = "239.255.42.99:7446";
/// Environment override for the beacon target (`ip:port`).
pub const ENV_BEACON_ADDR: &str = "AMOS_LINK_BEACON_ADDR";
/// Largest datagram accepted (a beacon is a few hundred bytes; a bigger datagram is
/// either foreign traffic or an attempt to make us allocate). The beacon frame itself
/// has its own, tighter ceiling
/// ([`MAX_BEACON_BYTES`](crate::discovery::MAX_BEACON_BYTES)), enforced by
/// [`Beacon::decode`] before it parses anything.
const MAX_DATAGRAM: usize = 1024;
/// Per-announce send timeout, so a wedged socket cannot stall the caller's task.
const SEND_TIMEOUT: Duration = Duration::from_secs(2);

/// A UDP multicast/unicast beacon channel.
#[derive(Debug)]
pub struct LanDiscovery {
    socket: Arc<UdpSocket>,
    bind: SocketAddr,
    target: SocketAddr,
}

impl LanDiscovery {
    /// Bind a beacon socket and (when the target is a multicast group) join it.
    ///
    /// `bind` is the local address to listen on (`0.0.0.0:<port>` in production,
    /// `127.0.0.1:<port>` in tests); `target` is where announcements go.
    pub async fn bind(bind: SocketAddr, target: SocketAddr) -> Result<Self> {
        let domain = if bind.is_ipv6() {
            socket2::Domain::IPV6
        } else {
            socket2::Domain::IPV4
        };
        let raw = socket2::Socket::new(domain, socket2::Type::DGRAM, Some(socket2::Protocol::UDP))
            .map_err(transport)?;
        // Several processes on one host may listen to the same group/port.
        raw.set_reuse_address(true).map_err(transport)?;
        #[cfg(unix)]
        raw.set_reuse_port(true).map_err(transport)?;
        raw.set_nonblocking(true).map_err(transport)?;
        raw.bind(&bind.into()).map_err(transport)?;
        // `socket2` builds the socket (reuse address/port for same-host peers); the
        // typed `std` socket is only a carrier for tokio's `from_std`.
        let std_socket: StdUdpSocket = raw.into();
        let socket = UdpSocket::from_std(std_socket).map_err(transport)?;
        // Report the *resolved* local address: a caller that asked for port 0 (an
        // ephemeral port, as tests and `--lan` bring-up do) needs to know which port the
        // OS actually chose, or the next peer has nothing to send to.
        let bound = socket.local_addr().unwrap_or(bind);

        if let IpAddr::V4(group) = target.ip() {
            if group.is_multicast() {
                socket
                    .join_multicast_v4(group, Ipv4Addr::UNSPECIFIED)
                    .map_err(|e| {
                        LinkError::Transport(format!("joining the beacon group {group}: {e}"))
                    })?;
            }
        }
        Ok(Self {
            socket: Arc::new(socket),
            bind: bound,
            target,
        })
    }

    /// Bind using `$AMOS_LINK_BEACON_ADDR` (or [`DEFAULT_BEACON_ADDR`]) as the target.
    ///
    /// The local port follows the target's port, so a deployment that wants a *separate*
    /// beacon channel only has to change one variable.
    pub async fn with_defaults() -> Result<Self> {
        let target = beacon_addr_from_env()?;
        let bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), target.port());
        Self::bind(bind, target).await
    }

    /// The local address the beacon socket listens on.
    pub fn bind_addr(&self) -> SocketAddr {
        self.bind
    }

    /// The address announcements are sent to.
    pub fn target_addr(&self) -> SocketAddr {
        self.target
    }

    /// Send one beacon (best-effort, bounded by [`SEND_TIMEOUT`]).
    pub async fn announce(&self, beacon: &Beacon) -> Result<()> {
        let bytes = beacon.encode()?;
        let sent = tokio::time::timeout(SEND_TIMEOUT, self.socket.send_to(&bytes, self.target))
            .await
            .map_err(|_| LinkError::Transport("beacon send timed out".to_string()))?
            .map_err(transport)?;
        if sent != bytes.len() {
            return Err(LinkError::Transport(format!(
                "beacon truncated on send ({sent} of {} bytes)",
                bytes.len()
            )));
        }
        Ok(())
    }

    /// Wait for the next *decodable* beacon.
    ///
    /// Foreign or truncated datagrams are logged and skipped: a shared LAN port carries
    /// other traffic, and one stray packet must not end discovery. Ends with
    /// `Transport` only when the socket itself fails.
    pub async fn next_beacon(&self) -> Result<Beacon> {
        let mut buf = [0u8; MAX_DATAGRAM];
        // Runs until a decodable beacon arrives, or the socket fails (shutdown).
        loop {
            let (len, from) = self.socket.recv_from(&mut buf).await.map_err(transport)?;
            match Beacon::decode(&buf[..len]) {
                Ok(beacon) => return Ok(beacon),
                Err(e) => {
                    tracing::debug!(from = %from, error = %e, "ignoring a foreign beacon datagram")
                }
            }
        }
    }
}

#[async_trait]
impl Discovery for LanDiscovery {
    async fn announce(&self, beacon: &Beacon) -> Result<()> {
        LanDiscovery::announce(self, beacon).await
    }

    async fn next_beacon(&self) -> Result<Beacon> {
        LanDiscovery::next_beacon(self).await
    }

    fn name(&self) -> &'static str {
        "lan"
    }
}

/// A running beacon announcer: the handle that stops it on shutdown.
#[derive(Debug)]
pub struct BeaconAnnouncer {
    handle: JoinHandle<()>,
}

impl BeaconAnnouncer {
    /// True once the task ended (aborted, or the channel failed).
    pub fn is_finished(&self) -> bool {
        self.handle.is_finished()
    }

    /// Stop the task and wait for it (the shutdown path: no orphaned announcer).
    pub async fn stop(self) {
        self.handle.abort();
        if let Err(e) = self.handle.await {
            tracing::debug!(error = %e, "beacon announcer ended");
        }
    }
}

/// Re-announce `peer` on the beacon channel every `period` until stopped.
///
/// Why a task rather than one `announce()` at boot: a beacon is the *only* evidence a
/// receiver has, and a receiver expires it after its TTL
/// ([`PeerRegistry`](crate::discovery::PeerRegistry)). A node that announces once is
/// therefore discoverable only by peers that were already listening — a robot that
/// boots, or a control laptop that joins the LAN a minute later, would never learn it
/// exists. Repeating the announcement is what makes this channel *discovery* instead of
/// a single broadcast.
///
/// The first beat fires immediately (a `tokio` interval's first tick completes at once),
/// so the caller needs no separate startup announce. Every beat carries a **fresh**
/// [`Timestamp`]: a live peer must not keep advertising the instant it booted.
///
/// `period` must be non-zero (a zero-period timer cannot be scheduled) and should be at
/// most a third of the receiver's TTL — the same rule
/// [`spawn_federation`](crate::discovery::spawn_federation) enforces: announcing less
/// often than that makes a healthy peer appear and expire forever, which every other
/// table on the link reads as a flapping node.
pub fn spawn_announcer(
    channel: Arc<LanDiscovery>,
    peer: PeerInfo,
    period: Duration,
) -> Result<BeaconAnnouncer> {
    if period.is_zero() {
        return Err(LinkError::Unsupported(
            "announcer period must be non-zero (a zero-period timer cannot be scheduled)"
                .to_string(),
        ));
    }
    let handle = tokio::spawn(async move {
        // `Delay`, not `Burst`: a beacon is an announcement, not a backlog — a burst after
        // a stall would look like a flapping peer to every table on the LAN.
        let mut ticker = tokio::time::interval(period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Runs until `stop()` aborts it. A failed announce never ends the task: the module
        // contract above is best-effort, so a lost datagram is a slower discovery.
        loop {
            ticker.tick().await;
            let beacon = Beacon::new(peer.clone(), Timestamp::now());
            if let Err(e) = channel.announce(&beacon).await {
                tracing::debug!(peer = %peer.id, error = %e, "beacon announce failed");
            }
        }
    });
    Ok(BeaconAnnouncer { handle })
}

/// Resolve the beacon target from the environment, refusing a malformed value early
/// (a typo must fail at startup, not silently disable discovery).
pub fn beacon_addr_from_env() -> Result<SocketAddr> {
    match std::env::var(ENV_BEACON_ADDR) {
        Ok(v) if !v.trim().is_empty() => v.trim().parse::<SocketAddr>().map_err(|e| {
            LinkError::Transport(format!("{ENV_BEACON_ADDR} `{v}` is not an ip:port — {e}"))
        }),
        _ => DEFAULT_BEACON_ADDR
            .parse::<SocketAddr>()
            .map_err(|e| LinkError::Transport(format!("default beacon address is invalid: {e}"))),
    }
}

/// Wrap an I/O failure as a transport error.
fn transport(e: std::io::Error) -> LinkError {
    LinkError::Transport(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::Timestamp;
    use crate::discovery::{NodeKind, PeerId, PeerInfo};

    fn beacon(id: &str) -> Beacon {
        let peer = PeerInfo::new(PeerId::new(id).expect("peer"), NodeKind::Brain)
            .with_endpoint("tcp/127.0.0.1:7447");
        Beacon::new(peer, Timestamp::new(1_700_000_000, 0).expect("stamp"))
    }

    #[tokio::test]
    async fn a_beacon_travels_over_loopback() {
        // Two sockets on 127.0.0.1 (unicast) — the deterministic shape of the LAN path,
        // with no multicast/interface assumptions a CI sandbox cannot meet.
        let listener = LanDiscovery::bind(
            "127.0.0.1:0".parse().expect("addr"),
            "127.0.0.1:1".parse().expect("addr"),
        )
        .await
        .expect("bind listener");
        let target = listener.bind_addr();
        let sender = LanDiscovery::bind("127.0.0.1:0".parse().expect("addr"), target)
            .await
            .expect("bind sender");

        assert_eq!(sender.target_addr(), target);
        assert_eq!(sender.name(), "lan");
        assert!(sender.bind_addr().port() > 0);

        sender
            .announce(&beacon("mini-brain"))
            .await
            .expect("announce");
        let got = tokio::time::timeout(Duration::from_secs(2), listener.next_beacon())
            .await
            .expect("beacon arrives")
            .expect("decode");
        assert_eq!(got.peer.id.as_str(), "mini-brain");
        assert_eq!(got.peer.kind, NodeKind::Brain);

        // The `Discovery` trait surface is the same channel (what a node holds).
        let dyn_disc: Arc<dyn Discovery> = Arc::new(sender);
        dyn_disc.announce(&beacon("tool")).await.expect("announce");
        let got = tokio::time::timeout(Duration::from_secs(2), listener.next_beacon())
            .await
            .expect("beacon arrives")
            .expect("decode");
        assert_eq!(got.peer.id.as_str(), "tool");
        assert_eq!(dyn_disc.name(), "lan");
    }

    #[tokio::test]
    async fn foreign_datagrams_are_ignored_not_fatal() {
        let listener = LanDiscovery::bind(
            "127.0.0.1:0".parse().expect("addr"),
            "127.0.0.1:1".parse().expect("addr"),
        )
        .await
        .expect("bind");
        let noise = UdpSocket::bind("127.0.0.1:0").await.expect("bind noise");
        // A datagram that is not an AmOS-Link beacon...
        noise
            .send_to(b"hello, is anybody there", listener.bind_addr())
            .await
            .expect("send noise");
        // ...followed by a real one: discovery survives the stray packet.
        let sender = LanDiscovery::bind("127.0.0.1:0".parse().expect("addr"), listener.bind_addr())
            .await
            .expect("bind sender");
        sender.announce(&beacon("dog1")).await.expect("announce");
        let got = tokio::time::timeout(Duration::from_secs(2), listener.next_beacon())
            .await
            .expect("no hang on noise")
            .expect("decode");
        assert_eq!(got.peer.id.as_str(), "dog1");
    }

    #[tokio::test]
    async fn the_announcer_repeats_so_a_late_listener_still_learns_the_peer() {
        // The defect this pins: one `announce()` at boot is discoverable only by a peer that
        // was *already* listening — a robot that boots, or a board that reboots, stays
        // invisible to everyone else. Repetition is what makes the channel discovery, so the
        // test demands **four** beats: a one-shot announcer blocks on the second one and
        // fails here instead of only looking slightly different on a real LAN.
        let listener = LanDiscovery::bind(
            "127.0.0.1:0".parse().expect("addr"),
            "127.0.0.1:1".parse().expect("addr"),
        )
        .await
        .expect("bind listener");
        let sender = Arc::new(
            LanDiscovery::bind("127.0.0.1:0".parse().expect("addr"), listener.bind_addr())
                .await
                .expect("bind sender"),
        );
        let peer = PeerInfo::new(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let announcer = spawn_announcer(Arc::clone(&sender), peer, Duration::from_millis(50))
            .expect("spawn announcer");

        let mut beats = 0;
        let mut last = None;
        while beats < 4 {
            let beat = tokio::time::timeout(Duration::from_secs(2), listener.next_beacon())
                .await
                .expect("the announcer must keep announcing")
                .expect("decode");
            assert_eq!(beat.peer.id.as_str(), "dog1");
            assert_eq!(beat.peer.kind, NodeKind::Robot);
            // A live peer must not keep advertising the instant it booted.
            assert_ne!(last, Some(beat.stamp), "every beat carries a fresh stamp");
            last = Some(beat.stamp);
            beats += 1;
        }
        assert!(!announcer.is_finished(), "it is still announcing");
        // `stop` consumes the handle (the same shape `FederationTask` has), so it is the
        // shutdown proof in itself: it aborts and awaits the task.
        announcer.stop().await;
    }

    #[tokio::test]
    async fn a_zero_period_announcer_is_refused_before_it_spawns() {
        // `tokio::time::interval(0)` panics inside the task, leaving the caller holding a
        // handle to something that never announces — refuse it where it is still visible.
        let channel = Arc::new(
            LanDiscovery::bind(
                "127.0.0.1:0".parse().expect("addr"),
                "127.0.0.1:1".parse().expect("addr"),
            )
            .await
            .expect("bind"),
        );
        let peer = PeerInfo::new(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        assert!(matches!(
            spawn_announcer(channel, peer, Duration::ZERO),
            Err(LinkError::Unsupported(_))
        ));
    }

    #[test]
    fn the_default_channel_and_env_override_are_sane() {
        let default: SocketAddr = DEFAULT_BEACON_ADDR.parse().expect("default parses");
        assert!(
            default.ip().is_multicast(),
            "the default channel is a group"
        );
        assert_eq!(ENV_BEACON_ADDR, "AMOS_LINK_BEACON_ADDR");
        // With no override set, the documented default is used.
        let resolved = beacon_addr_from_env().expect("resolves");
        assert!(resolved.port() > 0);
    }
}
