//! Small hex helpers shared across the crate.
//!
//! Kept local and dependency-free (matching the rest of Amos, which hand-rolls
//! hex rather than pulling a crate) and deliberately *total* where reasonable:
//! decoding returns `None` for malformed input so callers never have to panic.

/// Encode bytes as lowercase hex (no `0x` prefix).
pub fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Encode bytes as lowercase hex with a `0x` prefix.
pub fn encode_hex0x(bytes: &[u8]) -> String {
    format!("0x{}", encode_hex(bytes))
}

/// Decode a hex string (even length, hex digits only). A leading `0x`/`0X` is
/// tolerated. Returns `None` on malformed input.
pub fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let s = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    if s.len() % 2 != 0 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let val = |c: u8| -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => 0,
        }
    };
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    for i in (0..b.len()).step_by(2) {
        out.push((val(b[i]) << 4) | val(b[i + 1]));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_prefix() {
        let raw = [0xde_u8, 0xad, 0xbe, 0xef];
        assert_eq!(encode_hex(&raw), "deadbeef");
        assert_eq!(encode_hex0x(&raw), "0xdeadbeef");
        assert_eq!(decode_hex("0xdeadbeef").unwrap(), raw);
        assert_eq!(decode_hex("DEADBEEF").unwrap(), raw);
    }

    #[test]
    fn malformed_is_none() {
        assert!(decode_hex("xyz").is_none());
        assert!(decode_hex("abc").is_none()); // odd length
        assert!(decode_hex("").is_some()); // empty is valid (empty bytes)
        assert!(decode_hex("0x").unwrap().is_empty());
    }
}
