#!/usr/bin/env bash
# Amos smoke: bring up amos-ai + amos-translate daemons (mock), then the Tauri GUI.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"         # crates/amos-tauri
REPO="$(cd "$ROOT/../.." && pwd)"              # workspace root (has target/)
export AMOS_SOCKET=/tmp/amos-ai.sock
export AMOS_BACKEND=mock
export AMOS_TRANSLATE_BACKEND=mock
export RUST_LOG=info

pkill -f 'target/debug/amos-translate' 2>/dev/null || true
pkill -f 'target/debug/amos-ai' 2>/dev/null || true
rm -f /tmp/amos-ai.sock /tmp/amos-translate.sock

"$REPO/target/debug/amos-ai" -s "$AMOS_SOCKET" >/tmp/amos-ai.log 2>&1 &
AI_PID=$!

"$REPO/target/debug/amos-translate" -s /tmp/amos-translate.sock >/tmp/amos-translate.log 2>&1 &
TR_PID=$!

sleep 1
echo "amos-ai($AI_PID) + amos-translate($TR_PID) started"

cd "$ROOT"
exec cargo run 2>&1 | tee /tmp/amos-gui.log
