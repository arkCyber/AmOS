#!/usr/bin/env bash
# Strip DWARF debug info from the universal APK's libamos_tauri_lib.so, re-pack,
# zipalign and debug-sign. The debug build keeps its symbols on purpose
# (app/build.gradle.kts sets `jniLibs.keepDebugSymbols` for every ABI), so the
# unstripped APK is dominated by the native library; `--strip-debug` only removes
# `.debug_*`, `.symtab`, `.strtab` — the dynamic symbol table that the runtime
# loader consults is untouched, so every JNI export survives.
#
# The re-pack applies a fixed compression policy (see `repack` below): the two
# entries the platform requires uncompressed are STORED, everything else is
# DEFLATE'd. The script prints the measured before/after sizes rather than
# repeating a byte count that goes stale as the library grows.
#
# Requires NDK 23.x (`llvm-strip`), build-tools (`zipalign`, `apksigner`) and a
# debug keystore at ~/.android/debug.keystore.
#
# Usage: scripts/android-app-strip.sh             # strip + sign
#        scripts/android-app-strip.sh --selftest  # device-free check of the packer
#
# Idempotent: re-running overwrites the output. Safe to invoke from `make`.
set -euo pipefail

cd "$(dirname "$0")/.."  # repo root

# --- The packer --------------------------------------------------------
# Re-pack an extracted APK tree into an unsigned APK, applying the compression
# policy. Factored out of the main flow so `--selftest` exercises *this* code
# on a synthetic tree instead of a hand-copied idea of it.
repack() { # $1 = extracted dir, $2 = output apk (unsigned)
python3 - "$1" "$2" <<'PY'
import sys, os, zipfile
src_root, out = sys.argv[1], sys.argv[2]

# Which entries must be uncompressed? Two, for two different reasons:
#   * `**/*.so` — the manifest pins `android:extractNativeLibs="false"`, so the
#     loader mmaps the page-aligned bytes straight out of the APK; a deflated
#     entry cannot be mmapped and the install fails with
#     `INSTALL_FAILED_INVALID_APK: Failed to extract native libraries, res=-2`.
#   * `resources.arsc` — required uncompressed (and 4-byte aligned) on API 30+.
# Everything else (dex, manifest, resources, assets) is DEFLATE'd; storing them
# only bloats the APK.
def must_be_stored(rel):
    return rel.endswith('.so') or rel == 'resources.arsc'

def write_entry(z, full, rel):
    # A fixed date_time keeps two runs over the same tree byte-identical.
    zi = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
    zi.compress_type = zipfile.ZIP_STORED if must_be_stored(rel) else zipfile.ZIP_DEFLATED
    zi.external_attr = 0o644 << 16
    with open(full, 'rb') as fh:
        z.writestr(zi, fh.read())

with zipfile.ZipFile(out, 'w') as z:
    # classes.dex / AndroidManifest.xml first: the install-time readers touch
    # them before anything else and a local header at the front is cheaper.
    for first in ('classes.dex', 'AndroidManifest.xml'):
        p = os.path.join(src_root, first)
        if os.path.exists(p):
            write_entry(z, p, first)
    for root, _dirs, files in os.walk(src_root):
        for f in sorted(files):
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src_root).replace(os.sep, '/')
            if rel in ('classes.dex', 'AndroidManifest.xml'):
                continue
            write_entry(z, full, rel)
print('pack:', out)
PY
}

# --- Device-free self-test ---------------------------------------------
# The APK is only installable if this policy holds, and the failure mode
# (`res=-2` at install time) is invisible on the build host — so the packer is
# checked here, on a synthetic tree, rather than discovered on a phone.
if [ "${1:-}" = "--selftest" ]; then
    WORK=$(mktemp -d -t amos-apk-strip-selftest.XXXXXX)
    trap 'rm -rf "$WORK"' EXIT
    python3 - "$WORK/src" <<'PY'
import os, sys
root = sys.argv[1]
cases = [
    # a .so is incompressible in practice, and must stay STORED regardless
    ('lib/arm64-v8a/libamos_tauri_lib.so', os.urandom(300000)),
    # highly compressible payloads: a DEFLATE'd entry must come out smaller
    ('classes.dex', b'\x00' * 250000),
    ('resources.arsc', b'\x00' * 120000),
    ('AndroidManifest.xml', b'<manifest/>' * 4000),
    ('assets/big.txt', b'A' * 200000),
]
for rel, data in cases:
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as f:
        f.write(data)
PY
    repack "$WORK/src" "$WORK/selftest.apk" >/dev/null
    python3 - "$WORK/selftest.apk" <<'PY'
import sys, zipfile
STORE, DEFLATE = zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED
z = zipfile.ZipFile(sys.argv[1])
failures = []
for info in z.infolist():
    name = info.filename
    if name.endswith('.so'):
        why = 'a lib/**/*.so entry must be STORED (extractNativeLibs="false")'
        if info.compress_type != STORE:
            failures.append(f'{name}: {why}; got compress_type={info.compress_type}')
    elif name == 'resources.arsc':
        why = 'resources.arsc must be STORED (API 30+)'
        if info.compress_type != STORE:
            failures.append(f'{name}: {why}; got compress_type={info.compress_type}')
    else:
        why = 'only .so + resources.arsc are stored; every other entry must be DEFLATE'
        if info.compress_type != DEFLATE:
            failures.append(f'{name}: {why}; got compress_type={info.compress_type}')
    if info.compress_type == DEFLATE and info.compress_size >= info.file_size:
        failures.append(f'{name}: DEFLATE did not shrink the entry '
                        f'({info.compress_size} >= {info.file_size})')
print(f'selftest: {len(z.infolist())} entries checked')
for f in failures:
    print('FAIL:', f)
sys.exit(1 if failures else 0)
PY
    rc=$?
    [ "$rc" -eq 0 ] && echo "selftest: OK" || echo "selftest: FAILED"
    exit "$rc"
fi

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

SO_IN=$(find "$WORK/extract/lib" -name "libamos_tauri_lib.so" -type f 2>/dev/null | head -1)
[ -n "$SO_IN" ] || { echo "[strip] no lib/**/libamos_tauri_lib.so inside $SRC"; exit 1; }
SO_BUILD=$(find target/aarch64-linux-android/debug -name "libamos_tauri_lib.so" -type f 2>/dev/null | head -1)
[ -n "$SO_BUILD" ] || { echo "[strip] build cache empty — rebuild with 'make android-app'"; exit 1; }
cp "$SO_BUILD" "$SO_IN"
"$NDK_STRIP" --strip-debug "$SO_IN"

# --- 3. Re-pack ---------------------------------------------------------
repack "$WORK/extract" "$WORK/stripped-unsigned.apk"

# --- 4. Zipalign + sign -------------------------------------------------
"$ZIPALIGN" -f -p 4 "$WORK/stripped-unsigned.apk" "$WORK/stripped-aligned.apk"
# `-p 4` page-aligns the STORED .so entries; verify rather than assume, since a
# misaligned .so is the same install-time res=-2 as a deflated one.
"$ZIPALIGN" -c -p 4 "$WORK/stripped-aligned.apk"
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
