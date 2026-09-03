#!/usr/bin/env bash
# run-backends.sh — production-ish boot entry: start the backends the System UI
# needs, honoring the *persisted* AI-backend choice (so a restart picks up the
# last-selected local/cloud provider automatically).
#
#   scripts/run-backends.sh            # amos-ai (persisted or local) + translate
# Env (optional):
#   AMOS_ROOT        repo root (default: script dir/..)
#   AMOS_SOCKET      amos-ai socket   (default /tmp/amos-ai.sock)
#   AMOS_TRANSLATE_SOCKET   translate socket (default /tmp/amos-translate.sock)
#   AMOS_TRANSLATE_BACKEND  translate backend: mock (default) | ollama
#   AMOS_TRANSLATE_HOST / AMOS_TRANSLATE_MODEL / AMOS_TRANSLATE_API_KEY
set -euo pipefail

ROOT="${AMOS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
AI_SOCK="${AMOS_SOCKET:-/tmp/amos-ai.sock}"
TR_SOCK="${AMOS_TRANSLATE_SOCKET:-/tmp/amos-translate.sock}"
CFG=/tmp/amos-ai-backend.json

echo "==> amos-ai (backend config: ${CFG:-none})"
# ai-backend.sh with no args resumes the last selected provider (or defaults to
# local when there is no persisted config), stopping/starting amos-ai as needed.
"$ROOT/scripts/ai-backend.sh"

echo "==> amos-translate"
# Only start translate when nothing is already serving its socket.
if [ ! -S "$TR_SOCK" ]; then
  backend="${AMOS_TRANSLATE_BACKEND:-mock}"
  env_args=(env -u ALL_PROXY -u all_proxy "AMOS_TRANSLATE_BACKEND=$backend")
  [ -n "${AMOS_TRANSLATE_HOST:-}" ] && env_args+=("AMOS_TRANSLATE_HOST=$AMOS_TRANSLATE_HOST")
  [ -n "${AMOS_TRANSLATE_MODEL:-}" ] && env_args+=("AMOS_TRANSLATE_MODEL=$AMOS_TRANSLATE_MODEL")
  [ -n "${AMOS_TRANSLATE_API_KEY:-}" ] && env_args+=("AMOS_TRANSLATE_API_KEY=$AMOS_TRANSLATE_API_KEY")
  ( "${env_args[@]}" nohup "$ROOT/target/debug/amos-translate" --socket "$TR_SOCK" \
      >/tmp/amos-translate.log 2>&1 & )
else
  echo "translate daemon already serving $TR_SOCK (leaving it alone)"
fi

# Wait for both sockets to accept connections.
for name in "$AI_SOCK" "$TR_SOCK"; do
  for _ in $(seq 1 50); do
    if [ -S "$name" ] && python3 - "$name" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket(socket.AF_UNIX)
try:
    s.connect(sys.argv[1]); s.close(); raise SystemExit(0)
except Exception:
    raise SystemExit(1)
PY
    then break
    fi
    sleep 0.1
  done
  [ -S "$name" ] || { echo "error: $name not ready" >&2; exit 1; }
  echo "ready: $name"
done

echo "backends up (AI backend=$(sed -n 's/.*"provider":"\([a-z]*\)".*/\1/p' "$CFG" | head -1))"
echo "logs: /tmp/amos-ai-daemon.log /tmp/amos-translate.log"

# Optional strict gate: require RPC `get_status` running=true on both daemons.
if [ "${1:-}" = "--health" ]; then
  "$ROOT/scripts/health-backends.sh"
  echo "RPC health gate passed"
fi
