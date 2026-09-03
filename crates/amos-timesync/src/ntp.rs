//! Real SNTP-backed [`NtpTimeSource`] (feature `ntp`).
//!
//! This module performs actual network I/O: it binds a UDP socket, sends an SNTP
//! request to one of the configured servers, and turns the reply into a
//! [`SystemTime`]. The work is blocking (the underlying `sntpc-net-std` client is
//! synchronous), so [`fetch_time`](TimeSource::fetch_time) runs it on the blocking
//! pool via `spawn_blocking`.

use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use sntpc::sync::get_time;
use sntpc::{NtpContext, StdTimestampGen};
use sntpc_net_std::UdpSocketWrapper;
use tracing::debug;

use crate::error::{Error, Result};
use crate::time_source::TimeSource;

const DEFAULT_NTP_PORT: u16 = 123;
/// Socket read timeout for a single NTP exchange.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
/// Reject any reply outside a plausible epoch window (years 2000–2100) right at
/// the network source — before `SyncedClock` runs its own check — so a caller
/// using `NtpTimeSource` directly never gets an absurd `SystemTime`.
const MIN_ACCEPTED_EPOCH_SECS: u64 = 946_684_800; // 2000-01-01T00:00:00Z
const MAX_ACCEPTED_EPOCH_SECS: u64 = 4_102_444_800; // 2100-01-01T00:00:00Z

/// An SNTP time source that queries a configured set of NTP servers.
///
/// Servers are tried in order until one answers. Each may be a numeric
/// `ip:port`/`host:port` or a bare hostname (DNS-resolved with the default NTP
/// port 123).
#[derive(Debug, Clone)]
pub struct NtpTimeSource {
    servers: Vec<String>,
    timeout: Duration,
}

impl NtpTimeSource {
    /// A source that queries the given servers in order (default 5s timeout).
    pub fn new<I, S>(servers: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            servers: servers.into_iter().map(Into::into).collect(),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    /// Override the per-server socket read timeout.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Resolve a `host[:port]` string into candidate socket addresses.
    fn resolve(server: &str) -> Vec<SocketAddr> {
        if let Ok(addr) = server.parse::<SocketAddr>() {
            return vec![addr];
        }
        let (host, port) = match server.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().unwrap_or(DEFAULT_NTP_PORT)),
            None => (server.to_string(), DEFAULT_NTP_PORT),
        };
        (host.as_str(), port)
            .to_socket_addrs()
            .map(|addrs| addrs.collect())
            .unwrap_or_default()
    }

    /// Query every server in order until one yields a plausible time.
    fn query_servers(servers: &[String], timeout: Duration) -> Result<SystemTime> {
        let mut last_err: Option<Error> = None;
        for server in servers {
            let addrs = Self::resolve(server);
            for addr in addrs {
                match query_one(addr, timeout) {
                    Ok(t) => return Ok(t),
                    Err(e) => {
                        debug!("ntp query to {addr} failed: {e}");
                        last_err = Some(e);
                    }
                }
            }
        }
        Err(last_err
            .unwrap_or_else(|| Error::Source("no NTP servers configured or none resolved".into())))
    }
}

#[async_trait]
impl TimeSource for NtpTimeSource {
    async fn fetch_time(&self) -> Result<SystemTime> {
        let servers = self.servers.clone();
        let timeout = self.timeout;
        tokio::task::spawn_blocking(move || Self::query_servers(&servers, timeout))
            .await
            .map_err(|e| Error::Source(format!("ntp worker task failed: {e}")))?
    }
}

/// One SNTP exchange against a single resolved address.
fn query_one(addr: SocketAddr, timeout: Duration) -> Result<SystemTime> {
    let udp = UdpSocket::bind(SocketAddr::from(([0, 0, 0, 0], 0)))
        .map_err(|e| Error::Source(format!("bind udp socket: {e}")))?;
    udp.set_read_timeout(Some(timeout))
        .map_err(|e| Error::Source(format!("set read timeout: {e}")))?;
    let socket = UdpSocketWrapper::new(udp);
    let context = NtpContext::new(StdTimestampGen::default());

    let reply = get_time(addr, &socket, context)
        .map_err(|e| Error::Source(format!("snmp query {addr}: {e:?}")))?;

    let secs = reply.sec();
    if !(MIN_ACCEPTED_EPOCH_SECS..MAX_ACCEPTED_EPOCH_SECS).contains(&secs) {
        return Err(Error::Implausible(secs));
    }
    // The NTP second fraction is a fixed-point value in units of 2^-32 s.
    let frac_nanos = ((reply.sec_fraction() as u128 * 1_000_000_000) >> 32) as u64;
    Ok(UNIX_EPOCH + Duration::from_secs(secs) + Duration::from_nanos(frac_nanos))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_handles_numeric_addr_hostname_and_bare_port() {
        let ip = SocketAddr::from(([203, 0, 113, 7], 123));
        assert_eq!(NtpTimeSource::resolve("203.0.113.7:123"), vec![ip]);
        assert_eq!(
            NtpTimeSource::resolve("203.0.113.7"),
            vec![ip],
            "defaults to :123"
        );

        // A bare hostname is resolved via DNS; at least one address should exist
        // when the resolver is up, or zero when it is not (never panics).
        let _ = NtpTimeSource::resolve("localhost");
        let _ = NtpTimeSource::resolve("localhost:123");

        // Explicit host:port parsing.
        let host_port = NtpTimeSource::resolve("localhost:1123");
        assert!(
            host_port.iter().all(|a| a.port() == 1123),
            "custom port must be honoured"
        );
    }

    #[test]
    fn numeric_ip_without_port_defaults_to_ntp() {
        let a = NtpTimeSource::resolve("192.0.2.1");
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].port(), DEFAULT_NTP_PORT);
    }

    #[tokio::test]
    async fn unreachable_server_errors_cleanly_without_panicking() {
        // Reserve an ephemeral localhost UDP port, then close it so queries to it
        // must fail (no listener). Deterministic and offline.
        let probe = UdpSocket::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let closed = probe.local_addr().unwrap();
        drop(probe);

        let src = NtpTimeSource::new([closed.to_string()]).with_timeout(Duration::from_millis(300));
        // fetch_time must error (never panic) when no server answers.
        assert!(
            src.fetch_time().await.is_err(),
            "closed port should fail the fetch"
        );
    }
}
