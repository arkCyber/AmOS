//! Daemon health & metrics (`monitoring.rs`).
//!
//! A lightweight, process-local metrics surface for the AI daemon:
//!
//! * [`Monitor`] keeps cheap atomic counters (RPC calls seen at the gRPC
//!   boundary, uptime, periodic heartbeat ticks) and produces a [`Snapshot`].
//! * [`Monitor::spawn_periodic`] runs a low-frequency self-health heartbeat that
//!   logs the latest [`Snapshot`], so an operator (or `amos-supervisor`) sees a
//!   periodic "still alive & here are the numbers" line.
//!
//! The daemon serves the [`Snapshot`] to callers via the `GetStatus` RPC, so a
//! health probe gets the same numbers over the wire. All counters are
//! `AtomicU64`/`Instant` — lock-free and safe to share behind an `Arc`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::task::JoinHandle;

/// A point-in-time metrics read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Snapshot {
    /// Whole seconds since the [`Monitor`] was created (≈ daemon uptime).
    pub uptime_secs: u64,
    /// Total RPC requests counted at the gRPC boundary.
    pub rpc_total: u64,
    /// Number of periodic self-health heartbeat ticks emitted.
    pub heartbeats: u64,
}

/// Lock-free daemon metrics.
pub struct Monitor {
    start: Instant,
    rpc_total: AtomicU64,
    heartbeats: AtomicU64,
}

impl Default for Monitor {
    fn default() -> Self {
        Self::new()
    }
}

impl Monitor {
    /// A fresh monitor (uptime starts counting now, all counters zeroed).
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            rpc_total: AtomicU64::new(0),
            heartbeats: AtomicU64::new(0),
        }
    }

    /// Record one RPC request seen at the gRPC boundary.
    pub fn record_rpc(&self) {
        self.rpc_total.fetch_add(1, Ordering::Relaxed);
    }

    /// Record one periodic self-health heartbeat tick.
    pub fn heartbeat(&self) {
        self.heartbeats.fetch_add(1, Ordering::Relaxed);
    }

    /// Current metrics read.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            uptime_secs: self.start.elapsed().as_secs(),
            rpc_total: self.rpc_total.load(Ordering::Relaxed),
            heartbeats: self.heartbeats.load(Ordering::Relaxed),
        }
    }

    /// Spawn a periodic self-health heartbeat that logs each [`Snapshot`].
    ///
    /// The task runs until aborted (the daemon aborts it on shutdown). Tokio's
    /// interval fires its first tick immediately, so a health line is logged
    /// right away and then every `interval`.
    pub fn spawn_periodic(self: &Arc<Self>, interval: Duration) -> JoinHandle<()> {
        // tokio's interval panics on a zero period; clamp to a tiny floor so a
        // caller can't make the heartbeat task panic.
        let interval = interval.max(Duration::from_millis(1));
        let monitor = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                monitor.heartbeat();
                let s = monitor.snapshot();
                tracing::info!(
                    uptime_s = s.uptime_secs,
                    rpc_total = s.rpc_total,
                    heartbeats = s.heartbeats,
                    "amos-ai health metrics"
                );
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_accumulate_and_snapshot_reflects_them() {
        let m = Monitor::new();
        assert_eq!(m.snapshot().rpc_total, 0);
        m.record_rpc();
        m.record_rpc();
        m.record_rpc();
        m.heartbeat();
        let s = m.snapshot();
        assert_eq!(s.rpc_total, 3);
        assert_eq!(s.heartbeats, 1);
    }

    #[tokio::test]
    async fn uptime_advances_and_periodic_heartbeat_fires() {
        let m = Arc::new(Monitor::new());
        assert_eq!(m.snapshot().uptime_secs, 0);

        // Short sleep so the monotonic uptime has advanced at least ~a step.
        tokio::time::sleep(Duration::from_millis(5)).await;

        let handle = m.spawn_periodic(Duration::from_millis(5));
        // Let several heartbeat ticks fire, then stop.
        tokio::time::sleep(Duration::from_millis(40)).await;
        handle.abort();

        assert!(
            m.snapshot().heartbeats >= 1,
            "periodic heartbeat should have fired at least once"
        );
    }

    #[tokio::test]
    async fn zero_interval_is_clamped_and_heartbeat_still_fires() {
        // A zero interval must not panic the spawned task (tokio interval would
        // reject it); it is clamped to a tiny floor and still ticks.
        let m = Arc::new(Monitor::new());
        let handle = m.spawn_periodic(Duration::ZERO);
        tokio::time::sleep(Duration::from_millis(20)).await;
        handle.abort();
        assert!(
            m.snapshot().heartbeats >= 1,
            "heartbeat should fire even with a zero request interval"
        );
    }
}
