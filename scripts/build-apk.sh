#!/usr/bin/env bash
# Build the AmOS System UI APK for the on-device (retail S5) bring-up.
#
# Why this file exists: scripts/build-android.sh builds the *headless* Rust
# binaries (amos-ai/amos-wm) and the radio/flashlight jni libs, but it only
# PRINTS the System UI APK command — it never runs it. That left a gap where an
# APK could be produced WITHOUT amos-tauri's `android` feature, which crashes on
# launch with `UnsatisfiedLinkError: TelephonyGlue.nativeAttach ... is the
# library loaded?` (feature gate missing ⇒ no JNI symbols linked). This wrapper
# is the ONE canonical way to build the APK and it HARD-CODES `--features
# android`, so a feature-less (boot-crash) APK cannot be produced by accident.
#
# Requires: Android NDK (ANDROID_NDK_HOME), rustup target aarch64-linux-android,
#           cargo-tauri CLI (`cargo install tauri-cli`).
# Usage:    scripts/build-apk.sh            # debug-ish release APK (tauri default)
#           scripts/build-apk.sh --config   # debug build for faster installs
set -euo pipefail
cd "$(dirname "$0")/.."

NDK="${ANDROID_NDK_HOME:-}"
if [[ -z "$NDK" || ! -d "$NDK" ]]; then
  echo "error: set ANDROID_NDK_HOME to your Android NDK path" >&2
  exit 1
fi
if ! rustup target list --installed 2>/dev/null | grep -q aarch64-linux-android; then
  echo "installing rustup target aarch64-linux-android..."
  rustup target add aarch64-linux-android
fi
command -v cargo-tauri >/dev/null 2>&1 || cargo tauri --version >/dev/null 2>&1 || {
  echo "error: cargo-tauri CLI not found (install: cargo install tauri-cli)" >&2
  exit 1
}

TARGET=aarch64-linux-android
HOST_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
PREBUILT="$NDK/toolchains/llvm/prebuilt/${HOST_OS}-x86_64"
candidate=$(ls "$PREBUILT"/bin/"$TARGET"*-clang 2>/dev/null | sort -V | tail -n1)
if [ -z "$candidate" ]; then
  echo "error: no aarch64-linux-android*-clang found under $PREBUILT/bin" >&2
  exit 1
fi
_api=$(basename "$candidate"); _api=${_api#"$TARGET"}; _api=${_api%-clang}
LINKER="$PREBUILT/bin/${TARGET}${_api}-clang"
echo "linker: $LINKER (API $_api)"

# Make the NDK C toolchain resolvable for the whole workspace: some transitive
# deps (zstd-sys etc.) use a C `cc` build and need the target compiler + archiver
# on PATH / in CC_*/AR_* for the android triple — not just the cargo linker.
export PATH="$PREBUILT/bin:$PATH"
export CC_aarch64_linux_android="$LINKER"
export AR_aarch64_linux_android="$PREBUILT/bin/llvm-ar"
export TARGET_CC="$LINKER"
export TARGET_AR="$PREBUILT/bin/llvm-ar"

# Cargo needs the android linker set for the whole workspace when Tauri compiles
# the amos-tauri cdylib for the APK.
mkdir -p .cargo
cat > .cargo/config.toml <<EOF
[target.${TARGET}]
linker = "$LINKER"
EOF

# Pre-build the headless binaries + radio/flashlight android libs (idempotent) so
# the APK links jni providers that are on disk (matches documented bring-up).
scripts/build-android.sh

cd crates/amos-tauri
echo
echo "== building System UI APK (android feature HARD-CODED) =="
# `android` is the on-device feature that pulls in amos-radio/android
# (AndroidRadioProvider), amos-flashlight/android (torch), amos-sensor/android
# and amos-audio/aaudio — omitting it is the exact cause of the boot crash the
# TelephonyGlue nativeAttach guard diagnoses. Always on here.
if [ "${1:-}" = "--config" ]; then
  cargo tauri android build --debug --features android
else
  cargo tauri android build --features android
fi

echo
echo "Install on the S5 (example; adjust to your actual output APK):"
echo "  adb -s YY000286 install -r crates/amos-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk"
echo "  adb -s YY000286 shell am start -n com.amos.ai/.MainActivity"
echo
echo "Note: run scripts/build-apk.sh (not this file) to build the APK — it"
echo "  hard-codes amos-tauri's 'android' feature so you can't produce a"
echo "  boot-crash feature-less APK by accident."
