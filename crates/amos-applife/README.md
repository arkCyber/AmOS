# amos-applife — app/process lifecycle domain core

The state machine that answers "what is this app doing right now, and what may the OS do to
it": foreground, visible, foreground-service, background, cached (tombstone) and stopped —
with an LRU order and memory-pressure reclaim (the LMK proxy). Pure, deterministic, no I/O.
Part of **[Amos](../../README.md)**. Design record: [`docs/app-lifecycle.md`](../../docs/app-lifecycle.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `AppState` has six states, each with a **stable key** for wire/UI/store use: an app the
  user is touching (`Foreground`), one still visible in a split (`Visible`), a
  user-perceptible service (`ForegroundService`), running-but-invisible (`Background`), a
  frozen tombstone (`Cached`) and `Stopped`.
- `AppLifecycle` folds transitions into records (`ProcessRecord`) and keeps the **LRU
  order** the reclaim path needs, so "evict the least recently used cached app" is a
  lookup, not a guess.
- Memory-pressure reclaim ranks candidates by state (`reclaim_rank`) and returns a plan —
  the caller decides whether to execute it, which keeps the decision testable offline.
- The crate is **pure**: no clocks, no syscalls, no files. `now` is passed in (the caller
  owns time), so every rule is reproducible in a unit test.

It is **not** a supervisor: it never kills a process itself. `crates/amos-supervisor` owns
process control, and the daemon's LMK path applies what this crate decides.

## Layout

| file | what |
|---|---|
| `src/spec.rs` | `AppId`, `AppState` (+ `key()`), the ordering rules |
| `src/manager.rs` | `AppLifecycle`, `ProcessRecord`: transitions, LRU, reclaim plan |
| `src/error.rs` | `LifecycleError` / `Result` |

## Build & test

```bash
cargo test -p amos-applife
cargo clippy -p amos-applife --all-targets -- -D warnings
cargo fmt -p amos-applife -- --check
```

## Examples

```bash
# Walk one app through the real states and reclaim it under memory pressure.
cargo run -p amos-applife --example lifecycle_walk
```

| example | shows |
|---|---|
| `lifecycle_walk` | launch → visible → background → cached, the LRU order each step produces, and the ranked reclaim plan under `Critical` pressure |

## Honest boundaries

- **No I/O, no clocks**: `AppLifecycle` cannot observe anything by itself. A caller that
  never reports a transition gets a table that never changes — by design.
- **The tombstone is a model, not a save**: `Cached` records *that* state was retained; the
  actual snapshot/restore of an app is the host's job.
- Reclaim returns a **plan**; executing it (and accounting for what was freed) belongs to
  the caller, which is where real device numbers come from.

## Related

- [`docs/app-lifecycle.md`](../../docs/app-lifecycle.md) — the state table, thresholds and
  the LMK-proxy contract.
- [`crates/amos-android`](../amos-android/README.md) — the container side (`lmk.rs`,
  `activity_observer.rs`) that feeds activity state in.
- [`crates/amos-monitor`](../amos-monitor/README.md) — folds these process counts into one
  system-health verdict.
