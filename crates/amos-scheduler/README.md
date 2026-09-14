# amos-scheduler — background tasks + wakeup alignment

Registers background work as `AlarmExact` or `Deferred` jobs with an `[earliest, latest]`
window, gates them on Doze/charging/maintenance windows, coalesces due work into batches and
computes the next wakeup — so an idle phone is not woken ten times a minute. Part of
**[Amos](../../README.md)**. Design record: [`docs/scheduler.md`](../../docs/scheduler.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `JobId`, `JobType` (`AlarmExact` vs `Deferred`), `PowerState`: a job says what it needs and
  what it tolerates, and the scheduler decides when that may happen.
- **Windows, not instants**: a deferred job has an earliest and a latest time, so the
  scheduler can *align* it with other work instead of waking the SoC for one job.
- **Coalescing**: due jobs are handed over in batches (`ScheduledJob`), which is what lets a
  caller do one wakeup turn for many tasks.
- `ExactAlarmClock` is the seam to the platform's exact-alarm facility — used only for jobs
  that declared `AlarmExact`, because an exact alarm is a promise to the user.
- `Scheduler` is pure over the clock it is given, so the whole policy is testable without
  sleeping.

It is **not** a thread pool or a work queue: it says *when* work may run; running it is the
caller's.

## Layout

| file | what |
|---|---|
| `src/spec.rs` | `JobId`, `JobType`, `PowerState` |
| `src/scheduler.rs` | `Scheduler`, `ScheduledJob`: registration, gating, coalescing, next wake |
| `src/exact.rs` | `ExactAlarmClock` seam |
| `src/error.rs` | `SchedulerError` |

## Build & test

```bash
cargo test -p amos-scheduler
cargo clippy -p amos-scheduler --all-targets -- -D warnings
cargo fmt -p amos-scheduler -- --check
```

## Examples

```bash
# Register jobs, advance a fake clock, watch coalescing and the next-wake calculation.
cargo run -p amos-scheduler --example doze_alignment
```

| example | shows |
|---|---|
| `doze_alignment` | deferred jobs with windows that get aligned into one due batch, an exact job taking the exact path, a Doze gate holding work back, and the computed next wakeup after each step |

## Honest boundaries

- **Pure by construction**: the scheduler never sleeps, never spawns and never reads a real
  clock — the caller passes time in.
- **Exact alarms are the platform's**: whether one fires on time is the OS's answer, and
  Android's exact-alarm permission can refuse it (the refusal is reported).
- **No persistence here**: which jobs survive a reboot is the caller's storage decision.
- **Coalescing trades latency for battery deliberately** — an aligned job may run later than
  its earliest time, which is why the window is explicit.

## Related

- [`docs/scheduler.md`](../../docs/scheduler.md) — job classes, gating and alignment rules.
- [`crates/amos-power`](../amos-power/README.md) — the energy policy that supplies `PowerState`.
- [`crates/amos-display`](../amos-display/README.md) — screen state as another gate input.
