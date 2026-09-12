#!/usr/bin/env bash
# scripts/release-artifacts.sh — build the headless release bundle.
#
# Single source of truth for BOTH `make release-artifacts` (local) and
# .github/workflows/release.yml (tagged CI), so what CI publishes is exactly what a
# maintainer can reproduce on their own machine.
#
# What it does:
#   1. builds the daemon + CLI binaries with `--locked` (reproducible: the committed
#      Cargo.lock is authoritative);
#   2. stages them as
#        dist/amos-<version>-<target>/bin/<binary…>
#      together with VERSION and README.txt (contents + honest scope);
#   3. tars the staging dir and writes dist/SHA256SUMS for every tarball.
#
# Honest scope (FUNCTIONAL_GAP_ANALYSIS #39): this is the **headless** bundle — the
# AI daemon, the supervisor, the translator and the CLIs. The Tauri desktop bundle
# and the Android APK are separate build paths (Tauri/NDK toolchains) and are *not*
# produced here; the README inside the tarball says so.
#
# Env overrides:
#   AMOS_RELEASE_BINS    space-separated binary list (default: the headless set)
#   AMOS_RELEASE_DIR     output directory (default: dist)
#   AMOS_RELEASE_TARGET  cargo --target triple (default: none = the host target)
#   AMOS_RELEASE_NO_BUILD=1  skip cargo and package already-built binaries
set -euo pipefail
cd "$(dirname "$0")/.."

DEFAULT_BINS=(
  amos-ai            # AI daemon (gRPC over UDS) — the core service
  amos-supervisor    # process supervisor for the daemons
  amos-translate     # translation daemon
  amos-int-cli       # intents CLI
  amos-mail-cli      # mail CLI
  amos-appstore-cli  # app-store CLI
  amos-timesync-cli  # time-sync CLI
  amos-pdf-parser    # PDF text extraction CLI
)
if [[ -n "${AMOS_RELEASE_BINS:-}" ]]; then
  # shellcheck disable=SC2206
  BINS=(${AMOS_RELEASE_BINS})
else
  BINS=("${DEFAULT_BINS[@]}")
fi

OUT_DIR="${AMOS_RELEASE_DIR:-dist}"
TARGET="${AMOS_RELEASE_TARGET:-}"
# The workspace version is parsed **section-aware**: a dependency version written as
# its own `version = "…"` line must never be mistaken for ours, or the release would
# be silently renamed after a dependency (identity fraud by accident).
VERSION="$(awk '
  /^\[workspace\.package\]/ { ours = 1; next }
  /^\[/                     { ours = 0 }
  ours && /^version[[:space:]]*=/ {
    sub(/^[^"]*"/, ""); sub(/".*$/, ""); print; exit
  }
' Cargo.toml)"
if [[ ! "${VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "release-artifacts: cannot read a valid workspace version from Cargo.toml (got: '${VERSION:-<empty>}')" >&2
  exit 1
fi
# Tag/version consistency: a `vX.Y.Z` tag must match the version being packaged.
# Otherwise the published release would be *named* after one version while its
# VERSION file and every binary's `--version` report another.
EXPECT_TAG="${AMOS_RELEASE_TAG:-}"
if [[ -n "$EXPECT_TAG" ]]; then
  if [[ "$EXPECT_TAG" != "v$VERSION" ]]; then
    echo "release-artifacts: tag/version mismatch — tag '${EXPECT_TAG}' but Cargo.toml declares ${VERSION}" >&2
    exit 1
  fi
  echo "release-artifacts: tag ${EXPECT_TAG} matches the packaged version ${VERSION}"
fi
HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
TRIPLE="${TARGET:-$HOST_TRIPLE}"
NAME="amos-${VERSION}-${TRIPLE}"
RELEASE_DIR="target/release"
[[ -n "$TARGET" ]] && RELEASE_DIR="target/${TARGET}/release"

echo "release-artifacts: amos ${VERSION} for ${TRIPLE} -> ${OUT_DIR}/${NAME}"

if [[ "${AMOS_RELEASE_NO_BUILD:-0}" != "1" ]]; then
  args=(build --release --locked)
  [[ -n "$TARGET" ]] && args+=(--target "$TARGET")
  for b in "${BINS[@]}"; do args+=(--bin "$b"); done
  echo "release-artifacts: cargo ${args[*]}"
  cargo "${args[@]}"
fi

STAGE="${OUT_DIR}/${NAME}"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin"

copied=0
for b in "${BINS[@]}"; do
  src="${RELEASE_DIR}/${b}"
  if [[ ! -x "$src" ]]; then
    echo "release-artifacts: missing built binary ${src} (build it or fix AMOS_RELEASE_BINS)" >&2
    exit 1
  fi
  cp "$src" "$STAGE/bin/${b}"
  copied=$((copied + 1))
done

# Every staged binary must self-report the version we are packaging: an artifact you
# cannot identify after deployment is not a release artifact (FUNCTIONAL_GAP_ANALYSIS
# #39). This is also what keeps the CLIs' `--version` honest going forward.
for b in "${BINS[@]}"; do
  out="$("$STAGE/bin/${b}" --version 2>&1 | head -n1)"
  if [[ "$out" != *"$VERSION"* ]]; then
    echo "release-artifacts: ${b} --version did not report ${VERSION} (got: '${out}')" >&2
    exit 1
  fi
  echo "release-artifacts: ${b} --version -> ${out}"
done

printf '%s\n' "$VERSION" > "$STAGE/VERSION"
cat > "$STAGE/README.txt" <<EOF
AmOS ${VERSION} — headless release bundle (${TRIPLE})
built by scripts/release-artifacts.sh

bin/            the daemon + CLI binaries (${copied}):
$(for b in "${BINS[@]}"; do printf '                  %s\n' "$b"; done)

Run \`bin/amos-ai --help\` for the daemon's flags; it serves the AI Agent gRPC
service over a Unix Domain Socket (default path from AMOS_SOCKET / the CLI flag).

Scope: this bundle is the HEADLESS part of the system. It does NOT contain the
Tauri desktop app or the Android APK — those are separate build paths
(\`make run-ui-release\` / \`make android-app\`). Verify integrity with:
    sha256sum -c SHA256SUMS      (Linux)
    shasum -a 256 -c SHA256SUMS  (macOS)
EOF

tar -czf "${OUT_DIR}/${NAME}.tar.gz" -C "$OUT_DIR" "$NAME"

# One checksum line per tarball, GNU-style ("<hash>  <file>"), portable across
# sha256sum (Linux) / shasum (macOS) / openssl (neither present).
sum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  else
    openssl dgst -sha256 -r "$1"   # "<hash> *<file>"
  fi
}

# Rebuild the manifest so a second target never drops the first one's line.
keep="$(mktemp)"
trap 'rm -f "$keep"' EXIT
if [[ -f "${OUT_DIR}/SHA256SUMS" ]]; then
  grep -vE "[[:space:]]+${NAME}\.tar\.gz$" "${OUT_DIR}/SHA256SUMS" > "$keep" || true
fi
{
  cat "$keep"
  (cd "$OUT_DIR" && sum "${NAME}.tar.gz")
} > "${OUT_DIR}/SHA256SUMS"

echo "release-artifacts: staged ${copied} binary/binaries"
ls -l "${OUT_DIR}/${NAME}.tar.gz"
echo "release-artifacts: ${OUT_DIR}/SHA256SUMS"
cat "${OUT_DIR}/SHA256SUMS"
