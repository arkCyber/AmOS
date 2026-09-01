#!/usr/bin/env bash
# Local dev loop (desktop): run the AI daemon, then the Tauri System UI.
# Simulates the no-UI boot orchestration on the host for fast iteration.
set -euo pipefail
cd "$(dirname "$0")/.."

SOCK="${AMOS_SOCKET:-/tmp/amos-ai.sock}"

echo "==> amos-ai (socket: $SOCK)"
(cargo run -p amos-ai -- --socket "$SOCK") &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null || true' EXIT

# Wait for the socket to appear before starting the UI.
for _ in $(seq 1 50); do [[ -S "$SOCK" ]] && break; sleep 0.1; done

echo "==> amos-tauri"
echo "    多窗口/跨窗口同步核对清单: docs/gui-verify.md"
AMOS_SOCKET="$SOCK" cargo run -p amos-tauri

kill "$DAEMON" 2>/dev/null || true
