.PHONY: all build test check lint cov smoke gated-check run-ai run-ui run-ui-dev run-ui-release run-backends health mobile-init mobile-check clean

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
	cargo build -p amos-tts --features piper
	cargo build -p amos-tts --features piper --example piper_tts
	cargo build -p amos-timesync --features ntp --example ntp_probe
	cargo build -p amos-timesync-cli --features ntp
	cargo build -p amos-supervisor --features timesync
	cargo build -p amos-tauri --features sherpa-asr,piper-tts

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

clean:
	cargo clean
