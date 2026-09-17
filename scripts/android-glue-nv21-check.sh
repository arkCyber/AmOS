#!/usr/bin/env bash
# Host-JVM check for the Android glue's host-testable Kotlin — **no device needed**.
#
# `crates/amos-tauri/android-glue/` is the tracked source of truth for the Kotlin
# glue; `crates/amos-tauri/gen/` is the Tauri-generated Android project (git-ignored).
# This script mirrors the glue into the generated project, installs the camera packer's
# JUnit test into the app's unit-test source set, then runs three phases on the host JVM:
#
#   1. the app's Kotlin **compile** plus that test — the compile half is what gives the
#      other mirrored glue files a place to be type-checked without a device;
#   2. **our glue's Kotlin warnings are errors** (unused parameters, unreachable branches,
#      dead declarations — deprecations excepted, because calling an older platform API is
#      a documented choice);
#   3. **Android Lint** (`:app:lintArmDebug`), scoped to `com/amos/ai/glue/` — the
#      platform's own verdict on the two claims the compiler cannot check: **does the API
#      exist on `minSdk` (26)**, and **does the call need a permission nobody checks**
#      (REQ-A380: the first run found 20 errors in our glue — 5 × `NewApi`, 8 ×
#      `MissingPermission` — plus 16 warnings, among them an API-29-only `MediaStore` path
#      that was silently dead on API 26..28). **Our glue must come out with zero findings,
#      errors and warnings alike**: every accepted one is suppressed *in the source* with its
#      reason (`@SuppressLint("…") // why`), so a new warning is a decision nobody made.
#      Findings outside our glue (the generated project, Tauri's own files, and the merged
#      manifest's `<uses-feature>` implications of our permissions) are printed grouped by
#      issue id — reported, not judged, because those files are machine-owned.
#
# Requirements:
#   * `cargo tauri android init` has been run once (crates/amos-tauri/gen/ exists),
#   * a JDK 17 — AGP/Kotlin reject newer JDKs (JDK 26 makes `:buildSrc` fail),
#   * the Gradle dependency cache for the Android test artifacts (one online
#     `:app:lintArmDebug` populates it; `GRADLE_ARGS=…` can drop `--offline`).
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

# --- Android Lint: the platform's own API-level / permission verdicts (REQ-A380) ----
# WHY: the Kotlin compile above proves the glue *builds*. It says nothing about whether the
# APIs it calls **exist** on the `minSdk` (26) devices this APK claims to support, nor about a
# platform call whose permission nobody checks — both of which the platform's own linter
# answers. Nothing in this repo ran it, and the first run reported **20 errors** in our glue:
#   * 5 × `NewApi` in `TetheringGlue` — the API-level guard lived in the caller, which Lint
#     cannot follow (the fix is `@RequiresApi`, so *every* call site is verified),
#   * 8 × `MissingPermission` in `BluetoothGlue` — every call sits inside the `try/catch` that
#     reports the refusal (Lint cannot see that either: suppressed *with the reason*),
#   * plus `InlinedApi` warnings on a `MediaStore.VOLUME_EXTERNAL_PRIMARY` use that is API 29
#     while `minSdk` is 26 — the volume-based `getContentUri(String)` is a `NoSuchMethodError`
#     below 29, i.e. that path was silently dead on API 26..28 (it now falls back to
#     `EXTERNAL_CONTENT_URI`).
# A finding here is a device-range or permission claim, so it is the same class of defect as
# the compile gate's warning rule: ours must be zero.
LINT_LOG=$(mktemp)
LINT_REPORT=app/build/reports/lint-results-armDebug.txt
OUR_GLUE_RE='^/.*/com/amos/ai/glue/.*\.kt:[0-9]+: '
glue_errors() { grep -E "${OUR_GLUE_RE}Error:" "$1" || true; }
glue_warnings() { grep -E "${OUR_GLUE_RE}Warning:" "$1" || true; }

# Self-check: the classifier must count a glue error, ignore an error in the generated project
# (machine-owned: reported, not judged) and see a glue warning.
PROBE2=$(mktemp)
{
  printf "/x/app/src/main/java/com/amos/ai/glue/Probe.kt:1: Error: Call requires API level 36 [NewApi]\n"
  printf "/x/app/src/main/java/com/amos/ai/glue/Probe.kt:2: Warning: Unnecessary [ObsoleteSdkInt]\n"
  printf "/x/app/src/main/java/com/amos/ai/generated/RustWebView.kt:3: Error: not ours [ViewConstructor]\n"
} > "$PROBE2"
if [[ "$(glue_errors "$PROBE2" | wc -l | tr -d ' ')" != "1" || "$(glue_warnings "$PROBE2" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "[glue] self-check FAILED: the Lint classifier does not classify as documented" >&2
  exit 1
fi
rm -f "$PROBE2"

rm -f "$LINT_REPORT"
set +e
./gradlew :app:lintArmDebug ${GRADLE_ARGS:---offline} --console=plain > "$LINT_LOG" 2>&1
set -e
# Lint exits non-zero when it finds *any* error (the generated project has some), so the report
# — not the exit code — is the evidence here. No report means "cannot tell".
if [[ ! -f "$LINT_REPORT" ]]; then
  echo "[glue] FAIL — Android Lint produced no report ($LINT_REPORT missing); 'cannot tell' is not 'fine'." >&2
  tail -20 "$LINT_LOG" >&2
  exit 1
fi
grep -m1 'Lint found' "$LINT_LOG" || true
FINDINGS=$(glue_errors "$LINT_REPORT")
if [[ -n "$FINDINGS" ]]; then
  echo >&2
  echo "[glue] FAIL — Android Lint reports error(s) in our glue. These are device-range or" >&2
  echo "       permission claims that the compiler cannot see (REQ-A380):" >&2
  echo "$FINDINGS" >&2
  rm -f "$LINT_LOG"
  exit 1
fi
# Warnings are judged too: every one we accept is suppressed **in the source** with its reason
# (@SuppressLint("…") // why), so a *new* warning is a decision nobody made — the same rule the
# Kotlin-warning phase above follows. The findings that remain in the generated project are
# printed (machine-owned: reported, not judged).
WARNINGS=$(glue_warnings "$LINT_REPORT")
if [[ -n "$WARNINGS" ]]; then
  echo >&2
  echo "[glue] FAIL — Android Lint reports warning(s) in our glue that nobody judged." >&2
  echo "       Fix it, or suppress it in the source with a reason (REQ-A380):" >&2
  echo "$WARNINGS" >&2
  rm -f "$LINT_LOG"
  exit 1
fi
OTHER=$(grep -E ': (Error|Warning): .*\[[A-Za-z]+\]$' "$LINT_REPORT" | grep -v '/com/amos/ai/glue/' || true)
if [[ -n "$OTHER" ]]; then
  echo "[glue] note — $(printf '%s\n' "$OTHER" | wc -l | tr -d ' ') Lint finding(s) outside our glue (generated project / Tauri, reported not judged), by issue:"
  printf '%s\n' "$OTHER" | sed -E 's/.*\[([A-Za-z]+)\]$/\1/' | sort | uniq -c | sort -rn | head -10 | sed 's/^/       /'
fi
echo "[glue] OK — Android Lint: 0 finding(s) in our glue (every suppression carries its reason); generated-project findings reported above."
rm -f "$LINT_LOG"
rm -f "$LOG"
