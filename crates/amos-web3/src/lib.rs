//! `amos-web3` — deterministic Web3 / EVM digital-signature domain core.
//!
//! A phone wallet needs to *prove* things — "this device controls address X",
//! "I consent to Y" — using the same primitives the open Web3 ecosystem speaks:
//! secp256k1 keys, keccak256, EVM addresses, and the two message-signing
//! standards dApps actually accept ([EIP-191] `personal_sign` and [EIP-712]
//! typed structured data).
//!
//! ```text
//!   32-byte seed ─▶ [SecretKey] ─▶ [PublicKey] ─▶ EVM address (0x…)
//!        │  (deterministic, no PRNG)         │
//!        └─ sign_prehash ─▶ (r, s, v)        └─ EIP-191 personal_sign / EIP-712
//!                                            recover signer & verify
//! ```
//!
//! # Determinism & entropy (honest seam)
//!
//! The whole core is **deterministic**: a key comes from a 32-byte seed used
//! directly as the secp256k1 secret scalar, so the exact same seed always
//! yields the exact same key, address and signature (ECDSA nonces follow
//! RFC 6979). There is deliberately **no randomness inside the crate**.
//! Generating a *new* wallet is therefore a seam: the caller must supply 32
//! bytes of OS entropy (see [`SecretKey::from_seed`] and
//! `docs/identity-web3.md`). Nothing here invents randomness that a
//! hardware/OS keystore should be the authority on. Seeds outside `[1, n-1]`
//! are rejected rather than silently remapped.
//!
//! [EIP-191]: https://eips.ethereum.org/EIPS/eip-191
//! [EIP-712]: https://eips.ethereum.org/EIPS/eip-712
//!
//! Design: `docs/identity-web3.md`.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod bytes;
pub mod eip191;
pub mod eip712;
pub mod error;
pub mod hash;
pub mod secp;
