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
/// Environment override for the **interface** the beacon channel uses (a local IPv4
/// address, e.g. `192.168.1.5`).
///
/// This is the knob that makes a multi-NIC board work. A robot has Wi-Fi, Ethernet and a
/// 5G modem, and "the OS picks an interface" is not a decision: an announcement can leave
/// through the 5G modem while the camera board sits on Wi-Fi, and a group join on
/// `0.0.0.0` subscribes only on the kernel's *default* interface — so the two never meet.
/// Pinning both directions to one interface address turns discovery from "it depends on
/// the routing table" into a configured fact.
pub const ENV_BEACON_IFACE: &str = "AMOS_LINK_BEACON_IFACE";
/// Environment override for multicast loopback (`1`/`0`, default: the platform's, which is
/// on).
///
/// `IP_MULTICAST_LOOP` decides whether the kernel copies an outgoing multicast datagram
/// back to the local host **at all** (it is not "send it to myself"): with it off, no local
/// socket receives our own beacons — including a *second* process on the same board. It is
/// therefore never the correctness mechanism (the peer table's self-refusal is: see
/// [`PeerRegistry`](crate::discovery::PeerRegistry)), and this crate leaves it at the
/// platform default unless a deployment asks otherwise. What a deployment gains by turning
/// it off, and what it loses, is measured by `tests/lan_multicast.rs` rather than promised
/// here.
pub const ENV_BEACON_LOOP: &str = "AMOS_LINK_BEACON_LOOP";
/// Largest datagram accepted (a beacon is a few hundred bytes; a bigger datagram is
/// either foreign traffic or an attempt to make us allocate). The beacon frame itself
/// has its own, tighter ceiling
/// ([`MAX_BEACON_BYTES`](crate::discovery::MAX_BEACON_BYTES)), enforced by
/// [`Beacon::decode`] before it parses anything.
const MAX_DATAGRAM: usize = 1024;
/// Per-announce send timeout, so a wedged socket cannot stall the caller's task.
const SEND_TIMEOUT: Duration = Duration::from_secs(2);

/// How the beacon socket is configured, beyond the addresses.
///
/// Kept as a value rather than read at each call site so the applied configuration can be
/// reported back ([`LanDiscovery::options`]) — a resolver that silently ignored a typo
/// would be indistinguishable from one that worked.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BeaconOptions {
    /// The interface both directions are pinned to (outgoing via `IP_MULTICAST_IF`,
    /// incoming via a group join on that interface). `None` = let the kernel decide.
    ///
    /// Applied when the target is a **multicast group** (the default channel); a unicast
    /// target is routed by the kernel, so there is nothing to pin.
    pub iface: Option<Ipv4Addr>,
    /// `Some(false)` disables multicast loopback; `None` leaves the platform default (on).
    pub multicast_loop: Option<bool>,
}

impl BeaconOptions {
    /// Read the two overrides from the environment, refusing malformed values.
    ///
    /// Refusing matters more than it looks: a typo in `AMOS_LINK_BEACON_IFACE` that is
    /// silently ignored produces the exact failure the variable exists to prevent —
    /// discovery that "sometimes works" on a multi-NIC board — so a bad value is an error
    /// at startup instead of a silent fallback.
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            iface: iface_from_env()?,
            multicast_loop: loop_from_env()?,
        })
    }
}

/// Parse `$AMOS_LINK_BEACON_IFACE` (a local IPv4 address; blank = not pinned).
pub fn iface_from_env() -> Result<Option<Ipv4Addr>> {
    match std::env::var(ENV_BEACON_IFACE) {
        Ok(value) if !value.trim().is_empty() => {
            let text = value.trim();
            text.parse::<Ipv4Addr>().map(Some).map_err(|e| {
                LinkError::Transport(format!(
                    "{ENV_BEACON_IFACE} `{text}` is not an interface IPv4 address — {e}"
                ))
            })
        }
        _ => Ok(None),
    }
}

/// Parse `$AMOS_LINK_BEACON_LOOP` (`1`/`0`; blank = platform default).
pub fn loop_from_env() -> Result<Option<bool>> {
    let Ok(value) = std::env::var(ENV_BEACON_LOOP) else {
        return Ok(None);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "" => Ok(None),
        "1" | "true" | "on" => Ok(Some(true)),
        "0" | "false" | "off" => Ok(Some(false)),
        other => Err(LinkError::Transport(format!(
            "{ENV_BEACON_LOOP} `{other}` is not a switch: use 1/true/on or 0/false/off"
        ))),
    }
}

/// A UDP multicast/unicast beacon channel.
#[derive(Debug)]
pub struct LanDiscovery {
    socket: Arc<UdpSocket>,
    bind: SocketAddr,
    target: SocketAddr,
    options: BeaconOptions,
}

impl LanDiscovery {
    /// Bind a beacon socket and (when the target is a multicast group) join it.
    ///
    /// `bind` is the local address to listen on (`0.0.0.0:<port>` in production,
    /// `127.0.0.1:<port>` in tests); `target` is where announcements go. The interface and
    /// loopback overrides are read from the environment
    /// ([`ENV_BEACON_IFACE`]/[`ENV_BEACON_LOOP`]) — use [`LanDiscovery::bind_with`] to pass
    /// them explicitly.
    pub async fn bind(bind: SocketAddr, target: SocketAddr) -> Result<Self> {
        Self::bind_with(bind, target, BeaconOptions::from_env()?).await
    }

    /// Bind with an explicit [`BeaconOptions`] (no environment involved).
    pub async fn bind_with(
        bind: SocketAddr,
        target: SocketAddr,
        options: BeaconOptions,
    ) -> Result<Self> {
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
        // The multicast configuration lives on the raw socket: interface pinning and the
        // loopback switch are set here, before the descriptor becomes a tokio socket.
        if let IpAddr::V4(group) = target.ip() {
            if group.is_multicast() {
                // With an interface configured, **both** directions are pinned to it: the
                // outgoing datagram leaves through it and the group join subscribes on it.
                // Without one, the kernel picks (the default interface for the join, the
                // routing table for the send) — which is the multi-NIC trap
                // `ENV_BEACON_IFACE` exists to close.
                let interface = options.iface.unwrap_or(Ipv4Addr::UNSPECIFIED);
                if let Some(iface) = options.iface {
                    raw.set_multicast_if_v4(&iface).map_err(|e| {
                        LinkError::Transport(format!(
                            "pinning the beacon channel to {iface}: {e} (is that address on this host?)"
                        ))
                    })?;
                }
                raw.join_multicast_v4(&group, &interface).map_err(|e| {
                    LinkError::Transport(format!(
                        "joining the beacon group {group} on {interface}: {e}"
                    ))
                })?;
                if let Some(loop_on) = options.multicast_loop {
                    raw.set_multicast_loop_v4(loop_on).map_err(transport)?;
                }
            }
        }
        // `socket2` builds the socket (reuse address/port for same-host peers); the
        // typed `std` socket is only a carrier for tokio's `from_std`.
        let std_socket: StdUdpSocket = raw.into();
        let socket = UdpSocket::from_std(std_socket).map_err(transport)?;
        // Report the *resolved* local address: a caller that asked for port 0 (an
        // ephemeral port, as tests and `--lan` bring-up do) needs to know which port the
        // OS actually chose, or the next peer has nothing to send to.
        let bound = socket.local_addr().unwrap_or(bind);

        Ok(Self {
            socket: Arc::new(socket),
            bind: bound,
            target,
            options,
        })
    }

    /// The configuration this channel was built with (what was *applied*, not what was
    /// asked for: a caller that presents the channel's state prints this).
    pub fn options(&self) -> BeaconOptions {
        self.options
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

    /// Bind a test channel that **ignores the environment**.
    ///
    /// The production constructor [`LanDiscovery::bind`] reads `AMOS_LINK_BEACON_IFACE` /
    /// `AMOS_LINK_BEACON_LOOP` (that is its job), so a test that is *not* about those variables
    /// must not go through it: otherwise a developer's shell variables change what the test
    /// measures, and the env-parsing test below — which deliberately sets a *bad* value — fails
    /// unrelated tests running beside it in the same binary (measured: `AMOS_LINK_BEACON_LOOP
    /// `maybe` is not a switch` surfacing from `the_announcer_repeats_…`).
    async fn channel(bind: &str, target: SocketAddr) -> LanDiscovery {
        LanDiscovery::bind_with(
            bind.parse().expect("addr"),
            target,
            BeaconOptions::default(),
        )
        .await
        .expect("bind")
    }

    #[tokio::test]
    async fn a_beacon_travels_over_loopback() {
        // Two sockets on 127.0.0.1 (unicast) — the deterministic shape of the LAN path,
        // with no multicast/interface assumptions a CI sandbox cannot meet.
        let listener = channel("127.0.0.1:0", "127.0.0.1:1".parse().expect("addr")).await;
        let target = listener.bind_addr();
        let sender = channel("127.0.0.1:0", target).await;

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
        let listener = channel("127.0.0.1:0", "127.0.0.1:1".parse().expect("addr")).await;
        let noise = UdpSocket::bind("127.0.0.1:0").await.expect("bind noise");
        // A datagram that is not an AmOS-Link beacon...
        noise
            .send_to(b"hello, is anybody there", listener.bind_addr())
            .await
            .expect("send noise");
        // ...followed by a real one: discovery survives the stray packet.
        let sender = channel("127.0.0.1:0", listener.bind_addr()).await;
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
        let listener = channel("127.0.0.1:0", "127.0.0.1:1".parse().expect("addr")).await;
        let sender = Arc::new(channel("127.0.0.1:0", listener.bind_addr()).await);
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
        let channel = Arc::new(channel("127.0.0.1:0", "127.0.0.1:1".parse().expect("addr")).await);
        let peer = PeerInfo::new(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        assert!(matches!(
            spawn_announcer(channel, peer, Duration::ZERO),
            Err(LinkError::Unsupported(_))
        ));
    }

    #[test]
    fn the_beacon_overrides_are_parsed_or_refused() {
        // The environment is process-wide, so this test owns the two variables it touches and
        // restores them (the other env test in this module reads a third one).
        let saved_iface = std::env::var(ENV_BEACON_IFACE).ok();
        let saved_loop = std::env::var(ENV_BEACON_LOOP).ok();

        std::env::remove_var(ENV_BEACON_IFACE);
        std::env::remove_var(ENV_BEACON_LOOP);
        assert_eq!(
            BeaconOptions::from_env().expect("no overrides"),
            BeaconOptions::default(),
            "nothing set = nothing pinned, loop at the platform default"
        );

        std::env::set_var(ENV_BEACON_IFACE, " 192.168.1.5 ");
        assert_eq!(
            BeaconOptions::from_env().expect("a literal address").iface,
            Some(Ipv4Addr::new(192, 168, 1, 5)),
            "surrounding whitespace is trimmed"
        );

        // A hostname or a typo is refused, never silently ignored: the variable exists to pin
        // the NIC, and "the kernel picks" is exactly the failure it prevents.
        std::env::set_var(ENV_BEACON_IFACE, "en0");
        let err = BeaconOptions::from_env().expect_err("`en0` is not an address");
        assert!(err.to_string().contains("en0"), "got: {err}");

        std::env::set_var(ENV_BEACON_IFACE, "   ");
        assert_eq!(
            BeaconOptions::from_env().expect("blank").iface,
            None,
            "a blank value means 'not pinned', not 'pin to nothing'"
        );

        std::env::set_var(ENV_BEACON_LOOP, "0");
        assert_eq!(
            BeaconOptions::from_env().expect("off").multicast_loop,
            Some(false)
        );
        std::env::set_var(ENV_BEACON_LOOP, "TRUE");
        assert_eq!(
            BeaconOptions::from_env().expect("on").multicast_loop,
            Some(true)
        );
        std::env::set_var(ENV_BEACON_LOOP, "maybe");
        let err = BeaconOptions::from_env().expect_err("a non-switch is refused");
        assert!(err.to_string().contains("maybe"), "got: {err}");

        match saved_iface {
            Some(v) => std::env::set_var(ENV_BEACON_IFACE, v),
            None => std::env::remove_var(ENV_BEACON_IFACE),
        }
        match saved_loop {
            Some(v) => std::env::set_var(ENV_BEACON_LOOP, v),
            None => std::env::remove_var(ENV_BEACON_LOOP),
        }
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
