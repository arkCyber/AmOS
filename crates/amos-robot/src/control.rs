//! A control loop that **measures its own cadence** instead of asserting one.
//!
//! [`amos_link::RobotBridge`] is one explicit step: it does not spawn a thread, and
//! `docs/amos-link.md` §6 says so — "the frequency is the caller's (50–100 Hz in a real
//! product)". This module is that caller, and its whole point is the difference between
//! *running* at a period and *claiming* one:
//!
//! | what the loop reports | why it is measured, not assumed |
//! |---|---|
//! | [`CycleStats::late_ratio`] + `worst_lateness` | the interval between tick **starts**. A loop that slept through two periods says so |
//! | [`CycleStats::overruns`] | the work of a tick (`bridge.step()`) took longer than the period: the *next* tick is already late, and no amount of careful sleeping fixes it |
//! | [`CadenceHealth::Unknown`] before the second tick | one tick has no interval, so there is no evidence yet — the same rule as `LinkHealth`'s "no evidence is not healthy" |
//!
//! What this module explicitly does **not** claim (see `docs/robot-autonomy.md`): there is no
//! real-time kernel under it, no priority inheritance, no `mlock`, no WCET analysis. A tokio
//! timer on a general-purpose OS gives you *measured* lateness — which is exactly why the
//! number is published rather than promised. A deployment that needs bounded lateness needs
//! an RT scheduling class and a machine to validate on; this loop will then *report* what
//! that machine actually achieved.
//!
//! Honest boundaries (registered in `docs/robot-autonomy.md`):
//!
//! 1. **Bounded history**: percentiles are computed over the last [`MAX_CYCLE_SAMPLES`] ticks,
//!    and [`CycleStats::window_full`] says whether the window has rolled. A percentile that
//!    quietly means "the last thousand" while reading like "the whole run" is the defect this
//!    flag exists to prevent; `ticks`/`late`/`overruns` are counters over the whole run.
//! 2. **Lateness is not budget**: `late_by` measures when a tick *started*, `overruns`
//!    measures when the work *finished*. A tick can start on time, overrun, and be followed
//!    by a late tick; both facts are reported separately rather than collapsed into one
//!    verdict.
//! 3. **`slack` is a policy, not a discovery**: how late a tick may start and still count as
//!    on-time is the caller's (default: a tenth of the period, so a 10 ms loop tolerates
//!    1 ms). The number is reported alongside the result.
//! 4. **No work stealing, no isolation**: everything the loop runs (`step()`, the publisher
//!    inside it) shares the runtime with the rest of the process — the loop measures the
//!    consequence of that, it does not prevent it.
//!
//! ```no_run
//! use std::time::Duration;
//! use amos_link::discovery::{NodeKind, PeerId};
//! use amos_link::keyexpr::Topic;
//! use amos_link::node::LinkNode;
//! use amos_link::qos::Qos;
//! use amos_link::robot_hal::{AgentAction, MockRobotHal, RobotBridge};
//! use amos_robot::control::ControlLoop;
//!
//! # async fn demo() -> Result<(), Box<dyn std::error::Error>> {
//! let node = LinkNode::in_process(PeerId::new("patrol-01")?, NodeKind::Robot);
//! let subscriber = node
//!     .subscriber::<AgentAction>(Topic::pattern("amos/patrol-01/control/*")?, Qos::control())
//!     .await?;
//! let bridge = RobotBridge::with_watchdog(
//!     subscriber,
//!     MockRobotHal::new(),
//!     Duration::from_millis(250),
//! );
//! // A 20 Hz control task: 50 ms periods, an overrun budget of a tenth of that.
//! let mut control = ControlLoop::new(bridge, Duration::from_millis(50))?;
//! control.run_ticks(4).await?;
//! println!("{}", control.stats().summary());
//! # Ok(())
//! # }
//! ```

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use amos_link::error::LinkError;
use amos_link::robot_hal::{BridgeEvent, RobotBridge, RobotHal};

/// How many recent tick intervals the percentile window keeps.
///
/// 1024 intervals at 100 Hz is ~10 s of history: long enough for a p99 to mean something at a
/// control cadence, small enough that the window is 8 KiB of `Duration` rather than an
/// unbounded `Vec` that grows with uptime (the same bounded-instrument rule the middleware's
/// `SeqTracker` and rate tracker follow).
pub const MAX_CYCLE_SAMPLES: usize = 1_024;

/// What one tick did with respect to its period.
///
/// Both halves are independent facts: a tick can start late and finish quickly, or start on
/// time and overrun. Collapsing them into one enum would lose one of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CycleVerdict {
    /// How late this tick **started** relative to the period (saturating: early is `None`).
    pub late_by: Option<Duration>,
    /// True when the work of this tick took longer than the period (the next tick is already
    /// behind, whatever the timer does).
    pub overrun: bool,
}

impl CycleVerdict {
    /// True when the tick started within the slack window and finished inside its period.
    pub fn is_clean(&self) -> bool {
        self.late_by.is_none() && !self.overrun
    }
}

/// The loop's own verdict on its cadence.
///
/// The vocabulary is the middleware's (`LinkHealth::{Unknown, Healthy, Degraded}`), because an
/// operator reading "slipping" for a link and "slipping" for a control loop should not have to
/// learn two words for the same shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CadenceHealth {
    /// Fewer than two ticks: there is no interval yet, so there is nothing to conclude.
    Unknown,
    /// Every judged tick started inside the slack window and finished inside its period.
    Held,
    /// At least one tick was late or overran. Read the counters for which.
    Slipping,
}

impl CadenceHealth {
    /// Stable key, for logs and for a UI that renders the verdict.
    pub fn key(self) -> &'static str {
        match self {
            CadenceHealth::Unknown => "unknown",
            CadenceHealth::Held => "held",
            CadenceHealth::Slipping => "slipping",
        }
    }
}

/// The instrument: a bounded window of tick intervals plus run-long counters.
///
/// It is deliberately separate from the loop that feeds it, so a test can record a
/// *simulated* bad tick (an interval of 300 ms on a 10 ms loop) and assert the verdict,
/// instead of trying to make the machine it runs on late on purpose.
#[derive(Clone, Debug)]
pub struct CycleStats {
    period: Duration,
    slack: Duration,
    ticks: u64,
    judged: u64,
    on_time: u64,
    late: u64,
    overruns: u64,
    worst_lateness: Duration,
    worst_work: Duration,
    recent: VecDeque<Duration>,
    rolled: bool,
}

impl CycleStats {
    /// A fresh instrument for a loop of `period` with `slack` of tolerated lateness.
    pub fn new(period: Duration, slack: Duration) -> Self {
        Self {
            period,
            slack,
            ticks: 0,
            judged: 0,
            on_time: 0,
            late: 0,
            overruns: 0,
            worst_lateness: Duration::ZERO,
            worst_work: Duration::ZERO,
            recent: VecDeque::with_capacity(MAX_CYCLE_SAMPLES),
            rolled: false,
        }
    }

    /// Record one tick.
    ///
    /// `interval` is the measured time since the previous tick's **start** (`None` for the
    /// first tick, which has no predecessor: it is counted as a tick but never judged — the
    /// alternative, comparing it against the period, would report a lateness no timer could
    /// have avoided).
    pub fn record(&mut self, interval: Option<Duration>, work: Duration) -> CycleVerdict {
        self.ticks = self.ticks.saturating_add(1);
        if work > self.worst_work {
            self.worst_work = work;
        }
        let overrun = work > self.period;

        let late_by = match interval {
            Some(interval) => {
                self.judged = self.judged.saturating_add(1);
                let allowed = self.period.saturating_add(self.slack);
                let late = interval.saturating_sub(allowed);
                if late.is_zero() {
                    self.on_time = self.on_time.saturating_add(1);
                } else {
                    self.late = self.late.saturating_add(1);
                    if late > self.worst_lateness {
                        self.worst_lateness = late;
                    }
                }
                if self.recent.len() == MAX_CYCLE_SAMPLES {
                    self.recent.pop_front();
                    self.rolled = true;
                }
                self.recent.push_back(late);
                (!late.is_zero()).then_some(late)
            }
            None => None,
        };

        if overrun {
            self.overruns = self.overruns.saturating_add(1);
        }
        CycleVerdict { late_by, overrun }
    }

    /// Every tick the loop ran, including the first (which is never judged).
    pub fn ticks(&self) -> u64 {
        self.ticks
    }

    /// Ticks with a predecessor: the denominator of every lateness statement here.
    pub fn judged(&self) -> u64 {
        self.judged
    }

    /// Ticks that started inside `period + slack`.
    pub fn on_time(&self) -> u64 {
        self.on_time
    }

    /// Ticks that started late.
    pub fn late(&self) -> u64 {
        self.late
    }

    /// Ticks whose work exceeded the period.
    pub fn overruns(&self) -> u64 {
        self.overruns
    }

    /// The worst lateness seen (zero when none was).
    pub fn worst_lateness(&self) -> Duration {
        self.worst_lateness
    }

    /// The longest work time seen.
    pub fn worst_work(&self) -> Duration {
        self.worst_work
    }

    /// The period the loop was configured for.
    pub fn period(&self) -> Duration {
        self.period
    }

    /// The tolerated lateness.
    pub fn slack(&self) -> Duration {
        self.slack
    }

    /// Fraction of judged ticks that started late, or `None` when nothing has been judged.
    ///
    /// `None` rather than `0.0`: "no tick has been judged yet" and "every tick was on time"
    /// are different statements, and a dashboard that prints `0.0%` for both teaches its
    /// reader to ignore the number.
    pub fn late_ratio(&self) -> Option<f64> {
        if self.judged == 0 {
            return None;
        }
        Some(self.late as f64 / self.judged as f64)
    }

    /// The `p`-th percentile of the **retained window** (nearest-rank), or `None` when the
    /// window is empty. Read [`CycleStats::window_full`] to know whether that window is the
    /// whole run.
    pub fn recent_lateness_percentile(&self, p: u32) -> Option<Duration> {
        if self.recent.is_empty() {
            return None;
        }
        let mut sorted: Vec<Duration> = self.recent.iter().copied().collect();
        sorted.sort_unstable();
        let p = p.min(100) as usize;
        let len = sorted.len();
        let rank = (p * len).div_ceil(100).max(1).min(len);
        sorted.get(rank - 1).copied()
    }

    /// True when older intervals have been dropped from the percentile window.
    ///
    /// A percentile then means "of the last `MAX_CYCLE_SAMPLES` ticks", not "of the run" — the
    /// counters above stay whole-run, and this flag is what says which number is which.
    pub fn window_full(&self) -> bool {
        self.rolled
    }

    /// The loop's verdict: `Unknown` until a second tick exists.
    pub fn health(&self) -> CadenceHealth {
        if self.judged == 0 {
            return CadenceHealth::Unknown;
        }
        if self.late == 0 && self.overruns == 0 {
            CadenceHealth::Held
        } else {
            CadenceHealth::Slipping
        }
    }

    /// One line an operator can read — with the window each number belongs to.
    pub fn summary(&self) -> String {
        let ratio = match self.late_ratio() {
            Some(ratio) => format!("{:.1}%", ratio * 100.0),
            None => "no evidence yet".to_string(),
        };
        let p99 = self
            .recent_lateness_percentile(99)
            .map(|d| format!("{}us", d.as_micros()))
            .unwrap_or_else(|| "-".to_string());
        format!(
            "cadence={} period={}ms slack={}ms ticks={} late={}/{} ({ratio}) worst_late={}us \
             overruns={} worst_work={}us p99_late={p99} window={}",
            self.health().key(),
            self.period.as_millis(),
            self.slack.as_millis(),
            self.ticks,
            self.late,
            self.judged,
            self.worst_lateness.as_micros(),
            self.overruns,
            self.worst_work.as_micros(),
            if self.window_full() {
                format!("last {MAX_CYCLE_SAMPLES}")
            } else {
                format!("all {}", self.judged)
            }
        )
    }
}

/// Why a loop could not be created or stopped.
#[derive(Debug)]
pub enum LoopError {
    /// The period must be non-zero.
    ///
    /// `tokio::time::interval(ZERO)` panics *inside the spawned task*, which is the worst
    /// shape of failure: the caller holds a handle that looks alive. The middleware refuses
    /// the same value in `spawn_heartbeat`/`spawn_federation`, for the same reason.
    ZeroPeriod,
    /// The bridge failed. The link is gone or the bus refused; the cadence counters stay
    /// readable because the [`ControlLoop`] is still in the caller's hands.
    Link(LinkError),
}

impl std::fmt::Display for LoopError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoopError::ZeroPeriod => write!(
                f,
                "a control loop needs a non-zero period (a zero-period timer panics in the \
                 task it is spawned in)"
            ),
            LoopError::Link(e) => write!(f, "the control link failed: {e}"),
        }
    }
}

impl std::error::Error for LoopError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LoopError::ZeroPeriod => None,
            LoopError::Link(e) => Some(e),
        }
    }
}

impl From<LinkError> for LoopError {
    fn from(error: LinkError) -> Self {
        LoopError::Link(error)
    }
}

/// A control loop around one [`RobotBridge`]: paced ticks, measured lateness.
///
/// It does **not** spawn anything: the caller awaits it (or drops the future), which is the
/// same discipline the middleware keeps ("`LinkNode` does not start a control thread for
/// you"), and it is what makes `run_ticks(4)` a usable startup self-check.
pub struct ControlLoop<H: RobotHal> {
    bridge: RobotBridge<H>,
    stats: CycleStats,
    last_tick: Option<tokio::time::Instant>,
}

impl<H: RobotHal> ControlLoop<H> {
    /// A loop at `period`, tolerating a tenth of that as jitter before a tick counts as late.
    pub fn new(bridge: RobotBridge<H>, period: Duration) -> Result<Self, LoopError> {
        Self::with_slack(bridge, period, period / 10)
    }

    /// A loop with an explicit jitter tolerance.
    ///
    /// `slack` is a policy, not a measurement: a 100 Hz loop on a busy general-purpose OS may
    /// reasonably tolerate 1–2 ms of scheduling jitter, and a deployment that must know
    /// exactly how much it tolerated reads it back from [`CycleStats::slack`].
    pub fn with_slack(
        bridge: RobotBridge<H>,
        period: Duration,
        slack: Duration,
    ) -> Result<Self, LoopError> {
        if period.is_zero() {
            return Err(LoopError::ZeroPeriod);
        }
        Ok(Self {
            bridge,
            stats: CycleStats::new(period, slack),
            last_tick: None,
        })
    }

    /// The cadence instrument (whole-run counters + a bounded percentile window).
    pub fn stats(&self) -> &CycleStats {
        &self.stats
    }

    /// The bridge this loop drives.
    pub fn bridge(&self) -> &RobotBridge<H> {
        &self.bridge
    }

    /// One tick: measure, `step()`, measure, record.
    ///
    /// The cadence fact is recorded **even when the step failed** — "the link broke at tick
    /// 412, 3 ms late" is two independent facts and the caller needs both. No pacing here:
    /// this is the shape for a caller that owns its own timer.
    pub async fn tick(&mut self) -> Result<BridgeEvent, LoopError> {
        let started = tokio::time::Instant::now();
        let interval = self
            .last_tick
            .map(|last| started.saturating_duration_since(last));
        self.last_tick = Some(started);

        let outcome = self.bridge.step().await;
        let work = started.elapsed();
        self.stats.record(interval, work);

        outcome.map_err(LoopError::Link)
    }

    /// Run exactly `ticks` **paced** ticks and return.
    ///
    /// Bounded on purpose: an unbounded loop is not a thing a test, a self-check or an
    /// operator can hold. The first tick happens immediately (that is how
    /// `tokio::time::interval` behaves, and it is what a control loop wants: do not wait a
    /// whole period before the first step).
    ///
    /// Each paced run re-captures its predecessor (see [`ControlLoop::run_until`]): the loop
    /// was not running between two calls, so the gap the caller spent elsewhere is not loop
    /// lateness.
    pub async fn run_ticks(&mut self, ticks: u64) -> Result<(), LoopError> {
        self.restart_pacing();
        let mut ticker = self.ticker();
        for _ in 0..ticks {
            ticker.tick().await;
            self.tick().await?;
        }
        Ok(())
    }

    /// Run paced ticks until `stop` is set.
    ///
    /// **Termination**: the flag is checked before every tick, so an already-set flag means
    /// zero ticks — a stop that still drives once is not a stop. Missed ticks are not
    /// replayed (`MissedTickBehavior::Delay`, the same choice the middleware's heartbeat and
    /// beacon tasks make), so a stalled loop resumes on schedule and *reports* the interval it
    /// actually had instead of bursting to catch up.
    ///
    /// **A paced run is a run, not a continuation.** `last_tick` is dropped when a run starts,
    /// so the first tick of a run has no predecessor and is never judged — the same rule the
    /// loop's very first tick follows. Measured defect: without this, the caller doing
    /// something else for ten periods and then resuming made the instrument report the idle
    /// gap as *the loop* being late (a 50 ms `sleep` between two `run_ticks` calls read as a
    /// 45 ms late tick), blaming the loop for time it was not running. A caller that owns its
    /// own timer calls [`ControlLoop::tick`] directly, where every interval *is* an interval.
    pub async fn run_until(&mut self, stop: &AtomicBool) -> Result<(), LoopError> {
        self.restart_pacing();
        let mut ticker = self.ticker();
        while !stop.load(Ordering::Relaxed) {
            ticker.tick().await;
            self.tick().await?;
        }
        Ok(())
    }

    /// Start a paced run with no predecessor tick (see [`ControlLoop::run_until`]).
    fn restart_pacing(&mut self) {
        self.last_tick = None;
    }

    /// The paced ticker, configured once (`Delay` is chosen here and nowhere else).
    fn ticker(&self) -> tokio::time::Interval {
        let mut ticker = tokio::time::interval(self.stats.period());
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_link::discovery::{NodeKind, PeerId};
    use amos_link::keyexpr::{Channel, Topic};
    use amos_link::node::LinkNode;
    use amos_link::pubsub::Publisher;
    use amos_link::qos::Qos;
    use amos_link::robot_hal::{AgentAction, MockRobotHal};
    use std::sync::Arc;

    const PERIOD: Duration = Duration::from_millis(5);
    const SLACK: Duration = Duration::from_micros(500);

    fn stats() -> CycleStats {
        CycleStats::new(PERIOD, SLACK)
    }

    #[test]
    fn the_first_tick_is_counted_but_never_judged() {
        let mut stats = stats();
        assert_eq!(stats.health(), CadenceHealth::Unknown);
        let first = stats.record(None, Duration::from_micros(100));
        assert_eq!(
            first,
            CycleVerdict {
                late_by: None,
                overrun: false
            }
        );
        assert_eq!(stats.ticks(), 1);
        assert_eq!(stats.judged(), 0, "one tick has no interval to judge");
        assert_eq!(stats.health(), CadenceHealth::Unknown);
        assert_eq!(stats.late_ratio(), None, "no evidence is not 0%");
    }

    #[test]
    fn an_on_time_stream_is_held() {
        let mut stats = stats();
        stats.record(None, Duration::from_micros(100));
        for _ in 0..9 {
            // Exactly the period: on time, with no lateness to report.
            let verdict = stats.record(Some(PERIOD), Duration::from_micros(200));
            assert!(verdict.is_clean());
        }
        // …and the slack is a window, not a hair trigger.
        assert!(stats
            .record(Some(PERIOD + SLACK), Duration::from_micros(200))
            .is_clean());
        assert_eq!(stats.judged(), 10);
        assert_eq!(stats.on_time(), 10);
        assert_eq!(stats.late(), 0);
        assert_eq!(stats.late_ratio(), Some(0.0));
        assert_eq!(stats.health(), CadenceHealth::Held);
        assert_eq!(stats.worst_lateness(), Duration::ZERO);
    }

    #[test]
    fn a_late_tick_is_measured_named_and_dated() {
        let mut stats = stats();
        stats.record(None, Duration::from_micros(100));
        // 4 ms late relative to the slack window (period + slack + 4 ms).
        let verdict = stats.record(
            Some(PERIOD + SLACK + Duration::from_millis(4)),
            Duration::from_micros(200),
        );
        assert_eq!(verdict.late_by, Some(Duration::from_millis(4)));
        assert!(
            !verdict.overrun,
            "starting late and running long are different facts"
        );
        assert_eq!(stats.late(), 1);
        assert_eq!(stats.judged(), 1);
        assert_eq!(stats.late_ratio(), Some(1.0));
        assert_eq!(stats.worst_lateness(), Duration::from_millis(4));
        assert_eq!(stats.health(), CadenceHealth::Slipping);
        assert!(stats.summary().contains("late=1/1"), "{}", stats.summary());
    }

    #[test]
    fn an_overrun_is_a_separate_fact_from_lateness() {
        let mut stats = stats();
        stats.record(None, Duration::from_micros(100));
        // On time, but the work took longer than the period: the *next* tick is already
        // behind whatever the timer does.
        let verdict = stats.record(Some(PERIOD), PERIOD + Duration::from_millis(1));
        assert_eq!(verdict.late_by, None);
        assert!(verdict.overrun);
        assert_eq!(stats.late(), 0);
        assert_eq!(stats.overruns(), 1);
        assert_eq!(stats.worst_work(), PERIOD + Duration::from_millis(1));
        assert_eq!(
            stats.health(),
            CadenceHealth::Slipping,
            "an overrun is not hidden by an on-time start"
        );
    }

    #[test]
    fn the_percentile_window_is_bounded_and_says_so() {
        let mut stats = stats();
        stats.record(None, Duration::ZERO);
        // A window that has rolled: the counters stay whole-run, the percentiles do not.
        for i in 0..(MAX_CYCLE_SAMPLES as u64 + 500) {
            let late = if i < 500 {
                Duration::from_millis(1)
            } else {
                Duration::ZERO
            };
            stats.record(Some(PERIOD + SLACK + late), Duration::from_micros(10));
        }
        assert_eq!(stats.judged() as usize, MAX_CYCLE_SAMPLES + 500);
        assert_eq!(stats.late(), 500, "the counters are the whole run");
        assert!(stats.window_full());
        // Every retained sample is recent (zero lateness), so the window's p99 is zero even
        // though the run has late ticks — which is exactly why the flag exists.
        assert_eq!(stats.recent_lateness_percentile(99), Some(Duration::ZERO));
        assert!(
            stats.summary().contains("window=last 1024"),
            "{}",
            stats.summary()
        );
    }

    #[test]
    fn percentiles_are_nearest_rank_over_the_retained_window() {
        let mut stats = stats();
        stats.record(None, Duration::ZERO);
        for value in 0..100u64 {
            stats.record(
                Some(PERIOD + SLACK + Duration::from_millis(value)),
                Duration::ZERO,
            );
        }
        assert_eq!(
            stats.recent_lateness_percentile(50),
            Some(Duration::from_millis(49))
        );
        assert_eq!(
            stats.recent_lateness_percentile(99),
            Some(Duration::from_millis(98))
        );
        assert_eq!(
            stats.recent_lateness_percentile(100),
            Some(Duration::from_millis(99))
        );
        assert_eq!(stats.recent_lateness_percentile(0), Some(Duration::ZERO));
        assert!(!stats.window_full());
        assert!(
            stats.summary().contains("window=all 100"),
            "{}",
            stats.summary()
        );
    }

    /// The cadence facts must not be able to hide behind an empty window.
    #[test]
    fn an_empty_window_has_no_percentile_and_no_verdict() {
        let stats = stats();
        assert_eq!(stats.recent_lateness_percentile(50), None);
        assert_eq!(stats.late_ratio(), None);
        assert_eq!(stats.health(), CadenceHealth::Unknown);
        assert!(
            stats.summary().contains("no evidence yet"),
            "{}",
            stats.summary()
        );
        assert!(
            stats.summary().contains("window=all 0"),
            "{}",
            stats.summary()
        );
    }

    #[tokio::test]
    async fn a_zero_period_is_refused_before_any_timer_exists() {
        let (bridge, _pub, _node) = fixture().await;
        match ControlLoop::new(bridge, Duration::ZERO) {
            Err(LoopError::ZeroPeriod) => {}
            Err(other) => panic!("expected ZeroPeriod, got {other}"),
            Ok(_) => panic!("a zero period must be refused, not turned into a timer"),
        }
    }

    #[tokio::test]
    async fn a_bounded_run_ticks_the_bridge_and_the_commander_is_heard() {
        let (bridge, publisher, _node) = fixture().await;
        // Four actions queued before the loop starts: the reliable control channel holds them
        // (that is what `Qos::control()` is for), so each tick consumes one.
        for _ in 0..4 {
            publisher
                .publish(&AgentAction::new(r#"{"action":"sit","speed":0.4}"#))
                .await
                .expect("publish");
        }

        let mut control = ControlLoop::new(bridge, PERIOD).expect("a loop");
        control.run_ticks(4).await.expect("four ticks");

        let stats = control.stats();
        assert_eq!(stats.ticks(), 4);
        assert_eq!(stats.judged(), 3, "the first tick has no interval");
        assert!(control.bridge().hal().applied() >= 13, "the bus was driven");
        assert!(control.bridge().hal().armed());
        // The loop's own verdict must be self-consistent: `Slipping` implies a counter that
        // says why. (Asserting `Held` here would make the test a measure of the CI machine.)
        match stats.health() {
            CadenceHealth::Held => assert_eq!(stats.on_time(), stats.judged()),
            CadenceHealth::Slipping => assert!(stats.late() > 0 || stats.overruns() > 0),
            CadenceHealth::Unknown => panic!("four ticks are judged evidence"),
        }
        assert!(stats.summary().contains("ticks=4"), "{}", stats.summary());
    }

    #[tokio::test]
    async fn the_loop_stops_on_the_flag_and_does_no_work_when_it_is_already_set() {
        let (bridge, publisher, _node) = fixture().await;
        let mut control = ControlLoop::new(bridge, PERIOD).expect("a loop");

        // Already stopped: zero ticks. A stop that still drives once is not a stop.
        let stopped = AtomicBool::new(true);
        control.run_until(&stopped).await.expect("returns at once");
        assert_eq!(control.stats().ticks(), 0);

        // Running, then stopped by another task: it performs work and returns.
        publisher
            .publish(&AgentAction::new(r#"{"action":"sit","speed":0.4}"#))
            .await
            .expect("publish");
        let running = Arc::new(AtomicBool::new(false));
        let flipper = {
            let flag = Arc::clone(&running);
            tokio::spawn(async move {
                tokio::time::sleep(PERIOD * 3).await;
                flag.store(true, Ordering::Relaxed);
            })
        };
        control
            .run_until(&running)
            .await
            .expect("runs until stopped");
        flipper.await.expect("the flipper task");
        assert!(control.stats().ticks() >= 1, "it did work before stopping");
        assert!(control.bridge().hal().applied() >= 13);
    }

    #[tokio::test]
    async fn a_restarted_paced_run_does_not_charge_the_loop_for_the_idle_gap() {
        let (bridge, publisher, _node) = fixture().await;
        // One action per step, so no tick waits out the watchdog.
        for _ in 0..6 {
            publisher
                .publish(&AgentAction::new(r#"{"action":"sit","speed":0.4}"#))
                .await
                .expect("publish");
        }
        let mut control = ControlLoop::new(bridge, PERIOD).expect("a loop");

        control.run_ticks(3).await.expect("the first run");
        assert_eq!(control.stats().ticks(), 3);
        assert_eq!(
            control.stats().judged(),
            2,
            "the first tick of a run has no predecessor"
        );

        // The caller does something else for ten periods, then resumes the loop. That gap is
        // not loop lateness: the loop was not running, and `run_ticks` re-captures on entry.
        tokio::time::sleep(PERIOD * 10).await;
        control.run_ticks(3).await.expect("the second run");
        assert_eq!(control.stats().ticks(), 6);
        assert_eq!(
            control.stats().judged(),
            4,
            "a restart is a new run: without the re-capture this was 5, with the idle gap \
             recorded as the loop being {} ms late",
            (PERIOD * 10).as_millis()
        );
    }

    /// A robot and a commander on one in-process node (the same shape the middleware's own
    /// bridge test uses: the broker delivers to subscribers inside the node).
    async fn fixture() -> (
        RobotBridge<MockRobotHal>,
        Publisher<AgentAction>,
        Arc<LinkNode>,
    ) {
        let node = LinkNode::in_process(PeerId::new("patrol-01").expect("peer"), NodeKind::Robot);
        let subscriber = node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/patrol-01/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        let publisher = node.publisher::<AgentAction>(
            Topic::channel_topic("patrol-01", Channel::Control, "action").expect("topic"),
        );
        // A 250 ms deadman: far longer than this test's few periods, so the watchdog is an
        // arm-through-not-fire part of the fixture rather than a source of flakiness.
        let bridge =
            RobotBridge::with_watchdog(subscriber, MockRobotHal::new(), Duration::from_millis(250));
        (bridge, publisher, node)
    }
}
