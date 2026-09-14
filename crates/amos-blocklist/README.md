# amos-blocklist — spam blocking for calls and SMS

Number rules that decide whether an incoming call or message is blocked: exact or prefix
matches, per channel (call / SMS / both), with number equivalence (`+CC`, leading `0`) and
an unknown-number toggle. Pure, deterministic, no I/O — the same rules feed the SMS filter,
the `CallScreeningService` and the settings UI. Part of **[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `Rule` is `{ pattern, kind: Exact | Prefix, channel: Call | Sms | Both, reason, label }`;
  `Blocklist::check(number, traffic)` answers with the matching rule (or `None`).
- **Number equivalence is part of the rule, not the caller**: an entry may be written with
  or without a country code (`+8613800138000` vs `13800138000`) and still match, so a user
  never has to know which form a carrier delivered.
- **A cap with LRU eviction** (`DEFAULT_CAP`, `list.rs`) bounds the store: a runaway
  importer cannot grow it without limit, and what eviction dropped is visible.
- `MIN_PREFIX_DIGITS` refuses a prefix rule so short it would block a whole country — a
  refusal, not a warning, because the alternative is silently locking a user out.
- The list is **data**: JSON in, JSON out, so settings UI, SMS filter and the Android
  screening service read the same file.

It is **not** a spam classifier: there is no scoring, no learning, no network lookups. Rules
are what the user (or an app they trust) put there.

## Layout

| file | what |
|---|---|
| `src/rule.rs` | `Rule`, `MatchKind`, `Channel`, `BlockReason`, `DEFAULT_CAP`, `MIN_PREFIX_DIGITS` |
| `src/list.rs` | `Blocklist`: add/remove/check, equivalence, cap + LRU, JSON (de)serialisation |
| `src/error.rs` | `BlocklistError` |

## Build & test

```bash
cargo test -p amos-blocklist
cargo clippy -p amos-blocklist --all-targets -- -D warnings
cargo fmt -p amos-blocklist -- --check
```

## Examples

```bash
# Rules in, verdicts out: exact/prefix, per channel, +CC equivalence, the cap, and JSON.
cargo run -p amos-blocklist --example block_calls_and_sms
```

| example | shows |
|---|---|
| `block_calls_and_sms` | adding an exact and a prefix rule, checking calls vs SMS against them, the `+CC`/bare-number equivalence, a too-short prefix being refused, and the JSON round trip the UI and Android service share |

## Honest boundaries

- **Deterministic and offline by construction**: no carrier lookup, no reputation service,
  no heuristics. Two device builds with the same rules make the same decision.
- **Blocking is a decision, not an action**: this crate never rejects a call or deletes a
  message — the SMS filter and the screening service apply the verdict.
- **`MIN_PREFIX_DIGITS` is a guard, not a policy**: a deployment that genuinely needs a
  shorter prefix must change the constant deliberately (and see the tests that pin it).

## Related

- [`docs/sms.md`](../../docs/sms.md) — where the SMS side applies these rules.
- [`docs/telephony.md`](../../docs/telephony.md) — the call side (screening + routing).
- [`crates/amos-sms`](../amos-sms/README.md) · [`crates/amos-telephony`](../amos-telephony/README.md)
