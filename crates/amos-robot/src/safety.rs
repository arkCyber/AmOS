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
//! | `R4` | Unsafe attitude | Roll/pitch out of [`SafetyLimits::max_tilt_rad`] (a non-finite axis always fires) |
//! | `R5` | Sanity check | A set point is outside its travel, or a reported attitude/divergence is non-finite |
//!
//! Rules are applied **independently**: a firing rule does not silence the others, and the
//! report carries the full set so a post-mortem can see which would have fired first. This
//! is the standard avionics "OR-tree" shape — a chain of simple predicates, each with a
//! bounded, named check.
//!
//! ### What `R1` can and cannot see
//!
//! `R1` tests the **caller-reported** gap `Heartbeat::elapsed`; this monitor owns no clock
//! (`Instant::now` appears nowhere in this file). It therefore catches a loop that is
//! *running late* — a slow tick, a blocked task that still reaches the heartbeat — but it
//! cannot catch a loop that has stopped calling `heartbeat` altogether, because no code
//! here runs in that case. Detecting a fully-hung process is the job of an outer watchdog
//! (a hardware timer, or a supervisor task that itself owns a clock) — and that supervisor
//! task now ships, as [`crate::watchdog`] (REQ-A701, FMEA `F-SH-161`): it watches a
//! [`PetCounter`](crate::watchdog::PetCounter)
//! that [`ControlLoop`](crate::control::ControlLoop) pets each tick
//! (`ControlLoop::with_watchdog`), and `supervise` is the clock-owning loop that reports the
//! stopped-loop case. It is a *software* supervisor, not a hardware timer: if the whole
//! process is wedged, neither side runs and only an external timer or a second core notices
//! (`watchdog.rs`, "Honest boundaries" #1). Stating that limit here is deliberate: a monitor
//! must not claim a capability its inputs cannot carry.
//!
//! ### What is not wired
//!
//! Nothing in this crate calls the monitor — `ControlLoop` and the example do not (the crate
//! README's boundary 2 lists it among the library modules). So "the **last** layer before
//! the bus" states the position this module is *designed* to occupy, not one it occupies in
//! a running pipeline today. (Its *complement*, [`crate::watchdog`], **is** wired: a loop can
//! pet a liveness token via `ControlLoop::with_watchdog`, because a stopped loop cannot call
//! the monitor at all — that half is an observation, not a check.) The refusal is the
//! caller's in any case: the monitor *reports*
//! (a `Vec<FaultRecord>` from [`SafetyMonitor::heartbeat`], an `Option<FaultRecord>` from
//! [`SafetyMonitor::check_set_point`]) and a deployment acts on it. Both statements are
//! here so the opening sentence reads as intent rather than as a description of live wiring.

use std::time::Duration;

/// Upper bound on the number of faults the monitor can hold in one window (NASA Power of 10 #2:
/// fixed-size storage on the safety path).
///
/// 256 is the smallest power-of-two at or above a 100 Hz loop's 2.5 s (250 ticks), so a window
/// holds the first ~2.5 s of faults **at one fault per tick** — long enough to write a log.
/// With a cascade it holds half that: once the streak trips, `R3` and `R2` fire on the *same*
/// tick (see the module doc — the rules are independent), so 256 entries cover ~1.3 s.
/// // chosen: the size is this crate's; nothing here measured a fault rate. The window index
/// is a `usize` (the entries live in a `VecDeque`), **not** a `u8` — an earlier revision of
/// this comment claimed a `u8` index, which neither exists nor could hold 256.
pub const MAX_FAULT_LOG: usize = 256;

/// Default heartbeat period.
///
/// // chosen: 250 ms is 25 ticks of a 100 Hz loop — long enough to ride out a scheduler
/// hiccup, short enough to catch a stalled controller before it can drive far. The `25` is
/// arithmetic; the "long enough / short enough" is this crate's policy, not a measurement.
pub const DEFAULT_HEARTBEAT: Duration = Duration::from_millis(250);

/// Default hard-divergence bound in radians.
///
/// // chosen: 0.2 rad ≈ 11.5° — this crate's policy, not a measurement and not a figure any
/// other module imposes. (An earlier revision cited "the SLAM frontend's own gate"; the
/// gate in `slam::data_assoc` is a **squared-Mahalanobis** test on a landmark's *position*
/// against the `χ²(2)` quantile, so it carries no radian threshold at all. The only `0.2 rad`
/// in `slam/` is `loop_closure::range_theta_rad`, and that is a scan-match *search* half-extent,
/// not a rejection gate.)
pub const DEFAULT_MAX_DIVERGENCE_RAD: f32 = 0.2;

/// Default consecutive-divergence streak bound.
///
/// // chosen: 3 consecutive over-limit updates — one is noise, three is a trend. An aphorism
/// this crate adopted, not a measured settling time.
pub const DEFAULT_MAX_STREAK: u32 = 3;

/// Default unsafe-tilt bound in radians.
///
/// // chosen: 0.5 rad ≈ 28.6°. The claim that this is where a ground vehicle's traction model
/// (or a drone's attitude envelope) stops being valid is uncited — no such model is evaluated
/// anywhere in this crate — so the value is stated here as this crate's policy.
pub const DEFAULT_MAX_TILT_RAD: f32 = 0.5;

/// Largest meaningful divergence limit: π rad. A disagreement between two headings is taken
/// the short way, so no magnitude above half a turn can be reached — accepting a larger limit
/// would silently disable `R3`. // chosen: the half-turn reading is this crate's definition of
/// "disagreement". (An earlier revision carried `// cited: an angle's range is bounded by 2π
/// (ISO 80000-3)`. ISO 80000-3 defines the *plane angle* as item 3-5 with `α = s/r` and the
/// radian as its unit — it states no bound on an angle's range, and an angle so defined is not
/// bounded by 2π. The bound that matters here is on a reduced disagreement, not on an angle.)
pub const MAX_DIVERGENCE_LIMIT_RAD: f32 = std::f32::consts::PI;

/// Largest meaningful tilt limit: π/2 rad. Past 90° of roll or pitch the body frame has
/// tipped beyond a vehicle; a larger limit would silently disable `R4`.
pub const MAX_TILT_LIMIT_RAD: f32 = std::f32::consts::FRAC_PI_2;

/// One rule the monitor can fire.
///
/// The **key** ([`FaultCode::key`], `"R1"`..`"R5"`) is the stable identifier an operator greps
/// for in a log. An earlier revision of this comment said "the discriminant is part of the
/// wire format" — there is no wire format: `FaultCode` derives no `Serialize`/`Deserialize`
/// and nothing in the workspace reads or writes one, so the *key*, not the discriminant, is
/// what a reader is expected to match on.
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
    /// `R5`: an input failed its sanity check. That is either an attitude/divergence that is
    /// non-finite (a NaN is neither below `R3`/`R4`'s bound nor above it, so those rules cannot
    /// see it and the value is reported here instead), or a set point outside the joint's
    /// travel (`check_set_point`).
    ///
    /// A **non-finite set point** is not on that list and cannot be: `check_set_point` takes an
    /// `i32`, which is always finite. An earlier revision of this doc listed it, contradicting
    /// the rule table in the module header, which correctly omits it.
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
    /// (`R1` records the elapsed time in microseconds; `R2`/`R3` record the divergence in
    /// radians; `R4` the tilt in radians; `R5` the offending set point **or**, for a
    /// non-finite attitude/divergence, the non-finite value itself).
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
            // `R5` covers both an out-of-travel set point and a non-finite reported value,
            // so the line names the *value* rather than assuming it is a set point. The
            // `{:.4}` form (not `as i32`) keeps a `NaN`/`inf` measurement legible instead of
            // rendering it as a misleading `0`.
            FaultCode::SanityFailed => {
                format!("{}: bad value {:.4}", self.code.key(), self.measurement)
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
    /// The conservative defaults: [`DEFAULT_HEARTBEAT`], [`DEFAULT_MAX_DIVERGENCE_RAD`],
    /// [`DEFAULT_MAX_STREAK`], [`DEFAULT_MAX_TILT_RAD`].
    pub fn conservative() -> Self {
        Self {
            heartbeat: DEFAULT_HEARTBEAT,
            max_divergence_rad: DEFAULT_MAX_DIVERGENCE_RAD,
            max_streak: DEFAULT_MAX_STREAK,
            max_tilt_rad: DEFAULT_MAX_TILT_RAD,
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
            streak: 0,
            fault_log: std::collections::VecDeque::with_capacity(MAX_FAULT_LOG),
            rolled: false,
        }
    }

    /// Bring every out-of-domain limit back into its domain, by **one of two** remedies — the
    /// choice of remedy depends on which way the limit left the domain (REQ-A687):
    ///
    /// - **Zero or non-finite → replaced by the default.** A non-positive bound would make the
    ///   rule fire unconditionally — an alarm that always rings is one an operator silences —
    ///   and a `NaN`/`∞` comparison is not even a bound. There is no meaningful value to clamp
    ///   *to*, so the default is the answer.
    /// - **Above the geometric maximum → clamped to that maximum** ([`MAX_DIVERGENCE_LIMIT_RAD`],
    ///   [`MAX_TILT_LIMIT_RAD`]). A limit past the maximum can never fire — the same as turning
    ///   the rule off — but a finite over-large number still carries the caller's intent to be
    ///   *loose*, so the enforced bound becomes the loosest one the rule table is stated over,
    ///   not the default. This is what `an_oversized_limit_is_clamped_to_the_geometric_maximum`
    ///   pins; an earlier revision of *this* doc claimed both cases were replaced by the default,
    ///   which the code never did.
    ///
    /// Read [`SafetyMonitor::limits`] back to see which remedy was applied — the two are
    /// observable and different.
    ///
    /// `max_streak` is *not* clamped: `0` is a documented policy choice
    /// ([`SafetyLimits::max_streak`]) meaning "disable `R2`", and a large value is the
    /// operator deliberately loosening the streak rule. Policy is the caller's; the
    /// domain limits above are not.
    fn sanitise(limits: SafetyLimits) -> SafetyLimits {
        SafetyLimits {
            heartbeat: if limits.heartbeat.is_zero() {
                DEFAULT_HEARTBEAT
            } else {
                limits.heartbeat
            },
            max_divergence_rad: if limits.max_divergence_rad.is_finite()
                && limits.max_divergence_rad > 0.0
            {
                limits.max_divergence_rad.min(MAX_DIVERGENCE_LIMIT_RAD)
            } else {
                DEFAULT_MAX_DIVERGENCE_RAD
            },
            max_streak: limits.max_streak,
            max_tilt_rad: if limits.max_tilt_rad.is_finite() && limits.max_tilt_rad > 0.0 {
                limits.max_tilt_rad.min(MAX_TILT_LIMIT_RAD)
            } else {
                DEFAULT_MAX_TILT_RAD
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
    /// **A fault is not a dropped beat**: a heartbeat that violates a rule still advances
    /// the divergence streak and the fault sequence counter, so a monitor that refuses one
    /// tick does not silently reset itself on the next.
    pub fn heartbeat(&mut self, beat: Heartbeat) -> Vec<FaultRecord> {
        let mut fired = Vec::new();

        // R1: watchdog. The caller reports `beat.elapsed` as the wall-clock gap since the
        // previous heartbeat, so the check is a single comparison — there is no need to
        // reconstruct the gap from the sequence counters.
        if beat.elapsed > self.limits.heartbeat {
            fired.push(self.record(FaultCode::WatchdogElapsed, beat.elapsed.as_micros() as f64));
        }

        // R2 / R3: divergence. `None` is the documented "no independent source" and skips
        // both; a `Some` that is *non-finite* is a different thing entirely — a source that
        // reported and died. It is a sanity fault (`R5`) and must **not** reset the streak:
        // the old code fell into the `else` branch here and cleared the streak, so a sensor
        // alternating live/`NaN` could never accumulate one and `R2` would never fire.
        if let Some(div) = beat.divergence_rad {
            if !div.is_finite() {
                fired.push(self.record(FaultCode::SanityFailed, f64::from(div)));
            } else if div.abs() > self.limits.max_divergence_rad {
                self.streak = self.streak.saturating_add(1);
                // R3 (hard divergence) and R2 (streak) are **independent** rules, as the
                // module doc promises: the streak exceeding its bound must not silence the
                // level check. Both are reported, R3 first, so a post-mortem sees the full
                // set. The measurement each carries is the divergence that tripped it.
                fired.push(self.record(FaultCode::DivergenceExceeded, div.abs() as f64));
                if self.limits.max_streak > 0 && self.streak > self.limits.max_streak {
                    fired.push(self.record(FaultCode::DivergenceStreak, div.abs() as f64));
                }
            } else {
                self.streak = 0;
            }
        }

        // R4: attitude. Both axes tested independently. A non-finite value is reported under
        // `AttitudeExceeded` (a `NaN` roll is a "roll that has no known magnitude" — an
        // out-of-tolerance reading by definition) with the offending value preserved as-is,
        // and again under `SanityFailed` below — the two fire together so a post-mortem can
        // distinguish "sensor died" from "frame exceeded the bound".
        if !beat.roll_rad.is_finite() || beat.roll_rad.abs() > self.limits.max_tilt_rad {
            fired.push(self.record(FaultCode::AttitudeExceeded, f64::from(beat.roll_rad.abs())));
        }
        if !beat.pitch_rad.is_finite() || beat.pitch_rad.abs() > self.limits.max_tilt_rad {
            fired.push(self.record(FaultCode::AttitudeExceeded, f64::from(beat.pitch_rad.abs())));
        }

        // Sanity: a heartbeat that hands us NaN is itself a fault and must not be the input
        // to a comparison downstream. The offending axis is recorded **as it arrived** — the
        // old `f32::max` dropped the `NaN` (IEEE `max` returns the non-NaN operand), so a
        // `roll = NaN, pitch = 0` beat was logged as the finite `0.0` with no trace of the
        // fault. `roll` leads so the two-axis case is deterministic.
        let bad_axis = if !beat.roll_rad.is_finite() {
            Some(beat.roll_rad)
        } else if !beat.pitch_rad.is_finite() {
            Some(beat.pitch_rad)
        } else {
            None
        };
        if let Some(axis) = bad_axis {
            fired.push(self.record(FaultCode::SanityFailed, f64::from(axis)));
        }

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

    /// `R1` fires strictly *after* the period — a gap exactly equal to the limit is on time.
    /// Without this boundary case an implementation using `>=` would pass every other test.
    #[test]
    fn the_watchdog_boundary_is_exclusive() {
        let mut m = SafetyMonitor::with_default_limits();
        let exactly = DEFAULT_HEARTBEAT.as_millis() as u64;
        assert!(
            m.heartbeat(beat(exactly, 0.0)).is_empty(),
            "a gap exactly at the limit is on time"
        );
        let fired = m.heartbeat(beat(exactly + 1, 0.0));
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].code, FaultCode::WatchdogElapsed);
    }

    #[test]
    fn a_hard_divergence_fires_r3_and_a_streak_fires_r2_together() {
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
        // 0.5 rad ⇒ streak now 3 > 2. The rules are independent, so **both** fire this tick:
        // the hard divergence is still exceeded, and the streak has now tripped. Suppressing
        // R3 here (the old behaviour) would hide the more severe rule for the whole duration
        // of a sustained fault.
        let fired = m.heartbeat(beat(50, 0.5));
        assert_eq!(fired.len(), 2, "{fired:?}");
        assert_eq!(fired[0].code, FaultCode::DivergenceExceeded);
        assert_eq!(fired[1].code, FaultCode::DivergenceStreak);
        // A clean tick resets the streak.
        let fired = m.heartbeat(beat(50, 0.01));
        assert!(fired.is_empty(), "{fired:?}");
        assert_eq!(m.streak(), 0);
    }

    /// `R3` fires at the boundary strictly above the limit, not at it.
    #[test]
    fn the_divergence_boundary_is_exclusive() {
        let mut m = SafetyMonitor::with_default_limits();
        let at_limit = f64::from(DEFAULT_MAX_DIVERGENCE_RAD) as f32;
        assert!(
            m.heartbeat(beat(50, at_limit)).is_empty(),
            "divergence exactly at the limit is in tolerance"
        );
        let fired = m.heartbeat(beat(50, at_limit + 1e-4));
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].code, FaultCode::DivergenceExceeded);
    }

    /// A non-finite divergence is a dead source, not a healthy reading: it fires `R5` and
    /// must not clear the streak (the old code cleared it, so live/NaN alternation could
    /// never reach `R2`).
    #[test]
    fn a_nan_divergence_fires_r5_and_does_not_reset_the_streak() {
        let mut m = SafetyMonitor::with_default_limits();
        for _ in 0..3 {
            let fired = m.heartbeat(beat(50, 0.5));
            assert!(fired
                .iter()
                .any(|r| r.code == FaultCode::DivergenceExceeded));
        }
        let streak_before = m.streak();
        assert_eq!(streak_before, 3);
        let fired = m.heartbeat(beat(50, f32::NAN));
        assert_eq!(fired.len(), 1, "{fired:?}");
        assert_eq!(fired[0].code, FaultCode::SanityFailed);
        assert!(fired[0].measurement.is_nan(), "the NaN must be recorded");
        assert_eq!(
            m.streak(),
            streak_before,
            "a dead sensor is not evidence of a healthy update"
        );
    }

    /// A `None` divergence is the documented "no independent source": the divergence rules
    /// are skipped entirely (and the streak is left alone), unlike a `Some(NaN)`.
    #[test]
    fn a_missing_divergence_skips_the_divergence_rules() {
        let mut m = SafetyMonitor::with_default_limits();
        let mut b = beat(50, 0.0);
        b.divergence_rad = None;
        let fired = m.heartbeat(b);
        assert!(fired.is_empty(), "{fired:?}");
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
        // The NaN roll fires R4 (out of tolerance by definition); the finite pitch is in
        // tolerance and stays silent; then R5 names the bad axis.
        assert_eq!(fired.len(), 2, "{fired:?}");
        assert_eq!(fired[0].code, FaultCode::AttitudeExceeded);
        assert!(fired[0].measurement.is_nan(), "the NaN axis is preserved");
        assert_eq!(fired[1].code, FaultCode::SanityFailed);
        assert!(
            fired[1].measurement.is_nan(),
            "the old `f32::max` recorded this as 0.0, losing the fault"
        );
        // The state is still consistent: a NaN input did not poison the streak counter.
        assert_eq!(m.streak(), 0);
    }

    #[test]
    fn a_set_point_outside_travel_fires_r5() {
        let mut m = SafetyMonitor::with_default_limits();
        let r = m.check_set_point(50_000, (-40_000, 40_000));
        assert!(matches!(r, Some(rec) if rec.code == FaultCode::SanityFailed));
        // The travel is inclusive on both ends: the exact bounds are in travel, one past
        // them is not. (Without the inclusive cases, a `min..max` off-by-one passes.)
        assert!(m.check_set_point(40_000, (-40_000, 40_000)).is_none());
        assert!(m.check_set_point(-40_000, (-40_000, 40_000)).is_none());
        assert!(m.check_set_point(40_001, (-40_000, 40_000)).is_some());
        assert!(m.check_set_point(-40_001, (-40_000, 40_000)).is_some());
        assert!(m.check_set_point(0, (-40_000, 40_000)).is_none());
    }

    #[test]
    fn the_fault_log_is_bounded_and_says_so() {
        let mut m = SafetyMonitor::with_default_limits();
        // 300 over-limit heartbeats. Ticks 1..=3 exceed the divergence bound but are still
        // inside the `max_streak = 3` window (1 fault each, R3); from tick 4 the streak is
        // exceeded too, so both R3 and R2 fire (2 faults each).
        for _ in 0..300u64 {
            let fired = m.heartbeat(beat(50, 1.0));
            assert!(!fired.is_empty());
        }
        let expected = 3 + (300 - 3) * 2;
        assert_eq!(m.total_faults(), expected);
        assert_eq!(m.fault_log_len(), MAX_FAULT_LOG);
        assert!(m.window_full());
        // The window keeps the most recent MAX_FAULT_LOG records.
        let first = m.faults().first().expect("non-empty").sequence;
        assert_eq!(first, expected - MAX_FAULT_LOG as u64 + 1);
    }

    #[test]
    fn a_zero_or_invalid_limit_is_replaced_with_a_safe_default() {
        let m = SafetyMonitor::new(SafetyLimits {
            heartbeat: Duration::ZERO,
            max_divergence_rad: f32::NAN,
            max_streak: 0,
            max_tilt_rad: -1.0,
        });
        // The exact defaults, not merely "some positive value" — replacing the fallback
        // with any other positive number must fail this. `max_streak` is deliberately NOT
        // sanitised (0 is a documented policy choice), so it stays 0 here.
        let l = m.limits();
        assert_eq!(l.heartbeat, DEFAULT_HEARTBEAT);
        assert_eq!(l.max_divergence_rad, DEFAULT_MAX_DIVERGENCE_RAD);
        assert_eq!(l.max_tilt_rad, DEFAULT_MAX_TILT_RAD);
        assert_eq!(
            l.max_streak, 0,
            "max_streak is policy, left as the caller set it"
        );
    }

    /// A limit past its geometric maximum is clamped back to that maximum, **not** replaced
    /// by the default and not accepted: the enforced bound is the largest one the rule table
    /// is stated over.
    ///
    /// The two remedies [`SafetyMonitor::sanitise`] applies are **different** — a
    /// zero/non-finite bound gets the default, an over-large one gets the geometric maximum —
    /// so this pins which remedy this branch takes. A later revision that "fixed" the clamp
    /// to fall back to the default (as an earlier revision of `sanitise`'s own doc promised)
    /// would turn `1e30` into `0.2`, and the `assert_ne!`s below are what refuse that.
    #[test]
    fn an_oversized_limit_is_clamped_to_the_geometric_maximum() {
        let m = SafetyMonitor::new(SafetyLimits {
            max_divergence_rad: 1e30,
            max_tilt_rad: 1e30,
            ..SafetyLimits::conservative()
        });
        assert_eq!(m.limits().max_divergence_rad, MAX_DIVERGENCE_LIMIT_RAD);
        assert_eq!(m.limits().max_tilt_rad, MAX_TILT_LIMIT_RAD);
        assert_ne!(
            m.limits().max_divergence_rad,
            DEFAULT_MAX_DIVERGENCE_RAD,
            "an over-large bound is clamped to the maximum, not replaced by the default"
        );
        assert_ne!(
            m.limits().max_tilt_rad,
            DEFAULT_MAX_TILT_RAD,
            "an over-large bound is clamped to the maximum, not replaced by the default"
        );
    }

    /// The `is_finite` leaf of both bound checks — and why `∞` is not the same input as an
    /// over-large *finite* one.
    ///
    /// [`SafetyMonitor::sanitise`]'s own doc names `∞` explicitly ("a `NaN`/`∞` comparison is
    /// not even a bound" ⇒ *zero or non-finite → the default*), and the code implements it —
    /// but no test ever walked it. Measured: deleting `limits.max_divergence_rad.is_finite() &&`
    /// (or the matching leaf on `max_tilt_rad`) leaves the whole `safety::` suite green (20
    /// passed). The two neighbours pin only the `> 0.0` leaf (`−1.0`, `NaN`) and the `.min()`
    /// clamp (`1e30`), and `∞` is the **sole** input that reaches the finiteness leaf alone:
    /// `NaN > 0.0` is `false`, so a `NaN` is caught by `> 0.0` too, and `−∞ > 0.0` is `false`.
    ///
    /// That matters because the two remedies are opposites in intent. A caller that passed
    /// `∞` asked for "no bound at all", and the enforced answer is the **conservative
    /// default** — not the loosest bound the rule table is stated over. Without the leaf the
    /// clamp would take it and `R3`/`R4` would be silently widened to π rad / π⁄2 rad, i.e.
    /// the monitor would stop guarding the very axis the caller widened.
    ///
    /// The finite over-large control in the same test shows the branch discriminates on
    /// *finiteness*, not on magnitude: `1e30` and `∞` are both huge and must take different
    /// remedies.
    #[test]
    fn an_infinite_limit_is_substituted_not_clamped_to_the_geometric_maximum() {
        let infinite = SafetyMonitor::new(SafetyLimits {
            max_divergence_rad: f32::INFINITY,
            max_tilt_rad: f32::INFINITY,
            ..SafetyLimits::conservative()
        });
        assert_eq!(
            infinite.limits().max_divergence_rad,
            DEFAULT_MAX_DIVERGENCE_RAD,
            "an unbounded divergence limit is not a bound: it takes the default"
        );
        assert_eq!(
            infinite.limits().max_tilt_rad,
            DEFAULT_MAX_TILT_RAD,
            "an unbounded tilt limit is not a bound: it takes the default"
        );
        assert_ne!(
            infinite.limits().max_divergence_rad,
            MAX_DIVERGENCE_LIMIT_RAD,
            "∞ must not be read as an over-large finite bound"
        );
        assert_ne!(
            infinite.limits().max_tilt_rad,
            MAX_TILT_LIMIT_RAD,
            "∞ must not be read as an over-large finite bound"
        );

        // Control: a *finite* over-large bound takes the other remedy (the geometric
        // maximum), so the assertions above cannot be passing because every huge value is
        // replaced by the default.
        let oversized = SafetyMonitor::new(SafetyLimits {
            max_divergence_rad: 1e30,
            max_tilt_rad: 1e30,
            ..SafetyLimits::conservative()
        });
        assert_eq!(
            oversized.limits().max_divergence_rad,
            MAX_DIVERGENCE_LIMIT_RAD
        );
        assert_eq!(oversized.limits().max_tilt_rad, MAX_TILT_LIMIT_RAD);
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

    /// The **pitch** axis of `R4` and its `R5` ladder arm. The NaN-roll test above exercises
    /// the first `if`; if the pitch check or the `else if` that names the pitch axis were
    /// dropped, nothing else here would notice — the ladder's second arm is exactly the
    /// branch that only a NaN/over-tilt *pitch* reaches.
    #[test]
    fn a_nan_pitch_fires_r4_and_r5_and_names_the_pitch_axis() {
        let mut m = SafetyMonitor::with_default_limits();
        let mut beat = beat(50, 0.0);
        beat.pitch_rad = f32::NAN;
        let fired = m.heartbeat(beat);
        assert_eq!(fired.len(), 2, "{fired:?}");
        // The roll is level and in tolerance, so the only `R4` is the pitch one.
        assert_eq!(fired[0].code, FaultCode::AttitudeExceeded);
        assert!(fired[0].measurement.is_nan(), "the pitch axis is preserved");
        assert_eq!(fired[1].code, FaultCode::SanityFailed);
        assert!(fired[1].measurement.is_nan());
    }

    #[test]
    fn an_over_tilt_pitch_fires_r4_with_its_magnitude() {
        let mut m = SafetyMonitor::with_default_limits();
        let mut beat = beat(50, 0.0);
        beat.pitch_rad = 0.6; // default max_tilt_rad is 0.5
        let fired = m.heartbeat(beat);
        assert_eq!(fired.len(), 1, "{fired:?}");
        assert_eq!(fired[0].code, FaultCode::AttitudeExceeded);
        assert!((fired[0].measurement - 0.6).abs() < 1e-5);
        // A finite out-of-tolerance reading is *not* a sanity fault — the sensor is alive.
        assert_eq!(m.total_faults(), 1);
    }

    /// `FaultRecord::summary` is the operator-facing line: it is the only thing a post-mortem
    /// reads, and it is where a `NaN` measurement must stay legible (the `{:.4}` form rather
    /// than an `as i32`, which would render it as a misleading `0`).
    #[test]
    fn every_fault_code_renders_one_operator_line() {
        let rec = |code, measurement| FaultRecord {
            code,
            sequence: 1,
            measurement,
        };
        let r1 = rec(FaultCode::WatchdogElapsed, 12_500.0).summary();
        assert!(r1.starts_with("R1"), "got {r1}");
        assert!(
            r1.contains("12.500 ms"),
            "microseconds must render as ms: {r1}"
        );

        let r2 = rec(FaultCode::DivergenceStreak, 0.25).summary();
        assert!(r2.starts_with("R2"), "got {r2}");
        assert!(r2.contains("0.2500 rad"), "got {r2}");

        let r3 = rec(FaultCode::DivergenceExceeded, 0.25).summary();
        assert!(r3.starts_with("R3"), "got {r3}");
        assert!(r3.contains("0.2500 rad"), "got {r3}");

        let r4 = rec(FaultCode::AttitudeExceeded, 0.6).summary();
        assert!(r4.starts_with("R4"), "got {r4}");
        assert!(r4.contains("0.6000 rad"), "got {r4}");

        let r5 = rec(FaultCode::SanityFailed, 50_000.0).summary();
        assert!(r5.starts_with("R5"), "got {r5}");
        assert!(r5.contains("50000.0000"), "got {r5}");

        // The legibility claim: a non-finite measurement renders as a word, not a `0`.
        let nan = rec(FaultCode::SanityFailed, f64::NAN).summary();
        assert!(nan.contains("NaN"), "a NaN must not render as 0: {nan}");
        let inf = rec(FaultCode::SanityFailed, f64::INFINITY).summary();
        assert!(inf.contains("inf"), "got {inf}");
    }

    /// The `healthy` constructor is what every test and every "level, in-tolerance" fixture
    /// builds; it must be exactly that — level on both axes, with a divergence *source*
    /// present (`Some(0.0)`, not `None`, which would silently skip `R2`/`R3`).
    #[test]
    fn the_healthy_constructor_is_level_and_has_a_divergence_source() {
        let beat = Heartbeat::healthy(Duration::from_millis(50));
        assert_eq!(beat.divergence_rad, Some(0.0));
        assert_eq!(beat.roll_rad, 0.0);
        assert_eq!(beat.pitch_rad, 0.0);
        // And it is silent against the conservative defaults.
        let mut m = SafetyMonitor::with_default_limits();
        assert!(m.heartbeat(beat).is_empty());
    }
}
