#!/usr/bin/env bash
# Run the amos System UI in dev with the React/TS (Vite) frontend on :1420.
#
# The amos-tauri *dev* binary loads the frontend from tauri.conf.json
# `build.devUrl` (http://localhost:1420) and does NOT embed assets, so a Vite dev
# server must be up. This script starts `bun run dev` for frontend-ts (if the port
# isn't already served) and then launches the binary with the local-model features.
#
# Usage:
#   scripts/run-gui-dev.sh
# Env (all optional):
#   AMOS_UI_FEATURES      cargo features for amos-tauri (default sherpa-asr,piper-tts;
#                         set "" to disable native local-model backends)
#   AMOS_SHERPA_MODEL_DIR / AMOS_PIPER_MODEL_DIR  model dirs (default under ./models)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI_DIR="$ROOT/crates/amos-tauri/frontend-ts"
PORT="1420"
FEAT="${AMOS_UI_FEATURES:-sherpa-asr,piper-tts}"

if ! lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "starting Vite dev server on :$PORT ($UI_DIR)"
  ( cd "$UI_DIR" && nohup bun run dev >/tmp/amos-vite.log 2>&1 & )
  # Wait for the port to accept connections (up to ~20s).
  for _ in $(seq 1 40); do
    if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
fi
echo "System UI dev server: http://localhost:$PORT"

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
