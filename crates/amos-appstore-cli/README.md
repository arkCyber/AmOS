# amos-appstore-cli — drive the app store from a terminal

The terminal front end of **[`crates/amos-appstore`](../amos-appstore/README.md)**: browse a
catalog, view an app, install/upgrade/uninstall, browse and search a real **F-Droid** repo,
and download an artifact with sha256 verification — where `download` never pretends to install
anything. Part of **[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

```text
amos-appstore-cli catalog [--json]                 # what the provider offers
amos-appstore-cli view <id>                        # versions, size, checksum, notes
amos-appstore-cli install <id>                     # atomic install (sha256 verified)
amos-appstore-cli update [<id>]                    # upgrade what has a newer version
amos-appstore-cli uninstall <id>
amos-appstore-cli search <query> --repo <path|url> # F-Droid index browse/search
amos-appstore-cli download <id> --out <path>       # fetch + verify, install nothing
```

- The default provider is the **offline mock**, so every command works without a network and
  without installing anything.
- `download` is deliberately separate from `install`: fetching bytes and installing an app are
  different acts, and the CLI never blurs them.
- `--repo` reads an F-Droid `index-v1.json`, so the terminal can browse the real ecosystem the
  engine is compatible with.

## Layout

| file | what |
|---|---|
| `src/main.rs` | the binary: args → `run` → exit code |
| `src/lib.rs` | `parse_args`, `Op`, `demo_provider`, `dispatch`, `run` |
| `tests/` | process-level smoke over the shipped binary |

## Build & test

```bash
cargo test -p amos-appstore-cli
cargo run -p amos-appstore-cli -- catalog
cargo clippy -p amos-appstore-cli --all-targets -- -D warnings
```

## Examples

```bash
# Embed the CLI's command interpreter in a program (no shell).
cargo run -p amos-appstore-cli --example embed_commands
```

| example | shows |
|---|---|
| `embed_commands` | `run` (what `main.rs` calls) used from a harness: the catalog, a view and a `download`-only flow against the offline provider, printing what the shell would have printed |

## Honest boundaries

- **The default provider is a mock**: `install` on the mock installs into a mock store. A real
  install happens on device through the Android channel (`crates/amos-appstore`), which this
  CLI does not pretend to be.
- **`download` verifies and stops**: no implicit install, no "probably fine" artifact.
- **Network access happens only when a `--repo` URL is given**: the default path is offline.
- **Exit codes are the contract**: `0` ok, non-zero on refusal or verification failure.

## Related

- [`crates/amos-appstore`](../amos-appstore/README.md) — the engine (integrity, F-Droid).
- [`docs/appstore.md`](../../docs/appstore.md) · [`docs/fdroid-audit.md`](../../docs/fdroid-audit.md)
