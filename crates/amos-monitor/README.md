# amos-monitor — system working-status (health) domain core

Folds load, battery, power and process counts into **one honest** `SystemHealth`: a verdict
with its reasons, where an unmeasured input stays unmeasured instead of being assumed
healthy. Part of **[Amos](../../README.md)**. Design record:
[`docs/system-monitor.md`](../../docs/system-monitor.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `SystemSampler` is the seam: `LinuxSystemSampler` reads `/proc` on the host/board,
  `AndroidSystemSampler` (feature `android`) is the device path, and `MockSystemSampler`
  makes every rule testable offline.
- `SystemMonitor` aggregates one `SystemLoad` (`CpuSample`, `MemoryInfo`), the battery
  (`BatteryStatus`), live power (from **`crates/amos-profiling`**) and the process counts
  (`ProcessSummary`) into a `SystemHealth`.
- **Missing evidence is not health**: an input that could not be sampled marks the affected
  area unknown, so a dashboard can say "not measured" rather than a fabricated green.
- `process_summary` / `process_summary_from_counts` are pure, so the process accounting is
  testable without a live system.

It is **not** a metrics exporter: there is no Prometheus/OTLP surface and no history buffer —
one snapshot, folded once.

## Layout

| file | what |
|---|---|
| `src/spec.rs` | `SystemLoad`, `CpuSample`, `MemoryInfo`, `BatteryStatus`, `ProcessSummary`, `SystemHealth` |
| `src/sampler.rs` | `SystemSampler` seam + `MockSystemSampler` |
| `src/linux.rs` | `LinuxSystemSampler` (real `/proc`), `default_cpufreq_root`-style discovery |
| `src/android.rs` | *(feature `android`)* `AndroidSystemSampler` |
| `src/monitor.rs` | `SystemMonitor`, `process_summary`, `process_summary_from_counts` |

## Build & test

```bash
cargo test -p amos-monitor
cargo run -p amos-monitor --example sample_health      # real /proc snapshot
cargo clippy -p amos-monitor --all-targets -- -D warnings
```

## Examples

```bash
# One real snapshot on this machine: CPU load, memory, battery/power, process counts.
cargo run -p amos-monitor --example sample_health
```

| example | shows |
|---|---|
| `sample_health` | the Linux sampler reading the real `/proc`, the folded `SystemHealth` with its reasons, and what an unsampled input looks like (so "unknown" is never confused with "fine") |

## Honest boundaries

- **`/proc` is the only truth here**: fields a kernel does not expose stay unknown.
- **Not a scheduler**: the monitor observes; `crates/amos-scheduler` and the governor decide.
- **Battery/power come from other crates** (`amos-profiling`), so this crate's numbers are
  only as good as those seams — and each one says whether it measured.

## Related

- [`docs/system-monitor.md`](../../docs/system-monitor.md) — inputs, folding rules and the
  dock-verification notes.
- [`crates/amos-profiling`](../amos-profiling/README.md) — power/energy measurement.
- [`crates/amos-applife`](../amos-applife/README.md) — the process states counted here.
