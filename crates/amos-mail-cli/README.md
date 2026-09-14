# amos-mail-cli — email from a terminal

Drives an **[`crates/amos-mail`](../amos-mail/README.md)** `MailClient` — by default over the
offline in-memory provider, so `list` / `read` / `send` / `delete` all work with no server and
no credentials. Part of **[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

```text
amos-mail-cli demo                      # a scripted mailbox (root README's live smoke)
amos-mail-cli list [--folder inbox]     # folders + unread counts
amos-mail-cli read <id>                 # one message, rendered as text
amos-mail-cli send --to a@b --subject S --body B
amos-mail-cli delete <id>
```

- `dispatch` maps a parsed `Op` onto the engine, so the CLI and any other front end exercise
  the same code paths.
- `demo_lines()` produces a deterministic transcript (`docs`-friendly) without network.
- `--store <path>` points the CLI at a persisted mailbox file, so a demo run can be repeated
  and inspected.

It is **not** a mail server or a sync client: it drives the engine, which drives a provider.

## Layout

| file | what |
|---|---|
| `src/main.rs` | the binary: args → `run` → exit code |
| `src/lib.rs` | `parse_args`, `Op`, `default_account`, `store_path`, `dispatch`, `demo_lines`, `run` |
| `tests/` | process-level smoke |

## Build & test

```bash
cargo test -p amos-mail-cli
cargo test -p amos-mail-cli --features amos-mail-cli/live --lib   # live IMAP/SMTP (loopback)
cargo clippy -p amos-mail-cli --all-targets --features amos-mail-cli/live -- -D warnings
```

## Examples

```bash
# The deterministic mailbox transcript, from a program.
cargo run -p amos-mail-cli --example demo_transcript
```

| example | shows |
|---|---|
| `demo_transcript` | `demo_lines()` printed exactly as the CLI would: folders, an unread message, a send and a read-back — proving the engine is drivable without a shell or a server |

## Honest boundaries

- **The default provider is in-memory**: messages vanish when the process ends unless
  `--store` is used, and the CLI says which provider it used.
- **The live backend needs a server and credentials** (feature `live`); it is off by default.
- **No HTML rendering** and no attachment decoding: the engine's text model is what is shown.
- **No background sync**: every command is one explicit action.

## Related

- [`crates/amos-mail`](../amos-mail/README.md) — the engine this drives.
