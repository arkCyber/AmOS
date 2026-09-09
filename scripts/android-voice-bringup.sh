#!/usr/bin/env bash
# android-voice-bringup.sh — one-shot **device** driver for the always-on native
# voice chain (AAudio mic → local sherpa → assistant). Turns the manual steps in
# docs/aaudio-sherpa-bringup.md §3/C1–C7 into a repeatable, honest script.
#
# Modes:
#   $0 [--device <serial>] [--pkg com.amos.ai] [--probe <path>] \
#        [--model <dir>] [--check-prereqs | --dry-run | --apply]
#   * --check-prereqs : verify the host tooling only (adb present). Safe, no device.
#   * --dry-run        : print the exact plan it WOULD run (default). Safe, no device.
#   * --apply          : actually touch the attached device. Use only with consent.
#
# Honesty: only the automatable, non-UI hops (C2/C3 probe evidence, RECORD_AUDIO
# grant, model staging) are executed/claimed by --apply. C1/C4–C7 need the running
# System UI + a human speaking, so this driver prints them as a manual checklist
# rather than pretending an automated verdict.
#
# Exit codes: 0 ok, 1 hard error, 2 preflight/usage failure.

set -euo pipefail
cd "$(dirname "$0")/.."

ADB="${ADB:-adb}"
SERIAL=""
PKG="com.amos.ai"
PROBE="target/aarch64-linux-android/release/examples/aaudio_callback_probe"
MODEL="models/sherpa-en-20m"
MODE="dry-run"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) SERIAL="${2:-}"; shift 2 ;;
    --pkg) PKG="${2:-}"; shift 2 ;;
    --probe) PROBE="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
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
echo "=== AmOS always-on native voice — device bring-up ($MODE) ==="

if [[ "$MODE" == "check-prereqs" ]]; then
  resolve_device
  echo "prereqs ok. Use --dry-run for the plan, --apply to run against a device."
  exit 0
fi

resolve_device

# API level preflight (AAudio needs >= 26).
if [[ "$MODE" == "apply" ]]; then
  sdk="$("${ADB_DEV[@]}" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')"
  info "device API level: ${sdk:-unknown}"
  if [[ -n "$sdk" && "$sdk" -lt 26 ]]; then
    echo "error: AAudio requires API >= 26 (device is $sdk)" >&2; exit 2
  fi
else
  sdk=""
  plan "read ro.build.version.sdk (expect >= 26 for AAudio)"
fi

echo
echo "1) Stage the sherpa model dir for the daemon (AMOS_SHERPA_MODEL_DIR=/data/amos/sherpa)"
if [[ -d "$MODEL" ]]; then
  device push "$MODEL" /data/amos/sherpa
  device shell "chmod -R a+rX /data/amos/sherpa"
else
  warn "model dir '$MODEL' missing — pass --model <dir> (tokens.txt + encoder/decoder/joiner .onnx)"
fi

echo
echo "2) Grant RECORD_AUDIO to the System UI ($PKG) so the native AAudio mic can open"
device shell "pm grant $PKG android.permission.RECORD_AUDIO"

echo
echo "3) Runtime AAudio probe — C2 (open real mic) + C3 (data callback streams samples)"
if [[ -f "$PROBE" ]]; then
  device push "$PROBE" /data/local/tmp/aaudio_callback_probe
  device shell "chmod 755 /data/local/tmp/aaudio_callback_probe"
  device shell /data/local/tmp/aaudio_callback_probe
else
  warn "probe not built: $PROBE — run first: make android-audio-check (or cargo ndk -t arm64-v8a -P 26 build -p amos-audio --features aaudio --example aaudio_callback_probe)"
fi

echo
echo "=== Verdict (only what --apply can honestly claim) ==="
echo "  C2 open native mic ......... probe above (or: no 'no native backend' in logs)"
echo "  C3 capture streams audio ... probe 'samples read > 0'"
echo "  C1 device reports aaudio ... check the System UI / get_status mic field (manual)"
echo
echo "The remaining acceptance needs the running System UI + a human speaking:"
echo "  C4 sherpa real recognition (interim before the final bubble)"
echo "  C5 trailing-silence AudioEnd segmentation"
echo "  C6 end-to-end voice → text → answer in the AI app composer"
echo "  C7 RECORD_AUDIO denied path stays an honest error (no crash, no fake mic)"
echo
if [[ "$MODE" != "apply" ]]; then
  echo "Dry run (nothing executed). Re-run with --apply to run against the device."
fi
exit 0
