#!/usr/bin/env bash
# Cross-compile + link gate for amos-audio's Android audio seams.
#
# What this proves (all host-side, no device needed):
#   1. The hand-written AAudio/TinyALSA FFI seams *compile* for every Android ABI
#      (arm64-v8a, x86_64, armeabi-v7a) when the `aaudio`/`tinyalsa` features are on.
#   2. AAudio actually *links* against the NDK's libaaudio.so (API >= 26): the
#      `aaudio_link_smoke` example is an Android *executable*, which cannot carry
#      undefined symbols, so a successful link proves the #[link(name = "aaudio")]
#      resolves every AAudio_* extern. (TinyALSA is deliberately *not* linked here:
#      libtinyalsa is an AOSP system library that the NDK does not ship, so that
#      seam's link step happens on a system image — see docs/aaudio-sherpa-bringup.md.)
#
# Requires: Android NDK (ANDROID_NDK_HOME or ANDROID_SDK_ROOT/ndk/*), cargo-ndk,
#           rustup targets aarch64-linux-android x86_64-linux-android armv7-linux-androideabi.
# Optional env: AMOS_NDK_API (default 26 — AAudio ships in the NDK from API 26).
set -euo pipefail
cd "$(dirname "$0")/.."

API="${AMOS_NDK_API:-26}"

# --- Locate the NDK ---------------------------------------------------------
if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  if [[ -n "${ANDROID_SDK_ROOT:-}" && -d "$ANDROID_SDK_ROOT/ndk" ]]; then
    ANDROID_NDK_HOME="$(ls -d "$ANDROID_SDK_ROOT/ndk"/* | sort -V | tail -1)"
  fi
fi
if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "$ANDROID_NDK_HOME" ]]; then
  echo "error: set ANDROID_NDK_HOME to your Android NDK path (or ANDROID_SDK_ROOT with an ndk/ dir)" >&2
  exit 1
fi
command -v cargo-ndk >/dev/null 2>&1 || { echo "error: cargo-ndk not installed (cargo install cargo-ndk)" >&2; exit 1; }
export ANDROID_NDK_HOME

# --- rustup targets (install missing ones) ---------------------------------
for t in aarch64-linux-android x86_64-linux-android armv7-linux-androideabi; do
  rustup target list --installed 2>/dev/null | grep -q "$t" || rustup target add "$t"
done

ABIS=(arm64-v8a x86_64 armeabi-v7a)
echo "== NDK audio seam compile gate (AAudio + TinyALSA), API $API =="
for abi in "${ABIS[@]}"; do
  echo "--- compile $abi (aaudio + tinyalsa) ---"
  cargo ndk -t "$abi" -P "$API" build --release -p amos-audio --features aaudio,tinyalsa
done

echo
echo "== AAudio link smoke (arm64-v8a) =="
# An Android executable must resolve every AAudio_* symbol from libaaudio.so.
cargo ndk -t arm64-v8a -P "$API" build --release -p amos-audio \
  --features aaudio --example aaudio_link_smoke

BIN="target/aarch64-linux-android/release/examples/aaudio_link_smoke"
if ! llvm-readelf -d "$BIN" 2>/dev/null | grep -q 'libaaudio.so' \
   && ! "${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/"*/bin/llvm-readelf -d "$BIN" 2>/dev/null | grep -q 'libaaudio.so'; then
  echo "error: $BIN does not declare a DT_NEEDED dependency on libaaudio.so — #[link(name=\"aaudio\")] is not binding" >&2
  exit 1
fi
echo "ok: $BIN links against libaaudio.so (DT_NEEDED confirmed)"

echo
echo "== AAudio data-callback probe (arm64-v8a) =="
# The run-time callback probe must also compile + link (it references the same
# AAudioStreamBuilder_setDataCallback/setFramesPerDataCallback FFI as the seam).
cargo ndk -t arm64-v8a -P "$API" build --release -p amos-audio \
  --features aaudio --example aaudio_callback_probe
echo "ok: aaudio_callback_probe compiled + linked for arm64-v8a"

echo
echo "Amos audio Android seams: compile + AAudio link gate PASSED."
