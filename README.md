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

The single full-screen Tauri window renders an iOS-style **home screen / launcher**:

```
frontend/
├── index.html          # full-screen shell: status bar, viewport, home indicator
├── styles.css          # iOS-style wallpaper, icon grid, dock, app transitions
└── js/
    ├── core.js         # app registry + router (home ⇄ app screens) + DOM helpers
    ├── main.js         # boot: clock, home indicator, AI stream event wiring
    └── apps/           # one module per app
```

Tapping an icon navigates to that app's full-screen view; the `⌂` button or the
home indicator returns to the launcher. The **AI 助手** app drives the real
`amos-ai` daemon through the Rust RPC bridge (`ai-token-received` events →
typing-machine effect), identical to the earlier single-view chat.

Each app is a plain module registering itself via `Amos.register({ id, name,
icon, gradient, render, onMount?, onUnmount? })`. Functionality included:
calculator, clock, notes, messages, settings (persisted), photos, dialer,
music player, weather, maps, files, camera, and AI.

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
  the bell shows an unread count. Apps can post via `window.AmosNc.post(...)`.
* Dismiss by swiping up from the grabber handle.

## Tooling (bun)

The frontend uses **bun** (not npm) as its runtime and package manager. The
frontend has no third‑party dependencies, so `bun install` is a no‑op.

```bash
cd crates/amos-tauri/frontend
bun install     # no-op (no deps) — creates nothing
bun run test    # unit tests (tests/run_tests.mjs)
bun run check   # syntax check via Bun.Transpiler (tests/check_syntax.mjs)
```

## Testing

Run the full suite (Rust unit + end-to-end UDS RPC + frontend JS) from the repo root:

```bash
make test          # = cargo test --workspace && bun run test
make check         # fast frontend JS syntax check (bun)
```

- **Rust** (`cargo test --workspace`): daemon unit tests (mock inference,
  session counter, status), socket-path test, and an **end-to-end RPC test**
  that runs the real server over a Unix Domain Socket and streams tokens via
  the tonic client.
- **Frontend** (`cd crates/amos-tauri/frontend && bun run test`): a bun/Node
  harness (`tests/run_tests.mjs`) with a minimal DOM stub covering the core DOM
  helper, app registry, home layout, jiggle/delete/drag-reorder, layout
  persistence, and graceful degradation without Tauri internals / with blocked
  storage.

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
