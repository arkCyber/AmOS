//! 「内存加速」**policy** — which lifecycle tiers a memory boost may reclaim.
//!
//! Every Android phone manager offers a one-tap memory boost. The engineering
//! question is not the readout but *what it is allowed to touch*. This module
//! answers that with the same discipline as the cleaner: the safety property
//! holds **by construction** — only the two reclaimable tiers of
//! `docs/app-lifecycle.md` are ever named, so no bug can select the app the user
//! is looking at.
//!
//! | lifecycle tier | reclaimable | why |
//! |---|---|---|
//! | `foreground` / `visible` / `foreground_service` | **never** | the user is looking at it, just left it visible, or it is playing media / in a call |
//! | `cached` (tombstone) | **yes — first** | frozen with saved state; the documented prime reclaim target |
//! | `background` | **yes — after** | running but invisible; freeze/kill eligible |
//! | `stopped` / unknown | no | not running — nothing to reclaim |

/// The governor lifecycle keys a boost treats as reclaimable, in reclaim order.
///
/// The order is the policy: `cached` tombstones go first because they are
/// already frozen with saved state (cheapest to free, cheapest to resume).
pub const RECLAIMABLE_STATES: [&str; 2] = ["cached", "background"];

/// Whether a lifecycle key may be reclaimed by a memory boost.
///
/// Anything not in [`RECLAIMABLE_STATES`] — including the protected tiers, an
/// empty key, and any key a future governor invent — is **not** reclaimable.
/// Unknown means "leave it alone", never "probably fine".
pub fn is_reclaimable(state_key: &str) -> bool {
    RECLAIMABLE_STATES.contains(&state_key)
}

/// The reclaim order for a lifecycle key (`None` = never reclaimed).
pub fn reclaim_rank(state_key: &str) -> Option<u8> {
    RECLAIMABLE_STATES
        .iter()
        .position(|k| *k == state_key)
        .map(|i| i as u8)
}

/// Plan a boost over the governor's app list.
///
/// `apps` is `(app_id, lifecycle_key)` in the governor's order. Returns the ids
/// to reclaim, **cached before background**, stable within a tier (input order
/// preserved) — so the same snapshot always yields the same plan, and a
/// protected tier is never selected.
pub fn reclaim_plan(apps: &[(String, String)]) -> Vec<String> {
    let mut selected: Vec<&(String, String)> = apps
        .iter()
        .filter(|(_, state)| is_reclaimable(state))
        .collect();
    // `sort_by_key` is stable, so equal ranks keep the input order.
    selected.sort_by_key(|(_, state)| reclaim_rank(state).unwrap_or(u8::MAX));
    selected.into_iter().map(|(id, _)| id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(id, s)| ((*id).to_string(), (*s).to_string()))
            .collect()
    }

    #[test]
    fn the_protected_tiers_are_never_reclaimable() {
        // The whole safety property: what the user is using (or hearing) is off
        // limits, by construction.
        for state in ["foreground", "visible", "foreground_service"] {
            assert!(!is_reclaimable(state), "{state} must never be reclaimed");
            assert_eq!(reclaim_rank(state), None);
        }
    }

    #[test]
    fn only_cached_and_background_are_reclaimable() {
        assert!(is_reclaimable("cached"));
        assert!(is_reclaimable("background"));
        // Not running / unknown keys are left alone, not guessed at.
        for state in ["stopped", "unknown", "", "CACHED", "cached "] {
            assert!(!is_reclaimable(state), "{state:?} must not be reclaimed");
        }
    }

    /// `RECLAIMABLE_STATES` is documented as "the two reclaimable tiers of
    /// `docs/app-lifecycle.md`", but the tiers are owned in code by the lifecycle
    /// kernel `amos-applife` (`AppState::is_reclaimable()` over the wire keys from
    /// `AppState::key()`). Nothing bound the two: the test above only compared the
    /// constant against its own literals, so a tier renamed or split on the kernel
    /// side left the boost policy silently disagreeing — reclaiming a tier the
    /// kernel protects, or refusing one it frees. Read the authority's source and
    /// require the exact same key set (REQ-A655 / F-SH-122).
    #[test]
    fn reclaimable_states_equal_the_app_lifecycle_kernel_tiers() {
        const SPEC: &str = include_str!("../../amos-applife/src/spec.rs");

        // 1. The `AppState::key()` wire keys: variant name → stable key.
        let at = SPEC
            .find("pub fn key(self) -> &'static str {")
            .expect("AppState::key() not found");
        let rest = &SPEC[at..];
        let key_body = &rest[..rest.find("\n    }").expect("key() body not closed")];
        let mut key_of: std::collections::BTreeMap<&str, &str> = std::collections::BTreeMap::new();
        for (i, _) in key_body.match_indices("AppState::") {
            let arm = &key_body[i + "AppState::".len()..];
            let variant = &arm[..arm.find(" =>").expect("variant not followed by =>")];
            let after = &arm[arm.find("=> \"").expect("arm has no string key") + 4..];
            let key = &after[..after.find('"').expect("unterminated key literal")];
            key_of.insert(variant, key);
        }
        // Vacuity guard: a rewrite that moves the arms out of the scanned window
        // must fail loudly rather than compare against an empty map.
        assert_eq!(
            key_of.len(),
            6,
            "expected six AppState keys, parsed {key_of:?}"
        );

        // 2. The variants `AppState::is_reclaimable()` actually admits, mapped to
        //    their wire keys.
        let at = SPEC
            .find("pub fn is_reclaimable(self) -> bool {")
            .expect("AppState::is_reclaimable() not found");
        let rest = &SPEC[at..];
        let rec_body = &rest[..rest
            .find("\n    }")
            .expect("is_reclaimable() body not closed")];
        let mut expected: Vec<&str> = rec_body
            .match_indices("AppState::")
            .map(|(i, _)| {
                let arm = &rec_body[i + "AppState::".len()..];
                let end = arm
                    .find(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .unwrap_or(arm.len());
                let variant = &arm[..end];
                *key_of
                    .get(variant)
                    .unwrap_or_else(|| panic!("unknown AppState variant {variant}"))
            })
            .collect();
        assert_eq!(
            expected.len(),
            2,
            "expected two reclaimable tiers, parsed {expected:?}"
        );
        expected.sort_unstable();

        let mut ours = RECLAIMABLE_STATES.to_vec();
        ours.sort_unstable();
        assert_eq!(
            ours, expected,
            "boost RECLAIMABLE_STATES must equal amos-applife's reclaimable tiers"
        );
    }

    #[test]
    fn a_plan_selects_cached_first_then_background() {
        let plan = reclaim_plan(&apps(&[
            ("bg1", "background"),
            ("fg", "foreground"),
            ("c1", "cached"),
            ("bg2", "background"),
            ("c2", "cached"),
        ]));
        assert_eq!(plan, vec!["c1", "c2", "bg1", "bg2"]);
        assert!(!plan.contains(&"fg".to_string()));
    }

    #[test]
    fn a_plan_is_stable_within_a_tier_and_deterministic() {
        let input = apps(&[("a", "cached"), ("b", "cached"), ("c", "background")]);
        let first = reclaim_plan(&input);
        assert_eq!(first, vec!["a", "b", "c"], "input order kept inside a tier");
        assert_eq!(first, reclaim_plan(&input), "same snapshot ⇒ same plan");
    }

    #[test]
    fn a_plan_over_nothing_reclaimable_is_empty() {
        assert!(reclaim_plan(&[]).is_empty());
        assert!(reclaim_plan(&apps(&[("x", "foreground"), ("y", "stopped")])).is_empty());
    }
}
