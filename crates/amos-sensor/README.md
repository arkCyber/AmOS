# amos-sensor — device sensors (camera / GNSS / IMU) + gRPC service

Camera, GPS/GNSS and IMU spec types, a `SensorProvider` seam (mock on the host, Android
Camera2/GNSS/SensorManager on device), a live-frame/IMU latest-value buffer for streaming,
and the `SensorManager` that applies the energy policy to sensors. Part of
**[Amos](../../README.md)**. Design record: [`docs/sensors.md`](../../docs/sensors.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- **Specs, not bytes**: camera/GNSS/IMU frames are described by typed metadata — the raw
  camera frame *bytes* deliberately do **not** travel over gRPC (`proto/sensor.proto` says
  so); high-rate payloads belong to a data plane such as
  [`crates/amos-link`](../amos-link/README.md).
- `sensor.stream` (`FrameLatest`, `ImuLatest`, `LiveSensorProvider`, `StreamChange`) keeps
  the **newest** sample per stream, which is what a UI needs and what stops a slow consumer
  from growing a queue.
- `SensorManager` owns the on/off + rate decisions, driven by `crates/amos-power`'s
  `SensorMode` — so "the governor lowered the rate" is one code path, not per-sensor logic.
- `service.rs` (`SensorService`, `server`, `mock_server`) exposes the typed surface over the
  daemon's UDS; `AndroidSensorProvider` (feature `android`) is the real GNSS path via
  `LocationManager`.

It is **not** a camera driver or an ALSA/HAL: the actual capture is the platform provider's.

## Layout

| file | what |
|---|---|
| `src/spec.rs` | camera / GNSS / IMU spec types |
| `src/provider.rs` | `SensorProvider` seam + `MockSensorProvider` |
| `src/stream.rs` | `FrameLatest`, `ImuLatest`, `LiveSensorProvider`, `StreamChange` |
| `src/manager.rs` | `SensorManager`: energy-policy-driven enable/rate |
| `src/service.rs` | `SensorService`, `server`, `mock_server` (the tonic surface) |
| `src/android.rs` | *(feature `android`)* the Android provider |

## Build & test

```bash
cargo test -p amos-sensor
cargo check -p amos-sensor --features android
cargo clippy -p amos-sensor --all-targets -- -D warnings
```

## Examples

```bash
# Drive the mock provider: camera/GNSS/IMU samples and latest-value semantics.
cargo run -p amos-sensor --example stream_latest
```

| example | shows |
|---|---|
| `stream_latest` | a mock provider serving camera/GNSS/IMU samples, a capture that really changes, a refused nonexistent camera, and `FrameLatest`/`ImuLatest` keeping only the newest sample (and clearing to empty) |

## Honest boundaries

- **No frame bytes over gRPC**: the typed surface carries metadata; the bulk path is the link
  layer (or a platform API). Claiming otherwise would be a bandwidth lie.
- **The Android provider needs permissions and a device**: a GNSS fix on a host is
  impossible, and the example never fakes one.
- **Mock mode is explicit**: the service's `mock_server` says it is a mock; a caller cannot
  mistake it for hardware.
- **Sensor accuracy/flags are passed through**, not interpreted.

## Related

- [`docs/sensors.md`](../../docs/sensors.md) — the provider contract and the stream rules.
- [`proto/sensor.proto`](../../proto/sensor.proto) — the gRPC surface.
- [`crates/amos-power`](../amos-power/README.md) — the mode that drives sensor rates.
- [`crates/amos-link`](../amos-link/README.md) — the data plane for high-rate frames.
