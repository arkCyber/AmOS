# amos-flashlight — torch on/off with an honest hardware seam

Illumination (torch) state, a `FlashlightProvider` seam and a manager that reports what the
hardware actually did — including "there is no torch on this device", which is an error, not
a silent success. Part of **[Amos](../../README.md)**. Design record:
[`docs/flashlight.md`](../../docs/flashlight.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `FlashlightManager` owns the intent and the observed state (`FlashlightState`), so the UI
  toggle, the notification shortcut and the quick-settings tile cannot disagree.
- `FlashlightProvider` is the seam: `MockFlashlightProvider` for host tests,
  `AndroidFlashlightProvider` (feature `android`) for the real `CameraManager.setTorchMode`.
- **`set_on` only reports `true` after the platform accepted it** (`on=true` is never
  fabricated), and a device without a torch refuses with a typed error.
- The state carries a stable key for the wire/UI, so persistence and the System UI use one
  representation.

It is **not** a camera controller: it never takes a picture, opens a preview or touches
auto-exposure.

## Layout

| file | what |
|---|---|
| `src/state.rs` | `FlashlightState` (+ stable key) |
| `src/manager.rs` | `FlashlightManager`: intent → provider → observed state |
| `src/provider.rs` | `FlashlightProvider` seam + `MockFlashlightProvider` |
| `src/android.rs` | *(feature `android`)* `AndroidFlashlightProvider` |
| `src/error.rs` | `FlashlightError`, `Result` |

## Build & test

```bash
cargo test -p amos-flashlight
cargo check -p amos-flashlight --features android   # the JNI provider compiles
cargo clippy -p amos-flashlight --all-targets -- -D warnings
```

## Examples

```bash
# The mock provider: what a real toggle reports, and what a torch-less device refuses.
cargo run -p amos-flashlight --example toggle_states
```

| example | shows |
|---|---|
| `toggle_states` | on → off → on through `FlashlightManager` with the mock provider, the state each step reports, and a provider that fails the way a torch-less device does (a refusal, never a fake `on`) |

## Honest boundaries

- **The Android provider needs a device** (feature `android`, a `Context`): `cargo check`
  proves it compiles; the torch behaviour is verified on hardware.
- **One torch, one owner**: a second camera client can steal the torch from under Android;
  the manager reports what the platform said at the time of the call, not a guarantee.
- **No auto-off timer**: keeping a torch on is the user's call; the energy policy only
  observes it.

## Related

- [`docs/flashlight.md`](../../docs/flashlight.md) — the seam, the JNI path and the honesty
  rules.
- [`crates/amos-power`](../amos-power/README.md) — the governor that sees a lit torch as a
  load.
