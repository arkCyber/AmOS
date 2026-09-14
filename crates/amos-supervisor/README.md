# amos-supervisor — process supervisor (spawn, monitor, hot-restart)

Runs the OS's CLI daemons as supervised children: spawn, watch, restart on failure with a
backoff, hot-restart on `SIGUSR1`, and stop gracefully — so a crashed daemon does not take the
device's backend with it. Part of **[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `DaemonSpec` (name, program, args, env, restart policy) — a spec is data, so the same
  supervisor can run the AI daemon, the translate daemon or a test child.
- `Supervisor`: `start` / `stop` / `restart` / `restart_all`, with a bounded restart backoff
  so a permanently-broken binary cannot spin the CPU, and a report of what it did.
- **Hot restart** is a signal, not a kill: a child that handles `SIGUSR1` reloads while
  keeping its state file — the pattern `scripts/supervise-backends.sh` uses.
- Child output is captured so a failure is explainable (a supervisor that hides a child's
  stderr is not a supervisor you can debug).

It is **not** systemd/init: it is a user-space supervisor for the OS's own daemons, with no
`cgroup`/`unit` integration (see `docs/bottom-layer-os-audit.md` for what that implies).

## Layout

| file | what |
|---|---|
| `src/lib.rs` | `DaemonSpec`, `Supervisor` (start/stop/restart/restart_all), child output capture |

## Build & test

```bash
cargo test -p amos-supervisor
cargo clippy -p amos-supervisor --all-targets -- -D warnings
bash scripts/supervisor-smoke.sh        # the scripted end-to-end path
```

## Examples

```bash
# Supervise a real child: a shell that exits, one that fails, and a graceful stop.
cargo run -p amos-supervisor --example supervise_child
```

| example | shows |
|---|---|
| `supervise_child` | `DaemonSpec` for a short-lived process: the start, the exit it observes, a restart of a child that fails immediately (with the backoff), a hot-restart signal, and a graceful stop — all against real processes |

## Honest boundaries

- **Restart loops are bounded**: the backoff caps what a broken daemon can burn, and the
  supervisor reports the loop instead of hiding it.
- **No privilege management**: it does not drop capabilities or bind to a privileged port.
- **Not a cgroup**: memory/CPU limits are the governor's business, not this crate's.
- **The child's exit code is data**: it is reported, never reinterpreted as success.

## Related

- [`scripts/supervise-backends.sh`](../../scripts/supervise-backends.sh) — the deployed use.
- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — where the supervisor sits.
- [`crates/amos-timesync`](../amos-timesync/README.md) — the sibling daemon it often supervises.
