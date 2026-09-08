//! The pure decode → scan → signal glue, shared by the live capture loop.
//!
//! Keeping this in the default (pure-`std`) build means the exact composition a
//! real capture uses — [`crate::packet::decode_frame`] → [`crate::scanner`] →
//! [`EgressMatch`] — is host-unit-tested with crafted frames, without needing a
//! NIC. [`capture::run_blocking`] calls [`match_frame`] per frame.

use crate::identifier::Identifier;
use crate::now_ms;
use crate::packet::decode_frame;
use crate::scanner::scan_payload;
use crate::signal::{Direction, EgressMatch};

/// Turn one raw frame into an [`EgressMatch`] if its payload contained any
/// watch-list identifier; otherwise `None`. Direction is [`Direction::Unknown`]
/// because a raw datalink capture carries no direction metadata.
pub fn match_frame(iface: &str, ids: &[Identifier], frame: &[u8]) -> Option<EgressMatch> {
    let flow = decode_frame(frame)?;
    let hits = scan_payload(ids, &flow.payload);
    if hits.is_empty() {
        return None;
    }
    let payload_bytes = flow.payload.len();
    Some(EgressMatch::from_hits(
        now_ms(),
        iface,
        Direction::Unknown,
        flow.src_ip,
        flow.src_port,
        flow.dst_ip,
        flow.dst_port,
        flow.protocol,
        hits,
        payload_bytes,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identifier::{Identifier, IdentifierKind};
    use crate::signal::Severity;

    fn eth(payload: &[u8]) -> Vec<u8> {
        let mut f = vec![0u8; 12];
        f.extend_from_slice(&[0x08, 0x00]);
        f.extend_from_slice(payload);
        f
    }

    fn udp_frame(data: &[u8]) -> Vec<u8> {
        // IPv4 + UDP + payload, matching the test builder in packet.rs.
        let mut p = vec![0x45u8];
        p.push(0);
        p.extend_from_slice(&((20 + 8 + data.len()) as u16).to_be_bytes());
        p.extend_from_slice(&[0, 0]);
        p.extend_from_slice(&[0, 0]);
        p.push(64);
        p.push(17);
        p.extend_from_slice(&[0, 0]);
        p.extend_from_slice(&[10, 0, 0, 2]);
        p.extend_from_slice(&[203, 0, 113, 9]);
        p.extend_from_slice(&53000u16.to_be_bytes());
        p.extend_from_slice(&53u16.to_be_bytes());
        p.extend_from_slice(&((8 + data.len()) as u16).to_be_bytes());
        p.extend_from_slice(&[0, 0]);
        p.extend_from_slice(data);
        eth(&p)
    }

    #[test]
    fn produces_high_severity_match_on_hit() {
        let ids = [Identifier::ascii(IdentifierKind::Imei, "490154203237518").unwrap()];
        let m = match_frame("rmnet_data0", &ids, &udp_frame(b"leak 490154203237518"))
            .expect("should match");
        assert_eq!(m.iface, "rmnet_data0");
        assert_eq!(m.severity, Severity::High);
        assert_eq!(m.hits[0].kind, IdentifierKind::Imei);
        assert_eq!(m.dst_port, Some(53));
        assert_eq!(m.protocol.as_str(), "udp");
    }

    #[test]
    fn none_when_no_hit_or_undecodable() {
        let ids = [Identifier::ascii(IdentifierKind::Imei, "490154203237518").unwrap()];
        assert!(match_frame("en0", &ids, &udp_frame(b"no secrets")).is_none());
        assert!(match_frame("en0", &ids, b"").is_none());
        assert!(match_frame("en0", &ids, &[0xff, 0xff]).is_none());
    }
}
