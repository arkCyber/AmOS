//! Junk scanning, clean **planning** and honest **execution**.
//!
//! The pipeline is deliberately three separate, individually testable steps:
//!
//! ```text
//!   scan (caller)            analyze              plan                 execute
//!   &[JunkItem] ───────▶ JunkReport ─────▶ (no bytes) ──▶ CleanPlan ───────▶ CleanOutcome
//!                                                       (frozen, sorted)   (per-item honest)
//! ```
//!
//! * [`analyze`] folds a raw scan into per-kind totals. It **refuses** an
//!   over-cap scan rather than truncating an input that a destructive operation
//!   would later consume.
//! * [`plan`] validates the user's selection against policy: an empty selection
//!   is refused, a review-only category is refused unless explicitly
//!   acknowledged, and the chosen items are sorted so the same scan always
//!   yields the same plan.
//! * [`execute`] runs the plan through a [`CleanProvider`] and records every
//!   outcome item by item — `freed_bytes` counts **confirmed** removals only.

use std::collections::hash_map::Entry;
use std::collections::HashMap;

use crate::error::{DevCareError, Result};
use crate::provider::CleanProvider;
use crate::spec::{
    CleanFailure, CleanOutcome, CleanPlan, CleanRequest, JunkGroup, JunkItem, JunkKind, JunkReport,
    MAX_CLEAN_BATCH, MAX_JUNK_ITEMS,
};

/// Fold a scan result into per-kind totals.
///
/// Refuses (does not truncate) when the scan exceeds [`MAX_JUNK_ITEMS`]. Group
/// order follows [`JunkKind::ALL`], so two scans of the same data produce
/// byte-identical reports.
pub fn analyze(items: &[JunkItem]) -> Result<JunkReport> {
    if items.len() > MAX_JUNK_ITEMS {
        return Err(DevCareError::TooManyItems {
            found: items.len(),
            cap: MAX_JUNK_ITEMS,
        });
    }

    let mut groups = Vec::new();
    for kind in JunkKind::ALL {
        let mut count = 0usize;
        let mut bytes = 0u64;
        for it in items.iter().filter(|i| i.kind == kind) {
            count += 1;
            bytes = bytes.saturating_add(it.size_bytes);
        }
        if count > 0 {
            groups.push(JunkGroup { kind, count, bytes });
        }
    }

    Ok(JunkReport {
        total_items: items.len(),
        total_bytes: items
            .iter()
            .map(|i| i.size_bytes)
            .fold(0u64, u64::saturating_add),
        groups,
    })
}

/// The auto-cleanable categories actually present in a report, in
/// [`JunkKind::ALL`] order. This is what a "一键清理" button may select on its
/// own — it can never include a review-only category.
pub fn auto_cleanable_kinds(report: &JunkReport) -> Vec<JunkKind> {
    report
        .groups
        .iter()
        .map(|g| g.kind)
        .filter(|k| k.is_auto_cleanable())
        .collect()
}

/// Validate a user selection into a frozen [`CleanPlan`].
///
/// # Refusals (never silent)
/// * Empty selection → [`DevCareError::InvalidArguments`].
/// * A review-only category without [`CleanRequest::acknowledge_review`] →
///   [`DevCareError::InvalidArguments`].
/// * An item with a blank `uri` → [`DevCareError::Refused`] (an unnamed path is
///   not a modelled, cleanable target, so nothing may be deleted for it).
/// * More than [`MAX_CLEAN_BATCH`] matching items → [`DevCareError::BatchTooLarge`].
///
/// # Deduplication
/// A scan that reports the same `uri` more than once yields **one** plan entry
/// for it, carrying the **smallest** claimed size. Deleting the same path twice
/// is wrong, and when the backend disagrees with itself we keep the conservative
/// (smallest) figure so the plan never overstates reclaimable space.
pub fn plan(items: &[JunkItem], request: &CleanRequest) -> Result<CleanPlan> {
    if request.kinds.is_empty() {
        return Err(DevCareError::InvalidArguments(
            "no junk categories selected".to_string(),
        ));
    }

    // Normalize to JunkKind::ALL order and drop duplicates, so the plan does not
    // depend on the order the caller happened to send.
    let selected: Vec<JunkKind> = JunkKind::ALL
        .into_iter()
        .filter(|k| request.kinds.contains(k))
        .collect();

    if !request.acknowledge_review {
        if let Some(kind) = selected.iter().copied().find(|k| k.needs_review()) {
            return Err(DevCareError::InvalidArguments(format!(
                "category '{}' needs explicit review acknowledgement",
                kind.key()
            )));
        }
    }

    // A blank uri can never be deleted; refuse the whole plan rather than skip.
    if let Some(bad) = items
        .iter()
        .filter(|i| selected.contains(&i.kind))
        .find(|i| i.uri.trim().is_empty())
    {
        return Err(DevCareError::Refused {
            uri: bad.uri.clone(),
            reason: "empty uri".to_string(),
        });
    }

    let mut by_uri: HashMap<String, JunkItem> = HashMap::new();
    for item in items.iter().filter(|i| selected.contains(&i.kind)) {
        match by_uri.entry(item.uri.clone()) {
            Entry::Occupied(mut e) => {
                let existing = e.get_mut();
                // A self-inconsistent scan may report the same `uri` more than
                // once. Keep the conservative (smallest) claimed size AND resolve
                // every other field to its minimum, so the resulting plan is the
                // same no matter the order the duplicates arrived in — instead of
                // silently keeping whichever variant happened to be seen first.
                existing.size_bytes = existing.size_bytes.min(item.size_bytes);
                existing.kind = existing.kind.min(item.kind);
                if item.owner < existing.owner {
                    existing.owner = item.owner.clone();
                }
            }
            Entry::Vacant(v) => {
                v.insert(item.clone());
            }
        }
    }

    let mut chosen: Vec<JunkItem> = by_uri.into_values().collect();
    if chosen.len() > MAX_CLEAN_BATCH {
        return Err(DevCareError::BatchTooLarge {
            requested: chosen.len(),
        });
    }

    chosen.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.uri.cmp(&b.uri)));
    let total_bytes = chosen
        .iter()
        .map(|i| i.size_bytes)
        .fold(0u64, u64::saturating_add);

    Ok(CleanPlan {
        items: chosen,
        total_bytes,
    })
}

/// Run a frozen plan through a provider, recording every outcome.
///
/// Never panics and never stops early: one item's failure does not abandon the
/// rest, and `freed_bytes` accumulates only confirmed removals. The caller can
/// therefore show "freed N, M items failed" truthfully.
pub fn execute(plan: &CleanPlan, provider: &mut dyn CleanProvider) -> CleanOutcome {
    let mut outcome = CleanOutcome::default();
    for item in &plan.items {
        match provider.remove(item) {
            Ok(()) => {
                outcome.freed_bytes = outcome.freed_bytes.saturating_add(item.size_bytes);
                outcome.removed.push(item.clone());
            }
            Err(err) => outcome.failures.push(CleanFailure {
                uri: item.uri.clone(),
                kind: item.kind,
                size_bytes: item.size_bytes,
                message: err.to_string(),
            }),
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(uri: &str, kind: JunkKind, bytes: u64) -> JunkItem {
        JunkItem::new(uri, kind, bytes)
    }

    #[test]
    fn junk_kind_keys_round_trip_and_unknown_tags_are_rejected() {
        for k in JunkKind::ALL {
            assert_eq!(JunkKind::from_key(k.key()), Some(k));
        }
        assert_eq!(JunkKind::from_key("nope"), None);
        assert_eq!(JunkKind::from_key(""), None);
    }

    #[test]
    fn analyze_groups_and_totals_in_stable_order() {
        let items = vec![
            item("b", JunkKind::Thumbnail, 10),
            item("a", JunkKind::AppCache, 100),
            item("c", JunkKind::AppCache, 5),
        ];
        let r = analyze(&items).expect("scan is within cap");
        assert_eq!(r.total_items, 3);
        assert_eq!(r.total_bytes, 115);
        // JunkKind::ALL order: AppCache before Thumbnail.
        assert_eq!(r.groups.len(), 2);
        assert_eq!(r.groups[0].kind, JunkKind::AppCache);
        assert_eq!(r.groups[0].count, 2);
        assert_eq!(r.groups[0].bytes, 105);
        assert_eq!(r.groups[1].kind, JunkKind::Thumbnail);
    }

    #[test]
    fn analyze_empty_scan_is_an_honest_empty_report() {
        let r = analyze(&[]).expect("empty scan is fine");
        assert!(r.is_empty());
        assert_eq!(r.total_bytes, 0);
        assert!(r.groups.is_empty());
        assert_eq!(r.reclaimable_bytes(), 0);
    }

    #[test]
    fn analyze_refuses_over_cap_instead_of_truncating() {
        let items: Vec<JunkItem> = (0..MAX_JUNK_ITEMS + 1)
            .map(|i| item(&format!("x{i}"), JunkKind::AppCache, 1))
            .collect();
        let err = analyze(&items).expect_err("over cap must be refused");
        assert_eq!(
            err,
            DevCareError::TooManyItems {
                found: MAX_JUNK_ITEMS + 1,
                cap: MAX_JUNK_ITEMS
            }
        );
    }

    #[test]
    fn analyze_saturates_rather_than_overflowing() {
        let items = vec![
            item("a", JunkKind::AppCache, u64::MAX),
            item("b", JunkKind::AppCache, u64::MAX),
        ];
        let r = analyze(&items).expect("within cap");
        assert_eq!(r.total_bytes, u64::MAX);
        assert_eq!(r.groups[0].bytes, u64::MAX);

        // The cross-group accessors must saturate too: two auto-cleanable kinds
        // each already saturated would overflow a plain `.sum()` (panic in debug,
        // silent wrap in release) even though each group is individually honest.
        let split = vec![
            item("c", JunkKind::AppCache, u64::MAX),
            item("l", JunkKind::LogFile, u64::MAX),
            item("d", JunkKind::StaleDownload, u64::MAX),
        ];
        let r2 = analyze(&split).expect("within cap");
        assert_eq!(r2.total_bytes, u64::MAX);
        assert_eq!(r2.reclaimable_bytes(), u64::MAX);
        assert_eq!(r2.review_bytes(), u64::MAX);
    }

    #[test]
    fn report_separates_reclaimable_from_review_bytes() {
        let items = vec![
            item("cache", JunkKind::AppCache, 100),
            item("dl", JunkKind::StaleDownload, 40),
        ];
        let r = analyze(&items).expect("within cap");
        assert_eq!(r.reclaimable_bytes(), 100);
        assert_eq!(r.review_bytes(), 40);
        assert_eq!(auto_cleanable_kinds(&r), vec![JunkKind::AppCache]);
    }

    #[test]
    fn plan_refuses_an_empty_selection() {
        let err = plan(&[], &CleanRequest::new([])).expect_err("empty is refused");
        assert_eq!(err.key(), "invalid_arguments");
    }

    #[test]
    fn plan_refuses_review_kind_without_acknowledgement() {
        let items = vec![item("dl", JunkKind::StaleDownload, 40)];
        let err = plan(&items, &CleanRequest::new([JunkKind::StaleDownload]))
            .expect_err("review needs acknowledgement");
        assert_eq!(err.key(), "invalid_arguments");
    }

    #[test]
    fn plan_allows_review_kind_when_acknowledged() {
        let items = vec![item("dl", JunkKind::StaleDownload, 40)];
        let p = plan(
            &items,
            &CleanRequest::new([JunkKind::StaleDownload]).acknowledging_review(),
        )
        .expect("acknowledged review is allowed");
        assert_eq!(p.len(), 1);
        assert_eq!(p.total_bytes, 40);
    }

    #[test]
    fn plan_is_filtered_sorted_and_deterministic() {
        let items = vec![
            item("z", JunkKind::LogFile, 1),
            item("b", JunkKind::AppCache, 2),
            item("a", JunkKind::AppCache, 3),
            item("keep", JunkKind::Thumbnail, 999),
        ];
        let req = CleanRequest::new([JunkKind::LogFile, JunkKind::AppCache]);
        let p1 = plan(&items, &req).expect("plan ok");
        let p2 = plan(&items, &req).expect("plan ok again");
        assert_eq!(p1, p2);
        assert_eq!(
            p1.items.iter().map(|i| i.uri.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "z"]
        );
        assert_eq!(p1.total_bytes, 6);
        // The unselected Thumbnail is never planned.
        assert!(p1.items.iter().all(|i| i.kind != JunkKind::Thumbnail));
    }

    #[test]
    fn plan_deduplicates_repeated_kinds() {
        let items = vec![item("a", JunkKind::AppCache, 1)];
        let p = plan(
            &items,
            &CleanRequest::new([JunkKind::AppCache, JunkKind::AppCache]),
        )
        .expect("duplicates are tolerated");
        assert_eq!(p.len(), 1);
    }

    #[test]
    fn plan_refuses_over_batch() {
        let items: Vec<JunkItem> = (0..MAX_CLEAN_BATCH + 1)
            .map(|i| item(&format!("x{i}"), JunkKind::AppCache, 1))
            .collect();
        let err = plan(&items, &CleanRequest::new([JunkKind::AppCache]))
            .expect_err("over batch must be refused");
        assert_eq!(err.key(), "batch_too_large");
    }

    #[test]
    fn plan_refuses_a_blank_uri_instead_of_skipping_it() {
        let items = vec![
            item("ok", JunkKind::AppCache, 1),
            item("   ", JunkKind::AppCache, 2),
        ];
        let err = plan(&items, &CleanRequest::new([JunkKind::AppCache]))
            .expect_err("a blank uri must be refused");
        assert_eq!(err.key(), "refused");
        assert_eq!(err.to_string(), "refusing to touch    : empty uri");
    }

    #[test]
    fn plan_deduplicates_a_repeated_uri_keeping_the_smallest_claimed_size() {
        // A self-inconsistent scan must not yield two deletes for one path, and
        // must not overstate reclaimable bytes.
        let items = vec![
            item("same", JunkKind::AppCache, 900),
            item("same", JunkKind::AppCache, 100),
            item("same", JunkKind::AppCache, 500),
        ];
        let p = plan(&items, &CleanRequest::new([JunkKind::AppCache])).expect("plan ok");
        assert_eq!(p.len(), 1, "one plan entry per uri");
        assert_eq!(p.total_bytes, 100, "the conservative (smallest) size wins");
    }

    #[test]
    fn plan_deduplication_is_independent_of_scan_order() {
        let forward = vec![
            item("a", JunkKind::AppCache, 30),
            item("a", JunkKind::AppCache, 10),
        ];
        let backward = vec![
            item("a", JunkKind::AppCache, 10),
            item("a", JunkKind::AppCache, 30),
        ];
        let req = CleanRequest::new([JunkKind::AppCache]);
        assert_eq!(
            plan(&forward, &req).expect("ok"),
            plan(&backward, &req).expect("ok")
        );
        assert_eq!(plan(&forward, &req).expect("ok").total_bytes, 10);
    }

    #[test]
    fn plan_deduplication_across_kinds_is_independent_of_scan_order() {
        // A self-inconsistent scan may report one `uri` under two kinds. Keeping
        // the *first* kind seen would make the plan depend on scan order; the
        // plan must instead resolve every field deterministically.
        let forward = vec![
            item("a", JunkKind::Thumbnail, 30),
            item("a", JunkKind::TempFile, 10),
        ];
        let backward = vec![
            item("a", JunkKind::TempFile, 10),
            item("a", JunkKind::Thumbnail, 30),
        ];
        let req = CleanRequest::new([JunkKind::Thumbnail, JunkKind::TempFile]);
        let f = plan(&forward, &req).expect("ok");
        let b = plan(&backward, &req).expect("ok");
        assert_eq!(f, b, "the plan must not depend on scan order");
        assert_eq!(f.len(), 1, "one plan entry per uri");
        assert_eq!(f.total_bytes, 10, "the conservative size wins");
        assert_eq!(
            f.items[0].kind,
            JunkKind::TempFile,
            "the smallest kind (in JunkKind order) wins deterministically"
        );
    }

    #[test]
    fn execute_accounts_for_every_planned_item() {
        use crate::provider::MockCleanProvider;

        let items = vec![
            item("a", JunkKind::AppCache, 1),
            item("b", JunkKind::AppCache, 2),
            item("c", JunkKind::AppCache, 3),
        ];
        let p = plan(&items, &CleanRequest::new([JunkKind::AppCache])).expect("plan ok");
        // Only "a" and "c" exist in the backend; "b" must be reported as failed.
        let mut provider =
            MockCleanProvider::new(["a".to_string(), "c".to_string()]).with_failure("c", "locked");
        let outcome = execute(&p, &mut provider);

        assert_eq!(outcome.attempted(), p.len(), "no planned item is skipped");
        assert_eq!(outcome.removed_count(), 1);
        assert_eq!(outcome.failed_count(), 2);
        assert!(outcome.is_partial());
    }
}
