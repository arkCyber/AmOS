# amos-audio — hardware audio HAL abstraction

AOSP-near audio abstraction: capture and playback traits, a 16 kHz PCM wire spec, sample-rate
resampling, deterministic mocks for tests — plus the TinyALSA/AAudio FFI seams behind
features. Part of **[Amos](../../README.md)**. Design record:
[`docs/audio-hal-bridge.md`](../../docs/audio-hal-bridge.md) ·
[`docs/aaudio-sherpa-bringup.md`](../../docs/aaudio-sherpa-bringup.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `AudioCapture` / `AudioCaptureExt` + `sink`: the two directions a voice stack needs, as
  traits, so the same code runs over a mock mic in tests and AAudio on a device.
- `spec.rs`: the PCM wire format (16 kHz mono, little-endian) **and** `encode_f32_le`, so
  handing samples between crates is not a convention but a helper.
- `resample.rs` (`resample_linear`, `LinearDownsampler`): 48 kHz device audio → the format
  ASR wants, deterministic and testable.
- `ring.rs`: the bounded sample ring the real-time callback writes into, with an
  under-run policy that reports a stalled capture instead of blocking a real-time thread.
- `android/` (features `aaudio` / `tinyalsa`): the FFI seams. The AAudio path uses the
  **data-callback (push)** form by default (`AAudioCallbackCapture`), with a blocking pull
  reader kept as an explicit alternative.
- `mock.rs`: the offline sources (`SineMic`) every consumer test uses.

It is **not** a mixer, a codec or a policy manager (routing, focus, ducking are platform
concerns) and it does not implement AOSP's `audio_policy` service.

## Layout

| file | what |
|---|---|
| `src/capture.rs` | `AudioCapture`, `AudioCaptureExt` |
| `src/sink.rs` | the playback side |
| `src/spec.rs` | the PCM wire spec + `encode_f32_le` |
| `src/resample.rs` | `resample_linear`, `LinearDownsampler` |
| `src/ring.rs` | the bounded, real-time-safe sample ring |
| `src/mock.rs` | deterministic offline sources (`SineMic`) |
| `src/android/` | *(features `aaudio`/`tinyalsa`)* the real HAL seams |

## Build & test

```bash
cargo test -p amos-audio
cargo check -p amos-audio --features aaudio --target aarch64-linux-android
bash scripts/android-audio-check.sh    # compiles the seams for 3 ABIs + link-checks AAudio
cargo clippy -p amos-audio --all-targets -- -D warnings
```

## Examples

```bash
# Mock mic → resample → PCM spec → (optionally) the ASR pipeline. No hardware needed.
cargo run -p amos-audio --example mic_to_asr
# Link-check the AAudio FFI against the NDK's libaaudio.so (feature `aaudio`; a cfg'd
# no-op on a non-Android host, which is why it is build-checked, not run, here).
cargo run -p amos-audio --features aaudio --example aaudio_link_smoke
# Open the real callback capture for ~1 s (feature `aaudio`, device): how many samples
# actually arrived.
cargo run -p amos-audio --features aaudio --example aaudio_callback_probe
```

| example | shows |
|---|---|
| `mic_to_asr` | a synthetic 440 Hz mic, the resampling step, the encoded frame the ASR/interpretation layer receives — the whole capture path without a microphone |
| `aaudio_link_smoke` | link-checking the AAudio FFI against the NDK's `libaaudio.so` (needs the NDK; on host it is a no-op) |
| `aaudio_callback_probe` | *(feature `aaudio`, device)* opening the real callback capture for ~1 s and printing how many samples arrived |

## Honest boundaries

- **Host runs cannot capture**: there is no native mic path on a desktop host, so the mock is
  what tests use, and the README says so instead of pretending.
- **The AAudio/TinyALSA seams need the NDK and a device**: `cargo check` + the link smoke
  prove compilation; real sample flow is a device item (`docs/aaudio-sherpa-bringup.md`).
- **No AEC/NS/AGC**: echo cancellation and noise suppression are not implemented here.
- **Latency claims are device measurements**, taken with the probe, never estimates.

## Related

- [`crates/amos-asr`](../amos-asr/README.md) — consumes capture.
- [`crates/amos-tts`](../amos-tts/README.md) — produces playback.
- [`crates/amos-int`](../amos-int/README.md) — the session that ties them together.
