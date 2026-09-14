# amos-timesync — network wall-clock calibration

A `TimeSource` seam (offline `HostClock`, deterministic `MockTimeSource`, real NTP behind the
`ntp` feature) feeding a `SyncedClock` that keeps a calibrated wall clock plus a
**last-known-good** state, refreshed by a periodic timekeeper. Part of
**[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `SyncedClock` carries the offset it measured **and whether that offset is trustworthy**:
  a clock that never synced says so, so a caller (an audit log, a latency figure, a
  timestamp in [`crates/amos-link`](../amos-link/README.md)) can print "bounds" instead of
  implying a measurement.
- **Last-known-good persistence**: a device that boots without network keeps the last
  calibration, with its age, instead of resetting to zero.
- `spawn_timekeeper` refreshes on a bounded period and reports failures — a time server that
  goes away degrades the clock's *confidence*, it does not break the daemon.
- `NtpTimeSource` (feature `ntp`) is a real, small NTP client; the tests for it run offline
  against loopback/RFC-shaped data.
- `MockTimeSource` advances only when told to, which is why every rule here is deterministic
  in tests.

It is **not** a PTP/PPS implementation and makes no claim of sub-millisecond accuracy: it
calibrates a wall clock over the network.

## Layout

| file | what |
|---|---|
| `src/clock.rs` | `SyncedClock` (offset + trust + last-known-good) |
| `src/time_source.rs` | `TimeSource` seam, `HostClock`, `MockTimeSource` |
| `src/timekeeper.rs` | `spawn_timekeeper`, `Timekeeper` |
| `src/ntp.rs` | *(feature `ntp`)* `NtpTimeSource` |
| `src/error.rs` | `Error`, `Result` |

## Build & test

```bash
cargo test -p amos-timesync
cargo test -p amos-timesync --features amos-timesync/ntp --lib   # NTP resolver tests
cargo run -p amos-timesync --example ntp_probe -- pool.ntp.org  # real network, opt-in
cargo clippy -p amos-timesync --all-targets -- -- -D warnings
```

## Examples

```bash
cargo run -p amos-timesync --example ntp_probe -- pool.ntp.org
```

| example | shows |
|---|---|
| `ntp_probe` | a real NTP round trip (opt-in, needs network): the offset measured, the trust state afterwards, and what an unreachable server does to the clock's confidence |

## Honest boundaries

- **Needs network**: the example is the only place this crate talks to the outside, and it is
  opt-in with an explicit server argument.
- **Accuracy is bounded by the network**, not by this code; the API reports an offset and a
  trust verdict rather than an accuracy guarantee.
- **No monotonic-guard guarantee**: a backward jump is reported as a jump; smoothing it is
  the caller's policy.
- **The clock is not a security boundary**: TLS/certificate time belongs to the platform.

## Related

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — where the calibrated clock sits.
- [`crates/amos-timesync-cli`](../amos-timesync-cli/README.md) — query/sync from a terminal.
- [`crates/amos-link`](../amos-link/README.md) — stamps every `Envelope` with this clock.
