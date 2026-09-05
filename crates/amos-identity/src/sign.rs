//! Sign a statement with an [`IdentityKey`] and verify it against a `did:key`.
//!
//! * **Ed25519** identities sign the raw statement bytes with an Ed25519
//!   signature; verification checks it against the public key embedded in the
//!   DID.
//! * **secp256k1** identities sign the statement as an [EIP-191]
//!   `personal_sign`; verification recovers the signer's EVM address and checks
//!   it against the address of the public key embedded in the DID (the Web3
//!   path, so `did:key` ↔ wallet are the same person).
//!
//! Everything is deterministic, and every verify function fails closed
//! (`false` on any malformed / tampered input, never an error).
//!
//! [EIP-191]: https://eips.ethereum.org/EIPS/eip-191

use amos_web3::eip712::TypedData;
use amos_web3::secp::RecoverableSignature;
use ed25519_dalek::{Signature as EdSignature, VerifyingKey as EdVerifyingKey};

use crate::did;
use crate::error::{Error, Result};
use crate::key::{Curve, IdentityKey};

/// A signature over a statement produced by an identity, tagged with the curve
/// that made it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatementSignature {
    /// Which curve produced `bytes`.
    pub curve: Curve,
    /// Curve-specific signature bytes:
    /// Ed25519 → 64 bytes; secp256k1 → 65 bytes `r ‖ s ‖ v`.
    pub bytes: Vec<u8>,
}

impl StatementSignature {
    /// Whether the byte length matches the curve's signature format.
    pub fn is_well_formed(&self) -> bool {
        match self.curve {
            Curve::Ed25519 => self.bytes.len() == 64,
            Curve::Secp256k1 => self.bytes.len() == 65,
        }
    }

    /// Hex form of the signature bytes (for display / transport).
    pub fn to_hex(&self) -> String {
        amos_web3::bytes::encode_hex0x(&self.bytes)
    }
}

/// Sign `statement` with an identity. Deterministic for a given key.
///
/// Signing a digest is an infallible invariant for a valid key, so this does
/// not return a `Result`; the one inner `expect` is documented here (P0-1).
#[allow(clippy::expect_used)]
pub fn sign_statement(key: &IdentityKey, statement: &[u8]) -> StatementSignature {
    match key {
        IdentityKey::Ed25519(k) => StatementSignature {
            curve: Curve::Ed25519,
            bytes: k.sign(statement).to_vec(),
        },
        IdentityKey::Secp256k1(k) => {
            // EIP-191 personal_sign over the statement (deterministic, low-s).
            let sig = amos_web3::eip191::sign_personal(k, statement)
                .expect("deterministic sign of a digest cannot fail");
            StatementSignature {
                curve: Curve::Secp256k1,
                bytes: sig.to_bytes().to_vec(),
            }
        }
    }
}

/// Verify `sig` over `statement` against the public key embedded in `did`.
///
/// Fails closed: returns `false` for a malformed DID, wrong curve, wrong
/// signature length, or a signature that does not belong to the DID's key.
pub fn verify_statement(did_str: &str, statement: &[u8], sig: &StatementSignature) -> bool {
    let Ok((curve, pubkey)) = did::parse_did_key(did_str) else {
        return false;
    };
    if curve != sig.curve || !sig.is_well_formed() {
        return false;
    }
    match curve {
        Curve::Ed25519 => verify_ed25519(&pubkey, statement, &sig.bytes),
        Curve::Secp256k1 => verify_secp256k1(&pubkey, statement, &sig.bytes),
    }
}

/// Verify an Ed25519 signature against a 32-byte public key.
fn verify_ed25519(pubkey: &[u8], statement: &[u8], sig_bytes: &[u8]) -> bool {
    if pubkey.len() != 32 || sig_bytes.len() != 64 {
        return false;
    }
    let Ok(pk) = <[u8; 32]>::try_from(pubkey) else {
        return false;
    };
    let Ok(vk) = EdVerifyingKey::from_bytes(&pk) else {
        return false;
    };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig_bytes) else {
        return false;
    };
    let sig = EdSignature::from_bytes(&sig_arr);
    vk.verify_strict(statement, &sig).is_ok()
}

/// Verify an EIP-191 signature over `statement` against a compressed secp256k1
/// public key: recover the signer address and compare to the key's address.
fn verify_secp256k1(pubkey: &[u8], statement: &[u8], sig_bytes: &[u8]) -> bool {
    if sig_bytes.len() != 65 {
        return false;
    }
    let Ok(pk) = amos_web3::secp::PublicKey::from_bytes(pubkey) else {
        return false;
    };
    let expected = pk.address();
    let Ok(sig) = RecoverableSignature::from_bytes(sig_bytes) else {
        return false;
    };
    amos_web3::eip191::recover_signer(statement, &sig) == Ok(expected)
}

/// Sign an [EIP-712] typed-data message with a secp256k1 identity (the Web3
/// wallet path). Ed25519 identities cannot speak EIP-712 and return
/// [`Error::UnsupportedCurve`].
///
/// [EIP-712]: https://eips.ethereum.org/EIPS/eip-712
pub fn sign_typed_data(key: &IdentityKey, typed: &TypedData) -> Result<StatementSignature> {
    let IdentityKey::Secp256k1(k) = key else {
        return Err(Error::UnsupportedCurve);
    };
    let sig = typed.sign(k)?;
    Ok(StatementSignature {
        curve: Curve::Secp256k1,
        bytes: sig.to_bytes().to_vec(),
    })
}

/// Verify an EIP-712 typed-data signature produced by [`sign_typed_data`]
/// against a `did:key`. Fails closed on any mismatch / malformed input.
pub fn verify_typed_data(did_str: &str, typed: &TypedData, sig: &StatementSignature) -> bool {
    let Ok((curve, pubkey)) = did::parse_did_key(did_str) else {
        return false;
    };
    if curve != Curve::Secp256k1 || sig.curve != Curve::Secp256k1 || sig.bytes.len() != 65 {
        return false;
    }
    let Ok(pk) = amos_web3::secp::PublicKey::from_bytes(&pubkey) else {
        return false;
    };
    let Ok(recovered) = RecoverableSignature::from_bytes(&sig.bytes) else {
        return false;
    };
    typed.verify_signer(&recovered, &pk.address())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::Ed25519Key;

    #[test]
    fn ed25519_sign_verify_roundtrip() {
        let key = IdentityKey::from_seed(Curve::Ed25519, [11u8; 32]).unwrap();
        let did_str = key.did().unwrap();
        let statement = b"e2e license: I own device ABC-123";
        let sig = sign_statement(&key, statement);
        assert_eq!(sig.curve, Curve::Ed25519);
        assert!(sig.is_well_formed());
        assert!(verify_statement(&did_str, statement, &sig));

        // Tampered statement and a different DID both fail closed.
        assert!(!verify_statement(&did_str, b"tampered", &sig));
        let other = IdentityKey::from_seed(Curve::Ed25519, [12u8; 32]).unwrap();
        assert!(!verify_statement(&other.did().unwrap(), statement, &sig));
    }

    #[test]
    fn secp_sign_verify_roundtrip_and_wallet_alignment() {
        let key = IdentityKey::from_seed(Curve::Secp256k1, [42u8; 32]).unwrap();
        let did_str = key.did().unwrap();
        let statement = b"authorize transfer of 1 ETH";
        let sig = sign_statement(&key, statement);
        assert_eq!(sig.curve, Curve::Secp256k1);
        assert_eq!(sig.bytes.len(), 65);
        assert!(verify_statement(&did_str, statement, &sig));

        // The DID's embedded pubkey is the same EVM address as the signer of
        // the underlying EIP-191 personal_sign (web3 re-verification).
        let (_, pubkey) = did::parse_did_key(&did_str).unwrap();
        let pk = amos_web3::secp::PublicKey::from_bytes(&pubkey).unwrap();
        let sig_obj = RecoverableSignature::from_bytes(&sig.bytes).unwrap();
        assert!(amos_web3::eip191::verify_signer(
            statement,
            &sig_obj,
            &pk.address()
        ));

        // Tampered message and a different DID reject.
        assert!(!verify_statement(&did_str, b"tampered", &sig));
        let other = IdentityKey::from_seed(Curve::Secp256k1, [43u8; 32]).unwrap();
        assert!(!verify_statement(&other.did().unwrap(), statement, &sig));
    }

    #[test]
    fn sign_and_verify_typed_data_wallet_path() {
        fn permit() -> TypedData {
            TypedData::from_json(
                r#"{
                  "types": {
                    "EIP712Domain": [ { "name": "chainId", "type": "uint256" } ],
                    "Permit": [
                      { "name": "spender", "type": "address" },
                      { "name": "amount", "type": "uint256" }
                    ]
                  },
                  "primaryType": "Permit",
                  "domain": { "chainId": 1 },
                  "message": {
                    "spender": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
                    "amount": 1000
                  }
                }"#,
            )
            .unwrap()
        }
        fn tampered() -> TypedData {
            let s = "{\"types\":{\"EIP712Domain\":[{\"name\":\"chainId\",\"type\":\"uint256\"}],\"Permit\":[{\"name\":\"spender\",\"type\":\"address\"},{\"name\":\"amount\",\"type\":\"uint256\"}]},\"primaryType\":\"Permit\",\"domain\":{\"chainId\":1},\"message\":{\"spender\":\"0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826\",\"amount\":9999}}";
            TypedData::from_json(s).unwrap()
        }

        let key = IdentityKey::from_seed(Curve::Secp256k1, [7u8; 32]).unwrap();
        let did_str = key.did().unwrap();
        let sig = sign_typed_data(&key, &permit()).unwrap();
        assert_eq!(sig.curve, Curve::Secp256k1);
        assert_eq!(sig.bytes.len(), 65);
        assert!(verify_typed_data(&did_str, &permit(), &sig));
        // A different message (different amount) must not verify.
        assert!(!verify_typed_data(&did_str, &tampered(), &sig));
        // A different DID must not verify.
        let other = IdentityKey::from_seed(Curve::Secp256k1, [8u8; 32]).unwrap();
        assert!(!verify_typed_data(&other.did().unwrap(), &permit(), &sig));
    }

    #[test]
    fn typed_data_ed25519_rejected() {
        let key = IdentityKey::from_seed(Curve::Ed25519, [1u8; 32]).unwrap();
        let typed = TypedData::from_json(
            r#"{"types":{"EIP712Domain":[],"S":[{"name":"v","type":"uint256"}]},"primaryType":"S","domain":{},"message":{"v":1}}"#,
        )
        .unwrap();
        let res = sign_typed_data(&key, &typed);
        assert_eq!(res.unwrap_err(), Error::UnsupportedCurve);
    }

    #[test]
    fn malformed_sig_fails_closed() {
        let key = Ed25519Key::from_seed([5u8; 32]);
        let did_str = did::did_key_from_public_key(Curve::Ed25519, &key.public_bytes()).unwrap();
        let bad = StatementSignature {
            curve: Curve::Ed25519,
            bytes: vec![0u8; 63], // wrong length
        };
        assert!(!verify_statement(&did_str, b"msg", &bad));
        // Curve tag does not match the DID.
        let bad_curve = StatementSignature {
            curve: Curve::Secp256k1,
            bytes: vec![0u8; 64],
        };
        assert!(!verify_statement(&did_str, b"msg", &bad_curve));
    }
}
