//! Keccak-256 hashing used by the whole EVM stack.

use sha3::{Digest, Keccak256};

/// The Keccak-256 hash used by Ethereum (note: the `sha3` crate's `Keccak256`
/// is Keccak-256 as Ethereum defines it, *not* the FIPS SHA3-256 variant).
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    let out = hasher.finalize();
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&out);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A well-known Keccak-256 test vector (empty input).
    #[test]
    fn empty_input_vector() {
        assert_eq!(
            keccak256(b"").to_vec(),
            hex_decode("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        );
    }

    /// `keccak256("abc")` test vector.
    #[test]
    fn abc_vector() {
        assert_eq!(
            keccak256(b"abc").to_vec(),
            hex_decode("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
        );
    }

    fn hex_decode(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
}
