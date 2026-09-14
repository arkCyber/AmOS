# amos-mail — email client core engine

A transport-agnostic mail engine: account/model types, a `MailProvider` seam and a
deterministic in-memory provider, so the same engine serves the terminal client today and a
real IMAP/SMTP backend behind a feature. Part of **[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `MailClient<P: MailProvider>`: list/read/send/delete expressed against the provider seam —
  the engine has no sockets, so every rule (folders, unread state, threading, address
  formatting) is testable offline.
- `model.rs`: `Address`-style parsing and the message/folder model, with the formatting rules
  the UI shows ("Ada <ada@example.com>").
- `MockMailProvider` is a real in-memory mailbox (not a stub that returns canned strings):
  you can send, and then read what you sent.
- `live` (feature) is the real IMAP/SMTP path; its tests run against a loopback relay, and
  credentials come from the caller's account — never from a repo file.

It is **not** a mail server, a spam filter or a calendar: it is a client engine.

## Layout

| file | what |
|---|---|
| `src/client.rs` | `Account`, `MailClient` |
| `src/model.rs` | addresses, messages, folders |
| `src/provider.rs` | `MailProvider` seam + `MockMailProvider` |
| `src/live.rs` | *(feature `live`)* the IMAP/SMTP backend |
| `src/error.rs` | `MailError`, `Result` |

## Build & test

```bash
cargo test -p amos-mail
cargo clippy -p amos-mail --all-targets -- -D warnings
cargo fmt -p amos-mail -- --check
```

## Examples

```bash
# A whole mailbox round trip on the in-memory provider: send, list, read, delete.
cargo run -p amos-mail --example mailbox_roundtrip
```

| example | shows |
|---|---|
| `mailbox_roundtrip` | the engine over `MockMailProvider`: an account, a sent message that appears in the sent folder, a received message, unread counts, an address parsed and rendered, and a delete that really removes it |

## Honest boundaries

- **The live backend is opt-in and needs a server** (feature `live` + credentials): the
  default build is offline and the mock is what tests and examples use.
- **No OAuth flow is implemented**: the live path takes credentials the caller already has.
- **HTML rendering is not done here**: the engine delivers text/structure; rendering (and its
  sanitisation) is a UI concern.
- **No background sync daemon**: fetching is an explicit call.

## Related

- [`crates/amos-mail-cli`](../amos-mail-cli/README.md) — the terminal front end over this engine.
