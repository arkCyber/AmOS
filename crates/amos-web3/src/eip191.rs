//! [EIP-191] `personal_sign`-style message signing and verification.
//!
//! The digest is defined as:
//!
//! ```text
//! keccak256("\x19Ethereum Signed Message:\n" ‖ ascii(len(message)) ‖ message)
//! ```
//!
//! Signing is deterministic ([`SecretKey`] is derived from a seed and uses
//! RFC 6979 nonces), so the same key + message always yields the same
//! signature — and the signer can always be recovered from it.
//!
//! [EIP-191]: https://eips.ethereum.org/EIPS/eip-191

use crate::error::Result;
use crate::hash::keccak256;
use crate::secp::{PublicKey, RecoverableSignature, SecretKey};

/// Compute the EIP-191 `personal_sign` digest for `message`.
pub fn personal_message_digest(message: &[u8]) -> [u8; 32] {
    let mut data = Vec::with_capacity(message.len() + 26);
    data.extend_from_slice(b"\x19Ethereum Signed Message:\n");
    data.extend_from_slice(message.len().to_string().as_bytes());
    data.extend_from_slice(message);
    keccak256(&data)
}

/// Sign `message` (EIP-191 `personal_sign`). Deterministic given the key.
pub fn sign_personal(key: &SecretKey, message: &[u8]) -> Result<RecoverableSignature> {
    key.sign_prehash_recoverable(&personal_message_digest(message))
}

/// Recover the signer's EVM address from an EIP-191 signature over `message`.
pub fn recover_signer(message: &[u8], sig: &RecoverableSignature) -> Result<[u8; 20]> {
    let digest = personal_message_digest(message);
    let key = PublicKey::recover_from_prehash(&digest, sig)?;
    Ok(key.address())
}

/// Whether `sig` was produced by the holder of `address` over `message`.
///
/// Returns `false` (never an error) for any non-matching / tampered input, so
/// callers can treat it as a boolean gate without error handling.
pub fn verify_signer(message: &[u8], sig: &RecoverableSignature, address: &[u8; 20]) -> bool {
    match recover_signer(message, sig) {
        Ok(recovered) => &recovered == address,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes;

    #[test]
    fn digest_is_deterministic_and_sensitive() {
        let digest = personal_message_digest(b"hello");
        assert_eq!(digest, personal_message_digest(b"hello"));
        // Different messages differ.
        assert_ne!(
            personal_message_digest(b"hello"),
            personal_message_digest(b"hellp")
        );
        // Multi-byte UTF-8 is counted in bytes, not chars.
        let d1 = personal_message_digest("你好".as_bytes());
        assert_ne!(d1, [0u8; 32]);
    }

    #[test]
    fn sign_recover_verify_roundtrip() {
        let key = SecretKey::from_seed([77u8; 32]).unwrap();
        let message = b"Allow amos to access mailbox?";
        let sig = sign_personal(&key, message).unwrap();
        assert!(sig.v == 27 || sig.v == 28);

        let addr = recover_signer(message, &sig).unwrap();
        assert_eq!(addr, key.public_key().address());
        assert!(verify_signer(message, &sig, &key.public_key().address()));

        // A wrong expected address and a tampered message both fail closed.
        let mut wrong = addr;
        wrong[0] ^= 0x01;
        assert!(!verify_signer(message, &sig, &wrong));
        assert!(!verify_signer(
            b"tampered",
            &sig,
            &key.public_key().address()
        ));
    }

    #[test]
    fn serialization_survives_signature() {
        let key = SecretKey::from_seed([5u8; 32]).unwrap();
        let message = b"some message";
        let sig = sign_personal(&key, message).unwrap();
        let hex = sig.to_hex();
        assert!(hex.starts_with("0x"));
        assert_eq!(hex.len(), 2 + 65 * 2);
        let back = RecoverableSignature::from_bytes(&bytes::decode_hex(&hex).unwrap()).unwrap();
        assert!(verify_signer(message, &back, &key.public_key().address()));
    }
}
