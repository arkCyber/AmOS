# amos-timesync-cli — query and sync the calibrated clock

Reads and drives **[`crates/amos-timesync`](../amos-timesync/README.md)**'s `SyncedClock`
through its shared state file: print the current calibrated time, show whether the clock is
calibrated (and how old that calibration is), or perform a sync against a time source. Part
of **[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

```text
amos-timesync-cli now            # the calibrated wall clock (with its trust state)
amos-timesync-cli status         # calibrated? offset? age of the last known-good value?
amos-timesync-cli sync           # one sync against the configured time source
amos-timesync-cli sync --server <host>
```

- `render(&SyncedClock)` is the one formatter, so `now`/`status` read the same way and a script
  can parse them.
- The state file path is resolved by `resolve_state` (`--state` / `AMOS_*` / default), which is
  the same file the daemon writes — so the CLI shows the daemon's clock, not a private one.
- A clock that never calibrated reports that, and an unreachable time source degrades the
  trust state instead of failing silently.

It is **not** a time daemon: it queries and triggers; the daemon keeps the clock.

## Layout

| file | what |
|---|---|
| `src/main.rs` | the binary: args → `run` → exit code |
| `src/lib.rs` | `resolve_state`, `parse_from`/`parse_args`, `render`, `run` |
| `tests/` | process-level smoke |

## Build & test

```bash
cargo test -p amos-timesync-cli
cargo run -p amos-timesync-cli -- status
cargo clippy -p amos-timesync-cli --all-targets -- -D warnings
```

## Examples

```bash
# The library surface offline: resolve the state path, render an uncalibrated clock.
cargo run -p amos-timesync-cli --example embed_status
```

| example | shows |
|---|---|
| `embed_status` | `parse_from` + `resolve_state` + `render` used from a program: which state file it reads, and exactly how an uncalibrated/synced clock is rendered — without touching the network |

## Honest boundaries

- **`sync` needs a reachable time source** (and the `ntp` path in the library); without it the
  command reports the failure and the clock stays uncalibrated.
- **The CLI does not keep time**: it reads/writes the shared state the daemon owns, so two
  callers cannot disagree about the clock.
- **Accuracy is the network's**, and the status says whether the value is a measurement or a
  last-known-good estimate.

## Related

- [`crates/amos-timesync`](../amos-timesync/README.md) — the clock and its timekeeper.
