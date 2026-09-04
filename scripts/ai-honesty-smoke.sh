#!/usr/bin/env bash
# ai-honesty-smoke.sh — host-side proof that the AI daemon TRUTHFULLY reports
# which inference engine it is serving (engine / degraded / asr in get_status),
# instead of silently pretending a mock engine is real inference.
#
# Verifies over the real UDS RPC (status_once -> get_status):
#   * AMOS_BACKEND=mock       -> engine=mock   degraded=false   (mock is the
#     default; NOT a "degradation")
#   * AMOS_BACKEND=hermes + an unreachable server -> engine=mock degraded=true
#     (a REAL engine was requested but init failed -> honest degraded flag)
#   * AMOS_BACKEND=ollama     -> engine=ollama degraded=false when a local Ollama
#     is reachable; otherwise engine=mock degraded=true (status matches reality
#     either way)
#
# Requires: built target/debug/amos-ai + examples/status_once (script builds them).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

AI="target/debug/amos-ai"
STATUS="target/debug/examples/status_once"

die() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

cargo build -q -p amos-ai --bin amos-ai
cargo build -q -p amos-ai --example status_once

S1="/tmp/amos-honest-mock-$$.sock"
S2="/tmp/amos-honest-hermes-$$.sock"
S3="/tmp/amos-honest-ollama-$$.sock"
L1="/tmp/amos-honest-mock-$$.log"
L2="/tmp/amos-honest-hermes-$$.log"
L3="/tmp/amos-honest-ollama-$$.log"

cleanup() { rm -f "$S1" "$S2" "$S3" "$L1" "$L2" "$L3"; }
trap cleanup EXIT

wait_sock() { # path
  local p="$1"
  for _ in $(seq 1 100); do
    [ -S "$p" ] && return 0
    sleep 0.05
  done
  return 1
}

probe() { # socket -> the whole status_once line
  "$STATUS" "$1" 2>&1
}

field() { # status_line field_name -> value
  echo "$1" | tr ' ' '\n' | grep -o "^$2=[^ ]*" | head -1 | cut -d= -f2
}

# --- 1) mock: default dev engine, never "degraded" ---------------------------
AMOS_BACKEND=mock "$AI" --socket "$S1" >"$L1" 2>&1 &
P1=$!
wait_sock "$S1" || die "mock daemon socket not up (see $L1)"
OUT=$(probe "$S1")
echo "  mock:   $OUT"
[ "$(field "$OUT" running)" = true ] || die "mock should be running"
[ "$(field "$OUT" engine)" = mock ] || die "mock engine must report mock"
[ "$(field "$OUT" degraded)" = false ] || die "mock-as-default is NOT degraded"
pass "mock -> engine=mock degraded=false"
kill "$P1" 2>/dev/null
wait "$P1" 2>/dev/null || true

# --- 2) hermes requested but unreachable -> degraded=true (honest fallback) ---
AMOS_BACKEND=hermes "$AI" --socket "$S2" >"$L2" 2>&1 &
P2=$!
wait_sock "$S2" || die "hermes daemon socket not up (see $L2)"
OUT=$(probe "$S2")
echo "  hermes: $OUT"
[ "$(field "$OUT" degraded)" = true ] || die "requested-real-but-unreachable must degrade honestly"
[ "$(field "$OUT" engine)" = mock ] || die "degraded daemon serves the mock engine"
pass "hermes(unreachable) -> engine=mock degraded=true"
kill "$P2" 2>/dev/null
wait "$P2" 2>/dev/null || true

# --- 3) ollama: engine follows reality (reachable => real; absent => degraded) -
HOST="${AMOS_OLLAMA_HOST:-http://localhost:11434}"
if curl -fsS --noproxy '*' --max-time 2 "$HOST/api/tags" >/dev/null 2>&1; then
  expect_engine=ollama
  expect_degraded=false
else
  expect_engine=mock
  expect_degraded=true
fi
AMOS_BACKEND=ollama AMOS_OLLAMA_HOST="$HOST" "$AI" --socket "$S3" >"$L3" 2>&1 &
P3=$!
wait_sock "$S3" || die "ollama daemon socket not up (see $L3)"
OUT=$(probe "$S3")
echo "  ollama: $OUT"
[ "$(field "$OUT" engine)" = "$expect_engine" ] \
  || die "ollama engine should be $expect_engine (got $(field "$OUT" engine))"
[ "$(field "$OUT" degraded)" = "$expect_degraded" ] \
  || die "ollama degraded should be $expect_degraded (got $(field "$OUT" degraded))"
pass "ollama -> engine=$expect_engine degraded=$expect_degraded (matches reachability)"
kill "$P3" 2>/dev/null
wait "$P3" 2>/dev/null || true

cleanup
echo
echo "== honesty smoke OK: daemon reports its real engine & degraded state =="
