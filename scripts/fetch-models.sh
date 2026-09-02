#!/usr/bin/env bash
# Fetch local inference models for the interpretation stack.
#
#   ASR: sherpa-onnx streaming zipformer English (int8) — feeds amos-asr
#        SherpaOnlineRecognizer (feature `sherpa`).
#   TTS: Piper en_US voice (medium) — feeds amos-tts PiperProvider (feature
#        `piper`). Requires espeak-ng at runtime: `brew install espeak-ng`.
#
# Downloads are serial (one at a time) with retries — a parallel/background
# fetch can truncate a large model and make onnxruntime throw at load.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASR_DIR="$ROOT/models/sherpa-en-20m"
PIPER_DIR="$ROOT/models/piper-en_US-lessac-medium"
ASR_REPO="csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17"
ASR_FILES="tokens.txt encoder-epoch-99-avg-1.int8.onnx decoder-epoch-99-avg-1.int8.onnx joiner-epoch-99-avg-1.int8.onnx test_wavs/0.wav test_wavs/trans.txt"
# Piper voice files (HF rhasspy/piper-voices, en_US/lessac/medium).
PIPER_REPO="rhasspy/piper-voices"
PIPER_FILES="en/en_US/lessac/medium/en_US-lessac-medium.onnx en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"

hf_dl() { # hf_dl <repo> <subpath> <dest>
  local repo="$1" sub="$2" dest="$3"
  local url="https://huggingface.co/${repo}/resolve/main/${sub}"
  echo "  [fetch] $sub"
  env -u ALL_PROXY -u all_proxy curl -sL --retry 5 -o "$dest" "$url"
  if [ ! -s "$dest" ]; then echo "  [fetch] FAILED: $sub"; exit 1; fi
}

echo "[fetch] ASR model -> $ASR_DIR"
mkdir -p "$ASR_DIR/test_wavs"
for f in $ASR_FILES; do
  hf_dl "$ASR_REPO" "$f" "$ASR_DIR/$f"
done

echo "[fetch] Piper voice -> $PIPER_DIR"
mkdir -p "$PIPER_DIR"
for f in $PIPER_FILES; do
  hf_dl "$PIPER_REPO" "$f" "$PIPER_DIR/$(basename "$f")"
done

echo "[fetch] done."
echo
echo "Run real ASR:"
echo "  cargo run -p amos-asr --example sherpa_asr --features sherpa -- models/sherpa-en-20m/test_wavs/0.wav"
echo "Piper TTS needs espeak-ng: brew install espeak-ng"
