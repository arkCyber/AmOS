#!/usr/bin/env bash
# Strip DWARF debug info from the universal APK's libamos_tauri_lib.so, re-pack,
# zipalign and debug-sign. Drops ~660 MB → ~26 MB while preserving every JNI export
# (`--strip-debug` only removes `.debug_*`, `.symtab`, `.strtab` — the dynamic
# symbol table that the runtime loader consults is untouched). Requires NDK 23.x
# and a debug keystore at ~/.android/debug.keystore.
#
# Idempotent: re-running overwrites the output. Safe to invoke from `make`.
set -euo pipefail

cd "$(dirname "$0")/.."  # repo root

# --- 1. Locate tools ---------------------------------------------------
NDK_STRIP=$(find /opt/homebrew/share/android-commandlinetools/ndk/23.1.7779620/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-strip 2>/dev/null \
            || find /Users/arksong/Library/Android/sdk/ndk/23.1.7779620/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-strip 2>/dev/null \
            || echo "")
ZIPALIGN=$(find /Users/arksong/Library/Android/sdk/build-tools/35.0.0/zipalign 2>/dev/null || echo "")
APKSIGNER=$(find /Users/arksong/Library/Android/sdk/build-tools/35.0.0/apksigner 2>/dev/null || echo "")
DEBUG_KEY="${ANDROID_DEBUG_KEY:-$HOME/.android/debug.keystore}"
SRC=crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
OUT=crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug-stripped.apk

[ -x "$NDK_STRIP"  ] || { echo "[strip] missing llvm-strip in NDK"; exit 1; }
[ -x "$ZIPALIGN"   ] || { echo "[strip] missing zipalign in build-tools"; exit 1; }
[ -x "$APKSIGNER"  ] || { echo "[strip] missing apksigner in build-tools"; exit 1; }
[ -f "$DEBUG_KEY"  ] || { echo "[strip] missing debug keystore at $DEBUG_KEY"; exit 1; }
[ -f "$SRC"        ] || { echo "[strip] source APK missing — run 'make android-app' first"; exit 1; }

# --- 2. Stage extraction ----------------------------------------------
WORK=$(mktemp -d -t amos-apk-strip.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/extract"
unzip -q "$SRC" -d "$WORK/extract"

SO_IN="$WORK/extract/lib/arm64-v8a/libamos_tauri_lib.so"
SO_BUILD=$(find target/aarch64-linux-android/debug -name "libamos_tauri_lib.so" -type f 2>/dev/null | head -1)
[ -n "$SO_BUILD" ] || { echo "[strip] build cache empty — rebuild with 'make android-app'"; exit 1; }
cp "$SO_BUILD" "$SO_IN"
"$NDK_STRIP" --strip-debug "$SO_IN"

# --- 3. Re-pack ---------------------------------------------------------
# Android 11+ (API 30) manifest pins `android:extractNativeLibs="false"` ⇒ native
# .so entries MUST be `Stored` (not Deflated) inside the ZIP for `dlopen` to see
# the page-aligned bytes. Refusing to do this yields `INSTALL_FAILED_INVALID_APK:
# Failed to extract native libraries, res=-2` on device.
python3 - "$WORK/extract" "$WORK/stripped-unsigned.apk" <<'PY'
import sys, os, zipfile
src_root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w') as z:
    for first in ('classes.dex', 'AndroidManifest.xml'):
        if os.path.exists(os.path.join(src_root, first)):
            z.write(os.path.join(src_root, first), first)
    for root, _dirs, files in os.walk(src_root):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src_root).replace(os.sep, '/')
            if rel in ('classes.dex', 'AndroidManifest.xml'):
                continue
            # .so 必须不压缩；其余文件走 DEFLATE。
            if rel.endswith('.so'):
                zi = zipfile.ZipInfo(rel)
                zi.compress_type = zipfile.ZIP_STORED
                with open(full, 'rb') as fh:
                    z.writestr(zi, fh.read())
            else:
                z.write(full, rel)
print('pack:', out)
PY

# --- 4. Zipalign + sign -------------------------------------------------
"$ZIPALIGN" -f -p 4 "$WORK/stripped-unsigned.apk" "$WORK/stripped-aligned.apk"
"$APKSIGNER" sign \
    --ks "$DEBUG_KEY" --ks-pass pass:android \
    --ks-key-alias androiddebugkey --key-pass pass:android \
    --out "$OUT" "$WORK/stripped-aligned.apk"
"$APKSIGNER" verify "$OUT"

# --- 5. Report ----------------------------------------------------------
ORIG_BYTES=$(stat -f %z "$SRC" 2>/dev/null || stat -c %s "$SRC")
NEW_BYTES=$(stat -f %z "$OUT" 2>/dev/null || stat -c %s "$OUT")
printf '[strip] %s → %s  (%.1f MB → %.1f MB)\n' \
    "$(basename "$SRC")" "$(basename "$OUT")" \
    "$(echo "$ORIG_BYTES/1048576" | bc -l)" \
    "$(echo "$NEW_BYTES/1048576" | bc -l)"
echo "[strip] APK: $OUT"
