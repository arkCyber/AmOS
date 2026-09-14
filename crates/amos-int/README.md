# amos-int — simultaneous interpretation session engine

The state machine and streaming pipeline behind 同传 (live interpretation): ASR → translation
→ TTS, with a both-directions mode, segment bookkeeping and an event stream a UI can render.
Transport-agnostic: the pipeline is a seam, so the loop is testable with no daemon, no model
and no microphone. Part of **[Amos](../../README.md)**. Design record:
[`docs/interpretation-architecture.md`](../../docs/interpretation-architecture.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `SessionConfig` / `BothMode`: one speaker or two, and how the two directions interleave.
- `Pipeline` (`MockPipeline`) is the seam: feed `AsrEvent`s (partial/final), receive
  `Translation` and `TtsAudio`. `MockPipeline` makes every session rule deterministic in
  tests; the real one lives in [`crates/amos-translate`](../amos-translate/README.md) +
  [`crates/amos-asr`](../amos-asr/README.md) + [`crates/amos-tts`](../amos-tts/README.md).
- `segment.rs` + `state.rs`: segments are numbered and finalized once — a partial never
  becomes a second translation, and a session's state is explicit (`SessionEvent`,
  `EndReason`).
- `language.rs`: `Language` / `LanguagePair` are validated, so a session cannot be started
  with an unknown pair.
- `InterpretationOutput` is the one document a UI renders (text, translation, timing), used
  by both the CLI and the System UI.

It is **not** a speech recognizer, translator or synthesizer: it composes those. It also does
not do diarization ("who spoke" beyond the configured direction).

## Layout

| file | what |
|---|---|
| `src/state.rs` · `src/event.rs` | the session state machine and its events (`SessionEvent`, `InterpretationOutput`, `TtsRequest`, `EndReason`) |
| `src/segment.rs` | segment numbering/finalisation |
| `src/pipeline.rs` | `Pipeline`, `MockPipeline`, `AsrEvent`, `Translation`, `TtsAudio`, `PipelineInfo` |
| `src/config.rs` | `SessionConfig`, `BothMode` |
| `src/language.rs` | `Language`, `LanguagePair` |
| `src/error.rs` | `InterpretationError`, `Result` |

## Build & test

```bash
cargo test -p amos-int
cargo clippy -p amos-int --all-targets -- -D warnings
cargo fmt -p amos-int -- --check
```

## Examples

```bash
# A whole session on the mock pipeline: partials, finals, translation, speech.
cargo run -p amos-int --example mock_session
```

| example | shows |
|---|---|
| `mock_session` | a session driven end to end on `MockPipeline`: a partial that is not translated, a final that is, the TTS request it produces, segment numbering, and a clean session end with its `EndReason` |

## Honest boundaries

- **The mock is the test double, not the feature**: real recognition/translation/synthesis
  need their own crates, models and (for audio) a device.
- **Latency is not claimed here**: the session reports what it observed; measured numbers come
  from the profiling crate.
- **One pair at a time**: `LanguagePair` is fixed for a session.
- **Noise, overlapping speakers and code-switching** are outside the state machine's model —
  the design record states this rather than implying robustness.

## Related

- [`docs/interpretation-architecture.md`](../../docs/interpretation-architecture.md) — states,
  events and the both-directions mode.
- [`crates/amos-asr`](../amos-asr/README.md) · [`crates/amos-translate`](../amos-translate/README.md)
  · [`crates/amos-tts`](../amos-tts/README.md) — the three stages it composes.
- [`crates/amos-int-cli`](../amos-int-cli/README.md) — the terminal front end.
