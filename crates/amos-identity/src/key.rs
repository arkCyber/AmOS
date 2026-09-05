//! Key curves, the Ed25519 key wrapper, and the unified [`IdentityKey`].

use ed25519_dalek::{Signer, SigningKey};

use crate::did;
use crate::error::{Error, Result};

/// The public-key curves this crate can represent. These are the two that the
/// wider Web3/DID ecosystem actually uses and that have `did:key` multicodecs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Curve {
    /// Ed25519 (raw 32-byte public keys; `did:key` multicodec `0xed01`).
    Ed25519,
    /// secp256k1 (33-byte compressed public keys; `0xe701`).
    Secp256k1,
}

impl Curve {
    /// The two-byte `did:key` multicodec prefix for this curve.
    pub fn multicodec(self) -> [u8; 2] {
        match self {
            Curve::Ed25519 => [0xed, 0x01],
            Curve::Secp256k1 => [0xe7, 0x01],
        }
    }

    /// Map a two-byte multicodec prefix back to a curve.
    pub fn from_multicodec(prefix: [u8; 2]) -> Result<Self> {
        match prefix {
            [0xed, 0x01] => Ok(Curve::Ed25519),
            [0xe7, 0x01] => Ok(Curve::Secp256k1),
            _ => Err(Error::UnsupportedCurve),
        }
    }

    /// The expected raw public-key byte length (Ed25519 32, secp compressed 33).
    pub fn public_key_len(self) -> usize {
        match self {
            Curve::Ed25519 => 32,
            Curve::Secp256k1 => 33,
        }
    }
}

/// An Ed25519 keypair held by seed (the 32-byte secret seed, matching how the
/// rest of Amos treats Ed25519 — e.g. `amos-appstore`'s `DeveloperKey`).
#[derive(Clone)]
pub struct Ed25519Key {
    seed: [u8; 32],
}

impl Ed25519Key {
    /// Build from a 32-byte seed. Any 32 bytes are a valid Ed25519 seed.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self { seed }
    }

    /// The 32-byte secret seed, for export / at-rest wrapping.
    pub fn to_seed(&self) -> [u8; 32] {
        self.seed
    }

    fn signing_key(&self) -> SigningKey {
        SigningKey::from_bytes(&self.seed)
    }

    /// The 32-byte Ed25519 public key.
    pub fn public_bytes(&self) -> [u8; 32] {
        self.signing_key().verifying_key().to_bytes()
    }

    /// Sign `msg`, returning the 64-byte Ed25519 signature.
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing_key().sign(msg).to_bytes()
    }
}

/// A unified deterministic identity that is either an Ed25519 or a secp256k1
/// key, enough to derive a [`did::did_key_from_public_key`] and to sign.
#[derive(Clone)]
pub enum IdentityKey {
    /// Ed25519 (native to this crate).
    Ed25519(Ed25519Key),
    /// secp256k1 (owned by `amos-web3`).
    Secp256k1(amos_web3::secp::SecretKey),
}

impl IdentityKey {
    /// Build an identity deterministically from a seed for the given curve.
    ///
    /// # Examples
    /// ```
    /// use amos_identity::{Curve, IdentityKey};
    /// let id = IdentityKey::from_seed(Curve::Ed25519, [1u8; 32]).unwrap();
    /// assert!(id.did().unwrap().starts_with("did:key:z"));
    /// ```
    pub fn from_seed(curve: Curve, seed: [u8; 32]) -> Result<Self> {
        match curve {
            Curve::Ed25519 => Ok(IdentityKey::Ed25519(Ed25519Key::from_seed(seed))),
            Curve::Secp256k1 => Ok(IdentityKey::Secp256k1(
                amos_web3::secp::SecretKey::from_seed(seed)?,
            )),
        }
    }

    /// The curve of this identity.
    pub fn curve(&self) -> Curve {
        match self {
            IdentityKey::Ed25519(_) => Curve::Ed25519,
            IdentityKey::Secp256k1(_) => Curve::Secp256k1,
        }
    }

    /// Export the 32-byte secret seed / scalar (the value a keystore stores).
    pub fn to_seed(&self) -> [u8; 32] {
        match self {
            IdentityKey::Ed25519(k) => k.to_seed(),
            IdentityKey::Secp256k1(k) => k.to_secret_bytes(),
        }
    }

    /// Raw public-key bytes in the form used by `did:key`: Ed25519 → 32 bytes,
    /// secp256k1 → 33-byte compressed SEC1.
    pub fn public_key_bytes(&self) -> Vec<u8> {
        match self {
            IdentityKey::Ed25519(k) => k.public_bytes().to_vec(),
            IdentityKey::Secp256k1(k) => k.public_key().to_compressed_bytes().to_vec(),
        }
    }

    /// The `did:key` string for this identity.
    pub fn did(&self) -> Result<String> {
        did::did_key_from_public_key(self.curve(), &self.public_key_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ed25519_roundtrip_and_deterministic() {
        let a = Ed25519Key::from_seed([3u8; 32]);
        let b = Ed25519Key::from_seed([3u8; 32]);
        assert_eq!(a.public_bytes(), b.public_bytes());
        assert_eq!(a.public_bytes().len(), 32);
        assert_eq!(a.to_seed(), [3u8; 32]);
    }

    #[test]
    fn identity_key_builds_from_seed_per_curve() {
        for curve in [Curve::Ed25519, Curve::Secp256k1] {
            let key = IdentityKey::from_seed(curve, [9u8; 32]).unwrap();
            assert_eq!(key.curve(), curve);
            assert_eq!(key.public_key_bytes().len(), curve.public_key_len());
            assert_eq!(key.to_seed(), [9u8; 32]);
            let did_str = key.did().unwrap();
            assert!(did_str.starts_with("did:key:z"));
            assert_eq!(did::parse_did_key(&did_str).unwrap().0, curve);
        }
    }

    #[test]
    fn secp_curve_multicodec_mapping() {
        assert_eq!(Curve::Ed25519.multicodec(), [0xed, 0x01]);
        assert_eq!(Curve::Secp256k1.multicodec(), [0xe7, 0x01]);
        assert_eq!(
            Curve::from_multicodec([0xed, 0x01]).unwrap(),
            Curve::Ed25519
        );
        assert_eq!(
            Curve::from_multicodec([0xe7, 0x01]).unwrap(),
            Curve::Secp256k1
        );
        assert_eq!(
            Curve::from_multicodec([0x00, 0x00]).unwrap_err(),
            Error::UnsupportedCurve
        );
    }
}
