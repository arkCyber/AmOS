//! Integrity and signature verification.
//!
//! Two independent gates, in order:
//!
//! 1. **Integrity** — the bytes must hash to the digest the manifest published.
//!    This is computed here ([`sha256_hex`]) so it is testable against the RFC's
//!    own vectors; a mismatch is a hard refusal, never a warning.
//! 2. **Authenticity** — a detached signature over the same bytes must be
//!    accepted by the deployment's [`SignatureVerifier`]. Two verifiers ship:
//!
//!    * [`Ed25519Verifier`] — the **real** one. It holds a table of trusted
//!      Ed25519 public keys by `key_id` and actually verifies the signature
//!      mathematics (RFC 8032), pinned below against the RFC's own vectors. This
//!      is what a deployment should use.
//!    * [`TrustingVerifier`] — a **policy-only** stand-in that checks that the
//!      `key_id` is one we trust and the signature is shaped like a signature,
//!      and performs **no cryptography**. It exists for tests, offline demos and
//!      the CLI's `--trusting` mode, and its docs must not be read as a security
//!      claim: it would accept a forged signature from any holder of a trusted
//!      key id.
//!
//! Both implement the same [`SignatureVerifier`] seam, so a deployment swaps one
//! for the other without touching the caller.

use std::collections::{BTreeMap, BTreeSet};

use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::error::{OtaError, Result};
use crate::spec::UpdatePackage;

/// Lowercase-hex SHA-256 of `bytes` (always 64 characters).
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The outcome of an integrity check. `Malformed` is deliberately distinct from
/// `Mismatch`: a manifest digest that is not even 64-hex is a *bug in the
/// manifest*, not an attack on the payload, and the two deserve different logs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IntegrityVerdict {
    /// The bytes hash to the expected digest.
    Verified,
    /// The bytes hashed to something else — a corrupt or tampered payload.
    Mismatch { expected: String, actual: String },
    /// The expected digest was not a 64-character hex string.
    Malformed { reason: String },
}

impl IntegrityVerdict {
    pub fn is_verified(&self) -> bool {
        matches!(self, IntegrityVerdict::Verified)
    }
}

/// Check `bytes` against an expected lowercase-or-uppercase hex SHA-256.
///
/// The comparison is case-insensitive on purpose: hex case carries no meaning,
/// and refusing `AABB…` because it is upper-case would be a false refusal of a
/// valid digest. A digest of the wrong *length* or with a non-hex byte is
/// `Malformed` (see above).
pub fn check_integrity(expected_hex: &str, bytes: &[u8]) -> IntegrityVerdict {
    if expected_hex.len() != 64 {
        return IntegrityVerdict::Malformed {
            reason: format!(
                "expected digest is {} chars, not 64: {expected_hex}",
                expected_hex.len()
            ),
        };
    }
    if hex::decode(expected_hex).is_err() {
        return IntegrityVerdict::Malformed {
            reason: format!("expected digest is not hex: {expected_hex}"),
        };
    }
    let actual = sha256_hex(bytes);
    if actual == expected_hex.to_ascii_lowercase() {
        IntegrityVerdict::Verified
    } else {
        IntegrityVerdict::Mismatch {
            expected: expected_hex.to_ascii_lowercase(),
            actual,
        }
    }
}

/// The outcome of a signature check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignatureVerdict {
    /// The verifier accepted the detached signature.
    Trusted,
    /// The verifier rejected it (unknown key, or the signature did not verify).
    Untrusted { key_id: String, reason: String },
    /// The package carried no signature at all.
    Missing,
}

impl SignatureVerdict {
    pub fn is_trusted(&self) -> bool {
        matches!(self, SignatureVerdict::Trusted)
    }
}

/// The authenticity seam. A deployment implements this over a real signature
/// scheme; the core only calls it.
pub trait SignatureVerifier: Send + Sync {
    /// Verify `signature_hex` over `payload` for `key_id`. `Ok(false)` means
    /// "well-formed but not trusted"; `Err` means the input could not even be
    /// evaluated (bad hex, unknown algorithm). A deployment must never return
    /// `Ok(true)` for a signature it did not actually check.
    fn verify(&self, key_id: &str, payload: &[u8], signature_hex: &str) -> Result<bool>;
}

/// A **real** Ed25519 verifier (RFC 8032). It carries a table of trusted public
/// keys keyed by `key_id` and verifies the detached signature over the payload
/// with `verify_strict` — which additionally rejects small-order / non-canonical
/// public keys and signatures, so a key that would admit a malleable signature is
/// refused.
///
/// This is the verifier a deployment should use. The keys are supplied by the
/// caller as 32-byte hex public keys; loading them from the manifest, a config
/// file or the image is the caller's job (this crate is I/O-free), and an
/// undecodable key is a typed [`OtaError::InvalidKey`] at insert time rather
/// than a silent "never verifies" at check time.
#[derive(Clone, Debug, Default)]
pub struct Ed25519Verifier {
    keys: BTreeMap<String, VerifyingKey>,
}

impl Ed25519Verifier {
    /// An empty verifier — it trusts no key, so every signature is `Untrusted`.
    /// Add keys with [`Self::insert`] / [`Self::with_key`].
    pub fn new() -> Ed25519Verifier {
        Ed25519Verifier::default()
    }

    /// Register `public_key_hex` (32-byte lowercase-or-uppercase hex) under
    /// `key_id`. Returns [`OtaError::InvalidHex`] if the hex is malformed or not
    /// 32 bytes, and [`OtaError::InvalidKey`] if it decodes to bytes that are not
    /// a valid Ed25519 public key.
    pub fn insert(&mut self, key_id: impl Into<String>, public_key_hex: &str) -> Result<()> {
        let key = decode_public_key(public_key_hex)?;
        self.keys.insert(key_id.into(), key);
        Ok(())
    }

    /// [`Self::insert`] in builder form, for a chained registration.
    pub fn with_key(mut self, key_id: impl Into<String>, public_key_hex: &str) -> Result<Self> {
        self.insert(key_id, public_key_hex)?;
        Ok(self)
    }

    /// Whether `key_id` has a registered public key.
    pub fn trusts(&self, key_id: &str) -> bool {
        self.keys.contains_key(key_id)
    }

    /// How many keys are registered.
    pub fn key_count(&self) -> usize {
        self.keys.len()
    }
}

/// Decode a 32-byte hex Ed25519 public key. Splits three failure modes: a
/// non-hex or odd-length string is [`OtaError::InvalidHex`]; hex that decodes to
/// the wrong number of bytes, or to 32 bytes that are not a curve point, is
/// [`OtaError::InvalidKey`].
fn decode_public_key(public_key_hex: &str) -> Result<VerifyingKey> {
    let bytes = hex::decode(public_key_hex)
        .map_err(|_| OtaError::InvalidHex(format!("public key: {public_key_hex}")))?;
    let arr = <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| {
        OtaError::InvalidKey(format!(
            "public key is {} bytes, not 32: {public_key_hex}",
            bytes.len()
        ))
    })?;
    VerifyingKey::from_bytes(&arr)
        .map_err(|e| OtaError::InvalidKey(format!("{public_key_hex}: {e}")))
}

impl SignatureVerifier for Ed25519Verifier {
    fn verify(&self, key_id: &str, payload: &[u8], signature_hex: &str) -> Result<bool> {
        // Hex shape first, so a malformed signature is an `Err` (unevaluable)
        // regardless of whether the key is known — the same contract
        // `TrustingVerifier` keeps.
        let sig_bytes = hex::decode(signature_hex)
            .map_err(|_| OtaError::InvalidHex(format!("signature: {signature_hex}")))?;
        let sig_arr = <[u8; 64]>::try_from(sig_bytes.as_slice()).map_err(|_| {
            OtaError::InvalidHex(format!(
                "signature is {} bytes, not 64: {signature_hex}",
                sig_bytes.len()
            ))
        })?;

        // An unknown key is *untrusted*, not an error: the input is well-formed,
        // the deployment simply does not trust that key id.
        let Some(key) = self.keys.get(key_id) else {
            return Ok(false);
        };

        let sig = Signature::from_bytes(&sig_arr);
        Ok(key.verify_strict(payload, &sig).is_ok())
    }
}

/// A **policy-only** verifier: it accepts a signature iff its `key_id` is in the
/// trusted set and the value is even-length hex. It performs **no cryptography**
/// and is intended for tests, offline demos and the CLI's `--trusting` mode.
///
/// **This is not a security boundary.** A deployment that needs real
/// authenticity implements [`SignatureVerifier`] over an actual signature
/// scheme; using this one in production would accept a forged signature from any
/// holder of a trusted key id. The type name and this paragraph exist so no
/// reader can mistake it for more than it is.
#[derive(Clone, Debug, Default)]
pub struct TrustingVerifier {
    trusted: BTreeSet<String>,
}

impl TrustingVerifier {
    /// A verifier trusting `key_ids`.
    pub fn new<'a>(key_ids: impl IntoIterator<Item = &'a str>) -> TrustingVerifier {
        TrustingVerifier {
            trusted: key_ids.into_iter().map(str::to_string).collect(),
        }
    }

    /// Whether `key_id` is in the trusted set.
    pub fn trusts(&self, key_id: &str) -> bool {
        self.trusted.contains(key_id)
    }
}

impl SignatureVerifier for TrustingVerifier {
    fn verify(&self, key_id: &str, _payload: &[u8], signature_hex: &str) -> Result<bool> {
        if signature_hex.is_empty()
            || signature_hex.len() % 2 != 0
            || hex::decode(signature_hex).is_err()
        {
            return Err(OtaError::InvalidHex(format!("signature: {signature_hex}")));
        }
        Ok(self.trusts(key_id))
    }
}

/// Verify a package's detached signature over `payload` with `verifier`.
pub fn verify_signature(
    verifier: &dyn SignatureVerifier,
    package: &UpdatePackage,
    payload: &[u8],
) -> Result<SignatureVerdict> {
    match package.signature() {
        None => Ok(SignatureVerdict::Missing),
        Some(sig) => {
            if verifier.verify(sig.key_id(), payload, sig.value())? {
                Ok(SignatureVerdict::Trusted)
            } else {
                Ok(SignatureVerdict::Untrusted {
                    key_id: sig.key_id().to_string(),
                    reason: "signature not trusted by this verifier".into(),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{Channel, Signature};
    use crate::version::Version;

    #[test]
    fn sha256_matches_rfc_vectors() {
        // FIPS 180-2 / RFC 6234 vectors.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn integrity_accepts_case_insensitively_and_rejects_mismatch() {
        let bytes = b"abc";
        let good = sha256_hex(bytes);
        assert_eq!(check_integrity(&good, bytes), IntegrityVerdict::Verified);
        assert_eq!(
            check_integrity(&good.to_ascii_uppercase(), bytes),
            IntegrityVerdict::Verified
        );
        assert!(matches!(
            check_integrity(&"0".repeat(64), bytes),
            IntegrityVerdict::Mismatch { .. }
        ));
    }

    #[test]
    fn integrity_reports_malformed_distinctly() {
        assert!(matches!(
            check_integrity("abcd", b"x"),
            IntegrityVerdict::Malformed { .. }
        ));
        assert!(matches!(
            check_integrity(&"z".repeat(64), b"x"),
            IntegrityVerdict::Malformed { .. }
        ));
    }

    fn signed_pkg(sig: Option<Signature>) -> UpdatePackage {
        let p = UpdatePackage::new(
            Version::parse("1.0.0").unwrap(),
            Channel::Stable,
            "u",
            sha256_hex(b"payload"),
            7,
        )
        .unwrap();
        match sig {
            Some(s) => p.with_signature(s),
            None => p,
        }
    }

    #[test]
    fn signature_verdicts() {
        let verifier = TrustingVerifier::new(["good-key"]);
        // Missing signature.
        assert_eq!(
            verify_signature(&verifier, &signed_pkg(None), b"payload").unwrap(),
            SignatureVerdict::Missing
        );
        // Trusted key + well-formed value.
        let trusted = signed_pkg(Some(Signature::new("good-key", "aabb").unwrap()));
        assert!(verify_signature(&verifier, &trusted, b"payload")
            .unwrap()
            .is_trusted());
        // Unknown key ⇒ Untrusted, not an error.
        let unknown = signed_pkg(Some(Signature::new("other-key", "aabb").unwrap()));
        assert!(matches!(
            verify_signature(&verifier, &unknown, b"payload").unwrap(),
            SignatureVerdict::Untrusted { .. }
        ));
    }

    #[test]
    fn trusting_verifier_refuses_malformed_signature_hex() {
        let verifier = TrustingVerifier::new(["k"]);
        assert!(verifier.verify("k", b"", "abc").is_err());
        assert!(verifier.verify("k", b"", "").is_err());
        assert!(verifier.verify("k", b"", "aabb").unwrap());
    }

    /// RFC 8032 §7.1 test vectors, verbatim: `(public_key_hex, message_hex,
    /// signature_hex)`. These are the authority for "this is Ed25519" — the
    /// implementation is only called Ed25519 because it reproduces them.
    const RFC8032_VECTORS: &[(&str, &str, &str)] = &[
        (
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
            "",
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        ),
        (
            "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
            "72",
            "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
        ),
        (
            "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
            "af82",
            "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
        ),
    ];

    #[test]
    fn ed25519_verifier_accepts_the_rfc8032_vectors() {
        for (i, (pk, msg_hex, sig)) in RFC8032_VECTORS.iter().enumerate() {
            let verifier = Ed25519Verifier::new()
                .with_key("k", pk)
                .unwrap_or_else(|e| panic!("vector {i}: key should decode: {e}"));
            let msg = hex::decode(msg_hex).unwrap();
            assert!(
                verifier.verify("k", &msg, sig).unwrap(),
                "vector {i} must verify — this is what \"Ed25519\" means"
            );
        }
    }

    /// The verifier must be sensitive to *every* bit of the three inputs. A
    /// flipped signature bit, a one-byte-longer payload and a flipped payload bit
    /// must each be refused — the negative control for the positive test above.
    #[test]
    fn ed25519_verifier_rejects_every_tampered_input() {
        for (i, (pk, msg_hex, sig)) in RFC8032_VECTORS.iter().enumerate() {
            let verifier = Ed25519Verifier::new().with_key("k", pk).unwrap();
            let msg = hex::decode(msg_hex).unwrap();

            // Flip one bit of the signature.
            let mut bad_sig = sig.to_string();
            let first = sig.as_bytes()[0];
            let flipped = if first == b'0' { '1' } else { '0' };
            bad_sig.replace_range(0..1, &flipped.to_string());
            assert!(
                !verifier.verify("k", &msg, &bad_sig).unwrap(),
                "vector {i}: a flipped signature bit must not verify"
            );

            // Flip one bit of the payload.
            let mut bad_msg = msg.clone();
            if let Some(b) = bad_msg.first_mut() {
                *b ^= 0x01;
                assert!(
                    !verifier.verify("k", &bad_msg, sig).unwrap(),
                    "vector {i}: a flipped payload bit must not verify"
                );
            } else {
                // The empty-message vector: any non-empty message is a mismatch.
                assert!(
                    !verifier.verify("k", b"\x00", sig).unwrap(),
                    "vector {i}: a non-empty message must not verify an empty-message signature"
                );
            }
        }
    }

    #[test]
    fn ed25519_verifier_reports_an_unknown_key_as_untrusted_not_an_error() {
        let pk = RFC8032_VECTORS[0].0;
        let verifier = Ed25519Verifier::new().with_key("known", pk).unwrap();
        let sig = RFC8032_VECTORS[0].2;
        assert!(!verifier.verify("other", b"", sig).unwrap());
        assert!(verifier.trusts("known"));
        assert!(!verifier.trusts("other"));
        assert_eq!(verifier.key_count(), 1);
    }

    #[test]
    fn ed25519_verifier_refuses_a_malformed_signature_hex() {
        let verifier = Ed25519Verifier::new()
            .with_key("k", RFC8032_VECTORS[0].0)
            .unwrap();
        // Not hex at all.
        assert!(verifier.verify("k", b"", "zz").is_err());
        // Odd length.
        assert!(verifier.verify("k", b"", "abc").is_err());
        // Right shape, wrong length (a 63-byte signature).
        let short = &RFC8032_VECTORS[0].2[..126];
        assert!(verifier.verify("k", b"", short).is_err());
    }

    #[test]
    fn ed25519_verifier_distingishes_a_bad_key_shape_from_a_bad_point() {
        let mut verifier = Ed25519Verifier::new();
        // Odd-length hex never decodes ⇒ InvalidHex (unevaluable input).
        assert!(matches!(
            verifier.insert("k", "abc"),
            Err(OtaError::InvalidHex(_))
        ));
        // Non-hex ⇒ InvalidHex.
        assert!(matches!(
            verifier.insert("k", &"zz".repeat(32)),
            Err(OtaError::InvalidHex(_))
        ));
        // Valid hex that decodes to 31 bytes ⇒ InvalidKey (wrong key length).
        assert!(matches!(
            verifier.insert("k", &"ab".repeat(31)),
            Err(OtaError::InvalidKey(_))
        ));
        // 32 bytes that are not a valid curve point ⇒ InvalidKey. `0x02` repeated
        // is a well-known compressed encoding that does not decompress to a point
        // on the curve for this y-coordinate.
        assert!(matches!(
            verifier.insert("k", &"02".repeat(32)),
            Err(OtaError::InvalidKey(_))
        ));
        // A real key inserts cleanly.
        assert!(verifier.insert("k", RFC8032_VECTORS[0].0).is_ok());
    }

    /// The end-to-end point of this module: a real signer's signature is
    /// `Trusted` through `verify_signature`, and a payload tampered after signing
    /// is `Untrusted` — with no `TrustingVerifier` in the path.
    #[test]
    fn a_real_signature_round_trips_through_verify_signature() {
        use ed25519_dalek::{Signer, SigningKey};

        // RFC 8032 TEST 2's deterministic seed.
        let seed: [u8; 32] =
            hex::decode("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
                .unwrap()
                .try_into()
                .unwrap();
        let signing_key = SigningKey::from_bytes(&seed);
        let pk_hex = hex::encode(signing_key.verifying_key().to_bytes());

        let payload = b"the ota image bytes";
        let sig_hex = hex::encode(signing_key.sign(payload).to_bytes());

        let verifier = Ed25519Verifier::new()
            .with_key("release-2026", &pk_hex)
            .unwrap();
        let pkg = signed_pkg(Some(Signature::new("release-2026", &sig_hex).unwrap()));

        assert!(
            verify_signature(&verifier, &pkg, payload)
                .unwrap()
                .is_trusted(),
            "a genuine Ed25519 signature over the exact payload must be Trusted"
        );
        // Tampering the payload after signing flips the verdict.
        assert!(matches!(
            verify_signature(&verifier, &pkg, b"the ota image bytez").unwrap(),
            SignatureVerdict::Untrusted { .. }
        ));
    }

    /// The difference the real verifier buys: a forged signature (any 64 hex
    /// bytes) on a trusted key id is accepted by the policy-only verifier and
    /// **refused** by the Ed25519 one. Without this, `Ed25519Verifier` would be
    /// `TrustingVerifier` under a more persuasive name.
    #[test]
    fn the_real_verifier_refuses_a_forgery_the_trusting_one_accepts() {
        let forged = "00".repeat(64);
        let trusting = TrustingVerifier::new(["trusted-key"]);
        let real = Ed25519Verifier::new()
            .with_key("trusted-key", RFC8032_VECTORS[0].0)
            .unwrap();
        assert!(
            trusting.verify("trusted-key", b"payload", &forged).unwrap(),
            "the policy-only verifier accepts any well-shaped signature on a trusted key"
        );
        assert!(
            !real.verify("trusted-key", b"payload", &forged).unwrap(),
            "the real verifier must refuse a signature it cannot verify"
        );
    }
}
