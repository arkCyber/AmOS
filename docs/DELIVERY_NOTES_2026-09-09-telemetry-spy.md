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

1. ~~**真实 pnet 抓网卡 producer** 仅剩设备/AOSP 接线~~ → **已补全（2026-09-09）**：daemon 侧
   producer 已落地为 `amos-ai::telemetry_spy_capture`（feature `telemetry-spy-audit`），
   `serve()` 持共享 `TelemetrySpySvc` 并在编译期启用该 feature 时按环境变量启动；见下方 §5。
   仍需真机验收的只剩「打开 raw datalink 的 root/AmOS-AOSP 通道」本身。
2. 默认 host 构建无 producer → `Watch` 静默，**绝不产生伪造 hit**（no-fake-success）。
3. `SimulateHit` 注入 RPC 需进程显式设 `AMOS_SPY_ALLOW_INJECT=1`，生产 boot 默认只读。
4. ~~前端 `spyNotif` 中性英文 / 无设置页入口~~ → **已补（2026-09-09）**：en/zh i18n key +
   「设置 → 隐私与安全性 → 外发泄漏审计」入口页；命中通知文案随当前语言本地化。
5. 抓包只见 AP/App 数据面、明文启发式低置信、per-frame 无 TCP 重组 / IP 分片重组——
   均为文档声明的边界。

---

## 5. 跟进增量（2026-09-09，工作树内，尚未提交）

### A. daemon 侧真实 capture producer（打通 NIC → Watch）
- `crates/amos-ai/src/telemetry_spy_capture.rs`（feature `telemetry-spy-audit` = `telemetry-spy`
  + `amos-telemetry-spy/audit`）：解析环境（`AMOS_SPY_IFACE` / `AMOS_SPY_LAYER3` /
  `AMOS_SPY_IDS`，`kind=value` 逗号分隔），`spawn_stream` 开网卡并 `tokio::spawn` 逐帧调
  `ingest_match`。诚实门：接口未设或标识为空**拒绝启动并记录日志**（绝不空扫/伪造）。
- `server.rs` `serve()`：预先构造**共享** `TelemetrySpySvc`（`#[derive(Clone)]` 共用 broadcast），
  用 `telemetry_spy_service::server_for` 挂载；feature 下经 `spawn_configured` 启动 producer，
  关停时 `stop_request` + abort。
- 验证：默认 + `--features telemetry-spy-audit` 的 `cargo check`/`clippy -D warnings`/`fmt --check`
  干净；`cargo test -p amos-ai --features telemetry-spy-audit --lib telemetry_spy_` → **11 passed**
  （含 5 个 producer 解析/拒绝单测 + 既有 ingest_match e2e seam）。`cargo check -p
  amos-telemetry-spy --features audit` 干净。

### B. 前端本地化 + 设置入口（顺带补全，见上一步交付）
- `frontend-ts/lib/telemetrySpy.ts`：`spyNotif`/`recordSpyHit` 增可选 `fmt` 翻译器，命中通知随
  语言本地化且仍**不回显标识明文**；新增 `kindKey`/`confidenceKey`。
- `App.tsx`：向 `recordSpyHit(hit, t)` 传入实时 `t`。
- i18n `zh.ts`/`en.ts`：新增 `settings.spy` + `spy.*` 键（MessageKey 强制 en 全量对齐）。
- 新增 `svelte/settings/TelemetrySpyPage.svelte` + `SettingsApp.svelte` 注册
  「外发泄漏审计 / Outbound Leak Audit」子页（隐私与安全性组，含 Quiet/Watching 状态行与诚实边界）。
- 验证：`telemetrySpy.test.ts` 9 pass；`tsc --noEmit` / `svelte-check` / `bun-iso test` 全绿。

### 建议提交（按仓库风格）
```text
feat(telemetry-spy): daemon capture producer (feature telemetry-spy-audit) + frontend i18n/settings entry
```
涉及文件：`crates/amos-ai/{Cargo.toml,src/lib.rs,src/server.rs,src/telemetry_spy_service.rs,
src/telemetry_spy_capture.rs}`、`frontend-ts/…{telemetrySpy.ts,App.tsx,i18n/locales/{zh,en}.ts,
SettingsApp.svelte,settings/TelemetrySpyPage.svelte,telemetrySpy.test.ts}`、`docs/telemetry-spy.md`、
`docs/DELIVERY_NOTES_2026-09-09-telemetry-spy.md`。
