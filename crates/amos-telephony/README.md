# amos-telephony — number rules, call sessions, dial routing

Phone-number and emergency-map rules, a per-call `CallSession` state machine, recording
consent and dial routing — with a **hard no-record rule for emergency lines** and a rate
limit that cannot starve an emergency call. Part of **[Amos](../../README.md)**. Design
record: [`docs/telephony.md`](../../docs/telephony.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `Number` / `NumberKind` / `EmergencyMap`: parsing and classification, including the
  emergency set (`110`/`112`/`911` …) — classification is a domain fact, not a UI string
  match.
- `route` / `guard_emergency` / `guard_regular` / `DialRoute`: one place decides how a dial
  is routed and what may block it. **Emergency dials bypass ordinary guards**; regular dials
  are rate-limited (`rate.rs`).
- `CallSession` + `Call`/`CallState`/`CallDirection`/`EndReason`: the state machine every
  surface follows, so the UI, the notification and the log cannot disagree about a call.
- **Recording** (`RecordingState`): consent is an explicit allow/deny seam, and an emergency
  line is a hard refusal — telephony is where a mistake is unrecoverable, so the rule is a
  refusal rather than a warning.
- `audit.rs` (`AuditLog`, `AuditEntry`, `AuditOutcome`) records what was decided and why.
- `service.rs` exposes the gRPC surface (the daemon mounts a rate-limited demo server).

It is **not** a modem stack: there is no RIL, no IMS registration and no SIM toolkit.

## Layout

| file | what |
|---|---|
| `src/number.rs` | `Number`, `NumberKind`, `EmergencyMap` |
| `src/route.rs` | `route`, `DialRoute`, `guard_emergency`, `guard_regular` |
| `src/rate.rs` | the dial rate limiter (emergency-exempt) |
| `src/session.rs` | `CallSession`, `Call`, `CallState`, `RecordingState`, `EndReason` |
| `src/provider.rs` | `TelephonyProvider` / `EmergencyTelephonyProvider` seams + mock |
| `src/audit.rs` | `AuditLog`, `AuditEntry`, `AuditOutcome` |
| `src/service.rs` | the tonic surface |

## Build & test

```bash
cargo test -p amos-telephony
cargo clippy -p amos-telephony --all-targets -- -D warnings
cargo fmt -p amos-telephony -- --check
```

## Examples

```bash
# A call's whole life through the state machine, plus the emergency recording refusal.
cargo run -p amos-telephony --example call_lifecycle
```

| example | shows |
|---|---|
| `call_lifecycle` | dial → connect → record start/stop → end (local vs remote), the emergency classification that refuses recording outright, the emergency-exempt rate limit, and the audit entries produced |

## Honest boundaries

- **No call is placed by a host example**: the provider is a mock; the real modem path is a
  device item.
- **Emergency numbers are locale data**: `EmergencyMap` ships the sets it knows and refuses
  to guess an unknown region's set.
- **The no-record rule is absolute in this crate** — there is no override flag, deliberately.
- **Rate limiting is per client id**, and an emergency dial never counts against it.

## Related

- [`docs/telephony.md`](../../docs/telephony.md) — the state machine, routing and policy.
- [`proto/telephony.proto`](../../proto/telephony.proto) — the gRPC surface.
- [`crates/amos-blocklist`](../amos-blocklist/README.md) — the call-screening rules.
- [`crates/amos-display`](../amos-display/README.md) — the hold-while-call idle rule.
