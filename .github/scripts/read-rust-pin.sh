#!/usr/bin/env bash
# .github/scripts/read-rust-pin.sh — the ONE way CI learns which Rust toolchain to
# install.
#
# Why this file exists: `dtolnay/rust-toolchain@stable` *overrides*
# `rust-toolchain.toml`, so every job that used it ran a **different** toolchain
# from the one a local `rustup`/`cargo` resolves. rustfmt output and the clippy
# lint set both move between releases, so "green locally, red in CI" (this repo's
# recorded `make lint` fmt failures) was structural, not accidental — see
# `docs/ci-engineering.md` §6.
#
# Usage in a workflow job (the pin step must come first):
#
#     - name: Read the pinned Rust toolchain (source: rust-toolchain.toml)
#       id: rust-pin
#       run: bash .github/scripts/read-rust-pin.sh
#
#     - name: Install the pinned Rust toolchain
#       uses: dtolnay/rust-toolchain@master
#       with:
#         toolchain: ${{ steps.rust-pin.outputs.channel }}
#         components: rustfmt, clippy
#
# Fails loudly (non-zero) when the file is missing or has no `channel = "…"`:
# silently falling back to `stable` is exactly the drift this prevents.
# Enforced by `scripts/ci-drift-scan.mjs` (rule R3).
set -euo pipefail

file="${AMOS_TOOLCHAIN_FILE:-rust-toolchain.toml}"

if [ ! -f "$file" ]; then
  echo "::error::$file is missing — CI has no pinned Rust toolchain" >&2
  exit 1
fi

channel="$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -1)"
if [ -z "$channel" ]; then
  echo "::error::$file has no channel = \"…\" — CI has no pinned Rust toolchain" >&2
  exit 1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "channel=$channel" >> "$GITHUB_OUTPUT"
fi
echo "Rust toolchain pinned by $file: $channel"
