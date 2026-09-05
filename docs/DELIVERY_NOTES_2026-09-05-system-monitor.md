# 交付说明与遗留清单 (Delivery Notes & Known Limits) — System Monitor

**日期**: 2026-09-05
**范围**: 系统「工作状况监控」从零到一条全链路——`amos-monitor` domain-core crate、
daemon 聚合（`GetStatus.system` + 周期心跳日志）、proto 契约、Tauri `system_health`
桥、Settings「系统工作状况」面板（CPU/内存/电量/进程档 + governor 已注册 app 清单，
自动刷新）。本文件供提交/归档使用。
**状态基线**: 工作树（在 `main` 之上有大量其他未提交 WIP，本段改动叠加其上）。
**主设计文档**: `docs/system-monitor.md`。

---

## 1. 可直接使用的提交说明（commit message）

```
feat(monitor): system working-status — amos-monitor domain core +
daemon GetStatus.system/heartbeat + Tauri system_health bridge + Settings panel

Add a transport-/platform-agnostic system-health domain core and wire it end to
end so the OS reports one honest "working status" (CPU/memory, battery/power,
per-app process tiers) over get_status and in the daemon log.

Domain core (crates/amos-monitor, pure std)
- spec: SystemLoad/CpuSample/MemoryInfo/BatteryStatus/ProcessSummary/SystemHealth
  (Option = unknown, never fabricated; one-line summary()).
- sampler: SystemSampler seam + deterministic MockSystemSampler (busy% = two-read
  delta via interior Mutex); LinuxSystemSampler over an injectable /proc root
  (feature linux, tempdir tests); AndroidSystemSampler skeleton (feature android).
- monitor: SystemMonitor aggregator + process_summary / process_summary_from_counts.

Daemon + wire (crates/amos-ai + proto/ai_agent.proto)
- StatusReply.system = 16 with SystemHealth/SystemLoad/SystemBattery/ProcessCounts
  (optional scalars) + repeated AppProcess apps (id + AppState::key() tier).
- AiAgentService::system_metrics() -> fold_system_health(sampler, energy, governor):
  load + energy-store battery(level/charging/power; charging reported only once the
  governor has ticked) + governor process counts + per-app list.
- serve() system_beat logs one SystemHealth::summary() per cadence (shared fold),
  aborted on shutdown.

Tauri + System UI (crates/amos-tauri + frontend-ts)
- system_health command -> SystemStatus/AppProc serde payload (pure mapper, unit
  tests); lib/system.ts normalize + guarded systemHealth(); Settings SystemPanel
  (CPU/mem/battery/process tiers + app list, 2.5s auto-refresh, hidden when no data,
  absent values "—"); en/zh settings.system* keys.
```

## 2. 改动文件（相对既有 WIP 之外新增/修改）

新增：`crates/amos-monitor/`（Cargo.toml + src/{lib,spec,sampler,monitor,linux,android}.rs）、
`crates/amos-tauri/src/system.rs`、`frontend-ts/src/lib/system.ts`、
`__tests__/{system.test.ts,system-panel.test.tsx}`、
`components/SystemPanel.tsx`、`docs/system-monitor.md`、
`docs/DELIVERY_NOTES_2026-09-05-system-monitor.md`。
修改：workspace `Cargo.toml`、`Makefile`（gated-check）、`docs/ARCHITECTURE.md`、
`README.md`（crates 树 + docs 索引）、`CHANGELOG.md`、
`proto/ai_agent.proto`、`crates/amos-ai/{Cargo.toml,src/server.rs,tests/rpc_test.rs}`、
`crates/amos-tauri/src/lib.rs`、`frontend-ts/{apps.tsx,i18n/locales/{en,zh}.ts}`。

## 3. 验证汇总

- `cargo test -p amos-monitor --features linux` **14**；`cargo check -p amos-monitor --features android`。
- `cargo test -p amos-ai --lib` **126** + `--test rpc_test` **4**（真实 UDS，含 `get_status.system` 断言）。
- `cargo test -p amos-tauri --lib` **72**。
- 三 Rust crate `clippy --all-targets -D warnings` / `cargo fmt --check` 干净。
- 前端：`bun run typecheck`、`bun run test`（ISO 套件 `[bun-iso] OK`，含 system 纯测 14 + SystemPanel DOM 2）。
- `Makefile gated-check` 已含 `amos-monitor --features {linux,android}`。

## 4. 已知限制 / 诚实边界 / 后续

- 真机 CPU/内存来自 `/proc`（Linux/Android 有效）；macOS dev 无 `/proc` → 如实 unknown。
- `system.battery` 镜像 energy 块（`level_pct/charging/live_power_mw`），首 tick 前为 pending →
  如实 unknown；能量块仍是权威电量/模式面。
- `system.apps` 仅在宿主经 Governor gRPC / Android LMK 向共享 governor 注册 app 时非空；桌面空 registry
  时面板 app 区自动隐藏。
- 面板仅显示**聚合 + 各档进程数/清单**，尚未做逐进程 CPU/内存（需 `/proc/<pid>/stat`/`status` 逐进程
  采样，真机系统级能力，留待设备 bring-up）。
- 后续可选：把 `level_pct/charging` 一并回填到 `StatusReply` 主层或 energy 块顶层；面板加数据缺失/连接态提示。

## 5. 真机/验收跟进顺序

1. Linux/Android 上跑 daemon：确认日志周期出现 `amos-ai system working status: …` 且 CPU/mem 非 unknown。
2. `get_status` 经真实 UDS 返回 `system`（已有 e2e 断言兜底）。
3. 真机 System UI：注册 app → `SystemPanel` 出现 CPU/内存/电量与 app 清单（面板 2.5s 自动刷新）。
4. 逐进程采样/热/网络等扩展（如上 §4）留待设备层实现。
