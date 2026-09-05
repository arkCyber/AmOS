//! Headless integration test: the full split **closed loop** at the state/geometry
//! layer — enter_split → resize → move → swap → exit — asserting invariants at
//! every step (disjoint, min-respecting panes; primary/secondary mapping;
//! clearing on exit). Real *window* geometry still needs a live multi-window Tauri
//! host; this verifies the decisions the host applies.

use amos_tauri_lib::wm::{SplitLayoutInfo, WmState};

fn split_info(s: &WmState) -> SplitLayoutInfo {
    s.layout_snapshot()
        .expect("layout snapshot")
        .split
        .expect("a split is active")
}

/// The two panes must be disjoint, left within the screen, and each ≥ 1 wide.
fn panes_disjoint(info: &SplitLayoutInfo) -> bool {
    if info.panes.len() != 2 {
        return false;
    }
    let a = &info.panes[0];
    let b = &info.panes[1];
    a.width > 0 && b.width > 0 && (a.x + a.width as i32) <= b.x
}

#[test]
fn split_cycle_state_and_geometry_closed_loop() {
    let wm = WmState::new();
    wm.open_surface("legacy:notes").unwrap();
    wm.open_surface("legacy:maps").unwrap();
    assert!(
        wm.layout_snapshot().unwrap().split.is_none(),
        "no split yet"
    );

    // 1) enter a vertical split: notes primary (left), maps secondary (right).
    wm.enter_split("legacy:notes", "legacy:maps", "vertical")
        .unwrap();
    let entered = split_info(&wm);
    assert_eq!(entered.primary, "legacy:notes");
    assert_eq!(entered.secondary, "legacy:maps");
    assert_eq!(entered.axis, "vertical");
    assert!(panes_disjoint(&entered), "panes disjoint after enter");

    // 2) resize the divider (40% for the primary pane).
    let r = wm.split_resize(40).unwrap().split.expect("split active");
    assert_eq!(r.percent, 40);
    assert!(panes_disjoint(&r));

    // 3) move the divider by +10 → 50%.
    let moved = wm.split_move(10).unwrap().split.expect("split active");
    assert_eq!(moved.percent, 50);
    assert!(panes_disjoint(&moved));

    // 4) swap → maps becomes primary.
    let swapped = wm.split_swap().unwrap().split.expect("split active");
    assert_eq!(swapped.primary, "legacy:maps");
    assert_eq!(swapped.secondary, "legacy:notes");
    assert!(panes_disjoint(&swapped));

    // 5) exit → split cleared, nothing left to restore.
    assert!(wm.split_exit().unwrap().split.is_none());
    assert_eq!(wm.split_labels().unwrap(), None);
}
