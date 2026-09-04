//! Core profiling primitives shared across the crate: the two inference phases
//! and a single timing record.

use std::time::Duration;

/// The two measured phases of an LLM inference run. These are the standard knobs
/// for on-device model tuning: **prompt eval** (prefill — drives time-to-first
/// token) and **decode** (auto-regressive — drives tokens-per-second and the
/// per-token latency that a user actually feels).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Phase {
    /// Processing the whole prompt once (prefill). Throughput here is reported
    /// in prompt tokens/s and its wall time is the main component of TTFT.
    PromptEval,
    /// Generating output tokens one at a time (autoregressive decode).
    Decode,
}

impl Phase {
    /// Both phases, for iterating.
    pub const ALL: [Phase; 2] = [Phase::PromptEval, Phase::Decode];

    /// Stable key used in reports / a future wire bus.
    pub fn key(self) -> &'static str {
        match self {
            Phase::PromptEval => "prompt_eval",
            Phase::Decode => "decode",
        }
    }

    pub fn from_key(s: &str) -> Option<Phase> {
        match s {
            "prompt_eval" => Some(Phase::PromptEval),
            "decode" => Some(Phase::Decode),
            _ => None,
        }
    }
}

/// One measured stretch of inference: how many tokens were processed in `wall`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Record {
    pub phase: Phase,
    /// Tokens processed during this stretch (prompt tokens or generated tokens).
    pub tokens: u64,
    /// Wall-clock time the stretch took.
    pub wall: Duration,
}

impl Record {
    pub fn new(phase: Phase, tokens: u64, wall: Duration) -> Self {
        Self {
            phase,
            tokens,
            wall,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_keys_round_trip() {
        for p in Phase::ALL {
            assert_eq!(Phase::from_key(p.key()), Some(p));
        }
        assert_eq!(Phase::from_key("embedding"), None);
    }

    #[test]
    fn record_carries_phase_tokens_and_wall() {
        let r = Record::new(Phase::Decode, 12, Duration::from_millis(300));
        assert_eq!(r.phase, Phase::Decode);
        assert_eq!(r.tokens, 12);
        assert_eq!(r.wall, Duration::from_millis(300));
    }
}
