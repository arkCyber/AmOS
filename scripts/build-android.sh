#!/usr/bin/env bash
# Build the Rust pieces of Amos for aarch64-linux-android.
#
# * Headless binaries (amos-ai, amos-wm) output under
#   target/aarch64-linux-android/release/ for staging into /system/bin/ (amos.rc).
# * amos-radio with --features android compiles the jni AndroidRadioProvider —
#   a *lib* the System UI APK links (cargo tauri android build --features android).
# * amos-flashlight with --features android compiles the jni AndroidFlashlightProvider
#   (CameraManager torch), same link target as radio.
# * `--ai-voice` additionally builds amos-ai with the `asr-sherpa` feature so the
#   shipped daemon can run the real on-device ASR the init.rc now requests
#   (AMOS_ASR_BACKEND=sherpa + AMOS_SHERPA_MODEL_DIR=/data/amos/sherpa). This
#   needs network on first run to fetch sherpa-onnx's aarch64-linux-android lib.
#
# Requires: Android NDK (ANDROID_NDK_HOME), rustup target aarch64-linux-android.
set -euo pipefail
cd "$(dirname "$0")/.."

# Flags (env AMOS_AI_VOICE=1 is the non-flag equivalent).
ai_voice=0
[ "${AMOS_AI_VOICE:-0}" = "1" ] && ai_voice=1
for arg in "$@"; do
  case "$arg" in
    --ai-voice|-v) ai_voice=1 ;;
    -h|--help)
      echo "usage: $0 [--ai-voice]   (build amos-ai with real sherpa ASR)"
      exit 0 ;;
    *) echo "warning: ignoring unknown arg: $arg" >&2 ;;
  esac
done

NDK="${ANDROID_NDK_HOME:-}"
if [[ -z "$NDK" || ! -d "$NDK" ]]; then
  echo "error: set ANDROID_NDK_HOME to your Android NDK path" >&2
  exit 1
fi
if ! rustup target list --installed 2>/dev/null | grep -q aarch64-linux-android; then
  echo "installing rustup target aarch64-linux-android..."
  rustup target add aarch64-linux-android
fi

TARGET=aarch64-linux-android
HOST_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
LLVM_PREBUILT="$NDK/toolchains/llvm/prebuilt"
PREBUILT="$LLVM_PREBUILT/${HOST_OS}-x86_64"

# Pick the highest API level this NDK ships for the target (NDK 23 tops out at
# 31, newer NDKs ship 34+). Hard-coding one level breaks on every other NDK.
candidate=$(ls "$PREBUILT"/bin/"$TARGET"*-clang 2>/dev/null | sort -V | tail -n1)
if [ -z "$candidate" ]; then
  echo "error: no aarch64-linux-android*-clang found under $PREBUILT/bin" >&2
  exit 1
fi
# name is aarch64-linux-android<NN>-clang → strip to <NN>.
_api=$(basename "$candidate"); _api=${_api#"$TARGET"}; _api=${_api%-clang}
LINKER="$PREBUILT/bin/${TARGET}${_api}-clang"
echo "linker: $LINKER (API $_api)"

# Cargo's `linker` (set in .cargo/config.toml below) is only enough for pure-Rust
# cdylibs. Any dependency with a C `cc` build (e.g. zstd-sys) ALSO needs the
# target C compiler + archiver resolvable — otherwise cc's family detection fails
# with `ToolNotFound: aarch64-linux-android-clang` and the build dies. Export the
# cc/ar env for the target triple (underscore form only — a '-' is an invalid bash
# identifier) and put the NDK tools on PATH so build scripts that invoke the
# `-cc`/`-ar` by name find them.
export PATH="$PREBUILT/bin:$PATH"
export CC_aarch64_linux_android="$LINKER"
export AR_aarch64_linux_android="$PREBUILT/bin/llvm-ar"
export TARGET_CC="$LINKER"
export TARGET_AR="$PREBUILT/bin/llvm-ar"

# Generate the cross-compile config in the workspace's .cargo/config.toml.
mkdir -p .cargo
cat > .cargo/config.toml <<EOF
[target.${TARGET}]
linker = "$LINKER"
EOF

# Build the pure-Rust headless binaries (daemon + window manager).
if [ "$ai_voice" = 1 ]; then
  echo "== building amos-ai with --features asr-sherpa (real on-device ASR) =="
  echo "   (first run downloads sherpa-onnx's aarch64-linux-android static lib from"
  echo "    GitHub; if your proxy blocks it, run on an unrestricted network or set"
  echo "    SHERPA_ONNX_LIB_DIR to a pre-downloaded lib.)"
  cargo build --release --target "$TARGET" -p amos-ai --features asr-sherpa
  cargo build --release --target "$TARGET" -p amos-wm
else
  echo "== building amos-ai + amos-wm (base; no sherpa ASR) =="
  echo "   (pass --ai-voice to build amos-ai with the real sherpa ASR feature)"
  cargo build --release --target "$TARGET" -p amos-ai -p amos-wm
fi

echo
echo "--- compiling radio/connectivity crate (android provider) for $TARGET ---"
# amos-radio with `--features android` pulls in the jni-based AndroidRadioProvider
# (Wi-Fi via WifiManager, Bluetooth via BluetoothAdapter). Pure Rust + jni — no
# extra NDK C libs — but gated behind the feature so desktop builds skip it.
cargo build --release --target "$TARGET" -p amos-radio --features android

echo
echo "--- compiling flashlight/torch crate (android provider) for $TARGET ---"
# amos-flashlight with `--features android` pulls in the jni-based
# AndroidFlashlightProvider (CameraManager#setTorchMode on the rear flash). Pure
# Rust + jni — no extra NDK C libs — but gated behind the feature so desktop
# builds skip it. The System UI APK links it via FlashlightGlue.attach.
cargo build --release --target "$TARGET" -p amos-flashlight --features android

echo
echo "Built binaries:"
find "target/$TARGET/release" -maxdepth 1 -type f \
  -name 'amos-ai' -o -name 'amos-ai.exe' | sort
echo
echo "System UI APK: use scripts/build-apk.sh (the ONLY supported APK entry) —"
echo "  it hard-codes amos-tauri's 'android' feature so the on-device APK always"
echo "  links the jni providers (radio/flashlight/sensor/aaudio). Building the"
echo "  APK without 'android' crashes on launch with UnsatisfiedLinkError."
echo "  cd crates/amos-tauri && cargo tauri android build --features android"
echo
echo "Stage to device (example):"
echo "  adb root; adb push target/$TARGET/release/amos-ai /system/bin/ ; adb shell chmod 0755 /system/bin/amos-ai"
echo "  adb shell mkdir -p /data/amos && adb shell chown system:system /data/amos"
if [ "$ai_voice" = 1 ]; then
  echo
  echo "Real ASR model (matches AMOS_ASR_BACKEND=sherpa + AMOS_SHERPA_MODEL_DIR in"
  echo "  deploy/android/amos.rc -> /data/amos/sherpa). This repo ships a demo model"
  echo "  under models/sherpa-en-20m; push it so the bidi voice channel runs on-device:"
  echo "  adb shell mkdir -p /data/amos/sherpa && adb shell chown system:system /data/amos/sherpa"
  echo "  adb push models/sherpa-en-20m/ /data/amos/sherpa/"
  echo "  adb shell ls /data/amos/sherpa   # expect encoder/decoder/joiner .onnx + tokens.txt"
fi
