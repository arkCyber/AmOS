# Native voice (sherpa ASR + Piper TTS) — status & test protocol

> Scope note: real local voice. This document records **what is implemented and
> verified headlessly**, **the two voice paths**, and **the recommended seam**, so
> the remaining window test has a clear protocol.

## Two voice paths (don't confuse them)

| Path | Mic → audio | ASR | Notes |
|---|---|---|---|
| **同传 native** (`interpret_audio`) | WebView `getUserMedia` → PCM | **local sherpa-onnx** via `amos-tauri/src/interpret.rs::local_sherpa_pipeline` (feature `sherpa-asr` + `AMOS_SHERPA_MODEL_DIR`) → daemon translation | This is the native local-ASR path. |
| VoiceMicButton (`transcribeAudio`) | WebView capture → WAV | **translate daemon** `Transcribe` (WhisperProvider / mock) | Remote/whole-buffer; **not** local sherpa. |

Piper TTS (`tts_synthesize`) runs on **both** (a final translation segment is
synthesized locally with `models/piper-*`).

## Verified headless (no GUI, real models)
- Piper TTS: `piper_tts` example → real WAV (16 kHz).
- sherpa streaming ASR: `sherpa_asr` example on `models/sherpa-en-20m/test_wavs/0.wav`.
- Whole-buffer reusable API (feature `sherpa`): `amos_asr::sherpa::decode_pcm16_wav`
  + `transcribe_buffer` — test passes against the real model + clip. Feeds in
  **6400-sample (400 ms)** chunks; too-fine chunks trip sherpa's frame assertion.
- Native UI runs with `--features sherpa-asr,piper-tts` + model dirs.

## Recommended seam (design decision)
Local streaming ASR lives in **`amos-asr` / `amos-tauri` native** (already wired for
同传). **Do not** embed sherpa into the `amos-translate` daemon: it would duplicate
the heavy native lib and drift from the intended seam (daemon `Transcribe` is for
remote/whole-buffer Whisper). `amos-asr` now exposes the whole-buffer helper if a
daemon recognizer is ever genuinely needed.

## Window test protocol (needs a human + a mic)
In the running native UI:
1. Open 「🌐 同传」 → ▶ 开始 (log should say `using local sherpa ASR from …`).
2. ① mic: hold 🎤, speak English 1–2 s → permission prompt?/recording indicator?
3. ② ASR: release → recognized English (partial → final) appears?
4. ③ Piper: tap 🔊 on a segment → audible speech?

Report ①/②/③ per stage (or the error text). macOS: the repo has no `Info.plist`
mic-permission description; if ① shows nothing at all, that is the most likely
cause → add an `NSMicrophoneUsageDescription` to the bundled app's plist and
re-run a bundled build.
