#!/usr/bin/env bash
# Local dev loop (desktop): run the AI daemon, then the Tauri System UI.
# Simulates the no-UI boot orchestration on the host for fast iteration.
#
# The System UI debug binary loads its frontend from `tauri.conf.json` `build.devUrl`
# (http://localhost:1420) and does not embed assets, so a Vite dev server must be up —
# otherwise the window opens onto nothing served (REQ-A189: this script used to skip
# that, and `make run-ui-dev` was the only loop that got it right). Started here if the
# port is free, using the same check `scripts/run-gui-dev.sh` uses.
#
#   make dev            # this script
#   scripts/dev.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SOCK="${AMOS_SOCKET:-/tmp/amos-ai.sock}"
UI_DIR="$(pwd)/crates/amos-tauri/frontend-ts"
PORT=1420

if ! lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "==> Vite dev server on :$PORT ($UI_DIR)"
  ( cd "$UI_DIR" && nohup bun run dev >/tmp/amos-vite.log 2>&1 & )
  for _ in $(seq 1 40); do
    lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.5
  done
  lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 ||
    echo "    warning: :$PORT is still not listening (see /tmp/amos-vite.log); the window may be blank" >&2
fi

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
