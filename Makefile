.PHONY: all build test check lint smoke gated-check run-ai run-ui mobile-init mobile-check clean

all: build

build:
	cargo build --workspace

# Comprehensive tests: Rust (unit + end-to-end RPC over UDS) + JS (launcher).
test:
	cargo test --workspace
	cd crates/amos-tauri/frontend && bun run test

# Fast syntax check of the frontend JS only.
check:
	cd crates/amos-tauri/frontend && bun run check

# Headless end-to-end smokes: start a mock daemon and drive the real chain.
smoke:
	bash scripts/int-cli-smoke.sh
	cargo test -p amos-translate --test full_chain

# Compile the gated native backends (sherpa ASR / Piper TTS). Requires network
# to download prebuilt native libs — run on a networked machine.
gated-check:
	cargo build -p amos-asr --features sherpa
	cargo build -p amos-tts --features piper

# Production gate: formatting + clippy must be clean.
lint:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings

run-ai:
	cargo run -p amos-ai

run-ui:
	cargo run -p amos-tauri

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
