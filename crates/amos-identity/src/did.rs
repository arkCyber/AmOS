//! W3C [`did:key`] encoding and parsing for the two supported curves.
//!
//! A `did:key` is `did:key:<multibase>`, where `<multibase>` is the
//! **base58btc** (`z` prefix) encoding of a **multicodec** value = the two-byte
//! curve prefix followed by the raw public key:
//!
//! * Ed25519 → multicodec `0xed01` ‖ 32-byte public key
//! * secp256k1 → multicodec `0xe701` ‖ 33-byte compressed public key
//!
//! [did:key]: https://w3c-ccg.github.io/did-method-key/

use bs58;

use crate::error::{Error, Result};
use crate::key::Curve;

/// The method identifier for `did:key`.
pub const METHOD: &str = "key";

/// Build a `did:key` string from a curve and its raw public key bytes.
///
/// `pubkey` must be exactly the expected length for the curve (Ed25519: 32,
/// secp256k1 compressed: 33). Returns [`Error::InvalidDid`] otherwise.
pub fn did_key_from_public_key(curve: Curve, pubkey: &[u8]) -> Result<String> {
    if pubkey.len() != curve.public_key_len() {
        return Err(Error::InvalidDid(format!(
            "public key for {curve:?} must be {} bytes, got {}",
            curve.public_key_len(),
            pubkey.len()
        )));
    }
    let prefix = curve.multicodec();
    let mut payload = Vec::with_capacity(2 + pubkey.len());
    payload.extend_from_slice(&prefix);
    payload.extend_from_slice(pubkey);
    let encoded = bs58::encode(payload).into_string();
    Ok(format!("did:key:z{encoded}"))
}

/// Parse a `did:key:…` string back into `(curve, raw public key bytes)`.
pub fn parse_did_key(did: &str) -> Result<(Curve, Vec<u8>)> {
    let rest = did
        .strip_prefix("did:key:z")
        .ok_or_else(|| Error::InvalidDid(format!("{did:?} is not did:key:z…")))?;
    if rest.is_empty() {
        return Err(Error::InvalidDid("empty payload".into()));
    }
    let decoded = bs58::decode(rest)
        .into_vec()
        .map_err(|e| Error::Decode(e.to_string()))?;
    if decoded.len() < 3 {
        return Err(Error::InvalidDid(
            "payload too short for a multicodec".into(),
        ));
    }
    let curve = Curve::from_multicodec([decoded[0], decoded[1]])?;
    let pubkey = decoded[2..].to_vec();
    if pubkey.len() != curve.public_key_len() {
        return Err(Error::InvalidDid(format!(
            "{curve:?} did:key must carry {} public-key bytes, got {}",
            curve.public_key_len(),
            pubkey.len()
        )));
    }
    Ok((curve, pubkey))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::Ed25519Key;

    #[test]
    fn roundtrip_ed25519() {
        let key = Ed25519Key::from_seed([1u8; 32]);
        let did = did_key_from_public_key(Curve::Ed25519, &key.public_bytes()).unwrap();
        assert!(did.starts_with("did:key:z6Mk"));
        let (curve, pubkey) = parse_did_key(&did).unwrap();
        assert_eq!(curve, Curve::Ed25519);
        assert_eq!(pubkey, key.public_bytes());
    }

    /// The encoded payload decodes back to the exact 34 bytes regardless of
    /// the exact character count of the base58btc encoding.
    #[test]
    fn payload_roundtrips_exactly() {
        let key = Ed25519Key::from_seed([7u8; 32]);
        let did = did_key_from_public_key(Curve::Ed25519, &key.public_bytes()).unwrap();
        let payload = &did["did:key:z".len()..];
        let mut expected = Vec::with_capacity(34);
        expected.extend_from_slice(&[0xed, 0x01]);
        expected.extend_from_slice(&key.public_bytes());
        assert_eq!(bs58::decode(payload).into_vec().unwrap(), expected);
    }

    #[test]
    fn wrong_length_rejected() {
        assert!(did_key_from_public_key(Curve::Ed25519, &[0u8; 31]).is_err());
        assert!(did_key_from_public_key(Curve::Secp256k1, &[0u8; 32]).is_err());
    }

    #[test]
    fn garbage_rejected() {
        assert!(parse_did_key("did:key:z!!!").is_err());
        assert!(parse_did_key("did:web:example.com").is_err());
        assert!(parse_did_key("did:key:").is_err());
    }
}
