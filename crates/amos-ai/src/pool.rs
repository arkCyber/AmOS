//! Daemon-wide generation admission gate (`pool.rs`).
//!
//! Bounds the number of **concurrent in-flight inference generations** across
//! the whole daemon. This is the enforcement half of `Config::max_concurrent_sessions`
//! (`AMOS_MAX_SESSIONS`), which existed and was validated but was never read by
//! the server: the per-client [`crate::security::RateLimiter`] bounds request
//! *rate* and hourly token *quota*, while this pool bounds simultaneous
//! *executing* generations. On a battery device an unbounded fan-out of NPU/GPU
//! generations is a resource-exhaustion failure mode, so admission is:
//!
//! - **Bounded by construction** — capacity is a `NonZeroUsize`, so a "zero
//!   slots" pool is unrepresentable in the type system.
//! - **Fail-fast by default** — a saturated pool rejects immediately (wait = 0);
//!   an optional bounded wait (`AMOS_GEN_POOL_WAIT_MS`) queues instead.
//! - **Honest on rejection** — the caller gets a typed [`PoolError`] saying
//!   *why* (saturated vs wait-timeout) and every acquire/reject is countable.
//! - **Panic-safe release** — permits are RAII: dropping the permit returns the
//!   slot on every exit path (early return, error, task abort).

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

/// Default generation-pool capacity — mirrors `Config::default().max_concurrent_sessions`.
pub const DEFAULT_POOL_CAPACITY: usize = 16;

/// Why an acquire did not get a generation slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolError {
    /// Every slot was busy and the configured wait was zero (fail-fast).
    Saturated,
    /// Every slot stayed busy for the whole bounded wait.
    WaitTimeout { waited: Duration },
}

impl PoolError {
    /// Stable, human-readable reason for audit entries / gRPC details.
    pub fn reason(&self) -> String {
        match self {
            PoolError::Saturated => {
                "generation pool saturated (all generation slots busy)".to_string()
            }
            PoolError::WaitTimeout { waited } => format!(
                "generation pool stayed saturated for {}ms",
                waited.as_millis()
            ),
        }
    }
}

/// A held generation slot. Returning it is automatic on drop, so every early
/// exit path in a streaming handler releases the slot exactly once. Uses
/// tokio's *owned* permit (from an `Arc<Semaphore>`) so a permit is `'static`
/// and can be moved into a spawned streaming task.
#[derive(Debug)]
pub struct PoolPermit {
    // `OwnedSemaphorePermit` releases its slot on drop; wrapped so callers
    // cannot accidentally forget the pool semantics (the permit is opaque).
    _permit: tokio::sync::OwnedSemaphorePermit,
}

/// Monotonic pool counters. Rejections are split into saturated (fail-fast) and
/// timeout (bounded wait) so the two failure modes stay distinguishable in
/// audit entries and metrics.
#[derive(Debug, Default)]
struct PoolCounters {
    acquired_total: AtomicU64,
    rejected_saturated: AtomicU64,
    rejected_timeout: AtomicU64,
}

/// Bounded daemon-wide pool of concurrent generation slots.
#[derive(Debug)]
pub struct GenerationPool {
    capacity: NonZeroUsize,
    semaphore: Arc<Semaphore>,
    counters: PoolCounters,
}

impl GenerationPool {
    /// Create a pool with a nonzero capacity (type-encoded invariant: a pool
    /// with zero slots can never exist).
    pub fn new(capacity: NonZeroUsize) -> Self {
        Self {
            capacity,
            semaphore: Arc::new(Semaphore::new(capacity.get())),
            counters: PoolCounters::default(),
        }
    }

    /// Fallible constructor for `usize` capacities: `0` is a config error and
    /// is reported, never silently clamped.
    pub fn try_new(capacity: usize) -> Result<Self, String> {
        let capacity = NonZeroUsize::new(capacity)
            .ok_or_else(|| "generation pool capacity must be >= 1".to_string())?;
        Ok(Self::new(capacity))
    }

    /// Build from the `AMOS_MAX_SESSIONS` env var, falling back to
    /// [`DEFAULT_POOL_CAPACITY`]. Values `< 1` fall back too (same rule as
    /// `Config::from_env`, which only accepts `>= 1`).
    pub fn from_env() -> Self {
        let capacity = std::env::var("AMOS_MAX_SESSIONS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .and_then(NonZeroUsize::new)
            .unwrap_or_else(|| {
                NonZeroUsize::new(DEFAULT_POOL_CAPACITY).unwrap_or(NonZeroUsize::MIN)
            });
        Self::new(capacity)
    }

    /// Fixed capacity (never changes after construction).
    pub fn capacity(&self) -> usize {
        self.capacity.get()
    }

    /// Slots currently in flight (held permits).
    pub async fn in_flight(&self) -> usize {
        self.capacity.get() - self.semaphore.available_permits()
    }

    /// Free slots right now.
    pub async fn available(&self) -> usize {
        self.semaphore.available_permits()
    }

    /// Monotonic counters: `(acquired, rejected_saturated, rejected_timeout)`.
    pub fn counters(&self) -> (u64, u64, u64) {
        (
            self.counters.acquired_total.load(Ordering::Relaxed),
            self.counters.rejected_saturated.load(Ordering::Relaxed),
            self.counters.rejected_timeout.load(Ordering::Relaxed),
        )
    }

    /// Acquire one generation slot, waiting at most `wait` for it.
    ///
    /// `wait == Duration::ZERO` is the deterministic fail-fast mode: a saturated
    /// pool rejects immediately with [`PoolError::Saturated`].
    pub async fn acquire(&self, wait: Duration) -> Result<PoolPermit, PoolError> {
        if wait.is_zero() {
            match self.semaphore.clone().try_acquire_owned() {
                Ok(permit) => {
                    self.counters.acquired_total.fetch_add(1, Ordering::Relaxed);
                    Ok(PoolPermit { _permit: permit })
                }
                Err(_would_block) => {
                    self.counters
                        .rejected_saturated
                        .fetch_add(1, Ordering::Relaxed);
                    Err(PoolError::Saturated)
                }
            }
        } else {
            match tokio::time::timeout(wait, self.semaphore.clone().acquire_owned()).await {
                Ok(Ok(permit)) => {
                    self.counters.acquired_total.fetch_add(1, Ordering::Relaxed);
                    Ok(PoolPermit { _permit: permit })
                }
                // The semaphore is never closed in this daemon; surface an
                // honest typed failure instead of an unreachable panic path.
                Ok(Err(_closed)) => {
                    self.counters
                        .rejected_saturated
                        .fetch_add(1, Ordering::Relaxed);
                    Err(PoolError::Saturated)
                }
                Err(_elapsed) => {
                    self.counters
                        .rejected_timeout
                        .fetch_add(1, Ordering::Relaxed);
                    Err(PoolError::WaitTimeout { waited: wait })
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_capacity_is_a_construction_error() {
        assert!(
            GenerationPool::try_new(0).is_err(),
            "capacity 0 must be rejected"
        );
        assert!(GenerationPool::try_new(1).is_ok());
        assert!(GenerationPool::try_new(DEFAULT_POOL_CAPACITY).is_ok());
    }

    #[tokio::test]
    async fn fail_fast_acquire_releases_on_drop() {
        let pool = GenerationPool::try_new(2).unwrap();
        let p1 = pool.acquire(Duration::ZERO).await.expect("first permit");
        assert_eq!(pool.in_flight().await, 1);
        let p2 = pool.acquire(Duration::ZERO).await.expect("second permit");
        assert_eq!(pool.in_flight().await, 2);
        drop(p1);
        assert_eq!(pool.in_flight().await, 1);
        drop(p2);
        assert_eq!(pool.in_flight().await, 0);
        assert_eq!(pool.available().await, 2);
        assert_eq!(pool.counters(), (2, 0, 0));
    }

    #[tokio::test]
    async fn saturated_fail_fast_rejects_with_typed_error() {
        let pool = GenerationPool::try_new(1).unwrap();
        let _p = pool.acquire(Duration::ZERO).await.expect("the only slot");
        let err = pool
            .acquire(Duration::ZERO)
            .await
            .expect_err("saturated pool must reject");
        assert_eq!(err, PoolError::Saturated);
        assert!(err.reason().contains("saturated"));
        assert_eq!(
            pool.counters(),
            (1, 1, 0),
            "saturated rejection counted exactly"
        );
    }

    #[tokio::test]
    async fn bounded_wait_times_out_honestly_then_succeeds_after_release() {
        let pool = GenerationPool::try_new(1).unwrap();
        let held = pool.acquire(Duration::ZERO).await.expect("hold the slot");
        let err = pool
            .acquire(Duration::from_millis(20))
            .await
            .expect_err("bounded wait must time out while the slot is held");
        match &err {
            PoolError::WaitTimeout { waited } => {
                assert!(*waited >= Duration::from_millis(20));
                assert!(err.reason().contains("20ms"));
            }
            other => panic!("expected WaitTimeout, got {other:?}"),
        }
        assert_eq!(pool.counters(), (1, 0, 1), "timeout counted separately");
        drop(held);
        let _q = pool
            .acquire(Duration::from_millis(500))
            .await
            .expect("released slot is acquirable");
        assert_eq!(pool.counters(), (2, 0, 1));
    }

    #[tokio::test]
    async fn bounded_wait_wakes_when_slot_is_released() {
        let pool = Arc::new(GenerationPool::try_new(1).unwrap());
        let held = Arc::new(pool.acquire(Duration::ZERO).await.unwrap());
        let waiter_pool = pool.clone();
        let handle = tokio::spawn(async move { waiter_pool.acquire(Duration::from_secs(5)).await });
        // Give the waiter time to park on the semaphore, then release the slot.
        tokio::time::sleep(Duration::from_millis(30)).await;
        drop(held);
        let got = handle
            .await
            .expect("waiter task joins")
            .expect("slot acquired after release");
        drop(got);
        assert_eq!(pool.in_flight().await, 0);
    }

    #[tokio::test]
    async fn concurrent_tasks_never_exceed_capacity() {
        // Fail-fast semantics: a saturated pool rejects immediately, so tasks
        // retry within a *static* bound until they get a slot. The invariant
        // under test is that in-flight never exceeds capacity.
        let pool = Arc::new(GenerationPool::try_new(3).unwrap());
        let max_seen = Arc::new(AtomicU64::new(0));
        let mut handles = Vec::new();
        for _ in 0..12 {
            let pool = pool.clone();
            let max_seen = max_seen.clone();
            handles.push(tokio::spawn(async move {
                const MAX_ATTEMPTS: usize = 200;
                for _ in 0..MAX_ATTEMPTS {
                    match pool.acquire(Duration::ZERO).await {
                        Ok(permit) => {
                            let now = pool.in_flight().await as u64;
                            max_seen.fetch_max(now, Ordering::Relaxed);
                            // Hold long enough to make overlaps observable.
                            tokio::time::sleep(Duration::from_millis(5)).await;
                            drop(permit);
                            return true;
                        }
                        Err(_) => {
                            tokio::time::sleep(Duration::from_millis(2)).await;
                        }
                    }
                }
                false
            }));
        }
        let mut acquired_all = 0;
        for h in handles {
            if h.await.expect("task joins") {
                acquired_all += 1;
            }
        }
        assert_eq!(acquired_all, 12, "every task eventually got a slot");
        assert!(
            max_seen.load(Ordering::Relaxed) <= 3,
            "in-flight must never exceed capacity"
        );
        let (acquired, _, _) = pool.counters();
        assert_eq!(acquired, 12);
        assert_eq!(pool.in_flight().await, 0, "all permits released");
    }

    #[test]
    fn capacity_default_stays_in_lockstep_with_config() {
        // Keep the pool default and Config::default().max_concurrent_sessions
        // aligned on purpose; a divergence is a documentation lie.
        assert_eq!(DEFAULT_POOL_CAPACITY, 16);
        assert_eq!(
            crate::config::Config::default().max_concurrent_sessions,
            DEFAULT_POOL_CAPACITY
        );
    }

    #[tokio::test]
    async fn permit_is_send_across_await_points() {
        // Streaming handlers move the permit into spawned tasks; pin the `Send`
        // bound here so a regression fails at compile time, not on device.
        fn assert_send<T: Send>(_: &T) {}
        let pool = GenerationPool::try_new(1).unwrap();
        let permit = pool.acquire(Duration::ZERO).await.unwrap();
        assert_send(&permit);
    }
}
