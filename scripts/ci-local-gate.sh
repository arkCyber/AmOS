#!/usr/bin/env bash
# scripts/ci-local-gate.sh — local CI-parity validation for the engineering fix.
#
# Catches the drift/failure classes that have been reddening CI without needing
# to push:
#   1. Broken shell in any CI script (scripts/*.sh, deploy.sh) — bash -n.
#   2. Malformed workflow / composite-action YAML.
#   3. Missing pieces of the native-toolchain containerization (Dockerfile,
#      composite action, publish workflow).
#   4. Version-pin drift between the single sources of truth:
#      .github/docker/ci-android/Dockerfile  vs  .github/actions/prep-android
#      (NDK + cargo-ndk must match so container & host modes behave identically).
#   5. The container image actually builds (docker build) — runs only when a
#      Docker daemon is reachable (pass --docker to force, else auto-skip).
#
# Run:  bash scripts/ci-local-gate.sh            (works offline; no CI needed)
#       ./deploy.sh ci-local                     (same)
#       bash scripts/ci-local-gate.sh --docker   (also docker-build the image)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

fails=0
warn=0
note() { printf '  [..] %s\n' "$*"; }
ok()   { printf '  [ok] %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*"; fails=$((fails + 1)); }
wrn()  { printf '  [warn] %s\n' "$*"; warn=$((warn + 1)); }

echo "=== AmOS local CI-parity gate ($REPO_ROOT) ==="

# --- 1. bash syntax over every shell script --------------------------------
echo; echo "-- 1. shell syntax (bash -n) --"
sh_failed=0
while IFS= read -r -d '' f; do
  if ! bash -n "$f"; then
    printf '  [FAIL] syntax: %s\n' "$f"; sh_failed=1
  fi
done < <(find . -path ./.git -prune -o -type f \
    \( -name '*.sh' -o -name 'deploy.sh' \) -print0)
if [[ "$sh_failed" -eq 0 ]]; then ok "all shell scripts pass bash -n"; else bad "shell syntax errors"; fi

# --- 2. workflow / action YAML --------------------------------------------
echo; echo "-- 2. workflow + action YAML --"
if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' 2>/dev/null; then
  yaml_bad=0
  while IFS= read -r -d '' f; do
    if ! python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' "$f" 2>/dev/null; then
      printf '  [FAIL] yaml: %s\n' "$f"; yaml_bad=1
    fi
  done < <(find .github -type f \( -name '*.yml' -o -name '*.yaml' \) -print0)
  if [[ "$yaml_bad" -eq 0 ]]; then ok "all .github YAML parses"; else bad "yaml errors"; fi
else
  wrn "python3+pyyaml not available; skipping YAML parse"
fi

# --- 3. required containerization files present ----------------------------
echo; echo "-- 3. native-toolchain containerization assets --"
required=(
  .github/docker/ci-android/Dockerfile
  .github/actions/prep-android/action.yml
  .github/workflows/container-image.yml
  .github/workflows/ci.yml
  deploy.sh
)
for f in "${required[@]}"; do
  if [[ -f "$f" ]]; then ok "present: $f"; else bad "missing: $f"; fi
done

# --- 4. pin parity: Dockerfile vs composite action --------------------------
echo; echo "-- 4. pinned version parity (NDK / cargo-ndk) --"
dockerfile=".github/docker/ci-android/Dockerfile"
action=".github/actions/prep-android/action.yml"
for pair in "NDK_VERSION=26.1.10909125|ndk-version|26.1.10909125" \
            "CARGO_NDK_VERSION=4.1.2|cargo-ndk-version|4.1.2"; do
  df_token="${pair%%|*}"; rest="${pair#*|}"; act_key="${rest%%|*}"; expect="${rest#*|}"
  if grep -q "$df_token" "$dockerfile" && grep -q "$act_key" "$action" \
     && grep -q "$expect" "$dockerfile" && grep -q "$expect" "$action"; then
    ok "$df_token == $expect (Dockerfile + action in lockstep)"
  else
    bad "pin mismatch for $df_token (expected $expect in both Dockerfile and action)"
  fi
done

# --- 5. optional docker build of the image ----------------------------------
echo; echo "-- 5. container build --"
want_docker=0
for a in "$@"; do [[ "$a" == "--docker" ]] && want_docker=1; done
if [[ "$want_docker" -eq 1 ]] || docker info >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    echo "  building .github/docker/ci-android --platform linux/amd64 (downloads the NDK; may take a while)..."
    if docker build --platform linux/amd64 -q .github/docker/ci-android >/dev/null; then
      ok "docker image builds"
    else
      bad "docker image build failed"
    fi
  else
    wrn "docker daemon not running; skipping build (start Docker Desktop, or pass --docker)"
  fi
else
  wrn "docker not available; skipping build"
fi

echo
if [[ "$fails" -eq 0 ]]; then
  echo "=== ci-local gate PASSED (${warn} warning(s)) ==="
  exit 0
else
  echo "=== ci-local gate FAILED ($fails failure(s), ${warn} warning(s)) ==="
  exit 1
fi
