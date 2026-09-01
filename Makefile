.PHONY: all build test check lint run-ai run-ui clean

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

# Production gate: formatting + clippy must be clean.
lint:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings

run-ai:
	cargo run -p amos-ai

run-ui:
	cargo run -p amos-tauri

clean:
	cargo clean
