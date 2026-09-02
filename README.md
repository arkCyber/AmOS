# Amos — AI-First Mobile OS

[![CI](https://github.com/yourusername/amos/actions/workflows/ci.yml/badge.svg)](https://github.com/yourusername/amos/actions/workflows/ci.yml)
[![License: MIT OR Apache 2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache%202.0-blue)](./LICENSE)
[![Rust 1.80+](https://img.shields.io/badge/rust-1.80+-orange.svg)](https://www.rust-lang.org/)
[![Cargo Workspace](https://img.shields.io/badge/workspace-monorepo-brightgreen)](./Cargo.toml)

**Amos** is an AI-first mobile OS built as a single Cargo Workspace. It unifies a
long-lived native AI CLI daemon (`amos-ai`) with a Tauri 2 System UI
(`amos-tauri`), connected over a local **Unix Domain Socket (UDS)** via
**gRPC (tonic)** for low-latency, streamed token delivery.

```
[ Tauri WebView (TS/JS) ]
        │  ▲  Tauri Command / Event (async, streaming)
        ▼  │
[ Tauri Rust core  →  amos-tauri/src/ai_bridge.rs ]
        │  ▲  gRPC over Unix Domain Socket (tonic client)
        ▼  │
[ AI CLI daemon  →  amos-ai ]   ◄── GPU/NPU inference core
```

## Workspace topology

```
.
├── Cargo.toml                    # workspace root (shared deps + profiles)
├── proto/
│   └── ai_agent.proto            # single source of truth (gRPC contract)
├── docs/
│   ├── ARCHITECTURE.md             # system overview (layers, crates, contracts)
│   ├── multi-window.md           # multi-window (真·OS 阶段) architecture
│   └── android-compat.md         # Waydroid APK-compat layer
└── crates/
    ├── amos-proto/               # tonic-generated types + socket-path helper
    ├── amos-ai/                  # AI CLI daemon (gRPC *server* over UDS)
    ├── amos-wm/                  # window-manager state machine (multi-window)
    ├── amos-android/             # Waydroid/APK compat (gRPC + icon extraction)
    └── amos-tauri/               # Tauri 2 System UI (gRPC *client* bridge)
```

The `.proto` file is the single truth: editing it regenerates Rust on **both**
sides on the next `cargo build`, so the wire contract can never drift.

## Build & run

```bash
# 1. Start the AI daemon (blocking; serves /tmp/amos-ai.sock by default)
cargo run -p amos-ai

# 2. In another terminal, launch the System UI (desktop dev build)
cargo run -p amos-tauri
```

Override the socket path for both sides with the `AMOS_SOCKET` env var:

```bash
AMOS_SOCKET=/tmp/amos-test.sock cargo run -p amos-ai
AMOS_SOCKET=/tmp/amos-test.sock cargo run -p amos-tauri
```

Release build for the whole OS stack (CLI + UI in one go):

```bash
cargo build --release
```

## Inference backend

The daemon routes generation through a pluggable backend selected by `AMOS_BACKEND`:

```bash
# Mock (default) — deterministic, no network, for dev/tests
AMOS_BACKEND=mock cargo run -p amos-ai

# Real external API (OpenAI-compatible, streaming over SSE)
AMOS_BACKEND=api \
  AMOS_API_KEY=sk-... \
  AMOS_API_ENDPOINT=https://api.openai.com/v1/chat/completions \
  AMOS_MODEL=gpt-4o-mini \
  cargo run -p amos-ai

# Local Ollama (Hermes / any pulled model) — keyless, streaming, function-calling ready
AMOS_BACKEND=ollama \
  AMOS_OLLAMA_HOST=http://localhost:11434 \
  AMOS_MODEL=hermes3 \
  cargo run -p amos-ai

# Hermes-Rust agent (which itself calls Ollama) — real token streaming + tools
AMOS_BACKEND=hermes \
  AMOS_HERMES_ENDPOINT=http://127.0.0.1:11438 \
  AMOS_MODEL=hermes-rust \
  cargo run -p amos-ai

# Local GGML (llama.cpp) — binding not wired yet; falls back to mock
AMOS_BACKEND=ggml AMOS_MODEL_PATH=/path/to/model.gguf cargo run -p amos-ai
```

Unrecognized / failing backend selections fall back to mock so the daemon always boots.

## RPC contract (`proto/ai_agent.proto`)

| RPC             | Kind                  | Purpose                                   |
|-----------------|-----------------------|-------------------------------------------|
| `StreamChat`    | server-streaming      | token-by-token chat / text generation     |
| `Chat`          | bidirectional         | interactive / voice multi-turn            |
| `GetStatus`     | unary                 | liveness probe from the System UI         |

`Chat`(bidi)已接线:服务端处理文本 prompt、`Cancel`(停止)与 `audio`(暂以"ASR 未接入"
诚实应答);Tauri 桥暴露 `chat_agent` / `cancel_ai_session` 命令,AI 应用带「停止」按钮。
真正的语音(麦克风采集 → ASR → 喂 `audio`)仍需后续实现(见 `docs/gui-verify.md`)。

`amos-ai` currently ships a **mock inference engine** (`inference.rs`) that
produces a token stream. Swapping it for the real GPU/NPU core only touches that
module — the transport and UI layers stay unchanged.

## OS integration notes (mobile)

* **Transport:** UDS, not TCP loopback → lower latency + process isolation.
* **Daemon protection:** set `oom_score_adj = -1000` and pin the inference
  process inside a cgroup (CPU/memory caps) so OS fundamentals stay smooth.
* **Privacy:** all IPC is local; no external network. Zero-trust sandboxing on
  the daemon via cgroups + permissive-less sockets.
* **Lifecycle:** keep the RPC heartbeating while the WebView enters a tombstone
  (frozen) state; wake the UI via a system-level notification when an agent
  finishes a background task.

## System UI (launcher)

The single full-screen Tauri window renders an iOS-style **home screen / launcher**,
built as a **React + TypeScript** UI (Vite + Tailwind, run with **bun**):

```
frontend-ts/
├── index.html            # Vite entry
├── vite.config.ts        # dev server on :1420 (matches tauri.conf `devUrl`)
└── src/
    ├── main.tsx          # React bootstrap
    ├── App.tsx           # shell: router (home ⇄ apps), lock, recents, spotlight, NC, hardware buttons
    ├── apps.tsx          # app registry (APPS) → per-app React component
    ├── components/       # HomeDock, StatusBar, per-app views, system panels
    ├── lib/              # typed amos.* store + Tauri backend bridges + pure logic
    ├── i18n/             # zh / en dictionaries
    └── __tests__/        # headless bun test suite
```

Tapping an icon navigates to that app's full-screen view; the `⌂` button or the
home indicator returns to the launcher. The **AI 助手** app drives the real
`amos-ai` daemon through the Rust RPC bridge (`ai-token-received` / `ai-card-received`
events → streaming tokens + semantic UiCards), same spirit as the single-view chat.

Each app is a React component registered in `APPS` (apps.tsx). Functionality
included: calculator, clock, notes, messages, settings (persisted), photos,
dialer, music player, weather, maps, files, camera, android, AI, and 同传.

### Home screen editing (iOS style)

* **Long-press** an icon (≈500 ms) to enter **jiggle/edit mode**.
* Icons shake; each shows a **− badge**. Tap it on a page icon to remove it
  from the home screen, or on a dock icon to move it back to the page.
* **Drag & drop** icons to rearrange — within the grid, between grid and dock.
* Tap the floating **完成** button, empty wallpaper, or the home indicator to
  exit edit mode.
* The layout (`page` / `dock` / `hidden`) is **persisted** in `localStorage`
  (`amos.home.layout`), and newly registered apps are merged in automatically.

### Notification center

Pull down from the **status bar** (or tap the **🔔 bell** in the top-right) to
reveal an iOS-style Notification Center:

* **Quick settings** tiles (Wi‑Fi / Bluetooth / Airplane / Dark mode / Do‑Not‑Disturb /
  Location) — these share the same `amos.settings` store as the Settings app,
  so toggling in one place updates the other.
* **Brightness & volume** sliders (persisted in `amos.settings`).
* A **notification list** (seeded on first run) with per-item dismiss (✕) and a
  **清空 (clear all)** button. Notifications persist in `amos.notifications`;
  the bell shows an unread count. Notifications persist in `amos.notifications`; apps
  write via the shared store (see `frontend-ts/src/lib/settings.ts`).
* Dismiss by swiping up from the grabber handle.

## Tooling (bun)

The System UI is built with **bun** + Vite + React + TypeScript. `frontend-ts`
has real (dev) dependencies, so install once:

```bash
cd crates/amos-tauri/frontend-ts
bun install        # install react/vite/tailwind deps
bun run dev        # Vite dev server on :1420 (tauri devUrl)
bun run test       # headless unit tests (bun test, src/__tests__)
bun run typecheck  # tsc --noEmit
```

## Testing

Run the full suite (Rust unit + end-to-end UDS RPC + TS System-UI) from the repo root:

```bash
make test          # = cargo test --workspace && bun run test (frontend-ts)
make check         # fast React/TS check (bun test + typecheck)
```

- **Rust** (`cargo test --workspace`): daemon unit tests (mock inference,
  session counter, status), socket-path test, and an **end-to-end RPC test**
  that runs the real server over a Unix Domain Socket and streams tokens via
  the tonic client.
- **System-UI** (`cd crates/amos-tauri/frontend-ts && bun run test`): a headless
  `bun test` suite covering the app registry + routing, home layout & dock
  drag/jiggle editing, layout persistence, i18n/theme, streaming/ASR/interpret
  reducers and per-app logic, plus graceful degradation outside Tauri.

## Mobile (Android/iOS)

Tauri 2 mobile is ready: `amos-tauri` is already structured as a
`staticlib`/`cdylib` lib crate. After adding the mobile platform targets
(`cargo tauri android init` / `cargo tauri ios init`), build with:

```bash
cd crates/amos-tauri && cargo tauri android build
cd crates/amos-tauri && cargo tauri ios build
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on how to contribute to the project.

### Code of Conduct

We are committed to providing a welcoming and inclusive environment. Please review our [Code of Conduct](./CODE_OF_CONDUCT.md).

### Development Setup

1. Clone this repository
2. Install Rust 1.80+ via [rustup](https://rustup.rs/)
3. Install protoc: `brew install protobuf` (macOS) or `apt-get install protobuf-compiler` (Linux)
4. Run `make build` to build the workspace
5. See [CONTRIBUTING.md](./CONTRIBUTING.md) for more details

## Documentation

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — System design and crate responsibilities
- [CONTRIBUTING.md](./CONTRIBUTING.md) — How to contribute
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) — Community guidelines
- [SECURITY.md](./SECURITY.md) — Security policy and vulnerability reporting
- [docs/multi-window.md](./docs/multi-window.md) — Multi-window architecture
- [docs/android-compat.md](./docs/android-compat.md) — Waydroid/APK compatibility

## License

This project is dual-licensed under:
- **MIT License** — See [LICENSE-MIT](./LICENSE-MIT)
- **Apache License 2.0** — See [LICENSE-APACHE](./LICENSE-APACHE)

You may use this project under either license at your discretion. See [LICENSE](./LICENSE) for details.

## Acknowledgments

- Built with [Rust](https://www.rust-lang.org/) and [Tauri 2](https://tauri.app/)
- gRPC implementation via [Tonic](https://github.com/hyperium/tonic)
- Protocol buffers via [Prost](https://github.com/tokio-rs/prost)

## Roadmap

- [ ] GPU/NPU inference integration (replace mock engine)
- [ ] Full voice input support (microphone → ASR)
- [ ] Multi-window desktop OS features
- [ ] Mobile platform optimization (iOS/Android)
- [ ] Extended device API access
- [ ] Performance profiling and optimization

## Support

For issues, feature requests, or questions:
- 📖 Check [existing issues](https://github.com/arksong/amos/issues)
- 🐛 [Report a bug](https://github.com/arksong/amos/issues/new?template=bug_report.md)
- ✨ [Request a feature](https://github.com/arksong/amos/issues/new?template=feature_request.md)
- 🔒 For security issues, see [SECURITY.md](./SECURITY.md)
- 📧 Contact: arksong2018@gmail.com
