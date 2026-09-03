#!/usr/bin/env bash
# ai-backend.sh — one-command switch of the amos-ai inference backend.
#
#   scripts/ai-backend.sh local
#   scripts/ai-backend.sh deepseek [API_KEY]
#
# It stops the running amos-ai (pid file /tmp/amos-ai.pid), writes the chosen
# config to /tmp/amos-ai-backend.json, and starts amos-ai again with the env the
# provider needs (local → mock, deepseek → OpenAI-compatible api + DeepSeek).
#
# Env:
#   AMOS_ROOT   repo root that contains target/debug/amos-ai (default: script dir/..)
#   AMOS_SOCKET socket path (default /tmp/amos-ai.sock)
set -euo pipefail

ROOT="${AMOS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SOCK="${AMOS_SOCKET:-/tmp/amos-ai.sock}"
PIDFILE=/tmp/amos-ai.pid
CFG=/tmp/amos-ai-backend.json
BIN="$ROOT/target/debug/amos-ai"
[ -x "$BIN" ] || { echo "error: amos-ai not built at $BIN" >&2; exit 1; }

provider="${1:-}"
api_key="${2:-${AMOS_API_KEY:-}}"

# No args → resume the last selected backend from the saved config.
if [ -z "$provider" ] && [ -f "$CFG" ]; then
  saved="$(sed -n 's/.*"provider":"\([a-z]*\)".*/\1/p' "$CFG" | head -1)"
  case "$saved" in
    local|deepseek) provider="$saved" ;;
    *) provider=local ;;
  esac
  echo "resuming last backend: $provider (from $CFG)"
fi
[ -n "$provider" ] || provider=local

# Cloud key fallback: a persisted 0600 key file (written by the Tauri command).
CREDS="${AMOS_CRED_FILE:-$HOME/.amos/ai.key}"
if [ "$provider" = deepseek ] && [ -z "$api_key" ] && [ -f "$CREDS" ]; then
  api_key="$(tr -d '\r\n' < "$CREDS")"
  [ -n "$api_key" ] && echo "using saved cloud key ($CREDS)"
fi

# 1) Stop the current daemon (if any).
if [ -f "$PIDFILE" ]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    echo "stopping amos-ai (pid $old)"
    kill "$old"
    for _ in $(seq 1 20); do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$old" 2>/dev/null || true
  fi
fi
rm -f "$PIDFILE" "$SOCK"

# 2) Write config + build env.
case "$provider" in
  local)
    MODEL="mock"
    echo '{"provider":"local","backend":"mock"}' > "$CFG"
    ENVS=(env -u ALL_PROXY -u all_proxy AMOS_BACKEND=mock)
    ;;
  deepseek)
    MODEL="${DEEPSEEK_MODEL:-deepseek-chat}"
    EP="${DEEPSEEK_ENDPOINT:-https://api.deepseek.com/v1/chat/completions}"
    [ -n "$api_key" ] || { echo "error: deepseek requires an API key (arg or AMOS_API_KEY)" >&2; exit 1; }
    printf '{"provider":"deepseek","model":"%s","endpoint":"%s"}' "$MODEL" "$EP" > "$CFG"
    ENVS=(env -u ALL_PROXY -u all_proxy AMOS_BACKEND=api AMOS_API_ENDPOINT="$EP" AMOS_MODEL="$MODEL" AMOS_API_KEY="$api_key")
    # Persist the key (0600) so later switches/resumes need no re-entry.
    CREDS="${AMOS_CRED_FILE:-$HOME/.amos/ai.key}"
    mkdir -p "$(dirname "$CREDS")"
    printf '%s' "$api_key" > "$CREDS"
    chmod 600 "$CREDS"
    ;;
  *)
    echo "usage: $0 local|deepseek [API_KEY]" >&2
    exit 2
    ;;
esac

# 3) Start the new daemon.
"${ENVS[@]}" nohup "$BIN" >/tmp/amos-ai-daemon.log 2>&1 &
newpid=$!
echo "$newpid" > "$PIDFILE"
echo "started amos-ai backend=$provider (pid $newpid) model=$MODEL"

# 4) Wait for the socket to accept connections.
for _ in $(seq 1 50); do
  if [ -S "$SOCK" ]; then break; fi
  if ! kill -0 "$newpid" 2>/dev/null; then
    echo "error: daemon exited during startup; see /tmp/amos-ai-daemon.log" >&2
    tail -5 /tmp/amos-ai-daemon.log >&2 || true
    exit 1
  fi
  sleep 0.1
done
[ -S "$SOCK" ] || { echo "error: socket never appeared" >&2; exit 1; }
echo "ready: $SOCK"
