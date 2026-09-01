# Amos Architecture Overview

Amos is an **AI-first mobile OS** built as a single Rust Cargo Workspace: a
long-lived AI daemon, a window-manager state machine, an Android-compat layer,
and a Tauri 2 System UI — all connected over a local Unix Domain Socket via gRPC.

## Runtime layering

```
[ Tauri System UI (Launcher + apps, one WebView) ]
        │  Tauri commands / streamed events
        ▼
[ Tauri Rust core (amos-tauri) ] ── gRPC client (shared, cached channel)
        │  Unix Domain Socket (/tmp/amos-ai.sock, or AMOS_SOCKET)
        ▼
[ amos-ai daemon: AiAgent + AndroidManager services ]
        │        └── AndroidRuntime driver (Waydroid | Demo)
        ▼
[ no-UI Android base / Linux ]  →  NPU/GPU/Wi-Fi/bluetooth
```

The single UDS carries **all** services, so the OS backend is one process and
one connection; the WebView talks to a real daemon, not directly to hardware.

## Workspace crates

| Crate | Role |
|---|---|
| `amos-proto` | gRPC contracts (`ai_agent`, `android_compat`) + socket helper; tonic-generated |
| `amos-ai` | AI daemon (gRPC server) + CLI args; headless, socket `0700`, graceful shutdown |
| `amos-wm` | transport-agnostic window-manager state machine (z-order/focus) |
| `amos-android` | Waydroid / demo runtime + icon extraction + PNG generation |
| `amos-tauri` | System UI: launcher, 14 apps, notification center, gRPC bridge, Android commands |

## RPC contract (`proto/`)

* `ai_agent.proto`: `StreamChat` (server-streaming tokens), `Chat` (bidi),
  `GetStatus`.
* `android_compat.proto`: `LaunchAndroidApp`, `GetInstalledApps`, `GetAppIcon`.

`amos-ai` serves both services on one UDS; `amos-tauri` uses one cached channel
for both clients.

## Frontend (static, no bundler — run by bun)

* `js/core.js` — app registry + router (home ⇄ app) + persistent home layout.
* `js/nc.js` — notification center (quick settings + notifications).
* `js/apps/*.js` — 14 apps, including the real **AI 助手** (drives the daemon)
  and **安卓应用** (lists/launches legacy APKs, real PNG icons).
* `js/main.js` — boot, clock, AI stream event wiring, global error boundary.

## Boot (no-UI Android)

`deploy/android/amos.rc` creates the socket dir, starts `amos-ai` after
`sys.boot_completed`, and `amos-tauri` is the single launcher APK. Cross-compile
the headless binaries with `scripts/build-android.sh`.

## Quality gates

```bash
make lint   # cargo fmt --check + clippy -D warnings
make test   # cargo test --workspace + bun run test (frontend)
make check  # frontend JS syntax check (bun)
```

Rust tests include real UDS + gRPC round trips (AI streaming, Android list /
launch / icon). The frontend test harness runs all apps and their logic under a
minimal DOM stub via bun. CI (`.github/workflows/ci.yml`) runs lint + test.

## Deployment notes / honest limits

* Waydroid-specific behavior (launching real APKs, extracting real icons) needs
  a device with Waydroid; on any other host the daemon auto-selects the in-process
  `DemoRuntime`, so the whole pipeline still works end-to-end.
* Tauri `csp` is currently unset (`null`); tightening it is a follow-up that
  should be validated against a real GUI/webview build.
