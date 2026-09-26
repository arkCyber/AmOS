//! Circuit breaker for the inference backend (CODE_AUDIT_REPORT §"健康检查和监控"
//! → `[ ] 实现断路器模式`, the one item of that list that was still absent).
//!
//! Why: every backend call already has a **timeout** (60s API / 10s Ollama / 5s
//! health). A timeout stops one call from hanging forever, but it does nothing about
//! *volume*: while a backend is down, every request still walks the full timeout and
//! every caller waits it out — and, with the generation pool in front, the slots that
//! would serve real work are held by doomed calls. A breaker turns "N slow failures"
//! into "fail fast, with a stated reason", and probes the backend again on its own
//! schedule instead of only when a user asks.
//!
//! Honesty rules (same discipline as `cache.rs` / `pool.rs`):
//!  - the decorator is **visible**: `metadata().name` gains `+breaker`, so the
//!    reported engine name shows the breaker is in the serving path (no silent
//!    behavior change).
//!  - a rejection is a **stated reason**, never a bare error: the message carries the
//!    remaining cooldown, so a caller can tell "the backend is being skipped on
//!    purpose" from "the backend failed".
//!  - it **fails fast, it does not retry**: no hidden re-send loop, no duplicate
//!    generation. Recovery is one probe at a time.
//!  - **no fabricated metrics**: `snapshot()` reports what was actually counted
//!    (including "0 openings" for a healthy backend).
//!  - `health_check()` is a *probe*, not a generation: it is passed through and does
//!    **not** open the breaker (the pool/liveness path already owns liveness).
//!  - known boundary: any `infer` failure counts — the breaker does not classify
//!    errors, so a burst of client errors (e.g. HTTP 400) can open it too. The
//!    thresholds are env-tunable and `AMOS_BREAKER=0` disables it outright.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use async_trait::async_trait;

use crate::inference::real::{BackendMetadata, BackendStats, InferenceBackend, TokenStream};

/// Where the breaker is right now. Mirrors the classic three-state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakerState {
    /// Serving normally; failures are counted.
    Closed,
    /// Skipping the backend until the cooldown elapses.
    Open,
    /// Cooldown elapsed: exactly one probe may run.
    HalfOpen,
}

impl BreakerState {
    /// The wire label (`get_status`), stable for clients.
    pub fn label(self) -> &'static str {
        match self {
            BreakerState::Closed => "closed",
            BreakerState::Open => "open",
            BreakerState::HalfOpen => "half_open",
        }
    }
}

/// Why a call was rejected (the second half of "a stated reason").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// The backend is known-bad and still cooling down.
    Open,
    /// The cooldown elapsed and another probe is already in flight.
    ProbeInFlight,
}

impl RejectReason {
    pub fn label(self) -> &'static str {
        match self {
            RejectReason::Open => "open",
            RejectReason::ProbeInFlight => "probe_in_flight",
        }
    }
}

/// What the breaker decided for one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Call the backend.
    Allow,
    /// Do **not** call the backend; report this reason (and, when known, how long).
    Reject {
        reason: RejectReason,
        retry_after: Option<Duration>,
    },
}

/// Tunables. `enabled=false` is the identity (always `Allow`, never opens).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BreakerConfig {
    pub enabled: bool,
    /// Consecutive failures that open the breaker.
    pub fail_threshold: u32,
    /// How long the breaker stays open before allowing a probe.
    pub cooldown: Duration,
}

impl Default for BreakerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            fail_threshold: 3,
            cooldown: Duration::from_secs(30),
        }
    }
}

const ENABLED_ENV: &str = "AMOS_BREAKER";
const FAILS_ENV: &str = "AMOS_BREAKER_FAILS";
const COOLDOWN_ENV: &str = "AMOS_BREAKER_COOLDOWN_SECS";

/// Read a numeric knob. Absence is the only silent state; a value that is present
/// but not valid Unicode is reported once and takes the documented default. An
/// unparseable or sub-minimum value also takes that default (documented in
/// [`BreakerConfig::from_env`]) — safe, because the default is never a nonsense
/// threshold.
fn numeric_env(key: &str) -> Option<String> {
    let raw = std::env::var_os(key)?;
    match raw.to_str() {
        Some(s) => Some(s.to_owned()),
        None => {
            tracing::warn!(
                key,
                "amos-ai breaker: value is not valid Unicode — using the documented default"
            );
            None
        }
    }
}

impl BreakerConfig {
    /// `AMOS_BREAKER` (`0`/`false`/`off`/`no` disables; `1`/`true`/`yes`/`on` enables),
    /// `AMOS_BREAKER_FAILS` (>=1), `AMOS_BREAKER_COOLDOWN_SECS` (>=1). Unparseable or
    /// zero values fall back to the documented default rather than to a nonsense
    /// threshold.
    ///
    /// A value that is present but outside both known sets — a typo, a blank, or a
    /// non-Unicode byte string — is **not** silently folded into "unset": it is
    /// reported once at WARN and the safe default (enabled) applies. The previous
    /// reader took *any* `Ok` value that was not one of the four disable tokens as
    /// "enabled", so `AMOS_BREAKER=flase` left the breaker armed without a word.
    pub fn from_env() -> Self {
        let d = Self::default();
        let enabled = crate::energy::env_flag(ENABLED_ENV).unwrap_or(d.enabled);
        let fail_threshold = numeric_env(FAILS_ENV)
            .and_then(|v| v.trim().parse::<u32>().ok())
            .filter(|n| *n >= 1)
            .unwrap_or(d.fail_threshold);
        let cooldown = numeric_env(COOLDOWN_ENV)
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|n| *n >= 1)
            .map(Duration::from_secs)
            .unwrap_or(d.cooldown);
        Self {
            enabled,
            fail_threshold,
            cooldown,
        }
    }
}

/// A read-only view of the breaker for reporting (`get_status`). Every number is a
/// counter that actually happened; nothing here is derived or estimated.
#[derive(Debug, Clone)]
pub struct BreakerSnapshot {
    pub enabled: bool,
    pub state: BreakerState,
    pub fail_threshold: u32,
    pub cooldown: Duration,
    /// Consecutive failures while `Closed` (reset by a success).
    pub consecutive_failures: u32,
    /// Times the breaker entered `Open` (monotonic).
    pub openings: u64,
    /// Times a call was skipped without touching the backend (monotonic).
    pub rejections: u64,
    /// Backend failures observed (monotonic).
    pub failures: u64,
    /// Completed generations observed (monotonic).
    pub successes: u64,
}

/// The breaker itself: a pure state machine driven by explicit `now` values.
///
/// Pure (no clock, no I/O) so the whole open/half-open/close policy is unit-testable
/// offline — the same choice `pool.rs` makes for admission.
#[derive(Debug)]
pub struct CircuitBreaker {
    cfg: BreakerConfig,
    state: BreakerState,
    consecutive_failures: u32,
    /// When `Open`: the instant the cooldown ends. `None` in `Closed`.
    open_until: Option<Instant>,
    /// When `HalfOpen`: whether the single allowed probe is currently running.
    probe_in_flight: bool,
    openings: u64,
    rejections: u64,
    failures: u64,
    successes: u64,
}

impl CircuitBreaker {
    pub fn new(cfg: BreakerConfig) -> Self {
        Self {
            cfg,
            state: BreakerState::Closed,
            consecutive_failures: 0,
            open_until: None,
            probe_in_flight: false,
            openings: 0,
            rejections: 0,
            failures: 0,
            successes: 0,
        }
    }

    pub fn config(&self) -> BreakerConfig {
        self.cfg
    }

    pub fn state(&self) -> BreakerState {
        self.state
    }

    /// Decide whether one call may proceed. Transitions `Open → HalfOpen` when the
    /// cooldown has elapsed, and reserves the single probe slot when it does.
    ///
    /// There is deliberately **no** `enabled` check here: a disabled breaker can never
    /// leave `Closed` (see [`Self::on_failure`], the one place the disable is
    /// enforced), so this is the same answer with one less untestable branch.
    pub fn decide(&mut self, now: Instant) -> Verdict {
        match self.state {
            BreakerState::Closed => Verdict::Allow,
            BreakerState::Open => {
                let until = self.open_until.unwrap_or(now);
                if now >= until {
                    // Cooldown over: allow exactly one probe.
                    self.state = BreakerState::HalfOpen;
                    self.probe_in_flight = true;
                    Verdict::Allow
                } else {
                    self.rejections += 1;
                    Verdict::Reject {
                        reason: RejectReason::Open,
                        retry_after: Some(until.duration_since(now)),
                    }
                }
            }
            BreakerState::HalfOpen => {
                if self.probe_in_flight {
                    self.rejections += 1;
                    Verdict::Reject {
                        reason: RejectReason::ProbeInFlight,
                        // No promise about when the probe finishes — say "unknown".
                        retry_after: None,
                    }
                } else {
                    self.probe_in_flight = true;
                    Verdict::Allow
                }
            }
        }
    }

    /// A generation that completed. In `HalfOpen` this closes the breaker (the probe
    /// succeeded); in `Closed` it clears the consecutive-failure count.
    pub fn on_success(&mut self, _now: Instant) {
        self.successes += 1;
        self.consecutive_failures = 0;
        if self.state == BreakerState::HalfOpen {
            self.state = BreakerState::Closed;
            self.open_until = None;
            self.probe_in_flight = false;
        }
    }

    /// A generation that failed (or whose stream errored). Failure is what opens the
    /// breaker — and what re-opens it when the probe itself fails.
    ///
    /// This is also the **only** place `enabled=false` is enforced: a disabled breaker
    /// observes failures (the counters stay true) but never transitions, so `decide`
    /// needs no guard of its own.
    pub fn on_failure(&mut self, now: Instant) {
        self.failures += 1;
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if !self.cfg.enabled {
            return;
        }
        let was_probe = self.state == BreakerState::HalfOpen;
        if was_probe || self.consecutive_failures >= self.cfg.fail_threshold {
            // (Re)open and restart the cooldown from *now*: a failed probe earns a
            // full cooldown, not the tail of the previous one.
            self.state = BreakerState::Open;
            self.open_until = Some(now + self.cfg.cooldown);
            self.probe_in_flight = false;
            self.openings += 1;
        }
    }

    /// Remaining cooldown, when open. `None` = not waiting (closed/half-open).
    pub fn retry_after(&self, now: Instant) -> Option<Duration> {
        match (self.state, self.open_until) {
            (BreakerState::Open, Some(until)) if until > now => Some(until.duration_since(now)),
            _ => None,
        }
    }

    /// The honest snapshot for reporting.
    pub fn snapshot(&self) -> BreakerSnapshot {
        BreakerSnapshot {
            enabled: self.cfg.enabled,
            state: self.state,
            fail_threshold: self.cfg.fail_threshold,
            cooldown: self.cfg.cooldown,
            consecutive_failures: self.consecutive_failures,
            openings: self.openings,
            rejections: self.rejections,
            failures: self.failures,
            successes: self.successes,
        }
    }
}

/// Shared, poison-tolerant handle (the repo's `Mutex` convention).
pub type SharedBreaker = Arc<Mutex<CircuitBreaker>>;

/// Build the shared handle wrapping a fresh breaker.
pub fn shared(cfg: BreakerConfig) -> SharedBreaker {
    Arc::new(Mutex::new(CircuitBreaker::new(cfg)))
}

/// Lock the shared breaker, tolerating a poisoned mutex (never able to fail the
/// request path — a poison flag means some other task panicked while holding it).
pub fn lock(breaker: &SharedBreaker) -> std::sync::MutexGuard<'_, CircuitBreaker> {
    breaker.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
impl CircuitBreaker {
    /// Force the breaker into a specific state. **Tests only**: production
    /// code must go through `decide` / `on_success` / `on_failure` so the
    /// cooldown/probe invariants are preserved. Tests that need to verify
    /// the alerting/bridge machinery on the recovery side without paying
    /// the wall-clock cost of a real cooldown use this hook.
    pub fn force_state_for_test(&mut self, state: BreakerState) {
        self.state = state;
    }
}

/// Transparent breaker decorator around any [`InferenceBackend`].
///
/// Composition guidance (also what `server.rs` wires): put this **inside** the
/// response cache — `Cache(Breaker(inner))` — so a cache hit is still served while
/// the backend is open, and only real (uncached) generations are gated.
///
/// `metadata()` adds an honest `+breaker` suffix; `get_stats()` stays a faithful
/// pass-through (the decorator fabricates no telemetry).
pub struct BreakerBackend {
    inner: Arc<dyn InferenceBackend>,
    breaker: SharedBreaker,
}

impl BreakerBackend {
    pub fn new(inner: Arc<dyn InferenceBackend>, breaker: SharedBreaker) -> Self {
        Self { inner, breaker }
    }

    /// Shared handle (for `get_status` / tests).
    pub fn breaker(&self) -> SharedBreaker {
        self.breaker.clone()
    }

    /// The honest rejection error: it names the reason and the remaining cooldown so
    /// an operator can distinguish "skipped on purpose" from "backend failed".
    fn reject_error(reason: RejectReason, retry_after: Option<Duration>) -> anyhow::Error {
        match retry_after {
            Some(d) => anyhow!(
                "inference backend skipped: circuit breaker {} (retry in {}s)",
                reason.label(),
                d.as_secs_f64().ceil() as u64
            ),
            None => anyhow!(
                "inference backend skipped: circuit breaker {}",
                reason.label()
            ),
        }
    }
}

#[async_trait]
impl InferenceBackend for BreakerBackend {
    async fn infer(
        &self,
        prompt: &str,
        context: &HashMap<String, String>,
        max_tokens: usize,
    ) -> Result<Box<dyn TokenStream>> {
        match lock(&self.breaker).decide(Instant::now()) {
            Verdict::Reject {
                reason,
                retry_after,
            } => {
                tracing::warn!(
                    reason = reason.label(),
                    retry_after_secs = retry_after.map(|d| d.as_secs_f64()),
                    "circuit breaker rejected a generation"
                );
                return Err(Self::reject_error(reason, retry_after));
            }
            Verdict::Allow => {}
        }
        match self.inner.infer(prompt, context, max_tokens).await {
            Ok(stream) => Ok(Box::new(BreakerStream {
                inner: stream,
                breaker: self.breaker.clone(),
            })),
            Err(e) => {
                // Failing to even start the generation is a backend failure.
                lock(&self.breaker).on_failure(Instant::now());
                Err(e)
            }
        }
    }

    fn metadata(&self) -> BackendMetadata {
        let mut m = self.inner.metadata();
        if !m.name.ends_with("+breaker") {
            m.name.push_str("+breaker");
        }
        m
    }

    /// Passed through **and deliberately not counted**: a probe reporting "not ready"
    /// is liveness information, not a generation outcome (documented boundary).
    async fn health_check(&self) -> Result<()> {
        self.inner.health_check().await
    }

    async fn get_stats(&self) -> BackendStats {
        self.inner.get_stats().await
    }
}

/// Wraps an in-flight generation so the *stream's* outcome reaches the breaker:
/// completing the stream is one success, an error mid-stream is one failure. This is
/// what lets a half-open probe actually close (or re-open) the breaker.
struct BreakerStream {
    inner: Box<dyn TokenStream>,
    breaker: SharedBreaker,
}

#[async_trait]
impl TokenStream for BreakerStream {
    async fn next(&mut self) -> Option<Result<String>> {
        match self.inner.next().await {
            Some(Ok(t)) => Some(Ok(t)),
            Some(Err(e)) => {
                lock(&self.breaker).on_failure(Instant::now());
                Some(Err(e))
            }
            None => {
                lock(&self.breaker).on_success(Instant::now());
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::real::{BackendStats, TokenStream};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn cfg(fails: u32, cooldown_secs: u64) -> BreakerConfig {
        BreakerConfig {
            enabled: true,
            fail_threshold: fails,
            cooldown: Duration::from_secs(cooldown_secs),
        }
    }

    /// A backend that fails on demand and counts how often it was actually called.
    struct CountingBackend {
        calls: Arc<AtomicUsize>,
        fail_start: bool,
        fail_stream: bool,
    }

    #[async_trait]
    impl InferenceBackend for CountingBackend {
        async fn infer(
            &self,
            _prompt: &str,
            _context: &HashMap<String, String>,
            _max_tokens: usize,
        ) -> Result<Box<dyn TokenStream>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_start {
                return Err(anyhow!("backend refused to start"));
            }
            Ok(Box::new(ScriptedStream {
                steps: if self.fail_stream {
                    vec![Err(anyhow!("stream broke"))]
                } else {
                    vec![Ok("hi".to_string())]
                }
                .into_iter(),
            }))
        }

        fn metadata(&self) -> BackendMetadata {
            BackendMetadata {
                name: "counting".into(),
                version: "0".into(),
                model_name: "m".into(),
                max_context_length: 8,
                supports_streaming: true,
                supports_function_calling: false,
                supports_images: false,
            }
        }

        async fn health_check(&self) -> Result<()> {
            Ok(())
        }

        async fn get_stats(&self) -> BackendStats {
            BackendStats::default()
        }
    }

    struct ScriptedStream {
        steps: std::vec::IntoIter<Result<String>>,
    }

    #[async_trait]
    impl TokenStream for ScriptedStream {
        async fn next(&mut self) -> Option<Result<String>> {
            self.steps.next()
        }
    }

    fn rig(
        cfg: BreakerConfig,
        fail_start: bool,
        fail_stream: bool,
    ) -> (Arc<BreakerBackend>, Arc<AtomicUsize>, SharedBreaker) {
        let calls = Arc::new(AtomicUsize::new(0));
        let inner = Arc::new(CountingBackend {
            calls: calls.clone(),
            fail_start,
            fail_stream,
        });
        let br = shared(cfg);
        let backend = Arc::new(BreakerBackend::new(inner, br.clone()));
        (backend, calls, br)
    }

    // ---- pure state machine -------------------------------------------------

    #[test]
    fn opens_only_after_the_threshold_of_consecutive_failures() {
        let mut b = CircuitBreaker::new(cfg(3, 30));
        let t = Instant::now();
        assert_eq!(b.decide(t), Verdict::Allow);
        b.on_failure(t);
        assert_eq!(b.state(), BreakerState::Closed, "1 failure < threshold");
        b.on_failure(t);
        assert_eq!(b.state(), BreakerState::Closed, "2 failures < threshold");
        b.on_failure(t);
        assert_eq!(b.state(), BreakerState::Open);
        assert_eq!(b.snapshot().openings, 1);
        // The next call is rejected, with a *stated* remaining cooldown.
        match b.decide(t + Duration::from_secs(1)) {
            Verdict::Reject {
                reason,
                retry_after,
            } => {
                assert_eq!(reason, RejectReason::Open);
                assert_eq!(retry_after, Some(Duration::from_secs(29)));
            }
            v => panic!("expected a rejection, got {v:?}"),
        }
        assert_eq!(b.snapshot().rejections, 1);
    }

    #[test]
    fn a_success_resets_the_consecutive_failure_count() {
        let mut b = CircuitBreaker::new(cfg(3, 30));
        let t = Instant::now();
        b.on_failure(t);
        b.on_failure(t);
        b.on_success(t);
        b.on_failure(t);
        b.on_failure(t);
        assert_eq!(b.state(), BreakerState::Closed, "counter restarted at 0");
        assert_eq!(b.snapshot().consecutive_failures, 2);
    }

    #[test]
    fn after_the_cooldown_exactly_one_probe_is_allowed() {
        let mut b = CircuitBreaker::new(cfg(1, 30));
        let t = Instant::now();
        b.on_failure(t);
        assert_eq!(b.state(), BreakerState::Open);
        assert!(matches!(b.decide(t), Verdict::Reject { .. }));
        // Cooldown elapsed ⇒ the first caller becomes the probe…
        assert_eq!(b.decide(t + Duration::from_secs(30)), Verdict::Allow);
        assert_eq!(b.state(), BreakerState::HalfOpen);
        // …and a second one is told to wait, without any invented duration.
        match b.decide(t + Duration::from_secs(30)) {
            Verdict::Reject {
                reason,
                retry_after,
            } => {
                assert_eq!(reason, RejectReason::ProbeInFlight);
                assert_eq!(retry_after, None, "no promise about the probe's duration");
            }
            v => panic!("expected a rejection, got {v:?}"),
        }
    }

    #[test]
    fn a_successful_probe_closes_the_breaker() {
        let mut b = CircuitBreaker::new(cfg(1, 30));
        let t = Instant::now();
        b.on_failure(t);
        assert_eq!(b.decide(t + Duration::from_secs(30)), Verdict::Allow);
        b.on_success(t + Duration::from_secs(31));
        assert_eq!(b.state(), BreakerState::Closed);
        assert_eq!(b.retry_after(t + Duration::from_secs(31)), None);
        assert_eq!(b.decide(t + Duration::from_secs(32)), Verdict::Allow);
        assert_eq!(b.snapshot().openings, 1, "closing is not a new opening");
    }

    #[test]
    fn a_failed_probe_reopens_for_a_full_cooldown() {
        let mut b = CircuitBreaker::new(cfg(1, 30));
        let t = Instant::now();
        b.on_failure(t);
        let probe_at = t + Duration::from_secs(30);
        assert_eq!(b.decide(probe_at), Verdict::Allow);
        b.on_failure(probe_at);
        assert_eq!(b.state(), BreakerState::Open);
        // The failed probe earned a *full* cooldown from its own instant.
        assert_eq!(b.retry_after(probe_at), Some(Duration::from_secs(30)));
        assert_eq!(b.snapshot().openings, 2);
    }

    #[test]
    fn disabled_is_the_identity() {
        let mut b = CircuitBreaker::new(BreakerConfig {
            enabled: false,
            fail_threshold: 1,
            cooldown: Duration::from_secs(1),
        });
        let t = Instant::now();
        for _ in 0..10 {
            b.on_failure(t);
            assert_eq!(b.decide(t), Verdict::Allow);
        }
        assert_eq!(b.state(), BreakerState::Closed);
        assert_eq!(b.snapshot().openings, 0);
    }

    #[test]
    fn config_defaults_are_documented_values() {
        let d = BreakerConfig::default();
        assert!(d.enabled);
        assert_eq!(d.fail_threshold, 3);
        assert_eq!(d.cooldown, Duration::from_secs(30));
    }

    // ---- decorator (real call path) -----------------------------------------

    #[tokio::test]
    async fn repeated_start_failures_open_after_the_threshold() {
        let (backend, calls, br) = rig(cfg(2, 30), true, false);
        let ctx = HashMap::new();
        assert!(backend.infer("p", &ctx, 4).await.is_err());
        assert!(backend.infer("p", &ctx, 4).await.is_err());
        assert_eq!(lock(&br).state(), BreakerState::Open);
        // The third call never reaches the backend — this is the whole point.
        let err = match backend.infer("p", &ctx, 4).await {
            Ok(_) => panic!("must fail fast while the breaker is open"),
            Err(e) => e,
        };
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "backend not called while open"
        );
        let msg = err.to_string();
        assert!(msg.contains("circuit breaker open"), "stated reason: {msg}");
        assert!(msg.contains("retry in"), "stated wait: {msg}");
    }

    #[tokio::test]
    async fn a_broken_stream_counts_as_a_failure_and_a_complete_stream_counts_as_a_success() {
        // Threshold 1: one broken stream is enough to open.
        let (backend, _calls, br) = rig(cfg(1, 30), false, true);
        let ctx = HashMap::new();
        let mut s = backend.infer("p", &ctx, 4).await.expect("starts fine");
        assert!(s.next().await.expect("one item").is_err());
        assert_eq!(
            lock(&br).state(),
            BreakerState::Open,
            "stream error counted"
        );

        // A healthy backend: a fully consumed stream closes/keeps it closed.
        let (ok, calls, br2) = rig(cfg(1, 30), false, false);
        let mut s = ok.infer("p", &ctx, 4).await.expect("starts fine");
        assert_eq!(s.next().await.expect("token").expect("ok"), "hi");
        assert!(s.next().await.is_none());
        let snap = lock(&br2).snapshot();
        assert_eq!(snap.successes, 1);
        assert_eq!(snap.openings, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn health_check_passes_through_without_opening_the_breaker() {
        let (backend, _calls, br) = rig(cfg(1, 30), true, false);
        // `health_check` on the counting backend always succeeds — the point is that
        // it is not counted as a generation either way.
        assert!(backend.health_check().await.is_ok());
        let snap = lock(&br).snapshot();
        assert_eq!(snap.successes, 0);
        assert_eq!(snap.failures, 0);
        assert_eq!(snap.state, BreakerState::Closed);
    }

    #[tokio::test]
    async fn the_decorator_advertises_itself_and_passes_stats_through() {
        let (backend, _calls, _br) = rig(cfg(1, 30), false, false);
        assert_eq!(backend.metadata().name, "counting+breaker");
        // Idempotent: never "counting+breaker+breaker".
        assert_eq!(backend.metadata().name, "counting+breaker");
        let stats = backend.get_stats().await;
        assert_eq!(
            stats.gpu_utilization_percent, None,
            "no fabricated readings"
        );
    }

    #[tokio::test]
    async fn a_disabled_breaker_never_interferes() {
        let disabled = BreakerConfig {
            enabled: false,
            fail_threshold: 1,
            cooldown: Duration::from_secs(30),
        };
        let (backend, calls, br) = rig(disabled, true, false);
        let ctx = HashMap::new();
        for _ in 0..5 {
            assert!(backend.infer("p", &ctx, 4).await.is_err());
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            5,
            "every call reached the backend"
        );
        assert_eq!(lock(&br).state(), BreakerState::Closed);
    }

    // --- F-AI-035 (REQ-A1932): "unset" and "set but unrecognised" stay apart ---

    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    /// Counts WARN events on this thread (via `set_default`), so an assertion lands
    /// on the operator's only view of a discarded flag rather than on a restatement
    /// of the code.
    struct WarnProbe(Arc<AtomicU64>);
    impl tracing::Subscriber for WarnProbe {
        fn enabled(&self, _m: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _s: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _id: &tracing::span::Id, _r: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _a: &tracing::span::Id, _b: &tracing::span::Id) {}
        fn event(&self, ev: &tracing::Event<'_>) {
            if ev.metadata().level() == &tracing::Level::WARN {
                self.0.fetch_add(1, AtomicOrdering::Relaxed);
            }
        }
        fn enter(&self, _id: &tracing::span::Id) {}
        fn exit(&self, _id: &tracing::span::Id) {}
    }

    /// Run `f` under a WARN probe and report its result plus how many WARNs it produced.
    fn warns_of<T>(f: impl FnOnce() -> T) -> (T, u64) {
        let warns = Arc::new(AtomicU64::new(0));
        let out = {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            f()
        };
        (out, warns.load(AtomicOrdering::Relaxed))
    }

    /// The three knobs this reader owns — wiped together so a case for one can never
    /// be coloured by a leftover value of another.
    const ALL_ENV: &[&str] = &[ENABLED_ENV, FAILS_ENV, COOLDOWN_ENV];

    /// Save/wipe/restore env vars for the duration of a test. Saves as `OsString` so
    /// a pre-existing non-Unicode value is restored byte-for-byte.
    struct EnvGuard {
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }
    impl EnvGuard {
        fn wipe(keys: &[&'static str]) -> Self {
            let saved = keys.iter().map(|k| (*k, std::env::var_os(k))).collect();
            for k in keys {
                std::env::remove_var(k);
            }
            Self { saved }
        }
        fn set(&self, key: &'static str, value: impl AsRef<std::ffi::OsStr>) {
            std::env::set_var(key, value);
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                match v {
                    Some(s) => std::env::set_var(k, s),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    #[test]
    #[serial_test::serial(breaker_env_lock)]
    fn an_unrecognised_breaker_flag_is_reported_not_silently_kept_enabled() {
        let env = EnvGuard::wipe(ALL_ENV);
        env.set(ENABLED_ENV, "flase"); // a typo of `false`
        let (cfg, warns) = warns_of(BreakerConfig::from_env);
        assert!(
            cfg.enabled,
            "an unreadable token keeps the safe (armed) default"
        );
        assert_eq!(
            warns, 1,
            "the operator asked to disable the breaker and was never told the request was discarded"
        );
    }

    #[test]
    #[serial_test::serial(breaker_env_lock)]
    fn an_unset_breaker_flag_stays_silent_and_keeps_the_default() {
        let _env = EnvGuard::wipe(ALL_ENV);
        let (cfg, warns) = warns_of(BreakerConfig::from_env);
        assert!(cfg.enabled);
        assert_eq!(warns, 0, "a genuinely unset variable is the silent case");
    }

    #[test]
    #[serial_test::serial(breaker_env_lock)]
    fn the_documented_disable_tokens_disable_without_a_warning() {
        let env = EnvGuard::wipe(ALL_ENV);
        for tok in ["0", "false", "off", "no", "OFF", "  No  "] {
            env.set(ENABLED_ENV, tok);
            let (cfg, warns) = warns_of(BreakerConfig::from_env);
            assert!(!cfg.enabled, "AMOS_BREAKER={tok:?} disables the breaker");
            assert_eq!(warns, 0, "{tok:?} is a documented token and must not warn");
        }
    }

    #[test]
    #[serial_test::serial(breaker_env_lock)]
    fn the_numeric_knobs_are_read() {
        let env = EnvGuard::wipe(ALL_ENV);
        env.set(FAILS_ENV, "7");
        env.set(COOLDOWN_ENV, "45");
        let (cfg, warns) = warns_of(BreakerConfig::from_env);
        assert_eq!(cfg.fail_threshold, 7);
        assert_eq!(cfg.cooldown, Duration::from_secs(45));
        assert_eq!(warns, 0);
    }

    #[cfg(unix)]
    #[test]
    #[serial_test::serial(breaker_env_lock)]
    fn a_non_unicode_breaker_flag_is_reported_not_silently_read_as_unset() {
        use std::os::unix::ffi::OsStrExt;
        let env = EnvGuard::wipe(ALL_ENV);
        env.set(ENABLED_ENV, std::ffi::OsStr::from_bytes(b"of\xfff"));
        let (cfg, warns) = warns_of(BreakerConfig::from_env);
        assert!(cfg.enabled);
        assert_eq!(
            warns, 1,
            "a present-but-unreadable value must not read as `unset`"
        );
    }

    #[cfg(unix)]
    #[test]
    #[serial_test::serial(breaker_env_lock)]
    fn a_non_unicode_numeric_knob_is_reported_not_silently_read_as_unset() {
        use std::os::unix::ffi::OsStrExt;
        let env = EnvGuard::wipe(ALL_ENV);
        env.set(FAILS_ENV, std::ffi::OsStr::from_bytes(b"7\xff"));
        let (cfg, warns) = warns_of(BreakerConfig::from_env);
        assert_eq!(
            cfg.fail_threshold,
            BreakerConfig::default().fail_threshold,
            "an unreadable value takes the documented default"
        );
        assert_eq!(warns, 1);
    }
}
