//! A human/JSON-ready [`ProfileReport`] snapshot computed from a
//! [`ProfileTracker`] and (optionally) an average-power figure.
//!
//! Keep it a plain, owned value: it is the thing a daemon can log, surface in
//! `monitoring`/status, or hand to a future wire exporter without holding a lock
//! on the live tracker. Rendering is a `Display` with one `key: value` line per
//! metric, `n/a` where there is no data yet (never `NaN`/`inf`).

use std::fmt;

use crate::power::energy_joules;
use crate::tracker::ProfileTracker;

/// A point-in-time snapshot of inference performance + energy for one run window.
#[derive(Clone, Debug)]
pub struct ProfileReport {
    pub prompt_tokens: u64,
    pub decode_tokens: u64,
    pub total_tokens: u64,
    pub prompt_records: u64,
    pub decode_records: u64,
    /// Prompt-eval (prefill) throughput, tokens/s.
    pub prompt_tokens_per_s: Option<f64>,
    /// Autoregressive decode throughput, tokens/s.
    pub decode_tokens_per_s: Option<f64>,
    /// Mean per-token decode latency, ms.
    pub decode_ms_per_token: Option<f64>,
    /// Time to first token, ms (≈ prefill wall time).
    pub ttft_ms: f64,
    /// Total wall time of the window, ms.
    pub total_wall_ms: f64,
    /// Average board power over the window, mW (when a power source was attached).
    pub avg_power_mw: Option<f64>,
    /// Estimated energy for the whole window, joules.
    pub est_energy_j: Option<f64>,
}

impl ProfileReport {
    /// Compute a snapshot from a tracker. Pass `avg_power_mw` when a
    /// [`PowerSource`](crate::power::PowerSource) reading is available.
    pub fn compute(tracker: &ProfileTracker, avg_power_mw: Option<f64>) -> Self {
        let est_energy_j = avg_power_mw.map(|mw| energy_joules(mw, tracker.total_wall()));
        Self {
            prompt_tokens: tracker.prompt_tokens(),
            decode_tokens: tracker.decode_tokens(),
            total_tokens: tracker.total_tokens(),
            prompt_records: tracker.prompt_records(),
            decode_records: tracker.decode_records(),
            prompt_tokens_per_s: tracker.prompt_tokens_per_second(),
            decode_tokens_per_s: tracker.decode_tokens_per_second(),
            decode_ms_per_token: tracker.decode_ms_per_token(),
            ttft_ms: tracker.ttft_ms(),
            total_wall_ms: tracker.total_wall().as_secs_f64() * 1000.0,
            avg_power_mw,
            est_energy_j,
        }
    }
}

impl fmt::Display for ProfileReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut lines: Vec<String> = vec![
            format!("prompt_tokens: {}", self.prompt_tokens),
            format!("decode_tokens: {}", self.decode_tokens),
            format!("total_tokens: {}", self.total_tokens),
            format!("prompt_records: {}", self.prompt_records),
            format!("decode_records: {}", self.decode_records),
            format!("prompt_tokens_per_s: {}", fmt_opt(self.prompt_tokens_per_s)),
            format!("decode_tokens_per_s: {}", fmt_opt(self.decode_tokens_per_s)),
            format!("decode_ms_per_token: {}", fmt_opt(self.decode_ms_per_token)),
            format!("ttft_ms: {:.2}", self.ttft_ms),
            format!("total_wall_ms: {:.2}", self.total_wall_ms),
            format!("avg_power_mw: {}", fmt_opt(self.avg_power_mw)),
            format!("est_energy_j: {}", fmt_opt(self.est_energy_j)),
        ];
        lines.sort_unstable();
        for line in lines {
            writeln!(f, "{line}")?;
        }
        Ok(())
    }
}

/// Format an optional metric with two decimals, `n/a` when absent.
pub fn fmt_opt(v: Option<f64>) -> String {
    match v {
        Some(x) if x.is_finite() => format!("{x:.2}"),
        Some(_) => "n/a".to_string(),
        None => "n/a".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Phase;
    use std::time::Duration;

    #[test]
    fn report_computes_from_tracker_and_power() {
        let mut t = ProfileTracker::new();
        t.record(Phase::PromptEval, 512, Duration::from_millis(150));
        t.record(Phase::Decode, 100, Duration::from_secs(2));
        let r = ProfileReport::compute(&t, Some(4000.0));
        assert_eq!(r.total_tokens, 612);
        assert!((r.decode_tokens_per_s.unwrap() - 50.0).abs() < 1e-9);
        // 4 W × 2.15 s = 8.6 J.
        assert!((r.est_energy_j.unwrap() - 8.6).abs() < 1e-9);
        assert_eq!(r.prompt_records, 1);
    }

    #[test]
    fn report_without_power_has_no_energy() {
        let mut t = ProfileTracker::new();
        t.record(Phase::Decode, 4, Duration::from_millis(100));
        let r = ProfileReport::compute(&t, None);
        assert_eq!(r.avg_power_mw, None);
        assert_eq!(r.est_energy_j, None);
    }

    #[test]
    fn empty_report_displays_n_a_not_nan() {
        let r = ProfileReport::compute(&ProfileTracker::new(), None);
        let s = r.to_string();
        assert!(s.contains("n/a"), "{s}");
        assert!(!s.contains("NaN"), "{s}");
        assert!(!s.contains("inf"), "{s}");
    }

    #[test]
    fn display_is_stable_key_value_lines() {
        let mut t = ProfileTracker::new();
        t.record(Phase::Decode, 100, Duration::from_secs(2));
        let s = ProfileReport::compute(&t, Some(4000.0)).to_string();
        assert!(s.contains("decode_tokens_per_s: 50.00"), "{s}");
        assert!(s.contains("est_energy_j:"), "{s}");
        assert_eq!(s.lines().count(), 12);
    }
}
