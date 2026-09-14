#!/usr/bin/env bash
# Host-JVM check for the Android glue's host-testable Kotlin — **no device needed**.
#
# `crates/amos-tauri/android-glue/` is the tracked source of truth for the Kotlin
# glue; `crates/amos-tauri/gen/` is the Tauri-generated Android project (git-ignored).
# This script mirrors the glue files this repo cares about into the generated
# project, installs the camera packer's JUnit test into the app's unit-test source
# set, then runs the app's Kotlin **compile** plus that test on the host JVM. The
# compile half is what gives the other mirrored glue files (currently
# `TetheringGlue.kt`, the personal hotspot) a place to be type-checked without a
# device.
#
# Requirements:
#   * `cargo tauri android init` has been run once (crates/amos-tauri/gen/ exists),
#   * a JDK 17 — AGP/Kotlin reject newer JDKs (JDK 26 makes `:buildSrc` fail).
set -euo pipefail
cd "$(dirname "$0")/.."

GEN=crates/amos-tauri/gen/android

if [[ ! -d "$GEN" ]]; then
  echo "error: $GEN not found — run 'cargo tauri android init' first" >&2
  exit 1
fi

# Put the tracked glue in front of the compiler. The mirror is ONE implementation
# (`scripts/android-glue-mirror.sh`), shared with the APK builds, because a
# hand-written file list here once meant only four files were ever compiled — the
# hotspot glue was never compiled at all (REQ-A174) and the alarm glue was absent
# from every mirror (REQ-A175). `gen/` is git-ignored, so a documented `cp` made
# coverage depend on a developer's leftovers; the script replaces (not merges).
bash scripts/android-glue-mirror.sh

# AGP/Kotlin 1.x need JDK 17; prefer an explicit JAVA_HOME, else look for a known one.
JDK="${JAVA_HOME:-}"
if [[ -z "$JDK" || ! -x "$JDK/bin/java" ]]; then
  for cand in \
    /Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home \
    /usr/lib/jvm/temurin-17-jdk-amd64 \
    /usr/lib/jvm/java-17-openjdk-amd64; do
    if [[ -x "$cand/bin/java" ]]; then
      JDK="$cand"
      break
    fi
  done
fi
if [[ -n "$JDK" && -x "$JDK/bin/java" ]]; then
  export JAVA_HOME="$JDK"
  echo "[ok] JAVA_HOME=$JAVA_HOME"
else
  echo "[warn] no JDK 17 found; using the current JDK (may fail on newer versions)" >&2
fi

cd "$GEN"
# shellcheck disable=SC2086
LOG=$(mktemp)
set +e
# `--rerun-tasks`: Kotlin warnings only exist in a run where the compiler actually
# ran — without it Gradle reports `compileArmDebugKotlin UP-TO-DATE`, the log has no
# `w:` lines, and this gate would pass **vacuously** (it did, on the first try).
./gradlew :app:compileArmDebugKotlin :app:testArmDebugUnitTest ${GRADLE_ARGS:---offline} \
  --rerun-tasks 2>&1 | tee "$LOG"
GRADLE_STATUS=${PIPESTATUS[0]}
set -e
[[ "$GRADLE_STATUS" -eq 0 ]] || exit "$GRADLE_STATUS"

# The compile must have actually happened, or the warning check below proves nothing.
if grep -qE '^> Task :app:compileArmDebugKotlin UP-TO-DATE' "$LOG"; then
  echo "[glue] FAIL — compileArmDebugKotlin was UP-TO-DATE; the warning gate cannot see a compiler that did not run" >&2
  exit 1
fi

# --- our glue's Kotlin warnings are errors (REQ-A185) ------------------------
# Compiling the glue is not enough if it only produces warnings: the first device
# round found three dead-code warnings in OUR glue that nobody ever saw —
# `ClipboardGlue.pushTextClipboard(text, seq)`'s `seq` (plumbing that reached
# nothing), `AmosGlue.onStop(context)`'s unused context, and a `?:` fallback the
# compiler proved unreachable — all "a declared thing that does nothing", the class
# this repo treats as a defect. A dependency's or the generated project's warnings
# are out of scope; *deprecation* notices in our own glue are allowed, because
# calling an older platform API is a deliberate, documented choice (the Android
# listener APIs we must use).
OUR_GLUE='^w: file://.*/com/amos/ai/glue/'
our_warnings() { grep -E "$OUR_GLUE" "$1" | grep -v 'is deprecated' || true; }
all_our_warnings() { grep -cE "$OUR_GLUE" "$1" || true; }

# Self-check: the filter must flag a non-deprecation warning and let a deprecation
# through — otherwise this gate is a no-op that only ever prints "ok".
PROBE=$(mktemp)
printf "w: file:///tmp/com/amos/ai/glue/Probe.kt:1:1 Parameter 'x' is never used\n" > "$PROBE"
printf "w: file:///tmp/com/amos/ai/glue/Probe.kt:2:1 'f()' is deprecated. Deprecated in Java\n" >> "$PROBE"
if [[ "$(our_warnings "$PROBE" | wc -l | tr -d ' ')" != "1" || "$(all_our_warnings "$PROBE")" != "2" ]]; then
  echo "[glue] self-check FAILED: the Kotlin-warning filter does not classify as documented" >&2
  exit 1
fi
rm -f "$PROBE"

FINDINGS=$(our_warnings "$LOG")
if [[ -n "$FINDINGS" ]]; then
  echo >&2
  echo "[glue] FAIL — our glue has Kotlin warning(s) that are not deprecations." >&2
  echo "       A warning here is a claim that does nothing (unused parameter, unreachable" >&2
  echo "       fallback, dead branch) — fix it or suppress it with a reason (REQ-A185):" >&2
  echo "$FINDINGS" >&2
  rm -f "$LOG"
  exit 1
fi
echo "[glue] OK — $(all_our_warnings "$LOG") Kotlin warning(s) in our glue, all deprecations; no dead declarations."
rm -f "$LOG"
