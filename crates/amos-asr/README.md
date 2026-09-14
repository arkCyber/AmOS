# amos-asr — streaming speech recognition (recognizer seam + pipeline)

A transport-agnostic `StreamingRecognizer` abstraction and a `Pipeline` adapter that turns
real `AsrEvent::Partial`/`Final` results into the interpretation layer's events. Part of
**[Amos](../../README.md)**. Design record:
[`docs/bidi-voice-asr.md`](../../docs/bidi-voice-asr.md) · bring-up:
[`docs/aaudio-sherpa-bringup.md`](../../docs/aaudio-sherpa-bringup.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `StreamingRecognizer` is the seam: push audio in, receive `Hypothesis`s out.
  `MockStreamingRecognizer` makes the whole consumer path (partial → final → translation)
  testable with no model and no microphone.
- `AsrPipeline` / `AsrPipelineBuilder` wire a recognizer into
  [`crates/amos-int`](../amos-int/README.md)'s pipeline, so voice input and text input arrive
  at the interpretation state machine through the same events.
- `SherpaOnlineRecognizer` (feature `sherpa`) is the real engine, with a config
  (`SherpaOnlineRecognizerConfig`) that says which model files it needs — a missing model is
  a typed error at construction, not a silence at first utterance.
- Partial results are **partial**: the API keeps final and non-final hypotheses apart, so a
  UI never treats a half sentence as a translation.

It is **not** a VAD/diarization toolkit and does not bundle a model: it drives one.

## Layout

| file | what |
|---|---|
| `src/recognizer.rs` | `StreamingRecognizer`, `Hypothesis`, `MockStreamingRecognizer` |
| `src/pipeline.rs` | `AsrPipeline`, `AsrPipelineBuilder` (feeds `amos-int`) |
| `src/sherpa.rs` | *(feature `sherpa`)* `SherpaOnlineRecognizer`, `SherpaOnlineRecognizerConfig`, `sherpa_pipeline` |

## Build & test

```bash
cargo test -p amos-asr
cargo check -p amos-asr --features sherpa   # needs the sherpa-onnx native lib
cargo clippy -p amos-asr --all-targets -- -D warnings
```

## Examples

```bash
# The mock recognizer driving the pipeline: partial → final, with no model and no mic.
cargo run -p amos-asr --example recognition_stream
# Real engine (feature `sherpa`): needs a model directory + a wav file.
cargo run -p amos-asr --features sherpa --example sherpa_asr -- model_dir audio.wav
cargo run -p amos-asr --features sherpa --example sherpa_session -- model_dir audio.wav
```

| example | shows |
|---|---|
| `recognition_stream` | a scripted recognizer pushing partial and final hypotheses through `AsrPipeline` and what the consumer sees at each step |
| `sherpa_asr` | *(feature `sherpa`)* the real engine over a wav file: final text and timing |
| `sherpa_session` | *(feature `sherpa`)* a streaming session: partials arriving before the final |

## Honest boundaries

- **A model is required for real recognition** and is fetched by
  `scripts/fetch-models.sh`; without it the `sherpa` path refuses at construction.
- **No microphone here**: audio comes from [`crates/amos-audio`](../amos-audio/README.md)
  (real AAudio callbacks on device, a sine/mic mock on the host).
- **Accuracy belongs to the model**, not to this crate; what this crate guarantees is the
  event contract (partial vs final, bounded queues).
- The Sherpa FFI needs the on-device `.so`; the host needs the matching native library.

## Related

- [`crates/amos-audio`](../amos-audio/README.md) — capture and resampling into the format ASR wants.
- [`crates/amos-int`](../amos-int/README.md) · [`crates/amos-tts`](../amos-tts/README.md) — the
  rest of the speech loop.
