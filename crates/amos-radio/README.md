# amos-radio — wifi / bluetooth / airplane connectivity core

The connectivity domain: wifi, bluetooth and airplane state, a `RadioProvider` seam (mock on
the host, JNI on Android) and a manager that owns the **airplane-mode cascade** — turning
airplane on turns radios off *in a defined order*, and turning it off restores only what was
on before. Part of **[Amos](../../README.md)**. Design record:
[`docs/radio.md`](../../docs/radio.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `RadioManager` + `RadioMode`/`RadioSnapshot`: one state object the UI, the status bar and
  the settings page read, instead of three caches of the platform truth.
- **Airplane mode is a policy, not a flag switch**: turning it **on** cascades
  Wi-Fi/Bluetooth/hotspot off in a defined order, and if a later step fails the whole set is
  rolled back and the failure reported — so a crash or a refusal cannot leave the device
  half-cascaded. Turning it **off** clears the airplane bit and nothing else: bringing radios
  back is the *user's* next action, and this crate never silently re-enables a radio it does
  not actually remember (see the boundaries below).
- **BLE** (`src/bluetooth.rs`): scan/pairing types with bounded results, so a busy air
  interface cannot flood a caller.
- `RadioProvider` is the seam: `MockRadioProvider` makes every rule testable offline, and
  `AndroidRadioProvider` (feature `android`) talks to the platform through
  [`crates/amos-jni`](../amos-jni/README.md).

It is **not** a network stack: no DHCP, no routing, no captive-portal detection.

## Layout

| file | what |
|---|---|
| `src/state.rs` | `RadioMode`, `RadioSnapshot` |
| `src/manager.rs` | `RadioManager`: airplane cascade + guard, restore policy |
| `src/bluetooth.rs` | BLE scan/pairing types and their bounds |
| `src/provider.rs` | `RadioProvider` seam + mock |
| `src/android.rs` | *(feature `android`)* the JNI provider |
| `src/error.rs` | `RadioError`, `Result` |

## Build & test

```bash
cargo test -p amos-radio
cargo test -p amos-radio --features amos-radio/android --lib   # the JNI glide's host tests
cargo clippy -p amos-radio --all-targets --features android -- -D warnings
```

## Examples

```bash
# Airplane on/off through the mock provider: what is restored, and what is not.
cargo run -p amos-radio --example airplane_cascade
```

| example | shows |
|---|---|
| `airplane_cascade` | wifi+bluetooth on → airplane on (the defined order of shut-offs) → airplane off (only the previously-on radios come back), plus a provider that refuses a toggle and how the manager reports it |

## Honest boundaries

- **Airplane OFF does not bring radios back.** The crate deliberately does not remember "what
  was on before" — a stale memory silently re-enabling Wi-Fi on the ground would be worse than
  one extra tap, so the caller (or the user) re-enables what they want. The example shows this
  explicitly (`wifi=false bluetooth=false` after airplane off).
- **A platform-managed radio is refused before it is attempted** (`RadioControl`): the user
  gets a surface to open, not a failed write.
- **The device is the only place the JNI provider is proven** (feature `android` + a
  `Context`): `cargo check` shows it compiles; the platform behaviour is a device item.
- **BLE scanning needs a runtime permission** on Android; the provider surfaces the refusal
  rather than returning an empty list.
- **No signal-strength history** and no network selection policy: those are platform
  concerns.

## Related

- [`docs/radio.md`](../../docs/radio.md) — the cascade rules and the provider contract.
- [`crates/amos-jni`](../amos-jni/README.md) — the JNI plumbing the Android provider uses.
- [`crates/amos-network-guard`](../amos-network-guard/README.md) — what may leave the radio.
