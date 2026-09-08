//! The [`NetworkGuard`] seam + a deterministic [`MockNetworkGuard`].
//!
//! This is the single external seam a transport layer (gRPC service, Tauri bridge,
//! or a future `VpnService`/nftables backend) talks to — mirroring
//! `amos-telephony`'s `TelephonyProvider` and `amos-monitor`'s `SystemSampler`.
//! The domain core decides *policy*; the seam decides *enforcement*, so the
//! enforcement layer stays swappable between a rootless `VpnService`, an
//! AOSP/rooted nftables backend, or the Mock in tests.

use std::sync::{Arc, Mutex};

use crate::error::Result;
use crate::policy::Policy;

/// A backend that can install and clear egress [`Policy`] rules for a uid.
///
/// Implementations must fail **explicitly** when they cannot enforce (e.g. not yet
/// wired on the current host) — never silently report success.
pub trait NetworkGuard: Send + Sync {
    /// Install (or refresh) the given policies on the underlying gate.
    fn apply(&self, policies: &[Policy]) -> Result<()>;
    /// Clear all rules installed by this guard.
    fn flush(&self) -> Result<()>;
}

/// Deterministic test/demo backend: records what was applied and always succeeds.
#[derive(Debug, Default)]
pub struct MockNetworkGuard {
    applied: Arc<Mutex<Vec<Policy>>>,
}

impl MockNetworkGuard {
    /// A fresh mock with no recorded policies.
    pub fn new() -> Self {
        Self::default()
    }

    /// A snapshot of every policy applied so far, in order.
    pub fn applied(&self) -> Vec<Policy> {
        lock(&self.applied).clone()
    }

    /// Number of policies applied so far.
    pub fn applied_count(&self) -> usize {
        lock(&self.applied).len()
    }
}

impl NetworkGuard for MockNetworkGuard {
    fn apply(&self, policies: &[Policy]) -> Result<()> {
        lock(&self.applied).extend_from_slice(policies);
        Ok(())
    }

    fn flush(&self) -> Result<()> {
        lock(&self.applied).clear();
        Ok(())
    }
}

/// Lock a `Mutex`, recovering from poison instead of panicking (P0-1 gate).
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{Destination, Effect};

    #[test]
    fn mock_records_applied_policies_in_order() {
        let guard = MockNetworkGuard::new();
        assert_eq!(guard.applied_count(), 0);

        let rules = vec![
            Policy::block(1000, Destination::domain("tracker.example")),
            Policy {
                uid: 2000,
                effect: Effect::Block,
                destination: Destination::domain("cdn.example"),
            },
        ];
        guard.apply(&rules).unwrap();
        assert_eq!(guard.applied_count(), 2);
        assert_eq!(guard.applied(), rules);
    }

    #[test]
    fn mock_flush_clears_records() {
        let guard = MockNetworkGuard::new();
        guard
            .apply(&[Policy::block(1, Destination::domain("x.example"))])
            .unwrap();
        assert_eq!(guard.applied_count(), 1);
        guard.flush().unwrap();
        assert!(guard.applied().is_empty());
    }
}
