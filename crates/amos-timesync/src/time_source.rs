//! The [`TimeSource`] seam: how a calibrated wall time is obtained.
//!
//! The rest of the crate never talks to the network directly — it asks a
//! [`TimeSource`]. This mirrors the repo's provider pattern (`StoreProvider`,
//! `StreamingRecognizer`): a deterministic in-memory mock for tests, an offline
//! host-clock fallback, and a real network backend gated behind a feature.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use async_trait::async_trait;

use crate::error::{Error, Result};

/// A source of an authoritative wall-clock [`SystemTime`].
///
/// Implementations must be cheap to share (`Send + Sync`) and infallibly
/// *returnable* — actual failures are reported as [`Error`].
#[async_trait]
pub trait TimeSource: Send + Sync {
    /// Fetch the current network-authoritative wall time.
    async fn fetch_time(&self) -> Result<SystemTime>;
}

/// The offline fallback: reads the local host wall clock directly.
///
/// This performs no network I/O, so it is the safe default when no NTP server is
/// configured or when the device is offline. It cannot *calibrate* a wrong host
/// clock, but it keeps the clock model total.
#[derive(Debug, Clone, Copy, Default)]
pub struct HostClock;

#[async_trait]
impl TimeSource for HostClock {
    async fn fetch_time(&self) -> Result<SystemTime> {
        Ok(SystemTime::now())
    }
}

struct MockInner {
    /// Queued results; each `fetch` pops the next one. When empty the *last*
    /// returned result is repeated, so a periodic loop keeps getting a value.
    queue: VecDeque<Result<SystemTime>>,
    /// The most recently returned result, repeated once the queue is drained.
    last: Option<Result<SystemTime>>,
    /// Number of `fetch_time` calls so far.
    calls: u64,
}

/// A deterministic, scriptable [`TimeSource`] for tests.
///
/// Each [`fetch_time`](TimeSource::fetch_time) returns the next value from the
/// injected sequence (a time or an error) and, once the sequence is exhausted,
/// repeats the last value forever. [`call_count`](MockTimeSource::call_count)
/// reports how many fetches happened, so a periodic-loop test can assert progress.
///
/// ```
/// use std::time::{Duration, SystemTime, UNIX_EPOCH};
/// use amos_timesync::{MockTimeSource, TimeSource};
///
/// # #[tokio::main]
/// # async fn main() {
/// let fixed = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
/// let src = MockTimeSource::fixed(fixed);
/// assert_eq!(src.fetch_time().await.unwrap(), fixed);
/// # }
/// ```
#[derive(Clone)]
pub struct MockTimeSource {
    inner: Arc<Mutex<MockInner>>,
}

impl MockTimeSource {
    /// A source that always returns `t`.
    pub fn fixed(t: SystemTime) -> Self {
        Self::sequence([Ok(t)])
    }

    /// A source that always reports `err`.
    pub fn failing(err: Error) -> Self {
        Self::sequence([Err(err)])
    }

    /// A source driven by an explicit sequence of outcomes (errors allowed), then
    /// repeating the final one forever.
    pub fn sequence<I>(results: I) -> Self
    where
        I: IntoIterator<Item = Result<SystemTime>>,
    {
        Self {
            inner: Arc::new(Mutex::new(MockInner {
                queue: results.into_iter().collect(),
                last: None,
                calls: 0,
            })),
        }
    }

    /// Number of `fetch_time` calls performed so far.
    pub fn call_count(&self) -> u64 {
        self.inner.lock().map(|g| g.calls).unwrap_or(0)
    }
}

#[async_trait]
impl TimeSource for MockTimeSource {
    async fn fetch_time(&self) -> Result<SystemTime> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| Error::Source("mock lock poisoned".into()))?;
        inner.calls += 1;
        if let Some(next) = inner.queue.pop_front() {
            inner.last = Some(next.clone());
        }
        // Repeat the last outcome once the script is drained.
        match &inner.last {
            Some(outcome) => outcome.clone(),
            None => Err(Error::Source("mock has no results".into())),
        }
    }
}
