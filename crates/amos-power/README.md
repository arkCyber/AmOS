# amos-power — battery/thermal/foreground-aware energy governor

Folds battery state-of-charge, charger state, die temperature, live board power and
foreground/background activity into one `Decision` (`SensorMode` + whether to cap inference
or throttle background work) — then applies it. Part of **[Amos](../../README.md)**. Design
record: [`docs/power-policy.md`](../../docs/power-policy.md) · bring-up:
[`docs/dvfs-power-bringup.md`](../../docs/dvfs-power-bringup.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `decide(telemetry, usage, policy) -> Decision` is a **pure function** of measured inputs
  (`Telemetry`, `BatteryState`, `Usage`, `Policy`), and every decision carries a `Reason` —
  so "why is inference capped right now" is always answerable.
- `EnergyGovernor` is the runtime half: it ticks, decides and applies through the sensor
  manager, instead of each subsystem inventing its own threshold.
- **CPU/NPU frequency** (`freq.rs`: `FreqPlan`, `Discovery`, `LinuxFreqGovernor`,
  `OverlapPolicy`) plans a DVFS state that protects the little cluster — the part that keeps
  the UI responsive — while the big cores serve inference.
- `PowerSource`/`PowerSource` telemetry comes from **`crates/amos-profiling`** (`µA × mV`),
  so the governor reacts to measured watts, not to a battery percentage alone.
- `AndroidBatteryTelemetry` (feature `android`) is the device input; a missing reading is
  reported as missing, never as "cool and full".

It is **not** a thermal daemon or a kernel governor: it writes the operating points the
kernel exposes (and only those it is permitted to write).

## Layout

| file | what |
|---|---|
| `src/policy.rs` | `decide`, `Policy`, `Decision`, `Reason` — the pure fold |
| `src/types.rs` | `Telemetry`, `BatteryState`, `Usage` |
| `src/governor.rs` | `EnergyGovernor` — tick → decide → apply |
| `src/freq.rs` | `FreqPlan`, `Discovery`, `Overlap`, `OverlapPolicy` |
| `src/linux.rs` | `LinuxFreqGovernor`, `default_cpufreq_root` |
| `src/android.rs` | *(feature `android`)* `AndroidBatteryTelemetry` |

## Build & test

```bash
cargo test -p amos-power
cargo run -p amos-power --example governor_freq       # decide + plan against mocks
cargo run -p amos-power --example ticker              # the governor loop, host-safe
cargo run -p amos-power --example live_governor       # real machine telemetry (read-only)
cargo clippy -p amos-power --all-targets -- -D warnings
```

## Examples

| example | shows |
|---|---|
| `governor_freq` | the pure `decide` + `FreqPlan` for a battery/thermal scenario matrix (each row printing its reasons) |
| `ticker` | the `EnergyGovernor` ticking with mock telemetry: the decisions it takes over time and what it applied |
| `live_governor` | the same governor fed by **this machine's** real telemetry, read-only (no writes without permission) |

```bash
cargo run -p amos-power --example governor_freq
cargo run -p amos-power --example ticker
cargo run -p amos-power --example live_governor
```

## Honest boundaries

- **Writing frequencies needs privileges**: `LinuxFreqGovernor` reports the paths it may
  write; without them it plans and says it could not apply.
- **The device is the only place the thermal model is proven**: host runs use mocks and the
  machine's own sensors.
- **No overclocking, no undervolting**: the governor selects among the operating points the
  kernel already publishes.
- **Battery percentages are not power**: the policy prefers measured watts when available and
  says which input it used.

## Related

- [`docs/power-policy.md`](../../docs/power-policy.md) — inputs, decision table and reasons.
- [`docs/dvfs-power-bringup.md`](../../docs/dvfs-power-bringup.md) — the board bring-up path.
- [`crates/amos-profiling`](../amos-profiling/README.md) — where the power numbers come from.
- [`crates/amos-sensor`](../amos-sensor/README.md) — the sensor manager the governor drives.
