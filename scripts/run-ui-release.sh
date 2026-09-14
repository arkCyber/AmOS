#!/usr/bin/env bash
# run-ui-release.sh — build & launch the *embedded* (release) System UI.
#
# The DEBUG binary loads build.devUrl (localhost:1420) — which can collide with
# another app — so to view OUR UI always use the release build (embeds dist,
# ignores devUrl, binds no port). Backends are started/left as configured.
set -euo pipefail
ROOT="${AMOS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# The socket is a single value used in two places (the message and the launch env).
# Reading `$AMOS_SOCKET` **bare** in the message made this whole script die with
# "unbound variable" under `set -u` on any shell that had not exported it — i.e. the
# documented PC path built the release binary and then never launched anything
# (found by actually running it, REQ-A228).
SOCK="${AMOS_SOCKET:-/tmp/amos-ai.sock}"

# This binary embeds `frontend-ts/dist` (tauri.conf's `beforeBuildCommand` is empty),
# so a stale bundle would ship a UI that does not match the tree — refuse instead of
# launching something that silently is not this source (REQ-A228). Checked *before*
# any side effect (the daemon is only started once the tree is known good).
if ! node "$ROOT/scripts/dist-freshness.mjs"; then
  echo "  run 'make frontend-dist' first (and re-run this script)." >&2
  exit 1
fi

echo "==> ensuring amos-ai is running (resumes persisted local/cloud choice)"
"$ROOT/scripts/ai-backend.sh"

echo "==> building release amos-tauri (embedded UI)…"
cargo build --release -p amos-tauri

echo "==> launching embedded UI (no port; AMOS_SOCKET=$SOCK)"
exec env -u ALL_PROXY -u all_proxy \
  AMOS_ROOT="$ROOT" \
  AMOS_SOCKET="$SOCK" \
  "$ROOT/target/release/amos-tauri"
