//! Pure payload-scanning heuristic.
//!
//! Honest scope (mirrors `docs/anti-telemetry-egress-guard.md` §3.2): grepping
//! outbound payloads for a plaintext device-bound token is a **brittle,
//! low-confidence** heuristic — encrypted flows never expose the plaintext and
//! naive scanning over-reports. This module therefore exposes a deterministic,
//! pure [`scan_payload`] plus an explicit [`Confidence`] label, so a caller can
//! surface a hit without ever mistaking a substring match for *confirmed*
//! exfiltration.

use crate::error::Result;
use crate::identifier::{Identifier, IdentifierKind};

/// Below this many bytes a needle is too ambiguous to report at all.
pub const MIN_NEEDLE_LEN: usize = 3;

/// How much evidence a single hit carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Confidence {
    /// A very short / generic token — easy to find by chance.
    Low,
    /// A moderately specific token.
    Medium,
    /// A long, self-describing token (e.g. a full 15-digit IMEI).
    High,
}

impl Confidence {
    /// Stable machine key for logs / a future wire mapping.
    pub fn as_str(self) -> &'static str {
        match self {
            Confidence::Low => "low",
            Confidence::Medium => "medium",
            Confidence::High => "high",
        }
    }
}

/// Label evidence from the specificity of the needle and how often it repeated.
pub fn confidence_for(needle_len: usize, occurrences: usize) -> Confidence {
    if needle_len >= 15 {
        Confidence::High
    } else if needle_len >= 8 || occurrences > 1 {
        Confidence::Medium
    } else {
        Confidence::Low
    }
}

/// One identifier matched inside a payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanHit {
    /// Which identifier kind was found.
    pub kind: IdentifierKind,
    /// How many (non-overlapping) times the token appeared.
    pub occurrences: usize,
    /// Length of the matched token (used to grade [`Confidence`]).
    pub needle_len: usize,
}

/// Count non-overlapping occurrences of `needle` within `hay`.
fn count_occurrences(needle: &[u8], hay: &[u8]) -> usize {
    if needle.is_empty() || needle.len() > hay.len() {
        return 0;
    }
    let mut n = 0;
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        if &hay[i..i + needle.len()] == needle {
            n += 1;
            i += needle.len(); // advance past a match (non-overlapping)
        } else {
            i += 1;
        }
    }
    n
}

/// Scan one payload for every configured identifier. Returns at most one hit
/// per kind, in declaration order. Needles shorter than [`MIN_NEEDLE_LEN`] or
/// longer than the payload are ignored.
pub fn scan_payload(ids: &[Identifier], payload: &[u8]) -> Vec<ScanHit> {
    let mut out: Vec<ScanHit> = Vec::new();
    for id in ids {
        if id.value.len() < MIN_NEEDLE_LEN || id.value.len() > payload.len() {
            continue;
        }
        let n = count_occurrences(&id.value, payload);
        if n > 0 {
            out.push(ScanHit {
                kind: id.kind,
                occurrences: n,
                needle_len: id.value.len(),
            });
        }
    }
    out
}

/// Convenience for callers that want a typed result wrapper. Parses nothing;
/// present so audit paths have a single well-typed entry point.
pub fn scan(ids: &[Identifier], payload: &[u8]) -> Result<Vec<ScanHit>> {
    Ok(scan_payload(ids, payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identifier::Identifier;

    fn imei(value: &str) -> Identifier {
        Identifier::ascii(IdentifierKind::Imei, value).unwrap()
    }

    #[test]
    fn finds_full_imei_once() {
        let ids = [imei("490154203237518")];
        let payload = b"hi header 490154203237518 trailer";
        let hits = scan_payload(&ids, payload);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, IdentifierKind::Imei);
        assert_eq!(hits[0].occurrences, 1);
        assert_eq!(hits[0].needle_len, 15);
        assert_eq!(
            confidence_for(hits[0].needle_len, hits[0].occurrences),
            Confidence::High
        );
    }

    #[test]
    fn counts_multiple_non_overlapping_occurrences() {
        let ids = [Identifier::ascii(IdentifierKind::Serial, "SN-12345").unwrap()];
        let payload = b"SN-12345 .. SN-12345"; // len 8+ -> medium, occurrences 2
        let hits = scan_payload(&ids, payload);
        assert_eq!(hits[0].occurrences, 2);
    }

    #[test]
    fn ignores_short_and_oversized_needles() {
        let ids = [
            Identifier::ascii(IdentifierKind::CellId, "ab").unwrap(), // too short
            Identifier::ascii(IdentifierKind::Imei, "x".repeat(50).as_str()).unwrap(), // too long
        ];
        let payload = b"ab abc";
        assert!(scan_payload(&ids, payload).is_empty());
    }

    #[test]
    fn scan_is_total_and_typed() {
        let ids = [imei("490154203237518")];
        let payload = b"abc 490154203237518 abc";
        assert_eq!(scan(&ids, payload).unwrap().len(), 1);
        assert_eq!(scan(&ids, b"nothing here").unwrap().len(), 0);
    }
}
