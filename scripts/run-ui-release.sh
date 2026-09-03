#!/usr/bin/env bash
# run-ui-release.sh — build & launch the *embedded* (release) System UI.
#
# The DEBUG binary loads build.devUrl (localhost:1420) — which can collide with
# another app — so to view OUR UI always use the release build (embeds dist,
# ignores devUrl, binds no port). Backends are started/left as configured.
set -euo pipefail
ROOT="${AMOS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

echo "==> ensuring amos-ai is running (resumes persisted local/cloud choice)"
"$ROOT/scripts/ai-backend.sh"

echo "==> building release amos-tauri (embedded UI)…"
cargo build --release -p amos-tauri

echo "==> launching embedded UI (no port; AMOS_SOCKET=$AMOS_SOCKET)"
exec env -u ALL_PROXY -u all_proxy \
  AMOS_ROOT="$ROOT" \
  AMOS_SOCKET="${AMOS_SOCKET:-/tmp/amos-ai.sock}" \
  "$ROOT/target/release/amos-tauri"
