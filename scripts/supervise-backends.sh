#!/usr/bin/env bash
# supervise-backends.sh — run amos-ai + amos-translate under amos-supervisor,
# with amos-ai honoring the *persisted* local/cloud backend config, so crashes
# are auto-restarted and SIGUSR1 hot-restarts work under supervision.
#
#   scripts/supervise-backends.sh                 # run (foreground supervisor)
#   scripts/supervise-backends.sh --print-config  # just print the generated JSON
#   scripts/supervise-backends.sh --dry-run       # validate + print, no run
#
# Backend resolution mirrors scripts/ai-backend.sh:
#   - provider from /tmp/amos-ai-backend.json (default: local)
#   - `local` = a real local Ollama when reachable; the deterministic mock is
#     only the offline/dev fallback. `ollama` forces real, `mock` forces offline.
#   - deepseek needs a key: ~/.amos/ai.key (0600) or AMOS_API_KEY
# Env: AMOS_ROOT / AMOS_SOCKET / AMOS_TRANSLATE_SOCKET / AMOS_OLLAMA_HOST /
#      AMOS_LOCAL_MODE (auto|ollama|mock) override paths.
set -euo pipefail

ROOT="${AMOS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
AI_SOCK="${AMOS_SOCKET:-/tmp/amos-ai.sock}"
TR_SOCK="${AMOS_TRANSLATE_SOCKET:-/tmp/amos-translate.sock}"
CFG=/tmp/amos-ai-backend.json
CREDS="${AMOS_CRED_FILE:-$HOME/.amos/ai.key}"

mode="${1:-run}"

provider="local"
if [ -f "$CFG" ]; then
  provider="$(sed -n 's/.*"provider":"\([a-z]*\)".*/\1/p' "$CFG" | head -1)"
  case "$provider" in local|ollama|mock|deepseek) ;; *) provider=local ;; esac
fi

# Is a local Ollama server reachable? (used by the `local` resolver; mirrors
# scripts/ai-backend.sh)
ollama_up() {
  local host="${1:-http://localhost:11434}"
  local url="${host%/}/api/tags"
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --noproxy '*' --max-time 1 "$url" >/dev/null 2>&1
}
OLLAMA_HOST="${AMOS_OLLAMA_HOST:-http://localhost:11434}"
local_mode="${AMOS_LOCAL_MODE:-auto}"

# amos-ai env pairs
ai_env='["AMOS_BACKEND","mock"],["AMOS_SOCKET","'"$AI_SOCK"'"]'
if [ "$provider" = deepseek ]; then
  key=""
  if [ -n "${AMOS_API_KEY:-}" ]; then key="$AMOS_API_KEY"
  elif [ -f "$CREDS" ]; then key="$(tr -d '\r\n' < "$CREDS")"; fi
  if [ "$mode" != "--print-config" ] && [ "$mode" != "--dry-run" ] && [ -z "$key" ]; then
    echo "error: deepseek backend needs a key (AMOS_API_KEY or $CREDS)" >&2; exit 1
  fi
  model="${DEEPSEEK_MODEL:-deepseek-chat}"
  ep="${DEEPSEEK_ENDPOINT:-https://api.deepseek.com/v1/chat/completions}"
  ai_env='["AMOS_BACKEND","api"],["AMOS_SOCKET","'"$AI_SOCK"'"],["AMOS_API_ENDPOINT","'"$ep"'"],["AMOS_MODEL","'"$model"'"],["AMOS_API_KEY","'"$key"'"]'
fi

# `local` / `ollama` / `mock`: `local` means real on-device inference via a
# reachable local Ollama; the deterministic mock is only the offline/dev
# fallback (mirrors scripts/ai-backend.sh). mock forces offline, ollama forces
# the real engine. deepseek was resolved above and overrides ai_env.
if [ "$provider" != deepseek ]; then
  want_mock=0; forced_ollama=0
  if [ "$provider" = mock ] || { [ "$provider" = local ] && [ "$local_mode" = mock ]; }; then
    want_mock=1
  fi
  if [ "$provider" = ollama ] || { [ "$provider" = local ] && [ "$local_mode" = ollama ]; }; then
    forced_ollama=1
  fi
  if [ "$want_mock" = 0 ] && { [ "$forced_ollama" = 1 ] || ollama_up "$OLLAMA_HOST"; }; then
    ai_env='["AMOS_BACKEND","ollama"],["AMOS_SOCKET","'"$AI_SOCK"'"],["AMOS_OLLAMA_HOST","'"$OLLAMA_HOST"'"]'
    resolved=ollama
  else
    ai_env='["AMOS_BACKEND","mock"],["AMOS_SOCKET","'"$AI_SOCK"'"]'
    resolved=mock
  fi
else
  resolved=deepseek
fi

tr_env='["AMOS_TRANSLATE_BACKEND","mock"]'
[ -n "${AMOS_TRANSLATE_HOST:-}" ] && tr_env="$tr_env,[\"AMOS_TRANSLATE_HOST\",\"$AMOS_TRANSLATE_HOST\"]"
[ -n "${AMOS_TRANSLATE_MODEL:-}" ] && tr_env="$tr_env,[\"AMOS_TRANSLATE_MODEL\",\"$AMOS_TRANSLATE_MODEL\"]"
[ -n "${AMOS_TRANSLATE_API_KEY:-}" ] && tr_env="$tr_env,[\"AMOS_TRANSLATE_API_KEY\",\"$AMOS_TRANSLATE_API_KEY\"]"

json() {
  printf '{"daemons":['
  printf '{"name":"ai","program":"%s/target/debug/amos-ai","args":[],"env":[%s],"restart":{"max_restarts":5,"backoff_secs":1,"backoff_factor":2}},' "$ROOT" "$ai_env"
  printf '{"name":"translate","program":"%s/target/debug/amos-translate","args":["-s","%s"],"env":[%s],"restart":{"max_restarts":5,"backoff_secs":1,"backoff_factor":2}}' "$ROOT" "$TR_SOCK" "$tr_env"
  printf ']}'
}

mode="${1:-run}"
if [ "$mode" = "--print-config" ] || [ "$mode" = "--dry-run" ]; then
  json
  echo
  exit 0
fi

SPEC="$(mktemp /tmp/amos-supervisor-XXXXXX.json)"
trap 'rm -f "$SPEC"' EXIT
json > "$SPEC"
echo "== supervising AI backend=$resolved under amos-supervisor =="
exec "$ROOT/target/debug/amos-supervisor" run "$SPEC"
