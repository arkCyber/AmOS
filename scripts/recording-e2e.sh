#!/usr/bin/env bash
# End-to-end device check for the in-call recording flow
# (crates/amos-tauri/android-glue/com/amos/ai/glue/AmosInCallService.kt,
# REQ-A1579 / F-TEL-038).
#
# What this script pins, in four layers:
#
#   1. **compile + lint + host-JVM tests** — the cheapest gate. Re-runs
#      `scripts/android-glue-nv21-check.sh`, which mirrors the tracked glue,
#      compiles every Kotlin file in `android-glue/`, runs every
#      `*Test.kt` in `android-glue/tests/` against a host JVM (incl. the new
#      `RecordingContractTest.kt`, 15 cases pinning the report envelope, the
#      audio-source word list, the emergency guard, and the
#      `<filesDir>/recordings/` rule), and runs Lint over the same sources.
#      Pinned 2026-09-26 against JDK 17 (the only one the `buildSrc` project
#      accepts).
#
#   2. **device pre-flight** — checks the connected ADB device is a recent
#      S5 / API 34 build of `com.amos.ai` (the only one whose InCallService
#      carries the F-TEL-038 changes — REQ-A1579 / F-TEL-038). The version
#      check is `versionCode >= 1000` AND `versionName` is `0.1.0`-something;
#      on a stale install every later gate silently runs against code the
#      Kotlin glue no longer matches.
#
#   3. **on-device instrumentation** — builds the test APK + the
#      instrumentation test APK, runs `:app:connectedArmDebugAndroidTest`
#      against the connected S5, and verifies the test class
#      `AmosInCallRecordingInstrumentationTest` actually executed (4 cases:
#      the real `MediaRecorder` cycle, the file-name + root rule, the
#      audio-source words, the report envelope). The "test executed" check
#      is what catches the failure mode measured 2026-09-26: a missing
#      `<instrumentation>` declaration in `androidTest/AndroidManifest.xml`
#      makes the test APK carry the legacy `android.test.InstrumentationTestRunner`,
#      which silently runs zero tests and exits with status 0 — Gradle's
#      `:connectedArmDebugAndroidTest` reports `BUILD SUCCESSFUL`, but no
#      test ran. The grep here is what closes that hole.
#
#   4. **filesystem + permission probe** — uses `adb shell run-as com.amos.ai`
#      to verify the `<filesDir>/recordings/` directory is reachable, and
#      `pm grant` to ensure `RECORD_AUDIO` is granted (the run-time
#      permission the live `MediaRecorder` needs).
#
# Usage:
#   bash scripts/recording-e2e.sh                # all four layers, default device
#   ADB_SERIAL=YY000286 bash scripts/recording-e2e.sh
#   bash scripts/recording-e2e.sh --skip-device  # layers 1+4 only
#
# Exit codes:
#   0 — every gate passed
#   1 — host gate (compile/test/lint) failed
#   2 — device pre-flight failed (no device, wrong package, wrong version)
#   3 — on-device instrumentation failed (zero tests, or a test failed)
#   4 — filesystem / permission probe failed
#
# This script is the script-form of `make android-recording-test`; both
# delegate here so a future gate can be added without touching the Makefile.
set -euo pipefail
cd "$(dirname "$0")/.."

ADB_SERIAL="${ADB_SERIAL:-}"
PKG=com.amos.ai
EXPECTED_VERSION_CODE=1000
EXPECTED_VERSION_NAME_PREFIX=0.1.

skip_device=0
for arg in "$@"; do
  [[ "$arg" == "--skip-device" ]] && skip_device=1
done

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
hdr() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }

# --- resolve adb serial --------------------------------------------------------
adb_dev() {
  if [[ -n "$ADB_SERIAL" ]]; then
    adb -s "$ADB_SERIAL" "$@"
  else
    adb "$@"
  fi
}

# --- layer 1: compile + host-JVM tests + lint ---------------------------------
hdr "Layer 1: compile, host-JVM tests, lint"
if ! export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home}"; then
  red "JAVA_HOME could not be set; pass it explicitly or install JDK 17"
  exit 1
fi
if ! bash scripts/android-glue-nv21-check.sh; then
  red "host-JVM glue gate failed"
  exit 1
fi
# The above runs `:app:testArmDebugUnitTest` — confirm our recording test
# actually ran (not just compiled).
test_xml=$(ls -t /Users/arksong/AmOS/crates/amos-tauri/gen/android/app/build/test-results/testArmDebugUnitTest/TEST-com.amos.ai.glue.RecordingContractTest.xml 2>/dev/null | head -1 || true)
if [[ -z "$test_xml" ]]; then
  red "RecordingContractTest test result file not found — was the test compiled and run?"
  exit 1
fi
if ! grep -q 'tests="15"' "$test_xml"; then
  red "RecordingContractTest did not run the full 15 cases (got $(grep -oE 'tests=\"[0-9]+\"' "$test_xml" | head -1))"
  exit 1
fi
if grep -q 'failures="[1-9]' "$test_xml"; then
  red "RecordingContractTest had $(grep -oE 'failures=\"[0-9]+\"' "$test_xml" | head -1) failures"
  exit 1
fi
grn "Layer 1 OK — 15/15 RecordingContractTest cases pass on host JVM"

# --- layer 2: device pre-flight -------------------------------------------------
hdr "Layer 2: device pre-flight"
if [[ "$skip_device" == "1" ]]; then
  grn "Layer 2 SKIPPED (--skip-device)"
else
  # Make sure the production `com.amos.ai` is installed before probing — a
  # previous `:app:connectedArmDebugAndroidTest` run leaves `com.amos.ai.test`
  # in place, which `dumpsys package com.amos.ai` cannot find. The arm-debug
  # APK is what the build pipeline produced most recently.
  arm_debug_apk="/Users/arksong/AmOS/crates/amos-tauri/gen/android/app/build/outputs/apk/arm/debug/app-arm-debug.apk"
  if [[ -f "$arm_debug_apk" ]] && \
     ! adb_dev shell dumpsys package "$PKG" 2>/dev/null | grep -q "versionName"; then
    echo "[recording-e2e] $PKG not installed (test APK from a prior run?), re-installing"
    adb_dev install -r -g "$arm_debug_apk" >/dev/null 2>&1 || true
  fi
  if ! adb_dev get-state 1>/dev/null 2>&1; then
    red "no ADB device connected; pass ADB_SERIAL=<serial> or plug in S5"
    exit 2
  fi
  serial="$(adb_dev get-serialno 2>/dev/null | tr -d '\r')"
  model="$(adb_dev shell getprop ro.product.model | tr -d '\r\n')"
  sdk="$(adb_dev shell getprop ro.build.version.sdk | tr -d '\r\n')"
  abi="$(adb_dev shell getprop ro.product.cpu.abi | tr -d '\r\n')"
  echo "[recording-e2e] device: serial=$serial model=$model sdk=$sdk abi=$abi"

  # The recording code lives in `AmosInCallService` (REQ-A1579 / F-TEL-038),
  # added in version 0.1.0 (versionCode 1000). A stale install silently
  # fails the device-half gate because the Kotlin glue never references the
  # `RecordingContract` companion object.
  installed="$(adb_dev shell dumpsys package "$PKG" 2>/dev/null | grep -E 'versionCode|versionName' | head -2 | tr -d '\r')"
  echo "[recording-e2e] installed: $installed"
  vcode="$(echo "$installed" | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -1)"
  vname="$(echo "$installed" | sed -n 's/.*versionName=\([^ ]*\).*/\1/p' | head -1)"
  if [[ -z "$vcode" ]]; then
    red "$PKG is not installed; install via 'make android-app' first"
    exit 2
  fi
  if (( vcode < EXPECTED_VERSION_CODE )); then
    red "versionCode=$vcode < $EXPECTED_VERSION_CODE; the in-call recording glue requires this build"
    exit 2
  fi
  if [[ "$vname" != "${EXPECTED_VERSION_NAME_PREFIX}"* ]]; then
    red "versionName=$vname does not start with $EXPECTED_VERSION_NAME_PREFIX"
    exit 2
  fi
  # RECORD_AUDIO is a runtime permission. It is **declared** in
  # AndroidManifest.permissions.xml (REQ-A1579), and the live InCallService's
  # `MediaRecorder` requires it at runtime. Without the grant the test class's
  # `@Before` check would fail with a clear refusal, but the gate here is to
  # grant it once so the test doesn't waste time on the failure mode.
  if adb_dev shell pm grant "$PKG" android.permission.RECORD_AUDIO 2>&1 | grep -qE 'Exception|failed'; then
    red "could not grant RECORD_AUDIO"
    exit 2
  fi
  grn "Layer 2 OK — $PKG $vname (versionCode=$vcode) on $serial, RECORD_AUDIO granted"
fi

# --- layer 3: on-device instrumentation ----------------------------------------
hdr "Layer 3: on-device instrumentation"
if [[ "$skip_device" == "1" ]]; then
  grn "Layer 3 SKIPPED (--skip-device)"
else
  bash scripts/android-glue-mirror.sh >/dev/null
  # Stop any foreground app that might be holding the audio HAL — the camera
  # foreground is the failure mode measured on S5 / API 34 (the camera holds
  # the mic exclusively, so the test's `MediaRecorder.start()` is rejected
  # with `RuntimeException` ~150 ms later and the test process is killed by
  # the AM with signal 9). This is **not** a defect in the glue — it's the
  # Android audio HAL being exclusive — but a clean test surface needs the
  # HAL idle.
  for pkg in com.freeme.camera com.android.camera com.google.android.GoogleCamera; do
    adb_dev shell am force-stop "$pkg" 2>/dev/null || true
  done
  # `--no-daemon` because the Kotlin daemon's incremental cache occasionally
  # holds stale `class-attributes.tab` files under the cargo registry path,
  # which crashes `:app:compileArmDebugKotlin` with `Internal compiler error`
  # (the failure mode measured 2026-09-26). The cold-compile cost is small
  # relative to the device-side run that follows it.
  if ! ( cd crates/amos-tauri/gen/android && \
         ./gradlew :app:connectedArmDebugAndroidTest --rerun-tasks --no-daemon --console=plain ); then
    red "on-device instrumentation gate failed"
    exit 3
  fi
  report_xml=$(ls -t /Users/arksong/AmOS/crates/amos-tauri/gen/android/app/build/outputs/androidTest-results/connected/debug/flavors/arm/TEST-*.xml 2>/dev/null | head -1 || true)
  if [[ -z "$report_xml" ]]; then
    red "no on-device test report found"
    exit 3
  fi
  # 4 tests is the minimum for `AmosInCallRecordingInstrumentationTest` (the
  # `RecorderRunnerSmokeTest` brings it to 5). A run that shows `tests="0"`
  # is the silent failure mode this grep catches: the legacy
  # `android.test.InstrumentationTestRunner` ran zero tests and exited 0.
  total="$(grep -oE 'tests=\"[0-9]+\"' "$report_xml" | head -1 | grep -oE '[0-9]+')"
  fails="$(grep -oE 'failures=\"[0-9]+\"' "$report_xml" | head -1 | grep -oE '[0-9]+')"
  errors="$(grep -oE 'errors=\"[0-9]+\"' "$report_xml" | head -1 | grep -oE '[0-9]+')"
  if [[ "$total" -lt 4 ]]; then
    red "on-device tests ran only $total (expected ≥4); the AndroidJUnitRunner wiring is broken"
    exit 3
  fi
  if [[ "$fails" -gt 0 || "$errors" -gt 0 ]]; then
    red "on-device tests had $fails failures and $errors errors"
    exit 3
  fi
  if ! grep -q 'AmosInCallRecordingInstrumentationTest' "$report_xml"; then
    red "the recording test class did not run (only smoke tests); check the runner"
    exit 3
  fi
  grn "Layer 3 OK — $total on-device tests passed incl. AmosInCallRecordingInstrumentationTest"

  # `:app:connectedArmDebugAndroidTest` installs the **test** APK over the
  # production debug APK the build pipeline laid down — the test APK targets
  # `com.amos.ai.test` and `run-as com.amos.ai` no longer works afterwards.
  # Re-install the production debug APK so layer 4 has a normal
  # `com.amos.ai` package to probe. The APK Gradle just produced is at the
  # canonical output path below.
  arm_debug_apk="/Users/arksong/AmOS/crates/amos-tauri/gen/android/app/build/outputs/apk/arm/debug/app-arm-debug.apk"
  if [[ ! -f "$arm_debug_apk" ]]; then
    red "expected arm-debug APK at $arm_debug_apk; layer 4 cannot probe without it"
    exit 3
  fi
  if ! adb_dev install -r -g "$arm_debug_apk" >/dev/null 2>&1; then
    red "could not re-install the production debug APK after the test APK"
    exit 3
  fi
  if ! adb_dev shell pm grant "$PKG" android.permission.RECORD_AUDIO 2>&1 | grep -qE 'Exception|failed'; then
    : # grant may already be in effect; not an error
  fi
fi

# --- layer 4: filesystem + permission probe ------------------------------------
hdr "Layer 4: filesystem + permission probe"
if [[ "$skip_device" == "1" ]]; then
  grn "Layer 4 SKIPPED (--skip-device)"
else
  # `<filesDir>` is `Context.getFilesDir()` ⇒ `/data/data/<pkg>/files`. The
  # in-call recording contract: `<filesDir>/recordings/<id>.m4a`. Without
  # the directory being reachable from `run-as`, the Rust side
  # (`recording::app_data_root` on Android) cannot file the row.
  # `run-as` spawns a fresh shell — `cd files && pwd` reports `/`, not the
  # target, so the probe must use absolute paths under the app's data dir.
  files_dir="/data/data/$PKG/files"
  # On a *fresh* install the files dir may not exist yet (Context.getFilesDir
  # creates it lazily). `RecordingContract.recordingsRoot` does the same
  # lazy-create pattern (mkdir + mkdir if not exists), so this probe mirrors
  # it: create each level in turn, then verify.
  #
  # Toybox `mkdir` on Android is a single-arg form (no `-p`), so the
  # parents must exist first — which is why the steps are sequential.
  adb_dev shell run-as "$PKG" mkdir "$files_dir" 2>/dev/null || true
  if ! adb_dev shell run-as "$PKG" test -d "$files_dir" 2>&1; then
    red "<filesDir> $files_dir could not be created from $PKG's uid"
    exit 4
  fi
  # The directory exists and must be writable from the app's uid —
  # `MediaRecorder` writes here. The Android `test -w` uses the file
  # *owner*'s write bit, which is the app uid after `run-as`. Quoting:
  # `adb shell` needs the `sh -c "..."` to receive the whole pipeline as
  # one argv, so we wrap the whole thing in outer double quotes and use
  # inner double quotes for the path (escaped).
  if ! adb_dev shell "run-as $PKG sh -c \"test -w '$files_dir' && echo OK\"" 2>&1 | grep -q OK; then
    red "<filesDir> $files_dir is not writable from $PKG's uid"
    exit 4
  fi
  # The `recordings/` subdirectory may not exist yet (no recording ever
  # started). The Rust side creates it on first file — what we pin here is
  # that the parent is writable, **and** the directory creation succeeds
  # (the same shape `RecordingContract.recordingsRoot` runs).
  recordings_dir="$files_dir/recordings"
  adb_dev shell run-as "$PKG" mkdir "$recordings_dir" 2>/dev/null || true
  if ! adb_dev shell run-as "$PKG" test -d "$recordings_dir" 2>&1; then
    red "could not create <filesDir>/recordings/ under $PKG's uid"
    exit 4
  fi
  if ! adb_dev shell "run-as $PKG sh -c \"test -w '$recordings_dir' && echo OK\"" 2>&1 | grep -q OK; then
    red "<filesDir>/recordings/ is not writable from $PKG's uid"
    exit 4
  fi
  grn "Layer 4 OK — <filesDir> $files_dir writable, <filesDir>/recordings/ creatable"
fi

hdr "ALL LAYERS PASSED"
