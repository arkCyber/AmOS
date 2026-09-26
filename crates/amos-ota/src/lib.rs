//! `amos-ota` — the system-update (over-the-air) domain core for Amos.
//!
//! A phone OS that cannot update itself cannot be secured after it ships, and
//! `docs/FEATURE_GAP_AUDIT_2026_SEP20.md` (§3, OTA row) recorded that AmOS had
//! **no** update path at all — `grep -rn 'updater'` was a zero hit. This crate
//! is the missing *decision layer*: given a manifest of offered images and a set
//! of device facts, it answers three questions deterministically and honestly:
//!
//! 1. **Is there an update for me?** — [`spec::Manifest`] + SemVer-correct
//!    precedence ([`version::Version`]), scoped to a [`spec::Channel`] and a
//!    deterministic staged-rollout [`spec::Cohort`].
//! 2. **May I install it right now?** — [`policy::evaluate`] folds the channel,
//!    prerelease/signature policy, cohort, maintenance window, Wi-Fi and battery
//!    into an [`policy::Decision`]. "I do not know" (an unreadable battery level)
//!    is a *deferral*, never an accidental "yes".
//! 3. **Did the bytes arrive intact?** — [`verify`] hashes the payload against
//!    the published SHA-256 and checks a detached signature through a
//!    [`verify::SignatureVerifier`] seam. Nothing is staged unless the digest
//!    matched.
//!
//! The install itself is an explicit state machine ([`install::InstallMachine`])
//! whose single invariant is that [`install::InstallState::Staged`] is reachable
//! **only** from a verified payload — there is no shortcut around the hash.
//!
//! ```text
//!   UpdateProvider ──manifest──▶ policy::evaluate ──Eligible──▶ fetch_package
//!        (seam)                       │                            │
//!                                 Deferred/Refused            verify::check_integrity
//!                                                                    │ Verified
//!                                                          install::InstallMachine ──▶ Staged
//! ```
//!
//! ## What is *not* here (the honest boundary)
//!
//! * **The network** — [`provider::UpdateProvider`] is the seam; only a
//!   deterministic [`provider::MockUpdateProvider`] ships.
//! * **Cryptography** — [`verify::TrustingVerifier`] checks *policy* (is this key
//!   trusted, is the signature shaped like one), **not** the mathematics, and is
//!   for tests / the CLI's `--trusting` mode only. [`verify::Ed25519Verifier`] is
//!   the **real** one: RFC 8032 over a caller-supplied table of trusted public
//!   keys, pinned against the RFC's own vectors. ECDSA is not offered; a
//!   deployment needing it implements the same [`verify::SignatureVerifier`] seam.
//! * **The deployment** — writing the image to the A/B slot, arming the bootloader
//!   and rebooting is the runtime's (`PackageInstaller` on Android, a Tauri
//!   updater on desktop). This crate decides and tracks; it does not flash.
//!
//! Everything else is `std` + `sha2` + `ed25519-dalek`: no clock, no I/O, no
//! runtime, fully offline-testable.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]
#![forbid(unsafe_code)]

pub mod error;
pub mod install;
pub mod policy;
pub mod provider;
pub mod spec;
pub mod verify;
pub mod version;

pub use error::{OtaError, Result};
pub use install::{FailReason, InstallMachine, InstallState, UntrustedSignaturePolicy};
pub use policy::{evaluate, Decision, DeviceFacts, Reason as PolicyReason, UpdatePolicy};
pub use provider::{MockUpdateProvider, UpdateProvider};
pub use spec::{Channel, Cohort, Manifest, Signature, UpdatePackage, MAX_PACKAGE_BYTES};
pub use verify::{
    check_integrity, sha256_hex, verify_signature, Ed25519Verifier, IntegrityVerdict,
    SignatureVerdict, SignatureVerifier, TrustingVerifier,
};
pub use version::Version;
