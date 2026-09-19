//! Safety monitor fault-injection suite.
//!
//! Why a dedicated test file: every one of the safety monitor's five rules
//! (R1..R5) is a single predicate in `safety.rs`, but the **policy** — which
//! rules fire for which inputs, in which order, with which status — is the
//! claim a deployment buys into. A unit test on each rule passes when the
//! predicate is correct; this file passes when the **join** behaviour is
//! right (e.g. "R1 fires for watchdog", "R3 fires for hard divergence",
//! "R5 fires for a bad set-point"), and *names* the rule that fired.
//!
//! Each test here is a fault-injection scenario that runs offline. No clock
//! dependency, no tokio runtime required (the monitor is synchronous).

use amos_robot::safety::{
    FaultCode, FaultRecord, Heartbeat, SafetyLimits, SafetyMonitor, MAX_FAULT_LOG,
};
use std::time::Duration;

fn default_limits() -> SafetyLimits {
    SafetyLimits {
        heartbeat: Duration::from_millis(100),
        max_divergence_rad: 0.20,
        max_streak: 3,
        max_tilt_rad: 0.78, // 45°
    }
}

fn empty_monitor() -> SafetyMonitor {
    SafetyMonitor::new(default_limits())
}

/// Tick one healthy heartbeat to advance the sequence counter (so `R1`'s
/// "previous heartbeat" check has a reference).
fn prime(mon: &mut SafetyMonitor) {
    mon.heartbeat(Heartbeat::healthy(Duration::from_millis(10)));
}

/// R1 (watchdog) fires when the heartbeat is delayed beyond the period.
#[test]
fn r1_watchdog_fires_after_one_missed_period() {
    let mut mon = empty_monitor();
    prime(&mut mon);
    // 50 ms in — no fault (still under 100 ms heartbeat budget).
    let fired = mon.heartbeat(Heartbeat {
        elapsed: Duration::from_millis(50),
        divergence_rad: None,
        roll_rad: 0.0,
        pitch_rad: 0.0,
    });
    assert!(
        !fired.iter().any(|f| f.code == FaultCode::WatchdogElapsed),
        "50 ms must still be within the 100 ms heartbeat window"
    );
    // 150 ms in — fired.
    let fired = mon.heartbeat(Heartbeat {
        elapsed: Duration::from_millis(150),
        divergence_rad: None,
        roll_rad: 0.0,
        pitch_rad: 0.0,
    });
    assert!(
        fired.iter().any(|f| f.code == FaultCode::WatchdogElapsed),
        "R1 must fire after one missed period"
    );
}

/// R2 fires when the streak counter exceeds `max_streak`.
///
/// Every divergence update that exceeds the bound increments the streak by
/// 1. Until the streak passes `max_streak`, the monitor fires R3
///    (DivergenceExceeded). Once `streak > max_streak`, R2 fires
///    (DivergenceStreak) on that tick and the streak is **not** reset by R2
///    itself (a healthy tick resets it).
#[test]
fn r2_streak_fires_after_max_streak_consecutive_divergences() {
    let mut mon = empty_monitor();
    prime(&mut mon);
    let mut r2_seen = false;
    let mut r3_seen = 0;
    for _ in 0..(default_limits().max_streak as usize + 4) {
        let fired = mon.heartbeat(Heartbeat {
            elapsed: Duration::from_millis(10),
            divergence_rad: Some(0.5), // over the 0.20 rad bound
            roll_rad: 0.0,
            pitch_rad: 0.0,
        });
        for f in &fired {
            match f.code {
                FaultCode::DivergenceStreak => r2_seen = true,
                FaultCode::DivergenceExceeded => r3_seen += 1,
                _ => {}
            }
        }
    }
    assert!(r2_seen, "R2 must fire after enough consecutive divergences");
    assert!(
        r3_seen >= 1,
        "R3 must fire on divergence ticks that haven't yet tripped R2"
    );
}

/// R3 fires on every divergence update that exceeds the bound (until the
/// streak rule R2 takes over).
#[test]
fn r3_hard_divergence_fires_on_a_single_update() {
    let mut mon = empty_monitor();
    prime(&mut mon);
    let fired = mon.heartbeat(Heartbeat {
        elapsed: Duration::from_millis(10),
        divergence_rad: Some(0.5), // way over 0.20 rad
        roll_rad: 0.0,
        pitch_rad: 0.0,
    });
    assert!(
        fired
            .iter()
            .any(|f| f.code == FaultCode::DivergenceExceeded),
        "R3 must fire on a single hard divergence"
    );
}

/// R4 fires when roll/pitch exceeds the unsafe-tilt bound.
#[test]
fn r4_unsafe_attitude_fires_for_a_60_degree_roll() {
    let mut mon = empty_monitor();
    prime(&mut mon);
    let fired = mon.heartbeat(Heartbeat {
        elapsed: Duration::from_millis(10),
        divergence_rad: None,
        roll_rad: 1.0, // 1 rad ≈ 57°, over the 45° (0.78 rad) bound
        pitch_rad: 0.0,
    });
    assert!(
        fired.iter().any(|f| f.code == FaultCode::AttitudeExceeded),
        "R4 must fire on a 60° roll"
    );
}

/// R5 fires via `check_set_point` — an out-of-travel set-point is refused.
#[test]
fn r5_sanity_fires_for_an_oversize_setpoint() {
    let mut mon = empty_monitor();
    prime(&mut mon);
    let fault = mon.check_set_point(5_000, (0, 1_000)).expect("a fault");
    assert_eq!(fault.code, FaultCode::SanityFailed);

    // An in-travel value must NOT record a fault.
    assert!(mon.check_set_point(500, (0, 1_000)).is_none());
}

/// Multiple rules can fire on the same tick — the report carries the full
/// set, and R5's NaN-handling is one of the predicates.
#[test]
fn multiple_rules_fire_independently() {
    let mut mon = empty_monitor();
    prime(&mut mon);
    // 200 ms in (>100 ms heartbeat ⇒ R1), divergence 0.5 rad (R3), roll
    // 1 rad (R4).
    let fired = mon.heartbeat(Heartbeat {
        elapsed: Duration::from_millis(200),
        divergence_rad: Some(0.5),
        roll_rad: 1.0,
        pitch_rad: 0.0,
    });
    let codes: Vec<FaultCode> = fired.iter().map(|f| f.code).collect();
    assert!(
        codes.contains(&FaultCode::WatchdogElapsed),
        "R1 must fire on a 200 ms gap"
    );
    assert!(
        codes.contains(&FaultCode::DivergenceExceeded),
        "R3 must fire on a 0.5 rad divergence"
    );
    assert!(
        codes.contains(&FaultCode::AttitudeExceeded),
        "R4 must fire on a 1 rad roll"
    );
}

/// A NaN-bearing heartbeat is itself a sanity-fault (R5).
#[test]
fn nan_inputs_in_a_heartbeat_fire_r5() {
    let mut mon = empty_monitor();
    prime(&mut mon);
    let fired = mon.heartbeat(Heartbeat {
        elapsed: Duration::from_millis(10),
        divergence_rad: None,
        roll_rad: f32::NAN,
        pitch_rad: 0.0,
    });
    assert!(
        fired.iter().any(|f| f.code == FaultCode::SanityFailed),
        "R5 must fire on a NaN heartbeat"
    );
}

/// The fault log is bounded — a long run that fires many faults must not
/// allocate past the cap.
#[test]
fn the_fault_log_is_bounded_and_wrapped() {
    let mut mon = empty_monitor();
    prime(&mut mon);
    // Provoke R3 every tick (a single hard divergence is sufficient).
    for _ in 0..(MAX_FAULT_LOG + 50) {
        mon.heartbeat(Heartbeat {
            elapsed: Duration::from_millis(10),
            divergence_rad: Some(0.5),
            roll_rad: 0.0,
            pitch_rad: 0.0,
        });
    }
    let log = mon.faults();
    assert!(
        log.len() <= MAX_FAULT_LOG,
        "fault log overgrew MAX_FAULT_LOG"
    );
    assert!(
        mon.window_full(),
        "a log that overran must record the roll-over"
    );
}

/// Each FaultRecord carries the sequence and the measurement the rule was
/// tested against (the rule says "this fired against *this* value, not
/// 'something' went wrong").
#[test]
fn a_fault_record_carries_a_measurement() {
    let rec = FaultRecord {
        code: FaultCode::DivergenceExceeded,
        sequence: 42,
        measurement: 0.34,
    };
    assert_eq!(rec.sequence, 42);
    assert!((rec.measurement - 0.34).abs() < 1e-12);
    let s = rec.summary();
    assert!(s.contains("R3"));
}

/// A hard-divergence tick increments the streak. An in-tolerance tick
/// resets the streak. A heartbeat with `divergence_rad = None` does not
/// touch the streak.
#[test]
fn a_healthy_heartbeat_does_not_increment_the_streak() {
    let mut mon = empty_monitor();
    prime(&mut mon);
    // A divergence above the bound ⇒ streak = 1.
    let _ = mon.heartbeat(Heartbeat {
        elapsed: Duration::from_millis(10),
        divergence_rad: Some(0.5),
        roll_rad: 0.0,
        pitch_rad: 0.0,
    });
    assert_eq!(
        mon.streak(),
        1,
        "a hard divergence increments the streak by 1"
    );
    // A `healthy` heartbeat (div=0) is below the bound ⇒ streak resets.
    let _ = mon.heartbeat(Heartbeat::healthy(Duration::from_millis(10)));
    assert_eq!(
        mon.streak(),
        0,
        "an in-tolerance tick resets the streak (divergence under the bound)"
    );
    // A heartbeat with `divergence_rad = None` is "no independent source";
    // the streak is left alone.
    let _ = mon.heartbeat(Heartbeat {
        elapsed: Duration::from_millis(10),
        divergence_rad: Some(0.5),
        roll_rad: 0.0,
        pitch_rad: 0.0,
    });
    assert_eq!(mon.streak(), 1);
    let _ = mon.heartbeat(Heartbeat {
        elapsed: Duration::from_millis(10),
        divergence_rad: None,
        roll_rad: 0.0,
        pitch_rad: 0.0,
    });
    assert_eq!(
        mon.streak(),
        1,
        "no divergence source = streak unchanged from previous"
    );
}

/// The summary line is one string an operator can read.
#[test]
fn the_summary_line_is_human_readable() {
    let mon = empty_monitor();
    let s = mon.summary();
    assert!(s.contains("safety:"));
    assert!(s.contains("limits="));
}
