//! `form_and_split` — the same windows under three form factors, then a split session.
//!
//! No OS window is created: the model is the whole point. First the class policies (what a
//! phone/tablet/desktop may do, how many content columns a width supports, and what the
//! headless `Robot` class means), then the window state machine (launcher, focus stack,
//! home), then a `SplitScreen` that swaps panes and refuses a screen too small to hold two
//! minimum panes.
//!
//! Usage:
//! ```text
//! cargo run -p amos-wm --example form_and_split
//! ```

use amos_wm::form::{resolve_hint, FormFactor, HintSource, LayoutPolicy, ShellFit};
use amos_wm::layout::{Bounds, SplitAxis};
use amos_wm::split::SplitScreen;
use amos_wm::{WindowKind, WindowManager};

/// A phone screen, a tablet screen and a desktop window — the sizes the policies differ on.
const SCREENS: [(FormFactor, u32, u32); 3] = [
    (FormFactor::Phone, 480, 820),
    (FormFactor::Tablet, 900, 1200),
    (FormFactor::Desktop, 1496, 967),
];

fn main() {
    // ── the class decides what is allowed ───────────────────────────────────────────
    for (form, width, height) in SCREENS {
        let policy = LayoutPolicy::of(form);
        println!(
            "{:<8} multi_window={:<5} free_resize={:<5} gap={:<3} min_pane={}x{} max_columns={} \
             initial={}x{} -> columns_for({width})={}",
            form.as_str(),
            policy.multi_window,
            policy.free_resize,
            policy.divider_gap,
            policy.min_pane.width,
            policy.min_pane.height,
            policy.max_columns,
            policy.initial_window.width,
            policy.initial_window.height,
            policy.columns_for(width),
        );
        let _ = height;
    }
    println!(
        "robot: has_ui={} (headless: window numbers are inert)",
        FormFactor::Robot.has_ui()
    );

    // ── an operator hint, resolved honestly ─────────────────────────────────────────
    for raw in ["tablet", "  Desktop ", "wizard", ""] {
        match FormFactor::parse(raw) {
            Some(form) => println!("hint {raw:?} -> {}", form.as_str()),
            None => println!("hint {raw:?} -> unusable (never guessed)"),
        }
    }
    match resolve_hint(Some("tablet"), FormFactor::Phone) {
        Ok((form, source)) => println!(
            "resolve_hint(\"tablet\") -> {} from {source:?}",
            form.as_str()
        ),
        Err(e) => println!("resolve_hint(\"tablet\") refused: {e}"),
    }
    match resolve_hint(Some("wizard"), FormFactor::Phone) {
        Ok((form, source)) => println!(
            "resolve_hint(\"wizard\") -> {} from {source:?}",
            form.as_str()
        ),
        Err(e) => println!("resolve_hint(\"wizard\") refused: {e}"),
    }
    let _: HintSource = HintSource::BuildDefault;
    let _ = ShellFit::Leave;

    // ── the window state machine ────────────────────────────────────────────────────
    let mut wm = WindowManager::new();
    println!(
        "launcher focused at start: {:?}",
        wm.focused() == wm.launcher()
    );
    let (notes, events) = wm.register(WindowKind::App);
    println!("register(notes) -> {events:?}");
    let events = wm.open(notes);
    println!("open(notes) -> {events:?}, focused={:?}", wm.focused());
    let (camera, _) = wm.register(WindowKind::App);
    let _ = wm.open(camera);
    println!("z_order={:?} focused={:?}", wm.z_order(), wm.focused());
    let events = wm.home();
    println!(
        "home() -> {events:?}, focused launcher={}",
        wm.focused() == wm.launcher()
    );
    println!("split candidates: {:?}", wm.split_candidates());

    // ── a split session over two windows ───────────────────────────────────────────
    let screen = Bounds {
        x: 0,
        y: 0,
        width: 900,
        height: 1200,
    };
    let policy = LayoutPolicy::of(FormFactor::Tablet);
    match SplitScreen::new(
        notes,
        camera,
        screen,
        SplitAxis::Vertical,
        policy.divider_gap,
        policy.min_pane,
    ) {
        Some(mut split) => {
            println!("split at {}%: bounds={:?}", split.percent(), split.bounds());
            println!("resize_to(30) -> {}", split.resize_to(30));
            println!(
                "after resize: {}% bounds={:?}",
                split.percent(),
                split.bounds()
            );
            split.swap();
            println!(
                "after swap: primary={:?} bounds_for(notes)={:?}",
                split.primary,
                split.bounds_for(notes)
            );
            println!(
                "other(notes)={:?} contains(camera)={}",
                split.other(notes),
                split.contains(camera)
            );
        }
        None => println!("the two panes + gap do not fit {screen:?}"),
    }
    // The same split on a screen too small for two minimum panes: refused, not squeezed.
    let tiny = Bounds {
        x: 0,
        y: 0,
        width: 320,
        height: 480,
    };
    println!(
        "split on {tiny:?} -> {:?}",
        SplitScreen::new(
            notes,
            camera,
            tiny,
            SplitAxis::Vertical,
            policy.divider_gap,
            policy.min_pane
        )
        .map(|s| s.percent())
    );
}
