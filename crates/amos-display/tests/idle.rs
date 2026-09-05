//! End-to-end controller behaviour through the public API (integration crate).
//! Mirrors `crates/amos-scheduler/tests/doze_cycle.rs`: drives the pure
//! controller with an explicit monotonic clock — no wall clock, no timers.

use std::time::Duration;

use amos_display::{IdlePolicy, ScreenChange, ScreenController, ScreenState};

fn battery_policy() -> IdlePolicy {
    IdlePolicy {
        on_battery_timeout: Duration::from_secs(30),
        on_charger_timeout: Duration::from_secs(120),
    }
}

#[test]
fn idle_then_interact_full_cycle() {
    let mut c = ScreenController::new(battery_policy(), 0);
    // Idle past the battery timeout → auto-off, reported exactly once.
    assert_eq!(c.probe(30, false, false), ScreenChange::Off);
    assert_eq!(c.state(), ScreenState::Off);
    assert_eq!(c.probe(31, false, false), ScreenChange::None);
    // User interacts → wake, idle clock resets.
    assert_eq!(c.touch(40), ScreenChange::On);
    assert_eq!(c.state(), ScreenState::On);
    // 20s later still on...
    assert_eq!(c.probe(60, false, false), ScreenChange::None);
    // ...and off again a full timeout after the touch.
    assert_eq!(c.probe(70, false, false), ScreenChange::Off);
}

#[test]
fn activity_keeps_the_screen_alive_across_probes() {
    let mut c = ScreenController::new(battery_policy(), 0);
    // Frequent interactions (every 20s < 30s) never let it sleep.
    for now in [0u64, 20, 40, 60, 80] {
        c.touch(now);
        assert_eq!(c.probe(now + 19, false, false), ScreenChange::None);
    }
    assert_eq!(c.state(), ScreenState::On);
}

#[test]
fn charging_screen_stays_alive_much_longer() {
    let mut c = ScreenController::new(battery_policy(), 0);
    // 60s idle while charging is well under the 120s charger timeout.
    assert_eq!(c.probe(60, true, false), ScreenChange::None);
    assert_eq!(c.probe(120, true, false), ScreenChange::Off);
}

#[test]
fn active_call_holds_the_screen_on() {
    let mut c = ScreenController::new(battery_policy(), 0);
    // In an active call even 10 minutes of no touch must not sleep.
    assert_eq!(c.probe(600, false, true), ScreenChange::None);
    assert_eq!(c.state(), ScreenState::On);
    // Call ends → normal idle timeout applies again.
    assert_eq!(c.probe(601, false, false), ScreenChange::Off);
}

#[test]
fn explicit_sleep_is_orthogonal_to_idle() {
    let mut c = ScreenController::new(battery_policy(), 0);
    assert_eq!(c.sleep(), ScreenChange::Off);
    // While off, probes never turn it back on by themselves.
    assert_eq!(c.probe(5, false, false), ScreenChange::None);
    assert_eq!(c.wake(5), ScreenChange::On);
    assert_eq!(c.state(), ScreenState::On);
}

#[test]
fn sub_second_timeout_never_sleeps_instantly() {
    // A misconfigured sub-second timeout must not truncate to 0 and turn the
    // screen off on the first probe (finest honour is 1 s).
    let policy = IdlePolicy {
        on_battery_timeout: Duration::from_millis(500),
        on_charger_timeout: Duration::from_millis(500),
    };
    let mut c = ScreenController::new(policy, 0);
    // 0.9s of idle is < the floored 1 s minimum → still on.
    assert_eq!(c.probe(0, false, false), ScreenChange::None);
    assert_eq!(c.state(), ScreenState::On);
    // A full second of idle honours the (otherwise sub-second) timeout.
    assert_eq!(c.probe(1, false, false), ScreenChange::Off);
}

#[test]
fn persistent_hold_keeps_the_screen_on_until_cleared() {
    let mut c = ScreenController::new(battery_policy(), 0);
    // Assert a call hold → 10 minutes of no touch must not sleep.
    assert!(c.set_hold("call"));
    assert!(c.held());
    assert_eq!(c.probe(600, false, false), ScreenChange::None);
    assert_eq!(c.state(), ScreenState::On);
    // Idempotent re-assert returns false (already held).
    assert!(!c.set_hold("call"));
    assert!(c.held());
    // Revoking the call lets normal idle apply again.
    assert!(c.clear_hold("call"));
    assert!(!c.held());
    assert_eq!(c.probe(601, false, false), ScreenChange::Off);
}

#[test]
fn overlapping_holds_each_need_their_own_clear() {
    let mut c = ScreenController::new(battery_policy(), 0);
    c.set_hold("call");
    c.set_hold("media");
    assert_eq!(c.probe(999, false, false), ScreenChange::None);
    // Clearing one reason is not enough while the other is still active.
    assert!(c.clear_hold("call"));
    assert!(c.held());
    assert_eq!(c.probe(1000, false, false), ScreenChange::None);
    assert_eq!(c.state(), ScreenState::On);
    // Clearing the last reason lets auto-off proceed.
    assert!(c.clear_hold("media"));
    assert_eq!(c.probe(1001, false, false), ScreenChange::Off);
}

#[test]
fn holds_are_enumerated_and_clearing_an_absent_reason_is_false() {
    let mut c = ScreenController::new(battery_policy(), 0);
    assert!(!c.clear_hold("call")); // nothing to clear yet
    c.set_hold("call");
    c.set_hold("nav");
    let got: Vec<&str> = c.holds().collect();
    assert_eq!(got, vec!["call", "nav"]);
}
