//! Linux `/proc`-backed [`SystemSampler`] (`linux` feature).
//!
//! Reads cumulative CPU jiffies from `/proc/stat` and memory from
//! `/proc/meminfo`, computes the busy% as a delta between two reads (kept in a
//! `Mutex` for `&self` sampling), and reports used memory from `MemAvailable`.
//!
//! The procfs root is *injectable* (default `"/proc"`) so the parser is fully
//! host-testable over a tempdir fixture — mirroring how `amos-power`'s Linux
//! cpufreq applier tests over an injected sysfs root. No root/device for tests.

use std::path::PathBuf;
use std::sync::Mutex;

use crate::sampler::{busy_pct_between, NO_PREV};
use crate::spec::{CpuSample, MemoryInfo, SystemLoad};
use crate::SystemSampler;

/// The `/proc` filesystem root; injectable for tests.
pub fn default_proc_root() -> PathBuf {
    PathBuf::from("/proc")
}

/// Parse the aggregate `cpu` line of `/proc/stat` into `(idle, total)` jiffies.
///
/// Format (all cores summed): `cpu user nice system idle iowait irq softirq
/// steal guest guest_nice`. `idle` includes `iowait`; busy = `total - idle`.
/// Returns `None` on a malformed / missing line (honest, never fabricates).
pub fn parse_cpu_line(line: &str) -> Option<(u64, u64)> {
    let mut fields = line.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let nums: Vec<u64> = fields.filter_map(|f| f.parse::<u64>().ok()).collect();
    // user nice system idle iowait irq softirq steal = 7 core fields.
    if nums.len() < 7 {
        return None;
    }
    let idle = nums[3].saturating_add(nums[4]); // idle + iowait
    let total: u64 = nums.iter().fold(0, |a, b| a.saturating_add(*b));
    Some((idle, total))
}

/// Parse `/proc/meminfo` content into `(total_kb, available_kb)`.
///
/// Both are `Option` — a missing/errored field is honest "unknown".
/// `MemAvailable` (kernels ≥ 3.14) is preferred over `MemFree` because it
/// accounts for reclaimable caches.
pub fn parse_meminfo(content: &str) -> (Option<u64>, Option<u64>) {
    let mut total_kb = None;
    let mut avail_kb = None;
    for line in content.lines() {
        let mut it = line.split_whitespace();
        let key = it.next();
        let val = it.next().and_then(|v| v.parse::<u64>().ok());
        match (key, val) {
            (Some("MemTotal:"), Some(v)) => total_kb = Some(v),
            (Some("MemAvailable:"), Some(v)) => avail_kb = Some(v),
            _ => {}
        }
    }
    (total_kb, avail_kb)
}

/// A real `/proc`-backed sampler. Keep one instance and call
/// [`snapshot`](crate::SystemSampler::snapshot) on a ticker; the first read
/// establishes the CPU baseline, later reads report the window's busy%.
pub struct LinuxSystemSampler {
    name: &'static str,
    proc_root: PathBuf,
    /// Previous cumulative `(idle, total)` jiffies, or `NO_PREV` on both.
    prev: Mutex<(u64, u64)>,
}

impl LinuxSystemSampler {
    /// Sampler over a specific procfs root (tests pass a tempdir).
    pub fn new_with_root(proc_root: impl Into<PathBuf>) -> Self {
        Self {
            name: "linux-proc",
            proc_root: proc_root.into(),
            prev: Mutex::new((NO_PREV, NO_PREV)),
        }
    }

    /// Sampler over the real `/proc`.
    pub fn new() -> Self {
        Self::new_with_root(default_proc_root())
    }

    fn read_stat_idle_total(&self) -> Option<(u64, u64)> {
        let raw = std::fs::read_to_string(self.proc_root.join("stat")).ok()?;
        raw.lines().find_map(parse_cpu_line)
    }

    fn read_mem(&self) -> MemoryInfo {
        let raw = std::fs::read_to_string(self.proc_root.join("meminfo")).ok();
        let (total_kb, avail_kb) = raw.as_deref().map(parse_meminfo).unwrap_or((None, None));
        MemoryInfo {
            total_bytes: total_kb.map(|kb| kb.saturating_mul(1024)),
            available_bytes: avail_kb.map(|kb| kb.saturating_mul(1024)),
        }
    }
}

impl Default for LinuxSystemSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemSampler for LinuxSystemSampler {
    fn name(&self) -> &'static str {
        self.name
    }

    fn snapshot(&self) -> SystemLoad {
        let memory = self.read_mem();
        let (pidle, ptotal) = *lock(&self.prev);
        let busy_pct = match self.read_stat_idle_total() {
            Some((idle, total)) => {
                let pct = busy_pct_between(pidle, ptotal, idle, total);
                *lock(&self.prev) = (idle, total);
                pct
            }
            None => None,
        };
        SystemLoad {
            cpu: CpuSample { busy_pct },
            memory,
        }
    }
}

/// Lock a `Mutex`, recovering from poison instead of panicking.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &std::path::Path, rel: &str, content: &str) {
        let dir = root.join(
            std::path::Path::new(rel)
                .parent()
                .unwrap_or(std::path::Path::new("")),
        );
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(root.join(rel), content).unwrap();
    }

    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("amos-monitor-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn parses_the_aggregate_cpu_line() {
        let line = "cpu  100 20 30 40 5 6 7 8 0 0";
        // idle = idle(40) + iowait(5) = 45; total = 100+20+30+40+5+6+7+8 = 216.
        assert_eq!(parse_cpu_line(line), Some((45, 216)));
    }

    #[test]
    fn rejects_non_aggregate_or_short_lines() {
        assert_eq!(parse_cpu_line("cpu0 1 1 1 1 0 0 0 0"), None);
        assert_eq!(parse_cpu_line("garbage 1 2 3 4 5 6 7"), None);
        assert_eq!(parse_cpu_line("cpu 1 2 3"), None, "too few fields");
    }

    #[test]
    fn parses_meminfo() {
        let c = "MemTotal:        8000000 kB\nMemFree:         1000000 kB\nMemAvailable:    3000000 kB\n";
        assert_eq!(parse_meminfo(c), (Some(8_000_000), Some(3_000_000)));
    }

    #[test]
    fn meminfo_missing_fields_are_unknown() {
        assert_eq!(parse_meminfo("MemFree: 1000 kB\n"), (None, None));
    }

    #[test]
    fn reads_and_deltas_over_a_fixture_proc_root() {
        let root = fixture();
        write(&root, "stat", "cpu  0 0 0 100 0 0 0 0 0 0\n"); // t0: all idle, total=100
        write(
            &root,
            "meminfo",
            "MemTotal:  8000 kB\nMemAvailable: 2000 kB\n",
        );

        let s = LinuxSystemSampler::new_with_root(root.clone());
        let first = s.snapshot();
        assert_eq!(first.cpu.busy_pct, None, "first read = baseline");
        assert_eq!(first.memory.used_pct(), Some(75.0));

        // t1: +50 user (busy), idle unchanged at 100.
        write(&root, "stat", "cpu  50 0 0 100 0 0 0 0 0 0\n");
        let second = s.snapshot();
        // delta idle = 0, delta total = 50 -> busy 50/50 = 100%.
        assert_eq!(second.cpu.busy_pct, Some(100.0));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absent_proc_is_honest_unknown_not_a_panic() {
        let s = LinuxSystemSampler::new_with_root("/nonexistent-proc-root-xyz");
        let load = s.snapshot();
        assert_eq!(load.cpu.busy_pct, None);
        assert_eq!(load.memory.total_bytes, None);
    }
}
