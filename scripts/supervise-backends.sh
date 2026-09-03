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
#   - deepseek needs a key: ~/.amos/ai.key (0600) or AMOS_API_KEY
# Env: AMOS_ROOT / AMOS_SOCKET / AMOS_TRANSLATE_SOCKET override paths.
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
  case "$provider" in local|deepseek) ;; *) provider=local ;; esac
fi

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
echo "== supervising AI backend=$provider under amos-supervisor =="
exec "$ROOT/target/debug/amos-supervisor" run "$SPEC"
