# amos-clipboard — host↔guest clipboard sync

The clipboard that works **across the boundary**: the host System UI and the Waydroid guest
share one clipboard through a framed wire protocol, with an echo guard so a copy does not
bounce forever between the two sides. Part of **[Amos](../../README.md)**. Design record:
[`docs/clipboard-container-sync.md`](../../docs/clipboard-container-sync.md); device
runbook: [`docs/clipboard-device-runbook.md`](../../docs/clipboard-device-runbook.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `src/proto.rs` **is the contract**: framed JSON messages (a length prefix + CRC-checked
  body) with an `encode`↔`decode` round trip; both sides of the boundary import this crate,
  so the wire cannot drift.
- `src/agent.rs` is the host side: it decides *what* to push (a real copy, not every poll)
  and records whether the guest acknowledged it.
- `src/link.rs` carries it over a byte stream with a bounded reconnect `Backoff`
  (`min_delay()` floors the retry so a flapping peer cannot spin a hot loop).
- `src/provider.rs` is the platform seam (`ClipboardProvider`), so the host path is
  testable offline; `src/android.rs` (feature `android`) is the guest implementation.
- `src/unix.rs` is the locally-runnable transport (a Unix socket) used by host bring-up.

It is **not** a cloud clipboard: nothing leaves the device, and there is no account,
encryption-at-rest or history sync.

## Layout

| file | what |
|---|---|
| `src/proto.rs` | the wire messages + `encode`/`decode` (length + CRC) |
| `src/agent.rs` | host agent: push policy, echo guard, acknowledgement |
| `src/link.rs` | stream framing + `Backoff` (exponential, floored) |
| `src/provider.rs` | `ClipboardProvider` seam + host/mock implementation |
| `src/unix.rs` | the UDS transport used for host bring-up |
| `src/android.rs` | *(feature `android`)* the guest provider |

## Build & test

```bash
cargo test -p amos-clipboard                       # protocol, echo guard, backoff (offline)
cargo check -p amos-clipboard --features android   # the guest provider compiles
cargo clippy -p amos-clipboard --all-targets -- -D warnings
```

## Examples

```bash
# The protocol end-to-end on the host: encode → decode → echo guard → backoff.
cargo run -p amos-clipboard --example on_device_selfcheck
```

| example | shows |
|---|---|
| `on_device_selfcheck` | the headless self-check that also runs on device: agent push → guest application (no echo), a real copy being reported, the protocol round trip, the echo guard, and the reconnect backoff's floor + cap |

## Honest boundaries

- **No Waydroid on this machine means no guest run**: `examples/on_device_selfcheck.rs` is
  written to run on device (`adb push` + run) and prints
  `AMOS_CLIPBOARD_SELFCHECK_OK` when every pure invariant holds on the host too.
- **The guest provider needs Android** (feature `android`, a `Context`): `cargo check`
  proves it compiles, the device proves it works.
- **Clipboard content is not persisted** by this crate: it is a transfer path, not a store.
- **Authentication is the transport's**: over the UDS the daemon's peer-credential policy
  applies; this crate does not add a second identity layer.

## Related

- [`docs/clipboard-container-sync.md`](../../docs/clipboard-container-sync.md) — the protocol
  and the echo-guard rules.
- [`docs/clipboard-device-runbook.md`](../../docs/clipboard-device-runbook.md) — how to
  decide the device form and what is verifiable on it.
- [`crates/amos-android`](../amos-android/README.md) — the container this crosses into.
