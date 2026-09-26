#!/usr/bin/env bash
# device.sh — build-on-demand runner for the macOS device tool (REQ-A486).
#
# Why a wrapper instead of the `.swift` file alone: the tool needs `swiftc`, and recompiling it on
# every call would make the *interactive* use (dump, click, dump again) unpleasant enough that people
# go back to ad-hoc scripts. So the binary is cached under `target/device-tool/` and rebuilt only
# when the source is newer — `make device-tool ARGS='ax Amos 新建窗口'` then behaves like any other
# command.
#
# The corpus that `unwired-script-scan.mjs` governs is `*.sh`/`*.mjs`/`*.js`/`*.cjs`, so this
# wrapper is the wireable half: it has a Makefile target and a row in `docs/GATES.md`, and the
# `.swift` source is its build input (checked by `lint-inputs-scan.mjs` like any other).
#
# usage: bash scripts/device.sh <command> [args]      (see the Swift file's header for the commands)
#        bash scripts/device.sh --selftest            (the device-free half; `make lint` runs it)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/scripts/device/amos-device.swift"
BIN="$ROOT/target/device-tool/amos-device"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "device.sh: swiftc not found — this tool drives the UI on macOS and needs the Swift toolchain" >&2
  echo "device.sh: (install Xcode command line tools: xcode-select --install)" >&2
  exit 3
fi

if [ ! -x "$BIN" ] || [ "$SRC" -nt "$BIN" ]; then
  mkdir -p "$(dirname "$BIN")"
  # `-parse-as-library` is required, not optional: the source declares `@main`, and `swiftc` treats
  # the *first* file as the main file (where top-level code is the entry point) unless told otherwise.
  # Without the flag the compile fails with "'main' attribute cannot be used in a module that contains
  # top-level code"; with top-level statements instead of `@main` it compiles and links an empty main,
  # i.e. a binary that exits 0 and does nothing (measured 2026-09-19 — see the guard below).
  # Warnings are not errors here: the tool links a whole AppKit surface it barely uses.
  swiftc -O -parse-as-library "$SRC" -o "$BIN" >/dev/null
fi

# A tool that exits 0 without answering is worse than one that fails: `--selftest` is wired into
# `make lint`, so a silently-empty binary would keep the gate green while checking nothing. The
# marker is what "the tool answered" looks like (the same shape as the gates that refuse to pass on
# an empty finding set).
if [ "${1:-}" = "--selftest" ]; then
  # `set -e` + `OUT="$(…)"` would exit here the moment the selftest failed — **printing nothing**,
  # which is the "silent instrument" family this repository keeps registering (F-DEV-074): a failing
  # check must show the tool's own FAIL lines, not just a status code. Hence the `if ! …` form.
  if OUT="$("$BIN" --selftest)"; then
    printf '%s\n' "$OUT"
    exit 0
  else
    STATUS=$?   # inside the else branch this is the tool's status, not the `if`'s
    printf '%s\n' "$OUT"
    echo "device.sh: the selftest failed (exit $STATUS)" >&2
    if ! printf '%s' "$OUT" | grep -q "FAIL:"; then
      echo "device.sh: and it reported no FAIL line — the tool did not run" >&2
    fi
    exit 1
  fi
fi

exec "$BIN" "$@"
