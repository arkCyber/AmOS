//! **AOSP / rooted** egress gate (`nftables` feature) — reserved skeleton.
//!
//! True kernel firewall enforcement (`iptables`/`nftables`) is only possible where
//! AmOS runs as a system component with root / its own SELinux domain — a *custom
//! AOSP* build, **not** a stock device and **not** this crate's default. Until that
//! slot exists every call fails explicitly with [`Error::NotOnDevice`]; no code here
//! shells out to `iptables` with `-d <url>` (which cannot work — `-d` takes an IP,
//! not a URL, see `docs/anti-telemetry-egress-guard.md` §2.2).
//!
//! `cargo check -p amos-network-guard --features nftables` validates it compiles;
//! real enforcement is an AOSP/system-component step.

use crate::error::{Error, Result};
use crate::guard::NetworkGuard;
use crate::policy::Policy;

/// AOSP/rooted `nftables`-backed gate (to be wired in the system-component build).
#[derive(Debug, Default)]
pub struct NftablesNetworkGuard;

impl NftablesNetworkGuard {
    /// Construct the (not-yet-wired) rooted guard.
    pub fn new() -> Self {
        Self
    }
}

impl NetworkGuard for NftablesNetworkGuard {
    fn apply(&self, _policies: &[Policy]) -> Result<()> {
        Err(Error::NotOnDevice(
            "nftables path needs a rooted / custom-AOSP system-component slot (not wired)",
        ))
    }

    fn flush(&self) -> Result<()> {
        Err(Error::NotOnDevice(
            "nftables path needs a rooted / custom-AOSP system-component slot (not wired)",
        ))
    }
}
