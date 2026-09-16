#!/usr/bin/env bash
set -euo pipefail
# Build + start the amos-translate mock daemon, launch the System UI, and wait.
# Wraps scripts/gui-smoke.sh --check for a quick readiness probe in CI/headless.
#
# The wrapper is a **sibling** of the script it wraps, so it must resolve `gui-smoke.sh`
# next to itself — resolving the *repo root* and then looking for `gui-smoke.sh` there
# (`$(dirname "$0")/..` exists, but the file does not) made this target die with
# "No such file or directory" on every invocation while still *looking* wired-in
# (REQ-A289: the doc and the `unwired-script-scan` both see a caller, only running it
# reveals that it cannot work).
"$(cd "$(dirname "$0")" && pwd)/gui-smoke.sh" --check
