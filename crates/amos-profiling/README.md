# amos-profiling — inference performance & power profiling

Measures what the inference path actually costs: prompt-eval vs decode phase tracking,
tokens/second, time-to-first-token, per-token latency, and a real power model
(`BatterySample`: µA × mV) with window averaging — all through seams, so the numbers are
reproducible in tests. Part of **[Amos](../../README.md)**. Design record:
[`docs/profiling.md`](../../docs/profiling.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `ProfileTracker` records per-phase `Record`s (`Phase`) and derives the meters an operator
  asks for; `ProfileReport` renders them (`fmt_opt` prints an unmeasured field as `-`, not as
  `0`, so "unknown" and "zero" never look alike).
- `measure::time` / `time_and` wrap a closure and return its cost — the same primitive the
  daemon's decode loop uses.
- **Power is measured, not guessed**: `BatterySample` carries `µA × mV`, `mean_power_mw`
  averages over a window, and `energy_joules` integrates it. `MockPowerSource` makes the
  maths testable; `AndroidBatteryPowerSource` (feature `android`) is the device input.
- `safe_div` exists so a zero denominator produces a defined answer instead of a NaN that
  silently poisons a report.

It is **not** a profiler UI or a sampler daemon: it is the accounting layer, and it holds no
global state.

## Layout

| file | what |
|---|---|
| `src/tracker.rs` | `ProfileTracker`, `safe_div` |
| `src/types.rs` | `Phase`, `Record` |
| `src/measure.rs` | `time`, `time_and` |
| `src/power.rs` | `BatterySample`, `mean_power_mw`, `energy_joules`, `PowerSource`, `MockPowerSource` |
| `src/report.rs` | `ProfileReport`, `fmt_opt` |
| `src/android.rs` | *(feature `android`)* `AndroidBatteryPowerSource` |

## Build & test

```bash
cargo test -p amos-profiling
cargo check -p amos-profiling --features android
cargo clippy -p amos-profiling --all-targets -- -D warnings
```

## Examples

```bash
# Time a fake prompt-eval + decode loop and fold it into a report (offline, deterministic).
cargo run -p amos-profiling --example profile_fake_run
```

| example | shows |
|---|---|
| `profile_fake_run` | `time_and` around two phases, the tracker's tokens/second + TTFT + per-token latency, a mocked battery/power window folded with `mean_power_mw`, and a report where an unmeasured field prints as `-` |

## Honest boundaries

- **Numbers are only as real as the input**: on the host the power source is the mock (or
  nothing); the device battery is the only true wattage.
- **Wall-clock, not accelerator counters**: no GPU/NPU perf counters are read here.
- **No thermal claims**: temperature lives in `crates/amos-power`'s telemetry.
- `fmt_opt`'s `-` is deliberate: a missing measurement must not read as a good one.

## Related

- [`docs/profiling.md`](../../docs/profiling.md) — phases, meters and the power model.
- [`crates/amos-power`](../amos-power/README.md) — consumes these numbers to decide.
- [`crates/amos-monitor`](../amos-monitor/README.md) — folds them into system health.
