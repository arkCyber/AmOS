//! **Rootless** Android egress gate (`vpn` feature) — reserved skeleton.
//!
//! On a stock / non-rooted device the only API that can enforce per-app /
//! per-destination rules *and* observe the traffic is Android **`VpnService`**
//! (the same mechanism NetGuard uses). This module is that future seam.
//!
//! Status — **honest skeleton** (mirrors `amos-telephony`'s feature-gated
//! `android.rs`): driving a real `VpnService` requires a running Android
//! `Context` + a `VpnService` session on the device, so it is deliberately **not**
//! wired here. Until then every call fails with [`Error::NotOnDevice`] rather than
//! pretending to block traffic. The pure policy ([`crate::policy`]) and audit
//! ([`crate::audit`]) logic it will consume is already host-tested.
//!
//! `cargo check -p amos-network-guard --features vpn` validates it *compiles*;
//! runtime is a device bring-up step (`docs/anti-telemetry-egress-guard.md` §5).

use crate::error::{Error, Result};
use crate::guard::NetworkGuard;
use crate::policy::Policy;

/// Rootless `VpnService`-backed gate (to be wired on device).
#[derive(Debug, Default)]
pub struct VpnNetworkGuard;

impl VpnNetworkGuard {
    /// Construct the (not-yet-wired) rootless guard.
    pub fn new() -> Self {
        Self
    }
}

impl NetworkGuard for VpnNetworkGuard {
    fn apply(&self, _policies: &[Policy]) -> Result<()> {
        Err(Error::NotOnDevice(
            "VpnService bridge is a device bring-up step (needs a Context + running VpnService)",
        ))
    }

    fn flush(&self) -> Result<()> {
        Err(Error::NotOnDevice(
            "VpnService bridge is a device bring-up step (needs a Context + running VpnService)",
        ))
    }
}
