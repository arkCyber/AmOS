#!/usr/bin/env bash
# Run the amos System UI frontend from source (dev build).
#
# Why this exists: the amos-tauri *dev* binary loads the frontend from
# `http://localhost:5173` (tauri.conf.json `build.devUrl`) and does NOT embed
# assets, so without something serving `crates/amos-tauri/frontend` on :5173 the
# window shows a blank white page. This script starts that static server (if it
# isn't already up) and then launches the binary with the local-model features.
#
# Usage:
#   scripts/run-gui-dev.sh
# Env (all optional):
#   AMOS_UI_PORT          port for the frontend (default 5173)
#   AMOS_UI_FEATURES      cargo features for amos-tauri (default sherpa-asr,piper-tts;
#                         set "" to disable native local-model backends)
#   AMOS_SHERPA_MODEL_DIR / AMOS_PIPER_MODEL_DIR  model dirs (default under ./models)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI_DIR="$ROOT/crates/amos-tauri/frontend"
PORT="${AMOS_UI_PORT:-5173}"
FEAT="${AMOS_UI_FEATURES:-sherpa-asr,piper-tts}"

if ! lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "starting static server on :$PORT serving $UI_DIR"
  ( cd "$UI_DIR" && nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >/tmp/amos-www.log 2>&1 & )
  sleep 1
fi
echo "frontend dev server: http://localhost:$PORT/index.html"

cd "$ROOT"
if [ -n "$FEAT" ]; then
  cargo build -p amos-tauri --features "$FEAT"
else
  cargo build -p amos-tauri
fi

echo "launching amos System UI (features: ${FEAT:-none})..."
exec env -u ALL_PROXY -u all_proxy \
  AMOS_SHERPA_MODEL_DIR="${AMOS_SHERPA_MODEL_DIR:-$ROOT/models/sherpa-en-20m}" \
  AMOS_PIPER_MODEL_DIR="${AMOS_PIPER_MODEL_DIR:-$ROOT/models/piper-low}" \
  ./target/debug/amos-tauri
