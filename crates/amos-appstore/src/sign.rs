//! Ed25519 publisher signing for app manifests.
//!
//! A store's sha256 on the package already proves a downloaded artifact wasn't
//! corrupted in transit. Signing adds the missing half: *who* published it. A
//! developer signs their [`AppManifest`] with a secret [`DeveloperKey`]; the
//! resulting [`PublisherSig`] (public key + signature, hex) rides inside the
//! manifest, and [`verify_manifest_signature`] checks it before an install is
//! trusted.
//!
//! The signature is over the manifest's canonical bytes **with its own
//! `publisher` field cleared** ([`AppManifest::manifest_payload_bytes`]), so the
//! field being signed is never self-referential.
//!
//! *Note on trust:* verification here proves the manifest was produced by the
//! key embedded in it (self-consistency). Deciding whether that *key* is a
//! trusted publisher is the store's job (a pinned allow-list / key server) and
//! is deliberately left outside this crate.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

use crate::error::Result;
use crate::model::{AppManifest, PublisherSig};

/// A developer's Ed25519 keypair. Secret half is kept private and never
/// serialized; only the public half (as hex) is published in manifests.
///
/// Construct from a 32-byte seed with [`from_seed`](Self::from_seed). For real
/// key generation feed OS randomness into the seed (this crate stays free of a
/// PRNG dependency so the core is fully deterministic and testable).
pub struct DeveloperKey {
    key: SigningKey,
}

impl DeveloperKey {
    /// Build a keypair deterministically from a 32-byte seed.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(&seed),
        }
    }

    /// Hex of the 32-byte Ed25519 public key (64 hex chars).
    pub fn public_key_hex(&self) -> String {
        hex_bytes(&self.key.verifying_key().to_bytes())
    }

    /// Sign `msg`, returning the 64-byte signature.
    pub fn sign_bytes(&self, msg: &[u8]) -> [u8; 64] {
        let sig: Signature = self.key.sign(msg);
        sig.to_bytes()
    }
}

/// Sign `manifest` with `key`, stamping a [`PublisherSig`] onto it. The digest
/// covers the manifest with any existing signature cleared, so re-signing is
/// stable and idempotent for a given (manifest, key).
pub fn sign_manifest(key: &DeveloperKey, mut manifest: AppManifest) -> Result<AppManifest> {
    let payload = manifest.manifest_payload_bytes()?;
    let signature = key.sign_bytes(&payload);
    manifest.publisher = Some(PublisherSig {
        public_key: key.public_key_hex(),
        signature: hex_bytes(&signature),
    });
    Ok(manifest)
}

/// Whether `manifest` carries a signature that verifies against its own content
/// under the embedded public key. `false` for an unsigned manifest or any
/// malformed / mismatched signature.
pub fn verify_manifest_signature(manifest: &AppManifest) -> bool {
    let payload = match manifest.manifest_payload_bytes() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let Some(p) = &manifest.publisher else {
        return false;
    };
    verify_ed25519(&p.public_key, &p.signature, &payload)
}

/// Verify an Ed25519 signature (hex pubkey + hex sig) over `msg`.
fn verify_ed25519(public_key_hex: &str, signature_hex: &str, msg: &[u8]) -> bool {
    let Some(pk) = hex_to_bytes(public_key_hex) else {
        return false;
    };
    let Ok(pk_bytes) = <[u8; 32]>::try_from(pk.as_slice()) else {
        return false;
    };
    let Ok(verifying) = VerifyingKey::from_bytes(&pk_bytes) else {
        return false;
    };
    let Some(sig_bytes) = hex_to_bytes(signature_hex) else {
        return false;
    };
    if sig_bytes.len() != 64 {
        return false;
    }
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
    verifying.verify(msg, &sig).is_ok()
}

/// Lowercase hex encoding of bytes.
fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Decode a hex string (even length, hex digits only).
fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
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
    use crate::model::{AppCategory, PackageFormat, PackageRef, Version};

    fn manifest() -> AppManifest {
        AppManifest {
            id: "org.amos.signed".into(),
            name: "Signed App".into(),
            summary: "published by a developer".into(),
            description: String::new(),
            author: "Alice Dev".into(),
            version: Version::new(1, 0, 0),
            category: AppCategory::Tools,
            homepage: String::new(),
            icon_url: String::new(),
            package: PackageRef {
                format: PackageFormat::TarGz,
                url: "https://x/a.tgz".into(),
                sha256: None,
                size_bytes: None,
            },
            publisher: None,
        }
    }

    #[test]
    fn sign_then_verify_roundtrip() {
        let key = DeveloperKey::from_seed([7u8; 32]);
        assert_eq!(key.public_key_hex().len(), 64);

        let signed = sign_manifest(&key, manifest()).unwrap();
        assert!(signed.is_signed());
        assert!(verify_manifest_signature(&signed));

        // Deterministic: signing the same manifest yields the same signature.
        let again = sign_manifest(&key, manifest()).unwrap();
        assert_eq!(signed.publisher, again.publisher);
    }

    #[test]
    fn tampering_breaks_the_signature() {
        let key = DeveloperKey::from_seed([9u8; 32]);
        let mut signed = sign_manifest(&key, manifest()).unwrap();
        signed.name = "Changed by attacker".into();
        assert!(
            !verify_manifest_signature(&signed),
            "any content change must invalidate the publisher signature"
        );
    }

    #[test]
    fn unsigned_or_garbage_is_not_accepted() {
        let key = DeveloperKey::from_seed([3u8; 32]);
        let mut m = manifest();
        assert!(!m.is_signed());
        assert!(!verify_manifest_signature(&m));

        // A malformed (non-hex) public key must not verify either.
        m.publisher = Some(PublisherSig {
            public_key: "not-hex".into(),
            signature: hex_bytes(&key.sign_bytes(&m.manifest_payload_bytes().unwrap())),
        });
        assert!(!verify_manifest_signature(&m));
    }

    #[test]
    fn signature_survives_manifest_json_roundtrip() {
        let key = DeveloperKey::from_seed([5u8; 32]);
        let signed = sign_manifest(&key, manifest()).unwrap();
        let json = serde_json::to_string(&signed).unwrap();
        let back: AppManifest = serde_json::from_str(&json).unwrap();
        assert!(verify_manifest_signature(&back));
        assert_eq!(back.publisher, signed.publisher);
    }
}
