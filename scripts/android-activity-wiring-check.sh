#!/usr/bin/env bash
# Verify the generated Tauri-Android Activity actually invokes the AmOS glue.
#
# WHY: `MainActivity.Wiring.kt` documents the wiring as a *hand-copied* template
# ("Copy the two calls below into the generated Activity's `onStart` /
# `onRequestPermissionsResult`"), and the generated Activity lives in the
# git-ignored `gen/`. So on a clean checkout (`cargo tauri android init`) the APK
# ships the whole compiled glue and **binds none of it**: no torch/sensor/camera
# producers, no telephony host, no shared blocklist store, no device-care backend,
# no always-on display, no runtime permission requests — with nothing to say so
# (found by audit, 2026-09-13).
#
# We deliberately do not rewrite Tauri's generated Activity (it is machine-owned).
# We do refuse to hand back a build whose Activity never calls the glue: that
# defect only shows up on device as "the feature silently does nothing".
#
# Honest scope: this checks the *presence* of each call, not its lifecycle
# placement — that contract is in `MainActivity.Wiring.kt` and the bring-up docs.
set -euo pipefail
cd "$(dirname "$0")/.."

GEN_ACTIVITY=crates/amos-tauri/gen/android/app/src/main/java/com/amos/ai/MainActivity.kt

if [[ ! -f "$GEN_ACTIVITY" ]]; then
  echo "error: $GEN_ACTIVITY not found — run 'cargo tauri android init' first" >&2
  exit 1
fi

# The generated project must have been generated for THIS app identifier: the
# manifest fragments use relative names (`.glue.AmosInCallService`) that resolve
# against the generated namespace, and the Activity's package must be the one the
# glue imports live in. A mismatch means gen/ is stale/inconsistent with
# tauri.conf.json — e.g. the identifier was changed without re-running
# `tauri android init`.
pkg=$(sed -n 's/^package //p' "$GEN_ACTIVITY" | head -1)
ident=$(sed -n 's/.*"identifier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  crates/amos-tauri/tauri.conf.json | head -1)
if [[ -n "$ident" && "$pkg" != "$ident" ]]; then
  echo "error: $GEN_ACTIVITY declares package '$pkg' but tauri.conf.json's identifier is '$ident'" >&2
  echo "  (gen/ was generated for a different applicationId — re-run 'cargo tauri android init')" >&2
  exit 1
fi

# One entry per glue entry point the Activity must reach, with the reason.
# The match is the call prefix (`Object.method(`) so it survives reformatting;
# `-F` keeps the parentheses literal.
REQUIRED=(
  "AlwaysOn.apply(|hold the physical display while AmOS is foreground"
  "PermissionWire.requestNeeded(|ask for CAMERA/RECORD_AUDIO (idempotent)"
  "PermissionWire.requestMedia(|ask for READ_MEDIA_* / READ_EXTERNAL_STORAGE"
  "PermissionWire.ensureAttached(|attach MediaStore when the grant already exists"
  "PermissionWire.onResult(|route the grant result back into the glue"
  "TelephonyGlue.bind(|hand the app context to the telephony host"
  "TelephonyGlue.ensureCallPermission(|ask for CALL_PHONE once"
  "TelephonyGlue.onResult(|route the CALL_PHONE result back"
  "BlocklistGlue.bind(|one rule store shared by the UI, SMS filter, screening service"
  "BlocklistGlue.attachActivity(|post the Call Screening role dialog from the Activity"
  "DevCareGlue.bind(|install the PackageManager/StatFs device-care backend"
  "DevCareGlue.attachActivity(|post the uninstall dialog from the Activity"
  "AmosGlue.onStart(|start the sensor/camera/clipboard/torch producers"
  "AmosGlue.onCameraPermissionGranted(|rebind the torch once CAMERA is held"
  "AmosGlue.onStop(|release the producers so the camera/torch is freed"
  "AlarmGlue.bind(|hand the app context to the host's AlarmManager binding (F-TAU-007)"
  "AlarmGlue.attachActivity(|post the exact-alarm settings screen from the foreground Activity"
)

missing=""
for entry in "${REQUIRED[@]}"; do
  call="${entry%%|*}"
  why="${entry#*|}"
  if ! grep -qF "$call" "$GEN_ACTIVITY"; then
    missing="$missing
  $call  ($why)"
  fi
done

if [[ -n "$missing" ]]; then
  echo "error: $GEN_ACTIVITY never calls:" >&2
  printf '%s\n' "$missing" >&2
  echo "  The glue is compiled into the APK but nothing binds it. Copy the wiring from" >&2
  echo "  crates/amos-tauri/android-glue/com/amos/ai/glue/MainActivity.Wiring.kt into" >&2
  echo "  the generated Activity (docs/REAL_DEVICE_SYSTEM_UI_AUDIT.md §5.2), then re-run." >&2
  exit 1
fi
echo "[glue] generated Activity invokes all ${#REQUIRED[@]} glue entry point(s)"
