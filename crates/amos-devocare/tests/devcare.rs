//! End-to-end host test for the device-care domain: scan → analyze → plan →
//! execute, plus the uninstall guard, the permission review and the folded care
//! report. **No device, no I/O** — the whole manager's decision path is proven
//! offline, which is what lets the Tauri bridge and the Svelte screen later be
//! thin.

use amos_devocare::{
    analyze, apps_holding, assess, auto_cleanable_kinds, execute, granted_resource_count, plan,
    review_grants, AppPackage, BatteryCare, CareGrade, CareInput, CleanRequest, JunkItem, JunkKind,
    MockCleanProvider, PermissionGrant, SensitiveResource, UninstallGuard,
};

fn scan() -> Vec<JunkItem> {
    vec![
        JunkItem::new("cache:a", JunkKind::AppCache, 300),
        JunkItem::new("cache:b", JunkKind::AppCache, 200),
        JunkItem::new("thumb:a", JunkKind::Thumbnail, 50),
        JunkItem::new("dl:movie", JunkKind::StaleDownload, 900),
    ]
}

#[test]
fn the_junk_pipeline_reclaims_only_what_was_selected() {
    let items = scan();
    let report = analyze(&items).expect("within cap");
    assert_eq!(report.reclaimable_bytes(), 550);
    assert_eq!(report.review_bytes(), 900);

    // The backend holds exactly what the scan found; one removal will fail.
    let mut provider = MockCleanProvider::new(items.iter().map(|i| i.uri.clone()))
        .with_failure("cache:b", "in use");

    let request = CleanRequest::new(auto_cleanable_kinds(&report));
    assert!(!request.kinds.contains(&JunkKind::StaleDownload));

    let clean_plan = plan(&items, &request).expect("plan is valid");
    assert_eq!(clean_plan.len(), 3);
    assert_eq!(clean_plan.total_bytes, 550);

    let outcome = execute(&clean_plan, &mut provider);
    assert!(outcome.is_partial());
    assert_eq!(outcome.removed_count(), 2);
    assert_eq!(outcome.failed_count(), 1);
    // Only confirmed removals are counted: 300 (cache:a) + 50 (thumb:a).
    assert_eq!(outcome.freed_bytes, 350);
    assert_eq!(outcome.failures[0].uri, "cache:b");

    // The user's download was never touched, and a removal really happened.
    assert!(provider.contains("dl:movie"));
    assert!(!provider.contains("cache:a"));
    assert!(!provider.contains("thumb:a"));
}

#[test]
fn a_stale_download_requires_an_explicit_acknowledgement_end_to_end() {
    let items = scan();
    let refused = plan(&items, &CleanRequest::new([JunkKind::StaleDownload]));
    assert!(
        refused.is_err(),
        "review-only kinds must not be planned blind"
    );

    let accepted = plan(
        &items,
        &CleanRequest::new([JunkKind::StaleDownload]).acknowledging_review(),
    )
    .expect("acknowledged plan is valid");
    assert_eq!(accepted.len(), 1);
    assert_eq!(accepted.items[0].uri, "dl:movie");
}

#[test]
fn the_manager_snapshot_folds_apps_permissions_and_battery() {
    let guard = UninstallGuard::new();
    let packages = vec![
        AppPackage::new("com.example.social", "Social").with_size(200_000_000),
        AppPackage::new("com.amos.settings", "Settings").system(true),
    ];
    let selectable = guard.selectable(&packages);
    assert_eq!(selectable.len(), 1, "the System settings app is protected");

    let grants = vec![
        PermissionGrant::granted("com.example.social", SensitiveResource::Camera),
        PermissionGrant::granted("com.example.social", SensitiveResource::Microphone),
        PermissionGrant::denied("com.example.social", SensitiveResource::Sms),
    ];
    let rows = review_grants(&grants);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].count(), 2, "the denied SMS grant is not shown");
    assert_eq!(
        apps_holding(&grants, SensitiveResource::Camera),
        vec!["com.example.social"]
    );

    let report = assess(&CareInput {
        storage_reclaimable_bytes: Some(1024 * 1024),
        battery: Some(BatteryCare {
            level_pct: 15,
            charging: false,
            thermal_throttled: false,
        }),
        sensitive_grants: Some(granted_resource_count(&grants)),
        reviewable_apps: Some(selectable.len()),
    });

    assert_eq!(report.assessed.len(), 4, "all four areas had data");
    // storage suggestion (5) + low battery (15) = 20.
    assert_eq!(report.score, 80);
    assert_eq!(report.grade, CareGrade::B);
    assert_eq!(report.findings[0].key, "care.battery.low");
}

#[test]
fn care_report_round_trips_through_json_for_the_bridge() {
    let report = assess(&CareInput {
        storage_reclaimable_bytes: Some(6 * 1024 * 1024 * 1024),
        battery: Some(BatteryCare {
            level_pct: 90,
            charging: true,
            thermal_throttled: false,
        }),
        sensitive_grants: Some(3),
        reviewable_apps: Some(0),
    });
    let json = serde_json::to_string(&report).expect("serialize");
    let back: amos_devocare::CareReport = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(report, back);
}
