# amos-tts — text-to-speech (provider seam + Piper backend)

Turns an interpretation request (`amos_int::TtsRequest`) into playable audio: a `TtsProvider`
trait, a deterministic `MockTtsProvider`, and the real Piper engine behind a feature. Part of
**[Amos](../../README.md)**. Design record: [`docs/bidi-voice-asr.md`](../../docs/bidi-voice-asr.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `TtsProvider`: synthesize text (with a language/voice) into `TtsAudio` — the one interface
  the interpretation pipeline needs, so voice output is swappable without touching the
  session state machine.
- `MockTtsProvider` produces deterministic (silent/synthetic) audio, which is what lets the
  full ASR → translation → TTS loop be tested offline.
- `PiperProvider` (feature `piper`) is the real engine: a model directory is required, and a
  missing model is a **construction-time error** rather than silence at playback.
- Audio out of the provider is in the same PCM spec as [`crates/amos-audio`](../amos-audio/README.md),
  so the playback sink is the only place that knows about a device.

It is **not** a voice-cloning or SSML engine: text in, PCM out.

## Layout

| file | what |
|---|---|
| `src/provider.rs` | `TtsProvider`, `MockTtsProvider` |
| `src/piper.rs` | *(feature `piper`)* `PiperProvider` |

## Build & test

```bash
cargo test -p amos-tts
cargo check -p amos-tts --features piper   # needs the Piper native library
cargo clippy -p amos-tts --all-targets -- -D warnings
```

## Examples

```bash
# The mock provider: what the interpretation loop receives, with no model and no speaker.
cargo run -p amos-tts --example mock_utterance
# Real engine (feature `piper`): needs a voice model directory.
cargo run -p amos-tts --features piper --example piper_tts -- <model_dir> "你好"
```

| example | shows |
|---|---|
| `mock_utterance` | a `TtsRequest` synthesized through the mock: the PCM it returns, its format and length — the contract the pipeline depends on |
| `piper_tts` | *(feature `piper`)* a real utterance written to a wav, with the sample count and duration it produced |

## Honest boundaries

- **A voice model is required for real speech** and is fetched separately; the `piper` path
  refuses to construct without it.
- **No playback here**: the samples go to `crates/amos-audio`'s sink (or a file in the
  example).
- **Quality belongs to the model**; this crate guarantees the interface, format and the
  refusal paths.
- **No streaming synthesis contract yet**: utterances are synthesized whole (see the design
  record's next steps).

## Related

- [`crates/amos-int`](../amos-int/README.md) — the session that requests speech.
- [`crates/amos-audio`](../amos-audio/README.md) — PCM format and playback.
- [`crates/amos-asr`](../amos-asr/README.md) — the other half of the voice loop.
