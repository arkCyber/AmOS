//! Container-app **capability ledger** — the host-side seam a future per-APK
//! permission interposer / HAL policy hook reads (Phase 5).
//!
//! A third-party APK inside the Waydroid/LXC container cannot currently be
//! intercepted at the `AudioRecord` / `Camera.open` / contacts-read boundary —
//! that is device/ecosystem work (see `docs/lmk-proxy.md` and
//! `docs/permissions-sandbox-audit-plan.md` Phase 5). What this module provides,
//! honestly and offline-testable, is the **decision data**: a deny-by-default,
//! per-package store of which sensitive resources a container app *holds*,
//! keyed by the **same stable wire keys** as the host `PrivacyManager`
//! (`microphone` / `camera` / `contacts` / `location` / `storage`, see
//! `proto/privacy.proto`). A container-side policy hook (or the LMK/`am
//! force-stop` layer) can seed and consult this ledger with no cross-crate
//! dependency on `amos-ai`.
//!
//! Invariant: unknown resource keys are rejected (never weaken deny-by-default);
//! an unknown package is always denied.

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

/// The sensitive-resource wire keys a container app may hold — 1:1 with the host
/// `PrivacyManager::Resource::key()` / `proto/privacy.proto`.
pub const SENSITIVE_RESOURCES: [&str; 5] =
    ["microphone", "camera", "contacts", "location", "storage"];

/// True for a known sensitive-resource key.
pub fn valid_resource_key(s: &str) -> bool {
    SENSITIVE_RESOURCES.contains(&s)
}

/// A deny-by-default, per-package capability store (thread-safe).
#[derive(Debug, Default)]
pub struct CapabilityLedger {
    grants: RwLock<HashMap<String, HashSet<String>>>,
}

impl CapabilityLedger {
    /// A fresh deny-by-default ledger.
    pub fn new() -> Self {
        Self::default()
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, HashSet<String>>> {
        match self.grants.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, HashSet<String>>> {
        match self.grants.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    /// Grant `resource` to `pkg`; returns `false` (no-op) for an unknown key.
    pub fn grant(&self, pkg: &str, resource: &str) -> bool {
        if !valid_resource_key(resource) {
            return false;
        }
        self.write()
            .entry(pkg.to_string())
            .or_default()
            .insert(resource.to_string());
        true
    }

    /// Revoke one `resource` from `pkg`; returns `true` when it was held.
    pub fn revoke(&self, pkg: &str, resource: &str) -> bool {
        if !valid_resource_key(resource) {
            return false;
        }
        let mut g = self.write();
        let Some(set) = g.get_mut(pkg) else {
            return false;
        };
        let removed = set.remove(resource);
        // Drop empty package entries (uninstall/teardown hygiene).
        if removed && set.is_empty() {
            g.remove(pkg);
        }
        removed
    }

    /// Remove every grant for `pkg` (uninstall / sandbox teardown).
    pub fn revoke_all(&self, pkg: &str) {
        self.write().remove(pkg);
    }

    /// Whether `pkg` currently holds `resource` (deny-by-default for unknown).
    pub fn is_granted(&self, pkg: &str, resource: &str) -> bool {
        self.read()
            .get(pkg)
            .map(|s| s.contains(resource))
            .unwrap_or(false)
    }

    /// The resources `pkg` currently holds (sorted, stable).
    pub fn granted(&self, pkg: &str) -> Vec<String> {
        let mut v: Vec<String> = self
            .read()
            .get(pkg)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        v.sort();
        v
    }

    /// Every package with at least one grant (sorted).
    pub fn packages(&self) -> Vec<String> {
        let mut v: Vec<String> = self.read().keys().cloned().collect();
        v.sort();
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_by_default_and_unknown_keys_are_rejected() {
        let l = CapabilityLedger::new();
        assert!(!l.is_granted("com.tencent.mm", "microphone"));
        assert!(l.granted("com.tencent.mm").is_empty());
        assert!(
            !l.grant("com.tencent.mm", "barometer"),
            "unknown key rejected"
        );
        assert!(!l.revoke("com.tencent.mm", "barometer"));
    }

    #[test]
    fn grant_is_granted_revoke_round_trip() {
        let l = CapabilityLedger::new();
        assert!(l.grant("com.tencent.mm", "microphone"));
        assert!(l.is_granted("com.tencent.mm", "microphone"));
        assert!(!l.is_granted("com.tencent.mm", "camera"), "per-resource");
        assert!(l.revoke("com.tencent.mm", "microphone"));
        assert!(!l.is_granted("com.tencent.mm", "microphone"));
    }

    #[test]
    fn packages_are_isolated_and_revoke_all_clears() {
        let l = CapabilityLedger::new();
        l.grant("com.a", "camera");
        l.grant("com.a", "location");
        l.grant("com.b", "contacts");
        assert!(!l.is_granted("com.b", "camera"));
        assert_eq!(l.packages(), vec!["com.a".to_string(), "com.b".to_string()]);

        l.revoke_all("com.a");
        assert!(l.granted("com.a").is_empty());
        assert_eq!(l.packages(), vec!["com.b".to_string()]);
    }

    #[test]
    fn granted_is_sorted_and_stable() {
        let l = CapabilityLedger::new();
        l.grant("com.x", "storage");
        l.grant("com.x", "microphone");
        l.grant("com.x", "camera");
        assert_eq!(
            l.granted("com.x"),
            vec![
                "camera".to_string(),
                "microphone".to_string(),
                "storage".to_string()
            ]
        );
    }

    #[test]
    fn resource_keys_align_with_the_host_wire_keys() {
        assert_eq!(
            SENSITIVE_RESOURCES,
            ["microphone", "camera", "contacts", "location", "storage"]
        );
        for k in SENSITIVE_RESOURCES {
            assert!(valid_resource_key(k));
        }
    }
}
