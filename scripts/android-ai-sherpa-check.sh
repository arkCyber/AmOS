#!/usr/bin/env bash
# Cross-compile gate for amos-ai WITH the real sherpa ASR backend on Android.
#
# This proves the daemon can be built for an on-device target with genuine local
# speech recognition (`asr-sherpa` → amos-asr/sherpa → sherpa-onnx). It needs a
# sherpa-onnx *Android* shared library to link against.
#
# Why this script stages the lib itself (not just cargo):
# sherpa-onnx-sys 1.13.7's auto-download assumes the Android archive extracts to a
# `<version>-android/` directory, but the real `...-android.tar.bz2` unpacks its
# `jniLibs/<abi>/` directly with no wrapping dir. So `SHERPA_ONNX_LIB_DIR` must be
# pointed at the actual extracted dir (desktop archives have `lib/` under a wrapping
# dir, which is why host builds auto-work). This is an upstream packaging quirk, not
# an AmOS bug — staged here so the gate is deterministic.
#
# Requires: Android NDK (ANDROID_NDK_HOME or ANDROID_SDK_ROOT/ndk/*), cargo-ndk,
#           rustup target aarch64-linux-android, protoc, and network to fetch the
#           sherpa-onnx Android archive on first run.
# Optional env: AMOS_SHERPA_VERSION (default 1.13.7, matches Cargo.toml),
#               AMOS_NDK_API (default 26), SHERPA_ONNX_LIB_DIR (use a pre-staged dir).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${AMOS_SHERPA_VERSION:-1.13.7}"
API="${AMOS_NDK_API:-26}"
ABI="${AMOS_ANDROID_ABI:-arm64-v8a}"

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
command -v cargo-ndk >/dev/null 2>&1 || { echo "error: cargo-ndk not installed" >&2; exit 1; }
command -v protoc >/dev/null 2>&1 || { echo "error: protoc not installed (amos-proto needs it)" >&2; exit 1; }
rustup target list --installed 2>/dev/null | grep -q aarch64-linux-android || rustup target add aarch64-linux-android
export ANDROID_NDK_HOME

# Map Android ABI to the Rust target triple + the archive's jniLibs subdir.
case "$ABI" in
  arm64-v8a) TRIPLE=aarch64-linux-android ;;
  armeabi-v7a) TRIPLE=armv7-linux-androideabi ;;
  x86_64) TRIPLE=x86_64-linux-android ;;
  x86) TRIPLE=i686-linux-android ;;
  *) echo "error: unknown ABI $ABI" >&2; exit 1 ;;
esac

# --- Stage the sherpa-onnx Android shared lib ------------------------------
if [[ -n "${SHERPA_ONNX_LIB_DIR:-}" ]]; then
  echo "== using pre-staged SHERPA_ONNX_LIB_DIR=$SHERPA_ONNX_LIB_DIR =="
else
  CACHE="target/sherpa-onnx-android-$VERSION"
  ARCHIVE="$CACHE/sherpa-onnx-v$VERSION-android.tar.bz2"
  LIB_DIR="$CACHE/jniLibs/$ABI"
  if [[ ! -d "$LIB_DIR" ]]; then
    mkdir -p "$CACHE"
    URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v$VERSION/sherpa-onnx-v$VERSION-android.tar.bz2"
    echo "== downloading $URL =="
    curl -fL --retry 3 -o "$ARCHIVE" "$URL"
    echo "== extracting (unpacks jniLibs/ directly; no wrapping dir) =="
    # The archive has no top-level wrapping dir: extract into a temp then move.
    TMP="$(mktemp -d)"
    tar -xjf "$ARCHIVE" -C "$TMP"
    mkdir -p "$CACHE/jniLibs"
    mv "$TMP"/jniLibs/* "$CACHE/jniLibs/" 2>/dev/null || mv "$TMP"/jniLibs "$CACHE/"
    rm -rf "$TMP"
  fi
  [[ -d "$LIB_DIR" ]] || { echo "error: staged lib dir missing: $LIB_DIR" >&2; exit 1; }
  export SHERPA_ONNX_LIB_DIR="$PWD/$LIB_DIR"
  echo "== SHERPA_ONNX_LIB_DIR=$SHERPA_ONNX_LIB_DIR =="
fi

echo "== cross-compiling amos-ai --features asr-sherpa for $ABI ($TRIPLE), API $API =="
# all_proxy may be a socks:// URL that ureq (no SOCKS support) can't use for the
# build script's own downloads; drop it so any download uses the http(s)_proxy.
env -u all_proxy -u ALL_PROXY \
  cargo ndk -t "$ABI" -P "$API" build -p amos-ai --features asr-sherpa

BIN="target/$TRIPLE/debug/amos-ai"
if command -v llvm-readelf >/dev/null 2>&1; then
  RE="llvm-readelf"
else
  RE="$(ls "${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/"*/bin/llvm-readelf 2>/dev/null | head -1)"
fi
if ! "$RE" -d "$BIN" 2>/dev/null | grep -q 'libsherpa-onnx-c-api.so'; then
  echo "error: $BIN does not link libsherpa-onnx-c-api.so — SHERPA_ONNX_LIB_DIR not binding" >&2
  exit 1
fi
echo "ok: $BIN links libsherpa-onnx-c-api.so (real on-device ASR bound)"
echo "Amos amos-ai + sherpa Android cross-compile gate PASSED."
