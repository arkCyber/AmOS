# amos-tauri — the System UI (Tauri 2 shell + Rust core)

The user-facing half of Amos: a Tauri 2 application whose Rust core bridges the WebView to the
daemon over the Unix Domain Socket, owns window/form-factor policy, and exposes the typed
commands the Svelte UI calls. Includes the embedded frontend
(`frontend-ts/`, Svelte + TypeScript). Part of **[Amos](../../README.md)**. Verification
records: [`docs/gui-verify.md`](../../docs/gui-verify.md) ·
[`docs/multi-window.md`](../../docs/multi-window.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `src/lib.rs` (`run()`): builds the Tauri app, resolves the form factor, measures the screen,
  creates the shell window, and installs the logging subscriber (Android logcat / desktop
  stderr).
- **The AI bridge** (`src/ai_bridge.rs`): one gRPC client to the daemon, with streaming events
  forwarded to the WebView as Tauri events — the UI never opens a socket itself.
- **Window management** (`src/wm.rs`): applies [`crates/amos-wm`](../amos-wm/README.md)'s model
  to real `WebviewWindow`s (create/focus/maximize/split), reports what the OS actually applied,
  and re-measures on `Resized`. App windows carry `#window=<label>` so each pane opens onto its
  app instead of the launcher.
- **~190 commands**: every capability the Svelte screens use (telephony, SMS, contacts, media,
  store, clipboard, radio, sensors, settings, store-backed UI state) is an explicit,
  type-checked command — `scripts/tauri-command-scan.mjs` proves each one is declared *and*
  reachable from a screen or from Rust.
- **Frontend gates**: `bun run check` runs typecheck + svelte-check + i18n/unwired/store/write
  scans, and `bun run test` runs 1000+ tests (pure lib tests + DOM tests in separate
  processes).

It is **not** a browser and does not embed a second network stack: WebView → Rust → UDS.

## Layout

| path | what |
|---|---|
| `src/main.rs` | the binary entry point |
| `src/lib.rs` | `run()`: app setup, form factor, screen measurement, logging |
| `src/ai_bridge.rs` | the daemon client + event forwarding |
| `src/wm.rs` | window manager adapter (real windows, honest reporting) |
| `src/link.rs` | the robot-link bridge: reads the daemon's AmOS-Link control plane (`RobotLink.GetStatus`) for the Settings「机器人链路」page |
| `src/*.rs` | the command modules (telephony, sms, media, appstore, clipboard, radio, …) |
| `frontend-ts/` | the Svelte/TypeScript System UI (apps, shell, i18n, tests, its own gates) |
| `tests/` | end-to-end daemon tests over a real UDS |
| `examples/term_shell.rs` | the PTY terminal harness (feature `terminal-pty`) |

## Build & test

```bash
cargo test -p amos-tauri                    # Rust core unit + integration tests
cargo test -p amos-tauri --features terminal-pty --lib
cargo clippy -p amos-tauri --all-targets --features appstore-live,tcp,terminal-pty -- -D warnings
cd frontend-ts && bun run check && bun run test    # UI gates
```

## Examples

```bash
cargo run -p amos-tauri --features terminal-pty --example term_shell
```

| example | shows |
|---|---|
| `term_shell` | the PTY terminal core the Terminal app uses, driven headlessly: spawn a real shell, send input, read output — the same code path the WebView calls |

## Running the UI

```bash
make dev               # daemon + UI in dev (loads the Vite dev server)
make run-ui-release    # release binary with the embedded frontend (freshness-checked)
make app-open          # macOS: build the .app bundle and open it (the form the OS activates)
```

## Honest boundaries

- **A bare `cargo build` binary is not an app bundle**: on macOS it renders behind other
  windows and the host can only warn about it — `make app-open` is the honest path.
- **The embedded frontend is built by hand**: `tauri.conf.json`'s `beforeBuildCommand` is
  empty, so stale `dist/` would silently ship old UI — `scripts/dist-freshness.mjs` refuses it.
- **Device-only features need the device** (Waydroid, Android providers, permissions); host
  runs use the mocks and say so.
- **Window geometry is the OS's answer**: the host reports what was applied and warns when a
  request was not honoured.
- **No port is bound by the release UI** (no dev server): the embedded path is offline.

## Related

- [`crates/amos-wm`](../amos-wm/README.md) — the window model this applies.
- [`crates/amos-ai`](../amos-ai/README.md) — the daemon behind the bridge.
- [`frontend-ts/README.md`](frontend-ts/README.md) — the UI's own documentation.
