# amos-appstore — app-store core engine (catalog, integrity, install, F-Droid)

The store's engine: catalog/version models, a `StoreProvider` seam, sha256 integrity checking,
a real install/update/uninstall engine, F-Droid repository compatibility (read `index-v1.json`
/ publish as an F-Droid repo) and a PWA/web-install path. Part of **[Amos](../../README.md)**.
Design record: [`docs/appstore.md`](../../docs/appstore.md) · repo audit:
[`docs/fdroid-audit.md`](../../docs/fdroid-audit.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `client.rs` (the `AppStore<S>` engine) + `provider.rs` (`StoreProvider` seam,
  `MockStoreProvider`): the same engine runs against an offline mock, a local directory or a
  real F-Droid index.
- **Integrity is not optional**: `atomic.rs` writes a download to a temp path, verifies its
  **sha256**, and only then moves it into place — a mismatched or truncated artifact never
  becomes an installed app, and a failed install never leaves a half file behind.
- `fdroid.rs`: read an F-Droid `index-v1.json` (browse/search) and/or publish AmOS's own
  catalog in that format, so the store is compatible with an existing ecosystem instead of
  inventing a private one.
- `serve.rs` serves a catalog (the repo shape a device can point at); `webinstall.rs` +
  `pwa.rs` handle the web-install path; `sign.rs` verifies/attaches repository signatures;
  `android.rs` (feature `android`) is the on-device install channel.
- `host.rs` provides the host filesystem backend so everything above is exercisable offline.

It is **not** a package manager for system libraries and does not bypass the platform: on
device the actual install goes through the Android package installer.

## Layout

| file | what |
|---|---|
| `src/client.rs` | `AppStore<S>`: catalog, install/update/uninstall |
| `src/provider.rs` | `StoreProvider` seam + `MockStoreProvider` |
| `src/model.rs` | app/version/catalog types |
| `src/atomic.rs` | atomic download + sha256 verification |
| `src/fdroid.rs` | F-Droid index read/write |
| `src/serve.rs` | serve a catalog over the repo shape |
| `src/webinstall.rs` · `src/pwa.rs` | web-install / PWA index |
| `src/sign.rs` | repository signature handling |
| `src/host.rs` | host filesystem backend |
| `src/android.rs` | *(feature `android`)* the device install channel |

## Build & test

```bash
cargo test -p amos-appstore
cargo check -p amos-appstore --features android,appstore-live
cargo clippy -p amos-appstore --all-targets -- -D warnings
```

## Examples

```bash
# The offline provider: browse a catalog, install with sha256 verification, uninstall.
cargo run -p amos-appstore --example offline_catalog
```

| example | shows |
|---|---|
| `offline_catalog` | a catalog served by the mock provider, an install that verifies its artifact hash, an update to a newer version, an uninstall, and what a tampered artifact does (refused, nothing installed) |

## Honest boundaries

- **Installing on a device is the platform's job**: the Android channel shells out to the
  package installer; a refusal there is reported, never worked around.
- **Signature verification covers what the repo provides** — an unsigned repo is accepted only
  where the policy says so, and the fact is surfaced.
- **No account, no ratings, no reviews**: this is a catalog + integrity + install engine.
- **Network access happens only in the live provider**; the mock path is fully offline.

## Related

- [`docs/appstore.md`](../../docs/appstore.md) — catalog shape, install states and the UI contract.
- [`docs/fdroid-audit.md`](../../docs/fdroid-audit.md) — what F-Droid compatibility does and
  does not cover.
- [`crates/amos-appstore-cli`](../amos-appstore-cli/README.md) — the terminal front end.
