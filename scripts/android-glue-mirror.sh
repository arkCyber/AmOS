#!/usr/bin/env bash
# Mirror the tracked Android glue into the generated Tauri-Android project, then
# verify the generated manifest carries every permission the tracked fragment
# declares.
#
# WHY this is a script and not a documented `cp -r`: the Android build compiles
# `crates/amos-tauri/gen/` (git-ignored), while `crates/amos-tauri/android-glue/`
# is the tracked source of truth — and nothing kept the two in sync. So a NEWLY
# ADDED glue file was simply absent from the APK, and an edited one could be built
# from a stale copy on disk. Both defects of that class were found by audit:
#   * REQ-A174 — the personal-hotspot glue was never compiled anywhere;
#   * REQ-A175 — the alarm glue was absent from every mirror.
# This file is the single implementation of "put the tracked glue where every
# Android build reads it", used by the host compile gate
# (`scripts/android-glue-nv21-check.sh`), the canonical APK wrapper
# (`scripts/build-apk.sh`) and `make android-app`.
#
# Replace, never merge: a stale copy of a renamed/removed glue file must not keep
# being compiled into the APK (that would ship a file the repository no longer has).
#
# The manifest half closes the same hole one layer up: merging
# `AndroidManifest.permissions.xml` into the GENERATED manifest is a documented
# manual step, and it had already drifted (the hotspot's TETHER_PRIVILEGED was
# declared and never merged) with nothing to say so. We do not rewrite Tauri's
# generated file; we refuse to hand back a build whose manifest is missing a
# declared permission.
set -euo pipefail
cd "$(dirname "$0")/.."

GLUE=crates/amos-tauri/android-glue/com/amos/ai/glue
TESTS=crates/amos-tauri/android-glue/tests/com/amos/ai/glue
GEN=crates/amos-tauri/gen/android
GEN_MAIN="$GEN/app/src/main/java/com/amos/ai/glue"
GEN_TEST="$GEN/app/src/test/java/com/amos/ai/glue"

# A missing generated project is a hard error: silently compiling nothing (or an
# APK without the glue) is exactly the failure this script exists to prevent.
if [[ ! -d "$GEN" ]]; then
  echo "error: $GEN not found — run 'cargo tauri android init' first" >&2
  exit 1
fi
if ! compgen -G "$GLUE/*.kt" >/dev/null; then
  echo "error: no glue sources under $GLUE" >&2
  exit 1
fi

mkdir -p "$GEN_MAIN" "$GEN_TEST"
rm -f "$GEN_MAIN"/*.kt "$GEN_TEST"/*.kt
cp "$GLUE"/*.kt "$GEN_MAIN/"
cp "$TESTS"/*.kt "$GEN_TEST/"

main=$(ls "$GEN_MAIN"/*.kt 2>/dev/null | wc -l | tr -d ' ')
tests=$(ls "$GEN_TEST"/*.kt 2>/dev/null | wc -l | tr -d ' ')
echo "[glue] mirrored $main main + $tests test Kotlin file(s) into $GEN"

# --- verify the generated manifest carries what the tracked fragments declare ---
#
# The build reads the GENERATED manifest, while `android-glue/AndroidManifest.*.xml`
# are the tracked fragments; merging them in is a documented *manual* step — which
# is how it drifts. Observed live: the hotspot's TETHER_PRIVILEGED was declared and
# never merged, and the three glue components (AmosInCallService,
# AmosCallScreeningService, SmsReceiver) existed ONLY in the generated file, so a
# clean checkout built an APK in which nothing bound them (no in-call UI, no call
# screening, no live SMS receive). We deliberately do NOT rewrite Tauri's generated
# file (it is machine-owned), but we refuse to hand back a build whose manifest is
# missing something a fragment declares — that defect only shows up at runtime, as
# a confusing SecurityException or, worse, a feature that silently never runs.
#
# Comparing **every** `android:name` (not just `<uses-permission>`) is what makes
# the component registrations covered too; the fragment name is reported so the
# missing line can be found.
FRAG_DIR=crates/amos-tauri/android-glue
GEN_MANIFEST="$GEN/app/src/main/AndroidManifest.xml"

if [[ ! -f "$GEN_MANIFEST" ]]; then
  echo "error: $GEN_MANIFEST not found — run 'cargo tauri android init' first" >&2
  exit 1
fi
if ! compgen -G "$FRAG_DIR/AndroidManifest.*.xml" >/dev/null; then
  echo "error: no AndroidManifest.*.xml fragments under $FRAG_DIR" >&2
  exit 1
fi

missing=""
for frag in "$FRAG_DIR"/AndroidManifest.*.xml; do
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    if ! grep -qF "$name" "$GEN_MANIFEST"; then
      missing="$missing
  $name  <- $(basename "$frag")"
    fi
  done < <(grep -oE 'android:name="[^"]+"' "$frag" | sort -u)
done

if [[ -n "$missing" ]]; then
  echo "error: $GEN_MANIFEST is missing entries declared by the tracked fragments:" >&2
  printf '%s\n' "$missing" >&2
  echo "  Merge the matching line(s) from crates/amos-tauri/android-glue/AndroidManifest.*.xml" >&2
  echo "  into the generated manifest (docs/REAL_DEVICE_SYSTEM_UI_AUDIT.md §5.1), then re-run." >&2
  exit 1
fi
echo "[glue] generated manifest declares every android:name in the tracked fragments"

# --- verify the package identity the JNI calls assume -------------------------
#
# Rust reaches the glue through hard-coded JNI class names
# (`find_class("com/amos/ai/glue/TetheringGlue")`). Those resolve only while the
# app identifier (`tauri.conf.json`, tracked), the Kotlin `package` declarations
# (tracked) and the generated project's package all agree — and nothing else ties
# those three facts together. A drift would surface on device as a
# ClassNotFoundException inside an otherwise-fine call, i.e. exactly the class of
# silent failure this script exists to catch.
IDENT=$(sed -n 's/.*"identifier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  crates/amos-tauri/tauri.conf.json | head -1)
if [[ -z "$IDENT" ]]; then
  echo "error: could not read \"identifier\" from crates/amos-tauri/tauri.conf.json" >&2
  exit 1
fi

glue_pkg=$(grep -h '^package ' "$GLUE"/*.kt | sed 's/^package //' | sort -u)
if [[ "$glue_pkg" != "$IDENT.glue" ]]; then
  echo "error: glue Kotlin declares package '$glue_pkg' but tauri.conf.json's identifier is '$IDENT'" >&2
  echo "  (expected package '$IDENT.glue' — Rust's JNI class strings assume it)" >&2
  exit 1
fi

jni_prefix="$(printf '%s' "$IDENT" | tr '.' '/')/glue/"
if ! grep -rqF --include='*.rs' --exclude-dir=target "\"$jni_prefix" crates; then
  echo "error: no Rust source references JNI classes under \"$jni_prefix\" (identifier '$IDENT')" >&2
  exit 1
fi
echo "[glue] package identity agrees: identifier=$IDENT, glue package=$glue_pkg, JNI prefix=\"$jni_prefix\""

# --- verify the Activity is never recreated under the glue ----------------------
#
# Nine files in `crates/amos-tauri/src` install a process-global handle **exactly once** —
# `APP` / `VM` / `GLUE` / `SINK` / `DEVICE` / `PUSHER` — and the comment at each says "a
# redundant attach simply keeps the first". That is only true while the first handle is
# still the *live* one: an Activity that is **recreated** (rotation, resize, locale or
# UI-mode change) hands the JNI attach a NEW Kotlin object, which `OnceLock::set` then
# drops — leaving the mic / clipboard / media bridges driving a dead instance.
#
# What makes "keep the first" true is not in this repository's Kotlin: it is the generated
# Activity's `android:configChanges` list, which comes from Tauri's template. Measured
# 2026-09-19: orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|
# screenLayout|uiMode. Nothing checked it, so a template change would silently turn those
# deliberate discards into a scheduled failure on device.
#
# Honest boundary: `density` and `fontScale` are NOT in that list, so changing display size
# or font scale DOES recreate the Activity — on that path the first-handle-wins rule is a
# registered gap, not something this script can assert away.
CONFIG_CHANGES_REQUIRED=(orientation keyboardHidden keyboard screenSize locale smallestScreenSize screenLayout uiMode)
if ! grep -q 'android:configChanges' "$GEN_MANIFEST"; then
  echo "error: $GEN_MANIFEST declares no android:configChanges on the Activity." >&2
  echo "  The exactly-once glue handles (APP/VM/GLUE/SINK/DEVICE/PUSHER) keep the FIRST" >&2
  echo "  handle on purpose; without configChanges the Activity is recreated and those" >&2
  echo "  handles go stale. Re-generate with 'cargo tauri android init' (or restore the" >&2
  echo "  attribute) before building." >&2
  exit 1
fi
cc_value=$(sed -n 's/.*android:configChanges="\([^"]*\)".*/\1/p' "$GEN_MANIFEST" | head -1)
IFS='|' read -r -a cc_tokens <<<"$cc_value"
missing_cc=""
for want in "${CONFIG_CHANGES_REQUIRED[@]}"; do
  found=0
  for tok in "${cc_tokens[@]}"; do
    [[ "$tok" == "$want" ]] && found=1
  done
  [[ "$found" == "1" ]] || missing_cc="$missing_cc $want"
done
if [[ -n "$missing_cc" ]]; then
  echo "error: the generated Activity's configChanges is missing:$missing_cc" >&2
  echo "  Found: android:configChanges=\"$cc_value\"" >&2
  echo "  Those values are what stop the Activity being recreated; the exactly-once glue" >&2
  echo "  handles rely on it (see the comment in this script)." >&2
  exit 1
fi
echo "[glue] Activity not recreated for orientation/size/locale/uiMode — the exactly-once handles rely on it (configChanges=\"$cc_value\")"

# The generated Activity is the only place the glue is actually *invoked*, and that
# wiring is hand-copied from `MainActivity.Wiring.kt`. Verify it too, for the same
# reason: a fresh `tauri android init` Activity binds nothing (the APK would ship a
# compiled-in glue that never runs).
bash scripts/android-activity-wiring-check.sh
