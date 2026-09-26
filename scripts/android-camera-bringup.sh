#!/usr/bin/env bash
# android-camera-bringup.sh — one-shot **device** driver for the camera producer's
# use-after-free acceptance (REQ-A776), i.e. the executable half REQ-A45 left open.
#
# Why it exists: REQ-A45 root-caused the `IllegalStateException: buffer is inaccessible`
# use-after-free on the `amos-camera` thread (a stale `ImageReader` callback reading a
# frame whose native memory `MemoryRef.free()` had already released) and fixed it — but
# wrote in its own honest boundary that the race **cannot be reproduced on a host** and
# therefore needs device acceptance, "步骤见 docs/android-glue.md". Those steps name five
# criteria, and one of them is `CameraGlue.droppedFrameCount()`. **Nothing in this
# repository can read that counter** (no JNI entry point, no tauri command, no caller):
# `grep -rn droppedFrameCount` finds the definition, its increment sites, and nothing
# else. A protocol whose instrument does not exist is not an acceptance protocol — so the
# device evidence REQ-A45 asked for has never been obtainable. This script is that
# instrument: it drives the *identified trigger* mechanically and judges the log.
#
# The trigger (REQ-A45, "触发路径"): `MainActivity.onStart` runs on every foreground, and
# `AmosGlue.onStart → CameraGlue.attach` used to tear down a live capture session — the
# reader close raced `onImageAvailable` on the `amos-camera` thread. So the exercise is
# repeated foreground↔background cycles, not one launch.
#
# Modes:
#   $0 [--device <serial>] [--pkg com.amos.ai] [--cycles N] [--log <path>] \
#      [--max-drops N] [--check-prereqs | --dry-run | --apply | --selftest]
#   * --check-prereqs : host tooling only (adb present). Safe, no device.
#   * --dry-run        : print the exact plan it WOULD run (default). Safe, no device.
#   * --apply          : actually touch the attached device. Use only with consent.
#   * --selftest       : prove the *judge* discriminates, on synthetic logs. No device.
#
# Honesty: this judges **log signatures**, which is not the same claim as "the race is
# gone" — a race that did not fire in N cycles is not a race that cannot fire. The verdict
# says exactly that. And a run that never reached the camera **fails**: a green on an
# unexercised path is the vacuous-gate defect this repository keeps registering
# (F-DEV-074 — "a tool that exits 0 without answering is worse than one that fails").
#
# Exit codes: 0 ok, 1 bad verdict / hard error, 2 preflight or usage failure.

set -euo pipefail
cd "$(dirname "$0")/.."

ADB="${ADB:-adb}"
SERIAL=""
PKG="com.amos.ai"
CYCLES=5
# The guard's cumulative drop count is a *criterion*, not a decoration (docs/android-glue.md
# §设备验收 2: "n 不持续增长（≈0；个位数偶发可接受并应记录）"). A camera that drops every
# frame still reports `no fatal signature`, so without a bound the judge would call a broken
# producer healthy. `10` is the boundary the doc's "个位数" draws; override with --max-drops.
MAX_DROPS=10
LOG="target/device/camera-bringup-$(date +%Y%m%d-%H%M%S).log"
MODE="dry-run"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) SERIAL="${2:-}"; shift 2 ;;
    --pkg) PKG="${2:-}"; shift 2 ;;
    --cycles) CYCLES="${2:-}"; shift 2 ;;
    --max-drops) MAX_DROPS="${2:-}"; shift 2 ;;
    --log) LOG="${2:-}"; shift 2 ;;
    --check-prereqs) MODE="check-prereqs"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    --selftest) MODE="selftest"; shift ;;
    -h|--help) sed -n '1,38p' "$0"; exit 0 ;;
    *) echo "error: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Both bounds are compared arithmetically, so a non-numeric value would abort the judge with
# a shell error instead of a verdict — refuse it up front, by name.
for pair in "cycles:$CYCLES" "max-drops:$MAX_DROPS"; do
  name="${pair%%:*}"; val="${pair#*:}"
  if ! [[ "$val" =~ ^[0-9]+$ ]]; then
    echo "error: --$name needs a non-negative integer (got: $val)" >&2
    exit 2
  fi
done

info() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
plan() { printf '  $ %s\n' "$*"; }

# ---- the judge (device-free; also the thing --selftest tests) --------------------
#
# Log signatures that mean the defect (or a sibling of it) is live on this device. They
# are the *named* symptoms, not a heuristic: two are the exception messages REQ-A45
# diagnosed, `FATAL EXCEPTION`/`Fatal signal` are the process death that an unguarded
# callback on the `amos-camera` thread produces (a `DirectByteBuffer` read of freed
# native memory is a SIGSEGV, which no `catch (Throwable)` can absorb).
#
# Each pattern is a *signature*, not a symptom class. A bare class name is not one: the
# old list carried `IllegalStateException`, which every REQ-A45 occurrence already matches
# through its own message (`buffer is inaccessible` / `ImageReader is not valid`), while an
# *unhandled* one always prints `FATAL EXCEPTION`. As a substring it therefore only matched
# `IllegalStateException` lines the glue **caught and reported** — the guard doing its job —
# so it turned a correctly-handled drop into a run failure (a false FAIL is as bad as a
# vacuous PASS: both make the verdict untrustworthy). Tightened accordingly.
FATAL_PATTERNS=(
  'FATAL EXCEPTION'
  'Fatal signal'
  'buffer is inaccessible'
  'ImageReader is not valid'
)

# Evidence that the exercise actually reached the camera producer. Without one of these
# the run proves nothing and must not pass — the CAMERA grant, or the app's foreground
# transition, or the sensor host binding may simply not have happened.
REACHED_PATTERNS=(
  'camera attached'
  'frame encode dropped'
)

# Judge a captured log on stdin. Prints the findings and one verdict line; exits 0 pass,
# 1 fail. `$1` = how many foreground cycles were actually driven (0 => refuse to pass);
# `$2` = the largest cumulative drop count tolerated (default `$MAX_DROPS`).
judge_log() {
  local cycles="${1:-0}" max_drops="${2:-$MAX_DROPS}"
  local log bad=0 reached=0 drops=0 peak="" line
  log="$(cat)"

  if (( cycles < 1 )); then
    echo "  FAIL: no foreground cycle was driven — this run did not exercise the path"
    echo "VERDICT: FAIL (unexercised: 0 cycles)"
    return 1
  fi

  for p in "${FATAL_PATTERNS[@]}"; do
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      bad=$((bad + 1))
      echo "  BAD  [$p] $line"
    done < <(printf '%s\n' "$log" | grep -F "$p" || true)
  done

  for p in "${REACHED_PATTERNS[@]}"; do
    if printf '%s\n' "$log" | grep -Fq "$p"; then reached=1; fi
  done
  drops="$(printf '%s\n' "$log" | grep -Fc 'frame encode dropped' || true)"
  # The bound is on the **cumulative** `(n=…)` the guard prints (per capture session — a
  # relaunch restarts the process counter), NOT on the number of log lines: five cycles that
  # each drop two frames are five lines with `n` never above 2, which the doc tolerates,
  # while one session that drops 400 frames is one line and is not. Empty when the log uses
  # the older `frame encode dropped:` form with no counter — then the peak is unknown and is
  # reported as such rather than read as zero.
  peak="$(printf '%s\n' "$log" | grep -oE '\(n=[0-9]+\)' | grep -oE '[0-9]+' | sort -n | tail -1 || true)"

  echo "  cycles driven ............... $cycles"
  echo "  camera-path evidence ........ $([[ $reached -eq 1 ]] && echo yes || echo NO)"
  echo "  frames dropped by the guard . $drops line(s), peak n=${peak:-unknown} (max $max_drops)"
  echo "  fatal signatures ............ $bad"

  if (( bad > 0 )); then
    echo "VERDICT: FAIL ($bad fatal signature line(s) in $cycles cycle(s))"
    return 1
  fi
  if (( reached == 0 )); then
    echo "VERDICT: FAIL (no camera-path evidence — nothing was exercised)"
    return 1
  fi
  if [[ -n "$peak" ]] && (( peak > max_drops )); then
    echo "VERDICT: FAIL (the guard dropped $peak frame(s) in one session, over the $max_drops bound — a producer that discards almost every frame is not healthy)"
    return 1
  fi
  echo "VERDICT: PASS (no fatal signature in $cycles cycle(s); $drops frame(s) dropped, peak n=${peak:-unknown})"
  return 0
}

# ---- --selftest: prove the judge discriminates, without a device -----------------
if [[ "$MODE" == "selftest" ]]; then
  echo "=== android-camera-bringup.sh --selftest (the judge, on synthetic logs) ==="
  fail=0
  run_case() { # <name> <cycles> <expected: pass|fail> [max_drops] <log on stdin>
    local name="$1" cycles="$2" want="$3" maxd="${4:-$MAX_DROPS}" out rc
    set +e
    out="$(judge_log "$cycles" "$maxd")"
    rc=$?
    set -e
    local got="pass"; [[ $rc -ne 0 ]] && got="fail"
    if [[ "$got" == "$want" ]]; then
      echo "  ok   $name -> $got"
    else
      echo "  FAIL $name -> got $got, want $want" >&2
      printf '%s\n' "$out" >&2
      fail=$((fail + 1))
    fi
  }

  run_case "a clean exercised run passes" 5 pass <<'EOF'
I AmosGlue: camera attached: id=0 640x480
I AmosGlue: camera attach skipped: CAMERA not granted
EOF
  run_case "the use-after-free signature fails" 5 fail <<'EOF'
I AmosGlue: camera attached: id=0 640x480
W AmosGlue: frame encode dropped: IllegalStateException: buffer is inaccessible
EOF
  run_case "a process death fails" 5 fail <<'EOF'
I AmosGlue: camera attached: id=0 640x480
E AndroidRuntime: FATAL EXCEPTION: amos-camera
EOF
  run_case "an unexercised run fails even when clean" 0 fail <<'EOF'
I AmosGlue: camera attach skipped: CAMERA not granted
EOF
  run_case "a run that never reached the camera fails" 5 fail <<'EOF'
I ActivityManager: Displayed com.amos.ai/.MainActivity
EOF
  run_case "guard drops alone are tolerated (counted, not fatal)" 5 pass <<'EOF'
I AmosGlue: camera attached: id=0 640x480
W AmosGlue: frame encode dropped (n=1): IllegalArgumentException
W AmosGlue: frame encode dropped (n=2): IllegalArgumentException
EOF
  run_case "a session that discards almost every frame fails the drop bound" 5 fail <<'EOF'
I AmosGlue: camera attached: id=0 640x480
W AmosGlue: frame encode dropped (n=412): IllegalArgumentException
EOF
  run_case "a handled exception outside the diagnosed signature is not a crash" 5 pass <<'EOF'
I AmosGlue: camera attached: id=0 640x480
W AmosGlue: camera attach skipped: IllegalStateException: camera in use by another app
EOF
  run_case "the diagnosed message still fails on its own, handled or not" 5 fail <<'EOF'
I AmosGlue: camera attached: id=0 640x480
W AmosGlue: frame encode dropped: IllegalStateException: buffer is inaccessible
EOF

  # The bound is an *argument*, not a constant: `--max-drops` must actually reach the judge
  # (a knob nobody reads is the "validated field with no reader" shape this repo registers).
  run_case "an over-bound drop is tolerated when --max-drops raises the ceiling" 5 pass 500 <<'EOF'
I AmosGlue: camera attached: id=0 640x480
W AmosGlue: frame encode dropped (n=412): IllegalArgumentException
EOF

  if (( fail > 0 )); then
    echo "selftest FAILED: $fail case(s)" >&2
    exit 1
  fi
  echo "selftest ok: 10/10 — the judge flags the crash signatures, refuses an unexercised"
  echo "             run, refuses a run that never reached the camera, bounds the guard's"
  echo "             cumulative drop count (and honours --max-drops), and does not fail a run"
  echo "             for an exception the guard caught and reported."
  exit 0
fi

# ---- device resolution -----------------------------------------------------------
ADB_DEV=()
resolve_device() {
  if [[ -n "$SERIAL" ]]; then
    ADB_DEV=("$ADB" -s "$SERIAL")
    return
  fi
  local serial
  serial="$("$ADB" devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1; exit}')"
  if [[ -z "$serial" ]]; then
    if [[ "$MODE" == "apply" ]]; then
      echo "error: no device attached (adb devices)" >&2
      exit 2
    fi
    info "no device attached — dry-run uses the <serial> placeholder"
    serial="<serial>"
  else
    info "using first attached device: $serial"
  fi
  ADB_DEV=("$ADB" -s "$serial")
}

device() {
  if [[ "$MODE" == "apply" ]]; then
    "${ADB_DEV[@]}" "$@"
  else
    plan "${ADB_DEV[@]}" "$@"
  fi
}

if [[ "$MODE" == "check-prereqs" ]]; then
  echo "=== AmOS camera producer — device bring-up (check-prereqs) ==="
  if ! command -v "$ADB" >/dev/null 2>&1; then
    echo "error: adb not found on PATH (set ADB=/path/to/adb)" >&2
    exit 2
  fi
  info "adb: $(command -v "$ADB")"
  resolve_device
  echo "prereqs ok. Use --dry-run for the plan, --apply to run against a device,"
  echo "--selftest to check the judge on synthetic logs (no device)."
  exit 0
fi

echo "=== AmOS camera producer — use-after-free acceptance ($MODE) ==="
resolve_device

if [[ "$MODE" == "apply" ]]; then
  if ! "${ADB_DEV[@]}" shell "pm list packages 2>/dev/null" | grep -qx "package:$PKG"; then
    echo "error: $PKG is not installed on the device (build + install the System UI first)" >&2
    exit 2
  fi
  sdk="$("${ADB_DEV[@]}" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')"
  info "device API level: ${sdk:-unknown}"
fi

echo
echo "1) Grant CAMERA to the System UI — the grant that used to crash the amos-camera thread"
device shell "pm grant $PKG android.permission.CAMERA"

echo
echo "2) Clear logcat, then drive $CYCLES foreground<->background cycle(s)"
echo "   (MainActivity.onStart -> CameraGlue.attach is the path that raced the reader close)"
device logcat -c

mkdir -p "$(dirname "$LOG")"
if [[ "$MODE" == "apply" ]]; then
  # Capture until the cycles are done; the pid filter keeps the buffer small enough to
  # survive a long run, and `-s AmosGlue AndroidRuntime` keeps the two channels that
  # matter (the producer's own lines, and the runtime that prints a thread death).
  "${ADB_DEV[@]}" logcat -v threadtime AmosGlue:V AndroidRuntime:V '*:S' >"$LOG" 2>/dev/null &
  LOGCAT_PID=$!
  sleep 1
  for ((i = 1; i <= CYCLES; i++)); do
    info "cycle $i/$CYCLES: HOME -> relaunch"
    "${ADB_DEV[@]}" shell input keyevent KEYCODE_HOME >/dev/null
    sleep 1
    "${ADB_DEV[@]}" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
    sleep 2
  done
  kill "$LOGCAT_PID" 2>/dev/null || true
  wait "$LOGCAT_PID" 2>/dev/null || true
  driven=$CYCLES
  echo "   captured $(wc -l <"$LOG" | tr -d ' ') line(s) -> $LOG"
else
  driven=0
  plan "# logcat -v threadtime AmosGlue:V AndroidRuntime:V '*:S' > $LOG"
  plan "# $CYCLES x ( input keyevent KEYCODE_HOME ; monkey -p $PKG -c android.intent.category.LAUNCHER 1 )"
fi

echo
echo "3) Judge the captured log"
if [[ "$MODE" == "apply" ]]; then
  set +e
  judge_log "$driven" <"$LOG"
  verdict=$?
  set -e
else
  echo "   (dry run: judged 0 cycles, which the judge refuses to pass — see --selftest)"
  judge_log 0 </dev/null || true
  verdict=0
fi

echo
echo "=== Verdict — what this run does and does not claim ==="
echo "  It judges the *named* symptoms of REQ-A45 (log signatures) over $CYCLES driven"
echo "  foreground cycle(s). It does NOT claim the race is gone: a use-after-free that did"
echo "  not fire is still a use-after-free, and this device's HAL timing is one sample."
echo "  The remaining criteria in docs/android-glue.md need a human or another tool:"
echo "    - only one AmOS client holds the camera ... adb shell dumpsys media.camera"
echo "    - the frame seq keeps increasing ......... SensorHost camera snapshot (manual)"
if [[ "$MODE" != "apply" ]]; then
  echo
  echo "Dry run (nothing executed). Re-run with --apply to run against the device."
fi
exit "$verdict"
