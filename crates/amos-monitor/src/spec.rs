//! Honest, transport-/platform-agnostic value types for a system-working-status
//! snapshot. Every scalar a real HAL / OS source might fail to produce is an
//! `Option` — an absent reading means "unknown", never a fabricated number (the
//! same honesty rule `amos-profiling`/`amos-power` follow).

/// A single CPU-load reading: the mean busy percentage over the sampler's last
/// window. `None` when there is no baseline yet (busy% is a *delta* between two
/// cumulative counters) or the platform cannot report it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CpuSample {
    /// Mean busy percentage over the last window (`0.0..=100.0`), or `None`.
    pub busy_pct: Option<f64>,
}

impl CpuSample {
    /// A fresh "nothing known yet" reading.
    pub const fn unknown() -> Self {
        Self { busy_pct: None }
    }
}

/// Memory usage. Raw bytes are kept so a UI can pick bytes vs percentage without
/// a second read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemoryInfo {
    /// Total physical memory in bytes.
    pub total_bytes: Option<u64>,
    /// Currently available memory in bytes (`MemAvailable`), when known.
    pub available_bytes: Option<u64>,
}

impl MemoryInfo {
    /// A fresh "nothing known yet" reading.
    pub const fn unknown() -> Self {
        Self {
            total_bytes: None,
            available_bytes: None,
        }
    }

    /// Used bytes = `total - available`, or `None` when either half is unknown.
    pub fn used_bytes(&self) -> Option<u64> {
        match (self.total_bytes, self.available_bytes) {
            (Some(t), Some(a)) => Some(t.saturating_sub(a)),
            _ => None,
        }
    }

    /// Used percentage (`0.0..=100.0`), or `None` when it cannot be derived.
    pub fn used_pct(&self) -> Option<f64> {
        let used = self.used_bytes()?;
        let total = self.total_bytes?;
        if total == 0 {
            return None;
        }
        Some((used as f64 / total as f64) * 100.0)
    }
}

/// The process-visible system load a [`SystemSampler`](crate::sampler) returns.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SystemLoad {
    pub cpu: CpuSample,
    pub memory: MemoryInfo,
}

impl SystemLoad {
    /// A fresh "nothing known yet" reading.
    pub const fn unknown() -> Self {
        Self {
            cpu: CpuSample::unknown(),
            memory: MemoryInfo::unknown(),
        }
    }
}

/// Live battery / board-power status folded into the health snapshot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BatteryStatus {
    /// State-of-charge percentage (`0.0..=100.0`), or `None` when unknown.
    pub level_pct: Option<f64>,
    /// Whether the device is (believed to be) charging, when known.
    pub charging: Option<bool>,
    /// Instantaneous board power draw in milliwatts, or `None` when unavailable.
    pub live_power_mw: Option<f64>,
}

impl BatteryStatus {
    /// A fresh "nothing known yet" reading.
    pub const fn unknown() -> Self {
        Self {
            level_pct: None,
            charging: None,
            live_power_mw: None,
        }
    }

    pub fn new(level_pct: Option<f64>, charging: Option<bool>, live_power_mw: Option<f64>) -> Self {
        Self {
            level_pct,
            charging,
            live_power_mw,
        }
    }

    /// Fold a real [`amos_profiling::BatterySample`]: its `power_mw()` is `0.0`
    /// when the raw µA×mV pair is invalid, which we map back to `None` (honest
    /// "unavailable") rather than reporting a fabricated `0` W.
    pub fn from_sample(sample: &amos_profiling::BatterySample, level_pct: Option<f64>) -> Self {
        let mw = sample.power_mw();
        Self::new(
            level_pct,
            None,
            if sample.is_valid() && mw > 0.0 {
                Some(mw)
            } else {
                None
            },
        )
    }
}

/// A per-process summary distilled from [`amos_applife::AppLifecycle`] counts.
/// Keeping it a plain summary (rather than leaking the whole registry) keeps the
/// health snapshot transport-ready and decoupled from the lifecycle crate.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProcessSummary {
    /// Processes that are live (any state except `Stopped`).
    pub running: usize,
    /// Processes in the reclaimable `Cached` (tombstone) tier.
    pub cached: usize,
    /// Processes that are `Stopped` (dead but kept saved state).
    pub stopped: usize,
}

/// The unified "system working status" snapshot an aggregator
/// ([`crate::SystemMonitor`]) produces and a diagnostics / Task-Manager / gRPC
/// surface can ship verbatim.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SystemHealth {
    pub load: SystemLoad,
    pub battery: BatteryStatus,
    pub processes: ProcessSummary,
}

impl SystemHealth {
    /// A one-line, human-readable rendering for the daemon's periodic health
    /// log (an operator / `amos-supervisor` can read it without a parser).
    pub fn summary(&self) -> String {
        let cpu = match self.load.cpu.busy_pct {
            Some(p) => format!("{p:.0}%"),
            None => "?".to_string(),
        };
        let mem = match self.load.memory.used_pct() {
            Some(p) => format!("{p:.0}%"),
            None => "?".to_string(),
        };
        let bat = match self.battery.level_pct {
            Some(p) => format!("{p:.0}%"),
            None => "?".to_string(),
        };
        format!(
            "cpu={cpu} mem={mem} battery={bat} procs: running={} cached={} stopped={}",
            self.processes.running, self.processes.cached, self.processes.stopped
        )
    }
}
