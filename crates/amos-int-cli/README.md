# amos-int-cli — text simultaneous interpretation from a terminal

Drives an **[`crates/amos-int`](../amos-int/README.md)** session over a gRPC pipeline to the
translate daemon: text in on stdin, translations out — the terminal twin of the 同传 app.
Part of **[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- One line of input becomes one interpretation: the CLI opens a session, pushes the line, and
  prints the streaming translation (`format_output` decides what a line looks like).
- `--socket` / `AMOS_*` resolution is `resolve_socket`, the same helper shape the other CLIs
  use, so pointing it at a daemon is one flag.
- The session state and event handling come from the library (`exec_line`, `run`), not from
  ad-hoc code in the binary — the CLI is a thin front end by construction.

It is **not** a translator itself: the model lives behind the daemon.

## Layout

| file | what |
|---|---|
| `src/main.rs` | the binary: args → `run` → exit code |
| `src/lib.rs` | `resolve_socket`, `parse_args`/`parse_from`, `format_output`, `exec_line`, `run` |
| `tests/` | process-level smoke |

## Build & test

```bash
cargo test -p amos-int-cli
cargo run -p amos-int-cli -- --help
cargo clippy -p amos-int-cli --all-targets -- -D warnings
```

## Examples

```bash
# The library surface with no daemon: parse a command line, resolve the socket, render output.
cargo run -p amos-int-cli --example embed_session
```

| example | shows |
|---|---|
| `embed_session` | `parse_from` + `resolve_socket` + `format_output` used from a program: what a session would connect to, and how one interpretation is rendered — no daemon required |

## Honest boundaries

- **A real run needs the translate daemon** (plus a model for meaningful output); the example
  deliberately shows the offline part instead of faking a translation.
- **Text only**: the voice path (mic → ASR → session) is not wired into this CLI.
- **One pair at a time**, like the session it drives.
- **The daemon's degraded state is surfaced**, not hidden: a mock-provider daemon says so.

## Related

- [`crates/amos-int`](../amos-int/README.md) — the session engine.
- [`crates/amos-translate`](../amos-translate/README.md) — the daemon it talks to.
- [`docs/interpretation-architecture.md`](../../docs/interpretation-architecture.md)
