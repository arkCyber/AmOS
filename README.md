# Amos — AI-First Mobile OS

[![CI](https://github.com/arkCyber/AmOS/actions/workflows/ci.yml/badge.svg)](https://github.com/arkCyber/AmOS/actions/workflows/ci.yml)
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
        │
        └── mounts the AmOS-Link control plane (RobotLink, `amos-link`)
```

The same daemon also hosts **[AmOS-Link](#robot-link-amos-link)** —
the ROS-class robot middleware (`amos-link` + `amos-link-cli`): a pub/sub bus that carries a
robot's sensor frames and motor commands across boards, plus the gRPC **control plane** the
System UI and the CLI read it through.

## Workspace topology

```
.
├── Cargo.toml                    # workspace root (shared deps + profiles)
├── proto/
│   ├── ai_agent.proto            # the AI shell's contract (StreamChat / Chat / GetStatus)
│   ├── robot_link.proto          # AmOS-Link control plane (RobotLink: 5 RPCs)
│   └── …                         # android_compat · sensor · telephony · translate · governor · privacy
├── docs/
│   ├── ARCHITECTURE.md             # system overview (layers, crates, contracts)
│   ├── multi-window.md           # multi-window (真·OS 阶段) architecture
│   ├── android-compat.md         # Waydroid APK-compat layer
│   ├── amos-link.md                # AmOS-Link robot middleware: layers, Zenoh audit, control plane, non-goals
│   ├── robot-apps.md              # the robot application cases: topology, topic/QoS contract, asserted properties
│   └── robot-domains.md          # platform profiles: the six machines, their actuators, vocabulary, safety envelopes
└── crates/
    ├── amos-proto/               # tonic-generated types + socket-path helper
    ├── amos-audio/               # hardware audio-HAL abstraction: capture/playback traits + resample + mocks + gated TinyALSA/AAudio FFI seams (docs/audio-hal-bridge.md)
    ├── amos-ai/                  # AI CLI daemon (gRPC *server* over UDS)
    ├── amos-wm/                  # window-manager state machine (multi-window)
    ├── amos-android/             # Waydroid/APK compat: container launch/install + icon extraction over the gRPC AndroidManager (docs/android-compat.md · docs/fdroid-audit.md)
    ├── amos-appstore/            # app-store core: catalog/Version + sha256 integrity + install engine + F-Droid repo compatibility (read index-v1.json / publish as F-Droid) (docs/appstore.md · docs/fdroid-audit.md)
    ├── amos-appstore-cli/        # drive the store from the terminal: catalog/view/install/update/uninstall + F-Droid `--repo` browse/search, `download` (atomic, sha256-verified, never pretends to install)
    ├── amos-timesync/            # network wall-clock calibration (TimeSource seam + SyncedClock + periodic timekeeper)
    ├── amos-timesync-cli/        # query/sync the calibrated clock (now/status/sync over the shared state file)
    ├── amos-telephony/           # telephony domain core + gRPC service: Number/EmergencyMap, CallSession state machine, TelephonyProvider seams + Mock (docs/telephony.md)
    ├── amos-radio/               # radio/connectivity domain core: wifi/bluetooth/airplane state + RadioProvider seams (Mock / android JNI) + RadioManager airplane policy (docs/radio.md)
    ├── amos-sensor/              # device-sensor domain core: camera / GPS-GNSS / IMU spec types + SensorProvider seam (Mock / Android `android`-gated: GNSS real via LocationManager) + energy-policy SensorManager (docs/sensors.md)
    ├── amos-profiling/           # inference performance & power-profiling domain core: prompt/decode tokens-per-second + TTFT + per-token latency, real power model `BatterySample` (µA×mV) + `mean_power_mw` window averaging, PowerSource seam (Mock / Android `android`-gated battery: live `CURRENT_NOW` × self-refreshed `EXTRA_VOLTAGE`) → honest `est_energy_j` (docs/profiling.md)
    ├── amos-power/               # energy-governor domain core: folds battery/thermal/live-power/foreground-background into a SensorMode decision + applies it to SensorManager; CPU/NPU frequency domain (`FreqPlan`, protects the little cluster) + dedup `FrequencyGovernor` + Linux `scaling_max_freq` cap/restore applier (`feature linux`) (docs/power-policy.md)
    ├── amos-applife/             # app/process lifecycle domain core: per-app foreground/background/tombstone states + LRU + memory-pressure reclaim (LMK-proxy) (docs/app-lifecycle.md)
    ├── amos-scheduler/           # background-task scheduler + wakeup-alignment domain core: AlarmExact vs Deferred jobs, Doze/charging/maintenance-window gating + coalesced due-batching + next-wake (docs/scheduler.md)
    ├── amos-monitor/             # system working-status (health) domain core: folds SystemSampler load (CPU/mem) + amos-profiling battery/power + amos-applife process counts into one honest SystemHealth (real /proc `linux` sampler, `android` skeleton) (docs/system-monitor.md)
    ├── amos-display/             # display-protection / auto screen-off domain core: deterministic ScreenState + IdlePolicy (battery vs charging timeouts, hold-while-call) + the AMOS_SCREEN_STATE_PATH file contract the daemon energy beat and the System UI host share (docs/display-idle.md)
    ├── amos-media/               # media / external-storage domain core: spec types for the standard Android collections (DCIM/Camera, Pictures, Download, Recordings…), a pluggable MediaProvider seam (deterministic Mock today; Android MediaStore via Kotlin glue + optional HostFsProvider raw read_dir for root/Waydroid later) + a permission-policy MediaManager (nothing readable/writable until granted) + a cross-compilable `scan_dir` DCIM-scan example (docs/media.md · docs/android-storage-unify.md)
    ├── amos-sms/                 # SMS domain core: threads/messages/folders (inbox/sent/draft), validate (normalize + bounded segments), pluggable SmsProvider seam (Mock / Android `android`-gated SmsGlue reading content://sms + SmsManager send), push-receive events (docs/sms.md)
    ├── amos-blocklist/           # spam-blocking rule core: exact/prefix rules per channel (call/sms/both), number equivalence (+CC / leading-0), unknown-number toggle, cap-500 LRU + JSON persistence shared by the SMS filter and the Android CallScreeningService (docs/sms.md §11)
    ├── amos-devocare/           # device-care (手机管家) domain core: junk scan→analyze→plan→execute (uri-dedup, review-only needs acknowledgement) with a CleanProvider seam + root-confined `hostfs` backend (bounded depth, no symlink follow, user media never matched), UninstallGuard (system + pinned-critical refusals), read-only sensitive-permission review, and a folded CareReport where unknown areas stay unassessed (docs/devcare.md)
    ├── amos-link/               # AmOS-Link robot middleware (ROS-class): key-expression topics + `*`/`**` with channel-implied QoS profiles, bincode `Envelope` frames with CRC32 + a 16 MiB frame ceiling, ROS-like QoS (best-effort latest-wins vs reliable back-pressure, counted as `blocked`), in-process Broker transport + optional Zenoh inter-board transport (`zenoh`), bus federation + CRC-checked UDP-beacon discovery (`lan`, with a repeating announcer so a peer that joins the LAN later still learns one that booted earlier) with static peers that never TTL-expire, heartbeats/NodeStatus + per-publisher sequence-gap accounting, a JSON→motor-frame robot HAL with validated frame/joint invariants, a latched e-stop + deadman watchdog, and a tonic control plane mounted by the daemon (docs/amos-link.md)
    ├── amos-link-cli/           # robot-middleware CLI: status / topics / pub / sub / bench / discover (mock|bus|lan) / watch / motor over one in-process node, or `--socket <path>` to read a *running* daemon's control plane (status/topics/pub/watch; process-level smoke in tests/cli_smoke.rs)
    ├── amos-robot/              # autonomy stack above the link: a Mahony 6-DOF attitude estimator that reports `GyroOnly{reason}` when gravity is unreadable and keeps yaw `DeadReckoned` until a heading is actually given; grid A* + line-of-sight smoothing + `Grid::inflated` (for the footprint a planner cannot know) + pure pursuit emitting the *profile's own* set points (`Actuator::check` / `Platform::plan`); and a control loop whose cadence is **measured** (lateness vs overruns, bounded percentile window, `Unknown` before the second tick) (docs/robot-autonomy.md)
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
>
> **To actually *see* the window** (macOS): `make app-open` — it builds the `.app`
> bundle (embedding `dist`, freshness-checked first) and opens it. A **bare**
> `cargo build` binary is not an app bundle, so macOS will not activate it: the window
> is on screen but sits behind whatever is in front, and the host can only `warn!`
> about it (`the platform did not hand focus to the shell window …` — REQ-A232). The
> `.app` is the form the OS will bring forward.
>
> That path embeds `frontend-ts/dist`, and `tauri.conf.json`'s `beforeBuildCommand`
> is **empty** — so the bundle must be rebuilt by hand whenever `frontend-ts/src`
> changes: `make frontend-dist` (then `make frontend-fresh` says whether it is
> current). `scripts/run-ui-release.sh` and `make app-open` both run that check and
> refuse to build a stale UI (REQ-A228). The debug path (`make run-ui-dev`, `make dev`)
> loads the Vite dev server, so it always shows your sources and needs neither step.

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

Single-command controls for the local (Ollama) ↔ cloud (OpenAI-compatible:
DeepSeek / OpenAI / custom endpoint) inference + translate backends:

```bash
# One-click switch AI backend and persist the choice (0600 key file on cloud).
scripts/ai-backend.sh local                          # real local Ollama (auto model); mock only if offline
scripts/ai-backend.sh mock                           # force deterministic mock (dev/offline)
scripts/ai-backend.sh ollama                         # force the real local Ollama engine
scripts/ai-backend.sh deepseek "$AMOS_API_KEY"       # DeepSeek cloud (api)
scripts/ai-backend.sh openai  "$AMOS_API_KEY"        # OpenAI cloud preset (gpt-4o-mini)
scripts/ai-backend.sh custom  "$AMOS_API_KEY"        # any OpenAI-compatible endpoint
#   (custom: set AMOS_API_ENDPOINT to the full .../v1/chat/completions URL + AMOS_MODEL)
scripts/ai-backend.sh anthropic "$ANTHROPIC_KEY"     # Claude (native Anthropic Messages)
scripts/ai-backend.sh gemini    "$GEMINI_KEY"        # Google Gemini (native)
scripts/ai-backend.sh                                # resume last persisted choice

# Start the backends the UI needs (honors persisted choice); optionally gate on
# RPC readiness.
scripts/run-backends.sh
scripts/run-backends.sh --health

# Run amos-ai + amos-translate under amos-supervisor (crash auto-restart,
# SIGUSR1 hot-restart, graceful stop) — also `make supervise`. `ARGS=--print-config`
# prints the generated supervisor spec first (nothing is started).
scripts/supervise-backends.sh --print-config
scripts/supervise-backends.sh
make supervise ARGS=--print-config

# One-command desktop dev loop (daemon + System UI; starts the frontend dev server
# the debug binary loads from `devUrl` if it is not already up).
make dev

# GUI smoke for the 同传 app (needs a display): `make gui-smoke` runs it, and
# `make gui-smoke-check` is the headless readiness probe (display check + build).
make gui-smoke-check

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

## Robot link (AmOS-Link)

`crates/amos-link` is the middleware that connects a robot's parts — a stereo pair and an IMU on
one board, a model server on a Mac mini, a control laptop joining over Wi-Fi/5G — **without ROS**.
`crates/amos-link-cli` drives the same kernel from a terminal, and the daemon mounts its
**control plane** (`amos-ai/src/server.rs` → `proto/robot_link.proto`), so the CLI and the System UI
can ask a *running* node what it sees on the link.

| piece | what it does |
|---|---|
| keys | `amos/<peer>/<channel>/<name>` + `*` / `**` (`keyexpr`) — an **iterative DP** matcher, no recursion and (since the last hardening round) **no allocation on the publish hot path**, bounded at 32 segments; a naive backtracking matcher used to hang the broker's registry lock, and a repo-wide `rust-recursion-scan` gate now guards that class |
| framing | `magic │ version │ bincode header │ CRC32 │ payload` with a 16 MiB ceiling checked on **both** sides *before* any allocation; the CRC streams over header ‖ payload, so a frame is never copied twice (a `concat()` used to double a frame's peak memory, on the receive path *before* the checksum was verified) |
| transport | in-process `Broker` (`Arc` fan-out, never awaits while holding the lock) + optional **Zenoh** across boards (`--features zenoh`) |
| QoS | `Reliability{BestEffort,Reliable} × depth × DropPolicy` from **one strategy table per channel**: sensor streams are latest-wins, control streams back-press and are counted as `blocked` — never silently dropped |
| discovery | beacons over the link's own transport (works on **any** transport, incl. Zenoh) + real UDP multicast behind `--features lan`, announcing repeatedly so a peer that joins later still learns one that booted earlier; a node is **never its own peer** (self-echoes are refused and **counted**, not filtered away silently). On a multi-NIC board the channel is **pinned to one interface** (`AMOS_LINK_BEACON_IFACE` — outgoing datagram *and* group join), because "the kernel picks one" is how a beacon leaves through the 5G modem while the camera board listens on Wi-Fi |
| health | `published`/`delivered`/`dropped`/`blocked`/`decode_errors` are measured, never estimates; `LinkHealth` folds them into `Unknown \| Healthy \| Degraded{reasons}` — `Unknown` means *no evidence yet* and is deliberately not the same as "healthy". Bookkeeping that is keyed by wire-supplied strings is **bounded and says when it stops**: the topic inventory (`topics_complete()`) and the per-publisher sequence tracker (`SeqEvent::Untracked`, `is_complete()`) both refuse to grow without end, because their keys can otherwise be minted per frame by a peer. A verdict is never cleaner than the instrument behind it: a tracker that refused frames reports `untracked_frames=N` rather than letting a partial loss figure read as `healthy` |
| robot HAL | an agent's JSON intent → a validated gait pose → CRC16-checked motor frames, with a latched e-stop and a deadman watchdog whose torque cut is reported as a **measured** frame count (it used to be assumed as "one frame per joint"). `MockRobotHal` is for tests; **`StreamRobotHal` writes the same frames to a real descriptor** — a controller's Unix socket or a serial/UART device — with the whole batch validated *before* the first byte, and `armed()` folded from the ops in wire order (it used to be an order-blind "was there an Enable anywhere in the batch?", which could report a re-armed robot as dead) |
| return path | a policy can report its own mode on `amos/<robot>/state/actuation` (armed / e-stopped + why / gait / last refusal) — published on change **and** replayed periodically, so the very peer whose link died sees the watchdog stop, and a late-joining brain still learns a steady gait. The report comes from **another peer**, so it validates on decode: a frame count, deadman period or refusal reason outside its bound is refused (and counted as a decode error), never stored, rendered, or silently truncated into a `u32` on the way to the UI |

```bash
# One process, no network: the robot↔brain loop (stereo out, control back, motor frames applied).
cargo run -p amos-link --example robot_brain_loop

# The robot application cases (docs/robot-apps.md): one patrol end to end, a three-robot
# console whose table is printed twice (which stream is moving, which one stopped), and a
# brain that is *not* on the link — the gRPC control plane over a Unix socket.
cargo run -p amos-link --example patrol_mission
cargo run -p amos-link --example fleet_console
cargo run -p amos-link --example remote_brain
cargo test -p amos-link --test robot_cases        # the cases' asserted properties (10)
# …and the platform profiles behind a fleet that is not all quadrupeds: a multirotor and a
# vehicle fly/drive on the same link, the same frame type and the same safety core.
cargo run -p amos-link --example uav_mission
cargo run -p amos-link --example road_autonomy
cargo test -p amos-link --test platform_cases     # 18 profile contracts (docs/robot-domains.md)

### The layer above it (`amos-robot`)

`crates/amos-robot` is what the middleware deliberately does not do: *which way am I pointing*,
*how do I get there*, and *is the loop holding its cadence*. An attitude estimator (Mahony 6-DOF)
that reports what it could not see (`GyroOnly{reason}` when gravity is unreadable, yaw
`DeadReckoned` until a heading is actually supplied, a stall past 250 ms refused instead of
bridged); grid A* with deterministic tie-breaking, a corner rule, line-of-sight smoothing and
`Grid::inflated` for the footprint a planner cannot know; pure pursuit whose aim point is measured
from the vehicle's projection onto the route and whose output **is** the profile's own set points
(validated with `Actuator::check`, planned with `Platform::plan`); and a control loop around
`RobotBridge` that **measures** its cadence (lateness vs overruns, a bounded percentile window that
says when it rolled, `Unknown` before the second tick). The closed-loop test found two real defects
on the way — a stateless aim point that aimed *behind* a vehicle which had driven past a waypoint,
and an arrival radius smaller than the machine's turning radius — both recorded in
[`docs/robot-autonomy.md`](docs/robot-autonomy.md). A second pass (REQ-A411) added the scanner-shaped
`Grid::from_occupancy`/`occupancy()` pair and fixed three numbers that lied: `Path::cost()` priced a
smoothed waypoint leg as one step (a 5-step route's simplification read *cheaper* than the route),
a restarted `ControlLoop` charged the loop for the idle gap between two paced runs, and `pursuit`
silently clamped an out-of-range speed limit instead of refusing it — all three now refuse to answer
rather than answer wrongly. A third pass (REQ-A495) wired the CAN driver's bounded re-transmission
(it existed as a documented constant with no loop): `apply` re-hands the batch only on a *transient*
`LinkError::Transport`, never on a refused `LinkError::Robot`, and no `RobotHal` implementation is
described as a skeleton any more. A fourth pass (REQ-A497) fixed a half-cell geometry defect the
coverage sweep turned up: `cell_centre` returned the cell's north-west *corner* under the name
"centre", so `clearance_mm` measured to an obstacle square offset half a cell — a point inside a
blocked cell read positive clearance (a second bug, `saturating_sub` on `i64` clamping at
`i64::MIN` instead of `0`, squared the negative gap back into a phantom distance). A fifth pass
(REQ-A503) fixed a promise the type system never allowed: the UDP drivers documented "wrap a
`tokio::net::UdpSocket`", but that socket implements neither `AsyncWrite` nor `AsyncRead`, so the
adapter had to be written by every deployment — it now ships as `UdpSink` (one `write` = one
datagram, so one frame is one datagram of exactly `FRAME_LEN` bytes), `UdpControlRobotHal` gained
the `bytes_written()` its serial/CAN siblings already had, and `UdpDiscoveryRobotHal`'s docs stopped
claiming a state-report path that does not exist (it is a refusal-only guard with a structurally
zero odometer). A sixth pass (REQ-A506) found the CAN driver stating its COB-ID/PDO mapping three
times in one file — three mutually incompatible answers, two of them not matching the CiA 301
document they cite (the real predefined set is `RPDO1 = 0x200 + node_id`, function nibble `4`), and
a "default" for `function_tx` that exists nowhere in the code. The mapping is now stated once, the
nibble is documented as the deployment's choice, `MAX_CAN_TX_RETRIES`'s false `// cited:` marker
became an honest `// chosen:`, and `from_motor_frame`'s never-covered `None` arm is documented as
unreachable-by-construction instead of faked with a test. A seventh pass (REQ-A509) went back into
`slam/`: the data-association inner loop took a `sqrt` per landmark per observation only to square
it straight back in the gate — the module's own docs said the `χ²` threshold is a *squared* form —
so `Landmark::mahalanobis_squared` is now the gated quantity and `mahalanobis` is defined on top of
it; and `AssocScratch`, documented as being "read when the gate verdict is recorded", was in fact
written after the loop from registers and then cleared before returning, so it is now a genuinely
readable caller-owned workspace (`best_distance`/`best_index`). The "never touches the allocator"
claim was true of the inner loop and false of the call — `associate` returns one `Vec` per call —
and now says so. An eighth pass (REQ-A511) went back over `slam/`'s remaining public surface: it
found the scan-match module citing a paper that does not exist (`Olson et al., "Closed-loop
performance", IROS 2005` — Olson's paper is the single-author *Real-Time Correlative Scan
Matching*, ICRA 2009), a one-sample search window that silently placed its only candidate a whole
`range` away from the pose the caller supplied, a `MAX_SCAN_OPERATIONS` comment whose arithmetic
called half a control tick "a small fraction" of one, and three `slam/` error enums with no
`Display` while every error type outside `slam/` has one.

A ninth pass (REQ-A514) moved the audit into `vision/`, which until then was exercised only through
its integration suite. The LK optical-flow module documents a hard rule against clamping ("never
invent an edge pixel and bias the flow") and then clamped the *gradient* stencil at the image's far
edge: `∂I/∂x` is a forward difference to `px + 1`, so where there is no such pixel the code
duplicated the last column into the gradient matrix. The only observable consequence was that a
window touching the boundary could come back `Singular` ("constant patch") when its real problem was
an incomplete window; the boundary guard now refuses one pixel early and the two `.min()` clamps are
gone. That fix then exposed something worse about the coverage itself: the module's *other*
documented refusal — a source window that fits but whose fractional target sample leaves the frame —
had been "covered" only by the very edge features the clamping bug let through, so that coverage was
evidence of the defect rather than of the branch, and it now has a real fixture (a 1.5-px shift at
`x = 2`). Two `// measured:` markers turned out to be unfalsifiable — the determinant-floor weight's
stated flat-vs-textured experiment accepts *any* weight in `(0, 0.1)`, eight orders of magnitude
wide, so it cannot have selected `1e-3`, and the eigenvalue-ratio floor's "sits between ~0 and
≫1e-3" is true of every value in that gap — so both became `// chosen:` with the value unchanged.
And `fast.rs`'s quick-rejection comment said "at least three must agree (the high-speed test)" while
the code implements the two-of-four *necessary* condition for a 9-arc — with the comment sixteen
lines below working out why three would wrongly drop real corners. The code was right; only the
comment was wrong.

A tenth pass (REQ-A516) finished `vision/` — `five_point.rs` (essential matrix + pose recovery) and
`vo.rs` (frame-to-frame glue). Two findings. First, `sampson_distance` ended in
`(num * num / denom) as f32` behind `#[allow(clippy::unnecessary_cast)]` whose comment claimed
"intermediate `f64` work … keeps a meaningful numerator" — but `Essential` is `[f32; 9]` and the two
correspondences are `(f32, f32)`, so every intermediate is already `f32` and the cast is a genuine
no-op (removing the `#[allow]` makes clippy report `unnecessary_cast` immediately). Second, and
worse, `recover_pose_from_essential` initialised its best-candidate slot to `(0, 0)` and replaced it
only on `in_front > best.1`, so when *no* `(R, t)` candidate put a single correspondence in front of
both cameras the function still returned `Some` — the untested `candidates[0]`, a fabricated motion
(a zero essential matrix returned `Some(Pose2D { …, inliers: 0, total: 8 })`). It now returns `None`
when the best cheirality count is zero, matching the "never a plausible-looking but meaningless
matrix" contract its sibling already states. The module doc also called Hartley *preconditioning*
"normalised by the intrinsics" and claimed the eight-point solver is the "equally accurate" one; it
now cites Hartley 1997 accurately — the eight-point algorithm is comparable to the best estimators
*once* the points are translated and scaled — and `Pose2D::inliers`'s doc admits the field carries a
cheirality count from one entry point and a Sampson inlier count from the other.

An eleventh pass (REQ-A520) read `planning.rs`'s dynamic-window (`dwa`) section line by line and
changed no behaviour at all — it is a documentation round. Its module doc counted "four `DWA_W_*`
constants" where there are three, linked a `[`score`]` that exists nowhere, told deployments to tune
the weights "in `DwaLimits`" (they are compile-time `const`s, not fields), gave the velocity pair's
units as `(m/s, rad/s)` when `DwaVelocity` is `v_mm_s`/`omega_mrad_s`, and claimed a log "still sees
the real gap" of an unsafe candidate — false, because unsafe candidates are never stored in `best`
and their clearance never leaves the function; the honest-boundaries list also called the route
"fixed input" when `dwa` receives no route at all. The three clearance/progress/speed weights had
been marked as if they came from Fox/Burgard/Thrun 1997, but that paper weights *clearance* by `β`,
not `α`, and states no numeric values, so they are re-marked `// chosen:` as this crate's own ratio.
Reading also turned up a check the crate had never run: `RUSTDOCFLAGS="-D warnings" cargo doc` fails
on six links — two to a `LinkError` not in `can.rs`'s scope and four from public docs to *private*
items (`MIN_MATCH_RATIO`, `MIN_COST_DROP`, `axis_offset`, `Self::index`) — none of which any of the
nine gates covers. The links are fixed (path completed or demoted to plain code) and `cargo doc` is
green; adding it to CI is recorded as a recommendation rather than done unilaterally.

A twelfth pass (REQ-A523) read the flagship `fusion.rs` (Mahony 6-DOF attitude + 9-axis
magnetometer + an Allan-variance gyro-health monitor), a module the README leads with but no round
had ever read line by line, and changed no production code. Three provenance markers did not hold:
a section comment named a `MagReference::Referenced` type that exists nowhere (the variant is
`YawReference::Magnetic`), `ALLAN_MIN_WINDOW` carried a `// cited:` with no citation (the statement
is a derivation from the Allan formula in `variance`'s own body), and `ALLAN_DEFAULT_NOMINAL_RAD_S`
carried a `// measured:` for a "typical MEMS-class gyro noise floor" this crate has no way to have
measured — `record` is fed whatever the caller supplies. `DEFAULT_KI` attributed "a `Kp:Ki` ratio
near 20 decouples the bias estimate" to Mahony/Hamel/Pflimlin 2008; that paper gives the bias
estimator and only the stability condition `Ki > 0`, with no numeric ratio (published
implementations use ~400), so the `20` — this crate's own `1.0/0.05` — is now `// chosen:`. And the
honest-boundaries list's `measured: 3.3°` yaw leak from a 25°/15° step reproduces only with
proportional-only gains: the default `Ki` gives 3.62°, so the figure now names its gains and a test
pins it. The new test's own metadata is the most useful result: three injected mutations — scaling
`Kp` by 0.9, zeroing the cross product's body-*z* term, and integrating a world-frame rate instead
of a body rate — all left it green (the last moved the figure only from 3.3267283° to
3.3267329°), because the leak is a geometric function of the converged attitude rather than of the
path. The test is therefore documented as **pinning the outcome, not a branch** — the negative
mutation result is recorded rather than hidden. One unreachable defensive arm
(`gravity_reference`'s `!norm.is_finite()`, shadowed by `update`'s finiteness gate) is documented
as unreachable instead of given a fabricated test.

A thirteenth pass (REQ-A527) read `mrac.rs` (Model-Reference Adaptive Control plus an
anti-windup PID), which had a dedicated integration suite but no dedicated round, and this one
**did** change production behaviour. The reference model was integrated as `ẋm = am·(xm − bm·r)`;
the standard form is `ẋm = am·xm + bm·r`, which is what makes the model *the plant at the matched
unknown* (`θ̂ = θ` ⇒ `u = r` ⇒ `ẋ = am·x + bm·r`) — the identity the cited Lyapunov argument
needs. The two forms agree **only at `am = −1`**. At any other pole the old form left a persistent
`−bm·r·(am+1)` in `ė`, so `V̇ ≤ 0` no longer held and `θ̂` settled at `θ + r·(am+1)/ω` instead of
the plant's true `θ` (probe: `θ = 0.5` at `am = −2` gave `θ̂ = −0.5`, at `am = −3` gave `−1.5`);
`e` still reached zero, because the adaptation absorbs the bias — which is why it went unseen.
Every unit and integration fixture used `am = −1.0`, also the constructor's fallback for an
invalid pole, so the one default value was the one point where the two forms coincide. The
integration line is fixed and the model's equilibrium is now documented as `−bm·r/am`; the change
is numerically identical at `am = −1`, so the 16 existing `mrac` tests did not move (mutation M1 —
reverting the line — turns exactly one test red, the new one). Three comments contradicted their
own fixtures: `Pid::new`'s doc claimed "`kp = 1.0`" though `kp` is the argument (another test
passes `0.0`), the `omega` field claimed to be "needed for the next step" though every `step`
takes its own `omega` and nothing in the algorithm reads the field, and a test comment said
"`am = bm = 1`" where the fixture writes `am = -1.0` (`am = +1` is rejected outright as an
unstable pole). The `p` field's "closed-form" is now named as this crate's `Q = bm²` choice
rather than a unique solution, and two `measured:` figures describing deleted code were demoted to
prose — they cannot be reproduced against the shipped implementation.

A fourteenth pass (REQ-A531) read `safety.rs` — the monitor that sits before the bus (a
heartbeat plus five independent rules `R1`..`R5`) and had a dedicated injection suite but no
dedicated round. This one changed no behaviour and added no test: every finding is a comment, a
provenance marker or a doc claim. `FaultCode`'s doc said "the discriminant is part of the wire
format", but the enum derives no `Serialize`/`Deserialize` and nothing in the workspace reads or
writes one — there is no wire format; the stable thing an operator greps is the `"R1"`..`"R5"`
*key*. `MAX_FAULT_LOG`'s doc justified its size with "an `Index` is `u8`", which is wrong twice:
256 does not fit a `u8`, and the module has no `u8` index at all (`fault_log` is a `VecDeque`,
its length a `usize`). Its "~2.5 s of cascading faults" holds only at one fault per tick, and
the module's *own* test records the cascade — `R3` and `R2` fire on the same tick — so 256
entries cover ~1.3 s. Four `DEFAULT_*` constants wore `// measured:` while this crate has never
measured a fault rate or a traction model; one of them,
`DEFAULT_MAX_DIVERGENCE_RAD`, said "chosen as" in the very sentence carrying the `measured:`
marker. That constant also cited "the SLAM frontend's own gate" — but `slam::data_assoc`'s gate
is a **squared-Mahalanobis** test on a landmark's *position* against the `χ²(2)` quantile and
carries no radian threshold, and the only `0.2 rad` in `slam/` is `loop_closure`'s scan-match
*search* half-extent, not a rejection gate. `MAX_DIVERGENCE_LIMIT_RAD`'s `// cited: an angle's
range is bounded by 2π (ISO 80000-3)` does not hold either: ISO 80000-3 defines the plane angle
(table 1, item 3-5, `α = s/r`) and the radian, it states no bound on an angle's range, and an
angle so defined is not bounded by 2π. `FaultCode::SanityFailed`'s doc listed "a non-finite set
point" among its triggers though `check_set_point` takes an `i32` — it cannot happen, and the
module's own rule table correctly omits it — so it is documented as unreachable rather than
given a fabricated test. And the module's opening line calls itself "the last layer before the
bus" while nothing in the crate calls the monitor; a new "What is not wired" section reads that
as intent, not as a description of a running pipeline.

A fifteenth pass (REQ-A534) read `control.rs` — one of the three modules the crate README leads
with, and the last never-audited one. It changed no production logic and added two tests, both of
which pin behaviour that already shipped. `CadenceHealth::Unknown`'s variant doc said "fewer than
two judged ticks", but `health()` tests `judged == 0`: after the second tick `judged == 1`, and an
on-time one already reads `Held`. The module table's "before the second tick", `health()`'s own
"`Unknown` until there is evidence" and the crate README's "fewer than two *ticks*" all match the
code; the variant doc was the lone outlier, and nothing pinned the boundary —
`the_second_tick_is_already_evidence_not_unknown` now does (mutation: `judged == 0` → `judged < 2`
turns exactly that test red). `CycleVerdict::late_by`'s field doc measured lateness from "the
period", though `record` subtracts `period + slack` — the neighbouring `on_time()` doc had it
right. And the module's opening paragraph presented `"the frequency is the caller's (50–100 Hz in
a real product)"` as a quotation from `docs/amos-link.md` §6; that section is Chinese, the English
string appears nowhere in the repository, so it is now labelled a translation with the source
sentence quoted. A second test, `a_hand_ticked_loop_judges_every_interval`, pins the contrast the
two entry points exist for — a paced run re-captures its predecessor, a hand tick does not — which
had been asserted only in prose; it counts `judged` rather than a wall-clock lateness, so the CI
machine cannot decide the verdict.

A sixteenth pass (REQ-A535) read `slam/ekf.rs` — the EKF-SLAM core, the largest file in `slam/`
and never audited on its own. Unlike the fifteenth, it did change behaviour: two inputs are now
refused. The create branch fed `initial_landmark_variance.sqrt()` to `Landmark::new`, which
computes `σ.max(0.0)²`; `f32::max` returns the non-NaN operand, so a negative variance (`sqrt` →
`NaN`) and a literal `NaN` both collapsed to `0.0` — a landmark of **zero** covariance, i.e.
"perfectly known", the opposite of the wide uninformative prior the field documents. The
`add_landmark` guard could not catch it, because by then the value was already the sanitised
`0.0`; the three new tests fail before the fix with `Ok(Created { landmark_index: 0 })`. A
non-finite or negative `gate_squared` is refused in the same block, since `d² ≤ gate` can never
hold (`d² ≥ 0`) and every observation would become a duplicate while the call still reported
`Ok`. `0.0` stays legal for both. Four doc defects went with it: `VelocityCommand` cited an
`amos_link::robot_hal::Gait` / `frame → motion` convention that exists nowhere in the workspace
(`Gait` is a gait *name* that expands to joint angles), `capacity()` called its row stride a
total cell count, the module boundary counted only the covariance against ~12 MiB of actual
`SlamState` (plus two scratch buffers), and `EkfSlam`'s doc claimed it "pins a `SlamControl`"
though no setter exists — that was left as a doc fix rather than re-adding a zero-caller API.

A seventeenth pass (REQ-A538) read `slam/occupancy.rs`, the log-odds grid mapper and the last
substantial never-audited `slam/` module. It changed no production logic: one real doc defect,
two wrong test comments, one garbled test name, four missing provenance markers, and one new
test. The defect was a self-contradiction — `with_origin`'s doc called the world origin the
millimetre position of cell `(0, 0)`'s **centre** while claiming, in the same sentence, that it
was "the same convention as `planning::Grid::with_origin` … so the two agree". The planner's
`with_origin` and `cell_centre` define that number as the north-west **corner** — "A corner, not
a centre" — so the two cannot both be true, and a caller who believed the centre reading and
handed the value to `Grid::with_origin(..)` would shift the whole map by half a cell
(`resolution / 2`), the same half-cell family as the round-7 `cell_centre`/`clearance_mm` fix.
Both doc sites now say corner; the mapper stores only the integer and never converts, so no code
changed. `the_origin_agrees_with_the_planners_corner_convention` reads the origin, passes it to
`Grid::with_origin`, and asserts `cell_centre((0, 0))` is half a cell in — the check fails if the
planner ever changes its convention (mutation: dropping the planner's half-cell offset turns it
red with `left: Some((1000, -2000))`; restored byte-identically). It cannot fail on a doc edit,
which is recorded honestly. The two comment fixes are threshold arithmetic: one test said its
cell was "still above the threshold (40/2 = 20)" when `+40` is *exactly* the `Occupied`
threshold (`OCCUPANCY_DEFAULT_HIT / 2`) and survives only because the comparison is inclusive; the
other said "two misses" where one already classifies the cell free, while its body called
`add_miss` three times.

An eighteenth pass (REQ-A540) read `vision/fast.rs`, the FAST-9 corner detector. Unlike the two
rounds before it this one changed behaviour, in two places. The defect: `Corner::x`/`y` are
`u16`, and `detect` did `x as u16` with no upper
bound on the image size, so a 70 000-wide frame would have its suppression scan reach
`x = 69 998` and truncate that coordinate mod 65 536 to `4 462` — a corner reported at the
*wrong* column, silently, the same family as the previous round's `ekf::observe` sanitisation.
The detector now refuses such an image up front (the real bound is `u16::MAX + 2`, since the last
two columns can never be a corner), and a test builds a 70 000 × 16 frame with a bright square at
`x ≈ 66 000` so that, absent the guard, a truncated corner would appear — deleting the guard
turns exactly that test red. Second, when non-maximum suppression was switched off the detector
still ran the whole 3×3 suppression pass and then threw it away to rebuild a raw list; the raw
branch now runs first, identical output, no wasted pass. On the documentation side, the default
threshold was said to come from a Rosten–Drummond "`t = 10 .. 20` working range" — the paper and
the reference implementation give a *default* of `t = 20`, not a range — so the claim is
withdrawn for a checkable `// cited:` of the default, and two unverifiable assertions ("every
aerospace-grade implementation I know of", "a 2-3× speedup") came out; `conservative`'s
"16-pixel arc" became the 9-of-16 arc it actually is, and `DEFAULT_FAST_MIN_SCORE`'s "one
threshold-step above" (30 is 1.5 × 20) became a plain statement of policy. Both new tests carry
measured negative controls (guard → `if false`; `<` → `<=`), each turning exactly one test red and
restored byte-identically.

A nineteenth pass (REQ-A543) read `vision/vo.rs`, the frame-to-frame VO glue and the last
never-audited `vision/` module. It changed no production logic. The defect was a promise the
constant's name made and the code did not keep: `MAX_TRACKED_FEATURES`'s doc called it "the
largest track set the glue holds between frames", but the cap is applied only to sets the glue
*generates* — `detect_corners` truncates its own detections and `replenish` stops at the cap,
while `track_frame_to_frame` takes the caller's `&mut Vec<(u16, u16)>` (and
`VisualTracker::set_features` takes a `Vec`) and tracks it verbatim. Hand in 300 features, keep
more than 128 of them tracked, and the glue holds 300 — so the bounded-work guarantee the
constant exists for (its own test calls it "the bounded-work guarantee for the whole frame
pipeline") is the caller's to keep, not the glue's. The doc now says exactly that, and the
round deliberately did *not* add a silent truncation, which would drop features the caller
explicitly asked to track. Three more docs claimed products that do not exist: `detect_corners`
advertised a "spatially-distributed" result that a score sort cannot give (spreading the set is
`replenish`'s spacing filter, and only on the refill path); the module's own honest-boundary
paragraph said the glue reports "the ratio of flow magnitudes" when no such quantity appears in
`VisualObservation` or `RansacReport`; and `MIN_TRACKED_FEATURES` said re-detection happens "in
the current frame" when it runs on the *target* frame. One guard, `VO_MIN_SAMPLES`, turned out
to be exactly redundant with `ransac_essential`'s own `a.len() < 8` — same `None` either way, so
no test can tell them apart and none pretends to. The new test — the round's only code change —
fills a frame with 361 weak corners and puts one saturated corner last in raster order, then
asserts it survives a 256-cap both through `detect_corners` directly and through the public
cold-start path; deleting the score sort turns exactly that test red.

```bash
cargo test -p amos-robot                     # 305 unit + 29 integration + 11 doc tests, offline
cargo run -p amos-robot --example patrol_loop  # plan → drive → estimate → tick → deadman
```


# The CLI: one in-process node, one command per operator question.
cargo run -p amos-link-cli -- status                              # identity · counters · peers · verdict
cargo run -p amos-link-cli -- bench --count 2000 --size 4096      # real publish→decode latency
cargo run -p amos-link-cli -- motor --action '{"action":"trot","speed":0.5}'   # 13 CRC16 motor frames
cargo run -p amos-link-cli -- motor --action '{"action":"stand"}' --device /run/motor.sock  # onto a real bus
cargo run -p amos-link-cli -- sub --pattern 'amos/**' --count 3 --timeout-ms 2000
cargo run -p amos-link-cli -- discover --lan --peer dog1 --seconds 9   # real UDP beacons (`--features lan`)
cargo run -p amos-link-cli -- state --timeout-ms 2000             # what the robots say about themselves
cargo run -p amos-link-cli -- topics --json                       # machine-readable: one document per result

# Remote mode: read a *running* daemon's control plane instead of a temporary local node.
cargo run -p amos-link-cli -- status --socket /tmp/amos-ai.sock
```

`status` / `topics` / `pub` / `watch` accept `--socket` and name the socket on every line, so a local
answer can never be mistaken for the robot's. Data-plane commands (`sub` / `bench` / `discover`) need a
local node and are **refused by name** when `--socket` is present rather than silently downgraded.
`status --socket` reads the **same document** a local `status` prints (plus `remote` and `actuations`):
the daemon's peer table crosses the wire as the same flat rows `discover --json` uses
(`id`/`kind`/`endpoint`/`last_seen_ms`/`beacons`), and the verdict is the same
`{"state", "reasons": ["decode_errors=3", …]}` object — one command, one shape, which it was not
before (`docs/amos-link.md` §3.11). A daemon that **predates** the return-path RPC is not a failed
command: everything it *did* answer still prints, and `actuations` is `null` ("not answered", never
`[]`, which would claim the fleet said nothing) — the same rule the Settings panel follows (§3.17).
Exit codes are part of the contract: `0` ok, `1` failure, `2` usage error — a window the platform clock
cannot represent, or a payload above the wire ceiling, is now refused at parse time (both used to
panic/abort the process). **Every** command takes `--json` (one document per result, one object per line
where the command streams — *every* line, header and summary included), and **no flag is silently
ignored**: a flag a command cannot act on —
`bench --pattern`, `sub --hz`, `motor --topic`, or `--peer` on a `--socket` run — is an exit-2 usage error
naming both, rather than an argument that quietly did nothing (`docs/amos-link.md` §3.10).

A node also says **where it can be reached**: `--endpoint tcp/10.0.0.7:7447` (or `$AMOS_LINK_ENDPOINT`)
is announced in its beacons by the commands that announce (`watch`, `discover --bus`/`--lan`), so the
peer table of every other node shows an address instead of nothing. The value is bounded exactly like
the beacon — at most 8 endpoints, 128 bytes each, and the whole frame must fit 512 bytes — and a value
that could never be emitted is refused **at startup**, because a node whose beacons cannot be encoded
is a node nobody can see (`docs/amos-link.md` §3.14).

| RPC (`proto/robot_link.proto`) | purpose |
|---|---|
| `GetStatus` | identity, uptime, clock-calibrated?, cumulative counters, the live peer table, and the daemon's **own** `health` verdict + reasons |
| `ListTopics` | the topic inventory the transport really saw (a network transport answers "unknown" instead of fabricating an empty list) |
| `Publish` | let a non-Rust node inject a payload — the daemon stamps its own peer id, independent sequence and calibrated clock, so typed subscribers still decode it |
| `StreamHeartbeats` | server-streaming heartbeat, forwarding the beats actually received on `amos/*/telemetry/beat` (the node's own included) — a beat is a *self-description*, so its payload `peer` must equal the frame's (validated) publisher or it is refused and counted: one frame, one identity |
| `ListActuations` | the return path folded into the control plane: each robot's armed / torque-cut(+reason) / gait / last refusal, attributed by frame publisher — a robot that never reported is **absent, not idle** |

The System UI reaches this plane over `crates/amos-tauri/src/link.rs`, in **two surfaces**: a
**read-only** one and a **command console**.

*The read-only one* is **Settings →「机器人链路 / Robot Link」**
(`frontend-ts/src/svelte/settings/LinkPage.svelte` over that bridge) and shows the
daemon's verdict, its reasons, cumulative counters, the live peer table (id · how to reach it, when
the beacon said) and the robots' self-reported modes. It is the panel with **no toggle** — it
observes. And the readout is **dated, not just refreshed**: every number is a
snapshot taken at a printed read time, the page re-reads every 10 s while it is open and visible,
and a re-read that gets no answer **drops the numbers** instead of leaving frozen ones on screen.

*The command console* is the **「机器人指挥台 / Robot console」** app (`RobotApp.svelte`, the 🦿
tile), the System UI's **write** side of the same plane: pick a robot, then send `arm` / `estop` /
a gait (`stand` / `trot` / `walk` / `sit`, with a speed slider) through the bridge's `link_publish`
to `amos/<robot>/control/action`. `estop` is a short-circuit action and is sent with **no
confirmation and no pre-check**. The console's one rule is the same everywhere in this file: a
publish receipt is **not** proof the command took effect (the transport's `matched`/`delivered`
count is what *this node* could see, and a network transport answers `0` = 「unknown」, never
「none」) — whether torque moved is read back from the robot's own report, which is exactly the
return path `ListActuations` folds in above. That is why the CLI is no longer the only publisher;
it is still the only one that can leave the UI entirely.

Honest boundaries, all of them enforced in code: **not ROS** (no `.msg`/DDS wire — a bridge into that
ecosystem is a separate deployment component), **not a scheduler** (`RobotBridge::step()` is one
explicit step; the control thread and its frequency are the caller's), **discovery is not
authentication** (plaintext beacons are a hint telling a peer where to connect — the authenticated path
is the daemon's UDS; the beat rule above is a *consistency* check in the same spirit: it makes "one
frame, one identity" true, not the link trustworthy), `zenoh-pico`/MCU firmware is out of scope, and cross-board multicast on a real
switch (IGMP, Wi-Fi power save) is still a field-verification item. One OS serves more than one kind
of machine: the **platform profiles** ([`docs/robot-domains.md`](./docs/robot-domains.md)) describe a
quadruped, a manipulator, a drone, a road vehicle, a surface vessel and an industrial cell as **data**
(actuators, vocabulary, safety envelope) and run them through one safety core — with the layer's own
boundaries registered (12 actuators, the reference argument space, no certification, no real-time
claim). A profile is data a **deployment** writes too: `Platform::from_parts` builds its own machine and
`Platform::validate` checks it (and all six built-ins) before anything reaches a bus, and a command the
layer cannot honour — an unknown action, an unknown parameter, a number past its limit, a `speed` on a
fixed-pose action, a second set point for one actuator, a `goto` with no target — is **refused by name**
rather than accepted and quietly dropped. The **application cases**
([`docs/robot-apps.md`](./docs/robot-apps.md)) test the *middleware*, not a machine: they run the
reference quadruped's HAL through `MockRobotHal`, so another form factor (a wheeled base, an arm, a
drone) implements `RobotHal` — the bus layer is form-factor-agnostic, this layer is not. See
[`docs/amos-link.md`](./docs/amos-link.md) · [`crates/amos-link/README.md`](./crates/amos-link/README.md) ·
[`crates/amos-link-cli/README.md`](./crates/amos-link-cli/README.md).

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

**Settings** also carries a read-only **「机器人链路 / Robot Link」** page (🦿): the daemon's own
AmOS-Link verdict and reasons, cumulative counters, the live peer table (id, and the endpoint the
beacon carried), and each robot's self-reported actuation mode (`RobotLink.ListActuations`). A robot
that has not reported since the daemon started watching is named **absent, never idle**; a daemon
that **predates that RPC** says so — one absent section, never a claim about the fleet and never a
page that looks disconnected (`docs/amos-link.md` §3.17). The numbers
are **dated** (the page prints when the reading was taken and re-reads every 10 s while open; a read
that gets no answer drops them rather than freezing them). There is no toggle here — this page
observes. **Commanding is a different app**: the **Robot console** (🦿) publishes arm / estop /
gait to a chosen robot over the same bridge, and a publish receipt there is a receipt, not a
verdict (see [Robot link](#robot-link-amos-link)).

The **status bar** (and lock screen / System Monitor / About) shows a **real
battery** reading, layered daemon `system_health` → desktop-host OS battery
(`pmset`/sysfs via `system_host_battery`) → browser Battery API, and **never a
fabricated number**. Cellular is handled honestly too: on a build with no real
modem it shows an explicit "no cellular service" in Settings (蜂窝网络 / 关于本机)
and no fake signal bars anywhere; the Control Center's cellular module only
appears once a real radio source is present (`svelte/cellularRadio.ts`). See
[docs/status-battery-cellular.md](./docs/status-battery-cellular.md).

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
make check         # frontend gate suite (bun run check): bun test + tsc + svelte-check
                   # (--fail-on-warnings) + the vitest DOM suite + 15 read-only scanners
make verify        # everything that needs no device: lint + test + cov + ci-local +
                   # smoke/sup-smoke/timesync-smoke/honesty-smoke + e2e-local +
                   # gated-check + the android/glue/audio/pdf/vector-db checks
```

The frontend half of `make check` / `make verify` is one script — `bun run check` in
`crates/amos-tauri/frontend-ts/package.json`. It chains the tests (`bun test`, `tsc --noEmit`,
`svelte-check --fail-on-warnings`, the vitest DOM suite) and then every **read-only scanner**, with
`--selftest` first in each case: `unwired` (dead exports / unmounted components), `i18n` (key and
`{param}` parity, hard-coded copy, unresolved `t("…")`), `store` and `write` (store-key
classification, write honesty), `a11y`, `svelteignore` (**compiler suppressions** — each declared
with a reason, that reason quoted on site, and re-proved *live*), `hover`, `lifetime`, `reactfree`,
`testreach`, `idgen` (unverified id minting), `sentinel` (no network during the suite) and `covgate`
(core-lib line coverage ≥ threshold).

`make verify` is the sequential local equivalent of the CI jobs (REQ-A193: 18 device-free
targets, all EXIT=0 on 2026-09-13). Targets that need a phone (`make android-app`, `make device-eval`)
or a running desktop app plus real pointer events (`make device-tool` — the macOS side of the same
idea, REQ-A486), and the generator `make api-docs` (which writes `docs/api-grpc.md`; `make lint` runs
its read-only `--check`), are deliberately excluded — *except* the device-free halves: both device
tools' `--selftest` runs inside `make lint`, because a gate must not need a device.

- **Rust** (`cargo test --workspace`): daemon unit tests (mock inference,
  session counter, status), socket-path test, and an **end-to-end RPC test**
  that runs the real server over a Unix Domain Socket and streams tokens via
  the tonic client.
- **System-UI** (`cd crates/amos-tauri/frontend-ts && bun run test`): a headless
  `bun test` suite covering the app registry + routing, home layout & dock
  drag/jiggle editing, layout persistence, i18n/theme, streaming/ASR/interpret
  reducers and per-app logic, plus graceful degradation outside Tauri.

### CI parity & environment drift (Android NDK / clippy)

To keep a local machine in lockstep with the Ubuntu x86 CI runner (the source of
the recurring `gated-native-backends` / `android-audio-seams` / `lint-and-test`
regressions), run the unified local gate instead of ad-hoc `cargo`:

```bash
make ci-local            # local parity gate: shell + workflow YAML + NDK/cargo-ndk pins
./deploy.sh lint         # fmt --check + clippy --workspace --all-targets -- -D warnings (== CI)
./deploy.sh android      # discover NDK, regenerate .cargo/config.toml, run the android seams
./deploy.sh docker       # build the pinned native-toolchain container image
```

`deploy.sh` never hard-codes an NDK path — it discovers it and regenerates the
git-ignored `.cargo/config.toml`, so a stale machine path can't leak into CI.
Native-gated CI jobs can opt into running inside that pinned container by setting
the repository Variable `CI_ANDROID_IMAGE`. See `docs/ci-engineering.md`.

## Recent additions (2026-09-19)

- **Compiler suppressions got a carrier and a ratchet (REQ-A472)** — the follow-up to
  REQ-A471's own honest record. A `svelte-ignore` is a *local* exemption whose reason used to
  live only in a comment on site, with **nothing** checking that it still held; and
  `--compiler-warnings` (the per-rule ignore/error mechanism) had **no cross-file carrier**, so
  relaxing a rule could only be an unexplained flag edit in `package.json`. Measured first: with
  the real exemption in place, an *extra* `a11y_media_has_caption` ignore sitting above a `<div>`
  produced `0 errors and 0 warnings`, exit 0 — svelte-check reports an *unknown* code
  (`unknown_code`, already fatal via `--fail-on-warnings`) but says **nothing** about a suppression
  that no longer suppresses anything. The fix is a carrier
  (`crates/amos-tauri/frontend-ts/scripts/svelte-ignore-allowlist.json`: every `file+code` with a
  `reason` that **quotes the on-site comment verbatim**, plus the only sanctioned way to relax a
  `--compiler-warnings` code) and a gate (`scripts/svelte-ignore-scan.mjs`, in `bun run check` and
  `make lint`): undeclared sites, stale entries, drifted reasons, missing on-site prose, a
  non-Svelte code, a relaxation that is not declared, and — the part nothing else could see — a
  **liveness** probe that removes *that* suppression, forces that one code to `error` and requires
  the count of that code in the file to **rise** (a "did it fire at all" test reads a retired
  exemption as live when the same code fires elsewhere and is separately suppressed). The probe
  restores the file in a `finally` and verifies it byte-for-byte by sha256 — a failed restore exits
  `2` instead of leaving a modified tree. Evidence: `--selftest` **24 assertions**, the gate green
  (`1 suppression, 1 live`), `bun run check` EXIT=0, `fmea-gen --check` **181** (+F-DEV-064), and
  **8/8 negative controls** (byte-identical restore each time) covering every rule. Honest
  boundaries: the liveness probe really does un-suppress the file for ~10 s, so it must run
  serially; sites outside `tsconfig.json`'s `include` (`svelte-tests/`) are declared but reported as
  liveness `skipped`; the recognised-code set is read from the **installed** Svelte; and the gate
  checks the *syntax and declaration* of a relaxation, not whether relaxing it was wise. See
  `docs/FMEA.md` (F-DEV-064) · `docs/TRACEABILITY_MATRIX.md` (REQ-A472).

- **The compiler's own warnings became a gate (REQ-A471)**: `svelte-check` ran in `bun run check` /
  `make check` / CI but **without** `--fail-on-warnings`, so three real a11y warnings sat in the
  output forever while every gate stayed green — two `<label>`s not associated with their control
  in `VoiceMemosApp.svelte` and a preview `<video>` with no captions track in `FilesApp.svelte`.
  Both instruments were silent: the repo's own `a11y-scan` (6 heuristic dimensions) reported **0
  gaps** because neither class is one of its dimensions. Fixed by giving the two trim sliders
  `for`/`id` (the accessible name is unchanged — the inputs already had matching `aria-label`s; the
  missing relation was "this label belongs to this control"), and by a **reasoned** `svelte-ignore
  a11y_media_has_caption` on the user's own file (a captions track can only come from the file
  itself — synthesising one would put a claim on screen that nobody made), with
  `--fail-on-warnings` added so the class cannot come back. The video exemption is deliberately
  **kept**; REQ-A472 later gave it the carrier and the liveness instrument.

## Recent additions (2026-09-14 → 2026-09-15)

- **A report's age, everywhere a robot's mode is shown (REQ-A266)**: the return path (`amos/<robot>/state/actuation`) tells the operator `armed` / `estopped` / `gait` — *claims about right now* — and neither form dated them. `render_actuation` (one renderer shared by `state` and `status --socket`) printed no timestamp at all, and the JSON carried only `stamp_ms`, leaving every consumer to do clock math; the System UI panel had `stamp_ms` in its type and never rendered it, so a robot that died two hours ago kept showing "armed" beside a perpetually fresh read time. Fixes: the human line ends with `age=…`, the JSON carries `age_ms` beside `stamp_ms`, and the panel renders `reported 3h 00m ago` per row (the CLI's `format_age_ms` and the panel's `reportAgeText` share one shape). The two stamps that cannot yield an age are named, never folded into `0`: a missing stamp (`0` is the proto's sentinel, not 1970 — which would read as "56 years ago") and one *in the future* (two unsynchronised clocks), which is exactly when an age would be a guess. Evidence: `cargo test -p amos-link-cli` **22 lib + 28 process-level** (the new process test folds a real robot report through a real daemon watch over a real UDS), `bun test` **14**, vitest `link-page` **10**, five negative controls. See `docs/amos-link.md` §3.12.

- **One peer table, one verdict vocabulary (REQ-A265)**: `status` and `status --socket` were one command with **two dialects**. The daemon's `GetStatus` carries a peer table (`repeated Peer`, mapping to every field the System UI renders) and the CLI printed only `peers={count}` — a *number* under a key that a local `status` fills with an *array* — while the verdict was a bare string remotely and an object locally. Probing also found the table rendered **four ways** across the workspace (kernel `{"info":{"id":…,"endpoints":[…]}}`, CLI `{"peer":…,"seen_ms":…,"static":…}`, a bare count, and the proto/UI's flat `id`/`kind`/`endpoint`/`last_seen_ms`/`beacons`), and the verdict spelled twice inside the same CLI (`{"decode_errors":{"count":3}}` in `status` vs `"decode_errors=3"` in `watch`). Fixes: the remote document is now the local document **plus** `remote` + `actuations` (equal for every shared key, asserted by a test that builds both from the same facts); the peer table is one type (`PeerRow`) rendering one flat shape aligned with `proto.Peer`; the verdict is `{"state":"…","reasons":["…",…]}` everywhere; and the render types (`NodeStatus`, `PeerView`, `LinkHealth`, `HealthReason`) dropped `Deserialize` — a rendering must not pretend to round-trip, which is how a stale test kept the old shape alive. Evidence: `cargo test -p amos-link` **133**, `-p amos-link-cli` **18 + 27**, `-p amos-tauri --lib link::` **7**, five negative controls. See `docs/amos-link.md` §3.11.

- **The robot CLI's argument surface, closed (REQ-A264)**: three sentences had no test behind them — the USAGE claiming `--json` belonged to `sub`/`watch`/`status --socket`, the crate README claiming `--device` "belongs to `motor` alone — anywhere else it is a usage error, never a silently ignored flag", and the fact that *no other* flag was under that rule. Probing the shipped binary found all three wanting: five commands (`topics`/`pub`/`bench`/`motor`/`discover`, plus remote `topics`/`pub`) **accepted `--json` and ignored it**, `pub --count 0` printed *nothing* and exited 0, and `sub --hz 5` / `bench --pattern 'amos/**'` / `motor --topic` / `status --seconds 9` all ran with the flag doing nothing. Every one of those is the same failure mode: the command runs, exits 0, and the operator believes something happened that did not. Fixes: `--json` is now global (one document per result, one object per line where the command streams, with `latency_us: null` for an empty bench and `device: null` for the mock bus); `--count 0` is refused at parse time; and one `honors(cmd, flag)` table plus `check_flag_scope` refuses any flag a command cannot act on **and** any local-node flag on a `--socket` run (`status --socket X --peer dog1` looked like a filter and filtered nothing). Evidence: `cargo test -p amos-link-cli` **17 lib + 25 process-level**, four negative controls, and a **hard-coded scope table** (`the_scope_table_refuses_what_the_docs_say_it_refuses`, 17 `(flag, refuses, accepts)` triples) beside the property test that parsing succeeds iff the command acts on a flag — the first negative control proved the property test alone was **self-referential** (it compares the parser against the same `honors` the parser calls, so an `honors` that says "yes" to everything passed it), which is why the literals exist. See `docs/amos-link.md` §3.10.

- **AmOS-Link — the robot middleware, and everything around it (`amos-link` + `amos-link-cli` + the daemon's control plane + the System UI panel)**: the workspace now has the layer that was missing between a board's sensor stream and another machine's brain. Fifteen rounds — the landing plus fourteen hardening/completion rounds (REQ-A207…A214, A235…A242) — shipped it and then audited it against its own documentation: key-expression topics with an **iterative, allocation-free** matcher (§3 of `docs/amos-link.md`), a framed wire contract whose CRC is streamed so a frame is never copied twice, ROS-like QoS with one strategy table per channel (sensor latest-wins vs control back-pressure), bus federation over any transport + real UDP beacon discovery, a robot HAL from JSON intent to CRC16 motor frames with a latched e-stop and deadman watchdog, a **return path** (`amos/<robot>/state/actuation`) so the peer whose link died can see the watchdog stop, and a 5-RPC control plane folded into the daemon's UDS. Operator surface: `amos-link-cli` (`status`/`topics`/`pub`/`sub`/`bench`/`discover`/`watch`/`state`/`motor`, plus `--socket` to read a **running** daemon) and the read-only **Settings →「机器人链路」** page. See `docs/amos-link.md` · `crates/amos-link/README.md` · `crates/amos-link-cli/README.md`.
- **The registered honest boundaries, closed (REQ-A243)**: the previous rounds recorded their limits in the traceability matrix; this round turned four of them into properties the code and tests guarantee. **(a) A real hardware HAL** (`StreamRobotHal`) writes the CRC16 frames to a real descriptor (a controller's Unix socket, or a serial/UART character device) — the whole batch validates before the first byte (measurable: a rejected batch leaves the socket at zero bytes), the accepted count is what was written, and `armed()` follows the ops in **wire order** (it used to be an order-blind "any Enable in the batch", which reported a re-armed robot as dead — defect 6 of the arc). `amos-link-cli motor --device <path>` is the operator's path to it, proven at process level: the frames arrive on the socket and decode, frame by frame, CRC included; a bus that cannot be opened is exit 1 naming the path, never "applied 13 frames". Honest remainder: no port configuration (termios is yours) and no servo has been driven yet. **(b) Multi-NIC multicast**: `AMOS_LINK_BEACON_IFACE` pins the channel (outgoing `IP_MULTICAST_IF` *and* the group join), `AMOS_LINK_BEACON_LOOP` exposes loopback — and the crate's first **real multicast** tests prove join/delivery/self-echo on a real group over a real interface. **(c) The identity-less peer table left the API**: `PeerRegistry::new` is test-only and `impl Default for PeerRegistry` is gone (it *was* the production caller of the anonymous shape — `default()`, `unwrap_or_default()`, `#[derive(Default)]`), so "a node is never its own peer" is now enforced by the compiler. **(d) The Zenoh session round trip is no longer `#[ignore]`d**: two peers with explicit endpoints over TCP loopback are a real session and run in CI — and that un-ignoring exposed that the old test could never have passed at all (Zenoh panics on `#[tokio::test]`'s current-thread scheduler; the ignore had hidden it). Also: the allocation budgets became one measurement per **process** (three test binaries) plus a new one for the broker's headline claim — a 4 MiB frame fan-out to 8 subscribers allocates far less than one payload, because they share the buffer (`Arc::strong_count`). Seven negative controls, each restored byte-for-byte.
- **Two aerospace-grade hardening rounds over that middleware — 7 real defects, 2 of them reproducible process-level crashes (REQ-A241 · REQ-A242)**: the rounds re-audited the *shipped* public surface as a black box against the repo's own discipline ("allocation · waiting · the numbers you report"), each finding reproduced first, fixed second, and pinned with a **negative control** (inject the defect back ⇒ the named test FAILS ⇒ restore byte-for-byte). (a) `crc32fast::hash(&[header, payload].concat())` allocated a **whole second copy of every frame** on both encode *and* decode — and on decode it happened **before** the checksum was verified, so a 16 MiB frame made the receiver allocate 32 MiB first ⇒ streamed `Hasher` (zero extra allocation, identical CRC, pinned to `0xFC0E56E6`). (b) A poisoned broker lock was read as "slot full", so `offer_blocking` waited for a notification **no sender would ever send** (an unbounded wait in a control loop) ⇒ typed `LinkError::Closed`. (c) The watchdog **reported a guessed frame count** (`frames: JOINTS`) ⇒ `estop() -> Result<usize>` measured, with a 1-frame `BroadcastCutHal` case. (d) `discover --seconds u64::MAX` panicked (`overflow when adding duration to instant`) and `bench --count u64::MAX` aborted (`capacity overflow`) ⇒ both refused at parse time with exit 2, plus a bounded latency reservation and a `--size` above the wire ceiling rejected. (e) Silent truncation (`usize as u32`, `u128 as u64`) saturating instead of wrapping. (f) **A node listed itself as its own peer** — a multicast beacon reaches its own socket (`IP_MULTICAST_LOOP` is the platform default), the LAN path did not filter, and two CLI paths even seeded themselves into the table; the invariant moved into the table itself (`PeerRegistry::with_local`, `self_entries_refused()`), the old test that asserted "the node appears in its own peer table" was **protecting the defect** and was replaced. (g) `Topic::matches` allocated **two `Vec`s per subscriber per frame under the registry lock** (measured: 1000 matches ⇒ 128 000 bytes) while the module documented "no allocation" ⇒ stack-fixed arrays. Also one *suspicion* was **disproved** against the dependency's source and recorded as a failing precondition instead of a change. Evidence: `cargo test -p amos-link` **117 lib + 1 allocation budget (encode/decode/matcher) + 4 e2e + 2 UDS**, `--features lan` **120**, `--features zenoh` **117 + 1 ignored**, `cargo test -p amos-link-cli` **9 + 17**, `clippy -D warnings` and `fmt` green. See `docs/amos-link.md` §3.3/§3.4.
- **Every workspace member now documents itself at its own door — and it is a gate, not a convention (REQ-A237)**: `scripts/crate-readme-scan.mjs` (wired into `make lint`, with `scripts/crate-readme-allowlist.json`) demands a `README.md` per `Cargo.toml` member, with an H1 naming the crate and a link back to the root; the scan has a `--selftest`, because a gate that never fails is not a gate. The same round turned README-promised examples into code that actually compiles (4 broken examples fixed).
- **Local gates hardened on the Rust side**: a repo-wide **"no recursion"** scan (`scripts/rust-recursion-scan.mjs`, now including mutual recursion via a resolved call graph) after a recursive matcher was found holding the broker's lock, plus the `unsafe-scan` / Tauri-reply JSON contract checks — all in `make lint`.

## Recent additions (2026-09-13)

- **F-Droid repository compatibility — `amos-appstore` + `amos-appstore-cli`**: the host store now consumes the **official F-Droid `index-v1.json`** (both `packages` shapes, numeric/string values, localized metadata) through `FdroidRepoProvider`, mapped onto the same `AppManifest` contract, and can publish our own catalog **back in F-Droid format** (`catalog_to_fdroid_index_v1`; categories map symmetrically, `suggestedVersionCode` is synthesised). Verified against **real f-droid.org** (61 MB index → zh backfill → real APK download + sha256). The CLI gains `--repo` (browse/search/find), `info`, `export` and an **atomic, sha256-verified `download`** that never pretends to install; network bodies are **capped fail-closed** (never silently truncated). Honest gaps: index PGP/JAR verification is not implemented (a pinned-index sha256 is the interim), and silent install still needs the device channel below. See `docs/appstore.md` · `docs/fdroid-audit.md`.
- **Container APK install channel (gap 1 — command + gRPC surface)**: `AndroidController::install_apk` (`waydroid app install <path>`) + `AndroidRuntime::install`, with the installed package **reset to deny-by-default** in the per-APK capability ledger (an upgrade never inherits an earlier build's grants), exposed as a new gRPC `InstallAndroidApp` RPC and exercised end-to-end over a real UDS. Installs get their **own 180 s timeout** (`AMOS_ANDROID_INSTALL_TIMEOUT`) instead of the 30 s launch budget, so a slow package-manager/dexopt run is never misreported as a timeout; a path that looks like a flag is refused before any process starts. Still missing (deliberately): the Tauri command / System UI consumer and the store→channel wiring. See `docs/android-compat.md` · `docs/fdroid-audit.md`.
- **Probe-verified audit hardening (F-Droid, web-bundle, install)**: nine audit rounds on the F-Droid layer (process-unique atomic staging, negative sizes reported as unknown instead of a fabricated `0 B`, blank `hashType` no longer dropping a verifiable package, no fabricated `"F-Droid"` author, documented version-code round-trip precondition, repo-relative exported icons, host-parsed proxy loopback check), plus web-bundle symlink hardening (`reject_link_entries`; `read_file` now reuses the hardened `serve::resolve_request`) and the independent install timeouts. Every round ships negative controls (temporary revert ⇒ FAIL ⇒ byte-level restore).
- **Release bundle + generated gRPC reference (now surfaced in this README)**: a `v*` tag builds the **headless release bundle** — `scripts/release-artifacts.sh` is the single definition, called by both `make release-artifacts` and `.github/workflows/release.yml` — staging 8 binaries with `VERSION`/`README.txt` + `SHA256SUMS`, and every binary must answer `--version` (a tag↔version mismatch refuses to publish). `scripts/proto-doc.mjs` renders `proto/*.proto` into `docs/api-grpc.md`, drift-checked in `make lint` and regenerated with `make api-docs`. See `docs/release-artifacts.md` · `docs/api-grpc.md`.

## Recent additions (2026-09-10)

- **Device care (手机管家) — shipped app + bridge + domain core**: the 「手机管家」 built-in app (🧹, the 26th app: `svelte/DeviceCareApp.svelte`, registered in `appMeta`/`appRegistry`/`appGroups`) over the new decision layer `crates/amos-devocare`. A root-confined `hostfs` backend makes it genuinely functional on host/root deployments, and the Tauri bridge (`devcare_status/scan/clean/apps/permissions/report`) **only accepts category keys — the WebView can never name a path to delete** (it re-plans inside Rust from its own scan). (a) **Junk cleaning** — `JunkKind` enumerates the *only* reclaimable material (app cache, leftover installers, logs, temp, thumbnails, crash dumps, empty dirs, + review-only stale downloads); **user media/documents/contacts/messages/app data are not modelled as junk at all**, so no code path can select them to delete — the safety property holds by construction. `analyze` folds a scan into deterministic per-kind totals and **refuses** an over-cap scan instead of silently truncating; `plan` refuses an empty selection and any review-only category without explicit acknowledgement, sorts by `(kind, uri)` and refuses batches over 5 000; `execute` reports every item honestly — a single failure does not abandon the rest and `freed_bytes` counts **confirmed** removals only (`is_partial()`). (b) **Safe uninstall** — `UninstallGuard` refuses platform-bundled packages and a pinned critical set (System UI, Settings, the manager itself) even when the platform would allow it. (c) **Permission review** — read-only `review_grants` shows only what apps actually hold (denied grants hidden, unattributable dropped, deduped, sorted, bounded); it never grants or revokes. (d) **Care report** — `assess` folds storage/battery/permissions/apps into a 0–100 score + grade with documented additive penalties, and leaves unobserved areas **unassessed** (`has_data()`) so unknown is never rendered as healthy. Pure `std`, deterministic, no I/O; P0-1 gate (`deny(unwrap/expect/panic)`) + `forbid(unsafe_code)`. **(e) Unified audit** — every clean and uninstall is written to the daemon's **one** audit trail (`PrivacyService.RecordAudit` → `PrivacyManager::record_audit` → `amos-ai::audit::AuditFile`, the same JSON-lines file the privacy decisions are mirrored to): the event content is produced by a pure domain function (`devcare.clean` aggregate + per-item failures + `app.uninstall`, with a **refusal recorded as `rejected`**), the daemon stamps the timestamp and validates the outcome, and the UI is told honestly whether it was persisted (`recorded/attempted/reason` → "audit not recorded" rather than a fake trail). Uninstall now goes through `devcare_uninstall`, which runs the guard **before** touching the store, so the policy cannot be bypassed by a UI. **(f) Audit read-back** — the trail is readable again: `PrivacyService.RecentTrail` reads the same `AuditFile` (privacy decisions and device-care actions share one sink), the bridge filters by the device-care actor in Rust, and the manager's「近期操作（审计）」card renders time/op/resource/outcome while keeping **"empty" ≠ "no durable sink" ≠ "read failed"** distinct. **(g) Permission review is daemon-authoritative** — `PrivacyService.GrantedAll` supplies the rows (the frontend's local ledger was a *cache*, not the authority); the domain still shapes them, and the review is tagged with its `authority` so **"the authority says nothing is granted" ≠ "the authority is unreachable"**. **(h) Memory boost** — the classic「一键加速」: the domain decides what may be reclaimed (only `cached`/`background`, protected tiers never, stable plan), the readings come from the real sampler, the governor owns every kill, and the result reports what it accepted (`requested`/`reclaimed`/`failures` + before/after available memory) **without claiming it caused the delta**. See `docs/devcare.md` (REQ-DC1…48).
- **Spam blocking (blacklist) — calls + SMS**: new domain crate `crates/amos-blocklist` (exact/prefix rules per channel, number equivalence tolerant of `+86`/leading-0 forms, unknown-number toggle, cap 500) shared by three enforcement points: the SMS filter (`sms_snapshot` hides blocked senders, live receipts raise no event), the Android `CallScreeningService` (system-level call rejection via `BlocklistGlue` JNI + `ROLE_CALL_SCREENING`), and the Phone app「拦截」tab (rule list, one-tap block from call history & message threads, honest role-status banner). See `docs/sms.md` §11.
- **SMS — real device end-to-end + folders**: push receive (`SMS_RECEIVED` receiver + manifest `SmsReceiver` → `sms-received` event, no manual refresh), sending via `SmsManager`, and full inbox/sent/drafts folders (`SmsFolder` domain + folder tabs + counts + AmOS-local drafts). `make android-app` rebuilds dist then installs. See `docs/sms.md`.
- **Call history page**: direction (incoming/outgoing/missed) recorded from real transitions, relative timestamps, filter chips, two-step clear, and per-record 回电 / 回短信 / 拉黑 actions with cross-app deep links (`appLinks.ts`). See `docs/telephony.md` §13.
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
- [docs/GATES.md](./docs/GATES.md) — **The gates index**: every instrument the build runs (94 scripts: scanners, generators, smokes, shell entry points), the question each one answers *in its own words*, its failure behaviour and whether it has a `--selftest`; kept in sync by `scripts/gate-index-scan.mjs` (`make lint`), with the rule *read this before writing a new instrument*
- [docs/FMEA.md](./docs/FMEA.md) — FMEA ledger: failure modes whose mitigations are verified against the code by `scripts/fmea-gen.mjs` (`make lint` runs its `--check`)
- [docs/TRACEABILITY_MATRIX.md](./docs/TRACEABILITY_MATRIX.md) — Requirements → code → verification ledger (a **partial** index; `scripts/trace-scan.mjs` keeps it readable as an index)
- [docs/multi-window.md](./docs/multi-window.md) — Multi-window architecture
- [docs/PC_DESKTOP_AUDIT.md](./docs/PC_DESKTOP_AUDIT.md) — PC desktop (macOS) form-factor audit + roadmap
- [docs/PC_DESKTOP_ARCHITECTURE.md](./docs/PC_DESKTOP_ARCHITECTURE.md) — PC desktop (macOS) shell architecture: `DesktopShell` + TopBar/Dock/Launchpad/Spotlight/MissionControl + multi-window stage
- [docs/clipboard-container-sync.md](./docs/clipboard-container-sync.md) — Cross-boundary global-clipboard sync (host↔Waydroid/Android container): two-topology decision + shared framed protocol + host transport + guest-side agent crate + offline link/backoff supervisor (`amos-clipboard`, all implemented/tested); device channel bridge planned
- [docs/clipboard-device-runbook.md](./docs/clipboard-device-runbook.md) — Connected-phone runbook: detect retail / no-UI-base / Waydroid, `adb push` + run the `amos-clipboard` on-device self-check, and which clipboard layers are really testable per device shape
- [docs/android-compat.md](./docs/android-compat.md) — Waydroid/APK compatibility (dev/prototype; product = no-UI Android base)
- [docs/microg.md](./docs/microg.md) — MicroG in AmOS: self-built AOSP guest + signature spoofing fixed preinstall layer (decision + Phase 0–3 plan; planned, not yet implemented)
- [docs/microg-implementation-review.md](./docs/microg-implementation-review.md) — MicroG proposal vs review side-by-side (claims → AmOS reality / recommended correction)
- [docs/lmk-proxy.md](./docs/lmk-proxy.md) — Android Activity/Task lifecycle proxy + LMK (AmOS-controlled freeze/kill of container APKs)
- [docs/android-lmk-e2e.md](./docs/android-lmk-e2e.md) — Android LMK end-to-end acceptance runbook (real device / live Tauri host)
- [docs/appstore.md](./docs/appstore.md) — App-store core: catalog/package JSON publish contract + download→verify→install (developer onboarding)
- [docs/fdroid-audit.md](./docs/fdroid-audit.md) — F-Droid distribution audit: `FdroidRepoProvider` (official `index-v1.json` read + F-Droid-format publish), the container APK-install channel (gap 1), and nine probe-verified audit rounds
- [docs/release-artifacts.md](./docs/release-artifacts.md) — Release artifacts: the headless bundle (`scripts/release-artifacts.sh` = the single definition, `make release-artifacts`, `.github/workflows/release.yml`), the `--version` contract, tag↔version consistency and honest boundaries
- [docs/api-grpc.md](./docs/api-grpc.md) — Generated gRPC API reference for `proto/*.proto` (services / RPCs / messages / enums, doc comments included); regenerate with `make api-docs`, drift-checked by `make lint`
- [docs/amos-link.md](./docs/amos-link.md) — AmOS-Link robot middleware: layers & the real data flow, the kernel modules, safety semantics (§3.1), an honest `LinkHealth` verdict (§3.2), the hardening rounds (§3.3 allocation/arithmetic, §3.4 peer table & matcher, §3.5 the real-bus HAL, §3.6 multicast & the identity-less registry, §3.7 the trust boundary on the wire), the Zenoh usage audit (§4 — what is used and what is not), the 5-RPC control plane (§5), env vars + non-goals (§6) and the verification entry points (§7)
- [docs/telephony.md](./docs/telephony.md) — Telephony: design + contract (dialer, EmergencyMap/110-112 hard path, TelephonyProvider seams, call-recording consent, call-history page)
- [docs/sms.md](./docs/sms.md) — SMS: real device send/receive, inbox/sent/drafts folders, validation bounds, and the shared spam blocklist (rules + SMS filter + CallScreeningService)
- [docs/radio.md](./docs/radio.md) — Radio/connectivity: wifi/bluetooth/airplane state, RadioManager airplane policy + cascade, provider seams (Mock / Android JNI) & System UI bridge
- [docs/sensors.md](./docs/sensors.md) — Device sensors/multimedia domain core: `amos-sensor` camera / GPS-GNSS / IMU spec types + SensorProvider seam + energy-policy SensorManager (real HAL + service-bus wiring left as seams)
- [docs/profiling.md](./docs/profiling.md) — Inference performance & power profiling domain core: `amos-profiling` prompt/decode tokens-per-second, TTFT, per-token latency, real `BatterySample` power model + `mean_power_mw`, PowerSource seam (live `CURRENT_NOW` × `EXTRA_VOLTAGE`) + honest energy estimate (`est_energy_j`)
- [docs/power-policy.md](./docs/power-policy.md) — Energy Governor → CPU/NPU frequency closed loop: `amos-power` folds battery/thermal/live-power/foreground-background into a `SensorMode` decision, then maps it to per-cluster + NPU frequency ceilings (`FreqPlan`/`FrequencyGovernor`) and a Linux `scaling_max_freq` cap/restore applier (`feature linux`)
- [docs/system-monitor.md](./docs/system-monitor.md) — System working status (health): `amos-monitor` folds CPU/memory load, battery/power and per-app process tiers into one honest `SystemHealth`, exposed as `GetStatus.system` and surfaced through a `system_health` Tauri bridge to the Settings `SystemPanel` and a dedicated dock「System Monitor」dashboard app
- [docs/monitor-dock-verify.md](./docs/monitor-dock-verify.md) — Real-device acceptance checklist for the dock「系统监控 / System Monitor」app (dock entry, live overview, offline/no-data empty states + auto-recovery, detail/regulation panels, a11y progress bars)
- [docs/status-battery-cellular.md](./docs/status-battery-cellular.md) — Status-bar/system-monitor honest battery (layered daemon → desktop-host → browser Battery API, `system_host_battery`) + honest cellular service state & the controlled `cellularRadio` seam (real modem source only)
- [docs/dvfs-power-bringup.md](./docs/dvfs-power-bringup.md) — 真机 bring-up runbook：电源/DVFS 子系统部署与验收（env 开关、架构速览、host 验证命令、设备步骤/判据、诚实边界）
- [docs/bidi-voice-asr.md](./docs/bidi-voice-asr.md) — AI-assistant voice wiring: bidi `Payload::Audio` → local ASR (design)
- [docs/audio-hal-bridge.md](./docs/audio-hal-bridge.md) — Hardware audio (Audio HAL Bridge): `amos-audio` capture/playback traits + resample + mocks + gated TinyALSA/AAudio seams; bidi real-sherpa ASR (`asr-sherpa` feature)
- [docs/aaudio-sherpa-bringup.md](./docs/aaudio-sherpa-bringup.md) — 真机 bring-up runbook: NDK 交叉编译/链接验收 (compile-all-ABI + AAudio `#[link]` DT_NEEDED) + `make android-audio-check`/CI 门 + device wiring/acceptance checklist
- [docs/device-poc.md](./docs/device-poc.md) — On-device POC: cross-compile `amos-ai` + run `chat_once` over UDS on a real phone
- [docs/no-ui-android.md](./docs/no-ui-android.md) — no-UI Android base: init.rc orchestration, `--ai-voice` sherpa cross-build + model push, and a pasteable on-device AI POC acceptance sequence
- [docs/external-analysis-review.md](./docs/external-analysis-review.md) — Audit of an external gap analysis against the real tree
- [docs/device-bring-up.md](./docs/device-bring-up.md) — 真机 bring-up 行动件：energy/applife/scheduler 三块 Android 接线的接线点、复用 seam、验收判据，与"daemon 托管生命周期"(可选 gRPC Governor 服务) 路线
- [docs/qcom-mtk-bringup.md](./docs/qcom-mtk-bringup.md) — QCOM/MTK 真机落地骨架：`amos-ai::accelerator` 芯片/加速器画像 seam、`AMOS_GGML_STRICT` 诚实本地引擎、AAudio→sherpa 语音闭环接线点与验收判据
- [docs/DELIVERY_NOTES_2026-09-03.md](./docs/DELIVERY_NOTES_2026-09-03.md) — Commit message + changeset + known limits for the telephony/voice/strategy work (2026-09-03)
- [docs/DELIVERY_NOTES_2026-09-05.md](./docs/DELIVERY_NOTES_2026-09-05.md) — Commit message + changeset + known limits for the Android LMK-proxy / bidirectional bridge / WatchLmk / System-UI surface-teardown work (2026-09-05)
- [docs/DELIVERY_NOTES_2026-09-05-system-monitor.md](./docs/DELIVERY_NOTES_2026-09-05-system-monitor.md) — Commit message + changeset + known limits for the system working-status (amos-monitor) domain core + daemon/Tauri/frontend wiring (2026-09-05)
- [docs/display-idle.md](./docs/display-idle.md) — Display protection / auto screen-off (idle → sleep → lock): `amos-display` ScreenState + IdlePolicy kernel, the `AMOS_SCREEN_STATE_PATH` file contract, and how a sleeping screen now reaches the energy governor as `screen_on = false`
- [docs/DELIVERY_NOTES_2026-09-05-display-protection.md](./docs/DELIVERY_NOTES_2026-09-05-display-protection.md) — Commit message + changeset + known limits for the display-protection / auto screen-off work (2026-09-05)
- [docs/identity-web3.md](./docs/identity-web3.md) — Digital identity & Web3 signing domain core: `amos-identity` (`did:key`, key/keystore) + `amos-web3` (secp256k1, EVM address, EIP-191/EIP-712) — deterministic, no PRNG in the core, honest entropy/at-rest seams
- [docs/DELIVERY_NOTES_2026-09-05-did-web3.md](./docs/DELIVERY_NOTES_2026-09-05-did-web3.md) — Commit message + changeset + known limits for the DID/Web3 signing domain-core work (2026-09-05)
- [docs/DELIVERY_REPORT.md](./docs/DELIVERY_REPORT.md) — Delivery & verification report for one arc: root-cause fixes, feature completion, test infrastructure and the voice loop, with the reproducible commands (2026-09)
- [docs/hardware-buttons.md](./docs/hardware-buttons.md) — Hardware buttons (Home/Voice/AI): `buttons.rs` abstraction + `hardware-button` event + on-device wiring and the S5 FreemeOS camera-key/WebView findings
- [docs/camera-key-system-remap.md](./docs/camera-key-system-remap.md) — Rooted system-layer steps to remap the camera key away from the OS camera on FreemeOS/MediaTek S5
- [docs/os-shell-bridge-checklist.md](./docs/os-shell-bridge-checklist.md) — Real-device acceptance for the pure-Svelte OS-shell bridges (auto screen-off, incoming call, hardware Home, OS alarms)

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
- [ ] Performance profiling and optimization — metric kernel wired into the daemon's `stream_chat` + bidi `Chat` decode paths, exposed on `get_status.profile`, on the periodic heartbeat log, and rendered in the Settings diagnostics area; **real power model landed** (`BatterySample`/`mean_power_mw`, Android source reads live `CURRENT_NOW` × `EXTRA_VOLTAGE` → `est_energy_j`); **Energy-Governor → CPU/NPU frequency closed loop landed** (`freq` domain + `FrequencyGovernor` + Linux `scaling_max_freq` cap/restore seam, and `ResourceGovernor::freq_plan` composition bridge). Remaining device/UI follow-ons: System-UI ticker sampling real battery + injecting chip topology + cpufreq write privileges (`docs/profiling.md`, `docs/power-policy.md`)
- [x] Robot middleware — **AmOS-Link** (`amos-link` + `amos-link-cli`, the daemon's 5-RPC control plane and the read-only Settings「机器人链路」page) landed and then audit-hardened over fifteen rounds (`docs/amos-link.md`). Remaining: cross-board multicast on a real switch is a field-verification item, the MCU/`zenoh-pico` firmware path is out of scope by design, and a ROS/DDS bridge would be a separate deployment component

## Support

For issues, feature requests, or questions:
- 📖 Check [existing issues](https://github.com/arkCyber/AmOS/issues)
- 🐛 [Report a bug](https://github.com/arkCyber/AmOS/issues/new?template=bug_report.md)
- ✨ [Request a feature](https://github.com/arkCyber/AmOS/issues/new?template=feature_request.md)
- 🔒 For security issues, see [SECURITY.md](./SECURITY.md)
- 📧 Contact: arksong2018@gmail.com
