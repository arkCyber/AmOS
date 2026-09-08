# 交付说明与遗留清单 (Delivery Notes & Known Limits)

**日期**: 2026-09-09
**范围**: 被动外发审计链 `amos-telemetry-spy`（无感异步审计网卡）→ daemon gRPC
`TelemetrySpyService` → `amos-tauri` 事件桥 → 前端 System UI 实时警告。供提交/归档使用。
**状态基线**: 工作树（含此前未提交的 `amos-network-guard` 等）之上，本段全部改动未提交。
**主设计文档**: `docs/telemetry-spy.md`（域核心 + 接线图 + 诚实边界）。

---

## 1. 可直接使用的提交说明（commit message）

按仓库既有提交风格（`feat(scope): …`）组织，覆盖本段全部改动。

```
feat(telemetry-spy): passive egress audit NIC + daemon gRPC Watch + System UI warning

Add a read-only, non-blocking audit layer that watches a data interface (e.g.
rmnet_data0) for device-bound identifiers (hardware serial / IMEI / serving cell
ID) leaking in outbound payloads, and pushes high-severity hits end-to-end to the
System UI as a notification. Honest boundaries: sees the AP/app data plane only
(not modem/baseband); a plaintext substring is a low-confidence heuristic, never a
claimed leak; default host build has no capture producer, so the chain is quiet.

New crate crates/amos-telemetry-spy (pure std by default)
- identifier: serial/IMEI/cell-ID byte-token model.
- scanner: pure payload heuristic + Confidence grading (tokens < 3B ignored).
- packet: pure-std Ethernet/IPv4/IPv6/TCP/UDP parser (no pnet_packet) — decode+scan
  unit-tested in the default build; fixed an IPv4 out-of-bounds panic.
- signal: EgressMatch high-severity audit event.
- identity: DeviceIdentity seam + clearly-fake MockIdentity (no silent drops).
- capture (feature `audit`): pnet sniff of rmnet_data0 → Tokio spawn_blocking async
  bridge (spawn_stream); no fake success — missing interface errors at spawn.
- analyze: pure decode→scan→signal glue (match_frame).

Wire contract + daemon (crates/amos-proto, amos-ai)
- proto/telemetry_spy.proto: TelemetrySpyService.Watch(stream EgressHit) +
  SimulateHit (test/demo injection, off unless AMOS_SPY_ALLOW_INJECT=1).
- amos-ai::telemetry_spy_service: TelemetrySpySvc with a tokio broadcast fan-out;
  Watch streams via BroadcastStream; mounted in serve() on the shared UDS.
- feature `telemetry-spy`: EgressMatch→EgressHit mapping + TelemetrySpySvc::ingest_match
  feed seam (host-tested; on device a pnet reader just calls ingest_match).
- fixed amos-ai::netguard_service tests calling status(Request::new(())).

System UI + frontend (crates/amos-tauri, frontend-ts)
- telemetry_spy.rs: spawn_telemetry_spy_watch re-emits daemon hits as
  `telemetry-spy-hit` (serializable SpyHitPayload; backoff reconnect).
- lib/telemetrySpy.ts: defensive toSpyHit + spyNotif writes NOTIF_KEY; the payload
  never echoes the actual serial/IMEI/cell-ID value.
- App.tsx effect subscribes (bridged) and records hits to the notification store.

Verification: amos-telemetry-spy default 23 / audit 24 tests; amos-ai
telemetry_spy_service default 5 / --features telemetry-spy 6; real-UDS daemon e2e
tests/telemetry_spy_rpc_e2e.rs (boot serve() → Watch → SimulateHit → hit) 1;
amos-tauri telemetry_spy 2; frontend telemetrySpy.test.ts 7 + full [bun-iso] OK;
clippy -D warnings / fmt clean on the touched crates.
```

## 2. 改动清单（改了什么）

### 新增文件
- `crates/amos-telemetry-spy/`（新 member crate：`Cargo.toml` + `src/{lib,error,identifier,
  identity,scanner,packet,analyze,signal,capture}.rs` + `examples/live_spy.rs`）
- `proto/telemetry_spy.proto`
- `crates/amos-ai/src/telemetry_spy_service.rs`
- `crates/amos-ai/tests/telemetry_spy_rpc_e2e.rs`
- `crates/amos-tauri/src/telemetry_spy.rs`
- `frontend-ts/src/lib/telemetrySpy.ts` + `src/__tests__/telemetrySpy.test.ts`
- `docs/telemetry-spy.md`

### 修改
- `Cargo.toml`（workspace members + `[workspace.dependencies]` `pnet`、
  `amos-telemetry-spy` path）
- `crates/amos-proto/build.rs` + `src/lib.rs`（注册 `amos_telemetry_spy`）
- `crates/amos-ai/Cargo.toml`（optional `amos-telemetry-spy` + `telemetry-spy` feature）、
  `src/lib.rs`（登记 `telemetry_spy_service`）、`src/server.rs`（`serve()` 挂载）、
  `src/netguard_service.rs`（修 3 处测试传 `StatusRequest`）
- `crates/amos-tauri/src/lib.rs`（登记 `mod telemetry_spy` + `setup()` 启动 watch）、
  `src/App.tsx`（守卫 effect 订阅并把命中写通知存储）

## 3. 门禁与验证汇总

- `cargo test -p amos-telemetry-spy` → 23 passed；`--features audit` → 24 passed。
- `cargo test -p amos-ai --lib telemetry_spy_service::` → 5；`--features telemetry-spy` → 6。
- `cargo test -p amos-ai --test telemetry_spy_rpc_e2e` → 1（真 UDS，boot `serve()`）。
- `cargo test -p amos-tauri --lib telemetry_spy::` → 2。
- frontend：`bun test src/__tests__/telemetrySpy.test.ts` 7 pass；`tsc --noEmit` clean；
  全量 `node scripts/bun-iso-test.mjs test` → `[bun-iso] test OK`。
- `cargo clippy`（amos-proto / amos-ai 默认+`telemetry-spy` / amos-tauri）
  `-- -D warnings` 干净；`cargo fmt --check` 干净。

## 4. 已知限制 / 遗留（诚实）

1. **真实 pnet 抓网卡 producer**（rooted/AmOS-AOSP + `audit` feature）打开 `rmnet_data0` 并
   对每帧命中调 `TelemetrySpySvc::ingest_match` —— 是唯一“设备才能验证”的动作；接线草图在
   `docs/telemetry-spy.md`，逐字段映射已 host 单测。
2. 默认 host 构建无 producer → `Watch` 静默，**绝不产生伪造 hit**（no-fake-success）。
3. `SimulateHit` 注入 RPC 需进程显式设 `AMOS_SPY_ALLOW_INJECT=1`，生产 boot 默认只读。
4. 前端 `spyNotif` 用中性英文文案（未补 en/zh i18n key / 专门设置页入口），纯可选打磨。
5. 抓包只见 AP/App 数据面、明文启发式低置信、per-frame 无 TCP 重组 / IP 分片重组——
   均为文档声明的边界。
