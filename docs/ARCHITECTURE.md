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

> **部署判定 (2026-09-03)**：真机产品本体底座 = **no-UI Android 基座**（`docs/no-ui-android.md`），旧 APK 原生运行。`AndroidRuntime driver (Waydroid | Demo)` 在真机路径换成面向原生 app 的 driver；**Waydroid 仅作开发/原型**（`docs/android-compat.md`）。详见两文档顶部的定位判定。

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
| `amos-translate` | simultaneous-interpretation daemon (gRPC) with pluggable translation + ASR providers |
| `amos-int` | transport-agnostic interpretation session engine (state machine, utterance assembly, `Pipeline` trait) |
| `amos-asr` | streaming speech recognition: `StreamingRecognizer` abstraction + `AsrPipeline` (Partial/Final) + gated sherpa-onnx backend |
| `amos-tts` | text-to-speech: `TtsProvider` trait (Mock + gated Piper) -> playable `TtsAudio` |
| `amos-appstore` | app-store domain core: `AppManifest` catalog + `Version`, sha256 integrity, Ed25519 publisher signing, `AppStore` engine (download→verify→install/upgrade/uninstall) over a pluggable `StoreProvider` (Mock default; `live` feature adds a real HTTP backend) |
| `amos-appstore-cli` | headless app-store CLI (demo/catalog/search/install/upgrade/uninstall/status) driving the same engine, mirroring `amos-mail-cli` |

## RPC contract (`proto/`)

* `ai_agent.proto`: `StreamChat` (server-streaming tokens), `Chat` (bidi),
  `GetStatus`.
* `android_compat.proto`: `LaunchAndroidApp`, `GetInstalledApps`, `GetAppIcon`.

`amos-ai` serves both services on one UDS; `amos-tauri` uses one cached channel
for both clients.

## Frontend (React + TypeScript, Vite + Tailwind, run by bun)

* `frontend-ts/src/App.tsx` — shell: router (home ⇄ apps), lock/recents/spotlight/NC,
  and hardware-button (Home/Voice/AI) handling.
* `frontend-ts/src/apps.tsx` — app registry (`APPS`) → per-app React component.
* `frontend-ts/src/components/` — HomeDock, StatusBar, per-app views, system panels.
* `frontend-ts/src/lib/` — typed `amos.*` store + Tauri backend bridges + pure logic.
* `frontend-ts/src/i18n/` — zh / en dictionaries.
* `frontend-ts/src/__tests__/` — headless bun test suite.

## Boot (no-UI Android)

`deploy/android/amos.rc` creates the socket dir, starts `amos-ai` after
`sys.boot_completed`, and `amos-tauri` is the single launcher APK. Cross-compile
the headless binaries with `scripts/build-android.sh`.

## Quality gates

```bash
make lint   # cargo fmt --check + clippy -D warnings
make test   # cargo test --workspace + bun run test (frontend-ts)
make check  # React/TS check: bun test + typecheck (frontend-ts)
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
