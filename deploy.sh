#!/usr/bin/env bash
# deploy.sh — unified local gate so your machine cannot drift from CI.
#
# The recurring CI breakage on this repo traces back to environment drift: the
# local macOS dev box (M-series, homebrew NDK 23, a hard-coded NDK path baked
# into a git-ignored .cargo/config.toml) cross-compiles Android with DIFFERENT
# NDK / api levels / clippy strictness than the Ubuntu x86 CI runner. This script
# makes local == CI:
#
#   1. It never hard-codes an NDK path — it DISCOVERS the installed NDK and
#      regenerates .cargo/config.toml + the CC/AR/linker env from it, so a stale
#      machine path can't silently diverge.
#   2. `lint` runs the EXACT commands CI runs (cargo fmt --check + `cargo clippy
#      --workspace --all-targets -- -D warnings`), so a warning you ship locally
#      is guaranteed to fail `make lint` on the runner too.
#   3. `android*` sets the same aarch64-linux-android toolchain env the CI NDK
#      gate (prep-android / .github/docker/ci-android) uses, then runs the same
#      Makefile seams CI gates on.
#
# Usage:
#   ./deploy.sh lint                 # fmt + clippy -D warnings  == CI `make lint`
#   ./deploy.sh test                 # host cargo test --workspace
#   ./deploy.sh android [voice]      # prepare env + android-audio-check (+ai sherpa)
#   ./deploy.sh android-build [--ai-voice]
#                                    # full aarch64-linux-android release build
#   ./deploy.sh docker               # build the pinned native CI container image
#   ./deploy.sh ci-local             # repo-level CI-parity validation script
#   ./deploy.sh doctor               # print discovered NDK/cargo/rustup/versions
#   ./deploy.sh help
set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(pwd)"

# --- NDK discovery ----------------------------------------------------------
# Order: ANDROID_NDK_HOME -> ANDROID_HOME/ndk/* -> ANDROID_SDK_ROOT/ndk/* ->
# homebrew android-commandlinetools ndk/* (the usual M-series Mac install).
ndk_root() {
  local d
  if [[ -n "${ANDROID_NDK_HOME:-}" && -d "$ANDROID_NDK_HOME" ]]; then
    printf '%s\n' "$ANDROID_NDK_HOME"; return 0
  fi
  for base in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" \
      "/opt/homebrew/share/android-commandlinetools" \
      "/usr/local/share/android-commandlinetools"; do
    if [[ -n "$base" && -d "$base/ndk" ]]; then
      d="$(ls -d "$base"/ndk/* 2>/dev/null | sort -V | tail -1)"
      if [[ -n "$d" ]]; then printf '%s\n' "$d"; return 0; fi
    fi
  done
  return 1
}

# prebuilt toolchain dir that matches this host (mac arm64 falls back to the
# darwin-x86_64 dir NDK ships / Rosetta runs under).
prebuilt_dir() {
  local ndk="$1" os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) os=unknown ;;
  esac
  arch="$(uname -m)"; [[ "$arch" == "arm64" ]] && arch=aarch64
  local llvm="$ndk/toolchains/llvm/prebuilt"
  if [[ -d "$llvm/${os}-${arch}" ]]; then printf '%s\n' "$llvm/${os}-${arch}"; return 0; fi
  if [[ -d "$llvm/${os}-x86_64" ]]; then printf '%s\n' "$llvm/${os}-x86_64"; return 0; fi
  ls -d "$llvm"/* 2>/dev/null | head -1
}

# Discover NDK + emit a cross-compile env into $CROSS_ENV_FILE (sourced by the
# caller). Never mutates a committed file.
CROSS_ENV_FILE="${CROSS_ENV_FILE:-$REPO_ROOT/.cargo/amos-deploy-env.sh}"
export_cross_env() {
  local triple="${1:-aarch64-linux-android}"
  local ndk prebuilt bin prefix candidate linker
  ndk="$(ndk_root || true)"
  if [[ -z "$ndk" ]]; then
    echo "error: no Android NDK found. Set ANDROID_NDK_HOME or install one" >&2
    echo "  (macOS: brew install --cask android-commandlinetools)" >&2
    exit 1
  fi
  prebuilt="$(prebuilt_dir "$ndk")"
  bin="$prebuilt/bin"
  candidate="$(ls "$bin"/"$triple"*-clang 2>/dev/null | sort -V | tail -1)"
  if [[ -z "$candidate" ]]; then
    echo "error: no $triple*-clang under $bin" >&2
    exit 1
  fi
  prefix="$(basename "$candidate")"; prefix="${prefix%-clang}"
  linker="$bin/$prefix-clang"

  mkdir -p .cargo
  # Generate the cross-compile config (git-ignored; regenerated from discovery so
  # a stale hard-coded NDK path can never leak into CI).
  cat > .cargo/config.toml <<EOF
[target.${triple}]
linker = "${linker}"
EOF
  {
    echo "export ANDROID_NDK_HOME=\"$ndk\""
    echo "export PATH=\"$bin:\$PATH\""
    echo "export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=\"$linker\""
    echo "export CC_aarch64_linux_android=\"$linker\""
    echo "export CXX_aarch64_linux_android=\"$bin/$prefix-clang++\""
    echo "export AR_aarch64_linux_android=\"$bin/llvm-ar\""
    echo "export TARGET_CC=\"$linker\""
    echo "export TARGET_AR=\"$bin/llvm-ar\""
  } > "$CROSS_ENV_FILE"

  echo "== NDK: $ndk (api ${prefix##*android}) =="
  echo "== linker: $linker =="
}

doctor() {
  echo "--- deploy.sh doctor ---"
  echo "pwd:      $REPO_ROOT"
  echo "rust:     $(rustc --version 2>/dev/null || echo 'MISSING')"
  echo "toolchain file: $(cat rust-toolchain.toml 2>/dev/null | tr '\n' ' ')"
  if command -v cargo-ndk >/dev/null 2>&1; then
    echo "cargo-ndk: present (pin with: cargo install cargo-ndk --version 4.1.2 --locked)"
  else
    echo "cargo-ndk: MISSING (cargo install cargo-ndk --version 4.1.2 --locked)"
  fi
  echo "bun:      $(command -v bun >/dev/null 2>&1 && bun --version || echo 'MISSING (TS gates skip)')"
  local ndk
  if ndk="$(ndk_root || true)"; then
    echo "NDK:      $ndk"
    echo "  prebuilt: $(prebuilt_dir "$ndk")"
  else
    echo "NDK:      none discovered"
  fi
}

lint() {
  echo "== cargo fmt --all --check =="
  cargo fmt --all --check
  echo "== cargo clippy --workspace --all-targets -- -D warnings (CI parity) =="
  cargo clippy --workspace --all-targets -- -D warnings
  if command -v bun >/dev/null 2>&1 && [[ -d crates/amos-tauri/frontend-ts/node_modules ]]; then
    echo "== bun run typecheck =="
    (cd crates/amos-tauri/frontend-ts && bun run typecheck)
  else
    echo "== (skipping TS typecheck: bun or node_modules absent) =="
  fi
  echo "lint PASSED (matches CI make lint)"
}

android_audio() {
  export_cross_env aarch64-linux-android
  # shellcheck disable=SC1090
  source "$CROSS_ENV_FILE"
  echo "== make android-audio-check =="
  make android-audio-check
}

android_voice() {
  export_cross_env aarch64-linux-android
  # shellcheck disable=SC1090
  source "$CROSS_ENV_FILE"
  echo "== make android-ai-sherpa-check =="
  make android-ai-sherpa-check
}

android_build() {
  # Full aarch64-linux-android release build via the existing script (it writes
  # its own .cargo/config.toml from $ANDROID_NDK_HOME, same discovery rule).
  export_cross_env aarch64-linux-android
  # shellcheck disable=SC1090
  source "$CROSS_ENV_FILE"
  bash scripts/build-android.sh "$@"
}

docker_build() {
  command -v docker >/dev/null 2>&1 || { echo "error: docker not found" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "error: docker daemon not running (start Docker Desktop)" >&2; exit 1; }
  echo "== docker build (--platform linux/amd64) .github/docker/ci-android =="
  # Explicit amd64: the prebuilt NDK/protoc/cmdline-tools are x86_64-only, and
  # the CI runner is x86_64 — an arm64 host must NOT produce an arm64 image.
  docker build --platform linux/amd64 \
    -t "ghcr.io/arkCyber/amos-ci-android:26.1.10909125" \
    -t "ghcr.io/arkCyber/amos-ci-android:latest" .github/docker/ci-android
  echo "Built. Optional:"
  echo "  docker push ghcr.io/arkCyber/amos-ci-android:latest"
  echo "  then set repo Variable CI_ANDROID_IMAGE=ghcr.io/arkCyber/amos-ci-android:latest"
}

usage() {
  sed -n '1,26p' "$0"
}

cmd="${1:-help}"
case "$cmd" in
  lint) lint ;;
  test) cargo test --workspace ;;
  android)
    shift || true
    android_audio
    if [[ "${1:-}" == "voice" ]]; then android_voice; fi
    ;;
  android-voice) android_voice ;;
  android-build) shift || true; android_build "$@" ;;
  docker|container) docker_build ;;
  ci-local) bash scripts/ci-local-gate.sh ;;
  doctor) doctor ;;
  help|-h|--help) usage ;;
  *) echo "unknown command: $cmd" >&2; echo; usage; exit 2 ;;
esac

