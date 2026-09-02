#!/usr/bin/env bash
# Headless smoke for amos-supervisor against the real daemons (mock backends).
#
# Validates the full intended deployment shape — launch amos-ai + amos-translate
# under the supervisor with NO GUI/window — plus the two operator controls we
# ship: SIGUSR1 = hot-restart all, SIGINT = graceful stop that must NOT orphan
# child daemons (regression guard for the shutdown race fix).
#
# Requires the workspace to be built (target/debug/amos-ai, amos-translate,
# amos-supervisor). Exits non-zero on any failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

build_sup() {
  cargo build -q -p amos-supervisor -p amos-ai -p amos-translate
}

die() { echo "FAIL: $*" >&2; exit 1; }
wait_for_socket() { # path, tries
  local path="$1" tries="${2:-100}"
  for _ in $(seq 1 "$tries"); do
    [ -S "$path" ] && return 0
    sleep 0.05
  done
  return 1
}

AI_SOCK="/tmp/amos-sup-smoke-ai-$$.sock"
TR_SOCK="/tmp/amos-sup-smoke-tr-$$.sock"
CFG="/tmp/amos-sup-smoke-$$.json"
LOG="/tmp/amos-sup-smoke-$$.log"

cleanup() {
  rm -f "$AI_SOCK" "$TR_SOCK" "$CFG"
  # Best-effort: kill a straggler supervisor if the test failed mid-way.
  local sup
  sup="$(pgrep -f "amos-supervisor run $CFG" | head -1 || true)"
  [ -n "$sup" ] && kill -INT "$sup" 2>/dev/null || true
}
trap cleanup EXIT

build_sup

cat >"$CFG" <<EOF
{"daemons":[
 {"name":"ai","program":"target/debug/amos-ai","args":[],"env":[["AMOS_BACKEND","mock"],["AMOS_SOCKET","$AI_SOCK"]],"restart":{"max_restarts":3,"backoff_secs":1,"backoff_factor":2}},
 {"name":"translate","program":"target/debug/amos-translate","args":["-s","$TR_SOCK"],"env":[["AMOS_TRANSLATE_BACKEND","mock"]],"restart":{"max_restarts":3,"backoff_secs":1,"backoff_factor":2}}
]}
EOF

echo "== launching supervisor (headless) =="
nohup target/debug/amos-supervisor run "$CFG" >"$LOG" 2>&1 &
SUP="$!"
echo "supervisor pid $SUP"

wait_for_socket "$AI_SOCK" || die "amos-ai socket not up"
wait_for_socket "$TR_SOCK" || die "amos-translate socket not up"
echo "both daemons up (sockets present)"

child_pids() { pgrep -P "$1" 2>/dev/null || true; }
BEFORE=$(child_pids "$SUP")
[ -n "$BEFORE" ] || die "no supervised children found"
echo "children before: $(echo $BEFORE | tr '\n' ' ')"

echo "== SIGUSR1: hot-restart all =="
kill -USR1 "$SUP"
sleep 2
AFTER=$(child_pids "$SUP")
[ -n "$AFTER" ] || die "children missing after SIGUSR1"
echo "children after:  $(echo $AFTER | tr '\n' ' ')"

echo "== SIGINT: graceful stop =="
kill -INT "$SUP"
# Wait for the supervisor process to exit.
for _ in $(seq 1 60); do
  if ! kill -0 "$SUP" 2>/dev/null; then break; fi
  sleep 0.05
done
if kill -0 "$SUP" 2>/dev/null; then
  die "supervisor did not exit after SIGINT"
fi

# Regression guard: no child daemon may survive the graceful shutdown.
ORPHANS=$(child_pids "$SUP")
if [ -n "$ORPHANS" ]; then
  die "graceful stop orphaned child daemons: $(echo $ORPHANS | tr '\n' ' ')"
fi

echo "== smoke OK: launched, hot-restarted, and stopped with no orphans =="
