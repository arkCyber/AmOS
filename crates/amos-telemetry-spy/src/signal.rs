//! The audit **signal** produced when a device-bound identifier is seen.
//!
//! An [`EgressMatch`] is the payload the daemon / System UI should react to: it
//! carries transport metadata, which identifier leaked, how much evidence there
//! was (occurrences), and a graded [`Confidence`]. The [`Severity`] is always
//! [`Severity::High`] when a hit is emitted, but confidence keeps the report
//! honest — a bare substring is never dressed up as a confirmed leak.

use crate::identifier::IdentifierKind;
use crate::scanner::{confidence_for, Confidence, ScanHit};

/// The transport a hit was observed on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    /// TCP.
    Tcp,
    /// UDP.
    Udp,
    /// ICMP / ICMPv6.
    Icmp,
    /// Anything else we could not classify.
    Other,
}

impl Protocol {
    /// Stable machine key.
    pub fn as_str(self) -> &'static str {
        match self {
            Protocol::Tcp => "tcp",
            Protocol::Udp => "udp",
            Protocol::Icmp => "icmp",
            Protocol::Other => "other",
        }
    }
}

/// Data-plane direction. Raw datalink capture cannot tell direction (honest
/// limitation — see `capture`), so live frames surface as [`Direction::Unknown`]
/// unless a richer backend (VpnService / nftables) supplies it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// Leaving the device (only knowable from a socket-aware backend).
    Outbound,
    /// Arriving at the device.
    Inbound,
    /// Unknown from the available capture metadata.
    Unknown,
}

impl Direction {
    /// Stable machine key.
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Outbound => "outbound",
            Direction::Inbound => "inbound",
            Direction::Unknown => "unknown",
        }
    }
}

/// Severity is deliberately coarse. The spy only emits on a positive match.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    /// High — a device-bound identifier appeared in an outbound payload.
    High,
}

impl Severity {
    /// Stable machine key.
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::High => "high",
        }
    }
}

/// One graded identifier hit folded into an [`EgressMatch`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentifierEvidence {
    /// Which identifier kind leaked.
    pub kind: IdentifierKind,
    /// Number of (non-overlapping) occurrences seen.
    pub occurrences: usize,
    /// How much evidence this specific hit carries.
    pub confidence: Confidence,
}

impl IdentifierEvidence {
    /// Build from a scanner hit, grading confidence from needle length.
    pub fn from_hit(hit: &ScanHit) -> IdentifierEvidence {
        IdentifierEvidence {
            kind: hit.kind,
            occurrences: hit.occurrences,
            confidence: confidence_for(hit.needle_len, hit.occurrences),
        }
    }
}

/// A complete audit event: one frame whose payload contained a watch-list token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EgressMatch {
    /// Wall-clock milliseconds (UTC) when the frame was observed.
    pub ts_ms: u64,
    /// The interface the frame was captured on (e.g. `rmnet_data0`).
    pub iface: String,
    /// Data-plane direction (see [`Direction`] — raw capture is usually unknown).
    pub direction: Direction,
    /// Source IP text form.
    pub src_ip: String,
    /// Source port, when the transport carried one.
    pub src_port: Option<u16>,
    /// Destination IP text form.
    pub dst_ip: String,
    /// Destination port, when the transport carried one.
    pub dst_port: Option<u16>,
    /// Transport protocol.
    pub protocol: Protocol,
    /// The graded identifier hits.
    pub hits: Vec<IdentifierEvidence>,
    /// Size of the payload window that was scanned.
    pub payload_bytes: usize,
    /// Always [`Severity::High`] — a hit was required to build this event.
    pub severity: Severity,
    /// The strongest evidence grade across all hits.
    pub confidence: Confidence,
}

impl EgressMatch {
    /// Assemble a full event from decoded flow metadata and scanner hits.
    #[allow(clippy::too_many_arguments)]
    pub fn from_hits(
        ts_ms: u64,
        iface: impl Into<String>,
        direction: Direction,
        src_ip: impl Into<String>,
        src_port: Option<u16>,
        dst_ip: impl Into<String>,
        dst_port: Option<u16>,
        protocol: Protocol,
        hits: Vec<ScanHit>,
        payload_bytes: usize,
    ) -> EgressMatch {
        let evidence: Vec<IdentifierEvidence> =
            hits.iter().map(IdentifierEvidence::from_hit).collect();
        let confidence = evidence
            .iter()
            .map(|e| e.confidence)
            .max()
            .unwrap_or(Confidence::Low);
        EgressMatch {
            ts_ms,
            iface: iface.into(),
            direction,
            src_ip: src_ip.into(),
            src_port,
            dst_ip: dst_ip.into(),
            dst_port,
            protocol,
            hits: evidence,
            payload_bytes,
            severity: Severity::High,
            confidence,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identifier::Identifier;
    use crate::scanner::scan_payload;

    fn sample_hit(kind: IdentifierKind, len: usize, occurrences: usize) -> ScanHit {
        ScanHit {
            kind,
            occurrences,
            needle_len: len,
        }
    }

    #[test]
    fn from_hits_grades_and_marks_high() {
        let m = EgressMatch::from_hits(
            1,
            "rmnet_data0",
            Direction::Unknown,
            "10.0.0.2",
            Some(53000),
            "203.0.113.9",
            Some(53),
            Protocol::Udp,
            vec![sample_hit(IdentifierKind::Imei, 15, 1)],
            40,
        );
        assert_eq!(m.severity, Severity::High);
        assert_eq!(m.confidence, Confidence::High);
        assert_eq!(m.direction.as_str(), "unknown");
        assert_eq!(m.dst_port, Some(53));
        assert_eq!(m.hits[0].kind, IdentifierKind::Imei);
    }

    #[test]
    fn weakest_identifier_caps_confidence_low() {
        let m = EgressMatch::from_hits(
            1,
            "wlan0",
            Direction::Unknown,
            "10.0.0.2",
            None,
            "203.0.113.9",
            None,
            Protocol::Other,
            vec![sample_hit(IdentifierKind::CellId, 4, 1)],
            8,
        );
        assert_eq!(m.confidence, Confidence::Low);
    }

    #[test]
    fn protocol_severity_direction_keys_are_stable() {
        assert_eq!(Protocol::Udp.as_str(), "udp");
        assert_eq!(Severity::High.as_str(), "high");
        assert_eq!(Direction::Outbound.as_str(), "outbound");
        let m = EgressMatch::from_hits(
            1,
            "eth0",
            Direction::Outbound,
            "a",
            None,
            "b",
            None,
            Protocol::Tcp,
            vec![sample_hit(IdentifierKind::Serial, 8, 1)],
            1,
        );
        assert_eq!(m.direction, Direction::Outbound);
        // end-to-end scanner -> builder stays coherent
        let ids = [Identifier::ascii(IdentifierKind::Serial, "SERIAL-12345").unwrap()];
        let payload = b"x SERIAL-12345 y";
        let hits = scan_payload(&ids, payload);
        assert_eq!(hits.len(), 1);
        let e2e = EgressMatch::from_hits(
            2,
            "eth0",
            Direction::Outbound,
            "1.1.1.1",
            Some(1),
            "2.2.2.2",
            Some(2),
            Protocol::Udp,
            hits,
            5,
        );
        assert_eq!(e2e.hits[0].kind, IdentifierKind::Serial);
        assert_eq!(e2e.confidence, Confidence::Medium); // needle len 13
    }
}
