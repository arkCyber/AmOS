#!/usr/bin/env bash
set -euo pipefail
# Build + start the amos-translate mock daemon, launch the System UI, and wait.
# Wraps scripts/gui-smoke.sh --check for a quick readiness probe in CI/headless.
"$(cd "$(dirname "$0")/.." && pwd)/gui-smoke.sh" --check
