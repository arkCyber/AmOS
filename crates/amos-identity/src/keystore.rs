//! A small wallet keystore: alias → key, with deterministic password-wrapped
//! **at-rest** encryption.
//!
//! In memory the [`Keystore`] holds each key by its 32-byte seed. For at-rest
//! persistence it can [`seal`](Keystore::seal) the whole map into an opaque
//! authenticated blob: the passphrase is stretched with **PBKDF2-HMAC-SHA256**,
//! and each sealed payload is encrypted with **ChaCha20-Poly1305** (authenticated).
//!
//! # Honest seams (no randomness inside)
//!
//! * **Entropy**: keys come from caller-supplied 32-byte seeds (see [`key`]).
//! * **Salt / nonce**: AEAD needs a unique salt and nonce per write. Both are
//!   **parameters** here so the core stays deterministic and testable; a real
//!   OS/hardware keystore must supply fresh random values on every seal. Do not
//!   reuse a nonce across two seal operations with the same key.
//!
//! Use a strong passphrase and keep the (salt, nonce) alongside the ciphertext.

use std::collections::BTreeMap;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key};
use generic_array::GenericArray;

use crate::error::{Error, Result};
use crate::key::{Curve, IdentityKey};

/// Recommended PBKDF2 iteration count for password-hash `derive_key`
/// (OWASP guidance for PBKDF2-HMAC-SHA256). Callers may lower it in tests.
pub const DEFAULT_PBKDF2_ROUNDS: u32 = 210_000;

/// Byte prefix that heads every decrypted payload, identifying the at-rest
/// wire format and its version. Bump `0x01` and update [`decrypt`]/[`Keystore`]
/// parsing together if the layout ever changes.
pub const FORMAT_MAGIC: &[u8; 6] = b"AMOSK\x01";

/// Stretch a passphrase into a 32-byte key with PBKDF2-HMAC-SHA256.
pub fn derive_key(passphrase: &[u8], salt: &[u8], rounds: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase, salt, rounds, &mut key);
    key
}

/// A single stored key: curve + the 32-byte seed that reproduces it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredKey {
    /// Which curve the seed belongs to.
    pub curve: Curve,
    /// The 32-byte secret seed / scalar.
    pub seed: [u8; 32],
}

impl StoredKey {
    /// Rebuild an in-memory identity from the stored seed.
    pub fn to_identity(&self) -> Result<IdentityKey> {
        IdentityKey::from_seed(self.curve, self.seed)
    }

    /// Capture an in-memory identity into its storable seed form.
    pub fn from_identity(key: &IdentityKey) -> Self {
        Self {
            curve: key.curve(),
            seed: key.to_seed(),
        }
    }

    /// Curve byte tag used by the deterministic serialization.
    fn tag(&self) -> u8 {
        match self.curve {
            Curve::Ed25519 => 0x01,
            Curve::Secp256k1 => 0x02,
        }
    }

    fn curve_from_tag(tag: u8) -> Result<Curve> {
        match tag {
            0x01 => Ok(Curve::Ed25519),
            0x02 => Ok(Curve::Secp256k1),
            _ => Err(Error::Keystore("unknown curve tag".into())),
        }
    }
}
/// An in-memory, alias-keyed wallet.
#[derive(Clone, Debug, Default)]
pub struct Keystore {
    entries: BTreeMap<String, StoredKey>,
}

impl Keystore {
    /// An empty keystore.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert (or replace) an identity under `alias`.
    pub fn insert(&mut self, alias: impl Into<String>, key: &IdentityKey) {
        self.entries
            .insert(alias.into(), StoredKey::from_identity(key));
    }

    /// Rebuild the identity stored under `alias`, if present.
    pub fn get(&self, alias: &str) -> Option<Result<IdentityKey>> {
        self.entries.get(alias).map(|k| k.to_identity())
    }

    /// Aliases currently present, in deterministic (sorted) order.
    pub fn list(&self) -> Vec<String> {
        self.entries.keys().cloned().collect()
    }

    /// Whether `alias` is present.
    pub fn contains(&self, alias: &str) -> bool {
        self.entries.contains_key(alias)
    }

    /// Number of stored keys.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the keystore is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Remove `alias`; returns whether it existed.
    pub fn remove(&mut self, alias: &str) -> bool {
        self.entries.remove(alias).is_some()
    }

    /// Seal the whole keystore into an authenticated ciphertext blob. The
    /// caller owns the fresh random `salt`/`nonce` (see the module docs).
    ///
    /// # Examples
    /// ```
    /// use amos_identity::keystore::Keystore;
    /// use amos_identity::{Curve, IdentityKey};
    /// let mut ks = Keystore::new();
    /// ks.insert("wallet", &IdentityKey::from_seed(Curve::Secp256k1, [3u8; 32]).unwrap());
    /// let salt = [0u8; 16];
    /// let nonce = [0u8; 12];
    /// let blob = ks.seal(b"correct horse", &salt, &nonce, 1_000).unwrap();
    /// let opened = Keystore::from_sealed(b"correct horse", &salt, &nonce, 1_000, &blob).unwrap();
    /// assert!(opened.contains("wallet"));
    /// ```
    pub fn seal(
        &self,
        passphrase: &[u8],
        salt: &[u8; 16],
        nonce: &[u8; 12],
        rounds: u32,
    ) -> Result<Vec<u8>> {
        let mut plaintext = Vec::new();
        plaintext.extend_from_slice(FORMAT_MAGIC);
        for (alias, key) in &self.entries {
            push_len_prefixed(&mut plaintext, alias.as_bytes());
            plaintext.push(key.tag());
            plaintext.extend_from_slice(&key.seed);
        }
        encrypt(&plaintext, passphrase, salt, nonce, rounds)
    }

    /// Rebuild a keystore from a sealed blob (inverse of [`seal`](Self::seal)).
    pub fn from_sealed(
        passphrase: &[u8],
        salt: &[u8; 16],
        nonce: &[u8; 12],
        rounds: u32,
        ciphertext: &[u8],
    ) -> Result<Self> {
        let plaintext = decrypt(ciphertext, passphrase, salt, nonce, rounds)?;
        if !plaintext.starts_with(FORMAT_MAGIC) {
            return Err(Error::Keystore(
                "unsupported at-rest format (missing/unknown magic)".into(),
            ));
        }
        let mut entries = BTreeMap::new();
        let mut rest: &[u8] = &plaintext[FORMAT_MAGIC.len()..];
        while !rest.is_empty() {
            let (alias_bytes, r) = take_len_prefixed(rest)?;
            let alias = std::str::from_utf8(alias_bytes)
                .map_err(|_| Error::Keystore("alias is not UTF-8".into()))?
                .to_string();
            if r.len() < 33 {
                return Err(Error::Keystore("truncated key record".into()));
            }
            let curve = StoredKey::curve_from_tag(r[0])?;
            let mut seed = [0u8; 32];
            seed.copy_from_slice(&r[1..33]);
            entries.insert(alias, StoredKey { curve, seed });
            rest = &r[33..];
        }
        Ok(Self { entries })
    }
}

/// Length-prefix (`u32` BE) a chunk onto `out`. An alias longer than `u32::MAX`
/// cannot exist in memory, so the cast is exact in practice.
fn push_len_prefixed(out: &mut Vec<u8>, data: &[u8]) {
    let len = data.len() as u32;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(data);
}

/// Read a `u32` BE length-prefixed chunk, returning it plus the remainder.
fn take_len_prefixed(data: &[u8]) -> Result<(&[u8], &[u8])> {
    if data.len() < 4 {
        return Err(Error::Keystore("truncated length prefix".into()));
    }
    let len = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let chunk = data
        .get(4..4 + len)
        .ok_or_else(|| Error::Keystore("truncated alias".into()))?;
    Ok((chunk, &data[4 + len..]))
}

/// ChaCha20-Poly1305 encryption under a PBKDF2-derived key.
fn encrypt(
    plaintext: &[u8],
    passphrase: &[u8],
    salt: &[u8; 16],
    nonce: &[u8; 12],
    rounds: u32,
) -> Result<Vec<u8>> {
    let key = derive_key(passphrase, salt, rounds);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let nonce_arr = GenericArray::from_slice(nonce);
    cipher
        .encrypt(nonce_arr, plaintext)
        .map_err(|_| Error::Keystore("encryption failed".into()))
}

/// ChaCha20-Poly1305 decryption + authentication.
fn decrypt(
    ciphertext: &[u8],
    passphrase: &[u8],
    salt: &[u8; 16],
    nonce: &[u8; 12],
    rounds: u32,
) -> Result<Vec<u8>> {
    let key = derive_key(passphrase, salt, rounds);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let nonce_arr = GenericArray::from_slice(nonce);
    cipher.decrypt(nonce_arr, ciphertext).map_err(|_| {
        Error::Keystore("decryption failed (wrong passphrase or tampered data)".into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Low iteration count so tests stay fast; production uses
    // DEFAULT_PBKDF2_ROUNDS.
    const ROUNDS: u32 = 1_000;
    const SALT: [u8; 16] = [7u8; 16];
    const NONCE: [u8; 12] = [9u8; 12];

    #[test]
    fn insert_get_remove_roundtrip() {
        let mut ks = Keystore::new();
        assert!(ks.is_empty());
        let ed = IdentityKey::from_seed(Curve::Ed25519, [1u8; 32]).unwrap();
        let secp = IdentityKey::from_seed(Curve::Secp256k1, [2u8; 32]).unwrap();
        ks.insert("device", &ed);
        ks.insert("wallet", &secp);
        assert_eq!(ks.len(), 2);
        assert!(ks.contains("device"));
        assert_eq!(ks.list(), vec!["device", "wallet"]); // sorted

        let got = ks.get("wallet").unwrap().unwrap();
        assert_eq!(got.to_seed(), secp.to_seed());
        assert_eq!(got.did().unwrap(), secp.did().unwrap());

        assert!(ks.remove("device"));
        assert!(!ks.contains("device"));
        assert_eq!(ks.len(), 1);
    }

    #[test]
    fn seal_open_roundtrip_and_determinism() {
        let mut ks = Keystore::new();
        ks.insert(
            "wallet",
            &IdentityKey::from_seed(Curve::Secp256k1, [3u8; 32]).unwrap(),
        );
        ks.insert(
            "device",
            &IdentityKey::from_seed(Curve::Ed25519, [4u8; 32]).unwrap(),
        );

        let pass = b"correct horse battery staple";
        let blob = ks.seal(pass, &SALT, &NONCE, ROUNDS).unwrap();
        // Deterministic: identical inputs → identical ciphertext.
        let blob2 = ks.seal(pass, &SALT, &NONCE, ROUNDS).unwrap();
        assert_eq!(blob, blob2);

        let opened = Keystore::from_sealed(pass, &SALT, &NONCE, ROUNDS, &blob).unwrap();
        assert_eq!(opened.list(), ks.list());
        for alias in ks.list() {
            assert_eq!(
                opened.get(&alias).unwrap().unwrap().to_seed(),
                ks.get(&alias).unwrap().unwrap().to_seed()
            );
        }
    }

    #[test]
    fn wrong_pass_or_tamper_fails_closed() {
        let mut ks = Keystore::new();
        ks.insert(
            "wallet",
            &IdentityKey::from_seed(Curve::Secp256k1, [5u8; 32]).unwrap(),
        );
        let blob = ks.seal(b"right", &SALT, &NONCE, ROUNDS).unwrap();
        assert!(Keystore::from_sealed(b"wrong", &SALT, &NONCE, ROUNDS, &blob).is_err());

        // Flip one ciphertext byte → authentication must fail.
        let mut tampered = blob.clone();
        tampered[0] ^= 0x01;
        assert!(Keystore::from_sealed(b"right", &SALT, &NONCE, ROUNDS, &tampered).is_err());
    }

    #[test]
    fn derive_key_is_deterministic_and_secret_sensitive() {
        let a = derive_key(b"pw", &SALT, ROUNDS);
        let b = derive_key(b"pw", &SALT, ROUNDS);
        let c = derive_key(b"pw2", &SALT, ROUNDS);
        let d = derive_key(b"pw", &[8u8; 16], ROUNDS);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
    }
}
