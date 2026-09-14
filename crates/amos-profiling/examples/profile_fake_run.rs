//! `profile_fake_run` — time a fake prompt-eval + decode loop and fold it into a report.
//!
//! The phases are artificial (a busy loop instead of a model) but everything around them is
//! the shipping accounting: `time_and` measures, the tracker derives tokens/second, TTFT and
//! per-token latency, and the power window turns battery samples (µA × mV) into mean
//! milliwatts and joules. A missing measurement prints as `-`, never as `0`.
//!
//! Usage:
//! ```text
//! cargo run -p amos-profiling --example profile_fake_run
//! ```

use std::time::Duration;

use amos_profiling::power::{BatterySample, MockPowerSource};
use amos_profiling::report::fmt_opt;
use amos_profiling::tracker::ProfileTracker;
use amos_profiling::types::Phase;
use amos_profiling::{energy_joules, mean_power_mw, time_and, PowerSource, ProfileReport};

fn main() {
    let mut tracker = ProfileTracker::new();

    // The "model": a prompt pass over 128 tokens, then 16 decode steps of 16 tokens. The busy
    // work is irrelevant — what matters is that the timing comes from the same `time_and` the
    // daemon's wrapper uses.
    let wall = time_and(
        || {
            // ~1 ms of "prefill" work — enough that the derived rate is a plausible number
            // instead of an artefact of an optimised busy loop.
            std::thread::sleep(Duration::from_millis(1));
            1u64
        },
        |sum, wall| {
            let _ = sum;
            wall
        },
    );
    tracker.record(Phase::PromptEval, 128, wall);

    for _ in 0..16 {
        let (_, step) = time_and(
            || {
                std::thread::sleep(Duration::from_micros(200));
                16u64
            },
            |s, wall| (s, wall),
        );
        tracker.record(Phase::Decode, 16, step);
    }

    println!(
        "phases: prompt tokens={} wall={}ms, decode tokens={} wall={}ms (records: {} + {})",
        tracker.prompt_tokens(),
        tracker.prompt_wall().as_millis(),
        tracker.decode_tokens(),
        tracker.decode_wall().as_millis(),
        tracker.prompt_records(),
        tracker.decode_records()
    );
    println!(
        "derived: prompt tok/s={} decode tok/s={} ms/token={} ttft={}ms",
        fmt_opt(tracker.prompt_tokens_per_second()),
        fmt_opt(tracker.decode_tokens_per_second()),
        fmt_opt(tracker.decode_ms_per_token()),
        fmt_opt(Some(tracker.ttft_ms()))
    );

    // Power: a mocked battery at a steady 4200 mV / 350 mA, averaged over a window.
    let source = MockPowerSource::new(350.0);
    println!("mock power: {} mW", source.average_power_mw());
    let samples = [
        BatterySample::new(350_000, 4200),
        BatterySample::new(362_000, 4180),
        BatterySample::new(348_000, 4190),
    ];
    let mean = mean_power_mw(&samples);
    println!(
        "battery window: {} sample(s) -> mean {} mW",
        samples.len(),
        fmt_opt(mean)
    );
    let joules = energy_joules(mean.unwrap_or(0.0), tracker.total_wall());
    println!(
        "energy over {}ms: {:.3} J",
        tracker.total_wall().as_millis(),
        joules
    );

    // The report is the document an operator reads: unmeasured fields print as `-`.
    let report = ProfileReport::compute_sampled(&tracker, &samples);
    println!("\n{report}");
    let bare = ProfileReport::compute(&ProfileTracker::new(), None);
    println!("\nan empty tracker (no numbers invented):\n{bare}");
    let _ = Duration::from_secs(0);
}
