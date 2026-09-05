# System Monitor (系统工作状况) — `amos-monitor`

> Domain-core crate for AmOS system **working-status / health** aggregation. Status:
> **domain core landed (reserved) + host-tested**; daemon aggregation wired into
> `GetStatus.system`; Tauri bridge + System-UI Task-Manager/diagnostics panel is the
> remaining wiring step.

## Why it exists

AmOS already produces scattered health/profiling signals — daemon uptime/RPC/heartbeat
(`amos-ai::monitoring`), decode throughput & power (`amos-profiling`), energy-governor
mode/DVFS (`amos-power`), process lifecycle counts (`amos-applife`), device sensors
(`amos-sensor`) — but there is **no unified, honest "system working status" snapshot**
and no single surface to present it. This crate is that unification point: a
transport-/platform-agnostic domain core (mirroring `amos-power`/`amos-sensor`) that
folds the pure, ownable parts into one `SystemHealth`:

```
 [ SystemSampler seam ]─┐
   Mock · Linux /proc   │        ┌────────────────────────┐
   Android (skeleton)   │        │                        │
 [ amos-profiling ]     ├──────▶│  SystemMonitor.health() │──▶ SystemHealth
   PowerSource/Battery  │        │                        │   (log / RPC / UI)
 [ amos-applife ]       │        └────────────────────────┘
   AppLifecycle counts  │
   (process_summary)   ─┘
```

## Honest scalar rule

Every reading a real HAL / OS source might fail to produce is an `Option`: absent ==
**unknown**, never a fabricated number. This is the same rule `amos-profiling` /
`amos-power` follow (`0.0`/`None` == unavailable), so a diagnostics surface can refuse
to paint a number it cannot trust. E.g. `BatterySample::power_mw()` = `0.0` when the
raw µA×mV pair is invalid → `amos-monitor` maps that back to `None`.

## Crate layout

* `spec` — `SystemLoad` / `CpuSample` / `MemoryInfo` / `BatteryStatus` /
  `ProcessSummary` / `SystemHealth` (with a one-line `summary()` for log lines).
* `sampler` — the `SystemSampler` seam + deterministic `MockSystemSampler`. CPU busy%
  is a **delta** between two cumulative reads (like `/proc/stat`), so every sampler
  keeps its previous reading in interior mutability and stays `Send + Sync`.
* `monitor` — `SystemMonitor` (owns the sampler) folding battery + process counts into
  `SystemHealth`; `process_summary`/`process_summary_from_counts` over `AppLifecycle`.

Feature gates (all pure `std` by default):

* `linux` — `LinuxSystemSampler` (`src/linux.rs`): real `/proc/stat` + `/proc/meminfo`
  reads over an **injectable procfs root** (`/proc` default) → fully host-tested over a
  tempdir fixture, no root/device. First read establishes the CPU baseline; later reads
  report the window's busy%.
* `android` — `AndroidSystemSampler` (`src/android.rs`) compile-gated skeleton for the
  System-UI APK build; honestly reports "unknown" until device bring-up wires real
  reads (`Debug.MemoryInfo` / `SystemStatus`). Validated by `cargo check --features android`.

The energy-governor **decision** (mode / throttle) is deliberately *not* re-derived
here — it is a consumer input owned by `amos-power`, folded in at the transport
boundary rather than this core duplicating policy.

## Verify

```bash
cargo test -p amos-monitor                          # mock aggregator + sampler (8)
cargo test -p amos-monitor --features linux         # + /proc parser over fixtures (14)
cargo clippy -p amos-monitor --features linux --all-targets -- -D warnings
cargo check  -p amos-monitor --features android     # on-device skeleton compiles
make gated-check                                    # runs the above for CI
```

`make lint` / `make test` pick the crate up automatically via the workspace.

## Wiring status

**Daemon aggregation — done (in `amos-ai`, no separate RPC service):** each
`GetStatus` reply now carries a `system` block (`StatusReply.system`, new proto
messages in `proto/ai_agent.proto`). `AiAgentService::system_metrics()` folds the
shared `LinuxSystemSampler` (`/proc` on Linux/Android; honest unknown on macOS),
advancing its busy% delta baseline per probe, and folds the shared governor's app
lifecycle into per-tier `ProcessCounts`, and per-app `apps` (id + `AppState::key()`
state) for the Task-Manager listing. Battery is threaded from the energy-governor
store (see the Honest-boundary note below).
Verified: `system_metrics` unit test (deterministic mock sampler + governor app count)
passes; `cargo check -p amos-ai` / `-p amos-tauri` green. A periodic `system_beat` in
`serve()` also logs one `SystemHealth::summary()` line each cadence (via the shared
`fold_system_health`), so an operator sees the working status in the daemon log even
without the UI; it is aborted on shutdown.

**Tauri bridge — done (`amos-tauri/src/system.rs`):** a `system_health` command opens
an `AiAgentClient` over the same UDS, runs `GetStatus`, and returns a serializable
`SystemStatus` **plus the live `SystemGovernor`** (mode/reason/caps/DVFS applied-failed/
dropped, pure `governor_status()` mapper) — one call carries the whole
"system + power" picture. Registered in `lib.rs`.

**System-UI panel — done (`frontend-ts`):** `lib/system.ts` (typed `SystemStatus` +
`AppProc` + `SystemGovernor` + `normalizeSystemHealth`/`normalizeApps`/`normalizeGovernor`/
`memUsedBytes`/`memUsedPct`/`fmtBytes`/`liveProcesses` + guarded `systemHealth()`, null
offline) with `__tests__/system.test.ts`; a Settings `SystemPanel.tsx` (CPU / memory /
battery / process tiers **+ the governor's registered apps id + tier**, and a
「电源调控 / Power regulation」block with mode · reason, cap-inference/throttle on/off,
DVFS applied/failed and expired-dropped counts (shown only once the governor has ticked,
`ticks>0`, so a not-yet-run "balanced · pending" is never presented as active
regulation); hidden when no data, absent values shown
as "—", never fabricated) mounted in Settings beside `SensorPanel`, with en/zh
`settings.system*` keys. Once live data is present it auto-refreshes every ~2.5 s (CPU
busy% is a window delta; a busy-ref guard prevents overlap) — offline / no data means no
timer, so tests never leak one.

Honest boundary: the `system` block's **battery comes from the energy-governor store**
(`level_pct`/`charging`/`live_power_mw`, threaded in `system_metrics()`); before the
governor's first tick it is the "pending" baseline → level/power unknown, charging
unreported, never fabricated. The energy block (`StatusReply.energy` / `GovernorMetrics`)
remains the authoritative battery/mode surface; `system.battery` just mirrors it for a
single-surface convenience.

Full end-to-end path: `proto/ai_agent.proto` → `amos-ai` `get_status.{system,governor}`
(`amos-monitor` sampler + governor app counts + energy battery + governor decision/DVFS/
dropped) → `amos-tauri` `system_health` bridge → `frontend-ts` `SystemPanel`. Verified:
`amos-monitor` (14), `amos-ai` lib (131) + rpc e2e (4), `amos-tauri` lib (73),
`bun run test` + `bun run typecheck` all green; `clippy -D warnings` clean on the three
touched Rust crates.
