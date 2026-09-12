#!/usr/bin/env bash
# android-rag-bringup.sh — one-shot **device** driver for the offline RAG chain
# (amos-ai daemon `Rag` service + rag_once client + bench_arm). Turns the manual
# steps in docs/vector-db-rag.md §"On-device daemon bring-up" into a repeatable,
# honest script.
#
# Modes:
#   $0 [--device <serial>] [--daemon <path>] [--client <path>] [--bench <path>] \
#        [--tcp 127.0.0.1:<port>] [--count <n>] [--dim <d>] \
#        [--check-prereqs | --dry-run | --apply]
#   * --check-prereqs : verify the host tooling only (adb present + the 3 binaries built).
#   * --dry-run        : print the exact plan it WOULD run (default). Safe, no device.
#   * --apply          : actually touch the attached device. Use only with consent.
#
# Honesty: --apply pushes the binaries, runs the bench_arm ARM index benchmark,
# starts the daemon in TCP-loopback mode (adb `shell` has no root; on this
# FreemeOS/MTK ROM SELinux blocks a shell UDS bind in /data/local/tmp — see
# docs/vector-db-rag.md), and drives a real index/query/remove round-trip via
# rag_once. The separate embedding-latency figure (Ollama /api/embeddings) needs
# an Ollama + model on-device and is NOT claimed here — it prints as a manual
# checklist item.
#
# Exit codes: 0 ok, 1 hard error, 2 preflight/usage failure.

set -euo pipefail
cd "$(dirname "$0")/.."

ADB="${ADB:-adb}"
SERIAL=""
DAEMON="target/aarch64-linux-android/release/amos-ai"
CLIENT="target/aarch64-linux-android/release/examples/rag_once"
BENCH="target/aarch64-linux-android/release/examples/bench_arm"
DEV_DIR="/data/local/tmp"
DEV_BIN="amos-ai-rag"
TCP="127.0.0.1:19090"
# Shared secret for the TCP transport (REQ-A142). Sent by the daemon *and* rag_once, so
# the on-device smoke exercises the authenticated path; override with AMOS_TCP_TOKEN.
TOKEN="${AMOS_TCP_TOKEN:-dev-only-secret}"
COUNT="20000"
DIM="384"
MODE="dry-run"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) SERIAL="${2:-}"; shift 2 ;;
    --daemon) DAEMON="${2:-}"; shift 2 ;;
    --client) CLIENT="${2:-}"; shift 2 ;;
    --bench) BENCH="${2:-}"; shift 2 ;;
    --tcp) TCP="${2:-}"; shift 2 ;;
    --count) COUNT="${2:-}"; shift 2 ;;
    --dim) DIM="${2:-}"; shift 2 ;;
    --check-prereqs) MODE="check-prereqs"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    -h|--help) sed -n '1,24p' "$0"; exit 0 ;;
    *) echo "error: unknown arg: $1" >&2; exit 2 ;;
  esac
done

info() { printf '%s\n' "  $*"; }
warn() { printf '%s\n' "warning: $*" >&2; }
plan() { printf '%s\n' "[plan] $*"; }

# ---- prereq / device resolution -------------------------------------------------
resolve_device() {
  if [[ "$MODE" == "check-prereqs" ]]; then
    if ! command -v "$ADB" >/dev/null 2>&1; then
      echo "error: '$ADB' not found on PATH" >&2; exit 2
    fi
    info "adb present: $ADB"
    local missing=0
    for f in "$DAEMON" "$CLIENT" "$BENCH"; do
      if [[ ! -f "$f" ]]; then
        warn "binary not built: $f"
        missing=1
      fi
    done
    [[ "$missing" == 0 ]] && info "all three android binaries present"
    return 0
  fi

  local serial="$SERIAL"
  if [[ -z "$serial" ]]; then
    serial="$("$ADB" devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1; exit}')"
    if [[ -z "$serial" ]]; then
      if [[ "$MODE" == "apply" ]]; then
        echo "error: no device attached (adb devices)" >&2
        exit 2
      fi
      info "no device attached — dry-run uses the <serial> placeholder"
      serial="<serial>"
    else
      info "using first attached device: $serial"
    fi
  fi
  ADB_DEV=("$ADB" -s "$serial")
}

# Only act on the device when --apply; otherwise print the plan.
device() {
  if [[ "$MODE" == "apply" ]]; then
    "${ADB_DEV[@]}" "$@"
  else
    plan "${ADB_DEV[@]:-adb}" "$@" || true
  fi
}

# ---- steps ----------------------------------------------------------------------
echo "=== AmOS offline RAG (mock embedder) — device bring-up ($MODE) ==="

if [[ "$MODE" == "check-prereqs" ]]; then
  resolve_device
  echo "prereqs ok. Use --dry-run for the plan, --apply to run against a device."
  exit 0
fi

resolve_device

echo
echo "1) Stage the android binaries into $DEV_DIR"
if [[ -f "$DAEMON" && -f "$CLIENT" ]]; then
  device push "$DAEMON" "$DEV_DIR/$DEV_BIN"
  device shell "chmod 755 $DEV_DIR/$DEV_BIN"
  device push "$CLIENT" "$DEV_DIR/rag_once"
  device shell "chmod 755 $DEV_DIR/rag_once"
else
  warn "daemon/client missing — run first: cargo build -p amos-ai --target aarch64-linux-android --release --bins --examples (needs NDK CC/AR on PATH, see docs/vector-db-rag.md)"
fi

echo
echo "2) ARM index benchmark (bench_arm ${COUNT}x${DIM}) — real on-device retrieval latency"
if [[ -f "$BENCH" ]]; then
  device push "$BENCH" "$DEV_DIR/bench_arm"
  device shell "chmod 755 $DEV_DIR/bench_arm"
  device shell "$DEV_DIR/bench_arm $COUNT $DIM"
else
  warn "bench not built: $BENCH — run: cargo build -p amos-vector-db --example bench_arm --target aarch64-linux-android --release"
fi


echo
echo "3) Start the daemon (TCP-loopback, mock embedder), run the round-trip, then stop it"
echo "   NOTE: AMOS_RAG_STATE unset => in-memory. For persistence add: AMOS_RAG_STATE=<base>"
# One blocking adb shell does all three so it always returns cleanly — a bare
# backgrounded daemon would otherwise keep the adb shell session open until killed.
device shell "cd $DEV_DIR && { env AMOS_TCP_ADDR=$TCP AMOS_TCP_TOKEN=$TOKEN AMOS_RAG_EMBEDDER=mock AMOS_BACKEND=mock ./$DEV_BIN >rag_daemon.log 2>&1 & } && sleep 3 && echo '--- rag_once round-trip ---' && AMOS_TCP_TOKEN=$TOKEN ./rag_once http://$TCP; pkill -f $DEV_BIN 2>/dev/null; true"

echo
echo "=== Verdict (only what --apply can honestly claim) ==="
echo "  binaries staged ............ staged + chmod 755 (above)"
echo "  ARM index bench ............ bench_arm output above (ingest us/insert + top-k ms/query)"
echo "  daemon + Rag service up .... rag_once status/index/query/remove round-trip above"
echo "  offline, no Ollama ......... embedder=mock; vector index dim=384 on-device"
echo
echo "The following need a real model + human/system UI (manual checklist):"
echo "  - embedding latency (Ollama /api/embeddings dims/ms) — needs Ollama + model on-device"
echo "  - real (semantic) retrieval quality over actual notes — mock is plumbing only"
echo "  - a root/system Unix-socket deployment (init.rc) instead of TCP-loopback"
echo
if [[ "$MODE" != "apply" ]]; then
  echo "Dry run (nothing executed). Re-run with --apply to run against the device."
fi
exit 0
