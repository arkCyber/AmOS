//! `amos-identity` — Amos digital-identity / DID domain core.
//!
//! Gives a phone an addressable, self-sovereign identity in the open Web3
//! sense: a [W3C `did:key`] Decentralized Identifier derived from a key pair,
//! plus a small deterministic key core and a password-wrapped at-rest keystore.
//!
//! ```text
//!          32-byte seed (entropy seam)
//!                 │
//!        ┌────────┴─────────┐
//!        ▼                  ▼
//!  [IdentityKey]       [Keystore]  (alias → key, optional passphrase)
//!   Ed25519 | Secp256k1        │
//!        │  (via amos-web3)    └─ wrap_seed / unwrap_seed (PBKDF2 + ChaCha20)
//!        ▼
//!   did:key (did:key:z…)
//!        │
//!        └─ sign/verify a statement against the DID
//! ```
//!
//! * [`key`] — `Curve { Ed25519, Secp256k1 }`, an [`IdentityKey`] built from a
//!   seed, and Ed25519 signing.
//! * [`did`] — `did:key` encode/parse for the `ed25519-pub` (`0xed01`) and
//!   `secp256k1-pub` (`0xe701`) multicodecs, base58btc multibase.
//! * [`sign`] — sign a statement with an identity and verify that signature
//!   against a `did:key`.
//! * [`keystore`] — in-memory wallet keyed by alias, with deterministic
//!   password-wrapped at-rest encryption (nonce/salt are explicit caller
//!   seams — see below).
//!
//! # Entropy & at-rest seams (honest boundary)
//!
//! Mirroring `amos-web3` and the rest of Amos, **no randomness lives in this
//! crate**. Keys come from caller-supplied 32-byte seeds, and at-rest
//! encryption needs a per-write random nonce + salt — both are *parameters*
//! that an OS/hardware keystore (or the host System-UI layer) must supply.
//! Tests use fixed values; production callers must draw them from OS entropy.
//! Nothing here invents entropy that the platform should own.
//!
//! Design: `docs/identity-web3.md`.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod did;
pub mod error;
pub mod key;
pub mod keystore;
pub mod sign;

pub use error::{Error, Result};
pub use key::{Curve, Ed25519Key, IdentityKey};
