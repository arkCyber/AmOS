//! The [`SystemMonitor`] aggregator — the *phase-1* unification point.
//!
//! This is where scattered producers are folded into one honest [`SystemHealth`]
//! snapshot that a diagnostics / Task-Manager / gRPC `SystemStatus` surface can
//! ship verbatim:
//!
//! * **system load** (CPU / memory) from a [`SystemSampler`] seam,
//! * **battery / live power** from the daemon's `amos-profiling` `PowerSource`
//!   ([`BatteryStatus::from_sample`]) or plain level/charging,
//! * **per-process lifecycle counts** from an [`amos_applife::AppLifecycle`]
//!   (see [`process_summary`]).
//!
//! The energy-governor's *decision* (mode / throttle) is deliberately *not*
//! re-derived here — it is a consumer input owned by `amos-power`, so callers
//! fold `Decision.reason`/`SensorMode` in at the transport boundary instead of
//! this core duplicating policy.

use std::collections::BTreeMap;
use std::sync::Arc;

use amos_applife::{AppLifecycle, AppState};

use crate::sampler::SystemSampler;
use crate::spec::{BatteryStatus, ProcessSummary, SystemHealth};

/// Owns the system-load sampler and produces a unified [`SystemHealth`] on
/// demand (a transport-agnostic aggregator — no wall clock, no I/O beyond the
/// sampler, fully host-testable).
pub struct SystemMonitor {
    sampler: Arc<dyn SystemSampler>,
}

impl SystemMonitor {
    /// Aggregator over a shared system-load sampler.
    pub fn new(sampler: Arc<dyn SystemSampler>) -> Self {
        Self { sampler }
    }

    /// The system-load sampler backend name (for logs / reports).
    pub fn sampler_name(&self) -> &'static str {
        self.sampler.name()
    }

    /// A single unified snapshot from the sampler + live battery + process
    /// counts. Battery and lifecycle are passed in because their producers live
    /// in other crates / the daemon; this core only *folds* them so it stays
    /// decoupled and offline-testable.
    pub fn health(&self, battery: BatteryStatus, processes: ProcessSummary) -> SystemHealth {
        SystemHealth {
            load: self.sampler.snapshot(),
            battery,
            processes,
        }
    }
}

/// Distil [`amos_applife::AppLifecycle`] counts into a transport-ready summary.
///
/// `running` = live processes (every state except `Stopped`), matching
/// [`AppState::is_running`](amos_applife::AppState) semantics.
pub fn process_summary(lifecycle: &AppLifecycle) -> ProcessSummary {
    let mut summary = ProcessSummary::default();
    for (state, count) in lifecycle.counts() {
        match state {
            AppState::Stopped => summary.stopped += count,
            AppState::Cached => summary.cached += count,
            _ => summary.running += count,
        }
    }
    summary
}

/// Convenience fold for callers holding a raw counts map (e.g. a snapshot the
/// lifecycle crate already serialised).
pub fn process_summary_from_counts(counts: &BTreeMap<AppState, usize>) -> ProcessSummary {
    let mut summary = ProcessSummary::default();
    for (state, count) in counts {
        match state {
            AppState::Stopped => summary.stopped += *count,
            AppState::Cached => summary.cached += *count,
            _ => summary.running += *count,
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sampler::MockSystemSampler;

    fn lifecycle_with(foreground: usize, cached: usize, stopped: usize) -> AppLifecycle {
        let mut lc = AppLifecycle::new();
        for i in 0..foreground {
            lc.launch(amos_applife::AppId(format!("fg{i}"))).unwrap();
        }
        for i in 0..cached {
            let id = amos_applife::AppId(format!("ca{i}"));
            lc.launch(id.clone()).unwrap();
            lc.freeze(id).unwrap();
        }
        for i in 0..stopped {
            let id = amos_applife::AppId(format!("st{i}"));
            lc.launch(id.clone()).unwrap();
            lc.stop(id).unwrap();
        }
        lc
    }

    #[test]
    fn process_summary_folds_lifecycle_counts() {
        let lc = lifecycle_with(2, 3, 4);
        let s = process_summary(&lc);
        assert_eq!(s.running, 2, "only live (fg) count as running");
        assert_eq!(s.cached, 3, "frozen apps are the cached tier");
        assert_eq!(s.stopped, 4);
    }

    #[test]
    fn aggregator_folds_sampler_battery_and_processes_into_one_health() {
        let sampler = Arc::new(MockSystemSampler::new(8_000_000_000, 2_000_000_000));
        let mon = SystemMonitor::new(sampler);
        let health = mon.health(
            BatteryStatus::new(Some(42.0), Some(true), Some(1234.5)),
            ProcessSummary {
                running: 5,
                cached: 2,
                stopped: 1,
            },
        );
        assert_eq!(health.load.memory.used_pct(), Some(75.0));
        assert_eq!(health.battery.level_pct, Some(42.0));
        assert_eq!(health.processes.running, 5);
        // summary() renders a one-line log, never panics, includes known values.
        let line = health.summary();
        assert!(
            line.contains("mem=75%") && line.contains("battery=42%"),
            "{line}"
        );
        assert!(line.contains("running=5 cached=2 stopped=1"), "{line}");
    }

    #[test]
    fn aggregator_does_not_fabricate_unknown_cpu() {
        let sampler = Arc::new(MockSystemSampler::new(8_000_000_000, 8_000_000_000));
        let mon = SystemMonitor::new(sampler);
        let health = mon.health(BatteryStatus::unknown(), ProcessSummary::default());
        assert_eq!(health.load.cpu.busy_pct, None, "first read: no baseline");
        assert_eq!(health.battery.live_power_mw, None);
        assert_eq!(health.processes.running, 0);
    }
}
