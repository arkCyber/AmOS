# gRPC API reference

> **Generated** by `scripts/proto-doc.mjs` from `proto/*.proto` — do not edit by
> hand. `make api-docs` regenerates it; `make lint` fails when it is stale, so the
> contract and this page cannot drift apart.

The daemon serves all of these over **one shared Unix Domain Socket** (default $AMOS_SOCKET).
10 services · 58 RPCs · 117 messages · 18 enums,
across 9 `.proto` files.

## Index

| File | Package | Services | RPCs | Messages | Enums |
|---|---|---|---|---|---|
| [`ai_agent.proto`](#ai_agentproto) | `ai_agent` | 2 | 11 | 40 | 0 |
| [`android_compat.proto`](#android_compatproto) | `android_compat` | 1 | 8 | 16 | 4 |
| [`governor.proto`](#governorproto) | `amos_governor` | 1 | 6 | 9 | 2 |
| [`netguard.proto`](#netguardproto) | `amos_netguard` | 1 | 3 | 7 | 1 |
| [`privacy.proto`](#privacyproto) | `amos_privacy` | 1 | 9 | 12 | 0 |
| [`sensor.proto`](#sensorproto) | `amos_sensor` | 1 | 7 | 12 | 4 |
| [`telemetry_spy.proto`](#telemetry_spyproto) | `amos_telemetry_spy` | 1 | 2 | 3 | 3 |
| [`telephony.proto`](#telephonyproto) | `amos_telephony` | 1 | 8 | 10 | 4 |
| [`translate.proto`](#translateproto) | `translate` | 1 | 4 | 8 | 0 |

## `ai_agent.proto`

Package: `ai_agent`

Transport: Unix Domain Socket (no TCP loopback) for low latency + process isolation.

### Services

#### `AiAgent`

The Tauri Rust core acts as a *client*: it opens a stream, consumes the token stream, and re-emits each token to the WebView as a Tauri event so the UI stays perfectly in sync (typing-machine effect) without blocking.

| Method | Request | Reply | Kind | Notes |
|---|---|---|---|---|
| `StreamChat` | `AgentRequest` | `AgentChunk` | server streaming | Unary request -> server-streaming tokens (chat / long text generation). |
| `Chat` | `ClientMessage` | `AgentChunk` | bidirectional streaming | Bidirectional streaming: client pushes prompts/audio, server streams tokens. Ideal for voice interaction and multi-turn agent orchestration. |
| `GetStatus` | `StatusRequest` | `StatusReply` | unary | Lightweight liveness / capability probe used by the System UI. |
| `ListSessions` | `ListSessionsRequest` | `ListSessionsReply` | unary | List the daemon's tracked agent sessions (id, model, usage) — lets the UI show / manage live conversations. |
| `ClearSessions` | `ClearSessionsRequest` | `ClearSessionsReply` | unary | Remove all tracked sessions (session-management UI's "clear all"). |
| `RemoveSession` | `RemoveSessionRequest` | `RemoveSessionReply` | unary | Remove a single tracked session by id. |
| `GetHistory` | `GetHistoryRequest` | `GetHistoryReply` | unary | Fetch one session's completed conversation history. |

#### `Rag`

RAG retrieval service: offline local vector search over the daemon's indexed notes / documents ("ask my files"). A separate service from `AiAgent` so it stays a clean, independently-testable seam; "retrieve-then-answer" is composed by a caller as `Rag.Query` (returns the nearest ids + their passage text) then `AiAgent.StreamChat` with that context dropped into the prompt. Honest scope: retrieval relevance is what the local embedding model (Ollama `/api/embeddings` on device) gives you — see docs/vector-db-rag.md.

| Method | Request | Reply | Kind | Notes |
|---|---|---|---|---|
| `Index` | `RagIndexRequest` | `RagIndexReply` | unary | Index (or re-index on edit) a passage under an id. |
| `Remove` | `RagRemoveRequest` | `RagRemoveReply` | unary | Drop a passage from future retrieval. |
| `Query` | `RagQueryRequest` | `RagQueryReply` | unary | Retrieve the nearest indexed ids to a query (embed + exact top-k). |
| `Status` | `RagStatusRequest` | `RagStatusReply` | unary | Lightweight probe: how many passages are indexed + the vector dimension. |

### Messages

**`AgentRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `session_id` | `string` | 1 | arbitrary id used to correlate the stream |
| `prompt` | `string` | 2 | user/system text input |
| `context` | `map<string, string>` | 3 | injected OS context (screen a11y text, intent, etc.) |

**`AgentChunk`**

| Field | Type | # | Notes |
|---|---|---|---|
| `session_id` | `string` | 1 | echoes back the originating session_id |
| `token` | `string` | 2 | next piece of generated text |
| `done` | `bool` | 3 | true on the terminal frame of the stream |
| `error` | `string` | 4 | non-empty when the generation failed |
| `card` | `UiCard` | 5 | optional structured UI descriptor (semantic "card") |

**`UiCard`** — A structured, AI-generated UI descriptor. The frontend renders these as dynamic cards ("语义中枢 → 像素表面"), so the agent can drive the interface instead of only returning text. See `cards.js` for the renderers.

| Field | Type | # | Notes |
|---|---|---|---|
| `kind` | `string` | 1 | "weather" \| "media" \| "note" \| "wallet" \| "action" \| ... |
| `title` | `string` | 2 | — |
| `subtitle` | `string` | 3 | — |
| `fields` | repeated `UiField` | 4 | key/value rows to display |
| `actions` | repeated `string` | 5 | quick-action button labels |

**`UiField`**

| Field | Type | # | Notes |
|---|---|---|---|
| `key` | `string` | 1 | — |
| `value` | `string` | 2 | — |

**`ClientMessage`**

| Field | Type | # | Notes |
|---|---|---|---|
| `prompt` | `string` | 1 | in `oneof payload` · push a text prompt into the stream |
| `audio` | `bytes` | 2 | in `oneof payload` · push an audio frame (voice interaction) |
| `cancel` | `string` | 3 | in `oneof payload` · request cancellation of the current turn |
| `audio_end` | `bool` | 4 | in `oneof payload` · "end of utterance": force-finalize the |

**`StatusRequest`**

*(no fields)*

**`StatusReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `running` | `bool` | 1 | is the inference daemon alive & ready |
| `model` | `string` | 2 | active model identifier |
| `uptime_seconds` | `int64` | 3 | daemon uptime |
| `gpu_util` | `uint32` | 4 | rough GPU/NPU utilisation percent |
| `active_sessions` | `uint32` | 5 | number of live agent sessions |
| `rpc_total` | `int64` | 6 | RPCs seen at the gRPC boundary (monitoring) |
| `heartbeats` | `int64` | 7 | periodic self-health ticks emitted (monitoring) |
| `engine` | `string` | 8 | Operational truth (added 2026-09): what inference/ASR engine is actually serving right now, so a UI/operator never mistakes a degraded (mock) engine for real inference. |
| `engine_model` | `string` | 9 | concrete model behind `engine` (empty for mock) |
| `degraded` | `bool` | 10 | a real engine was requested but the daemon is serving mock |
| `asr` | `string` | 11 | voice ASR backend in effect: mock\|sherpa\|off |
| `profile` | `ProfileMetrics` | 12 | Inference performance / power profile (amos-profiling), added 2026-09-04. Present on every reply; consumers treat decode_runs == 0 as "no runs yet". |
| `energy` | `EnergyPolicy` | 13 | Energy-governor decision (amos-power), added 2026-09-04. Present on every reply once the periodic governor has ticked at least once; consumers treat ticks == 0 as "governor has not run yet". |
| `governor` | `GovernorMetrics` | 14 | Resource-governor (amos_ai::governor::ResourceGovernor) live decision, added 2026-09-04: what the daemon's energy→lifecycle→scheduler closed loop is doing (sensor mode + throttle/cap recommendations + tick count). mirrors the Governor service's GovernorDecision. ticks == 0 ⇒ not run yet. |
| `accelerator` | `string` | 15 | Resolved device-acceleration target of the local inference path, added 2026-09-04 (amos_ai::accelerator): "<vendor>/<accel>", e.g. "android/nnapi" or "qualcomm/qnn" — reported ONLY when a local engine that uses it is serving (ggml). Empty otherwise, and never "auto" (always the concrete resolution). See docs/qcom-mtk-bringup.md. Consumers treat empty as "not applicable". |
| `system` | `SystemHealth` | 16 | System working-status (amos-monitor), added 2026-09-05: unified OS load (CPU/memory) + per-process lifecycle counts + (honestly) unknown battery when not available. Present on every reply; absent Optionals mean "unknown", never a fabricated reading. Backing sampler named in `sampler`. |
| `generation_pool` | `GenerationPoolMetrics` | 17 | Daemon-wide generation admission gate (REQ-A43), added 2026-09-11: live concurrency bounded by AMOS_MAX_SESSIONS. `in_flight` never exceeds `capacity` (the pool enforces it structurally). Present on every reply from this daemon version; a pre-this-field daemon leaves it absent (= unknown). |
| `response_cache` | `ResponseCacheMetrics` | 18 | Inference-response cache (REQ-A44), added 2026-09-11: opt-in via AMOS_RESPONSE_CACHE=1. When disabled (`enabled=false`) every counter is the honest zero of a cache that stored/looked up nothing — never fabricated. |
| `log_sink` | `LogSinkMetrics` | 19 | On-disk log sink health (REQ-A87), added 2026-09-11: the daemon persists its tracing output to a bounded, self-rotating file when AMOS_LOG_DIR is set (default ~/.amos/logs). `enabled=false` means stdout only — the counters are then the honest zeros of a sink that never persisted anything. A non-zero `lost_bytes`/`write_failures` is how an operator learns the on-disk trail is *incomplete* instead of assuming it is complete. |
| `breaker` | `BreakerMetrics` | 20 | Backend circuit breaker (REQ-A131), added 2026-09-12: while a backend is down, generations fail fast with a stated reason instead of every caller walking the full backend timeout. `enabled=false` (AMOS_BREAKER=0) means the decorator is not in the serving path at all — the counters are then the honest zeros of a breaker that never made a decision. `state` is "closed" \| "open" \| "half_open"; a non-zero `rejections` is how an operator learns calls were *skipped on purpose* rather than lost. See docs/daemon-resource-gate.md. |
| `alerts` | `Alerts` | 21 | Threshold alerts derived from the counters above (REQ-A133), added 2026-09-12: one place that says what is *wrong right now* instead of making an operator read eight blocks. `alerts` is EMPTY for a healthy daemon — absence means "no rule fired", never "checked and all good by some other authority". Nothing is delivered anywhere: this is a report, not a notification channel. |

**`Alerts`** — The active alerts at the moment of this reply (amos_ai::alerts). Recomputed on every call, so a recovered condition disappears rather than sticking as a stale alarm. `active_for_seconds` counts from when *this daemon process* first observed the condition — a restart resets it, so it must not be read as "how long the problem has existed".

| Field | Type | # | Notes |
|---|---|---|---|
| `alerts` | repeated `Alert` | 1 | ordered: errors first, then by id (stable) |

**`Alert`**

| Field | Type | # | Notes |
|---|---|---|---|
| `id` | `string` | 1 | breaker_open \| engine_degraded \| log_trail_incomplete \| |
| `severity` | `string` | 2 | generations_rejected \| power_throttled \| dvfs_write_failures |
| `detail` | `string` | 3 | the numbers behind it, e.g. "12 generation(s) were rejected…" |
| `active_for_seconds` | `uint64` | 4 | since this process first saw it (0 on first sight) |

**`BreakerMetrics`** — Live state + counters of the backend circuit breaker (amos_ai::breaker). Every number is a decision that actually happened: `openings` counts transitions *into* Open, `rejections` counts calls skipped without touching the backend, and `successes`/`failures` count observed generation outcomes (a completed stream is a success; a start error or a mid-stream error is a failure).

| Field | Type | # | Notes |
|---|---|---|---|
| `enabled` | `bool` | 1 | AMOS_BREAKER != 0 (false => not in the path) |
| `state` | `string` | 2 | closed \| open \| half_open |
| `fail_threshold` | `uint32` | 3 | consecutive failures that open it (AMOS_BREAKER_FAILS) |
| `cooldown_seconds` | `uint64` | 4 | open duration before a probe (AMOS_BREAKER_COOLDOWN_SECS) |
| `consecutive_failures` | `uint32` | 5 | current run while closed |
| `openings` | `uint64` | 6 | transitions into Open |
| `rejections` | `uint64` | 7 | calls skipped (backend untouched) |
| `failures` | `uint64` | 8 | observed generation failures |
| `successes` | `uint64` | 9 | observed completed generations |

**`LogSinkMetrics`** — Live state + counters of the daemon's bounded on-disk log sink (amos_ai::logfile). `bytes_written` counts what was appended; `lost_bytes` counts what a failed write/rotation could not persist, so the two together say how much of the trail exists and how much went missing.

| Field | Type | # | Notes |
|---|---|---|---|
| `enabled` | `bool` | 1 | a file sink is open (false => stdout only) |
| `path` | `string` | 2 | the active file ("" when disabled) |
| `bytes_written` | `uint64` | 3 | bytes appended since start-up |
| `lost_bytes` | `uint64` | 4 | bytes a failed write could not persist |
| `write_failures` | `uint64` | 5 | failed write/flush/rotation attempts |
| `rotations` | `uint64` | 6 | completed roll-overs (older lines moved to .1…) |
| `active_bytes` | `uint64` | 7 | size of the active file right now |

**`GenerationPoolMetrics`** — Live state + monotonic counters of the daemon's generation admission pool (amos_ai::pool::GenerationPool). `in_flight <= capacity` is an invariant, not a hope: the semaphore cannot hand out more permits than it holds.

| Field | Type | # | Notes |
|---|---|---|---|
| `capacity` | `uint32` | 1 | fixed slots (AMOS_MAX_SESSIONS; never 0) |
| `in_flight` | `uint32` | 2 | slots held right now (<= capacity) |
| `available` | `uint32` | 3 | free slots right now (capacity - in_flight) |
| `acquired_total` | `uint64` | 4 | generations admitted since daemon start |
| `rejected_saturated` | `uint64` | 5 | fail-fast rejections (all slots busy) |
| `rejected_timeout` | `uint64` | 6 | bounded-wait timeouts (AMOS_GEN_POOL_WAIT_MS) |
| `wait_ms` | `uint64` | 7 | configured bounded wait (0 = fail-fast) |

**`ResponseCacheMetrics`** — Live state + honest counters of the inference-response cache (amos_ai::cache::ResponseCache). `entries <= capacity`; hits + misses equals the number of lookups performed. Disabled => enabled=false, all counters 0.

| Field | Type | # | Notes |
|---|---|---|---|
| `enabled` | `bool` | 1 | AMOS_RESPONSE_CACHE=1 |
| `capacity` | `uint32` | 2 | max entries held (LRU bound) |
| `ttl_seconds` | `uint64` | 3 | entry time-to-live |
| `entries` | `uint32` | 4 | entries held right now |
| `hits` | `uint64` | 5 | lookups served from cache |
| `misses` | `uint64` | 6 | lookups not in cache (incl. expired) |
| `stores` | `uint64` | 7 | completed generations written |
| `evicted` | `uint64` | 8 | entries dropped by the LRU bound |
| `expired` | `uint64` | 9 | entries dropped by TTL |
| `oversized` | `uint64` | 10 | store attempts rejected as too large |

**`SystemHealth`** — Unified "system working status" folded from amos-monitor (docs/system-monitor.md).

| Field | Type | # | Notes |
|---|---|---|---|
| `load` | `SystemLoad` | 1 | CPU / memory load from the active sampler |
| `battery` | `SystemBattery` | 2 | level/power; fields absent = unknown |
| `processes` | `ProcessCounts` | 3 | per-process lifecycle tiers |
| `sampler` | `string` | 4 | sampler backend: linux-proc \| mock \| android \| ... |
| `apps` | repeated `AppProcess` | 5 | per-app processes the governor tracks (empty on |

**`AppProcess`**

| Field | Type | # | Notes |
|---|---|---|---|
| `id` | `string` | 1 | app/process id ("com.amos.photos", …) |
| `state` | `string` | 2 | lifecycle key: foreground\|visible\|foreground_service\| |

**`SystemLoad`**

| Field | Type | # | Notes |
|---|---|---|---|
| `cpu_busy_pct` | `double` | 1 | optional · Mean busy% over the sampler's last window (0..100). Absent on the first read after start (busy% is a delta) or when the platform cannot report it. |
| `mem_total_bytes` | `uint64` | 2 | optional · absent = unknown |
| `mem_available_bytes` | `uint64` | 3 | optional · absent = unknown (used% derived) |

**`SystemBattery`**

| Field | Type | # | Notes |
|---|---|---|---|
| `level_pct` | `double` | 1 | optional · Absent = unknown (never a fabricated reading). |
| `charging` | `bool` | 2 | optional |
| `live_power_mw` | `double` | 3 | optional |

**`ProcessCounts`**

| Field | Type | # | Notes |
|---|---|---|---|
| `running` | `uint32` | 1 | live processes (any state except Stopped) |
| `cached` | `uint32` | 2 | frozen tombstone tier |
| `stopped` | `uint32` | 3 | dead but kept saved state |

**`ProfileMetrics`** — Rolling decode-throughput + first-token latency measured by the daemon across its stream_chat text turns (see amos-ai/src/profiler.rs). Honest labels: decode_tokens_per_sec is end-to-end "generated tokens streamed to the client per second" (includes backend/network latency); ttft_ms is the mean wall time from a turn starting until its first token arrives.

| Field | Type | # | Notes |
|---|---|---|---|
| `decode_tokens_per_sec` | `double` | 1 | 0 when decode_runs == 0 |
| `ttft_ms` | `double` | 2 | mean first-token latency; 0 when no runs |
| `decode_tokens_total` | `uint64` | 3 | tokens streamed since daemon start |
| `decode_runs` | `uint64` | 4 | completed stream_chat decode turns (>0 ⇒ data) |

**`EnergyPolicy`** — Rolling energy-governor decision from amos-ai/src/energy.rs (amos-power). The governor folds battery level / charger state / temperature / live power / foreground-background usage (env-configured on a host, real HAL on-device) into a recommended sensor mode + throttle flags each tick.

| Field | Type | # | Notes |
|---|---|---|---|
| `sensor_mode` | `string` | 1 | performance \| balanced \| power_save |
| `reason` | `string` | 2 | charging\|healthy\|power_draw\|battery_low\|… (see amos_power::Reason::key) |
| `cap_inference` | `bool` | 3 | governor recommends capping / deferring inference |
| `throttle_background` | `bool` | 4 | governor recommends deferring background work |
| `ticks` | `uint64` | 5 | periodic governor ticks so far (>0 ⇒ data) |

**`GovernorMetrics`** — The daemon's ResourceGovernor live decision (energy → lifecycle → scheduler).

| Field | Type | # | Notes |
|---|---|---|---|
| `sensor_mode` | `string` | 1 | performance \| balanced \| power_save |
| `reason` | `string` | 2 | charging\|healthy\|battery_low\|… (see amos_power::Reason::key) |
| `cap_inference` | `bool` | 3 | — |
| `throttle_background` | `bool` | 4 | — |
| `ticks` | `uint64` | 5 | governor observe ticks so far (>0 ⇒ it has run) |
| `dvfs_applied` | `uint64` | 6 | total scaling_max_freq writes applied by the DVFS beat |
| `dvfs_failed` | `uint64` | 7 | total DVFS write failures the seam reported |
| `dropped` | `uint64` | 8 | deferred jobs whose window expired (never ran) this tick |

**`ListSessionsRequest`**

*(no fields)*

**`SessionInfo`**

| Field | Type | # | Notes |
|---|---|---|---|
| `session_id` | `string` | 1 | — |
| `model` | `string` | 2 | — |
| `tokens_generated` | `uint64` | 3 | tokens produced in this session |
| `cancelled` | `bool` | 4 | — |
| `age_seconds` | `uint64` | 5 | seconds since the session was created |

**`ListSessionsReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `sessions` | repeated `SessionInfo` | 1 | most-recently-active first |
| `count` | `uint32` | 2 | number of sessions returned |

**`ClearSessionsRequest`**

*(no fields)*

**`ClearSessionsReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `removed` | `uint32` | 1 | how many sessions were cleared |

**`RemoveSessionRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `session_id` | `string` | 1 | — |

**`RemoveSessionReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `removed` | `bool` | 1 | true when the session existed and was removed |

**`GetHistoryRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `session_id` | `string` | 1 | — |

**`HistoryTurn`**

| Field | Type | # | Notes |
|---|---|---|---|
| `role` | `string` | 1 | "user" \| "assistant" |
| `text` | `string` | 2 | — |

**`GetHistoryReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `session_id` | `string` | 1 | — |
| `model` | `string` | 2 | — |
| `tokens_generated` | `uint64` | 3 | — |
| `cancelled` | `bool` | 4 | — |
| `turns` | repeated `HistoryTurn` | 5 | completed turns, oldest first |

**`RagIndexRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `id` | `string` | 1 | stable identity (note id / chunk ref) to (re)index under |
| `text` | `string` | 2 | passage body to embed + index |

**`RagIndexReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `indexed` | `bool` | 1 | — |
| `dimension` | `uint32` | 2 | vector dimension after this ingest |

**`RagRemoveRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `id` | `string` | 1 | — |

**`RagRemoveReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `removed` | `bool` | 1 | true when the id was present and dropped |

**`RagQueryRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `query` | `string` | 1 | natural-language query to embed |
| `top_k` | `uint32` | 2 | max hits to return; 0 => daemon default (5) |

**`RagHit`**

| Field | Type | # | Notes |
|---|---|---|---|
| `id` | `string` | 1 | — |
| `score` | `double` | 2 | cosine similarity (higher = closer); 0 for an empty index |
| `passage` | `string` | 3 | the indexed text for that id (for citations) |

**`RagQueryReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `hits` | repeated `RagHit` | 1 | highest-scoring first |
| `count` | `uint32` | 2 | — |

**`RagStatusRequest`**

*(no fields)*

**`RagStatusReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `indexed` | `uint64` | 1 | passages currently indexed |
| `dimension` | `uint32` | 2 | 0 when nothing indexed yet (dimension unknown) |
| `embedder` | `string` | 3 | "mock" \| "ollama" (honest backend label) |

## `android_compat.proto`

Package: `android_compat`

The Tauri System UI never runs an APK directly. It talks to the Amos Rust core over this gRPC surface; the core drives the Android container (Waydroid) via CLI/binder, and the resulting app surface is composited into Tauri windows (Wayland / DMA-BUF texture).

### Services

#### `AndroidManager`

| Method | Request | Reply | Kind | Notes |
|---|---|---|---|---|
| `LaunchAndroidApp` | `AppLaunchRequest` | `AppLaunchResponse` | unary | Launch a legacy Android app in the container and return its surface id. |
| `GetInstalledApps` | `Empty` | `AppListResponse` | unary | List installed apps (so the Tauri Launcher can render their icons). |
| `GetAppIcon` | `AppIconRequest` | `AppIconResponse` | unary | Fetch a PNG icon for an app (extracted from its APK / demo-generated). |
| `OnActivity` | `ActivityEventRequest` | `ActivityEventResponse` | unary | Report a container-observed Activity lifecycle event to the LMK-proxy. The proxy tracks each running task's importance and its freeze/kill candidacy under memory pressure (docs/lmk-proxy.md). |
| `GetLmkSnapshot` | `Empty` | `LmkSnapshot` | unary | Snapshot of every tracked Android task + its current importance tier. |
| `TriggerLmk` | `LmkRequest` | `LmkResponse` | unary | Run the LMK-proxy under memory pressure; returns the freeze/kill victims. |
| `ApplyHostDecision` | `HostActionRequest` | `Empty` | unary | Push a host resource-governor decision back to the container (reverse half of the bridge): freeze/thaw the task tier, or reclaim (force-stop) it. |
| `WatchLmk` | `Empty` | `LmkEvent` | server streaming | Server-streaming LMK event feed: the daemon pushes a real-time stream of container lifecycle decisions (a legacy app was reclaimed/frozen/thawed or its task destroyed). A System UI subscriber uses `window_id` to tear down / refresh the `legacy:<window_id>` surface. Events are best-effort broadcast (a slow/late subscriber just misses them and re-syncs via GetLmkSnapshot). |

### Messages

**`AppIconRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `package_name` | `string` | 1 | — |

**`AppIconResponse`**

| Field | Type | # | Notes |
|---|---|---|---|
| `icon_png` | `bytes` | 1 | raw PNG bytes; empty if no icon available |
| `found` | `bool` | 2 | — |

**`AppLaunchRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `package_name` | `string` | 1 | e.g. "com.tencent.mm" (WeChat) |

**`AppLaunchResponse`**

| Field | Type | # | Notes |
|---|---|---|---|
| `success` | `bool` | 1 | — |
| `window_id` | `string` | 2 | Wayland surface / window id of the launched app |
| `error` | `string` | 3 | non-empty when success is false |

**`AppListResponse`**

| Field | Type | # | Notes |
|---|---|---|---|
| `apps` | repeated `AndroidApp` | 1 | — |

**`AndroidApp`**

| Field | Type | # | Notes |
|---|---|---|---|
| `name` | `string` | 1 | — |
| `package_name` | `string` | 2 | — |
| `icon_path` | `string` | 3 | web path the Tauri frontend can render |
| `activity` | `string` | 4 | main launch activity |

**`ActivityEventRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `package_name` | `string` | 1 | — |
| `event` | `ActivityEvent` | 2 | — |
| `activity_id` | `string` | 3 | Opaque per-activity identity of the emitting activity within the task (e.g. its `ComponentName`+instance or a monotonically-assigned token). When present and consistent, the LMK-proxy folds per-activity lifecycles: a task (container process) is kept alive while >=1 activity lives, and is only torn down on the Destroy of its LAST activity — so finishing a stacked/sub activity doesn't kill the whole app. Absent (empty) → legacy whole-task semantics (a Destroy always tears the task down); the real container adapter that can name activities is what fills this (docs/lmk-proxy.md). |

**`ActivityEventResponse`**

| Field | Type | # | Notes |
|---|---|---|---|
| `state_key` | `string` | 1 | Derived importance key after the event (rank ladder shared with amos_applife / governor.proto): foreground \| visible \| foreground_service \| background \| cached \| stopped. |

**`LmkTask`**

| Field | Type | # | Notes |
|---|---|---|---|
| `package_name` | `string` | 1 | — |
| `window_id` | `string` | 2 | legacy surface registered in amos-wm, if any |
| `state_key` | `string` | 3 | current importance key |

**`LmkSnapshot`**

| Field | Type | # | Notes |
|---|---|---|---|
| `tasks` | repeated `LmkTask` | 1 | — |
| `cached_count` | `uint64` | 2 | — |
| `background_count` | `uint64` | 3 | — |

**`LmkRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `pressure` | `MemoryPressure` | 1 | — |
| `budget` | `uint64` | 2 | max victims this round (0 => no victims) |

**`LmkVictim`**

| Field | Type | # | Notes |
|---|---|---|---|
| `package_name` | `string` | 1 | — |
| `window_id` | `string` | 2 | — |
| `killed` | `bool` | 3 | true = killed (surface torn down); false = frozen |

**`LmkResponse`**

| Field | Type | # | Notes |
|---|---|---|---|
| `victims` | repeated `LmkVictim` | 1 | — |

**`HostActionRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `package_name` | `string` | 1 | — |
| `action` | `HostAction` | 2 | — |

**`LmkEvent`**

| Field | Type | # | Notes |
|---|---|---|---|
| `package_name` | `string` | 1 | — |
| `window_id` | `string` | 2 | the `legacy:<window_id>` surface, if known |
| `kind` | `LmkEventKind` | 3 | — |

**`Empty`**

*(no fields)*

### Enums

**`ActivityEvent`** — A container-observed top-Activity lifecycle event for one package. Values carry the enum-name prefix because protobuf enum values share the package namespace; prost strips the `ACTIVITY_EVENT_` prefix into Rust variants (`Resume`, `Pause`, ...).

| Value | # | Notes |
|---|---|---|
| `ACTIVITY_EVENT_UNSPECIFIED` | 0 | — |
| `ACTIVITY_EVENT_RESUME` | 1 | — |
| `ACTIVITY_EVENT_PAUSE` | 2 | — |
| `ACTIVITY_EVENT_STOP` | 3 | — |
| `ACTIVITY_EVENT_DESTROY` | 4 | — |
| `ACTIVITY_EVENT_STARTED` | 5 | An activity entered the live task (onStart / first observation). In the per-activity model this registers the activity as *alive* so a task is kept until its last activity is destroyed — without demoting an existing top. |

**`MemoryPressure`** — Memory-pressure level fed to the LMK-proxy (mirrors Android `lmkd`).

| Value | # | Notes |
|---|---|---|
| `MEMORY_PRESSURE_UNSPECIFIED` | 0 | — |
| `MEMORY_PRESSURE_NONE` | 1 | — |
| `MEMORY_PRESSURE_LOW` | 2 | — |
| `MEMORY_PRESSURE_CRITICAL` | 3 | — |

**`HostAction`** — A host resource-governor decision about a container-managed app to apply back to the container (reverse half of the bridge, docs/lmk-proxy.md §8).

| Value | # | Notes |
|---|---|---|
| `HOST_ACTION_UNSPECIFIED` | 0 | — |
| `HOST_ACTION_FREEZE` | 1 | — |
| `HOST_ACTION_THAW` | 2 | — |
| `HOST_ACTION_RECLAIM` | 3 | — |

**`LmkEventKind`** — The kind of container lifecycle decision reported on `WatchLmk`.

| Value | # | Notes |
|---|---|---|
| `LMK_EVENT_KIND_UNSPECIFIED` | 0 | — |
| `LMK_EVENT_KIND_RECLAIMED` | 1 | — |
| `LMK_EVENT_KIND_FROZEN` | 2 | — |
| `LMK_EVENT_KIND_THAWED` | 3 | — |
| `LMK_EVENT_KIND_DESTROYED` | 4 | — |

## `governor.proto`

Package: `amos_governor`

Transport: the same UDS as ai_agent / android_compat / telephony / sensor. Design & contract: docs/device-bring-up.md §4.

### Services

#### `Governor`

Resource-governor service exposed by the OS daemon (amos-ai), backed by the amos_ai::governor::ResourceGovernor closed loop. A host registers apps/jobs, moves apps through their lifecycle, and reads the current state; the daemon's periodic beat keeps deciding (energy → freeze/thaw/defer/reclaim) over the same instance.

| Method | Request | Reply | Kind | Notes |
|---|---|---|---|---|
| `RegisterApp` | `AppRef` | `Empty` | unary | — |
| `MoveApp` | `MoveAppRequest` | `Empty` | unary | — |
| `UnregisterApp` | `AppRef` | `Empty` | unary | — |
| `ScheduleJob` | `ScheduleJobRequest` | `Empty` | unary | — |
| `CancelJob` | `JobRef` | `Empty` | unary | — |
| `GetState` | `Empty` | `GovernorState` | unary | — |

### Messages

**`Empty`**

*(no fields)*

**`AppRef`**

| Field | Type | # | Notes |
|---|---|---|---|
| `app_id` | `string` | 1 | — |

**`MoveAppRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `app_id` | `string` | 1 | — |
| `to` | `AppState` | 2 | — |

**`ScheduleJobRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `job_id` | `string` | 1 | — |
| `job_type` | `JobType` | 2 | — |
| `earliest` | `uint64` | 3 | — |
| `latest` | `uint64` | 4 | — |

**`JobRef`**

| Field | Type | # | Notes |
|---|---|---|---|
| `job_id` | `string` | 1 | — |

**`AppInfo`**

| Field | Type | # | Notes |
|---|---|---|---|
| `app_id` | `string` | 1 | — |
| `state` | `AppState` | 2 | — |

**`JobInfo`**

| Field | Type | # | Notes |
|---|---|---|---|
| `job_id` | `string` | 1 | — |
| `job_type` | `JobType` | 2 | — |
| `earliest` | `uint64` | 3 | — |
| `latest` | `uint64` | 4 | — |

**`GovernorDecision`** — The daemon's most recent resource-governor decision (what the closed loop is doing right now): the chosen sensor mode + the throttle/cap recommendations.

| Field | Type | # | Notes |
|---|---|---|---|
| `sensor_mode` | `string` | 1 | performance \| balanced \| power_save |
| `reason` | `string` | 2 | charging\|healthy\|battery_low\|... (see amos_power::Reason::key) |
| `cap_inference` | `bool` | 3 | — |
| `throttle_background` | `bool` | 4 | — |
| `ticks` | `uint64` | 5 | governor observe ticks so far (>0 ⇒ it has run) |

**`GovernorState`**

| Field | Type | # | Notes |
|---|---|---|---|
| `apps` | repeated `AppInfo` | 1 | — |
| `jobs` | repeated `JobInfo` | 2 | — |
| `background_count` | `uint64` | 3 | — |
| `decision` | `GovernorDecision` | 4 | last tick; ticks==0 ⇒ not run yet |

### Enums

**`AppState`** — Target lifecycle state for a registered app (see amos-applife AppState). Values carry the enum-name prefix because protobuf enum values share the package namespace; prost strips the `APP_STATE_` prefix into Rust variants.

| Value | # | Notes |
|---|---|---|
| `APP_STATE_UNSPECIFIED` | 0 | — |
| `APP_STATE_FOREGROUND` | 1 | — |
| `APP_STATE_BACKGROUND` | 2 | — |
| `APP_STATE_CACHED` | 3 | — |
| `APP_STATE_FOREGROUND_SERVICE` | 4 | — |
| `APP_STATE_STOPPED` | 5 | — |

**`JobType`** — Whether a scheduled job is an exact user alarm or deferrable background work.

| Value | # | Notes |
|---|---|---|
| `JOB_TYPE_UNSPECIFIED` | 0 | — |
| `JOB_TYPE_ALARM_EXACT` | 1 | — |
| `JOB_TYPE_DEFERRED` | 2 | — |

## `netguard.proto`

Package: `amos_netguard`

Honest boundaries (docs/anti-telemetry-egress-guard.md): * This gates and audits the Android **userspace / app data plane** only. It cannot reach the modem/baseband (a separate processor/trust domain), so "arm the guard" never claims to block the SoC's own backhaul. * `StatusReply.enforced` is true ONLY when a real backend (Android VpnService on a non-rooted device, or nftables in an AOSP/rooted build) is actually enforcing. On the default host build the backend is the in-process Mock and `enforced` is false — arming records intent, never a fabricated "blocked".

### Services

#### `NetGuardService`

| Method | Request | Reply | Kind | Notes |
|---|---|---|---|---|
| `Toggle` | `ToggleRequest` | `ToggleReply` | unary | Arm or disarm the egress guard. |
| `Status` | `StatusRequest` | `StatusReply` | unary | Current armed state + backend + small audit summary. |
| `NoteEgress` | `NoteEgressRequest` | `NoteEgressReply` | unary | TEST/INJECTION: fold one metadata egress event into the audit counter so `Status.top_egress` reflects a feed. Served ONLY when the process opts in via `AMOS_NETGUARD_ALLOW_INJECT=1` (off on every production boot, mirroring the telemetry-spy `SimulateHit` gate); otherwise PermissionDenied. A real device producer (VpnService / nftables observability) feeds the same counter directly and needs no RPC. |

### Messages

**`ToggleRequest`** — Arm / disarm the guard (records user intent in the daemon).

| Field | Type | # | Notes |
|---|---|---|---|
| `enabled` | `bool` | 1 | — |

**`ToggleReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `enabled` | `bool` | 1 | The post-toggle armed state. |
| `message` | `string` | 2 | Human-readable confirmation / caveat ("armed; mock backend, not enforced"). |

**`StatusRequest`**

*(no fields)*

**`EgressSample`** — One top egress domain (by bytes) from the daemon's rolling counter.

| Field | Type | # | Notes |
|---|---|---|---|
| `domain` | `string` | 1 | — |
| `bytes` | `uint64` | 2 | — |

**`StatusReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `enabled` | `bool` | 1 | User intent: is the guard armed? |
| `backend` | `string` | 2 | The enforcement backend in use: "mock" (default host) \| "vpn" \| "nftables". |
| `enforced` | `bool` | 3 | True ONLY when a real backend is actually enforcing on this device. |
| `policy_rules` | `uint64` | 4 | Number of egress policy rules the guard holds. |
| `top_egress` | repeated `EgressSample` | 5 | Top domains by bytes in the current audit window (empty when no data). |

**`NoteEgressRequest`** — One metadata egress signal to fold into the guard's rolling audit counter that backs `StatusReply.top_egress`. Carries destination domain / SNI + bytes only — never payload contents (docs/anti-telemetry-egress-guard.md §3.2).

| Field | Type | # | Notes |
|---|---|---|---|
| `ts_ms` | `uint64` | 1 | Wall-clock ms (UTC) when observed. |
| `uid` | `uint32` | 2 | The Android uid that produced the traffic. |
| `app` | `string` | 3 | The app package name, when resolvable. |
| `domain` | `string` | 4 | The observed destination domain / SNI (empty => unknown). |
| `bytes` | `uint64` | 5 | Bytes attributed to this event (0 when unknown). |
| `kind` | `EgressKind` | 6 | The metadata signal kind. |

**`NoteEgressReply`**

*(no fields)*

### Enums

**`EgressKind`** — The metadata signal kind that produced one audited egress event.

| Value | # | Notes |
|---|---|---|
| `EGRESS_KIND_UNSPECIFIED` | 0 | — |
| `EGRESS_KIND_DNS` | 1 | A DNS query for a hostname. |
| `EGRESS_KIND_TLS` | 2 | A TLS ClientHello (SNI observed). |
| `EGRESS_KIND_OTHER` | 3 | Other userspace data-plane traffic not classified by a higher-level signal. |

## `privacy.proto`

Package: `amos_privacy`

Domain core & honesty boundaries: docs/permissions-sandbox-audit-plan.md.

### Services

#### `PrivacyService`

| Method | Request | Reply | Kind | Notes |
|---|---|---|---|---|
| `Grant` | `GrantRequest` | `GrantReply` | unary | Grant one resource to an app (persists when the daemon has a state file). |
| `Revoke` | `GrantRequest` | `GrantReply` | unary | Revoke one resource from an app. |
| `RevokeAll` | `AppRef` | `GrantReply` | unary | Revoke every grant for an app (uninstall / sandbox teardown). |
| `Authorize` | `ResourceRef` | `DecisionReply` | unary | The single decision chokepoint: answer + audit one access request. |
| `Granted` | `AppRef` | `AppGrants` | unary | Cheap, non-auditing check: the resources an app currently holds. |
| `GrantedAll` | `AllGrantsRequest` | `AllGrantsReply` | unary | Every app holding at least one grant (one round-trip for a dashboard). |
| `RecentAudit` | `AuditQuery` | `AuditReply` | unary | Recent audited access decisions (newest first, optional filters). |
| `RecentTrail` | `AuditQuery` | `TrailReply` | unary | The **unified** durable trail (newest first) — privacy decisions plus every record ingested via `RecordAudit` (device-care cleans, app uninstalls). Filters reuse `AuditQuery`: `app_id` → principal, `resource` → resource. |
| `RecordAudit` | `AuditRecord` | `GrantReply` | unary | The daemon **stamps the timestamp with its own clock** (the audit time is the daemon's authority, not the caller's) and validates `outcome` against the known set. `ok = false` means the record was NOT persisted — the daemon has no durable sink configured (`AMOS_PRIVACY_PATH` unset) — so a caller can report the honest state instead of assuming the trail exists. |

### Messages

**`AppRef`** — An app (or other principal) id.

| Field | Type | # | Notes |
|---|---|---|---|
| `app_id` | `string` | 1 | — |

**`ResourceRef`** — A grant to (or access check for) one app + one sensitive resource.

| Field | Type | # | Notes |
|---|---|---|---|
| `app_id` | `string` | 1 | — |
| `resource` | `string` | 2 | stable wire key, see file header |

**`GrantRequest`** — grant / revoke carry the same shape.

| Field | Type | # | Notes |
|---|---|---|---|
| `app_id` | `string` | 1 | — |
| `resource` | `string` | 2 | — |

**`GrantReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `ok` | `bool` | 1 | — |
| `message` | `string` | 2 | — |

**`DecisionReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `app_id` | `string` | 1 | — |
| `resource` | `string` | 2 | — |
| `granted` | `bool` | 3 | true iff the app holds a grant (Authorize audits the check) |

**`AppGrants`** — The resources an app currently holds (deny-by-default => often empty).

| Field | Type | # | Notes |
|---|---|---|---|
| `app_id` | `string` | 1 | — |
| `resources` | repeated `string` | 2 | — |

**`AllGrantsRequest`** — Every app that holds at least one grant, so a dashboard never has to ask app-by-app. Deny-by-default ⇒ this is empty until something is granted.

*(no fields)*

**`AllGrantsReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `apps` | repeated `AppGrants` | 1 | sorted by app id, resources sorted |

**`AuditRecord`** — Normalised audit record (mirrors amos-ai::audit::AuditRecord). `outcome` is one of "granted" \| "denied" \| "success" \| "rejected" \| "error".

| Field | Type | # | Notes |
|---|---|---|---|
| `ts` | `uint64` | 1 | — |
| `principal` | `string` | 2 | — |
| `op` | `string` | 3 | — |
| `resource` | `string` | 4 | — |
| `outcome` | `string` | 5 | — |
| `details` | `string` | 6 | — |

**`AuditQuery`** — Optional filters over the recent audit window; empty = any.

| Field | Type | # | Notes |
|---|---|---|---|
| `app_id` | `string` | 1 | — |
| `resource` | `string` | 2 | — |
| `limit` | `uint32` | 3 | clamp: 1..=1000 (0 => default 200) |

**`AuditReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `records` | repeated `AuditRecord` | 1 | newest first |

**`TrailReply`** — `durable = false` means no sink is attached at all (`AMOS_PRIVACY_PATH` unset), so a trail cannot exist — a caller must NOT render the empty list as "nothing ever happened".

| Field | Type | # | Notes |
|---|---|---|---|
| `records` | repeated `AuditRecord` | 1 | — |
| `durable` | `bool` | 2 | — |

## `sensor.proto`

Package: `amos_sensor`

Transport: the same Unix Domain Socket as ai_agent / android_compat / telephony (single UDS for the whole OS backend). Design & contract: docs/sensors.md. This is the *service bus* on top of the amos-sensor domain core. Raw camera frame *bytes* are NOT shipped here (a frame stream belongs on a dedicated media channel with the real HAL); the service exposes capability listing, GNSS/IMU readings, the energy mode, and the PowerSave-gated stream-acquisition contract.

### Services

#### `Sensor`

Device-sensor service exposed by the OS daemon (amos-ai), backed by the amos-sensor domain core (SensorManager + SensorProvider). Unary, pull-based. AcquireStream is the energy-gated declaration of a continuous stream: it is refused in POWER_SAVE above the family ceiling / always above the hardware ceiling.

| Method | Request | Reply | Kind | Notes |
|---|---|---|---|---|
| `ListCameras` | `Empty` | `CameraList` | unary | — |
| `CaptureCamera` | `CameraCaptureRequest` | `CameraCaptureReply` | unary | — |
| `GetGnss` | `Empty` | `GnssReply` | unary | — |
| `GetImu` | `Empty` | `ImuReply` | unary | — |
| `GetMode` | `Empty` | `ModeReply` | unary | — |
| `SetMode` | `SetModeRequest` | `ModeReply` | unary | — |
| `AcquireStream` | `AcquireRequest` | `AcquireReply` | unary | — |

### Messages

**`Empty`**

*(no fields)*

**`CameraDesc`**

| Field | Type | # | Notes |
|---|---|---|---|
| `id` | `uint32` | 1 | — |
| `width` | `uint32` | 2 | — |
| `height` | `uint32` | 3 | — |
| `fps` | `uint32` | 4 | — |
| `format` | `PixelFormat` | 5 | — |

**`CameraList`**

| Field | Type | # | Notes |
|---|---|---|---|
| `cameras` | repeated `CameraDesc` | 1 | — |

**`CameraCaptureRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `id` | `uint32` | 1 | — |

**`CameraCaptureReply`** — Frame *metadata* (no raw bytes here — see module docs). Enough to prove a real capture path and to size a future media channel.

| Field | Type | # | Notes |
|---|---|---|---|
| `id` | `uint32` | 1 | — |
| `seq` | `uint64` | 2 | — |
| `width` | `uint32` | 3 | — |
| `height` | `uint32` | 4 | — |
| `format` | `PixelFormat` | 5 | — |
| `payload_len` | `uint64` | 6 | — |

**`GnssReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `enabled` | `bool` | 1 | — |
| `has_fix` | `bool` | 2 | — |
| `latitude_deg` | `double` | 3 | — |
| `longitude_deg` | `double` | 4 | — |
| `altitude_m` | `double` | 5 | — |
| `accuracy_m` | `double` | 6 | — |
| `fix_mode` | `FixMode` | 7 | — |
| `sats_in_view` | `uint32` | 8 | — |
| `timestamp_ms` | `uint64` | 9 | — |

**`Vec3`**

| Field | Type | # | Notes |
|---|---|---|---|
| `x` | `double` | 1 | — |
| `y` | `double` | 2 | — |
| `z` | `double` | 3 | — |

**`ImuReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `timestamp_ms` | `uint64` | 1 | — |
| `accel_m_s2` | `Vec3` | 2 | — |
| `gyro_rad_s` | `Vec3` | 3 | — |
| `temperature_c` | `float` | 4 | — |
| `rate_hz` | `uint32` | 5 | — |

**`SetModeRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `mode` | `SensorMode` | 1 | — |

**`ModeReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `mode` | `SensorMode` | 1 | — |

**`AcquireRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `kind` | `SensorKind` | 1 | — |
| `rate_hz` | `uint32` | 2 | — |

**`AcquireReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `allowed` | `bool` | 1 | — |
| `error` | `string` | 2 | — |

### Enums

**`SensorMode`**

| Value | # | Notes |
|---|---|---|
| `PERFORMANCE` | 0 | — |
| `BALANCED` | 1 | — |
| `POWER_SAVE` | 2 | — |

**`SensorKind`**

| Value | # | Notes |
|---|---|---|
| `CAMERA` | 0 | — |
| `GNSS` | 1 | — |
| `IMU` | 2 | — |

**`PixelFormat`**

| Value | # | Notes |
|---|---|---|
| `RGBA8` | 0 | — |
| `NV21` | 1 | — |

**`FixMode`**

| Value | # | Notes |
|---|---|---|
| `NO_FIX` | 0 | — |
| `TWO_DIM` | 1 | — |
| `THREE_DIM` | 2 | — |

## `telemetry_spy.proto`

Package: `amos_telemetry_spy`

Honest boundaries (mirrors docs/anti-telemetry-egress-guard.md and crates/amos-telemetry-spy): * A hit means a device-bound identifier (hardware serial / IMEI / serving cell ID) was found as a **plaintext substring** in an outbound payload. This is a brittle, low-confidence heuristic — encrypted flows hide it and naive scanning over-reports — so every hit carries an evidence `confidence` grade and is NOT claimed to be a confirmed leak. * The spy sees the AP / app data plane only (e.g. rmnet_data0); it cannot observe the modem/baseband's own backhaul (a separate trust domain). * `Watch` only yields events when a real capture backend (rooted / AmOS-AOSP pnet slot) is actually running. On the default host build the stream is empty or the Arm errors — never a fabricated hit.

### Services

#### `TelemetrySpyService`

| Method | Request | Reply | Kind | Notes |
|---|---|---|---|---|
| `Watch` | `Empty` | `EgressHit` | server streaming | Live server-streaming of high-severity audit hits. |
| `SimulateHit` | `EgressHit` | `Empty` | unary | Test/demo injection: publish one hit onto the Watch fan-out so a real UDS e2e can drive the chain (subscribe -> SimulateHit -> receive). Honest & safe by default: the daemon rejects this with PermissionDenied unless the `AMOS_SPY_ALLOW_INJECT` env var is set (off on every production boot). |

### Messages

**`Empty`** — Subscribe to live high-severity audit hits from the telemetry-spy capture.

*(no fields)*

**`IdentifierHit`** — One graded identifier hit folded into the audit event.

| Field | Type | # | Notes |
|---|---|---|---|
| `kind` | `IdentifierKind` | 1 | — |
| `occurrences` | `uint32` | 2 | — |
| `confidence` | `Confidence` | 3 | — |

**`EgressHit`** — A single high-severity audit event produced by the spy.

| Field | Type | # | Notes |
|---|---|---|---|
| `ts_ms` | `uint64` | 1 | Wall-clock milliseconds (UTC) when the frame was observed. |
| `iface` | `string` | 2 | The interface the frame was captured on (e.g. rmnet_data0). |
| `src_ip` | `string` | 3 | Source IP text form. |
| `src_port` | `uint32` | 4 | optional · Source port, when the transport carried one. |
| `dst_ip` | `string` | 5 | Destination IP text form. |
| `dst_port` | `uint32` | 6 | optional · Destination port, when the transport carried one. |
| `protocol` | `Protocol` | 7 | — |
| `hits` | repeated `IdentifierHit` | 8 | The graded identifier hits. |
| `payload_bytes` | `uint64` | 9 | Payload window size that was scanned. |
| `severity` | `string` | 10 | Severity (always HIGH for a hit) and strongest evidence grade. |
| `confidence` | `Confidence` | 11 | — |

### Enums

**`Confidence`** — One evidence grade carried on an EgressHit.

| Value | # | Notes |
|---|---|---|
| `CONFIDENCE_UNSPECIFIED` | 0 | — |
| `CONFIDENCE_LOW` | 1 | — |
| `CONFIDENCE_MEDIUM` | 2 | — |
| `CONFIDENCE_HIGH` | 3 | — |

**`IdentifierKind`** — Which device-bound identifier leaked.

| Value | # | Notes |
|---|---|---|
| `KIND_UNSPECIFIED` | 0 | — |
| `KIND_SERIAL` | 1 | — |
| `KIND_IMEI` | 2 | — |
| `KIND_CELL_ID` | 3 | — |

**`Protocol`** — The transport the hit was observed on.

| Value | # | Notes |
|---|---|---|
| `PROTOCOL_UNSPECIFIED` | 0 | — |
| `PROTOCOL_TCP` | 1 | — |
| `PROTOCOL_UDP` | 2 | — |
| `PROTOCOL_ICMP` | 3 | — |
| `PROTOCOL_OTHER` | 4 | — |

## `telephony.proto`

Package: `amos_telephony`

Transport: the same Unix Domain Socket as ai_agent / android_compat (single UDS for the whole OS backend). Design & contract: docs/telephony.md.

### Services

#### `Telephony`

Dial/Answer/End are unary; Status lists live calls; Watch streams the signalling events the UI (and AI assistant) need to react to (incoming call, connected, remote hangup). StartRecording/StopRecording toggle call recording (only legal while a call is ACTIVE + non-emergency) and return the authoritative snapshot so the UI can reflect the recording state without a round-trip.

| Method | Request | Reply | Kind | Notes |
|---|---|---|---|---|
| `Dial` | `DialRequest` | `CallIdMsg` | unary | — |
| `Answer` | `AnswerRequest` | `CallIdMsg` | unary | — |
| `End` | `EndRequest` | `CallIdMsg` | unary | — |
| `StartRecording` | `CallIdMsg` | `CallSnapshot` | unary | — |
| `StopRecording` | `CallIdMsg` | `CallSnapshot` | unary | — |
| `SimulateIncoming` | `SimulateIncomingRequest` | `CallIdMsg` | unary | — |
| `Status` | `StatusRequest` | `CallList` | unary | — |
| `Watch` | `WatchRequest` | `CallStateEvent` | server streaming | — |

### Messages

**`CallIdMsg`**

| Field | Type | # | Notes |
|---|---|---|---|
| `id` | `string` | 1 | — |

**`DialRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `number` | `string` | 1 | — |
| `emergency` | `bool` | 2 | emergency=true routes to the privileged emergency provider (110/112/911/...), which is never gated by the ordinary rate limiter. |

**`SimulateIncomingRequest`** — Dev/demo-only: simulate a ringing incoming call from `number` (mock backend). A real provider rejects this — incoming calls come from the network, not a client.

| Field | Type | # | Notes |
|---|---|---|---|
| `number` | `string` | 1 | — |

**`AnswerRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `call` | `CallIdMsg` | 1 | — |

**`EndRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `call` | `CallIdMsg` | 1 | — |

**`StatusRequest`**

*(no fields)*

**`WatchRequest`**

*(no fields)*

**`CallSnapshot`**

| Field | Type | # | Notes |
|---|---|---|---|
| `call` | `CallIdMsg` | 1 | — |
| `peer` | `string` | 2 | — |
| `direction` | `CallDirection` | 3 | — |
| `state` | `CallState` | 4 | — |
| `end_reason` | `EndReason` | 5 | — |
| `emergency` | `bool` | 6 | — |
| `recording` | `RecordingState` | 7 | — |

**`CallList`**

| Field | Type | # | Notes |
|---|---|---|---|
| `calls` | repeated `CallSnapshot` | 1 | — |

**`CallStateEvent`**

| Field | Type | # | Notes |
|---|---|---|---|
| `call` | `CallSnapshot` | 1 | — |

### Enums

**`CallDirection`**

| Value | # | Notes |
|---|---|---|
| `OUTGOING` | 0 | — |
| `INCOMING` | 1 | — |

**`CallState`**

| Value | # | Notes |
|---|---|---|
| `IDLE` | 0 | — |
| `DIALING` | 1 | — |
| `RINGING` | 2 | — |
| `ACTIVE` | 3 | — |
| `ENDED` | 4 | — |

**`EndReason`**

| Value | # | Notes |
|---|---|---|
| `LOCAL` | 0 | — |
| `REMOTE` | 1 | — |
| `FAILED` | 2 | — |
| `EMERGENCY` | 3 | — |

**`RecordingState`** — Whether the call is being recorded. A call may only start recording once it is ACTIVE and non-emergency; FAILED means the backend reported a recording error.

| Value | # | Notes |
|---|---|---|
| `RECORDING_OFF` | 0 | — |
| `RECORDING_ON` | 1 | — |
| `RECORDING_FAILED` | 2 | — |

## `translate.proto`

Package: `translate`

The System UI / amos-ai talks to the dedicated `amos-translate` daemon over this gRPC surface (Unix Domain Socket). The daemon routes translation through a pluggable provider (Ollama / Hermes / API), keeping the model backend swappable without touching the transport or UI layers.

### Services

#### `Translator`

| Method | Request | Reply | Kind | Notes |
|---|---|---|---|---|
| `Translate` | `TranslateRequest` | `TranslateResponse` | unary | Unary text translation. |
| `Transcribe` | `TranscribeRequest` | `TranscribeResponse` | unary | Speech-to-text: transcribe an audio segment (drives the hardware Voice button). `recognized=false` when no recognizer is configured or it fails. |
| `StreamTranslate` | `TranslateIn` | `TranslateOut` | bidirectional streaming | Bidirectional streaming for simultaneous interpretation: the client sends source segments (text now; audio once ASR is wired), the daemon streams back translated segments as they complete. |
| `GetStatus` | `StatusRequest` | `StatusReply` | unary | Liveness / model probe used by the System UI. |

### Messages

**`TranscribeRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `audio` | `bytes` | 1 | audio bytes (wav / webm / raw) |
| `language` | `string` | 2 | e.g. "zh"; empty = auto |
| `format` | `string` | 3 | e.g. "wav", "webm"; empty = auto |

**`TranscribeResponse`**

| Field | Type | # | Notes |
|---|---|---|---|
| `text` | `string` | 1 | transcribed text |
| `recognized` | `bool` | 2 | false when no recognizer configured or the call failed |

**`TranslateRequest`**

| Field | Type | # | Notes |
|---|---|---|---|
| `text` | `string` | 1 | text to translate |
| `source_lang` | `string` | 2 | e.g. "en", "zh"; empty = auto-detect |
| `target_lang` | `string` | 3 | e.g. "zh" |

**`TranslateResponse`**

| Field | Type | # | Notes |
|---|---|---|---|
| `translated` | `string` | 1 | the translated text |
| `detected_lang` | `string` | 2 | detected source language (empty when given) |

**`TranslateIn`**

| Field | Type | # | Notes |
|---|---|---|---|
| `text` | `string` | 1 | in `oneof payload` · a source segment |
| `audio` | `bytes` | 2 | in `oneof payload` · optional audio segment (ASR not wired yet) |

**`TranslateOut`**

| Field | Type | # | Notes |
|---|---|---|---|
| `segment` | `string` | 1 | one translated segment |
| `done` | `bool` | 2 | true on the terminal frame of the stream |

**`StatusRequest`**

*(no fields)*

**`StatusReply`**

| Field | Type | # | Notes |
|---|---|---|---|
| `running` | `bool` | 1 | — |
| `model` | `string` | 2 | — |
| `source_lang` | `string` | 3 | — |
| `target_lang` | `string` | 4 | — |
