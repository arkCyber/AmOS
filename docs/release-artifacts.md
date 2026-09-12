# Release artifacts (gap #39)

**Status:** implemented 2026-09-11 — a tagged build now produces downloadable,
checksummed release bundles instead of nothing.

## What a release is

The release is the **headless bundle**: the daemon, the supervisor, the translator
and the CLIs, built `--locked` (the committed `Cargo.lock` is authoritative) and
packaged as

```
dist/amos-<version>-<target>/
  bin/            the released binaries
  VERSION         the workspace version that was built
  README.txt      contents + honest scope (what is NOT in this bundle)
dist/amos-<version>-<target>.tar.gz
dist/SHA256SUMS   one "<sha256>  <file>" line per tarball
```

| Binary | Role |
|---|---|
| `amos-ai` | the AI daemon: AI Agent gRPC service over a Unix Domain Socket |
| `amos-supervisor` | launch/supervise the CLI daemons from a JSON config |
| `amos-translate` | translation daemon (used by the interpreter + chat ASR paths) |
| `amos-int-cli` | simultaneous-interpretation CLI |
| `amos-mail-cli` | email client CLI |
| `amos-appstore-cli` | app-store CLI |
| `amos-timesync-cli` | wall-clock query/calibration CLI |
| `amos-pdf-parser` | PDF → text/RAG chunks CLI |

## One implementation, two callers

`scripts/release-artifacts.sh` is the **only** definition of what a release
contains. It is called by both

* `make release-artifacts` (a maintainer's machine — this is how the bundle above
  was produced and verified locally), and
* `.github/workflows/release.yml` (a `v*` tag push, or a manual dispatch).

Env knobs (all optional): `AMOS_RELEASE_DIR` (default `dist`),
`AMOS_RELEASE_TARGET` (cross/`--target` triple; default = host),
`AMOS_RELEASE_BINS` (override the binary list),
`AMOS_RELEASE_NO_BUILD=1` (package binaries that are already built).

## The `--version` contract

A released binary that cannot say what it is cannot be audited after deployment, so
every binary in the bundle must answer `-V/--version` with `"<name> <version>"`.

`release-artifacts.sh` **enforces** this: after staging, it runs `--version` on every
binary and aborts the release if the output does not contain the version being
packaged. The 6 CLIs that lacked the flag (`amos-supervisor`, `amos-int-cli`,
`amos-mail-cli`, `amos-appstore-cli`, `amos-timesync-cli`, `amos-pdf-parser`) were
given it as part of this work, and each parse is unit-tested plus the printed line is
pinned in tests.

## Tag ↔ version consistency

A tag build passes `AMOS_RELEASE_TAG` (the workflow sets it only for `refs/tags/v*`).
The script then requires `tag == "v" + VERSION` and refuses to package otherwise, so a
release can never be *named* after one version while its `VERSION` file and its
binaries report another. Local runs (and `workflow_dispatch`) simply omit the variable.

The version itself is read **section-aware** — only `[workspace.package]` in the root
`Cargo.toml` — and validated as semver, so a dependency's `version = "…"` line can
never be mistaken for ours (a fixture with a dependency version first used to yield
`9.9.9`; it now yields the real `0.1.0`).

## CI behaviour (`Release` workflow)

* `bundle` — matrix over **native** runners only:
  `ubuntu-24.04` → `x86_64-unknown-linux-gnu`, `macos-14` → `aarch64-apple-darwin`.
  Each leg runs the script and uploads `dist/*.tar.gz` + `dist/SHA256SUMS` as a
  workflow artifact (`if-no-files-found: error`), so a build is retrievable even
  without a Release. A `v*` tag push is never cancelled by a newer push.
* `publish` — only for tags: downloads every bundle, **verifies `sha256sum -c
  SHA256SUMS`**, then creates the GitHub Release (or uploads to it with `--clobber`),
  using the preinstalled `gh` CLI so no third-party release action is involved.

## Honest boundaries

This closes "CI publishes nothing", **not** "everything is packaged":

* **No Tauri desktop bundle** (`.deb`/AppImage/`.dmg`) and **no Android APK** — those
  are separate toolchains (`make run-ui-release`, `make android-app`). The bundle's
  own `README.txt` says so on every download.
* **No arm64-linux leg** yet (the daemon's real device class): it needs either an
  arm64 runner or a cross toolchain, neither of which is verified here.
* **No signing / notarization / SBOM / provenance attestation**; integrity rests on
  the SHA-256 manifest (and, on a Release, GitHub's asset hosting).
* **Reproducible only in the `--locked` sense** (same lockfile ⇒ same dependency
  graph), not bit-for-bit: the compiler/toolchain version is not pinned in a
  checked-in file.
