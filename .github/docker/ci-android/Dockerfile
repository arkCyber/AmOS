# syntax=docker/dockerfile:1
# AmOS canonical "Android-native CI" toolchain image.
#
# Purpose: this is the SINGLE source of the pinned Android toolchain used to gate
# the NDK-dependent seams (amos-audio AAudio/TinyALSA link, amos-ai + real
# sherpa-onnx Android ASR) and the native-gated backends (sherpa/Piper). CI jobs
# that would otherwise re-provision the NDK on a *floating* `ubuntu-latest`
# runner (whose system deps/NDK drift underneath us) can instead run inside this
# container, so the exact NDK / cargo-ndk / protoc / Tauri libs are the same
# every run — killing the "works on my M-series Mac, breaks on the Ubuntu x86
# runner" class of environment drift.
#
# Build / push (pins must mirror the host composite action prep-android):
#   docker build -t ghcr.io/arkCyber/amos-ci-android:26.1.10909125 .
#   docker tag  ghcr.io/arkCyber/amos-ci-android:26.1.10909125 \
#               ghcr.io/arkCyber/amos-ci-android:latest
#   docker push ghcr.io/arkCyber/amos-ci-android:latest
#
# Then opt CI into container mode by setting the repository Variable
#   CI_ANDROID_IMAGE = ghcr.io/arkCyber/amos-ci-android:latest
# (Settings > Secrets and variables > Actions). Host-fallback jobs in ci.yml use
# the identical pins below via ./.github/actions/prep-android, so both modes stay
# in lockstep. `.github/workflows/container-image.yml` automates build+push.

# --- Pins -------------------------------------------------------------------
ARG NDK_VERSION=26.1.10909125        # must equal prep-android input ndk-version
ARG BUILD_TOOLS_VERSION=34.0.0
ARG ANDROID_CMDLINE_VERSION=latest
ARG PROTOBUF_VERSION=28.3            # matches the tonic/prost stack we pin
ARG CARGO_NDK_VERSION=4.1.2          # must equal prep-android input cargo-ndk-version
ARG RUST_CHANNEL=stable              # rust-toolchain.toml is also `stable`

# The CI runner + the prebuilt NDK/protoc/cmdline-tools we install are all x86_64.
# Pinning the platform here means an arm64 (Apple Silicon) build host still
# produces the same amd64 image (Docker Desktop emulates via qemu) instead of
# silently pulling arm64 Ubuntu and then failing on x86_64-only downloads.
FROM --platform=linux/amd64 ubuntu:24.04

ARG NDK_VERSION
ARG BUILD_TOOLS_VERSION
ARG ANDROID_CMDLINE_VERSION
ARG PROTOBUF_VERSION
ARG CARGO_NDK_VERSION
ARG RUST_CHANNEL

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_NDK_HOME=/opt/android-sdk/ndk/${NDK_VERSION}
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH="${CARGO_HOME}/bin:/opt/android-sdk/cmdline-tools/latest/bin:${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/bin:/usr/local/bin:${PATH}"

# --- Ubuntu 24.04 system deps ----------------------------------------------
# Tauri v2 on 24.04 needs *ayatana*-appindicator (the old `libappindicator3-dev`
# was dropped on 24.04 — a classic reason gated jobs "suddenly" break when
# runners float from 22.04 to 24.04). build-essential + cmake + pkg-config cover
# crates that build C at cross-compile time (zstd-sys, onnxruntime, …).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        curl \
        file \
        git \
        libasound2-dev \
        libayatana-appindicator3-dev \
        libgtk-3-dev \
        librsvg2-dev \
        libssl-dev \
        libwebkit2gtk-4.1-dev \
        openjdk-17-jre-headless \
        patchelf \
        pkg-config \
        python3 \
        unzip \
        zip \
    && rm -rf /var/lib/apt/lists/*

# --- Android cmdline-tools + pinned NDK / build-tools ----------------------
# sdkmanager needs JAVA_HOME (set above). cmdline-tools must live at
# $ANDROID_SDK_ROOT/cmdline-tools/latest for `sdkmanager` to resolve.
RUN mkdir -p "${ANDROID_SDK_ROOT}/cmdline-tools" \
    && curl -fsSL -o /tmp/android-clt.zip \
         "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" \
    && unzip -q /tmp/android-clt.zip -d /tmp/android-clt \
    && rm -f /tmp/android-clt.zip \
    && mv /tmp/android-clt/cmdline-tools "${ANDROID_SDK_ROOT}/cmdline-tools/latest" \
    && rm -rf /tmp/android-clt \
    && yes | sdkmanager --licenses >/dev/null 2>&1 || true \
    && sdkmanager "build-tools;${BUILD_TOOLS_VERSION}" "ndk;${NDK_VERSION}" >/dev/null \
    && rm -rf "${ANDROID_SDK_ROOT}/.temp"

# --- Rust: pinned channel + android targets + pinned cargo-ndk --------------
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal \
            --default-toolchain "${RUST_CHANNEL}" \
            --component rustfmt,clippy \
    && rustup target add \
        aarch64-linux-android \
        armv7-linux-androideabi \
        x86_64-linux-android \
        i686-linux-android \
    && cargo install cargo-ndk --version "${CARGO_NDK_VERSION}" --locked

# --- protoc (tonic-prost / amos-proto build) ---------------------------------
RUN curl -fsSL -o /tmp/protoc.zip \
        "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOBUF_VERSION}/protoc-${PROTOBUF_VERSION}-linux-x86_64.zip" \
    && unzip -q /tmp/protoc.zip -d /usr/local \
    && rm -f /tmp/protoc.zip

# --- validate the bake ------------------------------------------------------
RUN set -eux; \
    test "$("${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf" --version >/dev/null 2>&1 && echo ndk-ok || echo ndk-missing)"; \
    cargo-ndk --version; \
    protoc --version; \
    rustc --version; \
    clippy-driver --version

WORKDIR /workspace
