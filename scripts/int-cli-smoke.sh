#!/usr/bin/env bash
# End-to-end smoke for the text simultaneous-interpretation CLI (headless).
#
# Starts the amos-translate daemon in mock mode, pipes text through amos-int-cli,
# and asserts the translations appear. Exits non-zero on failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOCKET="${AMOS_TRANSLATE_SOCKET:-/tmp/amos-cli-smoke.sock}"
LOG="/tmp/amos-cli-smoke.log"
DAEMON_PID=""

cleanup() {
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  rm -f "$SOCKET"
}
trap cleanup EXIT

echo "  [cli-smoke] building amos-translate + amos-int-cli …"
(cd "$ROOT" && cargo build -p amos-translate -p amos-int-cli >/dev/null)

echo "  [cli-smoke] starting daemon (mock) at $SOCKET …"
rm -f "$SOCKET"
AMOS_TRANSLATE_BACKEND=mock AMOS_ASR_BACKEND=mock AMOS_TRANSLATE_SOCKET="$SOCKET" \
  "$ROOT/target/debug/amos-translate" --socket "$SOCKET" >"$LOG" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 50); do
  if [ -S "$SOCKET" ]; then break; fi
  sleep 0.1
done
[ -S "$SOCKET" ] || { echo "  [cli-smoke] daemon never bound $SOCKET"; cat "$LOG"; exit 1; }

echo "  [cli-smoke] piping text through the CLI …"
OUT="$("$ROOT/target/debug/amos-int-cli" --socket "$SOCKET" <<'EOF'
hello
こんにちは
.status
.quit
EOF
)"

echo "$OUT" | sed 's/^/    /'

# Assertions (mock provider wraps text as [译](auto->zh)<text>).
echo "$OUT" | grep -q "hello" || { echo "  [cli-smoke] FAIL: 'hello' not translated"; exit 1; }
echo "$OUT" | grep -q "こんにちは" || { echo "  [cli-smoke] FAIL: 'こんにちは' not translated"; exit 1; }
echo "$OUT" | grep -q "Collecting" || { echo "  [cli-smoke] FAIL: .status not rendered"; exit 1; }

echo "  [cli-smoke] OK — text simultaneous interpretation works end-to-end."
