#!/usr/bin/env bash
# Build the Rust pieces of Amos for aarch64-linux-android.
#
# * Headless binaries (amos-ai, amos-wm) output under
#   target/aarch64-linux-android/release/ for staging into /system/bin/ (amos.rc).
# * amos-radio with --features android compiles the jni AndroidRadioProvider —
#   a *lib* the System UI APK links (cargo tauri android build --features android).
#
# Requires: Android NDK (ANDROID_NDK_HOME), rustup target aarch64-linux-android.
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

TARGET=aarch64-linux-android
HOST_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
LINKER="$NDK/toolchains/llvm/prebuilt/${HOST_OS}-x86_64/bin/${TARGET}34-clang"
echo "linker: $LINKER"

# Generate the cross-compile config in the workspace's .cargo/config.toml.
mkdir -p .cargo
cat > .cargo/config.toml <<EOF
[target.${TARGET}]
linker = "$LINKER"
EOF

# Build the pure-Rust headless binaries (daemon + window manager).
cargo build --release --target "$TARGET" -p amos-ai -p amos-wm

echo
echo "--- compiling radio/connectivity crate (android provider) for $TARGET ---"
# amos-radio with `--features android` pulls in the jni-based AndroidRadioProvider
# (Wi-Fi via WifiManager, Bluetooth via BluetoothAdapter). Pure Rust + jni — no
# extra NDK C libs — but gated behind the feature so desktop builds skip it.
cargo build --release --target "$TARGET" -p amos-radio --features android

echo
echo "Built binaries:"
find "target/$TARGET/release" -maxdepth 1 -type f \
  -name 'amos-ai' -o -name 'amos-ai.exe' | sort
echo
echo "System UI: enable amos-tauri's 'android' feature so its RadioBridge is backed"
echo "  by AndroidRadioProvider, then build the APK:"
echo "  cd crates/amos-tauri && cargo tauri android build --features android"
echo
echo "Stage to device (example):"
echo "  adb root; adb push target/$TARGET/release/amos-ai /system/bin/ ; adb shell chmod 0755 /system/bin/amos-ai"
echo "  adb shell mkdir -p /data/amos && adb shell chown system:system /data/amos"
