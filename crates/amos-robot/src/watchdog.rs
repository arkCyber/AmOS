//! An **external watchdog**: a supervisor that owns its own clock and detects a control loop
//! that has *stopped*, which the in-loop [`SafetyMonitor`](crate::safety::SafetyMonitor)
//! cannot see.
//!
//! The monitor's `R1` tests the gap the **caller reports** — it owns no clock, so it catches
//! a loop that is *running late* but never one that has stopped calling in altogether: no
//! code runs in that case (`safety.rs`, "What `R1` can and cannot see"). Closing that hole
//! needs an **independent** observer, and that is this module:
//!
//! ```text
//!   control loop (may be hung)          supervisor task (owns the clock)
//!        │  pet() each tick ──► PetCounter ──► Watchdog::poll(now)
//!        │    (one atomic ++)                   │
//!        ▼                                       ▼
//!     driving the machine          Alive  |  Expired { silent_for }
//! ```
//!
//! The **split** is the point. The monitored side holds a [`PetCounter`] and bumps it every
//! tick — one relaxed atomic increment, no clock read, no lock. The supervisor side holds a
//! [`Watchdog`] and owns the clock: it polls on its own schedule and compares the token
//! against what it last saw. A loop that is merely *slow* keeps petting (the token advances,
//! [`WatchdogVerdict::Alive`]); a loop that has *hung* stops, and once the token has been
//! still for longer than [`Watchdog::deadline`] the supervisor reports
//! [`WatchdogVerdict::Expired`] — the verdict the monitor could never produce.
//!
//! [`Watchdog::poll`] takes `now` as an argument rather than reading a clock itself, so the
//! expiry logic is deterministic and testable **without real time** — the same "instrument
//! measures, the caller owns the clock" rule [`CycleStats`](crate::control::CycleStats)
//! follows. The async [`supervise`] helper is the one place a real clock is read; a
//! deployment spawns it, and a test drives [`Watchdog::poll`] directly.
//!
//! # Honest boundaries
//!
//! 1. **This is a software supervisor, not a hardware watchdog.** It detects a hung
//!    *monitored* task only while the *supervisor* itself keeps running. If the whole process
//!    is wedged (a global lock held by a third party, the scheduler starved, the CPU halted)
//!    neither side runs, and only an external timer or a second core can notice. What this
//!    buys over `R1` is exactly the case `R1` cannot see: one task stops while the rest of the
//!    process is healthy.
//! 2. **It reports; it does not act.** `poll` returns a verdict, like every other instrument
//!    in this crate — stopping the machine is the deployment's call (the same refusal
//!    `safety.rs` states for its own monitor).
//! 3. **The deadline is a policy, not a measurement.** This crate measures no task's failure
//!    mode; the number a deployment passes is its own (the same rule as
//!    [`CycleStats`](crate::control::CycleStats)'s `slack`).
//! 4. **A pet is proof of life, not of progress.** A loop that ticks but does nothing useful
//!    still pets. Liveness is what a watchdog is for; "the work is *correct*" is the job of
//!    the safety monitor and the tests, not of this module.

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

/// A watchdog must be given a **nonzero** deadline (and a supervisor a nonzero poll
/// interval): a watchdog that fires on the poll that created it is not a watchdog.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchdogError {
    /// The deadline was zero.
    ZeroDeadline,
    /// The poll interval was zero.
    ZeroPollInterval,
}

impl fmt::Display for WatchdogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WatchdogError::ZeroDeadline => f.write_str("a watchdog deadline must be nonzero"),
            WatchdogError::ZeroPollInterval => {
                f.write_str("a supervisor poll interval must be nonzero")
            }
        }
    }
}

impl std::error::Error for WatchdogError {}

/// The **monitored** side's liveness token: one atomic counter, bumped once per tick.
///
/// Cheap and cloneable on purpose — the loop holds one clone and the supervisor (via
/// [`Watchdog::new`]) holds another, both over the same `Arc<AtomicU64>`. Reading and
/// petting are `Relaxed`: the count carries no data, only "how many times the loop reached
/// this point", so no ordering with any other memory is implied.
#[derive(Clone, Debug, Default)]
pub struct PetCounter(Arc<AtomicU64>);

impl PetCounter {
    /// A fresh token at count `0`.
    pub fn new() -> Self {
        Self(Arc::new(AtomicU64::new(0)))
    }

    /// Record one tick and return the new count.
    ///
    /// The count is `u64`; reaching its wrap point would take `2^64` ticks (at 100 Hz, an
    /// age longer than the universe), and even then the supervisor only asks "did it
    /// change", so a wrap is harmless.
    pub fn pet(&self) -> u64 {
        self.0.fetch_add(1, Ordering::Relaxed).wrapping_add(1)
    }

    /// How many pets have been recorded so far.
    pub fn count(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

/// What one [`Watchdog::poll`] concluded about the monitored work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchdogVerdict {
    /// The token advanced since the last poll, **or** the deadline has not yet passed: the
    /// monitored work is alive. `count` is the token's value at this poll.
    Alive {
        /// The token's value at this poll.
        count: u64,
    },
    /// The token has not advanced for longer than the deadline: the monitored work has
    /// stopped. `silent_for` is how long it has been still, measured from the poll that last
    /// saw it advance (or, before the first advance, from construction).
    Expired {
        /// How long the token has been still, at this poll.
        silent_for: Duration,
        /// The token's value at this poll (unchanged from the previous poll).
        count: u64,
    },
}

impl WatchdogVerdict {
    /// `true` for [`WatchdogVerdict::Expired`].
    pub fn is_expired(self) -> bool {
        matches!(self, WatchdogVerdict::Expired { .. })
    }
}

/// The **supervisor** side: owns the clock and watches a [`PetCounter`].
///
/// Construct it with the *current* time, then call [`Watchdog::poll`] on the supervisor's own
/// schedule. "The deadline has passed" is measured from the last poll that saw the token
/// advance — or, before the first advance, from construction — so a loop that never pets at
/// all expires exactly like one that petted and then stopped.
#[derive(Clone, Debug)]
pub struct Watchdog {
    counter: PetCounter,
    deadline: Duration,
    last_count: u64,
    last_change: Instant,
    expirations: u64,
}

impl Watchdog {
    /// Watch `counter` with `deadline`, treating `now` as the moment the token was last seen
    /// to advance. Refuses a zero deadline.
    pub fn new(
        counter: PetCounter,
        deadline: Duration,
        now: Instant,
    ) -> Result<Self, WatchdogError> {
        if deadline.is_zero() {
            return Err(WatchdogError::ZeroDeadline);
        }
        Ok(Self {
            last_count: counter.count(),
            counter,
            deadline,
            last_change: now,
            expirations: 0,
        })
    }

    /// The deadline this watchdog was built with.
    pub fn deadline(&self) -> Duration {
        self.deadline
    }

    /// How many polls have ended in [`WatchdogVerdict::Expired`]. A supervisor that keeps
    /// polling after an expiry keeps counting (each poll is its own verdict); a deployment
    /// that acts on the first one stops polling.
    pub fn expirations(&self) -> u64 {
        self.expirations
    }

    /// Poll the token at time `now`.
    ///
    /// If the token advanced since the last poll, the watchdog re-arms (records `now` as the
    /// last change) and answers [`WatchdogVerdict::Alive`]. Otherwise it answers `Alive`
    /// until the token has been still for **longer than** `deadline` (the comparison is
    /// strict, so a token that has been still for exactly `deadline` is not yet expired), and
    /// [`WatchdogVerdict::Expired`] after that.
    pub fn poll(&mut self, now: Instant) -> WatchdogVerdict {
        let count = self.counter.count();
        if count != self.last_count {
            self.last_count = count;
            self.last_change = now;
            return WatchdogVerdict::Alive { count };
        }
        let silent_for = now.saturating_duration_since(self.last_change);
        if silent_for > self.deadline {
            self.expirations += 1;
            WatchdogVerdict::Expired { silent_for, count }
        } else {
            WatchdogVerdict::Alive { count }
        }
    }
}

/// How a [`supervise`] run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchdogOutcome {
    /// The monitored work stopped petting for longer than the deadline.
    Expired {
        /// How long the token was still when the expiry was detected.
        silent_for: Duration,
        /// The token's value at the detecting poll.
        count: u64,
    },
    /// The `stop` flag was set before an expiry was seen.
    Stopped,
}

/// Run a supervisor until the monitored work expires or `stop` is set.
///
/// This is the one place a real clock is read (`tokio::time`): it polls every `poll_interval`
/// and returns the first [`WatchdogOutcome::Expired`]. An already-set `stop` polls **zero**
/// times (an already-stopped supervisor that still reports is not stopped) — the same rule
/// [`ControlLoop::run_until`](crate::control::ControlLoop::run_until) keeps. `stop` is checked
/// before every poll, so a flag set during a poll is honoured on the next one.
///
/// A test drives [`Watchdog::poll`] directly for determinism; this helper exists so a
/// deployment has a supervisor to spawn.
pub async fn supervise(
    mut watchdog: Watchdog,
    poll_interval: Duration,
    stop: &AtomicBool,
) -> Result<WatchdogOutcome, WatchdogError> {
    if poll_interval.is_zero() {
        return Err(WatchdogError::ZeroPollInterval);
    }
    let mut ticker = tokio::time::interval(poll_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        if stop.load(Ordering::Relaxed) {
            return Ok(WatchdogOutcome::Stopped);
        }
        if let WatchdogVerdict::Expired { silent_for, count } = watchdog.poll(Instant::now()) {
            return Ok(WatchdogOutcome::Expired { silent_for, count });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Instant;

    const DEADLINE: Duration = Duration::from_millis(100);

    /// A watchdog at a fixed origin, so every `poll` in this module is fed a hand-picked
    /// `now` and no test reads a real clock.
    fn at(t0: Instant, counter: PetCounter) -> Watchdog {
        Watchdog::new(counter, DEADLINE, t0).expect("a nonzero deadline is accepted")
    }

    #[test]
    fn a_zero_deadline_is_refused() {
        let t0 = Instant::now();
        assert_eq!(
            Watchdog::new(PetCounter::new(), Duration::ZERO, t0).unwrap_err(),
            WatchdogError::ZeroDeadline
        );
    }

    #[test]
    fn pet_advances_the_token_and_count_reads_it_back() {
        let counter = PetCounter::new();
        assert_eq!(counter.count(), 0);
        assert_eq!(counter.pet(), 1, "pet returns the new count");
        assert_eq!(counter.pet(), 2);
        assert_eq!(counter.count(), 2);
    }

    /// The strict boundary: exactly `deadline` of silence is **not** yet expired; one
    /// nanosecond more is. A `>=` here would fire a poll early, so it is pinned.
    #[test]
    fn the_deadline_is_a_strict_boundary() {
        let t0 = Instant::now();
        let mut watchdog = at(t0, PetCounter::new());
        // A loop that never pets expires like one that petted and stopped: silence is
        // measured from construction.
        let exactly = watchdog.poll(t0 + DEADLINE);
        assert_eq!(
            exactly,
            WatchdogVerdict::Alive { count: 0 },
            "one nanosecond shy of the deadline is still alive"
        );
        let past = watchdog.poll(t0 + DEADLINE + Duration::from_nanos(1));
        assert_eq!(
            past,
            WatchdogVerdict::Expired {
                silent_for: DEADLINE + Duration::from_nanos(1),
                count: 0,
            }
        );
    }

    #[test]
    fn a_pet_re_arms_the_deadline_from_the_poll_that_saw_it() {
        let t0 = Instant::now();
        let counter = PetCounter::new();
        let mut watchdog = at(t0, counter.clone());
        // 90 ms in: still inside the deadline, then the loop pets.
        assert!(!watchdog.poll(t0 + Duration::from_millis(90)).is_expired());
        counter.pet();
        // The poll that *sees* the advance re-arms at its own `now`.
        assert_eq!(
            watchdog.poll(t0 + Duration::from_millis(95)),
            WatchdogVerdict::Alive { count: 1 }
        );
        // 100 ms after the re-arm (95 + 100) is alive; one ns more is expired — the counter
        // never advanced again, so this is the hung case.
        assert!(!watchdog.poll(t0 + Duration::from_millis(195)).is_expired());
        assert!(watchdog.poll(t0 + Duration::from_millis(196)).is_expired());
    }

    #[test]
    fn every_expired_poll_is_counted() {
        let t0 = Instant::now();
        let mut watchdog = at(t0, PetCounter::new());
        assert_eq!(watchdog.expirations(), 0);
        assert!(watchdog.poll(t0 + Duration::from_millis(101)).is_expired());
        assert!(watchdog.poll(t0 + Duration::from_millis(102)).is_expired());
        assert_eq!(
            watchdog.expirations(),
            2,
            "a supervisor that keeps polling keeps counting"
        );
        assert_eq!(watchdog.deadline(), DEADLINE);
    }

    /// A pet between two expired polls clears the expiry: the token moved, so the loop is
    /// alive again (a watchdog re-arms; it is not a latch).
    #[test]
    fn a_pet_after_an_expiry_reports_alive_again() {
        let t0 = Instant::now();
        let counter = PetCounter::new();
        let mut watchdog = at(t0, counter.clone());
        assert!(watchdog.poll(t0 + Duration::from_millis(150)).is_expired());
        counter.pet();
        assert_eq!(
            watchdog.poll(t0 + Duration::from_millis(151)),
            WatchdogVerdict::Alive { count: 1 }
        );
    }

    #[tokio::test]
    async fn supervise_refuses_a_zero_poll_interval() {
        let t0 = Instant::now();
        let watchdog = at(t0, PetCounter::new());
        let stop = AtomicBool::new(false);
        assert_eq!(
            supervise(watchdog, Duration::ZERO, &stop)
                .await
                .unwrap_err(),
            WatchdogError::ZeroPollInterval
        );
    }

    #[tokio::test]
    async fn supervise_returns_stopped_without_polling_when_the_flag_is_already_set() {
        let t0 = Instant::now();
        let watchdog = at(t0, PetCounter::new());
        let stop = AtomicBool::new(true);
        assert_eq!(
            supervise(watchdog, DEADLINE, &stop)
                .await
                .expect("supervise"),
            WatchdogOutcome::Stopped
        );
    }

    /// The whole point, end to end on a **real** clock (paused): a token that never moves
    /// expires the supervisor, which returns the `Expired` verdict the in-loop monitor could
    /// never produce.
    #[tokio::test(start_paused = true)]
    async fn supervise_expires_a_loop_that_never_pets() {
        let watchdog = Watchdog::new(PetCounter::new(), Duration::from_millis(50), Instant::now())
            .expect("watchdog");
        let stop = AtomicBool::new(false);
        let outcome = supervise(watchdog, Duration::from_millis(10), &stop)
            .await
            .expect("supervise");
        match outcome {
            WatchdogOutcome::Expired { silent_for, count } => {
                assert!(silent_for > Duration::from_millis(50), "{silent_for:?}");
                assert_eq!(count, 0);
            }
            other => panic!("a silent token must expire: {other:?}"),
        }
    }

    /// The contrast: while an independent task keeps petting, the supervisor does **not**
    /// expire. Asserted by racing a timeout that fires first — a supervisor that expired
    /// here would have returned `Expired` before the timeout.
    #[tokio::test(start_paused = true)]
    async fn supervise_stays_alive_while_the_token_advances() {
        let counter = PetCounter::new();
        let petter = {
            let counter = counter.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    counter.pet();
                }
            })
        };
        let watchdog =
            Watchdog::new(counter, Duration::from_millis(50), Instant::now()).expect("watchdog");
        let stop = AtomicBool::new(false);
        let raced = tokio::time::timeout(
            Duration::from_millis(200),
            supervise(watchdog, Duration::from_millis(10), &stop),
        )
        .await;
        petter.abort();
        assert!(
            raced.is_err(),
            "a petting loop must keep the supervisor alive past four deadlines: {raced:?}"
        );
    }
}
