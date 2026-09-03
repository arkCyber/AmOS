# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Network time calibration (`amos-timesync`, 2026-09-03)**: transport-agnostic `TimeSource` seam (`MockTimeSource` deterministic, `HostClock` offline fallback) feeding a `SyncedClock` that turns an authoritative network time into a signed host-clock offset, applies it to `now()`, rejects implausible times (plausibility window 2000–2100), and atomically persists the last-known-good offset (corrupt/missing file degrades gracefully). A `Timekeeper` runs the periodic sync loop. Real SNTP query is a `ntp` feature (`NtpTimeSource` via `sntpc` + `sntpc-net-std`, blocking work on `spawn_blocking`); a `ntp_probe` example does a live query. Deps: `async-trait`, `thiserror` (+ optional `sntpc`/`sntpc-net-std`).
- **Supervised periodic time sync (`amos-supervisor` `timesync` feature, 2026-09-03)**: optional background wall-clock calibration orchestrated alongside daemon supervision. Default build and behaviour unchanged; enabling the `timesync` feature and `AMOS_TIMESYNC=1` at runtime spawns a periodic `SyncedClock` loop (`AMOS_NTP_SERVER` for real SNTP, `AMOS_TIMESYNC_STATE`/`AMOS_TIMESYNC_INTERVAL_SECS` optional), exposes live calibrated-time status (`TimeSyncHandle::report()`: corrected now / offset / staleness, printed at startup, on SIGUSR1, and before shutdown), and exports the state path to supervised children via `AMOS_TIMESYNC_STATE` so any daemon can load the last-known-good calibrated clock. Added to `make gated-check`.
- **App store core engine (`amos-appstore`, 2026-09-03)**: transport-agnostic `AppManifest` catalog + `Version`, sha256 integrity check, and an `AppStore` engine driving download → verify → install / upgrade / uninstall over a pluggable `StoreProvider` (deterministic in-memory `MockStoreProvider` today) with a JSON-persisted installed registry. Publish contract + developer onboarding in `docs/appstore.md`.
- **App store CLI (`amos-appstore-cli`, 2026-09-03)**: headless terminal driver over the same engine (demo/catalog/search/install/upgrade/uninstall/status), mirroring `amos-mail-cli`; `--catalog <URL>` (with `--features live`) swaps the offline demo for the real HTTP backend.
- **App store HTTP backend (`amos-appstore` `live` feature, 2026-09-03)**: `HttpStoreProvider` fetches a remote `MockCatalog` JSON catalog + downloads packages over HTTP (ureq in `spawn_blocking`); feature-gated so the default build stays offline-green. Both the CLI (`--catalog`, `--features live`) and the Tauri `StoreBridge` (`AMOS_APPSTORE_CATALOG`, `--features appstore-live`) can select it at runtime via a type-erased `Box<dyn StoreProvider>`.
- **App store publisher signing (`amos-appstore`, 2026-09-03)**: Ed25519 signing/verification of app manifests (`DeveloperKey`/`sign_manifest`/`verify_manifest_signature`, `publisher` field); the engine verifies a signed manifest's signature before install/upgrade and refuses mismatches (`BadPublisherSignature`). Dep: `ed25519-dalek`.
- **Web-bundle installer (`amos-appstore`, 2026-09-03)**: `webinstall::WebInstaller` unpacks a verified `tar.gz` web-bundle (`index.html` + assets + `amos-app.json`) into `<root>/<id>/`, validates the entry file, writes `manifest.json`, and uninstalls; `tar` refuses `..`/absolute paths. Deps: `tar`, `flate2`.
- **Web-bundle server resolver (`amos-appstore`, 2026-09-03)**: `serve::{resolve_request, content_type_for}` maps a host request path safely onto a file inside an installed bundle (refuses traversal/`..`, falls back to `index.html`, returns MIME + `nosniff`) — the server-side gate a future custom-protocol host needs.
- **Engine web-bundle install (`amos-appstore`, 2026-09-03)**: `AppStore::with_web_install_dir(dir)` makes `install`/`upgrade` of a `tar.gz` bundle also unpack it to `<dir>/<id>/` (and `uninstall` removes it); a bundle that can't unpack fails the install and isn't recorded. Tests cover unpack→uninstall and broken-bundle rejection.
- **StoreBridge bundle serving (`amos-tauri`, 2026-09-03)**: `StoreBridge` reads `AMOS_APPSTORE_INSTALL_DIR` and configures the engine's web-install dir; new command `appstore_bundle_resource(id, path)` returns a bundle file as base64 + MIME (sanitised by `serve::resolve_request`), so a local web-bundle can be rendered without a custom protocol. Headless-tested.
- **App Store System-UI page (`frontend-ts`, 2026-09-03)**: new "App Store" app (`components/StoreApp.tsx`, registered in `APPS`/`COMPONENTS`) browses the catalog (offline demo or HTTP) and install / update / uninstall through the `store*` bridge, with graceful offline fallback outside the Tauri shell. i18n zh/en.
- **Dynamic home registry for store apps (`frontend-ts`, 2026-09-03)**: store-installed apps become persistent home-screen tiles (`lib/storeApps.ts`, `store:<mid>` ids merged into `amos.home.layout`); `HomeDock`/title/`AppComponent` resolve them and tapping opens a placeholder container (`components/ExtApp.tsx`) until a real runtime host (installer) lands. Store page changes notify the shell live.
- **Durable system state store (`amos-tauri` + `frontend-ts`, 2026-09-03)**: `SharedStore` persists every `amos.*` mutation to disk (`$AMOS_STATE_FILE`, default `~/.amos/state.json`); on boot the shell hydrates localStorage from it, so state recovers even after localStorage is cleared.
- **Permission ledger (`frontend-ts`, 2026-09-03)**: `lib/permissions.ts` — pure, immutable, durable (store-backed `amos.permissions`) grants of sensitive capabilities (camera/microphone/location/notifications) per app; query/grant/revoke + normalize. UI dashboard + enforcement wiring next.
- **Privacy & permissions dashboard (`frontend-ts`, 2026-09-03)**: new "privacy" app (`components/PermissionsApp.tsx`, in `APPS`) lists each capability with its granted apps (revocable) and allow/deny toggles for the built-in apps that request it; changes persist in the durable store.
- **Permission enforcement — camera (`frontend-ts`, 2026-09-03)**: `CameraApp` now refuses to call `getUserMedia` until the "camera" capability is granted for the camera app; an allow/deny overlay prompts first, and denying blocks the feed (retry from the Privacy app). Mic/location call sites still to gate.
- **Reusable capability gate (`frontend-ts`, 2026-09-03)**: `components/CapabilityGate.tsx` exports `useCapability(appId, cap)` + a `<CapabilityGate>` allow/deny overlay + `revokeCapability`; generic i18n (`perm.allow/deny/askAllow/denied`). Ready to apply to mic/location call sites.
- **Permission enforcement — location (`frontend-ts`, 2026-09-03)**: `MapsApp` "Locate" now asks before calling geolocation: ungranted taps show an allow/deny banner, and geolocation only runs once the "location" capability is granted for maps (persisted). Microphone call sites (VoiceMicButton / BackendApps) remain to gate with the same hook.
- **Permission enforcement — microphone (`frontend-ts`, 2026-09-03)**: capture is gated behind the "microphone" capability for both the AI app's mic (`VoiceMicButton`, inline allow/deny bubble) and the interpreter's own capture (`BackendApps.InterpApp`, two-tap consent). None call `getUserMedia({audio})` before the capability is granted; allows persist (revoke via Privacy).
- **Time-sync CLI (`amos-timesync-cli`, 2026-09-03)**: headless driver over the same `SyncedClock` — `now`/`status` read the last-known-good calibrated clock from state (no network), `sync` runs one calibration pass (offline host clock by default; `--server`/`$AMOS_NTP_SERVER` does a real SNTP query behind the `ntp` feature), mirroring the other `*-cli` crates. Reads/writes the same `AMOS_TIMESYNC_STATE` file the supervisor exports, so operators and supervised daemons can consume the calibrated time. Added to `make gated-check`.
- New features and enhancements in development

### Changed
- Modifications to existing features

### Fixed
- Bug fixes

### Deprecated
- Features planned for removal

### Removed
- Features removed from the project

### Security
- Security-related changes and patches

## [0.1.0] - 2025-09-01

### Added
- Initial release with core architecture
- AI daemon (amos-ai) with gRPC server over UDS
- Tauri 2 System UI (amos-tauri) as gRPC client
- Window manager state machine (amos-wm)
- Protocol buffer definitions (amos-proto)
- Waydroid/APK compatibility layer (amos-android)
- CI/CD workflow with GitHub Actions
- Comprehensive documentation

### Notes
- This is the initial beta release
- API and architecture subject to change before 1.0

---

## Template for new releases

When creating a new release:

1. Update version numbers in `Cargo.toml` across all crates
2. Update version in `tauri.conf.json`
3. Add corresponding section below with:
   - Date in YYYY-MM-DD format
   - Clear categorization of changes
   - Links to related issues/PRs
4. Update any affected documentation

### Commit message format:

```
chore(release): v0.X.Y

- Brief description of major features
- Link to release notes
```

### Release checklist:

- [ ] All tests passing (`make test`)
- [ ] All linting clean (`make lint`)
- [ ] CHANGELOG.md updated
- [ ] Version numbers updated
- [ ] Documentation updated if needed
- [ ] Security audit completed
- [ ] Tagged in git: `git tag v0.X.Y`
- [ ] GitHub release created with release notes
