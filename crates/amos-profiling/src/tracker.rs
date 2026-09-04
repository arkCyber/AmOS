//! A running, deterministic [`ProfileTracker`] that turns a stream of measured
//! phases into the throughput/latency numbers an on-device model team needs.
//!
//! The tracker is intentionally dumb and lossless about the *sums* (it also keeps
//! a per-phase record count so "average tokens per call" is derivable). All rate /
//! latency arithmetic is a pure function of those sums and is guarded against
//! division by zero (an empty decode yields `None`, never `NaN`/inf).

use std::time::Duration;

use crate::types::Phase;

/// A no-op division-by-zero guard used by every rate helper. Returns `None`
/// instead of producing `NaN`/`inf`, so a report can say "no data yet" cleanly.
pub fn safe_div(num: f64, den: f64) -> Option<f64> {
    if den > 0.0 && den.is_finite() {
        Some(num / den)
    } else {
        None
    }
}

/// Accumulates measured inference phases and exposes derived throughput metrics.
#[derive(Clone, Debug, Default)]
pub struct ProfileTracker {
    prompt_tokens: u64,
    decode_tokens: u64,
    prompt_wall: Duration,
    decode_wall: Duration,
    prompt_records: u64,
    decode_records: u64,
}

impl ProfileTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one measured stretch into the totals.
    pub fn record(&mut self, phase: Phase, tokens: u64, wall: Duration) {
        match phase {
            Phase::PromptEval => {
                self.prompt_tokens += tokens;
                self.prompt_wall += wall;
                self.prompt_records += 1;
            }
            Phase::Decode => {
                self.decode_tokens += tokens;
                self.decode_wall += wall;
                self.decode_records += 1;
            }
        }
    }

    /// Fold a [`Record`](crate::types::Record) into the totals.
    pub fn record_rec(&mut self, r: crate::types::Record) {
        self.record(r.phase, r.tokens, r.wall);
    }

    pub fn prompt_tokens(&self) -> u64 {
        self.prompt_tokens
    }

    pub fn decode_tokens(&self) -> u64 {
        self.decode_tokens
    }

    pub fn total_tokens(&self) -> u64 {
        self.prompt_tokens + self.decode_tokens
    }

    pub fn prompt_wall(&self) -> Duration {
        self.prompt_wall
    }

    pub fn decode_wall(&self) -> Duration {
        self.decode_wall
    }

    pub fn total_wall(&self) -> Duration {
        self.prompt_wall + self.decode_wall
    }

    /// How many prompt-eval stretches were folded in (for averages).
    pub fn prompt_records(&self) -> u64 {
        self.prompt_records
    }

    pub fn decode_records(&self) -> u64 {
        self.decode_records
    }

    /// Prompt-eval (prefill) throughput in prompt tokens per second.
    pub fn prompt_tokens_per_second(&self) -> Option<f64> {
        safe_div(self.prompt_tokens as f64, self.prompt_wall.as_secs_f64())
    }

    /// Decode throughput in generated tokens per second — the headline on-device
    /// number users feel.
    pub fn decode_tokens_per_second(&self) -> Option<f64> {
        safe_div(self.decode_tokens as f64, self.decode_wall.as_secs_f64())
    }

    /// Mean per-token decode latency in milliseconds. The inverse of decode TPS,
    /// often easier to read against a 60 Hz UI budget.
    pub fn decode_ms_per_token(&self) -> Option<f64> {
        let tps = self.decode_tokens_per_second()?;
        Some(1000.0 / tps)
    }

    /// Time-to-first-token estimate (ms): dominated by the prompt-eval wall of
    /// the most recent stretch. Reported as the prefill wall time.
    pub fn ttft_ms(&self) -> f64 {
        self.prompt_wall.as_secs_f64() * 1000.0
    }

    /// Merge another tracker's sums into this one.
    pub fn merge(&mut self, other: &ProfileTracker) {
        self.prompt_tokens += other.prompt_tokens;
        self.decode_tokens += other.decode_tokens;
        self.prompt_wall += other.prompt_wall;
        self.decode_wall += other.decode_wall;
        self.prompt_records += other.prompt_records;
        self.decode_records += other.decode_records;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_tracker_has_no_rates() {
        let t = ProfileTracker::new();
        assert_eq!(t.total_tokens(), 0);
        assert_eq!(t.prompt_tokens_per_second(), None);
        assert_eq!(t.decode_tokens_per_second(), None);
        assert_eq!(t.decode_ms_per_token(), None);
        assert!(t.total_wall().is_zero());
    }

    #[test]
    fn decode_throughput_and_ms_per_token() {
        let mut t = ProfileTracker::new();
        // 100 decode tokens over 2 s → 50 tps, 20 ms/token.
        t.record(Phase::PromptEval, 512, Duration::from_millis(150));
        t.record(Phase::Decode, 100, Duration::from_secs(2));
        assert_eq!(t.prompt_tokens(), 512);
        assert_eq!(t.decode_tokens(), 100);
        assert_eq!(t.total_tokens(), 612);
        let tps = t.decode_tokens_per_second().unwrap();
        assert!((tps - 50.0).abs() < 1e-9, "{tps}");
        assert!((t.decode_ms_per_token().unwrap() - 20.0).abs() < 1e-9);
        // TTFT is the prefill wall (150 ms).
        assert!((t.ttft_ms() - 150.0).abs() < 1e-9);
    }

    #[test]
    fn prompt_tokens_per_second() {
        let mut t = ProfileTracker::new();
        // 1024 prompt tokens in 256 ms → 4000 tps.
        t.record(Phase::PromptEval, 1024, Duration::from_millis(256));
        let tps = t.prompt_tokens_per_second().unwrap();
        assert!((tps - 4000.0).abs() < 1e-6, "{tps}");
    }

    #[test]
    fn records_and_merge_accumulate() {
        let mut a = ProfileTracker::new();
        a.record_rec(crate::types::Record::new(
            Phase::Decode,
            5,
            Duration::from_millis(100),
        ));
        let mut b = ProfileTracker::new();
        b.record(Phase::Decode, 5, Duration::from_millis(100));
        a.merge(&b);
        assert_eq!(a.decode_tokens(), 10);
        assert_eq!(a.decode_records(), 2);
        assert!((a.decode_tokens_per_second().unwrap() - 50.0).abs() < 1e-9);
    }

    #[test]
    fn safe_div_guards_zero() {
        assert_eq!(safe_div(1.0, 0.0), None);
        assert_eq!(safe_div(1.0, -0.0), None);
        assert_eq!(safe_div(2.0, 4.0), Some(0.5));
        assert_eq!(safe_div(2.0, f64::INFINITY), None);
    }
}
