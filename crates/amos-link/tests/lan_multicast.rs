//! Real multicast on a pinned interface — the path a robot's LAN discovery actually uses.
//!
//! Every other `lan` test speaks **unicast** loopback: deterministic, but it never exercises
//! the group join, the interface selection or `IP_MULTICAST_LOOP` — i.e. the three things
//! that decide whether two boards see each other on a real robot. These tests do, on the one
//! interface a test can be sure exists (`127.0.0.1`), with a private group and a probed free
//! port so a concurrent test binary cannot be mistaken for the announcer.
//!
//! What this closes and what it does not: the *protocol and the socket configuration* are now
//! proven on real multicast traffic (join, pinned interface, loop on/off, self-echo). What
//! remains a field item is the switch in between — IGMP snooping, STP, Wi-Fi power save — and
//! no loopback test can stand in for it.

#![cfg(feature = "lan")]

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use amos_link::codec::Timestamp;
use amos_link::discovery::{Beacon, NodeKind, PeerId, PeerInfo, PeerRegistry};
use amos_link::error::LinkError;
use amos_link::lan::{spawn_announcer, BeaconOptions, LanDiscovery};

/// The interface every test here pins to: loopback.
const LOOPBACK: Ipv4Addr = Ipv4Addr::LOCALHOST;

/// A port nobody else is listening on right now.
///
/// A fixed port would be a shared resource between parallel test binaries (every socket here
/// sets `SO_REUSEPORT`, so two runs would read each other's beacons); asking the OS for a free
/// one and releasing it keeps each test on its own channel.
fn free_port() -> u16 {
    let probe = std::net::UdpSocket::bind("127.0.0.1:0").expect("probe socket");
    probe.local_addr().expect("probe address").port()
}

fn target(group: Ipv4Addr, port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(group), port)
}

fn pinned(multicast_loop: Option<bool>) -> BeaconOptions {
    BeaconOptions {
        iface: Some(LOOPBACK),
        multicast_loop,
    }
}

/// The wildcard bind a production node uses, with the group joined on the pinned interface.
async fn listener(group: Ipv4Addr, port: u16, multicast_loop: Option<bool>) -> LanDiscovery {
    LanDiscovery::bind_with(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port),
        target(group, port),
        pinned(multicast_loop),
    )
    .await
    .expect("joining the group on the loopback interface")
}

/// Wait for a beacon from `want`, skipping anything else that lands on the port.
async fn next_beacon_from(channel: &LanDiscovery, want: &str) -> Beacon {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let beacon = tokio::time::timeout(left, channel.next_beacon())
            .await
            .expect("a beacon from the announcer arrives")
            .expect("the datagram decodes as a beacon");
        if beacon.peer.id.as_str() == want {
            return beacon;
        }
    }
}

fn robot() -> PeerInfo {
    PeerInfo::new(PeerId::new("dog1").expect("peer"), NodeKind::Robot)
}

#[tokio::test]
async fn a_beacon_crosses_a_real_multicast_group_on_a_pinned_interface() {
    let group = Ipv4Addr::new(239, 255, 42, 201);
    let port = free_port();

    let receiver = listener(group, port, None).await;
    assert_eq!(
        receiver.options().iface,
        Some(LOOPBACK),
        "the channel reports the configuration it applied"
    );

    let sender = Arc::new(
        LanDiscovery::bind_with(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
            target(group, port),
            pinned(None),
        )
        .await
        .expect("pinning the outgoing interface"),
    );
    let announcer =
        spawn_announcer(Arc::clone(&sender), robot(), Duration::from_millis(50)).expect("spawn");

    let first = next_beacon_from(&receiver, "dog1").await;
    assert_eq!(first.peer.kind, NodeKind::Robot);
    // Repetition, on the real channel: a robot that boots before the laptop joins is
    // discoverable because the announcement keeps coming, each with a fresh stamp.
    let second = next_beacon_from(&receiver, "dog1").await;
    assert_ne!(
        first.stamp, second.stamp,
        "every beat carries a fresh stamp"
    );
    announcer.stop().await;
}

#[tokio::test]
async fn a_node_never_learns_itself_from_a_real_multicast_echo() {
    // This is REQ-A242's defect, on the path where it was measured: `discover --lan` listed
    // the machine it ran on, because a multicast announcement comes back through the loopback
    // and nothing refused it. The unit test proved the table's refusal with a hand-built
    // beacon; here the echo is *real traffic*, and the first assertion is what makes the
    // second meaningful (if this platform did not echo, the refusal below would prove
    // nothing).
    let group = Ipv4Addr::new(239, 255, 42, 202);
    let port = free_port();
    let me = PeerId::new("dog1").expect("peer");
    let channel = listener(group, port, None).await;

    channel
        .announce(&Beacon::new(
            PeerInfo::new(me.clone(), NodeKind::Robot),
            Timestamp::now(),
        ))
        .await
        .expect("announce");
    let echo = next_beacon_from(&channel, "dog1").await;
    assert_eq!(
        echo.peer.id.as_str(),
        "dog1",
        "the echo this test depends on really happens on this platform"
    );

    let mut table = PeerRegistry::with_local(PeerRegistry::DEFAULT_TTL, me.clone());
    assert!(
        !table.observe(&echo, Timestamp::now()),
        "our own echo is not a new peer"
    );
    assert!(
        table.peers(Timestamp::now()).is_empty(),
        "the table stays empty"
    );
    assert_eq!(
        table.self_entries_refused(),
        1,
        "and the refusal is counted, not silently dropped"
    );
}

#[tokio::test]
async fn turning_loopback_off_silences_our_own_beacon() {
    // With `IP_MULTICAST_LOOP` off the kernel does not copy our datagram back to *this host*
    // at all — so the switch removes nothing that the peer table's self-refusal was
    // protecting, and it also hides our beacons from a second process on the same board that
    // has not been told our id. Both halves are measured; the second is the positive control
    // that makes the first meaningful.
    let group = Ipv4Addr::new(239, 255, 42, 203);
    let port = free_port();
    let quiet = listener(group, port, Some(false)).await;
    assert_eq!(quiet.options().multicast_loop, Some(false));

    quiet
        .announce(&Beacon::new(robot(), Timestamp::now()))
        .await
        .expect("announce");
    let silent = tokio::time::timeout(Duration::from_millis(300), quiet.next_beacon()).await;
    assert!(
        silent.is_err(),
        "with loopback off our own datagram must not come back, got: {:?}",
        silent.map(|r| r.map(|b| b.peer.id.to_string()))
    );

    // The control: the same socket shape with loopback on *does* come back to itself, so the
    // silence above is the switch working rather than a fixture that never sent anything.
    let loud = listener(group, port, Some(true)).await;
    loud.announce(&Beacon::new(robot(), Timestamp::now()))
        .await
        .expect("announce");
    let echo = next_beacon_from(&loud, "dog1").await;
    assert_eq!(echo.peer.id.as_str(), "dog1");
}

#[tokio::test]
async fn an_interface_that_is_not_on_this_host_is_refused_at_bind() {
    // A typo in `AMOS_LINK_BEACON_IFACE` must fail loudly: silently falling back to "the
    // kernel picks" is the multi-NIC trap the variable exists to close.
    // 192.0.2.0/24 is TEST-NET-1 — reserved for documentation, assigned to no host.
    let group = Ipv4Addr::new(239, 255, 42, 204);
    let port = free_port();
    let err = LanDiscovery::bind_with(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port),
        target(group, port),
        BeaconOptions {
            iface: Some(Ipv4Addr::new(192, 0, 2, 123)),
            multicast_loop: None,
        },
    )
    .await
    .expect_err("a non-local interface address cannot be pinned");
    assert!(matches!(err, LinkError::Transport(_)), "got: {err:?}");
    assert!(
        err.to_string().contains("pinning the beacon channel"),
        "the refusal names the step that failed: {err}"
    );
}
