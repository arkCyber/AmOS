//! Deterministic secp256k1 keys + recoverable ECDSA + EVM address derivation.
//!
//! Everything here is derived purely from a 32-byte secret seed (see
//! [`SecretKey`]) which is used **directly** as the secp256k1 scalar — no
//! randomness is required and every output is reproducible. ECDSA nonces are
//! deterministic (RFC 6979) and signatures are emitted in canonical **low-s**
//! form, matching the wider Ethereum tooling.

use core::cmp::Ordering;

use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};

use crate::bytes;
use crate::error::{Error, Result};
use crate::hash::keccak256;

/// The secp256k1 group order `n` (32 bytes, big-endian).
pub const SECP256K1_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, //
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, //
    0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, //
    0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, //
];

/// A 32-byte big-endian unsigned comparison (`a` vs `b`).
fn cmp_be(a: &[u8; 32], b: &[u8; 32]) -> Ordering {
    a.iter().cmp(b.iter())
}

/// `value` right-shifted by one bit (big-endian 32-byte). Used to get `n/2`.
fn shr1(value: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut carry = 0u8;
    for i in 0..32 {
        let byte = value[i];
        out[i] = (byte >> 1) | (carry << 7);
        carry = byte & 1;
    }
    out
}

/// Modular negation `(n - value) mod n` for a `value < n`.
fn neg_mod_n(value: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0u8;
    for i in (0..32).rev() {
        let n = SECP256K1_ORDER[i] as i16;
        let v = value[i] as i16;
        let mut diff = n - v - borrow as i16;
        if diff < 0 {
            diff += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[i] = diff as u8;
    }
    out
}

/// Whether `s` is a "high" ECDSA `s` value (i.e. `> n/2`). Canonical low-s
/// signatures require normalising these (flipping the recovery parity).
fn is_high_s(s: &[u8; 32]) -> bool {
    let half = shr1(&SECP256K1_ORDER);
    cmp_be(s, &half) == Ordering::Greater
}

/// A secp256k1 secret key. Construction is deterministic from a seed.
#[derive(Clone)]
pub struct SecretKey {
    key: SigningKey,
}

impl SecretKey {
    /// Build a secret key deterministically from a 32-byte seed.
    ///
    /// The 32 bytes are used **directly** as the secp256k1 secret scalar (the
    /// same way Ed25519 treats a 32-byte seed, and the way an existing EVM
    /// private key is carried). A random 32-byte seed is a valid scalar with
    /// overwhelming probability (`< n`, non-zero); one that is out of range is
    /// rejected with [`Error::InvalidSecret`] — the entropy seam means a caller
    /// should re-roll rather than silently map to a different key.
    pub fn from_seed(seed: [u8; 32]) -> Result<Self> {
        let is_zero = !seed.iter().any(|&b| b != 0);
        let in_range = cmp_be(&seed, &SECP256K1_ORDER) == Ordering::Less;
        if is_zero || !in_range {
            return Err(Error::InvalidSecret);
        }
        SigningKey::from_slice(&seed)
            .map(|key| Self { key })
            .map_err(|_| Error::InvalidSecret)
    }

    /// Import an existing EVM private key (the 32-byte secret scalar).
    ///
    /// Equivalent to [`from_seed`](Self::from_seed); named so that code reading
    /// a wallet export / backup is explicit about what the bytes are.
    pub fn from_private_key(bytes: [u8; 32]) -> Result<Self> {
        Self::from_seed(bytes)
    }

    /// The 32-byte secret scalar (`to_bytes` form), for export/backup. The
    /// secret never leaves this key except here — treat it as credentials.
    pub fn to_secret_bytes(&self) -> [u8; 32] {
        let raw = self.key.to_bytes();
        let mut out = [0u8; 32];
        out.copy_from_slice(&raw);
        out
    }

    /// The corresponding public key.
    pub fn public_key(&self) -> PublicKey {
        PublicKey {
            key: *self.key.verifying_key(),
        }
    }

    /// Sign a 32-byte pre-hash with recoverable ECDSA, returning a canonical
    /// low-s `(r, s, v)` where `v ∈ {27, 28}` (Ethereum legacy encoding).
    pub(crate) fn sign_prehash_recoverable(
        &self,
        prehash: &[u8; 32],
    ) -> Result<RecoverableSignature> {
        let prehash_arr = k256::FieldBytes::clone_from_slice(prehash);
        let (signature, recovery_id) = self
            .key
            .sign_prehash_recoverable(&prehash_arr)
            .map_err(|_| Error::InvalidSecret)?;

        // Recovery id from k256 is 0..=3. For signatures we produce, the
        // x-overflow bits (2/3) cannot occur (probability ~2^-128), so the
        // low bit is the y-parity we need for Ethereum's legacy v = 27/28.
        let mut parity = recovery_id.to_byte() & 1;

        // Canonicalise to low-s (matching ethereumjs / ethers). If we flip s we
        // must also flip the parity so the same public key is recovered.
        let raw = signature.to_bytes();
        let mut s_bytes = [0u8; 32];
        s_bytes.copy_from_slice(&raw[32..64]);
        let mut s = s_bytes;
        if is_high_s(&s) {
            s = neg_mod_n(&s);
            parity ^= 1;
        }
        let mut r = [0u8; 32];
        r.copy_from_slice(&raw[..32]);

        Ok(RecoverableSignature {
            r,
            s,
            v: 27 + parity,
        })
    }
}
/// A secp256k1 public key.
#[derive(Clone)]
pub struct PublicKey {
    key: VerifyingKey,
}

impl PublicKey {
    /// The EVM address (last 20 bytes of `keccak256(uncompressed[1..])`).
    pub fn address(&self) -> [u8; 20] {
        let uncompressed = self.key.to_encoded_point(false);
        let hash = keccak256(&uncompressed.as_bytes()[1..]);
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&hash[12..32]);
        addr
    }

    /// The EVM address as lowercase `0x…` hex.
    pub fn address_hex(&self) -> String {
        bytes::encode_hex0x(&self.address())
    }

    /// Compressed SEC1 encoding (33 bytes, starts with `02`/`03`). This is the
    /// form used in `did:key` for the `secp256k1-pub` multicodec.
    pub fn to_compressed_bytes(&self) -> [u8; 33] {
        let mut out = [0u8; 33];
        out.copy_from_slice(self.key.to_encoded_point(true).as_bytes());
        out
    }

    /// Uncompressed SEC1 encoding (65 bytes, starts with `0x04`).
    pub fn to_uncompressed_bytes(&self) -> [u8; 65] {
        let mut out = [0u8; 65];
        out.copy_from_slice(self.key.to_encoded_point(false).as_bytes());
        out
    }

    /// Build a public key from a SEC1-encoded point (33-byte compressed or
    /// 65-byte uncompressed, with the `02`/`03`/`04` prefix).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        VerifyingKey::from_sec1_bytes(bytes)
            .map(|key| Self { key })
            .map_err(|_| Error::InvalidPublicKey)
    }

    /// Recover the signer's public key from a 32-byte pre-hash + signature.
    pub fn recover_from_prehash(prehash: &[u8; 32], sig: &RecoverableSignature) -> Result<Self> {
        if sig.v != 27 && sig.v != 28 {
            return Err(Error::InvalidSignature);
        }
        let recovery_id = RecoveryId::from_byte(sig.v - 27).ok_or(Error::InvalidSignature)?;
        let signature = Signature::from_slice(&[sig.r.as_slice(), sig.s.as_slice()].concat())
            .map_err(|_| Error::InvalidSignature)?;
        let prehash_arr = k256::FieldBytes::clone_from_slice(prehash);
        let key = VerifyingKey::recover_from_prehash(&prehash_arr, &signature, recovery_id)
            .map_err(|_| Error::InvalidSignature)?;
        Ok(Self { key })
    }
}

/// A canonical Ethereum `(r, s, v)` signature with `v ∈ {27, 28}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoverableSignature {
    /// Big-endian `r`.
    pub r: [u8; 32],
    /// Canonical (low-s) big-endian `s`.
    pub s: [u8; 32],
    /// Recovery id as Ethereum legacy `v` (`27` or `28`).
    pub v: u8,
}

impl RecoverableSignature {
    /// Serialise to the 65-byte `r ‖ s ‖ v` form.
    pub fn to_bytes(&self) -> [u8; 65] {
        let mut out = [0u8; 65];
        out[..32].copy_from_slice(&self.r);
        out[32..64].copy_from_slice(&self.s);
        out[64] = self.v;
        out
    }

    /// Parse from the 65-byte `r ‖ s ‖ v` form (`v` must be `27`/`28`).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != 65 || (bytes[64] != 27 && bytes[64] != 28) {
            return Err(Error::InvalidSignature);
        }
        let mut r = [0u8; 32];
        let mut s = [0u8; 32];
        r.copy_from_slice(&bytes[..32]);
        s.copy_from_slice(&bytes[32..64]);
        if is_high_s(&s) {
            return Err(Error::InvalidSignature);
        }
        Ok(Self { r, s, v: bytes[64] })
    }

    /// The `0x…` hex of the 65-byte form.
    pub fn to_hex(&self) -> String {
        bytes::encode_hex0x(&self.to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The canonical reference: private key scalar `1` derives the well-known
    /// address `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`.
    #[test]
    fn scalar_one_known_address() {
        let mut seed = [0u8; 32];
        seed[31] = 1;
        let key = SecretKey::from_seed(seed).unwrap();
        assert_eq!(
            key.public_key().address_hex().to_lowercase(),
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn deterministic_from_seed() {
        let a = SecretKey::from_seed([7u8; 32]).unwrap();
        let b = SecretKey::from_seed([7u8; 32]).unwrap();
        let c = SecretKey::from_seed([8u8; 32]).unwrap();
        assert_eq!(a.public_key().address(), b.public_key().address());
        assert_ne!(a.public_key().address(), c.public_key().address());
    }

    #[test]
    fn recover_roundtrip_and_low_s() {
        let key = SecretKey::from_seed([42u8; 32]).unwrap();
        let digest = keccak256(b"round-trip message");
        let sig = key.sign_prehash_recoverable(&digest).unwrap();
        assert!(sig.v == 27 || sig.v == 28);
        // Canonical low-s: s must be <= n/2.
        assert!(!is_high_s(&sig.s));

        let recovered = PublicKey::recover_from_prehash(&digest, &sig).unwrap();
        assert_eq!(recovered.address(), key.public_key().address());

        // A different digest must NOT recover to the same key.
        let other = PublicKey::recover_from_prehash(&keccak256(b"tampered"), &sig).unwrap();
        assert_ne!(other.address(), key.public_key().address());
    }

    #[test]
    fn signature_bytes_roundtrip() {
        let key = SecretKey::from_seed([123u8; 32]).unwrap();
        let digest = keccak256(b"sig serialization");
        let sig = key.sign_prehash_recoverable(&digest).unwrap();
        let bytes = sig.to_bytes();
        assert_eq!(bytes.len(), 65);
        let parsed = RecoverableSignature::from_bytes(&bytes).unwrap();
        assert_eq!(parsed, sig);
    }

    #[test]
    fn malformed_signature_rejected() {
        assert!(RecoverableSignature::from_bytes(&[0u8; 64]).is_err()); // too short
        let mut bad = [0u8; 65];
        bad[64] = 29; // invalid v
        assert!(RecoverableSignature::from_bytes(&bad).is_err());
        let mut high = [0u8; 65];
        high[64] = 27;
        high[32..64].copy_from_slice(&[0xff; 32]); // high s -> non-canonical
        assert!(RecoverableSignature::from_bytes(&high).is_err());
    }

    /// Out-of-range (≥ n) and zero seeds are not valid scalars and must be
    /// rejected, never silently mapped to a different key.
    #[test]
    fn invalid_seed_rejected() {
        assert!(SecretKey::from_seed([0u8; 32]).is_err()); // zero scalar
        assert!(SecretKey::from_seed([0xffu8; 32]).is_err()); // >= group order
                                                              // Import alias has the same behaviour.
        assert!(SecretKey::from_private_key([0xffu8; 32]).is_err());
    }

    #[test]
    fn secret_bytes_roundtrip() {
        let key = SecretKey::from_seed([0xabu8; 32]).unwrap();
        let scalar = key.to_secret_bytes();
        let again = SecretKey::from_private_key(scalar).unwrap();
        assert_eq!(again.public_key().address(), key.public_key().address());
        // Deterministic export equals the original seed.
        assert_eq!(scalar, [0xabu8; 32]);
    }
}
