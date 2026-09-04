//! Integration: a full multi-process lifecycle + memory-pressure reclaim scenario.
//!
//! Verifies the LMK-proxy policy — cached (tombstone) processes are evicted
//! before background ones, least-recently-used first, and protected tiers
//! (foreground / visible / foreground-service) are never touched.

use amos_applife::{AppId, AppLifecycle, AppState};

fn id(s: &str) -> AppId {
    AppId::new(s)
}

#[test]
fn reclaim_evicts_cached_before_background_lru_first() {
    let mut lm = AppLifecycle::new();

    // A and C end up Cached (tombstoned); B stays Background. A is older.
    lm.launch(id("a")).unwrap();
    lm.go_background(id("a")).unwrap();
    lm.launch(id("b")).unwrap();
    lm.go_background(id("b")).unwrap();
    lm.launch(id("c")).unwrap();
    lm.go_background(id("c")).unwrap();
    lm.freeze(id("a")).unwrap(); // Cached
    lm.freeze(id("c")).unwrap(); // Cached (newer than a)

    assert_eq!(lm.state(&id("a")).unwrap(), AppState::Cached);
    assert_eq!(lm.state(&id("b")).unwrap(), AppState::Background);
    assert_eq!(lm.state(&id("c")).unwrap(), AppState::Cached);

    // Cached first (a older than c), then the background process b.
    let all = lm.reclaim_candidates(10);
    assert_eq!(all, vec![id("a"), id("c"), id("b")]);

    // Budget of 1 frees just the oldest cached process.
    assert_eq!(lm.reclaim_candidates(1), vec![id("a")]);
}

#[test]
fn protected_tiers_are_never_reclaimed() {
    let mut lm = AppLifecycle::new();
    lm.launch(id("front")).unwrap(); // foreground — protected
    lm.launch(id("svc")).unwrap();
    lm.start_service(id("svc")).unwrap(); // foreground service — protected
    lm.launch(id("bg")).unwrap();
    lm.go_background(id("bg")).unwrap(); // the only reclaimable one

    // Whatever the budget, only the truly background process is a victim.
    assert_eq!(lm.reclaim_candidates(10), vec![id("bg")]);
}

#[test]
fn reclaim_marks_lru_and_returns_saved_state_for_stopped() {
    let mut lm = AppLifecycle::new();
    // Two background apps; the one used least recently gets killed first.
    lm.launch(id("old")).unwrap();
    lm.go_background(id("old")).unwrap();
    lm.launch(id("recent")).unwrap();
    lm.go_background(id("recent")).unwrap();
    lm.go_foreground(id("recent")).unwrap(); // recent used last
    lm.go_background(id("recent")).unwrap();

    assert_eq!(lm.reclaim_candidates(1), vec![id("old")]);

    // Kill the victim; it is gone, but stopping (not killing) keeps state.
    assert!(lm.kill(&id("old")));
    assert!(!lm.contains(&id("old")));

    // Stop recent (keeps record) → cheap relaunch works.
    lm.stop(id("recent")).unwrap();
    assert_eq!(lm.state(&id("recent")).unwrap(), AppState::Stopped);
    lm.launch(id("recent")).unwrap();
    assert_eq!(lm.state(&id("recent")).unwrap(), AppState::Foreground);
}
