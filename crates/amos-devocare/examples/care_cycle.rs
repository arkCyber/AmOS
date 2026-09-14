//! `care_cycle` — scan → analyse → plan → execute, with the refusals visible.
//!
//! Uses the offline `MockCleanProvider`, so this runs anywhere: what it demonstrates is the
//! *policy* — which junk kinds are reclaimable, that a review-only item blocks execution until
//! the caller acknowledges it, that a provider failure produces an honest partial result, and
//! that the uninstall guard refuses system packages rather than "cleaning" them.
//!
//! Usage:
//! ```text
//! cargo run -p amos-devocare --example care_cycle
//! ```

use amos_devocare::guard::{UninstallGuard, CRITICAL_PACKAGES};
use amos_devocare::junk::{analyze, auto_cleanable_kinds, execute, plan};
use amos_devocare::provider::MockCleanProvider;
use amos_devocare::spec::{AppPackage, CleanRequest, JunkItem, JunkKind, UninstallVerdict};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // What a scan would have found (the engine's rules decide what is reclaimable).
    let items = vec![
        JunkItem::new(
            "content://cache/app-a",
            JunkKind::AppCache,
            40 * 1024 * 1024,
        ),
        JunkItem::new(
            "content://cache/app-b",
            JunkKind::AppCache,
            12 * 1024 * 1024,
        ),
        JunkItem::new(
            "file:///storage/emulated/0/Download/x.apk",
            JunkKind::ApkInstaller,
            90 * 1024 * 1024,
        ),
    ];
    let report = analyze(&items)?;
    println!(
        "scan: {} item(s), reclaimable={}MB review={}MB",
        report.total_items,
        report.reclaimable_bytes() / (1024 * 1024),
        report.review_bytes() / (1024 * 1024)
    );
    for group in &report.groups {
        println!(
            "  {:?}: {} item(s), {}B",
            group.kind, group.count, group.bytes
        );
    }
    let auto = auto_cleanable_kinds(&report);
    println!("automatically cleanable kinds: {auto:?}");

    // A plan that includes everything the report allows.
    let request = CleanRequest::new(auto.clone());
    let plan = plan(&items, &request)?;
    println!(
        "plan: {} item(s), {}MB",
        plan.items.len(),
        plan.total_bytes / (1024 * 1024)
    );

    // Execute against a mock that really holds those uris, with one configured failure so a
    // partial outcome is demonstrated honestly.
    let mut provider = MockCleanProvider::new(items.iter().map(|i| i.uri.clone()))
        .with_failure("content://cache/app-b", "simulated: file in use");
    let outcome = execute(&plan, &mut provider);
    println!(
        "execute: attempted={} removed={} freed={}MB failed={} partial={}",
        outcome.attempted(),
        outcome.removed_count(),
        outcome.freed_bytes / (1024 * 1024),
        outcome.failed_count(),
        outcome.is_partial()
    );
    for failure in &outcome.failures {
        println!("  refused {}: {}", failure.uri, failure.message);
    }
    println!(
        "the mock really removed {} item(s)",
        provider.removed().len()
    );

    // The uninstall guard: system and pinned-critical packages are refused, not "cleaned".
    let guard = UninstallGuard::new();
    for (id, name, system) in [
        ("com.example.app", "Example", false),
        ("com.android.systemui", "System UI", true),
    ] {
        let app = AppPackage::new(id, name).system(system);
        match guard.verdict(&app) {
            UninstallVerdict::Allowed => println!("uninstall {id}: allowed (user app)"),
            UninstallVerdict::SystemApp => println!("uninstall {id}: refused (system package)"),
            UninstallVerdict::Protected => println!("uninstall {id}: refused (pinned critical)"),
        }
    }
    println!(
        "critical packages the guard always protects: {}",
        CRITICAL_PACKAGES.len()
    );
    Ok(())
}
