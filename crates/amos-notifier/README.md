# amos-notifier — alert dispatcher (P0 / P1 / P2)

Suppression windows, per-channel rate limits and three pure-`std` transports (webhook /
SMTP / stderr) behind one `Channel` trait — so an alert can never take the process down.
Part of **[Amos](../../README.md)**. Runbook:
[`docs/devops.md`](../../docs/devops.md) §3.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `alert.rs`: `Alert` + `Severity` (P0/P1/P2) and the fingerprint the window keys on.
- `channel.rs`: the `Channel` trait, `SendOutcome`, plus `Instrumented` and the in-memory
  `Recorder` that tests use.
- `dispatcher.rs`: fan-out, suppression, rate limiting — and the rule that a duplicate
  is **merged and counted**, not dropped.
- `throttle.rs` / `metrics.rs`: the token bucket + window state machine, and the
  per-channel counters (`sent` / `dropped` / `failed` / `suppressed`).
- `webhook.rs` / `smtp.rs` / `stdout.rs`: the transports, all pure `std`.

| severity | meaning | window | rate limit |
|---|---|---|---|
| **P0** | someone must act now (a critical service is down) | 30 s | **none** |
| **P1** | the on-call engineer's next task (partial degradation) | 5 min | 1 / second / channel |
| **P2** | a warning for business hours | 1 h | 1 / 10 seconds / channel |

It is **not** a log aggregator, a paging roster, or an HTTP client with TLS.

## Layout

| file | what |
|---|---|
| `src/alert.rs` | `Alert`, `Severity`, fingerprint |
| `src/channel.rs` | `Channel`, `SendOutcome`, `Instrumented`, `Recorder` |
| `src/dispatcher.rs` | `Dispatcher`, `DispatcherBuilder` |
| `src/throttle.rs` | rate limiter + suppression-window state machine |
| `src/metrics.rs` | `ChannelMetrics`, `DispatchMetrics` |
| `src/webhook.rs` | the HTTP POST transport (pure std) |
| `src/smtp.rs` | the RFC 5321 subset transport (pure std) |
| `src/stdout.rs` | the stderr fallback |
| `examples/` | `alert_to_stderr` |

## Build & test

```bash
cargo test -p amos-notifier
cargo clippy -p amos-notifier --all-targets -- -D warnings
node scripts/rust-panic-scan.mjs   # every crate root denies unwrap/expect/panic in production
```

## Examples

```bash
# One alert per severity into the stderr fallback, then the counters — including the
# suppression counter, which is the point of the window. Offline: no socket is opened.
cargo run -p amos-notifier --example alert_to_stderr
```

| example | shows |
|---|---|
| `alert_to_stderr` | the builder, `fire()` for P0/P1/P2, and `metrics()` reporting `suppressed=1` for the repeated P0 — a merged duplicate rather than a second page |

## Honest boundaries

- **No TLS.** `https://` is refused at construction (`try_new` returns `Err`); point the
  webhook at a local relay or collector over `http://`.
- **`WebhookChannel::new` panics on a malformed URL.** That is the deliberate
  startup-misconfiguration contract — the crate's `panic!` exception, carrying a local
  `#[allow(clippy::panic)]`. For a URL loaded at run time (e.g. from `amos-config`) use
  `try_new`.
- **A transport that fails never panics**: it records `failed` and the next transport
  tries, with stderr always the last resort — which is also what makes the
  "an alert never takes the process down" contract observable.
- **A timeout that cannot be set is reported and the send continues.** Refusing would
  cost the only alert-delivery path; the report is what keeps the difference between
  "bounded" and "may block forever" visible.
- **SMTP is a subset**: EHLO / MAIL / RCPT / DATA / QUIT, no STARTTLS, no AUTH. It is
  meant for a localhost relay or an internal `msmtp`.
- **Suppression merges; it does not drop.** `suppressed` is how "23× in 5 min" reaches
  the operator as one number instead of 23 messages.

## Related

- [`docs/devops.md`](../../docs/devops.md) §3 — the runbook for this crate.
- [`crates/amos-config`](../amos-config/README.md) — where `AMOS_NOTIFIER_WEBHOOK`-class
  configuration is loaded from.
- [`crates/amos-ai`](../amos-ai/README.md) — the producer: threshold alerts reach this
  dispatcher through the notifier sink when `AMOS_NOTIFIER` is on.
