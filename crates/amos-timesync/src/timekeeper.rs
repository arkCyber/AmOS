//! [`Timekeeper`] — a periodic time-sync loop for a daemon orchestrator.
//!
//! A clock must be re-calibrated on an interval, not just once at boot. A
//! [`Timekeeper`] owns a shared [`SyncedClock`] and a [`TimeSource`]; each tick it
//! pulls a fresh remote time into the clock (updating its offset and the
//! persisted last-known-good state) and then sleeps until the next tick or until
//! it is told to stop.
//!
//! A supervisor / daemon orchestrator typically calls
//! [`spawn_timekeeper`], keeps the returned shutdown sender, and signals it on
//! graceful shutdown.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::clock::SyncedClock;
use crate::time_source::TimeSource;

/// Floor on the poll interval. Guards against a caller passing `0` or a sub-ms
/// value, which would otherwise turn the loop into a hot spin that hammers a
/// time server.
const MIN_POLL_INTERVAL: Duration = Duration::from_millis(1);

/// Drives periodic calibration of a shared [`SyncedClock`].
#[derive(Debug, Clone)]
pub struct Timekeeper {
    /// The shared clock to calibrate.
    pub clock: Arc<Mutex<SyncedClock>>,
    /// Time between calibration passes.
    pub interval: Duration,
    /// Human-readable name for logs.
    pub name: String,
}

impl Timekeeper {
    /// Build a timekeeper around a shared clock with a given poll interval.
    pub fn new(clock: Arc<Mutex<SyncedClock>>, interval: Duration) -> Self {
        Self {
            clock,
            interval,
            name: "timesync".to_string(),
        }
    }

    /// Set a log-friendly name.
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }

    /// Spawn the periodic loop on the current Tokio runtime.
    ///
    /// The loop synchronizes immediately, then waits `interval` between passes,
    /// stopping cleanly once the returned shutdown sender is signalled with
    /// `true`. The returned handle completes when the loop has fully stopped.
    ///
    /// The loop never holds the shared-clock lock across the network fetch: it
    /// pulls from the source *outside* the lock and only locks briefly to apply
    /// the result, so readers of [`SyncedClock::now`](crate::SyncedClock::now)
    /// never block on a slow NTP query.
    pub fn spawn(self, source: Arc<dyn TimeSource>) -> (JoinHandle<()>, watch::Sender<bool>) {
        spawn_timekeeper(self.clock, source, self.interval, self.name)
    }
}

/// Spawn a periodic time-sync loop.
///
/// Equivalent to [`Timekeeper::spawn`]; provided as a free function for callers
/// that prefer not to build a [`Timekeeper`].
///
/// The loop fetches from `source` *without* holding the `clock` lock (a network
/// query can take seconds), then locks only long enough to apply the offset, and
/// bails out promptly when the shutdown flag is set — even before a slow fetch or
/// mid-loop, so a stop is never deferred by the poll interval.
pub fn spawn_timekeeper(
    clock: Arc<Mutex<SyncedClock>>,
    source: Arc<dyn TimeSource>,
    interval: Duration,
    name: String,
) -> (JoinHandle<()>, watch::Sender<bool>) {
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    // Never spin: enforce a tiny floor so a `0`/sub-ms interval can't become a
    // busy loop hammering the time source.
    let interval = interval.max(MIN_POLL_INTERVAL);

    let handle = tokio::spawn(async move {
        loop {
            // Stop without doing work if shutdown was requested before this pass
            // (e.g. signalled while we were away on a slow fetch).
            if *shutdown_rx.borrow() {
                break;
            }

            // 1) Network fetch happens OUTSIDE the clock lock.
            let fetched = source.fetch_time().await;

            // 2) Re-check shutdown after the (possibly slow) fetch so a stop that
            //    arrived during it is honoured without another round-trip.
            if *shutdown_rx.borrow() {
                break;
            }

            // 3) Lock only to apply the fetched time (brief, non-network work).
            {
                let mut guard = clock.lock().await;
                match fetched {
                    Ok(remote) => match guard.apply(remote) {
                        Ok(accepted) => {
                            info!("timekeeper[{name}]: synced; remote epoch = {:?}", accepted)
                        }
                        Err(e) => warn!("timekeeper[{name}]: rejected remote time: {e}"),
                    },
                    Err(e) => warn!("timekeeper[{name}]: fetch failed: {e}"),
                }
            }

            // 4) Wait out the interval, aborting early on a stop request.
            let mut stopping = false;
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        stopping = true;
                    }
                }
            }
            if stopping {
                break;
            }
        }
        info!("timekeeper[{name}]: stopping");
    });

    (handle, shutdown_tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time_source::MockTimeSource;
    use std::time::UNIX_EPOCH;

    #[tokio::test]
    async fn loop_syncs_then_stops_on_shutdown() {
        let remote = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let source = MockTimeSource::fixed(remote);
        // Widen plausibility so the synthetic 2023-ish remote is accepted.
        let clock = Arc::new(Mutex::new(SyncedClock::new().with_plausibility(
            crate::clock::Plausibility {
                min_epoch_secs: 0,
                max_epoch_secs: u64::MAX,
            },
        )));

        let (handle, tx) = spawn_timekeeper(
            clock.clone(),
            Arc::new(source.clone()),
            Duration::from_millis(1),
            "test".to_string(),
        );

        // Give the loop a moment to run at least one sync.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if clock.lock().await.synced() {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("timekeeper never synced within 2s");
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        // The loop must have called the source at least once.
        assert!(source.call_count() >= 1, "source should have been polled");
        assert!(
            clock.lock().await.last_synced().is_some(),
            "clock should record a sync time"
        );

        // Signal stop and require the task to finish (no lingering task).
        let _ = tx.send(true);
        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("timekeeper did not stop within 2s")
            .expect("timekeeper task panicked");
    }

    #[tokio::test]
    async fn loop_survives_fetch_errors_and_stops_cleanly() {
        // A source that always fails: the loop must keep running (not exit or
        // panic) through repeated failures and stop cleanly on shutdown.
        let source = MockTimeSource::failing(crate::error::Error::Source("down".into()));
        let clock = Arc::new(Mutex::new(SyncedClock::new()));

        let (handle, tx) = spawn_timekeeper(
            clock.clone(),
            Arc::new(source.clone()),
            Duration::from_millis(1),
            "test-err".to_string(),
        );

        // Let a handful of failed ticks elapse; the loop must still be alive and
        // the clock unsynced (never partially calibrated by an error).
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            !clock.lock().await.synced(),
            "errors must not mark the clock synced"
        );
        assert!(
            source.call_count() >= 3,
            "loop should keep polling a failing source"
        );

        let _ = tx.send(true);
        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("timekeeper did not stop within 2s")
            .expect("timekeeper task panicked");
    }

    #[tokio::test]
    async fn zero_interval_is_clamped_and_still_syncs_then_stops() {
        // A zero interval must not become a hot spin: it is clamped to a tiny
        // floor, still syncs once, and stops cleanly on shutdown.
        let remote = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let source = MockTimeSource::fixed(remote);
        let clock = Arc::new(Mutex::new(SyncedClock::new().with_plausibility(
            crate::clock::Plausibility {
                min_epoch_secs: 0,
                max_epoch_secs: u64::MAX,
            },
        )));

        let (handle, tx) = spawn_timekeeper(
            clock.clone(),
            Arc::new(source.clone()),
            Duration::ZERO,
            "test-zero".to_string(),
        );

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if clock.lock().await.synced() {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("timekeeper with zero interval never synced within 2s");
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let _ = tx.send(true);
        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("timekeeper did not stop within 2s")
            .expect("timekeeper task panicked");
    }
}
