# amos-sms — SMS domain core (threads, folders, validation)

Real SMS threads and messages across the standard folders (inbox/sent/draft/trash), a
`SmsProvider` seam (mock on the host, Android `SmsGlue` on device) and the rules that keep a
message valid: number normalization, bounded segment counts, and balance redaction. Part of
**[Amos](../../README.md)**. Design record: [`docs/sms.md`](../../docs/sms.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `SmsMessage` / `SmsThread` / `SmsFolder` (+ `SmsFolderCounts`): the model the inbox UI, the
  notification and the blocklist filter share.
- `validate.rs`: a message is normalized and its **segment count is bounded** — an SMS has a
  hard protocol limit, and exceeding it is refused rather than silently truncated.
- `redact.rs` (`redact_balances`, `is_bank_sender`, `redact_for`): a bank message's balances
  are masked before they reach a UI surface, so a notification or a lock screen never leaks
  an account balance.
- `trash.rs` is a real trash with a retention rule, not a flag.
- `wire.rs` is the typed representation the System UI and the daemon exchange;
  `provider.rs` is the seam (`MockSms`, `MOCK_PROVIDER`, `SmsProvider`).
- `src/android.rs` (feature `android`) reads `content://sms` and sends via `SmsManager`.

It is **not** an RCS/MMS stack: SMS text only, no attachments, no group chat.

## Layout

| file | what |
|---|---|
| `src/spec.rs` | `SmsMessage`, `SmsThread` |
| `src/folder.rs` | `SmsFolder`, `SmsFolderCounts` |
| `src/validate.rs` | normalization + segment bounds |
| `src/redact.rs` | balance redaction for bank senders |
| `src/trash.rs` | trash with retention |
| `src/provider.rs` | `SmsProvider` seam + `MockSms` |
| `src/wire.rs` | UI/daemon representation |
| `src/android.rs` | *(feature `android`)* the device backend |

## Build & test

```bash
cargo test -p amos-sms
cargo check -p amos-sms --features android
cargo clippy -p amos-sms --all-targets -- -D warnings
```

## Examples

```bash
# Threads and folders on the mock provider, plus validation + redaction rules.
cargo run -p amos-sms --example inbox_and_redaction
```

| example | shows |
|---|---|
| `inbox_and_redaction` | sending and receiving through the mock provider, threads landing in the right folders with counts, a too-long message being refused, and a bank message's balances being redacted |

## Honest boundaries

- **Sending is the platform's**: on Android the real path is `SmsManager` (dual-SIM and
  permission refusals included) — the provider reports what happened.
- **Redaction is best-effort by sender pattern**: it protects the common bank formats, and a
  sender that does not match is passed through (see the tests for what is covered).
- **No MMS/RCS**, no delivery reports beyond what the platform gives.
- **Reading SMS needs a runtime permission**: a refusal is surfaced, never an empty inbox.

## Related

- [`docs/sms.md`](../../docs/sms.md) — folders, validation and the Android glue contract.
- [`crates/amos-blocklist`](../amos-blocklist/README.md) — the filter that drops spam first.
- [`crates/amos-telephony`](../amos-telephony/README.md) — calls, the sibling domain.
