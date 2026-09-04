//! On-device inference profiling (`profiler.rs`) — daemon assembly of
//! [`amos_profiling`].
//!
//! The roadmap's "Performance profiling and optimization" needs numbers from the
//! *real* generate path, not just a library. This store is shared (behind an
//! `Arc`) between the daemon's `stream_chat` text turns and `get_status`:
//!
//! * Each completed decode turn records its **streamed-token count + wall time**
//!   into an [`amos_profiling::ProfileTracker`] (guard-divided → no NaN).
//! * Each turn also records its **time-to-first-token** (start → first token).
//! * [`ProfileStore::snapshot`] folds these into a [`ProfileSnapshot`] that
//!   `get_status` maps onto the `StatusReply.profile` wire field.
//!
//! Honest labels: without a tokenizer the daemon does not count *prompt* tokens,
//! so we only report what is genuinely measurable end-to-end — generated tokens
//! streamed to the client per second (including backend/network latency) and the
//! first-token latency the user actually feels.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use amos_profiling::{Phase, ProfileTracker};

/// A point-in-time profile read (mapped onto `ProfileMetrics`).
#[derive(Debug, Clone, Copy, Default)]
pub struct ProfileSnapshot {
    /// End-to-end generated tokens per second (0 when no decode runs yet).
    pub decode_tokens_per_sec: f64,
    /// Mean time-to-first-token, milliseconds (0 when no runs yet).
    pub ttft_ms: f64,
    /// Total generated tokens since daemon start.
    pub decode_tokens_total: u64,
    /// Completed stream_chat decode turns.
    pub decode_runs: u64,
}

/// Shared, accumulating inference profile for the daemon.
pub struct ProfileStore {
    tracker: Mutex<ProfileTracker>,
    ttft_us_total: AtomicU64,
    ttft_samples: AtomicU64,
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ProfileStore {
    pub fn new() -> Self {
        Self {
            tracker: Mutex::new(ProfileTracker::new()),
            ttft_us_total: AtomicU64::new(0),
            ttft_samples: AtomicU64::new(0),
        }
    }

    /// Record one completed decode turn (`tokens` streamed over `wall`).
    pub fn record_decode(&self, tokens: u64, wall: Duration) {
        if tokens == 0 {
            return;
        }
        let mut t = self.tracker.lock().unwrap_or_else(|p| p.into_inner());
        t.record(Phase::Decode, tokens, wall);
    }

    /// Record the wall time from a turn start to its first streamed token.
    pub fn record_ttft(&self, first_token_latency: Duration) {
        self.ttft_us_total
            .fetch_add(first_token_latency.as_micros() as u64, Ordering::Relaxed);
        self.ttft_samples.fetch_add(1, Ordering::Relaxed);
    }

    /// Current profile read, consistent for one `get_status` reply.
    pub fn snapshot(&self) -> ProfileSnapshot {
        let t = self.tracker.lock().unwrap_or_else(|p| p.into_inner());
        let ttft_samples = self.ttft_samples.load(Ordering::Relaxed);
        let ttft_ms = if ttft_samples > 0 {
            (self.ttft_us_total.load(Ordering::Relaxed) as f64) / (ttft_samples as f64) / 1000.0
        } else {
            0.0
        };
        ProfileSnapshot {
            decode_tokens_per_sec: t.decode_tokens_per_second().unwrap_or(0.0),
            ttft_ms,
            decode_tokens_total: t.decode_tokens(),
            decode_runs: t.decode_records(),
        }
    }

    /// Periodically log the rolling profile on the same cadence as the daemon's
    /// health heartbeat, so an operator sees live inference numbers without an
    /// RPC round-trip. Aborted on shutdown (mirrors the monitoring heartbeat).
    pub fn spawn_periodic_log(self: &Arc<Self>, interval: Duration) -> tokio::task::JoinHandle<()> {
        // tokio's interval panics on a zero period; clamp so a caller can't make
        // this task panic.
        let interval = interval.max(Duration::from_millis(1));
        let profiler = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                let s = profiler.snapshot();
                tracing::info!(
                    decode_tokens_per_sec = s.decode_tokens_per_sec,
                    ttft_ms = s.ttft_ms,
                    decode_tokens_total = s.decode_tokens_total,
                    decode_runs = s.decode_runs,
                    "amos-ai inference profile"
                );
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_store_reports_no_data() {
        let s = ProfileStore::new();
        let snap = s.snapshot();
        assert_eq!(snap.decode_runs, 0);
        assert_eq!(snap.decode_tokens_total, 0);
        assert_eq!(snap.decode_tokens_per_sec, 0.0);
        assert_eq!(snap.ttft_ms, 0.0);
    }

    #[test]
    fn decode_records_accumulate_throughput() {
        let s = ProfileStore::new();
        // 100 tokens over 2 s → 50 tps, decode_runs=1.
        s.record_decode(100, Duration::from_secs(2));
        s.record_ttft(Duration::from_millis(150));
        let snap = s.snapshot();
        assert_eq!(snap.decode_runs, 1);
        assert_eq!(snap.decode_tokens_total, 100);
        assert!((snap.decode_tokens_per_sec - 50.0).abs() < 1e-9);
        assert!((snap.ttft_ms - 150.0).abs() < 1e-9);
    }

    #[test]
    fn zero_token_turn_is_skipped() {
        let s = ProfileStore::new();
        s.record_decode(0, Duration::from_secs(1));
        assert_eq!(s.snapshot().decode_runs, 0);
    }

    #[test]
    fn ttft_averages_across_samples() {
        let s = ProfileStore::new();
        s.record_ttft(Duration::from_millis(100));
        s.record_ttft(Duration::from_millis(300));
        assert!((s.snapshot().ttft_ms - 200.0).abs() < 1e-9);
    }
}
