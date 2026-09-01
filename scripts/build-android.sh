#!/usr/bin/env bash
# Build the headless Rust pieces of Amos for aarch64-linux-android.
#
# Outputs static binaries under target/aarch64-linux-android/release/ which can
# be staged into /system/bin/ on the no-UI Android base (see amos.rc).
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
echo "Built binaries:"
find "target/$TARGET/release" -maxdepth 1 -type f \
  -name 'amos-ai' -o -name 'amos-ai.exe' | sort
echo
echo "Stage to device (example):"
echo "  adb root; adb push target/$TARGET/release/amos-ai /system/bin/ ; adb shell chmod 0755 /system/bin/amos-ai"
echo "  adb shell mkdir -p /data/amos && adb shell chown system:system /data/amos"
