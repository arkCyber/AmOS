# 底层"现代移动 OS"职能审计（HAL / 内核交互 · 生命周期 / 进程常驻）

**日期**: 2026-09-04
**范围**: 全 workspace —— 对照参考判据「真正的现代移动操作系统底层职能」
**方法**: 以代码为准核验（grep + 逐文件读 seam），区分"代码里已有但未接线 / 只是骨架 / 完全缺失 / 属委托不该由 AmOS 自己造"四类，避免与既有文档叙事打架。

> 前置口径：仓库已有战略判定（`FUNCTIONAL_GAP_ANALYSIS.md` §六 / `docs/no-ui-android.md`）——
> **真机产品底座 = no-UI Android 基座**（内核 + 驱动 + HAL + Binder 由 Android 提供），Waydroid 仅开发/原型。
> 本审计不推翻该判定，而是在此口径上精确回答："作为独立移动 OS 的底层职能，AmOS 还缺什么。"

---

## 0. 一句话结论

**参考判据成立。** AmOS 目前本质是"跑在宿主 OS（Android/Linux）之上、拥有整套领域内核 + seam + 诚实 Mock 的高层 UI/服务壳"。它对底层芯片（基带/Modem、Wi-Fi/BT 芯片、PMIC）**没有任何独立驱动能力**，全部依赖 Android 框架/系统服务经 JNI 间接触达；对**进程生命周期（LMK/冻结/前后台）与后台唤醒/电池对齐（AlarmManager/Doze/JobScheduler）**，仓库内 **0 命中**（仅 `oom_score_adj -1000` + 文档化设计意图）。

但要分清两种"缺口"语义（§1）：**在 no-UI Android 底座上**，驱动/HAL/LMK/Alarms 大部分是平台的委托责任，AmOS 真正缺的是"把 Android 的能力接成产品功能"的那层桥 + 少数组装/决策逻辑；**若野心是脱离 Android 的独立 OS**，则参考判据所列每一项都是货真价实的缺口。仓库目前代码只支持第一种。

---

## 1. 审计口径：两种底座 → 两种"缺口"语义

| 判据项 | 若底座 = no-UI Android（已定战略） | 若底座 = 独立 OS（脱离 Android） |
|---|---|---|
| 原生硬件驱动（HAL）控制 Wi-Fi/BT/Modem/PMIC | **委托**：Android 已有驱动/HAL，AmOS 不该重建（自己造反而危险） | **真缺口**：无任何驱动/kernel 交互 |
| 低层生命周期 / LMK / 进程冻结 | **委托**：`lmkd`/AMS 由平台管，AmOS 只需把自己注册成合规 App | **真缺口**：无 LMK/调度 |
| 电池优化 / 后台唤醒对齐（Alarms） | **委托**：平台 Doze/AlarmManager/JobScheduler | **真缺口**：0 实现 |

> 结论先行：仓库里"领域内核 + provider seam + Mock"架构极其成熟，**大多数判据项其实是被设计成"委托"而非"自造"**。真正属于 AmOS 自身缺口的，是"桥/装配/决策"三层里还没接、以及少数领域内还没有的内核。以下逐条给出代码证据。

---

## 2. 现状证据盘点（对照判据）

### A. 原生硬件驱动层（HAL）/ 内核交互 —— 全部经 Android 系统服务，无直连芯片

| 判据项 | 代码证据 | 状态 |
|---|---|---|
| Wi-Fi / 蓝牙 | `crates/amos-radio/src/android.rs` `AndroidRadioProvider`：经 JNI `getSystemService("wifi"/"bluetooth")` → `WifiManager#setWifiEnabled/isWifiEnabled`、`BluetoothAdapter#enable/disable/isEnabled`。**只有开/关与查询**；无 `ConnectivityManager` 现代化路径、无扫描/选网/SSID 列表、无蓝牙扫描/配对。飞行模式是 AmOS 侧位，未写 `Settings.Global.AIRPLANE_MODE_ON` | 🟠 编译门控骨架，真机未接通；功能仅"总开关"级 |
| 移动网络 / Radio / Modem | 无独立 RIL/AT/QMI/DIAG 层。`amos-telephony` 不直连基带：真机 `android.rs` 用 **`ACTION_CALL` + `tel:` intent 起呼**；`answer`/`end`/录音/实时 `status` **显式返回 `Provider(…P3 device-validated…)` 未实现**；TODO 标注应迁移 `TelecomManager#placeCall` + InCallService/TelephonyCallback | 🔴 骨架；进出话控、来电注入、录音均未接 |
| 电源管理芯片（PMIC）/ 功耗 | 无 PMIC 直控。`amos-profiling/src/android.rs` 只**读** `BatteryManager#getLongProperty(CURRENT_NOW)`(µA)×电压(默认硬编码 3700mV)→mW 估计，属"计量读"非"控制"；无 suspend/resume、无调频/调压/温控/充电管理 | 🔴 只读骨架，电压尚未接 `EXTRA_VOLTAGE` |
| 传感器（Camera/IMU/GNSS） | `amos-sensor/src/android.rs`：**GNSS 真实现**（`LocationManager#getLastKnownLocation`，同步）；**Camera/IMU 是流**，需 `CameraDevice`+`ImageReader` / `SensorEventListener` 桥，当前返回显式 `Provider` 错误 | 🟠 GNSS 真、相机/IMU 流桥未接 |
| 音频硬件 | `amos-audio/src/android/` —— **全仓离"芯片"最近**：手写 FFI seam `tinyalsa`（AOSP/系统侧，指向通话语音流位置）与 `aaudio`（app 侧听麦）。宿主不编译，未在真机验证 | 🟠 seam 已写、未设备验证；通话语音拦截仍需系统级 HAL 路由钩子 |
| 内核直连（/sys、/dev、gpio、i2c、ioctl） | **全仓 grep 无任何直连**（除 tinyalsa 经 libtinyalsa 走 PCM）。radio/telephony/sensor/profiling 一律 `getSystemService` + JNI | 🔴 无 |
| Binder / HIDL / AIDL → SurfaceFlinger/AMS/input | `docs/no-ui-android.md` §4 仅**设计提案**（`binder` crate 建议）；代码 0。旧 APK 表面合成（SurfaceControl/VirtualDisplay，§5）仅设计 | 🔴 设计文档，未落地 |

### B. 低层生命周期 / 进程常驻 / 电池与唤醒对齐

| 判据项 | 代码证据 | 状态 |
|---|---|---|
| App / 进程模型（per-app 进程、前后台、冻结） | **✅ 状态机内核已落地**（`amos-applife`：Foreground/Visible/ForegroundService/Background/Cached=墓碑/Stopped，见 `docs/app-lifecycle.md`）。前端 App 仍共用 WebView 进程——**真 per-app 进程宿主仍是 runtime seam** | 🟠 内核✅ / 进程宿主待 runtime |
| Low Memory Killer / oom 分级 / 冻结 | **✅ LMK-proxy 内核已落地**（`amos-applife::reclaim_candidates` LRU 缓存/后台，保护态不回收）。Android 上 `lmkd`/AMS 仍委托平台（`amos-ai` 已 `oom_score_adj -1000`） | 🟠 内核✅ / 平台委托 |
| 后台任务 / 墓碑 / 冻结恢复 | **✅ 内核已落地**：`amos-applife` Cached(墓碑) 冻结/解冻 + `amos_ai::governor::ResourceGovernor` 低电冻结/恢复自动驱动 | 🟠 内核✅ / runtime seam |
| 电池优化 / 后台唤醒对齐（Alarms） | **✅ 内核已落地**（`amos-scheduler`：AlarmExact vs Deferred、Doze 门控、批量对齐、next_wake，见 `docs/scheduler.md`）。仓库原 0 命中 → 现内核 + daemon 闭环齐；**真 AlarmManager/JobScheduler/Doze 广播绑定是 seam** | 🟠 内核✅ / 平台绑定 seam |
| 电池/热策略联动 | **✅ 闭环已落地**：`amos-power` 决策 + `amos-ai::energy` daemon beat + `ResourceGovernor`（低电→PowerSave→冻结后台+压住 Deferred；恢复→解冻+跑批；压力→LRU 回收）。真 HAL 采样（`ACTION_BATTERY_CHANGED`/`EXTRA_VOLTAGE`/温度）是 seam | 🟠 内核+装配✅ / 真 HAL seam |

---

## 3. 逐条"还缺什么功能"（按优先级，标注类型）

> 类型：**[内核]**=领域逻辑该由 AmOS 写；**[桥]**=接 Android/系统服务；**[委托]**=平台责任、AmOS 只做产品侧注册/装配；**[决策]**=定口径后才能做。

### 优先级 P0 —— 决定"要不要自建底层"
1. **[决策] 明确定义底座边界**：哪些是"委托 Android"，哪些要 AmOS 自建。仓库已定为 no-UI Android（委托），但**没有一份文档把"判据里哪些是委托、哪些是 AmOS 必写"逐行画清楚**——本文件即起点。若转向独立 OS，则 P1/P2 全部从"委托"升级为"自建"。

### 优先级 P1 —— 在 no-UI Android 底座上、AmOS 自己的"桥/装配"缺口
2. **[桥] Radio 真机接通 & 功能深化**：`AndroidRadioProvider` 尚未在 System UI 用真 `Context` 替换 Mock；Wi-Fi 升 `ConnectivityManager`、蓝牙加 `BLUETOOTH_CONNECT` 权限、飞行写 `Settings.Global`（`docs/radio.md` §6）。当前产品只有"开关"，无选网/配对/状态枚举。
3. **[桥] Telephony P3 进出话控**：`ACTION_CALL` 起呼 → `TelecomManager#placeCall`；**接听/挂断/录音/实时 status/来电注入**（InCallService/TelephonyCallback）为明确未实现项——这是电话产品"能用"的死穴。
4. **[桥] Sensor 相机帧 + IMU 流桥**（GNSS 已真）：`CameraDevice`+`ImageReader`、`SensorEventListener` → 缓存/帧元数据；System UI 真 `Context` 构造 `SensorManager`。
5. **[桥] Battery 真电压接线**：System UI 接 `ACTION_BATTERY_CHANGED` 粘性广播取 `EXTRA_VOLTAGE` → `with_voltage_mv`，把 `est_energy_j` 报进 profile；补进 System UI 功耗 tile 与 profiler 闭环（`docs/profiling.md` §5）。
6. **[桥] Binder/AIDL 层落地**（可选、高性能路径）：`docs/no-ui-android.md` §4/§5 的 `binder` crate + 旧 APK surface 合成仍是纯设计——若 AI 代理要"免无障碍读屏 + 注入输入 + 取帧 VLM"，这是使能件。
7. **[桥] 真 `Context` 装配成集中 `android_bridge`**：radio/telephony/sensor/profiling 四个 seam 都散在各自 crate，缺一个在 System UI 启动时统一喂 `JavaVM`+`Context`、按能力替换 Mock 的装配点（各 doc 反复提到，尚未有代码）。

### 优先级 P2 —— 应用生命周期 / 常驻 / 唤醒（目前完全空白）
8. **[内核+桥] App 进程模型 + 前台/后台 + 墓碑状态机** → **✅ 状态机内核已落地（2026-09-04，`crates/amos-applife`，见 `docs/app-lifecycle.md`）**：per-App 状态阶梯（Foreground/Visible/ForegroundService/Background/Cached=墓碑/Stopped）+ 保护态永不回收 + LRU + 内存压力 `reclaim_candidates`（LMK-proxy），纯 `std` 离线可测（9 lib + 3 集成测试）。**剩余为调用方接线（非内核）**：把每个 App 映射成 `AppId`、在真 per-app 进程/独立 WebView 运行时驱动状态迁移、由 `amos-power` 压力或系统信号触发回收（`app-lifecycle.md` §5）；以及后台任务/Doze 唤醒对齐（见 #10/#12，仍空白）。
9. **[委托] LMK / 冻结**：在 Android 上委托 `lmkd`/AMS；AmOS 应做的是给前台体验留好 `oom_adj` 分层（`amos-ai` 已 `-1000`）与**启动即前台**、崩溃上报——而非自写 LMK。
10. **[桥] 后台任务调度 + 唤醒对齐** → **✅ 调度/唤醒对齐内核已落地（2026-09-04，`crates/amos-scheduler`，见 `docs/scheduler.md`）**：AlarmExact vs Deferred 作业 + [earliest,latest] 窗口 + Doze/充电/维护窗门控（`PowerState::deferred_runnable`）+ `due` 批量合并对齐 + `next_wake`（喂真 `AlarmManager`）。**剩余为调用方接线（非内核）**：把本内核绑到真 Android `JobScheduler`/`WorkManager`/`AlarmManager`、喂入 `PowerState`（Doze 广播 + `amos-power::throttle_background`）、并让 `Cached`(墓碑) 进程的后台作业只注册 Deferred（`scheduler.md` §7）。
11. **[内核] 电池/热/前后台联动的节能策略调度器** → **✅ 决策内核已落地（2026-09-04，`crates/amos-power`，见 `docs/power-policy.md`）**：把 `SensorManager`（采样上限/`SensorMode`）、`PowerSource`（实时功耗）、电量/充电/温度/前后台 `Usage` 组装成纯 `std` 确定性**决策内核**（带迟滞的 `policy::decide` + 状态ful `EnergyGovernor::observe`，输出 `Decision` 经 `apply_to(&SensorManager)` 真门控采样）。**剩余为调用方接线（非内核）**：daemon/System UI 周期 ticker 采样真 `ACTION_BATTERY_CHANGED`/`EXTRA_VOLTAGE`/温度喂入、按 `cap_inference`/`throttle_background` 门控引擎与后台任务（`docs/profiling.md` §5 / `power-policy.md` §6）。
12. **[委托] 设备空闲维护窗 / Doze 适配**：让 agent/同传在被 Doze 限制时走合规的 JobScheduler + wakelock + 前台服务类型，避免被系统杀掉又不假保活 → **✅ 门控/对齐内核已落地（2026-09-04，`amos-scheduler::PowerState` 维护窗 + 前台服务即 `amos-applife::ForegroundService` 保护态，见 `docs/scheduler.md`）**；剩余为在真 `AlarmManager`/`JobScheduler`/Doze 广播上的接线。

> **✅ 三合一闭环驱动已落地（daemon 侧，2026-09-04）**：`amos_ai::governor::ResourceGovernor` 把上述 #8/#10/#11/#12 的**内核**（`amos-applife` 生命周期/LMK、`amos-scheduler` 调度对齐、`amos-power` 节能、`amos-sensor` 采样档）在 daemon 里合成一个离线可测的 **ResourceGovernor 闭环**——低电→PowerSave→冻结后台 App+压住 Deferred；恢复/充电+维护窗→解冻+跑合并批；显式内存压力→LRU 回收。System-UI / per-app 宿主只需 `register_app`/`background_app`/`schedule` 后周期 `observe`。

> **✅ daemon 托管生命周期已落地（2026-09-04）**：新增 `Governor` gRPC 服务（`proto/governor.proto`）挂 `amos-ai::serve()` 同一条 UDS——`RegisterApp/MoveApp/UnregisterApp/ScheduleJob/GetState`；`serve()` 用**同一个** `Arc<Mutex<ResourceGovernor>>` 供周期 beat 与 RPC 共享（宿主经 UDS 注册 App/Job 即被该闭环治理，消除了此前"governor 无输入/重复决策"两点审计意见）。离线验证：`governor_service` 单测 + 真 UDS e2e `tests/governor_rpc_e2e.rs`。至此审计 #8/#10/#11/#12 的**内核 + 闭环 + 服务化**全部落地；仅剩**真机绑定**（真 HAL/Doze/AlarmManager 喂入 + 宿主把真实 App 经此服务注册）为 caller seam。

> **📋 真机接线行动件已整理（2026-09-04，`docs/device-bring-up.md`）**：把"仅剩的真机绑定"落成可执行清单——(1) 电池/热/功耗真采样（用 `amos-power::android::AndroidBatteryTelemetry` + `amos-profiling::android` 喂 daemon energy）、(2) per-app 进程宿主驱动 `AppLifecycle`（现可经 `Governor` gRPC 注册/移动）、(3) `amos-scheduler` 的 `next_wake`/`due` 绑 `AlarmManager`/`JobScheduler`/Doze，各含接线点/复用 seam/验收判据；§4 "daemon 托管生命周期"(gRPC Governor) **已实现**。宿主可验证部分至此已全部落地且 `make test`/`make lint` 全绿。


### 优先级 P3 —— 补齐"独立 OS"叙事才需要的（若只做 no-UI Android 委托底座可豁免）
13. **[内核] 真独立 RIL/基带层**（AT/QMI/RILJ 直连 Modem）、独立 Wi-Fi/BT 协议栈、PMIC/suspend/调频控制 —— 仅当脱离 Android 时是刚需，否则**强烈不建议自造**（`docs/telephony.md` §12 已明确：紧急硬通路等属平台/RIL/厂商保证，用户态 crate 不应宣称）。

---

## 4. "别重做 / 应委托"清单（防止重复造轮子）

- **Wi-Fi/BT/Radio 射频、Modem、协议栈、驱动**：no-UI Android 已有，勿重建（`docs/radio.md` 开头明确）。
- **内核/驱动/HAL 层**：整体委托（`docs/no-ui-android.md`）。
- **紧急呼叫硬保证**：属 Telecom 框架 + RIL/厂商 HAL + 锁屏紧急拨号器，非用户态 crate（`docs/telephony.md` §12 #2）——AmOS 只做分类/独立 provider/审计/ROLE_DIALER 注册。
- **领域内核 + seam 基建（勿重写）**：radio/telephony/sensor/audio/profiling/appstore 等都已是"内核 + provider seam + Mock"成熟形态，缺口只在"真机 provider 接线 + 装配"。
- **单一守护的保活**（`oom_score_adj -1000`、UDS 心跳、`amos-supervisor`）已存在，勿当缺失重做；缺的是它之上的**应用层**生命周期，不是给 daemon 加更狠的保活。

---

## 5. 建议推进顺序

1. **P0 定口径**（一行文档即可）：把参考判据逐项标"委托/桥/内核/决策"，锚定 no-UI Android 底座——避免团队在"自建 HAL/LMK/Alarms"上走错路。
2. **P1 接线**：真机把四个 seam（radio/telephony/sensor/battery）在 System UI 里用真 `Context` 统一装配（第 7 项），逐个换成 `AndroidXxxProvider`；先通 Radio + GNSS + 起呼，再攻 telephony 进出话控与相机/IMU 流桥。
3. **P2 生命周期**：补 App 进程/前后台状态机（内核）+ JobScheduler/AlarmManager 后台任务与唤醒对齐（桥）+ 组装电池/热策略调度器。
4. **P3 仅当转独立 OS** 才启动自建底层。

---

## 6. 代码证据位置速查

- Radio seam：`crates/amos-radio/src/android.rs` · 桥：`crates/amos-tauri/src/radio.rs`
- Telephony seam：`crates/amos-telephony/src/android.rs` · 责任边界：`docs/telephony.md` §12
- Sensor seam：`crates/amos-sensor/src/android.rs` · `docs/sensors.md` §6
- Profiling/power seam：`crates/amos-profiling/src/android.rs` · `docs/profiling.md` §5
- Audio FFI seam：`crates/amos-audio/src/android/{tinyalsa,aaudio}.rs` · `docs/audio-hal-bridge.md`
- Process/守护：`crates/amos-supervisor/src/lib.rs`（用户态守护，非 LMK）
- 保活/oom：`deploy/android/amos.rc`（`oom_score_adj -1000`）、README "Lifecycle" 段（设计意图，非代码）
- 独立 OS 提案（未落地）：`docs/no-ui-android.md` §4/§5
- 既有缺口全集：`FUNCTIONAL_GAP_ANALYSIS.md`（§二.22/§二.25 自认无生命周期/后台调度；§六战略）
