.PHONY: all build test check lint cov smoke gated-check run-ai run-ui run-ui-dev run-ui-release run-backends health mobile-init mobile-check android-app android-audio-check android-ai-sherpa-check android-voice-bringup android-rag-bringup pdf-android-check vector-db-check ci-local clean honesty-smoke deploy doctor

all: build

build:
	cargo build --workspace

# Comprehensive tests: Rust (unit + end-to-end RPC over UDS) + TS System-UI
# shell (bun). `cargo test --workspace` picks up every
# crate's tests/ dir automatically (incl. crates/amos-tauri/tests/ai_daemon_e2e.rs).
test:
	cargo test --workspace
	# TS System-UI: bun-iso-test.mjs runs pure files in one process and each DOM
	# test file in its OWN process (happy-dom global windows are per-process).
	cd crates/amos-tauri/frontend-ts && bun run test

# Fast check of the React/TS System-UI (tests + typecheck).
check:
	cd crates/amos-tauri/frontend-ts && bun run check

# TS core-lib coverage gate (P2-1): line coverage over src/lib/** must stay >= the
# threshold enforced by scripts/lib-coverage-gate.mjs (default 80%). Runs over the
# pure (non-DOM) files so no shared happy-dom process is involved (DOM files are
# already covered by correctness in `make test`).
cov:
	cd crates/amos-tauri/frontend-ts && bun run coverage:gate

# Headless end-to-end smokes: start a mock daemon and drive the real chain.
smoke:
	bash scripts/int-cli-smoke.sh
	cargo test -p amos-translate --test full_chain

# Supervisor headless smoke: launch real amos-ai + amos-translate (mock) under the
# supervisor with no GUI, SIGUSR1 hot-restart, and a graceful SIGINT stop that must
# not orphan the child daemons (regression guard).
sup-smoke:
	bash scripts/supervisor-smoke.sh

# Time-sync headless smoke: supervisor (timesync) calibrates + persists state,
# propagates AMOS_TIMESYNC_STATE to a child, and the amos-timesync-cli reads the
# calibrated clock; graceful SIGINT stop with no orphans.
timesync-smoke:
	bash scripts/timesync-smoke.sh

# Local-model end-to-end: Piper TTS -> sherpa streaming ASR -> daemon translate.
# (Piper + sherpa are real; translation uses a deterministic mock daemon unless
# AMOS_TRANSLATE_SOCKET points at a live daemon.)
e2e-local:
	bash scripts/e2e-local-models.sh

# Compile the gated native backends (sherpa ASR / Piper TTS / SNTP time sync) +
# the sherpa examples + the amos-tauri native bridge (sherpa-asr + piper-tts
# together). Requires network to download prebuilt native libs — run on a
# networked machine.
gated-check:
	cargo build -p amos-asr --features sherpa
	cargo build -p amos-asr --features sherpa --example sherpa_asr
	cargo build -p amos-asr --features sherpa --example sherpa_session
	# Real local ASR inside the AI daemon (bidi Payload::Audio → sherpa).
	cargo build -p amos-ai --features asr-sherpa
	cargo test -p amos-ai --features asr-sherpa --test bidi_sherpa_audio
	# System-UI resident voice capture thread (feeds amos-audio captures to the
	# daemon; single- and multi-utterance e2e).
	cargo test -p amos-tauri --test assistant_voice_e2e
	cargo build -p amos-tts --features piper
	cargo build -p amos-tts --features piper --example piper_tts
	cargo build -p amos-timesync --features ntp --example ntp_probe
	cargo build -p amos-timesync-cli --features ntp
	cargo build -p amos-supervisor --features timesync
	cargo build -p amos-tauri --features sherpa-asr,piper-tts
	# QCOM/MTK accelerator seams (amos_ai::accelerator): `qnn`/`neuropilot` feature
	# flags gate vendor-NPU claims — compile + unit-test both branches (no network).
	cargo check -p amos-ai --features qnn,neuropilot
	cargo test -p amos-ai --features qnn,neuropilot --lib accelerator::
	# Host compile-checks of the feature-gated Android HAL/power seams (no device /
	# no NDK needed; runtime requires a real Android VM + Context at device bring-up).
	cargo check -p amos-radio --features android
	cargo check -p amos-telephony --features android
	cargo check -p amos-sensor --features android
	cargo check -p amos-media --features android
	cargo check -p amos-profiling --features android
	# Battery/thermal telemetry seam feeding the energy governor (amos-power).
	cargo check -p amos-power --features android
	# CPU/NPU frequency-governor sysfs applier (amos-power, `linux` feature):
	# real scaling_max_freq writes + tempdir tests; host-compiles without a device.
	cargo check -p amos-power --features linux
	cargo test -p amos-power --features linux --lib
	# System working-status sampler (amos-monitor): real /proc reads over an
	# injected root (`linux`) + on-device Android skeleton (`android`). The linux
	# tests run entirely over a tempdir fixture — no root/device needed.
	cargo check -p amos-monitor --features linux
	cargo test -p amos-monitor --features linux --lib
	cargo check -p amos-monitor --features android

# Production gate: formatting + clippy must be clean; TS shells must typecheck.
lint:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	cd crates/amos-tauri/frontend-ts && bun run typecheck

run-ai:
	cargo run -p amos-ai

run-ui:
	cargo run -p amos-tauri

# Run the System UI from source against a local frontend dev server (fixes the
# blank/white window that appears when the dev binary can't reach :5173).
run-ui-dev:
	bash scripts/run-gui-dev.sh

# Production boot: start backends (AI honors the persisted local/cloud choice)
# + translate, wait until both UDS sockets are ready. Then: cargo run -p amos-tauri
run-backends:
	bash scripts/run-backends.sh

# Build & launch the EMBEDDED (release) System UI. The debug binary loads
# devUrl (localhost:1420) and can collide with another app; use this target.
run-ui-release:
	bash scripts/run-ui-release.sh

# RPC readiness probe: both daemons must answer get_status running=true.
health:
	bash scripts/health-backends.sh

# Host-side "honesty" smoke: proves the AI daemon truthfully reports its real
# engine + degraded state (engine/engine_model/degraded/asr) over get_status —
# mock=not-degraded, a requested-but-unreachable real engine=degraded, and
# ollama follows reachability. No GUI / no real device needed.
honesty-smoke:
	bash scripts/ai-honesty-smoke.sh

# Print the mobile-targets init guide (requires Android SDK / Xcode on a real
# machine; see docs/mobile-targets.md for the exact commands).
mobile-init:
	@echo "Amos mobile target initialization guide:"
	@echo "  -> docs/mobile-targets.md"
	@echo ""
	@echo "Quick summary (run on a machine with Android SDK / Xcode):"
	@echo "  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android"
	@echo "  rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim"
	@echo "  cargo install tauri-cli --version ^2 --locked"
	@echo "  cd crates/amos-tauri && cargo tauri android init && cargo tauri ios init"
	@echo "  cargo tauri android build --debug && cargo tauri ios build --debug"

# Best-effort prerequisite check for mobile builds (non-fatal if tools absent).
mobile-check:
	@echo "--- Amos mobile toolchain check ---"
	@(rustup target list --installed 2>/dev/null | grep -q aarch64-linux-android && echo "[ok] rust android target" || echo "[warn] android rust target not installed (see docs/mobile-targets.md)")
	@(rustup target list --installed 2>/dev/null | grep -q aarch64-apple-ios && echo "[ok] rust ios target" || echo "[warn] ios rust target not installed (see docs/mobile-targets.md)")
	@(command -v cargo-tauri >/dev/null 2>&1 && echo "[ok] tauri-cli" || echo "[warn] tauri-cli not installed (cargo install tauri-cli --version ^2 --locked)")
	@(command -v java >/dev/null 2>&1 && echo "[ok] java" || echo "[warn] java not found (JDK 17+ needed for Android)")
	@(test -n "$$ANDROID_HOME" && echo "[ok] ANDROID_HOME=$$ANDROID_HOME" || echo "[warn] ANDROID_HOME unset (Android SDK)")
	@(command -v xcodebuild >/dev/null 2>&1 && echo "[ok] xcodebuild (iOS)" || echo "[warn] xcodebuild not found (iOS)")

# Cross-compile + link gate for amos-audio's Android audio seams (AAudio/TinyALSA
# FFI). Compiles every ABI and link-checks AAudio against the NDK's libaaudio.so
# via the aaudio_link_smoke example. Requires NDK + cargo-ndk + rustup android
# targets (see scripts/android-audio-check.sh). No device needed.
android-audio-check:
	bash scripts/android-audio-check.sh

# Cross-compile gate for amos-ai WITH real sherpa on-device ASR (asr-sherpa) on
# Android. Stages the sherpa-onnx Android shared lib (upstream archive has no
# wrapping dir, so auto-download fails; see script), then builds the daemon for
# arm64-v8a and link-checks libsherpa-onnx-c-api.so. Requires NDK + cargo-ndk +
# protoc + network. No device needed.
android-ai-sherpa-check:
	bash scripts/android-ai-sherpa-check.sh

# One-shot DEVICE driver for the always-on native voice chain (AAudio → local
# sherpa → assistant). Host-verifiable without a device: `bash -n` + `--dry-run`
# print the exact plan; `--check-prereqs` only checks adb. `--apply` actually
# touches an attached device (stage sherpa model, grant RECORD_AUDIO, run the
# AAudio probe → C2/C3 evidence) and prints the honest C1–C7 verdict.
android-voice-bringup:
	bash scripts/android-voice-bringup.sh

# One-shot device driver for the offline RAG chain (daemon `Rag` + rag_once +
# bench_arm). Mirrors android-voice-bringup: --check-prereqs / --dry-run / --apply.
# Pass extra args through ARGS (e.g. `make android-rag-bringup ARGS='--apply --device X'`).
android-rag-bringup:
	bash scripts/android-rag-bringup.sh $(ARGS)

# Build + install the System UI APK on a connected device, with the two steps
# that are easy to forget made explicit and ordered:
#   1. rebuild the frontend `dist` (tauri.conf's beforeBuildCommand is EMPTY, so
#      `cargo tauri android build` embeds whatever `dist/` already holds — a
#      stale bundle silently ships an old UI),
#   2. build the arm64 debug APK with the `android` feature,
#   3. install it with runtime permissions granted (`-g`).
# Override the package/devices as needed: `make android-app DEVICE=...`.
android-app: 
	cd crates/amos-tauri/frontend-ts && bun run build
	cargo tauri android build --debug --features android --target aarch64
	adb install -r -g crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk $(if $(DEVICE),-s $(DEVICE),)

# Cross-compile gate for the offline-RAG PDF data-extraction crate on Android.
# The crate is pure Rust on lopdf (no C), so this only needs the rustup android
# target (no NDK linker for a `check`). Run `rustup target add aarch64-linux-android`
# first if missing. No device needed.
pdf-android-check:
	cargo check -p amos-pdf-parser --target aarch64-linux-android
	cargo test -p amos-pdf-parser

# Host + Android-cross-compile gate for the offline vector-retrieval core
# (amos-vector-db). Pure Rust on serde — the aarch64 `check` needs no NDK linker.
# Also runs clippy + fmt (crate hygiene) and prints the honest host benchmark.
vector-db-check:
	cargo check -p amos-vector-db --target aarch64-linux-android
	cargo test -p amos-vector-db
	cargo clippy -p amos-vector-db --all-targets -- -D warnings
	cargo fmt -p amos-vector-db -- --check
	cargo run -p amos-vector-db --example bench_arm -- 2000 64


# Local CI-parity gate: shell-syntax + workflow YAML + native-toolchain pin
# parity + (optional) container build. No push / no CI needed. See
# scripts/ci-local-gate.sh. Pass --docker to also build the container image.
ci-local:
	bash scripts/ci-local-gate.sh

# Unified local deploy/gate entrypoint (deploy.sh). Keeps the local M-series Mac
# NDK/env/clippy in lockstep with the Ubuntu CI runner and regenerates
# .cargo/config.toml from the DISCOVERED NDK (no stale hard-coded paths).
#   make deploy        -> ./deploy.sh help
#   ./deploy.sh lint / test / android / android-build / docker / ci-local / doctor
deploy:
	./deploy.sh

doctor:
	./deploy.sh doctor

clean:
	cargo clean
