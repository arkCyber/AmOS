# Android LMK 端到端验收 runbook（真机 / 活 Tauri host）

> 目标：在 **真起 daemon + Tauri host**（有 Waydroid / 真机底座）上目视验证
> “容器 Kill → 拆 `amos-wm` `legacy` 表面”整条链。离线部分已由 cargo/frontend 测试覆盖
> （见 §L1），本文面向无法离线跑 GUI 的收尾。设计见 `docs/lmk-proxy.md`。
> 部署定位：Waydroid = 开发/原型；产品 = no-UI Android 基座（`docs/no-ui-android.md`）。

## 0. 先跑无头基线（本机即可，必过）

```bash
cargo test -p amos-android                    # 52 单测 + 1 真 UDS e2e（含 WatchLmk 往返）
cargo test -p amos-ai --test lmk_governor_bridge --test lmk_reverse_drive
cargo test -p amos-tauri --lib                # 67
cd crates/amos-tauri/frontend-ts && bun run typecheck && bun run test
```

这些已确定性证明：launch 收养 → Activity 重要性 → host 双向桥 → beat 回收驱动 → `WatchLmk`
推送 → 前端对账拆除的**逻辑正确**。L1 之后才需要 GUI 目视（L2）。

## 1. L2 实时 GUI 验收（需活 daemon + host）

### 前置
- `amos-ai` daemon 在跑（共享 UDS），System UI `tauri dev` 已起（`bridged`）。
- Waydroid 容器在跑、`waydroid` 在 `$PATH`（或用 `DemoRuntime` 走无 Waydroid 的状态链）。
- 想用 governor beat 强制回收：daemon 以 `AMOS_GOVERNOR_MEMORY_PRESSURE=1` 启动
  （每次 `observe` 会对 `Background`/`Cached` 的 host app 做回收 → `drive_host_decisions`
  → 真 `am force-stop` + `WatchLmk` `RECLAIMED`）。

### 已知缺口（诚实，验收前须补）
当前 **System UI 没有“把 legacy app 背景化 / 触发 LMK”的用户入口**：launch 一律注册为前台，
beat 只回收 `Background`/`Cached`。要在 GUI 里目视“表面消失”，需要一方对一个**已背景化**
的容器 app 调 `AndroidManager::TriggerLmk(Critical)` 或 `ApplyHostDecision(Reclaim)`。
无头时由测试驱动；GUI 阶段建议**临时加一个 debug 入口**（Tauri 命令调
`TriggerLmk`/`apply_host_decision`，或把某 legacy app `OnActivity(Stop)` 后等 beat 回收）。

### 步骤与判定

| # | 操作 | 预期（判定） |
|---|---|---|
| G1 | Launcher「安卓应用」页点“微信”启动 | 出现 `legacy:<window_id>` 表面；`wm_windows`/调试卡含该 external System 窗口 |
| G2 | 用 debug 入口把该 app 背景化（OnActivity Stop） | 其 host 状态变 `Background`；`Governor::GetState` 可见 |
| G3 | 触发 `TriggerLmk(Critical)`（或 `AMOS_GOVERNOR_MEMORY_PRESSURE=1` 下等下一 beat） | daemon 日志：`force-stopped app: com.tencent.mm` + `WatchLmk` 广播 `RECLAIMED`；容器内 `am force-stop` 下发 |
| G4 | 观察 System UI | **`legacy:<window_id>` 表面被拆除**（`wm_windows` 不再含它；窗口从多窗口/前台消失）——事件路径（`lmk-surface` → `wm_close`）与对账兜底（启动+30s 周期）二者都消除它 |
| G5 | 杀掉 daemon，重启后重启 System UI | 启动即 reconcile：若之前有残留 stale `legacy` 表面，数秒内被对账清除（验证 `startPeriodicReconcile` 的启动即跑） |

### 端到端失败排查
- G2/G3 无事件：确认 daemon 是**带 host 装配**的新版（`server.rs` 用 `with_parts_and_events`）；
  用 `cargo test -p amos-ai --test lmk_reverse_drive` 先证 beat→WatchLmk 通。
- G4 无表面消失：System UI 是否 `bridged()`（未 bridged 的 effect 提前 return）；daemon down 时
  reconcile 守卫不误关（“daemon down ≠ 全部死”）——重启后对账才清。

## 2. 仍属 seam（产品底座，需真机）
- no-UI Android 基座的 `SurfaceControl` teardown；host thaw → 容器真实 surface 唤醒。
- `OnActivity` 真实喂入（每包多 Activity 折叠成 top-Activity）——真机适配器。
