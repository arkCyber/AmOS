//! Uninstall **safety policy** — deciding which packages may be removed.
//!
//! The phone manager never uninstalls on its own authority. It asks this guard
//! for a [`UninstallVerdict`] and, on a refusal, shows the matching
//! [`UninstallVerdict::reason_key`] instead of a destructive button. Two
//! independent protections stack:
//!
//! 1. **Platform-bundled** packages (`AppPackage::system`) are refused, because
//!    removing one can render the device unbootable or break core services.
//! 2. A **pinned critical set** ([`CRITICAL_PACKAGES`], extendable per device)
//!    is refused *even when the platform would allow it* — the System UI, the
//!    settings surface and the phone manager itself must never be removable
//!    from inside their own product.
//!
//! The guard is pure data + a pure function, so the policy is auditable and
//! testable without a device.

use crate::spec::{AppPackage, UninstallVerdict};

/// Packages the device-care app will never offer for uninstall.
///
/// A platform integration may extend this (e.g. carrier/vendor packages) via
/// [`UninstallGuard::with_critical`]; it may not shrink it from the UI.
pub const CRITICAL_PACKAGES: &[&str] = &[
    // AmOS surfaces that must survive their own manager.
    "com.amos.systemui",
    "com.amos.devocare",
    "com.amos.settings",
    "com.amos.ai",
    // Platform surfaces whose removal bricks or strands a device.
    "com.android.systemui",
    "com.android.settings",
    "com.android.permissioncontroller",
    "com.android.packageinstaller",
];

/// Decides whether a package may be uninstalled.
#[derive(Debug, Clone)]
pub struct UninstallGuard {
    critical: Vec<String>,
}

impl Default for UninstallGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl UninstallGuard {
    /// A guard with the built-in [`CRITICAL_PACKAGES`] set.
    pub fn new() -> Self {
        Self {
            critical: CRITICAL_PACKAGES.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    /// A guard with the built-in set plus device-specific extras.
    pub fn with_critical(extra: impl IntoIterator<Item = String>) -> Self {
        let mut guard = Self::new();
        guard.critical.extend(extra);
        guard
    }

    /// Whether `id` is in the pinned critical set (case-sensitive, exact match).
    pub fn is_critical(&self, id: &str) -> bool {
        self.critical.iter().any(|c| c == id)
    }

    /// The verdict for one package. `Protected` outranks `SystemApp`.
    pub fn verdict(&self, pkg: &AppPackage) -> UninstallVerdict {
        if self.is_critical(&pkg.id) {
            UninstallVerdict::Protected
        } else if pkg.system {
            UninstallVerdict::SystemApp
        } else {
            UninstallVerdict::Allowed
        }
    }

    /// The packages in `pkgs` a UI may actually offer to uninstall, in input
    /// order.
    pub fn selectable<'a>(&self, pkgs: &'a [AppPackage]) -> Vec<&'a AppPackage> {
        pkgs.iter()
            .filter(|p| self.verdict(p).is_allowed())
            .collect()
    }

    /// The packages that are **not** removable, paired with the reason.
    pub fn blocked<'a>(&self, pkgs: &'a [AppPackage]) -> Vec<(&'a AppPackage, UninstallVerdict)> {
        pkgs.iter()
            .map(|p| (p, self.verdict(p)))
            .filter(|(_, v)| !v.is_allowed())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_user_app_is_removable() {
        let g = UninstallGuard::new();
        let p = AppPackage::new("com.example.notes", "Notes");
        assert_eq!(g.verdict(&p), UninstallVerdict::Allowed);
        assert!(g.verdict(&p).reason_key().is_none());
    }

    #[test]
    fn a_platform_bundled_app_is_refused() {
        let g = UninstallGuard::new();
        let p = AppPackage::new("com.vendor.weather", "Weather").system(true);
        assert_eq!(g.verdict(&p), UninstallVerdict::SystemApp);
        assert_eq!(g.verdict(&p).reason_key(), Some("care.uninstall.systemApp"));
    }

    #[test]
    fn a_critical_app_is_refused_even_when_not_flagged_system() {
        let g = UninstallGuard::new();
        let p = AppPackage::new("com.amos.devocare", "手机管家");
        assert_eq!(g.verdict(&p), UninstallVerdict::Protected);
        assert_eq!(g.verdict(&p).reason_key(), Some("care.uninstall.protected"));
    }

    #[test]
    fn protected_outranks_system() {
        let g = UninstallGuard::new();
        let p = AppPackage::new("com.android.settings", "Settings").system(true);
        assert_eq!(g.verdict(&p), UninstallVerdict::Protected);
    }

    #[test]
    fn the_builtin_set_covers_the_manager_and_core_surfaces() {
        let g = UninstallGuard::new();
        for id in CRITICAL_PACKAGES {
            assert!(g.is_critical(id), "{id} must be critical");
        }
    }

    #[test]
    fn device_extras_extend_without_shrinking_the_defaults() {
        let g = UninstallGuard::with_critical(["com.carrier.bloat".to_string()]);
        assert!(g.is_critical("com.carrier.bloat"));
        assert!(g.is_critical("com.amos.devocare"));
    }

    #[test]
    fn selectable_filters_and_blocked_explains() {
        let g = UninstallGuard::new();
        let pkgs = vec![
            AppPackage::new("com.example.game", "Game"),
            AppPackage::new("com.amos.settings", "Settings").system(true),
            AppPackage::new("com.vendor.app", "Bloat").system(true),
            AppPackage::new("com.example.todo", "Todo"),
        ];
        let selectable = g.selectable(&pkgs);
        assert_eq!(selectable.len(), 2);
        assert_eq!(selectable[0].id, "com.example.game");
        assert_eq!(selectable[1].id, "com.example.todo");

        let blocked = g.blocked(&pkgs);
        assert_eq!(blocked.len(), 2);
        assert_eq!(blocked[0].1, UninstallVerdict::Protected);
        assert_eq!(blocked[1].1, UninstallVerdict::SystemApp);
    }

    #[test]
    fn an_empty_catalogue_yields_nothing() {
        let g = UninstallGuard::new();
        assert!(g.selectable(&[]).is_empty());
        assert!(g.blocked(&[]).is_empty());
    }
}
