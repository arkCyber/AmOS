# amos-telemetry-spy — passive egress payload audit

A **no-block** observer: it watches one egress interface (e.g. `rmnet_data0`) for
device-bound identifiers — hardware ids, advertising ids, account tokens, phone numbers —
and reports what it saw, without dropping or altering a single packet. Part of
**[Amos](../../README.md)**. Design record:
[`docs/DELIVERY_NOTES_2026-09-09-telemetry-spy.md`](../../docs/DELIVERY_NOTES_2026-09-09-telemetry-spy.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `packet.rs` + `scanner.rs` + `signal.rs`: a bounded scan over captured frames for
  identifier **shapes** (with a catalogue in `identifier.rs`), reporting a signal rather than
  a verdict.
- `identity.rs` (`DeviceIdentity`, `StaticIdentity`, `MockIdentity`): the identifiers belong to
  *this* device, so a report can say "this is your own id leaving the device" — the
  question a user actually has.
- `analyze.rs` (`match_frame`): the pure matcher, so every rule is testable against recorded
  frames with no interface and no privileges.
- `audit` (feature, needs `pnet`/libpcap): the real NIC read path. On a host without
  libpcap the feature is simply not enabled, and the crate still builds and tests.
- **No blocking, ever**: this crate has no hook that can drop a packet; that is
  [`crates/amos-network-guard`](../amos-network-guard/README.md)'s job, and keeping them
  separate is deliberate.

It is **not** a DPI product or a TLS interceptor: it sees what it can see on the wire
(metadata and cleartext) and says so.

## Layout

| file | what |
|---|---|
| `src/analyze.rs` | `match_frame` — the pure payload matcher |
| `src/identifier.rs` | `Identifier`, `IdentifierKind` (the catalogue) |
| `src/identity.rs` | `DeviceIdentity`, `StaticIdentity`, `MockIdentity` |
| `src/packet.rs` · `src/scanner.rs` · `src/signal.rs` | frame model, bounded scan, signals |
| `src/capture.rs` | *(feature `audit`)* the real interface reader |
| `src/error.rs` | `Error`, `Result` |

## Build & test

```bash
cargo test -p amos-telemetry-spy
cargo check -p amos-telemetry-spy --features audit   # needs libpcap (see gated-check)
cargo clippy -p amos-telemetry-spy --all-targets -- -D warnings
```

## Examples

```bash
# The pure matcher: synthetic frames carrying (and not carrying) identifiers.
cargo run -p amos-telemetry-spy --example audit_frames
# Real capture (feature `audit` + privileges): list interfaces and watch one.
cargo run -p amos-telemetry-spy --features audit --example live_spy -- <iface>
```

| example | shows |
|---|---|
| `audit_frames` | recorded/synthetic frames scanned by `match_frame`: which identifier kinds were found, the evidence, and a clean frame that matches nothing |
| `live_spy` | *(feature `audit`)* the real interfaces on this host and a passive watch, printing what it can see (and admitting what it cannot) |

## Honest boundaries

- **Encrypted traffic shows metadata, not content**: an identifier inside TLS is not visible
  here, and the report says "not observed" rather than "not present".
- **Capture needs privileges and libpcap**: without them the feature is off and the pure
  matcher still runs.
- **A match is a signal, not an accusation**: a phone number in a payload can be legitimate.
- **This crate cannot block** — by construction, so a false positive can never cut a user off.

## Related

- [`proto/telemetry_spy.proto`](../../proto/telemetry_spy.proto) — the service contract.
- [`crates/amos-network-guard`](../amos-network-guard/README.md) — the plane that *does* block.
