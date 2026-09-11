//! Sensitive-permission **review** — grouping grants by app, honestly.
//!
//! This is a *read-only* view: the device-care app displays who holds what, and
//! links to the authoritative permission surface. It never grants or revokes by
//! itself (that stays with the daemon-backed privacy ledger, see
//! `docs/permissions-sandbox-audit-plan.md`), so the worst a bug here can do is
//! show a wrong label — never change access.

use std::collections::BTreeMap;

use crate::spec::{PermissionGrant, SensitiveAppRow, SensitiveResource};

/// Maximum number of apps a single review returns.
pub const MAX_REVIEW_APPS: usize = 500;

/// Group granted sensitive permissions by app.
///
/// * **Denied grants are ignored** — a row only ever shows what an app actually
///   holds, so the view can never overstate access.
/// * Entries with an empty `app_id` are dropped (unattributable access is not
///   shown as if it belonged to someone).
/// * Resources are deduplicated in [`SensitiveResource::ALL`] order and rows are
///   sorted by `app_id`, so two reviews of the same data are identical.
/// * Bounded by [`MAX_REVIEW_APPS`]. This view is informational (nothing
///   destructive depends on it), so an over-large input is truncated rather
///   than refused — and the truncation is observable from the returned length.
pub fn review_grants(grants: &[PermissionGrant]) -> Vec<SensitiveAppRow> {
    let mut by_app: BTreeMap<String, Vec<SensitiveResource>> = BTreeMap::new();
    for g in grants {
        if !g.granted || g.app_id.is_empty() {
            continue;
        }
        let entry = by_app.entry(g.app_id.clone()).or_default();
        if !entry.contains(&g.resource) {
            entry.push(g.resource);
        }
    }

    let mut rows: Vec<SensitiveAppRow> = by_app
        .into_iter()
        .map(|(app_id, mut resources)| {
            resources.sort();
            SensitiveAppRow { app_id, resources }
        })
        .collect();
    rows.truncate(MAX_REVIEW_APPS);
    rows
}

/// The number of distinct `(app, resource)` pairs currently granted.
///
/// Feeds the care report's permission signal without inventing a judgement the
/// domain cannot make (no usage data ⇒ no "unused permission" claim).
pub fn granted_resource_count(grants: &[PermissionGrant]) -> usize {
    let mut seen: std::collections::BTreeSet<(&str, SensitiveResource)> =
        std::collections::BTreeSet::new();
    for g in grants {
        if g.granted && !g.app_id.is_empty() {
            seen.insert((g.app_id.as_str(), g.resource));
        }
    }
    seen.len()
}

/// The apps currently holding `resource`, sorted, deduplicated and bounded.
pub fn apps_holding(grants: &[PermissionGrant], resource: SensitiveResource) -> Vec<String> {
    let mut apps: Vec<String> = grants
        .iter()
        .filter(|g| g.granted && g.resource == resource && !g.app_id.is_empty())
        .map(|g| g.app_id.clone())
        .collect();
    apps.sort();
    apps.dedup();
    apps.truncate(MAX_REVIEW_APPS);
    apps
}

#[cfg(test)]
mod tests {
    use super::*;

    use SensitiveResource as R;

    #[test]
    fn groups_granted_resources_by_app_and_ignores_denied() {
        let grants = vec![
            PermissionGrant::granted("com.b", R::Camera),
            PermissionGrant::denied("com.b", R::Microphone),
            PermissionGrant::granted("com.a", R::Location),
            PermissionGrant::granted("com.a", R::Camera),
        ];
        let rows = review_grants(&grants);
        assert_eq!(rows.len(), 2);
        // BTreeMap order → app id ascending.
        assert_eq!(rows[0].app_id, "com.a");
        assert_eq!(rows[0].resources, vec![R::Camera, R::Location]);
        assert_eq!(rows[1].app_id, "com.b");
        assert_eq!(rows[1].resources, vec![R::Camera]);
    }

    #[test]
    fn duplicates_are_deduplicated() {
        let grants = vec![
            PermissionGrant::granted("com.a", R::Camera),
            PermissionGrant::granted("com.a", R::Camera),
        ];
        let rows = review_grants(&grants);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].count(), 1);
    }

    #[test]
    fn unattributable_grants_are_dropped() {
        let grants = vec![
            PermissionGrant::granted("", R::Camera),
            PermissionGrant::granted("com.a", R::Sms),
        ];
        let rows = review_grants(&grants);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].app_id, "com.a");
    }

    #[test]
    fn a_review_of_only_denials_is_empty() {
        let grants = vec![PermissionGrant::denied("com.a", R::Phone)];
        assert!(review_grants(&grants).is_empty());
        assert_eq!(granted_resource_count(&grants), 0);
    }

    #[test]
    fn review_is_deterministic() {
        let grants = vec![
            PermissionGrant::granted("com.b", R::Storage),
            PermissionGrant::granted("com.a", R::Camera),
            PermissionGrant::granted("com.b", R::Camera),
        ];
        assert_eq!(review_grants(&grants), review_grants(&grants));
    }

    #[test]
    fn review_is_bounded() {
        let grants: Vec<PermissionGrant> = (0..MAX_REVIEW_APPS + 5)
            .map(|i| PermissionGrant::granted(format!("com.app{i:04}"), R::Camera))
            .collect();
        let rows = review_grants(&grants);
        assert_eq!(rows.len(), MAX_REVIEW_APPS);
        // Truncation keeps the lexicographically smallest ids (deterministic).
        assert_eq!(rows[0].app_id, "com.app0000");
    }

    #[test]
    fn granted_resource_count_counts_distinct_pairs() {
        let grants = vec![
            PermissionGrant::granted("com.a", R::Camera),
            PermissionGrant::granted("com.a", R::Camera),
            PermissionGrant::granted("com.b", R::Camera),
            PermissionGrant::denied("com.c", R::Camera),
        ];
        assert_eq!(granted_resource_count(&grants), 2);
    }

    #[test]
    fn apps_holding_filters_sorts_and_dedups() {
        let grants = vec![
            PermissionGrant::granted("com.b", R::Camera),
            PermissionGrant::granted("com.a", R::Camera),
            PermissionGrant::granted("com.a", R::Camera),
            PermissionGrant::granted("com.a", R::Sms),
        ];
        assert_eq!(apps_holding(&grants, R::Camera), vec!["com.a", "com.b"]);
        assert_eq!(apps_holding(&grants, R::Sms), vec!["com.a"]);
        assert!(apps_holding(&grants, R::Phone).is_empty());
    }
}
