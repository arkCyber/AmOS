#!/usr/bin/env bash
# health-backends.sh — RPC readiness probe for the running daemons.
# Unlike a socket presence check, this calls each daemon's unary `get_status` and
# requires `running=true`; exits non-zero if either is down or not ready.
#
#   scripts/health-backends.sh [ai_sock] [translate_sock]
set -euo pipefail
ROOT="${AMOS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
AI_SOCK="${1:-${AMOS_SOCKET:-/tmp/amos-ai.sock}}"
TR_SOCK="${2:-${AMOS_TRANSLATE_SOCKET:-/tmp/amos-translate.sock}}"

cd "$ROOT"
echo "== amos-ai status =="
cargo run -q -p amos-ai --example status_once -- "$AI_SOCK" || { echo "FAIL: amos-ai not ready at $AI_SOCK" >&2; exit 1; }
echo "== amos-translate status =="
cargo run -q -p amos-translate --example status_once -- "$TR_SOCK" || { echo "FAIL: amos-translate not ready at $TR_SOCK" >&2; exit 1; }
echo "health OK"
