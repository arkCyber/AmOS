//! A minimal, pure-`std` IP/TCP/UDP header parser.
//!
//! Why hand-roll this instead of using `pnet_packet`? So the decode + scan
//! pipeline is **host-testable with zero native deps** in the default build.
//! `pnet` is only pulled in by the `audit` feature to *grab raw frames* from the
//! NIC; turning those bytes into a [`Flow`] is pure and unit-tested here.
//!
//! Honest limits: we scan **per frame**, so a device-bound token split across a
//! TCP segment boundary (or an IP fragment) will not be found — TCP reassembly /
//! IP defragmentation are out of scope for a passive heuristic. Non-initial IP
//! fragments are dropped for exactly this reason.

use crate::signal::Protocol;

/// A decoded (part of a) packet with its transport metadata and payload window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Flow {
    /// Transport protocol.
    pub protocol: Protocol,
    /// Source IP in text form.
    pub src_ip: String,
    /// Destination IP in text form.
    pub dst_ip: String,
    /// Source port when the transport carried one.
    pub src_port: Option<u16>,
    /// Destination port when the transport carried one.
    pub dst_port: Option<u16>,
    /// The bytes handed to the payload scanner (empty for non TCP/UDP).
    pub payload: Vec<u8>,
}

/// True when `buf` starts with an IPv4/IPv6 header (its first nibble is 4 or 6).
pub fn looks_like_ip(buf: &[u8]) -> bool {
    matches!(buf.first().map(|b| b >> 4), Some(4) | Some(6))
}

/// Decode an Ethernet frame (14-byte header stripped) or a raw-IP frame.
pub fn decode_frame(frame: &[u8]) -> Option<Flow> {
    if looks_like_ip(frame) {
        decode_ip(frame)
    } else if frame.len() >= 14 {
        // Ethernet II — skip dest MAC (6) + src MAC (6) + ethertype (2).
        // (VLAN tags are not handled; this is a documented limitation.)
        decode_ip(&frame[14..])
    } else {
        None
    }
}

fn u16be(b: &[u8]) -> u16 {
    (u16::from(b[0]) << 8) | u16::from(b[1])
}

fn decode_ip(buf: &[u8]) -> Option<Flow> {
    match buf.first()?.wrapping_shr(4) {
        4 => ipv4(buf),
        6 => ipv6(buf),
        _ => None,
    }
}

fn ipv4(buf: &[u8]) -> Option<Flow> {
    // A valid IPv4 header is >= 20 bytes; anything shorter must not be indexed.
    if buf.len() < 20 || buf[0] >> 4 != 4 {
        return None;
    }
    let hlen = usize::from(buf[0] & 0x0f) * 4;
    // ihl must be >= 5 (hlen >= 20) and <= 60 (ihl <= 15), and fit the buffer.
    if !(20..=60).contains(&hlen) || buf.len() < hlen {
        return None;
    }
    // Non-first fragment: we never defragment, so skip (can't scan a fragment).
    let frag_off = (u16::from(buf[6] & 0x1f) << 8) | u16::from(buf[7]);
    if frag_off != 0 {
        return None;
    }
    let proto = buf[9];
    let src_ip = fmt_v4(&buf[12..16]);
    let dst_ip = fmt_v4(&buf[16..20]);
    let (protocol, sport, dport, payload) = l4(proto, &buf[hlen..]);
    Some(Flow {
        protocol,
        src_ip,
        dst_ip,
        src_port: sport,
        dst_port: dport,
        payload,
    })
}

fn ipv6(buf: &[u8]) -> Option<Flow> {
    if buf.len() < 40 || buf[0] >> 4 != 6 {
        return None;
    }
    let src_ip = fmt_v6(&buf[8..24]);
    let dst_ip = fmt_v6(&buf[24..40]);
    // Walk IPv6 extension headers (hop-by-hop=0, routing=43, dest=60) to the
    // real upper-layer protocol, with a hard bound so we can never loop forever.
    let mut nh = usize::from(buf[6]);
    let mut pos = 40usize;
    for _ in 0..8 {
        match nh {
            0 | 43 | 60 => {
                if buf.len() < pos + 2 {
                    return None;
                }
                let ext_total = (usize::from(buf[pos + 1]) + 1) * 8;
                nh = usize::from(buf[pos]);
                pos += ext_total;
                if pos > buf.len() {
                    return None;
                }
            }
            _ => break,
        }
    }
    let (protocol, sport, dport, payload) = l4(u8::try_from(nh).unwrap_or(0), &buf[pos..]);
    Some(Flow {
        protocol,
        src_ip,
        dst_ip,
        src_port: sport,
        dst_port: dport,
        payload,
    })
}

/// Parse a TCP/UDP header (returns the payload window); other protocols are Other.
fn l4(proto: u8, buf: &[u8]) -> (Protocol, Option<u16>, Option<u16>, Vec<u8>) {
    match proto {
        6 => tcp(buf),
        17 => udp(buf),
        1 => (Protocol::Icmp, None, None, Vec::new()),
        _ => (Protocol::Other, None, None, Vec::new()),
    }
}

fn udp(buf: &[u8]) -> (Protocol, Option<u16>, Option<u16>, Vec<u8>) {
    if buf.len() < 8 {
        return (Protocol::Udp, None, None, Vec::new());
    }
    let sport = u16be(&buf[0..2]);
    let dport = u16be(&buf[2..4]);
    let payload = buf[8..].to_vec();
    (Protocol::Udp, Some(sport), Some(dport), payload)
}

fn tcp(buf: &[u8]) -> (Protocol, Option<u16>, Option<u16>, Vec<u8>) {
    if buf.len() < 20 {
        return (Protocol::Tcp, None, None, Vec::new());
    }
    let sport = u16be(&buf[0..2]);
    let dport = u16be(&buf[2..4]);
    let data_off = usize::from(buf[12] >> 4) * 4;
    let payload = if data_off < buf.len() {
        buf[data_off..].to_vec()
    } else {
        Vec::new()
    };
    (Protocol::Tcp, Some(sport), Some(dport), payload)
}

fn fmt_v4(o: &[u8]) -> String {
    if o.len() < 4 {
        return String::new();
    }
    format!("{}.{}.{}.{}", o[0], o[1], o[2], o[3])
}

fn fmt_v6(o: &[u8]) -> String {
    // Best-effort, dependency-free hex rendering of a 16-byte address.
    if o.len() < 16 {
        return String::new();
    }
    let mut groups = [0u16; 8];
    for (i, g) in groups.iter_mut().enumerate() {
        *g = (u16::from(o[i * 2]) << 8) | u16::from(o[i * 2 + 1]);
    }
    groups
        .iter()
        .map(|g| format!("{g:x}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eth(payload: &[u8]) -> Vec<u8> {
        let mut f = vec![0u8; 12]; // dummy MACs
        f.extend_from_slice(&[0x08, 0x00]); // ethertype IPv4
        f.extend_from_slice(payload);
        f
    }

    fn ipv4_udp(src: [u8; 4], dst: [u8; 4], sport: u16, dport: u16, data: &[u8]) -> Vec<u8> {
        let mut p = vec![0x45u8]; // v4, ihl 5
        p.push(0); // tos
        p.extend_from_slice(&((20 + 8 + data.len()) as u16).to_be_bytes()); // total len
        p.extend_from_slice(&[0, 0]); // id
        p.extend_from_slice(&[0, 0]); // flags + fragment offset
        p.push(64); // ttl
        p.push(17); // udp
        p.extend_from_slice(&[0, 0]); // checksum
        p.extend_from_slice(&src);
        p.extend_from_slice(&dst);
        p.extend_from_slice(&sport.to_be_bytes());
        p.extend_from_slice(&dport.to_be_bytes());
        p.extend_from_slice(&((8 + data.len()) as u16).to_be_bytes()); // udp len
        p.extend_from_slice(&[0, 0]); // udp checksum
        p.extend_from_slice(data);
        p
    }

    #[test]
    fn decodes_udp_in_ethernet_and_recovers_payload() {
        let marker = b"leak=490154203237518";
        let ip = ipv4_udp([10, 0, 0, 2], [203, 0, 113, 9], 53000, 53, marker);
        let frame = eth(&ip);
        let flow = decode_frame(&frame).expect("should decode");
        assert_eq!(flow.protocol, Protocol::Udp);
        assert_eq!(flow.src_ip, "10.0.0.2");
        assert_eq!(flow.dst_ip, "203.0.113.9");
        assert_eq!(flow.src_port, Some(53000));
        assert_eq!(flow.dst_port, Some(53));
        assert_eq!(flow.payload, marker.to_vec());
    }

    #[test]
    fn decodes_raw_ip_without_ethernet() {
        let marker = b"raw x";
        let ip = ipv4_udp([1, 1, 1, 1], [2, 2, 2, 2], 1, 2, marker);
        let flow = decode_frame(&ip).expect("raw ip should decode");
        assert_eq!(flow.payload, marker.to_vec());
    }

    #[test]
    fn drops_non_first_ip_fragment() {
        let ip = ipv4_udp([10, 0, 0, 2], [203, 0, 113, 9], 1, 2, b"abcdef");
        let mut frag = ip.clone();
        frag[6] = 0x00;
        frag[7] = 0x01; // fragment offset = 1 -> non-first fragment
        assert!(decode_frame(&frag).is_none());
    }

    #[test]
    fn garbage_returns_none() {
        assert!(decode_frame(&[]).is_none());
        assert!(decode_frame(&[0xff, 0xff, 0xff]).is_none());
        assert!(!looks_like_ip(&[0x08, 0x00]));
    }

    #[test]
    fn truncated_or_malformed_ihl_v4_never_panics() {
        // ihl nibble low (< 5 => hlen < 20) with a too-short buffer must not
        // index out of bounds (regression guard for the IPv4 parser).
        for len in 0..20usize {
            let mut f = vec![0u8; len];
            if !f.is_empty() {
                f[0] = 0x40 | (len as u8).min(15); // v4 + tiny/zero ihl
            }
            let _ = decode_frame(&f);
        }
        // Explicitly: hlen 0, only 1 byte of header present.
        let _ = decode_frame(&[0x40]);
    }

    #[test]
    fn decodes_ipv6_udp() {
        let mut src = [0u8; 16];
        src[15] = 2;
        let mut dst = [0u8; 16];
        dst[15] = 9;

        let udp_payload: &[u8] = b"ABCD";
        let udp_len = 8 + udp_payload.len(); // 12
        let mut p = vec![0u8; 40]; // base IPv6 header
        p[0] = 0x60; // version 6
        p[4] = ((udp_len >> 8) & 0xff) as u8;
        p[5] = (udp_len & 0xff) as u8; // payload length
        p[6] = 17; // next header = udp
        p[7] = 64; // hop limit
        p[8..24].copy_from_slice(&src);
        p[24..40].copy_from_slice(&dst);
        // UDP header + payload
        p.extend_from_slice(&5000u16.to_be_bytes());
        p.extend_from_slice(&53u16.to_be_bytes());
        p.extend_from_slice(&(udp_len as u16).to_be_bytes());
        p.extend_from_slice(&[0, 0]);
        p.extend_from_slice(udp_payload);

        let flow = decode_frame(&p).expect("ipv6 should decode");
        assert_eq!(flow.protocol, Protocol::Udp);
        assert_eq!(flow.src_port, Some(5000));
        assert_eq!(flow.dst_port, Some(53));
        assert_eq!(flow.payload, b"ABCD".to_vec());
        assert!(flow.dst_ip.contains(':'));
    }
}
