# amos-telemetry-spy · 无感异步审计网卡（passive egress telemetry-spy）

**状态**: 2026-09-09 · host 可测 domain core（纯 `std`，默认零 native 依赖）+ feature 门控
`audit` 实时抓包 seam。**compiling ≠ 真机已验收**。

## 它做什么（范围诚实）

针对「12GB 物理真机」的隐蔽外发场景，这个 crate 提供一层**只读、不阻断**的审计网卡：

1. 在某个数据接口（如 `rmnet_data0`）上常驻**被动抓包**；
2. 用纯 `std` 的轻量 IP/TCP/UDP 头解析器（[`packet`](../crates/amos-telemetry-spy/src/packet.rs)，
   刻意不依赖 `pnet_packet`，让 decode+scan 在默认构建里就能 host 单测）解出外发 Payload；
3. 对 Payload 跑确定性启发式扫描（[`scanner`](../crates/amos-telemetry-spy/src/scanner.rs)），
   检测是否出现设备绑定标识 —— 硬编码序列号 / **IMEI** / 当前基站 **Cell ID**；
4. 一旦命中即产出一条 **高危** 审计事件（[`signal::EgressMatch`]，severity=high），
   供 daemon 经 gRPC 实时向 Tauri System UI 派发警告。

异步线程要求：pnet 的 datalink receiver 是**阻塞**的，故 [`capture::run_blocking`] 设计成在
专用 OS 线程 / `tokio::task::spawn_blocking`（复用现有 Tokio 运行时）上跑；
[`capture::spawn_stream`] 已封装「当前运行时里 spawn_blocking → `tokio::sync::mpsc` receiver」，
daemon 可把该 receiver 变成 gRPC server-streaming 的警告流。

## 与仓库既有权威文档的关系

本 crate 按需求方拍板以 **平行 crate** 落地，未并入 `amos-network-guard`。但它**继承**了
`docs/anti-telemetry-egress-guard.md` 的三条诚实边界，不改写事实：

- **§2.1**：抓 `rmnet_data0` 只能看到 **AP/App 数据面**；modem/baseband 自己发起的外发
  （独立处理器/可信域）不经过用户态可见接口，本 crate 不声称能发现。
- **§3.2**：在 Payload 里 grep 明文 IMEI/序列号/Cell ID 是**脆弱、低置信启发式** —— 加密流
  不暴露明文、且误报高。故事件同时携带 severity（命中即 High）与独立分级的
  [`Confidence`]，**绝不给裸子串贴「实锤外泄」标签**。
- **root 决定一切**：打开 raw datalink channel 需要 root / AmOS-AOSP 系统位；无 root 原厂机
  上应走 `amos-network-guard` 的 `VpnService`（rootless）路径，不是本 pnet seam。

## Feature 门控与依赖

- 默认构建 = **纯 `std`**，`make test` / `make lint` 不新增任何 native 系统依赖，保持绿。
- `audit` feature = `pnet`（实时抓包）+ `tokio`（异步桥）。仅 AOSP/rooted 真机路径启用；
  `cargo check --features audit` 只保证**能编译**。

```bash
# 默认（纯 std）domain core
cargo test   -p amos-telemetry-spy
cargo clippy -p amos-telemetry-spy --all-targets -- -D warnings
cargo fmt    -p amos-telemetry-spy -- --check
# audit（pnet 实时抓包）编译 + 例程
cargo check  -p amos-telemetry-spy --features audit --all-targets
cargo run    -p amos-telemetry-spy --example live_spy --features audit -- [iface]
```

## 模块一览

| 模块 | 默认构建 | 职责 |
|---|---|---|
| `identifier` | ✔ | 序列号/IMEI/Cell ID 标识模型 + 字节 token |
| `identity`   | ✔ | [`DeviceIdentity`] seam：host 用 `StaticIdentity`/`MockIdentity`（样本值**显式伪造**）；真机取 Build/Telephony/CellInfo 属 bring-up seam |
| `scanner`    | ✔ | 纯函数扫描启发式 + `Confidence` 分级（短 token / 短于 3 字节直接忽略）|
| `packet`     | ✔ | 纯 `std` 的 Ethernet/IPv4/IPv6/TCP/UDP 头解析（无重装/分片重组，见诚实限制）|
| `signal`     | ✔ | `EgressMatch` 高危审计事件 + 证据分级 |
| `capture`    | ✖（`audit`）| pnet datalink 抓 `rmnet_data0` → decode → scan → mpsc 流 |

## 已知限制 / 遗留

- TCP 分片跨段、IP 分片**不重组**：token 若被拆到两个 segment 会漏报（被动启发式取舍）。
- `capture::CaptureCfg::layer3_ipv4`（`rmnet` 类 L3 接口）一次只抓 **IPv4**（pnet 的
  Layer3 channel 按单一 EtherType 键控）；默认 Layer2 通道在支持的后端上两族都收。
- raw datalink 无法给方向，`EgressMatch.direction` 通常为 `Unknown`；真正的
  outbound/inbound 区分需 socket-aware 后端（VpnService/nftables）。

## gRPC 派发链路（已接线，2026-09-09）

`EgressMatch` → daemon gRPC → System UI → 前端通知，已逐 crate 接线并验证：

1. **wire 契约**：`proto/telemetry_spy.proto` → `amos-proto`（`amos_telemetry_spy` 模块，
   `TelemetrySpyService.Watch(Empty) → stream EgressHit`）。
2. **daemon 服务**：`amos-ai::telemetry_spy_service`（`TelemetrySpySvc` 持
   `tokio::sync::broadcast<EgressHit>`，`Watch` 用 `BroadcastStream` fan-out）已
   `.add_service` 挂进 `serve()` 共享 UDS。
3. **System UI 桥**：`amos-tauri::telemetry_spy::spawn_telemetry_spy_watch` 在 `setup()`
   启动，把每个 hit 映射为可序列化 `SpyHitPayload` 并 `emit("telemetry-spy-hit", …)`。
4. **前端消费**：`frontend-ts/lib/telemetrySpy.ts` 的 `startTelemetrySpyWatcher` 订阅该事件，
   经防御式 `toSpyHit` 校验后用 `spyNotif` 写入共享 `NOTIF_KEY`（**绝不回显序列号/IMEI/
   Cell ID 明文**），Notification Center / `NotificationBanner` 即显示外发泄漏风险。

诚实边界：默认 host 构建无 pnet capture producer，daemon 的 `emit` 无人喂 → 整条链安静、
**绝不产生伪造 hit**；真实抓包 producer 接 `TelemetrySpySvc::emit` 是设备/AOSP
`audit`-feature 步骤。

### daemon 侧 feed seam（`amos-ai` `telemetry-spy` feature，纯 std 可测）
`amos-ai` 的 `--features telemetry-spy` 会把 `amos-telemetry-spy` 域核心拉进来，并启用
`EgressMatch → proto EgressHit` 的映射 + `TelemetrySpySvc::ingest_match(&EgressMatch)`。
单测证明：一个域 `EgressMatch`（含 IMEI 命中）经 `ingest_match` 即出现在 `Watch` 流。因此
**真机上只剩一步**：一个 pnet capture 任务每解码+扫描一帧命中就调用 `ingest_match`：

```rust,ignore
// on-device producer sketch (needs amos-telemetry-spy `audit` + rooted/AmOS-AOSP):
let cfg = amos_telemetry_spy::capture::CaptureCfg::new("rmnet_data0")?.layer3_ipv4();
let ids = device_identity.identifiers();           // serial / IMEI / cell ID
let mut rx = amos_telemetry_spy::capture::spawn_stream(cfg, stop, ids)?;
while let Some(m) = rx.recv().await { spy_svc.ingest_match(&m); } // -> Watch -> Tauri -> UI
```

### 测试注入门控（`AMOS_SPY_ALLOW_INJECT`）
`proto/telemetry_spy.proto` 的 `SimulateHit` 是 test/demo RPC：daemon 仅当进程显式设
`AMOS_SPY_ALLOW_INJECT=1` 才服务（否则 `PermissionDenied`，每生产 boot 默认只读）。它喂的是
与真实 producer 完全相同的 `emit` 广播，供 `tests/telemetry_spy_rpc_e2e.rs` 在真 UDS 上驱动
「订阅 `Watch` → 注入一帧 → 收到 hit」。


