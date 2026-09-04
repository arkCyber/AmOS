# Amos — AI-First Mobile OS

[![CI](https://github.com/yourusername/amos/actions/workflows/ci.yml/badge.svg)](https://github.com/yourusername/amos/actions/workflows/ci.yml)
[![License: MIT OR Apache 2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache%202.0-blue)](./LICENSE)
[![Rust 1.80+](https://img.shields.io/badge/rust-1.80+-orange.svg)](https://www.rust-lang.org/)
[![Cargo Workspace](https://img.shields.io/badge/workspace-monorepo-brightgreen)](./Cargo.toml)

**Amos** is an AI-first mobile OS built as a single Cargo Workspace. It unifies a
long-lived native AI CLI daemon (`amos-ai`) with a Tauri 2 System UI
(`amos-tauri`), connected over a local **Unix Domain Socket (UDS)** via
**gRPC (tonic)** for low-latency, streamed token delivery.

> ⚠️ **非审定软件 (not safety-critical / not certified).** Amos is a research /
> prototype OS. Although the code is developed with safety-critical engineering
> discipline (see `docs/AEROSPACE_SOFTWARE_AUDIT.md` and
> `docs/TRACEABILITY_MATRIX.md`), it is **not** qualified to DO-178C or any
> aviation/mission-safety standard and must not be used to control
> flight/medical/DAL-A systems.

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
    ├── amos-audio/               # hardware audio-HAL abstraction: capture/playback traits + resample + mocks + gated TinyALSA/AAudio FFI seams (docs/audio-hal-bridge.md)
    ├── amos-ai/                  # AI CLI daemon (gRPC *server* over UDS)
    ├── amos-wm/                  # window-manager state machine (multi-window)
    ├── amos-android/             # Waydroid/APK compat (gRPC + icon extraction)
    ├── amos-appstore/            # app-store core: catalog/Version + sha256 integrity + install engine (docs/appstore.md)
    ├── amos-timesync/            # network wall-clock calibration (TimeSource seam + SyncedClock + periodic timekeeper)
    ├── amos-timesync-cli/        # query/sync the calibrated clock (now/status/sync over the shared state file)
    ├── amos-telephony/           # telephony domain core + gRPC service: Number/EmergencyMap, CallSession state machine, TelephonyProvider seams + Mock (docs/telephony.md)
    ├── amos-radio/               # radio/connectivity domain core: wifi/bluetooth/airplane state + RadioProvider seams (Mock / android JNI) + RadioManager airplane policy (docs/radio.md)
    ├── amos-sensor/              # device-sensor domain core: camera / GPS-GNSS / IMU spec types + SensorProvider seam (Mock / Android `android`-gated: GNSS real via LocationManager) + energy-policy SensorManager (docs/sensors.md)
    ├── amos-profiling/           # inference performance & power-profiling domain core: prompt/decode tokens-per-second + TTFT + per-token latency, PowerSource seam (Mock / Android `android`-gated battery) + energy estimate (docs/profiling.md)
    ├── amos-power/               # energy-governor domain core: folds battery/thermal/live-power/foreground-background into a SensorMode decision + applies it to SensorManager (docs/power-policy.md)
    ├── amos-applife/             # app/process lifecycle domain core: per-app foreground/background/tombstone states + LRU + memory-pressure reclaim (LMK-proxy) (docs/app-lifecycle.md)
    ├── amos-scheduler/           # background-task scheduler + wakeup-alignment domain core: AlarmExact vs Deferred jobs, Doze/charging/maintenance-window gating + coalesced due-batching + next-wake (docs/scheduler.md)
    └── amos-tauri/               # Tauri 2 System UI (gRPC *client* bridge)
```

The `.proto` file is the single truth: editing it regenerates Rust on **both**
sides on the next `cargo build`, so the wire contract can never drift.

## Build & run

```bash
# Production-style boot: start the backends the UI needs, honoring the persisted
# AI-provider choice (last selection survives restart). amos-ai resumes the saved
# local/cloud backend; translate starts (mock unless env overridden).
scripts/run-backends.sh

# Then launch the System UI (desktop dev build, embedded UI, no fixed port)
cargo run -p amos-tauri
```

> Use the **embedded (release)** UI: the *debug* binary loads `build.devUrl`
> (`http://localhost:1420`), which can collide with another app. To view **this**
> project's UI reliably, run `make run-ui-release` (builds release, embeds dist,
> binds no port).

Manual (two terminals):

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

## Backend operations (ops cheatsheet)

Single-command controls for the local ↔ cloud (DeepSeek) inference + translate backends:

```bash
# One-click switch AI backend and persist the choice (0600 key file on cloud).
scripts/ai-backend.sh local                          # real local Ollama (auto model); mock only if offline
scripts/ai-backend.sh mock                           # force deterministic mock (dev/offline)
scripts/ai-backend.sh ollama                         # force the real local Ollama engine
scripts/ai-backend.sh deepseek "$AMOS_API_KEY"       # DeepSeek cloud (api)
scripts/ai-backend.sh                                # resume last persisted choice

# Start the backends the UI needs (honors persisted choice); optionally gate on
# RPC readiness.
scripts/run-backends.sh
scripts/run-backends.sh --health

# Run amos-ai + amos-translate under amos-supervisor (crash auto-restart,
# SIGUSR1 hot-restart, graceful stop). Dry-run print the generated spec first.
scripts/supervise-backends.sh --print-config
scripts/supervise-backends.sh

# RPC readiness probe: both daemons must answer get_status running=true.
make health

# Honesty smoke: prove get_status truthfully reports the active engine/degraded
# state (mock=not-degraded; requested-but-unreachable real engine=degraded; ollama
# follows reachability). No GUI / no device.
make honesty-smoke

# Secrets: cloud keys are stored (0600) at ~/.amos/ai.key, never in the UI store
# or repo. Provide new keys via AMOS_API_KEY / the switch command; rotate leaked
# keys at the provider console.
```

Live smoke (connect to a *running* daemon and exercise the real RPC):

```bash
cargo run -p amos-ai --example chat_once -- /tmp/amos-ai.sock "你好"
cargo run -p amos-translate --example translate_once -- /tmp/amos-translate.sock "Hello" en zh
cargo run -p amos-ai --example status_once -- /tmp/amos-ai.sock
```

Logs: `/tmp/amos-ai-daemon.log`, `/tmp/amos-translate.log`, `/tmp/amos-ui.log`.

Release build for the whole OS stack (CLI + UI in one go):

```bash
cargo build --release
```

## Inference backend

The daemon routes generation through a pluggable backend selected by `AMOS_BACKEND`:

```bash
# Mock (dev/test default) — deterministic, no network. The *runtime* default
# (scripts/run-backends.sh / ai-backend.sh local) prefers a real local Ollama.
AMOS_BACKEND=mock cargo run -p amos-ai

# Real external API (OpenAI-compatible, streaming over SSE)
AMOS_BACKEND=api \
  AMOS_API_KEY=sk-... \
  AMOS_API_ENDPOINT=https://api.openai.com/v1/chat/completions \
  AMOS_MODEL=gpt-4o-mini \
  cargo run -p amos-ai

# Local Ollama (any pulled model) — keyless, streaming, function-calling ready.
# Omit AMOS_MODEL to auto-select the first *chat* model Ollama reports installed
# (embedding models are skipped). Add AMOS_OLLAMA_API_KEY if your Ollama /v1 is
# token-gated.
AMOS_BACKEND=ollama \
  AMOS_OLLAMA_HOST=http://localhost:11434 \
  cargo run -p amos-ai

# Hermes-Rust agent (which itself calls Ollama) — real token streaming + tools
AMOS_BACKEND=hermes \
  AMOS_HERMES_ENDPOINT=http://127.0.0.1:11438 \
  AMOS_MODEL=hermes-rust \
  cargo run -p amos-ai

# Local GGML (llama.cpp) — binding not wired yet; falls back to mock
AMOS_BACKEND=ggml AMOS_MODEL_PATH=/path/to/model.gguf cargo run -p amos-ai
```

When an explicitly-requested real backend (`api`/`ollama`/`hermes`/`ggml`) cannot
initialise (unreachable server, missing model, bad key), the daemon logs an
**error** and serves the deterministic mock so the System UI and health probes
stay up — it never silently pretends mock output is real inference. `mock` is a
dev/test default only; the runtime boot path (`run-backends.sh`, `ai-backend.sh
local`, `supervise-backends.sh`) prefers a real local Ollama and uses mock only
as the offline/dev fallback.

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
included: calculator, clock, **notes** (iOS-style list rows — bold title +
preview snippet + relative time, checklist & pin markers, expand/collapse),
**提醒事项 Reminders** (smart lists 全部/今天/计划/旗标/已完成, colour-coded
custom lists, per-list 已完成 group, in-app search, OS-level due-time
notifications on any screen), **语音备忘录 Voice Memos** (record/play/rename/
delete with live clock; recorded audio stored as a **binary Blob** in IndexedDB —
codec-compressed, no base64 inflation), messages, settings (persisted), photos,
dialer (real calls: dial → talk → **record** → hang up, plus an incoming-call
surface), music player, weather, maps, files, camera, android, AI, 同传, and an
**App Store** (`store` — browse the catalog and install/update/uninstall apps,
see `docs/appstore.md`).

A few first-party apps (Reminders ✅-style, Voice Memos, Notes) render **bespoke
Apple-inspired tile icons** (`AppIcon.tsx` `isBespokeTile`) instead of the generic
emoji-on-gradient tile; every other app keeps the uniform tonal face.

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

## Recent additions (2026-09-04)

- **Call recording — first-class, contractual (`crates/amos-telephony` + `proto/telephony.proto` + `amos-tauri` + `frontend-ts`)**: per-call `RecordingState{Off,On,Failed}` domain state machine; `TelephonyProvider::start/stop_recording` allow/deny consent seam with a **hard no-record rule for emergency (110/112/911…) lines**; wire `StartRecording`/`StopRecording` RPCs, `CallSnapshot.recording`, Tauri `telephony_start/stop_recording`, and a record toggle + live "正在录音" indicator in `PhoneApp`. `Call`-state recording is broadcast on `Watch`, so every surface stays consistent.
- **Phone calls — real end-to-end loop (dial → talk → record → hang up) + incoming surface**: `amos-ai` mounts a demo `TelephonyService` that auto-connects dialed calls; a `Watch`→`telephony-event` bridge streams every transition (connect / record / local+remote end) to the WebView; `PhoneApp` shows a talking screen when its call connects; a system **`IncomingCall`** overlay offers Answer/Decline then a recordable in-call banner. A **模拟来电** demo trigger (`SimulateIncoming`) exercises the incoming path by hand. See `docs/telephony.md`.
- **Radio / connectivity**: quick-settings Wi‑Fi / Bluetooth / Airplane now go through a real policy layer — `crates/amos-radio` (`RadioManager` airplane cascade + guard, `MockRadioProvider`; Android `AndroidRadioProvider` behind the `android` feature, wired into `amos-tauri` via `RadioBridge::from_android`) — persisted `amos.settings`, status-bar indicators, and `scripts/build-android.sh` cross-compiles `amos-radio --features android`. See `docs/radio.md`.
- **Phone contacts / 通讯录 + call history**: a `contacts` app (👥) with `lib/contacts.ts` (validation, favorites, search by name/number, duplicate guard incl. `+CC`/bare, first-letter groups, colored avatars, number→name lookup) and `lib/calllog.ts` (recent/frequent outgoing calls). Successful bridged calls are recorded, raise a phone notification, and surface "Frequent ⭐"/"Recent" quick-dial strips.
- **Notifications & Do-Not-Disturb**: arrival banner (`NotificationBanner`, tap-to-acknowledge), ring/vibrate sound policy (`lib/sound.ts`) with Web-Audio chime + `navigator.vibrate`, DND that hides badges/banners, live unread bell/dock badges, and a reactive cross-window store (`useStoreValue` + authoritative `store-updated`).
- **提醒事项 Reminders + Voice Memos + Notes iOS alignment (`frontend-ts`)**: three first-party apps/refinements benchmarked against iOS — a full **Reminders** app (smart lists, colour-coded custom lists, per-list 已完成, in-app search, one-tap complete-all, past-due snooze, plus an **OS-wide due-time notifier** mounted in the Shell that fires once per reached reminder on any screen using idempotent persisted `amos.reminderFired` markers); a **Voice Memos** recorder whose audio is stored as a **binary Blob** in a MediaStore (IndexedDB in the shell, in-memory fallback) — codec-compressed (Opus), no base64 inflation — with real IndexedDB (`fake-indexeddb`) and end-to-end `fake-mic → recorder → store → read-back` tests; and **Notes** given iOS-style list rows (title + preview + relative time, checklist/pin markers, expand/collapse). Reminders / Voice Memos / Notes also get **bespoke Apple-inspired tile icons** (`AppIcon.isBespokeTile`).
- **Notes iOS-style list (`frontend-ts`)**: pure helpers `noteTitle/notePreview/noteDayOf`; plain notes collapse to a title + snippet row and expand on tap (with a 收起 toggle); checklist notes stay expanded for quick ticking.

All new domain libs are pure + unit-tested (contacts/calllog at 100% function coverage) with DOM interaction tests; i18n en/zh key-sets are auto-validated.

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
- [docs/android-compat.md](./docs/android-compat.md) — Waydroid/APK compatibility (dev/prototype; product = no-UI Android base)
- [docs/appstore.md](./docs/appstore.md) — App-store core: catalog/package JSON publish contract + download→verify→install (developer onboarding)
- [docs/telephony.md](./docs/telephony.md) — Telephony: design + contract (dialer, EmergencyMap/110-112 hard path, TelephonyProvider seams)
- [docs/radio.md](./docs/radio.md) — Radio/connectivity: wifi/bluetooth/airplane state, RadioManager airplane policy + cascade, provider seams (Mock / Android JNI) & System UI bridge
- [docs/sensors.md](./docs/sensors.md) — Device sensors/multimedia domain core: `amos-sensor` camera / GPS-GNSS / IMU spec types + SensorProvider seam + energy-policy SensorManager (real HAL + service-bus wiring left as seams)
- [docs/profiling.md](./docs/profiling.md) — Inference performance & power profiling domain core: `amos-profiling` prompt/decode tokens-per-second, TTFT, per-token latency, PowerSource seam + energy estimate (daemon assembly + power HAL left as seams)
- [docs/bidi-voice-asr.md](./docs/bidi-voice-asr.md) — AI-assistant voice wiring: bidi `Payload::Audio` → local ASR (design)
- [docs/audio-hal-bridge.md](./docs/audio-hal-bridge.md) — Hardware audio (Audio HAL Bridge): `amos-audio` capture/playback traits + resample + mocks + gated TinyALSA/AAudio seams; bidi real-sherpa ASR (`asr-sherpa` feature)
- [docs/device-poc.md](./docs/device-poc.md) — On-device POC: cross-compile `amos-ai` + run `chat_once` over UDS on a real phone
- [docs/no-ui-android.md](./docs/no-ui-android.md) — no-UI Android base: init.rc orchestration, `--ai-voice` sherpa cross-build + model push, and a pasteable on-device AI POC acceptance sequence
- [docs/external-analysis-review.md](./docs/external-analysis-review.md) — Audit of an external gap analysis against the real tree
- [docs/device-bring-up.md](./docs/device-bring-up.md) — 真机 bring-up 行动件：energy/applife/scheduler 三块 Android 接线的接线点、复用 seam、验收判据，与"daemon 托管生命周期"(可选 gRPC Governor 服务) 路线
- [docs/qcom-mtk-bringup.md](./docs/qcom-mtk-bringup.md) — QCOM/MTK 真机落地骨架：`amos-ai::accelerator` 芯片/加速器画像 seam、`AMOS_GGML_STRICT` 诚实本地引擎、AAudio→sherpa 语音闭环接线点与验收判据
- [docs/DELIVERY_NOTES_2026-09-03.md](./docs/DELIVERY_NOTES_2026-09-03.md) — Commit message + changeset + known limits for the telephony/voice/strategy work (2026-09-03)

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

- [x] GPU/NPU inference — accelerator domain (`amos-ai::accelerator`: SoC vendor detection + `AMOS_ACCEL` resolution → NNAPI/Vulkan/Metal/QNN/NeuroPilot, feature-gated) + honest `AMOS_GGML_STRICT` local-engine mode landed (2026-09-04, `docs/qcom-mtk-bringup.md`); real on-device NPU/GPU drivers still a Qualcomm/MediaTek device bring-up task
- [x] Voice input — AAudio/TinyALSA HAL seams + real local sherpa ASR (`asr-sherpa`) + bidi `Payload::Audio` + resident capture wiring landed (`docs/audio-hal-bridge.md`); device AAudio capture thread feeding the assistant remains the on-device bring-up step
- [ ] Full voice input on-device acceptance (microphone → ASR on real Qualcomm/MediaTek silicon)
- [ ] Multi-window desktop OS features
- [ ] Mobile platform optimization (iOS/Android)
- [ ] Extended device API access — domain core + gRPC `SensorService` wired into the daemon UDS + System UI desktop bridge (`sensor_snapshot`/`set_mode`/`acquire` + `lib/sensors.ts`); feature-gated Android skeleton landed (GNSS real via `LocationManager`); device bring-up: camera-frame/IMU stream bridges + System UI real-`Context` wiring (`docs/sensors.md`)
- [ ] Performance profiling and optimization — metric kernel wired into the daemon's `stream_chat` + bidi `Chat` decode paths, exposed on `get_status.profile`, on the periodic heartbeat log, and rendered in the Settings diagnostics area; battery `PowerSource` Android skeleton landed; device/UI follow-ons: live `EXTRA_VOLTAGE`→`est_energy_j` + sensor tile (`docs/profiling.md`)

## Support

For issues, feature requests, or questions:
- 📖 Check [existing issues](https://github.com/arksong/amos/issues)
- 🐛 [Report a bug](https://github.com/arksong/amos/issues/new?template=bug_report.md)
- ✨ [Request a feature](https://github.com/arksong/amos/issues/new?template=feature_request.md)
- 🔒 For security issues, see [SECURITY.md](./SECURITY.md)
- 📧 Contact: arksong2018@gmail.com
