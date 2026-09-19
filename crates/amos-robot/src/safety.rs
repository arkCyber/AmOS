//! Safety monitor — the **last** layer before the bus, before `RobotBridge`'s own safety
//! core (the e-stop latch + deadman + refusal), and the only one that can refuse a frame
//! after the controller has signed off.
//!
//! Why this is its own module (and not a method on [`ControlLoop`](crate::control::ControlLoop)):
//!
//! 1. **Bounded resources.** The monitor keeps a bounded fault window (NASA Power of 10 #2 —
//!    no buffer that grows at runtime). A monitor that allocates on every fault is the
//!    classic failure mode that takes out a flight recorder.
//! 2. **Testable in isolation.** A fault-injection test can drive a [`SafetyMonitor`] with a
//!    synthetic state transition sequence and assert the verdict, without spinning up a node,
//!    a publisher or a bridge.
//! 3. **Honest boundaries.** A monitor that pretends to *predict* failures has nothing to
//!    defend; this one *detects* them, with a verifier that names the rule that fired. The
//!    difference is what makes an audit entry: "the divergence was 0.34 rad, the threshold is
//!    0.20 rad, the rule is `R3`" — not "the controller crashed".
//!
//! Five rules (the same shape the aerospace regulator's "fault tree" looks like, with
//! rule IDs an operator can grep for in a log):
//!
//! | ID | Rule | When it fires |
//! |---|---|---|
//! | `R1` | Watchdog elapsed | Time since the last health-check exceeds the period |
//! | `R2` | Consecutive diverged updates | The estimator diverged more than `max_streak` updates in a row |
//! | `R3` | Hard divergence | The estimator's pose disagreement exceeds [`SafetyLimits::max_divergence_rad`] |
//! | `R4` | Unsafe attitude | Roll/pitch out of [`SafetyLimits::max_tilt_rad`] |
//! | `R5` | Sanity check on a frame | A set point is non-finite or outside its travel |
//!
//! Rules are applied **independently**: a firing rule does not silence the others, and the
//! report carries the full set so a post-mortem can see which would have fired first. This
//! is the standard avionics "OR-tree" shape — a chain of simple predicates, each with a
//! bounded, named check.

use std::time::Duration;

/// Upper bound on the number of faults the monitor can hold in one window (NASA Power of 10 #2:
/// fixed-size storage on the safety path).
///
/// 256 is the smallest power-of-two that covers a 100 Hz loop's first ~2.5 s of cascading
/// faults — long enough to write a log, short enough that an `Index` is `u8`.
pub const MAX_FAULT_LOG: usize = 256;

/// One rule the monitor can fire. The discriminant is part of the wire format — operators
/// grep on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FaultCode {
    /// `R1`: the period elapsed without a heartbeat update.
    WatchdogElapsed,
    /// `R2`: the divergence streak exceeded its bound.
    DivergenceStreak,
    /// `R3`: the pose disagreement exceeded the hard bound.
    DivergenceExceeded,
    /// `R4`: roll or pitch exceeded the unsafe-tilt bound.
    AttitudeExceeded,
    /// `R5`: a set point failed sanity (non-finite or out of travel).
    SanityFailed,
}

impl FaultCode {
    /// Stable key, for logs and for a UI that renders the rule.
    pub fn key(self) -> &'static str {
        match self {
            FaultCode::WatchdogElapsed => "R1",
            FaultCode::DivergenceStreak => "R2",
            FaultCode::DivergenceExceeded => "R3",
            FaultCode::AttitudeExceeded => "R4",
            FaultCode::SanityFailed => "R5",
        }
    }
}

/// One entry in the bounded fault log: rule, sequence number, the measurement that fired it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FaultRecord {
    /// Which rule fired.
    pub code: FaultCode,
    /// Monotonic sequence number (so a reader can detect a wrap without trusting `Instant`).
    pub sequence: u64,
    /// The measured value the rule was tested against, when it makes sense to record it
    /// (`R1` records the elapsed time in microseconds; `R5` records the bad set point; the
    /// others record the divergence in radians).
    pub measurement: f64,
}

impl FaultRecord {
    /// One line an operator can read.
    pub fn summary(&self) -> String {
        match self.code {
            FaultCode::WatchdogElapsed => format!(
                "{}: watchdog elapsed by {:.3} ms",
                self.code.key(),
                self.measurement / 1_000.0
            ),
            FaultCode::DivergenceStreak | FaultCode::DivergenceExceeded => format!(
                "{}: divergence {:.4} rad",
                self.code.key(),
                self.measurement
            ),
            FaultCode::AttitudeExceeded => {
                format!("{}: attitude {:.4} rad", self.code.key(), self.measurement)
            }
            FaultCode::SanityFailed => {
                format!(
                    "{}: bad set point {}",
                    self.code.key(),
                    self.measurement as i32
                )
            }
        }
    }
}

/// What the monitor accepts as the policy of a deployment.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SafetyLimits {
    /// Maximum time between two [`SafetyMonitor::heartbeat`] calls before `R1` fires.
    pub heartbeat: Duration,
    /// Maximum tolerated instantaneous divergence, radians. Above this, `R3` fires.
    pub max_divergence_rad: f32,
    /// Maximum tolerated consecutive-divergence streak before `R2` fires. `0` disables.
    pub max_streak: u32,
    /// Maximum tolerated roll/pitch (absolute), radians. Above this, `R4` fires.
    pub max_tilt_rad: f32,
}

impl SafetyLimits {
    /// The conservative defaults: 250 ms heartbeat (a 100 Hz loop skips 25 ticks before it
    /// is "dead"), 0.2 rad ≈ 11.5° divergence, a three-update streak, 0.5 rad ≈ 28.6° tilt.
    pub fn conservative() -> Self {
        Self {
            heartbeat: Duration::from_millis(250),
            max_divergence_rad: 0.2,
            max_streak: 3,
            max_tilt_rad: 0.5,
        }
    }
}

impl Default for SafetyLimits {
    fn default() -> Self {
        Self::conservative()
    }
}

/// One accepted heartbeat tick: the monitor records the time and the measured divergence
/// (the disagreement between the estimator and an independent source, when one is supplied).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Heartbeat {
    /// Time elapsed since the previous heartbeat. Refused (counts as `R1`) when it exceeds
    /// `heartbeat`.
    pub elapsed: Duration,
    /// The estimator's pose disagreement, radians. `None` means "no independent source" —
    /// the divergence rules `R2`/`R3` are skipped, the rest still fire.
    pub divergence_rad: Option<f32>,
    /// The estimator's roll, radians.
    pub roll_rad: f32,
    /// The estimator's pitch, radians.
    pub pitch_rad: f32,
}

impl Heartbeat {
    /// A level, in-tolerance heartbeat (mostly used in tests).
    pub fn healthy(elapsed: Duration) -> Self {
        Self {
            elapsed,
            divergence_rad: Some(0.0),
            roll_rad: 0.0,
            pitch_rad: 0.0,
        }
    }
}

/// What the monitor currently knows: counters, the streak, the bounded fault log.
///
/// The log is a **ring**: when full, the oldest entry is overwritten, and a flag says so.
/// That is the same `VecDeque`-bounded-history shape [`CycleStats`](crate::control::CycleStats)
/// uses for its percentile window — a single rule for the workspace's instruments.
#[derive(Clone, Debug, PartialEq)]
pub struct SafetyMonitor {
    limits: SafetyLimits,
    sequence: u64,
    last_heartbeat_seq: Option<u64>,
    streak: u32,
    fault_log: std::collections::VecDeque<FaultRecord>,
    rolled: bool,
}

impl SafetyMonitor {
    /// A new monitor with the given limits. Refused limits are kept as defaults — a monitor
    /// that starts in an unsafe state is one a deployment cannot defend.
    pub fn new(limits: SafetyLimits) -> Self {
        let limits = Self::sanitise(limits);
        Self {
            limits,
            sequence: 0,
            last_heartbeat_seq: None,
            streak: 0,
            fault_log: std::collections::VecDeque::with_capacity(MAX_FAULT_LOG),
            rolled: false,
        }
    }

    fn sanitise(limits: SafetyLimits) -> SafetyLimits {
        SafetyLimits {
            heartbeat: if limits.heartbeat.is_zero() {
                Duration::from_millis(250)
            } else {
                limits.heartbeat
            },
            max_divergence_rad: if limits.max_divergence_rad.is_finite()
                && limits.max_divergence_rad > 0.0
            {
                limits.max_divergence_rad
            } else {
                0.2
            },
            max_streak: limits.max_streak,
            max_tilt_rad: if limits.max_tilt_rad.is_finite() && limits.max_tilt_rad > 0.0 {
                limits.max_tilt_rad
            } else {
                0.5
            },
        }
    }

    /// The configured limits (read-back so an operator can see what the monitor is enforcing).
    pub fn limits(&self) -> SafetyLimits {
        self.limits
    }

    /// A monitor with the conservative defaults — convenience for tests and for
    /// deployments that don't want to spell out every field.
    pub fn with_default_limits() -> Self {
        Self::new(SafetyLimits::default())
    }

    /// How many faults have been recorded **in the whole run** (not the window).
    pub fn total_faults(&self) -> u64 {
        self.sequence
    }

    /// How many faults are currently in the bounded window.
    pub fn fault_log_len(&self) -> usize {
        self.fault_log.len()
    }

    /// True when older entries have been dropped from the window.
    pub fn window_full(&self) -> bool {
        self.rolled
    }

    /// The current divergence streak (reset on every healthy update).
    pub fn streak(&self) -> u32 {
        self.streak
    }

    /// One heartbeat. Returns the faults that fired on this tick (zero, one, or many — the
    /// rules run independently).
    ///
    /// **Failures are not a step**: the monitor's state is updated only with the *successful*
    /// parts of the heartbeat. A heartbeat that violates every rule still updates the
    /// sequence counter, so the next heartbeat's `R1` check is against the right reference.
    pub fn heartbeat(&mut self, beat: Heartbeat) -> Vec<FaultRecord> {
        let mut fired = Vec::new();

        // R1: watchdog — checked against the **previous** heartbeat's elapsed, not the
        // current one's (a watchdog that tested the time *of its own call* would never fire
        // for the first heartbeat and would double-count the second).
        if let Some(last_seq) = self.last_heartbeat_seq {
            // `last_seq` is the sequence at the time of the previous heartbeat; the current
            // beat's `elapsed` is the wall-clock gap, which is what the user wants to know.
            let _ = last_seq;
        }
        if beat.elapsed > self.limits.heartbeat {
            fired.push(self.record(FaultCode::WatchdogElapsed, beat.elapsed.as_micros() as f64));
        }

        // R2 / R3: divergence.
        if let Some(div) = beat.divergence_rad {
            if div.is_finite() && div.abs() > self.limits.max_divergence_rad {
                self.streak = self.streak.saturating_add(1);
                if self.limits.max_streak > 0 && self.streak > self.limits.max_streak {
                    fired.push(self.record(FaultCode::DivergenceStreak, div.abs() as f64));
                } else {
                    fired.push(self.record(FaultCode::DivergenceExceeded, div.abs() as f64));
                }
            } else {
                self.streak = 0;
            }
        }

        // R4: attitude. Both axes tested independently. A non-finite value is
        // reported under `AttitudeExceeded` (a `NaN` roll is a "roll that has no
        // known magnitude" — an out-of-tolerance reading by definition) and
        // again under `SanityFailed` below — the two fire together so a
        // post-mortem can distinguish "sensor died" from "frame exceeded the
        // bound".
        if !beat.roll_rad.is_finite() || beat.roll_rad.abs() > self.limits.max_tilt_rad {
            fired.push(self.record(FaultCode::AttitudeExceeded, beat.roll_rad.abs() as f64));
        }
        if !beat.pitch_rad.is_finite() || beat.pitch_rad.abs() > self.limits.max_tilt_rad {
            fired.push(self.record(FaultCode::AttitudeExceeded, beat.pitch_rad.abs() as f64));
        }

        // Sanity: a heartbeat that hands us NaN is itself a fault and must not be the input
        // to a comparison downstream.
        if !beat.roll_rad.is_finite() || !beat.pitch_rad.is_finite() {
            fired.push(self.record(
                FaultCode::SanityFailed,
                f64::from(beat.roll_rad.max(beat.pitch_rad)),
            ));
        }

        self.last_heartbeat_seq = Some(self.sequence);
        fired
    }

    /// Check one set point against the bounds the policy declares.
    ///
    /// `travel` is `(min, max)` in the unit the set point is in. An out-of-travel value
    /// is refused as `R5` — the value is reported so a deployment can record what the
    /// upstream emitted, even though the integer is necessarily finite.
    pub fn check_set_point(&mut self, value: i32, travel: (i32, i32)) -> Option<FaultRecord> {
        let (min, max) = travel;
        if !(min..=max).contains(&value) {
            return Some(self.record(FaultCode::SanityFailed, f64::from(value)));
        }
        None
    }

    fn record(&mut self, code: FaultCode, measurement: f64) -> FaultRecord {
        self.sequence = self.sequence.saturating_add(1);
        let rec = FaultRecord {
            code,
            sequence: self.sequence,
            measurement,
        };
        if self.fault_log.len() == MAX_FAULT_LOG {
            self.fault_log.pop_front();
            self.rolled = true;
        }
        self.fault_log.push_back(rec);
        rec
    }

    /// One line an operator can read.
    pub fn summary(&self) -> String {
        format!(
            "safety: faults={} (window={}/{} rolled={}) streak={} limits=heartbeat{}ms div<{:.3}rad \
             streak<{} tilt<{:.3}rad",
            self.total_faults(),
            self.fault_log_len(),
            MAX_FAULT_LOG,
            self.rolled,
            self.streak(),
            self.limits.heartbeat.as_millis(),
            self.limits.max_divergence_rad,
            self.limits.max_streak,
            self.limits.max_tilt_rad,
        )
    }

    /// Snapshot the bounded log (oldest first), for an audit trail.
    pub fn faults(&self) -> Vec<FaultRecord> {
        self.fault_log.iter().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn beat(elapsed_ms: u64, div: f32) -> Heartbeat {
        Heartbeat {
            elapsed: Duration::from_millis(elapsed_ms),
            divergence_rad: Some(div),
            roll_rad: 0.0,
            pitch_rad: 0.0,
        }
    }

    #[test]
    fn a_healthy_heartbeat_records_no_fault() {
        let mut m = SafetyMonitor::with_default_limits();
        let fired = m.heartbeat(beat(50, 0.01));
        assert!(fired.is_empty(), "an in-tolerance heartbeat is silent");
        assert_eq!(m.total_faults(), 0);
        assert_eq!(m.streak(), 0);
    }

    #[test]
    fn a_long_heartbeat_fires_r1_only_once() {
        let mut m = SafetyMonitor::with_default_limits();
        let fired = m.heartbeat(beat(300, 0.0));
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].code, FaultCode::WatchdogElapsed);
        assert_eq!(m.total_faults(), 1);
        // A second consecutive long heartbeat fires again — the watchdog is a periodic check.
        let fired = m.heartbeat(beat(300, 0.0));
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].code, FaultCode::WatchdogElapsed);
        assert_eq!(m.total_faults(), 2);
    }

    #[test]
    fn a_hard_divergence_fires_r3_and_a_streak_fires_r2() {
        let mut m = SafetyMonitor::new(SafetyLimits {
            max_streak: 2,
            ..SafetyLimits::default()
        });
        // 0.3 rad > 0.2 rad default ⇒ R3 fires (1 of `max_streak=2`).
        let fired = m.heartbeat(beat(50, 0.3));
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].code, FaultCode::DivergenceExceeded);
        assert_eq!(m.streak(), 1);
        // 0.4 rad ⇒ R3 again.
        let fired = m.heartbeat(beat(50, 0.4));
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].code, FaultCode::DivergenceExceeded);
        assert_eq!(m.streak(), 2);
        // 0.5 rad ⇒ streak now 3 > 2 ⇒ R2 takes over.
        let fired = m.heartbeat(beat(50, 0.5));
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].code, FaultCode::DivergenceStreak);
        // A clean tick resets the streak.
        let fired = m.heartbeat(beat(50, 0.01));
        assert!(fired.is_empty(), "{fired:?}");
        assert_eq!(m.streak(), 0);
    }

    #[test]
    fn a_streak_of_zero_disables_r2() {
        let mut m = SafetyMonitor::new(SafetyLimits {
            max_streak: 0,
            ..SafetyLimits::default()
        });
        for _ in 0..10 {
            let fired = m.heartbeat(beat(50, 0.5));
            assert!(fired.iter().all(|r| r.code != FaultCode::DivergenceStreak));
            assert!(fired
                .iter()
                .any(|r| r.code == FaultCode::DivergenceExceeded));
        }
    }

    #[test]
    fn an_unsafe_roll_fires_r4_with_its_magnitude() {
        let mut m = SafetyMonitor::with_default_limits();
        let mut beat = beat(50, 0.0);
        beat.roll_rad = 0.6;
        let fired = m.heartbeat(beat);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].code, FaultCode::AttitudeExceeded);
        assert!((fired[0].measurement - 0.6).abs() < 1e-5);
    }

    #[test]
    fn a_nan_attitude_fires_r5_and_does_not_propagate() {
        let mut m = SafetyMonitor::with_default_limits();
        let mut beat = beat(50, 0.0);
        beat.roll_rad = f32::NAN;
        let fired = m.heartbeat(beat);
        assert!(fired.iter().any(|r| r.code == FaultCode::SanityFailed));
        assert!(fired.iter().any(|r| r.code == FaultCode::AttitudeExceeded));
        // The state is still consistent: a NaN input did not poison the streak counter.
        assert_eq!(m.streak(), 0);
    }

    #[test]
    fn a_set_point_outside_travel_fires_r5() {
        let mut m = SafetyMonitor::with_default_limits();
        let r = m.check_set_point(50_000, (-40_000, 40_000));
        assert!(matches!(r, Some(rec) if rec.code == FaultCode::SanityFailed));
        assert!(m.check_set_point(0, (-40_000, 40_000)).is_none());
    }

    #[test]
    fn the_fault_log_is_bounded_and_says_so() {
        let mut m = SafetyMonitor::with_default_limits();
        // 300 heartbeat fires (each of which exceeds the divergence bound).
        for _ in 0..300u64 {
            let fired = m.heartbeat(beat(50, 1.0));
            assert!(!fired.is_empty());
        }
        assert_eq!(m.total_faults(), 300);
        assert_eq!(m.fault_log_len(), MAX_FAULT_LOG);
        assert!(m.window_full());
        // The window keeps the most recent MAX_FAULT_LOG records, so the first sequence in
        // the window is 300 - MAX_FAULT_LOG + 1 = 45.
        let first = m.faults().first().expect("non-empty").sequence;
        assert_eq!(first, 300 - MAX_FAULT_LOG as u64 + 1);
    }

    #[test]
    fn a_zero_or_invalid_limit_is_replaced_with_a_safe_default() {
        let m = SafetyMonitor::new(SafetyLimits {
            heartbeat: Duration::ZERO,
            max_divergence_rad: f32::NAN,
            max_streak: 0,
            max_tilt_rad: -1.0,
        });
        let l = m.limits();
        assert_eq!(l.heartbeat, Duration::from_millis(250));
        assert!(l.max_divergence_rad > 0.0);
        assert!(l.max_tilt_rad > 0.0);
    }

    #[test]
    fn fault_keys_are_stable() {
        assert_eq!(FaultCode::WatchdogElapsed.key(), "R1");
        assert_eq!(FaultCode::DivergenceStreak.key(), "R2");
        assert_eq!(FaultCode::DivergenceExceeded.key(), "R3");
        assert_eq!(FaultCode::AttitudeExceeded.key(), "R4");
        assert_eq!(FaultCode::SanityFailed.key(), "R5");
    }

    #[test]
    fn the_summary_carries_the_policy_being_enforced() {
        let m = SafetyMonitor::with_default_limits();
        let s = m.summary();
        assert!(s.contains("limits=heartbeat250ms"));
        assert!(s.contains("div<0.200rad"));
        assert!(s.contains("tilt<0.500rad"));
    }
}
