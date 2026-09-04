#!/usr/bin/env bash
# ai-backend.sh — one-command switch of the amos-ai inference backend.
#
#   scripts/ai-backend.sh local            # prefer a real local Ollama; else mock
#   scripts/ai-backend.sh ollama           # force the local Ollama engine
#   scripts/ai-backend.sh mock             # force the deterministic mock (offline/dev)
#   scripts/ai-backend.sh deepseek [API_KEY]
#
# It stops the running amos-ai (pid file /tmp/amos-ai.pid), writes the chosen
# config to /tmp/amos-ai-backend.json, and starts amos-ai again with the env the
# provider needs. `local` means *real on-device inference via a local Ollama*
# when one is reachable — the deterministic mock is used only as an offline/dev
# fallback (never the product default).
#
# Env:
#   AMOS_ROOT   repo root that contains target/debug/amos-ai (default: script dir/..)
#   AMOS_SOCKET socket path (default /tmp/amos-ai.sock)
#   AMOS_OLLAMA_HOST   Ollama base URL (default http://localhost:11434)
#   AMOS_MODEL         Ollama model id (default: auto-select the first installed)
#   AMOS_LOCAL_MODE    local resolution: auto | ollama | mock  (default auto)
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
    local|ollama|mock|deepseek) provider="$saved" ;;
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

# Reachability probe for a local Ollama server (used by the `local` resolver).
# Returns 0 when /api/tags answers within ~1 s; curls with no proxy so a stray
# HTTP(S)_PROXY cannot make a localhost probe fail or route it externally.
ollama_up() {
  local host="${1:-http://localhost:11434}"
  local url="${host%/}/api/tags"
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --noproxy '*' --max-time 1 "$url" >/dev/null 2>&1
}

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
    # "Local" = real on-device inference via a reachable local Ollama; the
    # deterministic mock is used only when Ollama is offline (or forced).
    OLLAMA_HOST="${AMOS_OLLAMA_HOST:-http://localhost:11434}"
    mode="${AMOS_LOCAL_MODE:-auto}"
    backend=ollama
    if [ "$mode" = mock ]; then
      backend=mock
    elif [ "$mode" = ollama ]; then
      backend=ollama
    elif ! ollama_up "$OLLAMA_HOST"; then
      echo "note: no reachable Ollama at $OLLAMA_HOST — falling back to the deterministic mock (use 'ollama' to force, or set AMOS_LOCAL_MODE=ollama to make absence a hard stop)"
      backend=mock
    fi
    if [ "$backend" = ollama ]; then
      MODEL="${AMOS_MODEL:-}"   # empty -> daemon auto-selects the first installed model
      printf '{"provider":"local","backend":"ollama","host":"%s"}' "$OLLAMA_HOST" > "$CFG"
      ENVS=(env -u ALL_PROXY -u all_proxy AMOS_BACKEND=ollama AMOS_OLLAMA_HOST="$OLLAMA_HOST")
    else
      MODEL="mock"
      echo '{"provider":"local","backend":"mock"}' > "$CFG"
      ENVS=(env -u ALL_PROXY -u all_proxy AMOS_BACKEND=mock)
    fi
    ;;

  mock)
    MODEL="mock"
    echo '{"provider":"mock","backend":"mock"}' > "$CFG"
    ENVS=(env -u ALL_PROXY -u all_proxy AMOS_BACKEND=mock)
    ;;

  ollama)
    OLLAMA_HOST="${AMOS_OLLAMA_HOST:-http://localhost:11434}"
    MODEL="${AMOS_MODEL:-}"   # empty -> daemon auto-selects the first installed model
    printf '{"provider":"ollama","backend":"ollama","host":"%s"}' "$OLLAMA_HOST" > "$CFG"
    ENVS=(env -u ALL_PROXY -u all_proxy AMOS_BACKEND=ollama AMOS_OLLAMA_HOST="$OLLAMA_HOST")
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
    echo "usage: $0 local|ollama|mock|deepseek [API_KEY]" >&2
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
