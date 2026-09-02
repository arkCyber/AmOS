#!/usr/bin/env bash
# End-to-end proof of the LOCAL MODEL chain, headless:
#
#   Piper TTS  →  (audio WAV)  →  sherpa-onnx streaming ASR  →  (text)
#     text                     →  amos-translate daemon  →  translated segment
#
# Piper + sherpa are REAL local models (offline). The translation stage runs
# through an amos-translate daemon; by default it starts a deterministic mock
# daemon on a temp socket (no network). To use a live daemon / provider instead,
# export AMOS_TRANSLATE_SOCKET pointing at a running daemon and the stage will
# reuse it (e.g. an ollama-backed daemon — note many ollama builds gate the
# OpenAI /v1/chat/completions endpoint behind auth and may return 401).
#
# Usage: scripts/e2e-local-models.sh [sentence]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SENT="${1:-The yellow lamps would light up here and there.}"
SHERPA_DIR="${SHERPA_MODEL_DIR:-$ROOT/models/sherpa-en-20m}"
PIPER_ONNX="$ROOT/models/piper-low/en_US-lessac-low.onnx"
PIPER_JSON="$ROOT/models/piper-low/en_US-lessac-low.onnx.json"
SRC_WAV="/tmp/amos_e2e_src.wav"
LIVE_SOCKET="${AMOS_TRANSLATE_SOCKET:-}"
SOCKET="${LIVE_SOCKET:-/tmp/amos-e2e.sock}"
DAEMON_PID=""

for f in "$SHERPA_DIR/tokens.txt" "$SHERPA_DIR/encoder-epoch-99-avg-1.int8.onnx" "$PIPER_ONNX" "$PIPER_JSON"; do
  [ -f "$f" ] || { echo "missing model file: $f (run bash scripts/fetch-models.sh)"; exit 2; }
done

# Build the examples + CLI if their binaries are missing.
[ -x "$ROOT/target/debug/examples/piper_tts" ] || (cd "$ROOT" && cargo build -q -p amos-tts --features piper --example piper_tts)
[ -x "$ROOT/target/debug/examples/sherpa_asr" ] || (cd "$ROOT" && cargo build -q -p amos-asr --features sherpa --example sherpa_asr)
[ -x "$ROOT/target/debug/amos-int-cli" ] || (cd "$ROOT" && cargo build -q -p amos-int-cli)
[ -x "$ROOT/target/debug/amos-translate" ] || (cd "$ROOT" && cargo build -q -p amos-translate)

# Translation daemon: reuse a live one when AMOS_TRANSLATE_SOCKET is set;
# otherwise start a deterministic mock daemon on a temp socket (no network).
start_daemon() {
  rm -f "$SOCKET"
  AMOS_TRANSLATE_BACKEND=mock AMOS_ASR_BACKEND=mock \
    "$ROOT/target/debug/amos-translate" --socket "$SOCKET" >/tmp/amos-e2e-daemon.log 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 60); do [ -S "$SOCKET" ] && break; sleep 0.1; done
  [ -S "$SOCKET" ] || { echo "daemon never bound $SOCKET"; cat /tmp/amos-e2e-daemon.log; exit 1; }
}
cleanup() { [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true; rm -f "$SRC_WAV"; if [ -z "$LIVE_SOCKET" ]; then rm -f "$SOCKET"; fi; }
trap cleanup EXIT
[ -n "$LIVE_SOCKET" ] || start_daemon
[ -S "$SOCKET" ] || { echo "no daemon at $SOCKET (start one or export AMOS_TRANSLATE_SOCKET)"; exit 1; }

echo "  [e2e] Piper -> sherpa -> daemon translate"
echo "  [e2e] source: $SENT"
echo "  [e2e] 1/3 Piper TTS …"
env -u ALL_PROXY -u all_proxy "$ROOT/target/debug/examples/piper_tts" "$SENT" "$PIPER_ONNX" "$PIPER_JSON" "$SRC_WAV" >/dev/null

echo "  [e2e] 2/3 sherpa ASR …"
ASR="$(SHERPA_MODEL_DIR="$SHERPA_DIR" env -u ALL_PROXY -u all_proxy \
  "$ROOT/target/debug/examples/sherpa_asr" "$SRC_WAV" 2>&1)"
echo "$ASR" | sed 's/^/        /'
TEXT="$(printf '%s\n' "$ASR" | grep -i '^FINAL:' | sed 's/^[Ff][Ii][Nn][Aa][Ll]: *//')"
if [ -z "$TEXT" ]; then echo "  [e2e] FAIL: no FINAL from sherpa"; exit 1; fi

echo "  [e2e] 3/3 daemon translate > ${TEXT}"
OUT="$(printf '%s\n.status\n.quit\n' "$TEXT" | timeout 120 "$ROOT/target/debug/amos-int-cli" --socket "$SOCKET" 2>&1)"
echo "$OUT" | sed 's/^/        /'
echo "$OUT" | grep -qi "$TEXT" || { echo "  [e2e] FAIL: translation did not round-trip text"; exit 1; }

echo "  [e2e] OK — Piper→sherpa→daemon translate works end-to-end."
