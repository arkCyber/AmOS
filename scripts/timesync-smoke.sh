#!/usr/bin/env bash
# Headless end-to-end smoke for the Amos time-sync line.
#
# Proves the real, feature-gated binaries interoperate over the shared
# last-known-good clock state:
#   1. amos-supervisor (--features timesync, AMOS_TIMESYNC=1) runs a periodic
#      calibration loop, persists <state>, and exports AMOS_TIMESYNC_STATE to the
#      child daemons it launches.
#   2. A supervised child actually inherits AMOS_TIMESYNC_STATE (writes it out).
#   3. amos-timesync-cli `status` reads that same <state> and reports a calibrated
#      (synced) clock.
#   4. SIGINT gracefully stops the supervisor with no orphaned children.
#
# Requires the timesync builds to exist (this script builds them). No network is
# used: the offline host clock is the time source. Exits non-zero on any failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

die() { echo "FAIL: $*" >&2; exit 1; }

echo "== building supervisor (timesync) + cli =="
cargo build -q -p amos-supervisor --features timesync
cargo build -q -p amos-timesync-cli

STATE="/tmp/amos-ts-smoke-$$.state.json"
ENVFILE="/tmp/amos-ts-smoke-$$.child-env"
CFG="/tmp/amos-ts-smoke-$$.json"
LOG="/tmp/amos-ts-smoke-$$.log"

cleanup() {
  rm -f "$STATE" "$ENVFILE" "$CFG" "$LOG"
  # Best-effort: kill a straggler supervisor if the test failed mid-way.
  local sup
  sup="$(pgrep -f "amos-supervisor run $CFG" | head -1 || true)"
  [ -n "$sup" ] && kill -9 "$sup" 2>/dev/null || true
}
trap cleanup EXIT

cat >"$CFG" <<EOF
{"daemons":[
 {"name":"envprobe","program":"sh","args":["-c","echo \"\$AMOS_TIMESYNC_STATE\" > $ENVFILE; exec sleep 30"],"env":[],"restart":{"max_restarts":0,"backoff_secs":0,"backoff_factor":1}}
]}
EOF

echo "== launching supervisor (headless, timesync enabled) =="
AMOS_TIMESYNC=1 AMOS_TIMESYNC_STATE="$STATE" \
  nohup target/debug/amos-supervisor run "$CFG" >"$LOG" 2>&1 &
SUP=$!
echo "supervisor pid $SUP"

# Wait for the calibration pass to persist the state file.
for _ in $(seq 1 100); do
  [ -f "$STATE" ] && break
  sleep 0.05
done
[ -f "$STATE" ] || die "supervisor never persisted the clock state (see $LOG)"

echo "== startup log =="
sed -n '1,20p' "$LOG"

grep -q "time sync: enabled" "$LOG" || die "supervisor did not report time-sync enabled"

# The supervised child must have inherited AMOS_TIMESYNC_STATE.
sleep 0.5
if [ ! -f "$ENVFILE" ]; then
  die "supervised child did not inherit AMOS_TIMESYNC_STATE"
fi
GOT="$(cat "$ENVFILE")"
[ "$GOT" = "$STATE" ] || die "child saw AMOS_TIMESYNC_STATE=$GOT (expected $STATE)"
echo "child inherited AMOS_TIMESYNC_STATE=$GOT"

# The CLI must read the same state and report a calibrated clock.
echo "== amos-timesync-cli status --state $STATE =="
OUT="$(target/debug/amos-timesync-cli status --state "$STATE")"
echo "$OUT"
echo "$OUT" | grep -q "corrected now" || die "cli status did not report corrected time"
echo "$OUT" | grep -q "last synced" || die "cli status did not report a synced clock"

# Capture the supervised child's own PID while it is still a direct child of the
# supervisor, so the orphan guard below can target *that* process. A machine-wide
# `pgrep -f "sleep 30"` is not isolated: `-f` matches the whole command line as a
# substring, so an unrelated `sleep 300` (another smoke, a busy host, a stray
# `sleep`) tripped a **false** "orphaned child" and reddened the whole
# `make verify` sweep (REQ-A193, 2026-09-13). This mirrors supervisor-smoke.sh's
# PID-scoped `child_pids` check.
CHILD=""
for _ in $(seq 1 100); do
  CHILD="$(pgrep -P "$SUP" 2>/dev/null | head -1 || true)"
  [ -n "$CHILD" ] && break
  sleep 0.05
done
[ -n "$CHILD" ] || die "could not find the supervised child of pid $SUP"
echo "supervised child pid $CHILD"

echo "== SIGINT: graceful stop =="
kill -INT "$SUP"
for _ in $(seq 1 60); do
  if ! kill -0 "$SUP" 2>/dev/null; then break; fi
  sleep 0.05
done
kill -0 "$SUP" 2>/dev/null && die "supervisor did not exit after SIGINT"

# The captured child must be gone too. Wait briefly for the OS to reap it, then a
# surviving pid means the graceful stop orphaned it.
for _ in $(seq 1 40); do
  kill -0 "$CHILD" 2>/dev/null || break
  sleep 0.05
done
if kill -0 "$CHILD" 2>/dev/null; then
  die "graceful stop orphaned a supervised child (pid $CHILD)"
fi

echo "== smoke OK: calibrated, propagated to child, readable via CLI, no orphans =="
