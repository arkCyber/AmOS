//! Realistic multi-window use-case (headless).
//!
//! Mirrors the desktop scenario in `docs/gui-verify.md` so the exact flow you'd
//! click through in the real Tauri GUI is also asserted automatically at the
//! pure state-machine level. The Tauri adapter (`amos-tauri/src/wm.rs`) maps
//! these same `WmEvent`s onto real `WebviewWindow`s.

use amos_wm::{WindowKind, WindowManager, WindowState, WmEvent};

/// Launcher → AI 助手 → 设置 → 通知中心 → 返回主屏 → 重开 AI → 全关。
#[test]
fn desktop_multi_window_flow() {
    let mut wm = WindowManager::new();
    let launcher = wm.launcher().unwrap();
    assert_eq!(wm.focused(), Some(launcher), "boot focuses the launcher");

    // 1. 打开 AI 助手(首个 App 窗口)。
    let ai = wm.register(WindowKind::App).0;
    let events = wm.open(ai);
    assert!(events.contains(&WmEvent::Shown(ai)), "app shown");
    assert_eq!(wm.focused(), Some(ai), "AI is focused");
    assert_eq!(
        wm.state_of(launcher),
        Some(WindowState::Shown),
        "launcher demoted"
    );

    // 2. 打开设置 —— AI 降级为 Shown,设置置顶。
    let settings = wm.register(WindowKind::App).0;
    wm.open(settings);
    assert_eq!(wm.focused(), Some(settings));
    assert_eq!(wm.state_of(ai), Some(WindowState::Shown));
    assert_eq!(wm.z_order(), vec![settings, ai, launcher]);

    // 3. 通知中心(System 窗口)盖在最上层。
    let nc = wm.register(WindowKind::System).0;
    wm.open(nc);
    assert_eq!(wm.focused(), Some(nc));
    assert_eq!(wm.z_order(), vec![nc, settings, ai, launcher]);

    // 4. 关闭通知中心 → 焦点回退到最近使用的设置。
    wm.close(nc);
    assert_eq!(
        wm.focused(),
        Some(settings),
        "focus falls back to most-recent"
    );
    assert!(!wm.windows().contains(&nc), "system window removed");

    // 5. 返回主屏 → Launcher 聚焦,App 仍在后台存活(recents)。
    wm.home();
    assert_eq!(wm.focused(), Some(launcher));
    assert!(wm.windows().contains(&ai) && wm.windows().contains(&settings));

    // 6. 重开 AI → 置顶(bring-to-front)。home 后 Launcher 是最近使用,故 ai 之后
    //    依序是 launcher、settings。
    wm.focus(ai);
    assert_eq!(wm.focused(), Some(ai));
    assert_eq!(wm.z_order(), vec![ai, launcher, settings]);

    // 7. 逐个关闭 → 回 Launcher,无残留窗口。
    wm.close(settings);
    wm.close(ai);
    assert_eq!(wm.focused(), Some(launcher));
    assert_eq!(wm.windows(), vec![launcher], "only the launcher remains");
}

/// System window (notification center) sits above apps but a focused app still
/// outranks an older hidden system surface.
#[test]
fn system_window_above_apps_but_recent_wins() {
    let mut wm = WindowManager::new();
    let app = wm.register(WindowKind::App).0;
    let sys = wm.register(WindowKind::System).0;
    wm.open(app);
    wm.open(sys);
    assert_eq!(wm.focused(), Some(sys), "system window on top");

    // Re-focus the app: it comes to front (most-recently-used wins).
    wm.focus(app);
    assert_eq!(wm.focused(), Some(app));
    assert_eq!(wm.z_order(), vec![app, sys, wm.launcher().unwrap()]);
}
