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
