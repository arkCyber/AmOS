//! `idle_timeline` — the idle rules, step by step, with no sleeping and no display.
//!
//! The controller is pure: ticks go in, a `ScreenChange` comes out. This walks a plausible
//! minute — idle on battery, a call holding the screen, an explicit sleep, a longer charging
//! timeout — and prints the exact transition each step produced (including `None`, which is
//! what tells a host "do not re-send the same command").
//!
//! Usage:
//! ```text
//! cargo run -p amos-display --example idle_timeline
//! ```

use std::time::Duration;

use amos_display::{IdlePolicy, ScreenChange, ScreenController, ScreenState};

/// Print one step: the time, what was asked, and what the controller said.
fn step(ctl: &mut ScreenController, now: u64, charging: bool, hold: bool, what: &str) {
    let change = ctl.probe(now, charging, hold);
    println!(
        "t={now:>3}s charging={charging:<5} hold={hold:<5} {what:<28} -> {:?} (screen={:?})",
        change,
        ctl.state()
    );
}

fn main() {
    let policy = IdlePolicy::default_for_phones();
    println!(
        "policy: on battery {}s, charging {}s",
        policy.timeout_for(false).as_secs(),
        policy.timeout_for(true).as_secs()
    );

    let mut ctl = ScreenController::new(policy, 0);
    println!("start: {:?}", ctl.state());

    // Activity keeps it awake; a call holds it even past the timeout.
    ctl.touch(1);
    step(&mut ctl, 5, false, false, "user touched at t=1");
    let held = ctl.set_hold("in-call");
    println!(
        "set_hold(\"in-call\") -> {held} (holds={:?})",
        ctl.holds().collect::<Vec<_>>()
    );
    step(&mut ctl, 45, false, true, "past the battery timeout");

    // The call ends: now the timeout applies.
    let cleared = ctl.clear_hold("in-call");
    println!("clear_hold(\"in-call\") -> {cleared} (held={})", ctl.held());
    step(&mut ctl, 46, false, false, "call ended, still idle");
    step(&mut ctl, 47, false, false, "one more probe (no change)");

    // Waking resets the idle clock; charging buys a longer timeout.
    println!("wake at t=60 -> {:?}", ctl.wake(60));
    step(&mut ctl, 61, true, false, "on the charger, 1s idle");
    step(&mut ctl, 200, true, false, "on the charger, 140s idle");
    step(&mut ctl, 201, false, false, "unplugged, now on battery");
    step(&mut ctl, 240, false, false, "idle past the battery timeout");

    // Explicit sleep is separate from idle, and it is idempotent in the model.
    println!("sleep -> {:?}", ctl.sleep());
    println!("sleep again -> {:?}", ctl.sleep());
    println!("final: {:?}", ctl.state());
    let _ = ScreenState::On;
    let _ = ScreenChange::None;
    let _ = Duration::from_secs(0);
}
