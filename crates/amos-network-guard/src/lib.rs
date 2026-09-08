//! `amos-network-guard` — AmOS **egress data-plane firewall** domain core.
//!
//! Mirrors the rest of AmOS: a transport-/platform-agnostic **domain core** with a
//! provider seam and a deterministic Mock, host-testable with zero root/device.
//! Scope (honest, per `docs/anti-telemetry-egress-guard.md` §2.1): this gates and
//! audits the **Android userspace / app data plane**. It cannot reach the modem /
//! baseband (a separate processor/trust domain), so it does **not** claim to
//! "block the SoC's own backhaul".
//!
//! ```text
//!   [ NetworkGuard seam ]┐
//!     Mock               │   ┌───────────────────────────────┐
//!     VpnService (rootless)├─▶│  RuleSet → apply → gate       │──▶ Policy / audit
//!     nftables (AOSP/root) │  └───────────────────────────────┘   (wire / UI)
//!     …                  ┘
//! ```
//!
//! Crate layout:
//! * [`policy`] — the pure, host-testable rule model: [`Destination`] (Domain /
//!   `Ip` / TLS SNI — deliberately **not** raw URL strings, which iptables `-d`
//!   cannot match), [`Policy`] (uid + effect + destination), and a [`RuleSet`]
//!   with first-match-wins evaluation.
//! * [`guard`] — the [`NetworkGuard`] seam + deterministic [`MockNetworkGuard`].
//! * [`audit`] — structured outbound events ([`EgressEvent`]) + a running
//!   [`audit::EgressCounter`] of per-uid/per-domain bytes.
//! * [`error`] — a small no-panic error type.
//!
//! Feature gates (pure `std` by default):
//! * `vpn` — `VpnNetworkGuard` (src/vpn.rs): the **rootless** Android path, reserved.
//! * `nftables` — `NftablesNetworkGuard` (src/nftables.rs): the **AOSP/rooted** path,
//!   reserved.
//!
//! Design: `docs/anti-telemetry-egress-guard.md` §3.1 / §3.2 / §5.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod audit;
pub mod error;
pub mod guard;
pub mod policy;

#[cfg(feature = "nftables")]
pub mod nftables;
#[cfg(feature = "vpn")]
pub mod vpn;

pub use audit::{EgressCounter, EgressEvent, EgressKind};
pub use error::{Error, Result};
pub use guard::{MockNetworkGuard, NetworkGuard};
pub use policy::{normalize_domain, Destination, Effect, Policy, RuleSet};

#[cfg(feature = "nftables")]
pub use nftables::NftablesNetworkGuard;
#[cfg(feature = "vpn")]
pub use vpn::VpnNetworkGuard;
