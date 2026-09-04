# 交付说明与遗留清单 (Delivery Notes & Known Limits)

**日期**: 2026-09-05
**范围**: Android「无界兼容层」的 LMK-proxy + Activity/Task 生命周期状态机 + container↔host
双向桥 + `WatchLmk` 事件推送 + System UI/前端表面拆除——把 `amos-android` 兼容层从
「启动/图标原型」推进到一条**可离线验证的容器生死闭环**。本文件供提交/归档使用。
**状态基线**: `main` @ `ed5d9de`（本段改动均在其之上，工作树未提交）。
**主设计文档**: `docs/lmk-proxy.md`（§1–§8）；`docs/android-compat.md`。

---

## 1. 可直接使用的提交说明（commit message）

按仓库既有提交风格（`feat(scope): …`）组织，覆盖本段全部改动。

```
feat(android-compat): LMK-proxy + Activity/Task lifecycle + bidirectional
host bridge + WatchLmk push + System UI/frontend surface teardown

Take the amos-android Waydroid/demo APK layer from a launch/icon prototype to
an AmOS-controlled container-lifecycle closed loop that is fully testable
offline (no Waydroid/device needed) end to end.

Container-side (crates/amos-android)
- lmk.rs: per-package Activity/Task lifecycle (Created..Destroyed) -> derived
  process importance on the amos_applife::AppState ladder (rank/key identical to
  governor.proto); foreground-service + frozen/cached flags; LRU recency;
  plan()/apply() under MemoryPressure{None,Low,Critical} pick Freeze/Kill victims
  (protected tiers never picked); host_state() maps container Visible -> host
  Foreground (host has no settable Visible); LmkHost sink + NoopLmkHost.
- controller::force_stop -> `waydroid shell am force-stop <pkg>`; AndroidRuntime
  gains default force_stop (Waydroid delegates, DemoRuntime records stops());
  EnhancedAndroidManager::force_stop_app (timeout-guarded).
- service: adopt launched apps; OnActivity/GetLmkSnapshot/TriggerLmk and reverse
  ApplyHostDecision RPCs; every container decision reflected to host bridge;
  WatchLmk server-streaming broadcast (trigger/apply/destroy + beat-driven).

Host/daemon side (crates/amos-ai)
- GovernorLmkHost (implements LmkHost) reflects container tier into the SAME
  shared ResourceGovernor the beat + Governor gRPC drive (register/move/kill,
  no-op de-dupe, managed package set).
- drive_host_decisions feeds host reclaim/freeze/thaw back into the container
  (real am force-stop) AND onto the shared WatchLmk channel; serve() builds the
  android service + beat from the same proxy/manager/host/events instances.

System UI (crates/amos-tauri) + frontend (frontend-ts)
- android_lmk.rs: spawn_lmk_watch opens WatchLmk and re-emits `lmk-surface`
  events (payload with close_surface for RECLAIMED/DESTROYED).
- lib/lmk.ts + App.tsx: startLmkSurfaceWatcher tears down the legacy:<window_id>
  external surface via wm_close when the container reclaimed/destroyed it.

Tests (all green at write time)
- amos-android: 52 unit + 1 real-UDS e2e (incl. WatchLmk streaming round)
- amos-ai: governor 6 + bridge e2e 1 + reverse-drive e2e 1
- amos-tauri --lib: 67 (incl. android_lmk 3); frontend lmk.test.ts 5 (ISO OK)
- fmt + clippy --all-targets -D warnings clean on the three Rust crates
```

---

## 2. 改动清单

### 新增（未跟踪）
| 路径 | 说明 |
|---|---|
| `crates/amos-android/src/lmk.rs` | Activity/Task 生命周期状态机 + LMK-proxy 纯逻辑（含 `LmkHost`/`HostAction`/`host_state`） |
| `crates/amos-ai/tests/lmk_governor_bridge.rs` | 正向桥 daemon 集成（同一共享 governor 下 launch/OnActivity/TriggerLmk ↔ host） |
| `crates/amos-ai/tests/lmk_reverse_drive.rs` | 反向驱动集成（beat 回收 → 真 `am force-stop` + `WatchLmk` 事件，仅容器管理 app） |
| `crates/amos-tauri/src/android_lmk.rs` | System UI 订阅 `WatchLmk` → 转发 `lmk-surface` 事件（仿 telephony watch） |
| `crates/amos-tauri/frontend-ts/src/lib/lmk.ts` | 前端监听：`close_surface` → `wm_close("legacy:<id>")` |
| `crates/amos-tauri/frontend-ts/src/__tests__/lmk.test.ts` | 前端纯映射单测（5 项） |
| `docs/lmk-proxy.md` | 主设计/诚实边界文档（§1–§8） |
| `docs/DELIVERY_NOTES_2026-09-05.md` | 本文件 |

### 修改
| 路径 | 说明 |
|---|---|
| `proto/android_compat.proto` | 增 `ActivityEvent`/`MemoryPressure`/`HostAction`/`LmkEventKind` 枚举 + `LmkEvent`/`HostActionRequest` 等消息 + RPC `OnActivity`/`GetLmkSnapshot`/`TriggerLmk`/`ApplyHostDecision`/`WatchLmk`（均 additive） |
| `crates/amos-android/{Cargo.toml,src/lib.rs,src/service.rs}` | 依赖 `amos-applife` + `tokio-stream(sync)`；导出 lmk 类型；服务构造器/`apply_host_action`/`WatchLmk`/事件回填 |
| `crates/amos-android/src/{controller.rs,runtime.rs,manager.rs,tests/e2e_test.rs}` | `force_stop`（`am force-stop`）、`DemoRuntime::stops`、超时保护、e2e 覆盖反向 RPC + WatchLmk |
| `crates/amos-ai/src/governor_service.rs` | `GovernorLmkHost`（managed 集合）+ `drive_host_decisions`（含 `WatchLmk` emit） |
| `crates/amos-ai/src/server.rs` | 共享 proxy/manager/host/events 装配；beat 反向驱动并广播 |
| `crates/amos-tauri/src/lib.rs` | 注册 `mod android_lmk` + `setup()` spawn |
| `crates/amos-tauri/frontend-ts/src/App.tsx` | 启动期订阅 `lmk-surface` |
| `README.md` / `CHANGELOG.md` | 文档索引 / 逐轮记录 |

> 审计删除：`AndroidManagerService::with_manager_and_lmk` 与 `service::server_with_host`
> （无调用方，被 `with_parts(_and_events)`/`with_runtime_and_host` 取代）。

---

## 3. 验证汇总（写时全绿）
- `cargo test -p amos-android` → 52 单测 + 1 真 UDS e2e。
- `cargo test -p amos-ai --lib governor` → 6；`--test lmk_governor_bridge` 1；`--test lmk_reverse_drive` 1。
- `cargo test -p amos-tauri --lib` → 67（含 `android_lmk::surface_payload` 3 项）。
- `cargo check -p amos-ai` / `-p amos-tauri` / `-p amos-proto` 编译通过（proto additive 安全）。
- `cargo fmt`、`cargo clippy --all-targets -D warnings`（amos-android/amos-ai/amos-tauri）干净。
- `frontend-ts`: `tsc --noEmit` 干净；`bun run test`（ISO 隔离运行器）→ `[bun-iso] test OK`（0 fail，含 `lmk.test.ts` 5 项）。

---

## 4. 已知限制 / 遗留事项（Known limits & leftover）

### 需要真机 / 活 Tauri 环境（无法在无真机/无 GUI 完成或验证）
- **端到端目视验证**：`am force-stop` 真下发、`WatchLmk` 推送、`wm_close` 拆 `legacy` 表面，
  需在真起 daemon + Tauri host 上跑通（GUI 无法离线跑）。
- **no-UI Android 基座（产品底座）**：容器侧执行 seam 在真机路径换 `SurfaceControl`/
  VirtualDisplay teardown 需真机；`Waydroid` 仍仅开发/原型。
- **`OnActivity` 真实喂入**：System UI/桥需把容器真实 Activity 回调填入；真实 Android 一进程可含
  多 Activity，现按「每包一 top-Activity 任务」建模，真容器适配器需折叠 per-Activity 信号。

### 已知未完成（可无头但体量大 / 端到端依赖运行中 daemon）
- **daemon→System UI 的 Live 闭环**：后端订阅 + 事件 + 前端拆除均已接（离线可测），但"运行中的
  GUI 收到一条真实回收 → 看到 legacy 表面消失"依赖真起 daemon+host。
- **WatchLmk 慢订阅者**：best-effort 广播，滞后即丢事件、靠 `GetLmkSnapshot` 重同步（有意的）。

### 已知暂缓 / 诚实标注
- 桥方向为「容器→host advisory 上送 + host→容器回收驱动」双向，但**解冻(thaw)→容器真实 surface
  唤醒**仍是 seam（只镜像 proxy tier，未做进程/表面级唤醒）。
- `EnhancedAndroidManager::force_stop_app` 复用了 `launch_timeout_secs` 作超时（命名非精确，行为 OK）。
- `DemoRuntime`/`WaydroidRuntime` 的 `force_stop` 离线路径分别是"记录"与"shell 下发"，均经
  `CommandRunner` 注入、可断言；真 Waydroid 验证需设备。
- LMK 事件容量 128、best-effort：高吞吐回收时若订阅方消费慢会 miss（有意的简化）。

### 建议的后续顺序
1. 真机/活 host 上做端到端目视验收（回收一个已开 legacy 表面的 APK → 表面消失）。
2. no-UI Android 基座的 `SurfaceControl` teardown 接线（产品底座）。
3. host thaw → 容器真实 surface 唤醒。
4. 若需 UI 级 Go/No-Go：把 `lmk-surface` 前端事件并入现有 surface 渲染快照（用
   `GetLmkSnapshot`/`wm_windows` 做对账），而非仅单向 close。

