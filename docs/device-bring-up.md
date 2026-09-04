# AmOS 真机 bring-up 验收清单（energy/applife/scheduler 接线）

**日期**: 2026-09-04
**性质**: 设备接线行动件 —— 把离线/宿主已验证的领域内核与 seam（`amos-power` / `amos-applife` / `amos-scheduler` / `amos_ai::energy` / `amos_ai::governor`）接到**真机 no-UI Android 基座 + System UI APK**。所有 JNI 均沿用仓库 `android.rs` 模式（`AndroidContext(GlobalRef)` + 每线程 attach + `cargo check --features android` 宿主可编译；运行需真机 `JavaVM`+`Context`）。
**关联**: `docs/power-policy.md`、`docs/app-lifecycle.md`、`docs/scheduler.md`、`docs/bottom-layer-os-audit.md`、`FUNCTIONAL_GAP_ANALYSIS.md` §一/§二.22/25。

---

## 0. 先决条件与验收总则

- 底座 = **no-UI Android 基座**（`docs/no-ui-android.md`），System UI = `amos-tauri` 唯一 HOME launcher APK，持 `Context`。
- 所有真机 seam 先在**宿主交叉编译**门禁通过：`make gated-check`（已含 `amos-{radio,telephony,sensor,profiling,power} --features android`）。
- 每条验收按"真机观察到的事实"判定（用 `dumpsys`/`getprop`/日志佐证），**不把"能编译"当"已接通"**。
- 建议真机：root 的 Android 12+（`adb`），先跑 `docs/device-poc.md` §3 交叉编译基线。

---

## 1. 电池/热/功耗真采样（喂 `amos_ai::energy` 的 `EnergyStore` 与 `ResourceGovernor`）

**目标**：把 daemon 的 energy ticker 从"env 采样"升级为真机电池读数。
**已有 seam（宿主编译已验证）**：
- `crates/amos-power/src/android.rs` → `AndroidBatteryTelemetry`：读粘性 `ACTION_BATTERY_CHANGED`（level/status/temperature）。
- `crates/amos-profiling/src/android.rs` → `AndroidBatteryPowerSource`：`BatteryManager#getLongProperty(CURRENT_NOW)`×电压。

**接线点（System UI APK，`amos-tauri`）**：
1. 启动时用 Activity 的 `JavaVM` + `Context` 构造两个对象（参考 `amos-tauri/src/radio.rs::RadioBridge::from_android` 的装配风格）。
2. 把 `AndroidBatteryTelemetry.snapshot()` 的 `Telemetry` 与 `AndroidBatteryPowerSource::read_mw()` 喂进一个**真 ticker**，替代 host 的 `telemetry_from_env()`（`crates/amos-ai/src/energy.rs`）；System UI 与 daemon 之间走既有 UDS（新增命令/事件桥，仿 `telephony_*`/`sensor_*` 桥）。
3. `EXTRA_VOLTAGE`（mV）经 `ACTION_BATTERY_CHANGED` 粘性广播传给 `with_voltage_mv`，使 `est_energy_j` 真实。

**验收判据**：拔/插充电器 → `get_status` 的 `energy.reason` 在 `charging`↔非 charging 间切换；运行本地 LLM 时 `power_mw`/温度读数随负载上升且有限（非 0/非 NaN）。

---

## 2. per-app 进程宿主驱动 `amos-applife`

**目标**：每个真实 App（System-UI App / 旧 APK / 后台服务）有一个 `AppId`，状态迁移由"用户切 App/熄屏/回前台"驱动，供 `ResourceGovernor` 冻结/回收。

**内核**：`crates/amos-applife`（`AppLifecycle`：launch/go_background/freeze/thaw/start_service/stop_service/stop/kill + `reclaim_candidates`）。

**接线点（System UI + 未来 per-app 进程宿主）**：
1. 维护 `AppId → 进程/窗口/surface` 映射（旧 APK 合成见 `docs/no-ui-android.md` §5）。
2. 前端切 App 事件 → `ResourceGovernor::register_app/background_app`；熄屏/Doze 进入 → 由 governor tick 冻结 `Background→Cached`；回前台 → `go_foreground`（自动 thaw）。
3. 前台服务（播放/通话）→ `start_service`（进入保护态，永不被回收）。

**验收判据**：打开 A 切到 B → A 在 governor 低电 tick 后 `Background→Cached`；再回 A → thaw/relaunch；显式内存压力下 LRU 的 Cached 进程被回收而前台/服务进程不动。

---

## 3. 调度/唤醒对齐绑真 `AlarmManager` / `JobScheduler`（`amos-scheduler`）

**目标**：把 `Scheduler` 的 `next_wake`（精确闹钟）与 `due`（Deferred 维护窗批）映射到平台。

**内核**：`crates/amos-scheduler`（`Scheduler`：due/next_wake/counts；`PowerState::deferred_runnable`）。

**接线点（System UI APK）**：
1. **tick 源**：以单调 clock 驱动 `Scheduler`；把 `next_wake` 换算为墙钟并 `AlarmManager.setExactAndAllowWhileIdle(…, PendingIntent)` 真正唤醒一次；被唤醒后对 `due` 返回的批执行，`complete` 每个。
2. **Deferred**：不在醒着/充电/维护窗时执行；维护窗（Android `JobScheduler` 或自维护窗口）开启时合并跑整批 → 少唤醒。
3. `PowerState{dozing, maintenance_open, charging}` 由 Doze 广播 + `amos-power` 的 `throttle_background`（`StatusReply.energy.throttle_background`）喂入。
4. `Cached`(墓碑) 进程的后台作业只注册 Deferred、不注册精确闹钟（与 §2 联动）。

**验收判据**：注册一个 60s 后闹钟 → 设备在 Doze 下仍在其时刻被 `setExactAndAllowWhileIdle` 唤醒（`dumpsys alarm` 可见）；多个 Deferred 作业在维护窗内**一次**触发（看日志合并批），Doze 无窗期间不产生任意唤醒。

---

## 4. （可选后续）让 daemon 的 `ResourceGovernor` 可被宿主驱动

现状：`serve()` 的 `governor_beat` 持**私有空** `ResourceGovernor`（`crates/amos-ai/src/server.rs`），宿主目前无法从 daemon 侧注册 App/Job。
若想"per-app 宿主经 UDS 驱动 daemon 生命周期"，需新增一个 **gRPC Governor/Lifecycle 服务**（proto 定义 `RegisterApp/SetAppState/ScheduleJob/GetGovernorState`，把 `AppId/AppState/JobId/JobType/窗口` 映射到 wire），挂进 `serve()`（仿 `Telephony`/`Sensor` 的 `add_service` 既有模式，见 server.rs 1033–1043），并让它驱动一个共享的 `ResourceGovernor`。此后 §2/§3 的宿主可纯经 UDS 与 daemon 协作，而无需改 daemon 内部。**这是把"三合一闭环"变成真正 OS 服务形态的下一步。**

> ✅ **已实现（2026-09-04）**：`Governor` gRPC 服务（`proto/governor.proto`, package `amos_governor`）已挂进 `amos-ai` 的 `serve()` 同一条 UDS——`RegisterApp` / `MoveApp`（→Foreground/Background/Cached/服务/Stopped）/ `UnregisterApp` / `ScheduleJob`（AlarmExact/Deferred）/ `GetState`（apps+jobs+background 计数）。`serve()` 用**同一个** `Arc<Mutex<ResourceGovernor>>` 供周期 beat 与 RPC 共享（无重复 governor、宿主注册即被该闭环治理）。离线验证：`governor_service` 单测（register→move→schedule→get_state + 同实例 observe）+ 真 UDS e2e（`amos-ai/tests/governor_rpc_e2e.rs`）。剩余 = System UI/per-app 宿主把它们真实的 App/Job 经此服务注册（§1–§3 接线）。

---

## 5. 一句话总结
host 可验证的部分（领域内核、daemon 装配、闭环、Android seam 骨架、门禁）已全部落地并绿；剩下 §1–§4 都是**真机 + System UI APK** 才能端到端验证的接线——本清单即它们的行动件与验收标准。建议顺序：§1（电池）→ §3（闹钟）→ §2（进程宿主）→ §4（若需 daemon 托管生命周期）。
