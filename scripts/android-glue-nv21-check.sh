#!/usr/bin/env bash
# Host-JVM check for the camera glue's pure NV21 packer — **no device needed**.
#
# `crates/amos-tauri/android-glue/` is the tracked source of truth for the Kotlin
# glue; `crates/amos-tauri/gen/` is the Tauri-generated Android project (git-ignored).
# This script mirrors the camera-glue files this repo cares about into the generated
# project, installs the packer's JUnit test into the app's unit-test source set, and
# runs it on the host JVM.
#
# Requirements:
#   * `cargo tauri android init` has been run once (crates/amos-tauri/gen/ exists),
#   * a JDK 17 — AGP/Kotlin reject newer JDKs (JDK 26 makes `:buildSrc` fail).
set -euo pipefail
cd "$(dirname "$0")/.."

GLUE=crates/amos-tauri/android-glue/com/amos/ai/glue
TESTS=crates/amos-tauri/android-glue/tests/com/amos/ai/glue
GEN=crates/amos-tauri/gen/android
GEN_MAIN="$GEN/app/src/main/java/com/amos/ai/glue"
GEN_TEST="$GEN/app/src/test/java/com/amos/ai/glue"

if [[ ! -d "$GEN_MAIN" ]]; then
  echo "error: $GEN_MAIN not found — run 'cargo tauri android init' first" >&2
  exit 1
fi

mkdir -p "$GEN_TEST"
# The three files this check covers (tracked source -> generated project).
cp "$GLUE/Nv21Packer.kt" "$GEN_MAIN/Nv21Packer.kt"
cp "$GLUE/Nv21.kt" "$GEN_MAIN/Nv21.kt"
cp "$GLUE/CameraGlue.kt" "$GEN_MAIN/CameraGlue.kt"
cp "$TESTS/Nv21PackerTest.kt" "$GEN_TEST/Nv21PackerTest.kt"

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
./gradlew :app:compileArmDebugKotlin :app:testArmDebugUnitTest ${GRADLE_ARGS:---offline}
