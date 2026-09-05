//! The [`SystemSampler`] seam and its deterministic [`MockSystemSampler`].
//!
//! Mirroring `amos-sensor`/`amos-profiling`, the sampler is deliberately dumb:
//! it just answers "what is the current system load?" A real backend reads
//! `/proc` (`linux` feature), a real device reads Android kernel / system
//! services (`android` skeleton), and the mock returns whatever the harness set
//! — so the aggregator / UI logic is fully testable offline.
//!
//! A CPU busy% is a *delta* between two cumulative counter reads, so every
//! sampler keeps its previous reading and the trait method takes `&self`: impls
//! store that previous read in interior mutability (a `Mutex`), keeping them
//! `Send + Sync` as the trait requires.

use std::sync::Mutex;

use crate::spec::{CpuSample, MemoryInfo, SystemLoad};

/// Sentinel meaning "no previous cumulative reading yet" (never a real count).
pub(crate) const NO_PREV: u64 = u64::MAX;

/// The seam to a source of system-load readings (CPU / memory).
pub trait SystemSampler: Send + Sync {
    /// Backend name (for reports / logs).
    fn name(&self) -> &'static str;

    /// The current system load. Cheap & non-blocking (a read of counters); must
    /// never fabricate a number it cannot read.
    fn snapshot(&self) -> SystemLoad;
}

/// Shared CPU busy% math from two cumulative (idle, total) counter reads.
///
/// `prev == NO_PREV` on either channel means "no baseline" → `None` (honest). A
/// zero `total_delta` window yields `None` rather than a divide-by-zero.
pub(crate) fn busy_pct_between(
    prev_idle: u64,
    prev_total: u64,
    cur_idle: u64,
    cur_total: u64,
) -> Option<f64> {
    if prev_idle == NO_PREV || prev_total == NO_PREV {
        return None;
    }
    let idle_delta = cur_idle.saturating_sub(prev_idle);
    let total_delta = cur_total.saturating_sub(prev_total);
    if total_delta == 0 {
        return None;
    }
    let busy = total_delta.saturating_sub(idle_delta);
    Some((busy as f64 / total_delta as f64) * 100.0)
}

/// A deterministic [`SystemSampler`]. The caller advances the cumulative
/// jiffies ([`advance`](Self::advance)) / memory ([`set_available`](Self::set_available))
/// between `snapshot` calls; the first `snapshot` has no CPU baseline (like a
/// real two-read delta) and yields `busy_pct = None`.
#[derive(Debug)]
pub struct MockSystemSampler {
    prev: Mutex<(u64, u64)>,
    cur: (u64, u64),
    mem_total: u64,
    mem_available: u64,
}

impl MockSystemSampler {
    pub fn new(mem_total: u64, mem_available: u64) -> Self {
        Self {
            prev: Mutex::new((NO_PREV, NO_PREV)),
            cur: (0, 0),
            mem_total,
            mem_available,
        }
    }

    /// Advance the cumulative counters before the next `snapshot`, simulating
    /// the jiffies accrued over one sampling window.
    pub fn advance(&mut self, busy_delta: u64, idle_delta: u64) {
        self.cur.0 += idle_delta;
        self.cur.1 += busy_delta + idle_delta;
    }

    /// Force the next `snapshot` to expose a chosen available memory.
    pub fn set_available(&mut self, bytes: u64) {
        self.mem_available = bytes;
    }
}

impl SystemSampler for MockSystemSampler {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn snapshot(&self) -> SystemLoad {
        let (pidle, ptotal) = *lock(&self.prev);
        let busy_pct = busy_pct_between(pidle, ptotal, self.cur.0, self.cur.1);
        // Stash this read as the next baseline.
        *lock(&self.prev) = self.cur;
        SystemLoad {
            cpu: CpuSample { busy_pct },
            memory: MemoryInfo {
                total_bytes: Some(self.mem_total),
                available_bytes: Some(self.mem_available),
            },
        }
    }
}

/// Lock a `Mutex`, recovering from poison instead of panicking (production code
/// must not panic on a poisoned-but-harmless lock).
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_read_has_no_cpu_baseline_but_mem_is_known() {
        let s = MockSystemSampler::new(8_000_000_000, 4_000_000_000);
        let load = s.snapshot();
        assert_eq!(load.cpu.busy_pct, None, "no baseline on first read");
        assert_eq!(load.memory.used_bytes(), Some(4_000_000_000));
        assert_eq!(load.memory.used_pct(), Some(50.0));
    }

    #[test]
    fn busy_pct_is_a_delta_over_one_window() {
        let mut s = MockSystemSampler::new(8_000_000_000, 8_000_000_000);
        s.snapshot(); // establishes baseline (idle=0,total=0)
        s.advance(75, 25); // one window: 75 busy + 25 idle jiffies
        let load = s.snapshot();
        let pct = load.cpu.busy_pct.expect("second read has a baseline");
        assert!((pct - 75.0).abs() < 1e-9, "got {pct}");
    }

    #[test]
    fn idle_only_window_is_0_pct_busy() {
        let mut s = MockSystemSampler::new(8_000_000_000, 8_000_000_000);
        s.snapshot();
        s.advance(0, 100);
        let load = s.snapshot();
        assert_eq!(load.cpu.busy_pct, Some(0.0));
    }

    #[test]
    fn zero_delta_window_is_unknown_not_nan() {
        let s = MockSystemSampler::new(8_000_000_000, 8_000_000_000);
        s.snapshot();
        // No jiffies accrued -> total_delta == 0 -> None (never NaN).
        let load = s.snapshot();
        assert_eq!(load.cpu.busy_pct, None);
    }

    #[test]
    fn memory_helpers_stay_honest() {
        let mut s = MockSystemSampler::new(10_000, 10_000);
        s.set_available(2_500);
        let load = s.snapshot();
        assert_eq!(load.memory.used_bytes(), Some(7_500));
        assert_eq!(load.memory.used_pct(), Some(75.0));
    }
}
