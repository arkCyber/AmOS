# 原生精确闹钟桥（Native Exact-Alarm Bridge）— 设计 + 诚实边界

> 目标（§9 ③）：让 Clock 闹钟的「到时 / 响铃」**不依赖时钟 App/WebView 是否在前台计时**——到点唤醒交给原生侧。
> 状态：**原生纯核心已落地并测试**（`amos-scheduler` 新增 `ExactAlarmClock`）；Tauri 命令与设备侧 `AlarmManager` 绑定是待办（见「边界」）。

## 现状与动机
- 时钟 App 与 OS 级到点提醒（`frontend-ts/src/lib/alarmNotify.ts`）都靠 WebView 里 `setInterval` 轮询 `amos.alarms` 计时——只要 **WebView 活着**，切到别处也会到点提醒（前几轮已落地）。
- 但若 **WebView 被节流 / 进程被杀 / 整机息屏**，JS 定时器不可靠；这时需要**原生**用绝对墙钟在精确时刻醒来。

## 已落地：`amos-scheduler::ExactAlarmClock`（纯 `std`）
把「某 alarm-id 在**绝对 epoch 毫秒**响一次」建模成 fire-once 账本：

| API | 语义 |
| --- | --- |
| `register(id: JobId, at_ms)` | 安排一次性到点（同 id 覆盖=改点；每日闹钟到点后再 register 下一天） |
| `due(now_ms) -> Vec<JobId>` | 返回并**移除**所有 `at_ms <= now` 的到点闹钟（每个只响一次，按时/按 id 有序） |
| `next_at(now_ms) -> Option<u64>` | 最早未来唤醒毫秒（喂给 AlarmManager / 宿主“睡到此刻”） |
| `cancel(id)` | 取消 |

- 时钟可注入（调用方传 `now_ms`）→ 确定性单测（+4，`cargo test -p amos-scheduler` 现 12+1 全绿；clippy `-D warnings`、fmt 干净）。
- 导出：`pub use amos_scheduler::ExactAlarmClock;`。

## 桥的接线（计划，未在本环境落地）
1. **前端**（`lib/alarmNotify.ts` / ClockApp）：算出每个启用闹钟的**下次发生 epoch-ms**，经 Tauri `invoke` 推给原生。
2. **宿主**（`amos-tauri`，**已落地** `crates/amos-tauri/src/alarm_sched.rs`，进程共享态 `AlarmSchedState` 包 `ExactAlarmClock`）：
   - `scheduler_alarm_register { id, atMs }`
   - `scheduler_alarm_cancel { id }`
   - `scheduler_alarm_poll { nowMs? } -> { due: [id, …] }`（到点一次性返回并移除）
   - 到点后由调用方把 id 抛给 WebView（触发既有响铃动画/横幅）；每日闹钟到点后再 `register` 下一天。
   - 已注册到 `invoke_handler` 与 `.manage`；`cargo test -p amos-tauri --lib alarm_sched::` 3 通过、clippy `-D warnings` 0。
3. 一个原生线程/`AlarmManager` 回调：`sleep_until(next_at)` → `due(now)` → 把到点 id 抛给 WebView。

## 诚实边界（重要）
- 本环境（无 Android 真机）**无法验证真正的“进程被杀/深度息屏唤醒”**：那需要把 `next_at` 接到设备的 **Android `AlarmManager`（`setExactAndAllowWhileIdle`）+ 常驻前台组件**上——这是设备侧绑定，且需跨真机验收。
- 即便 WebView 被节流但**进程仍活**，用本核心 + 宿主线程轮询即可让到点判定脱离 JS 计时器（可在 dev/桌面验证）；“进程死→被 OS 复活”才是 AlarmManager 的范畴。
- 每日重复由调用方在每次 `due` 后 `register` 下一天（核心保持 fire-once、最小语义）。

## 设备步骤（Android，已接真机时）
仓库已提供 **AlarmManager 绑定模板**（`crates/amos-tauri/android-glue/com/amos/ai/glue/`）：
- `AlarmGlue.kt`：`schedule(ctx,id,atMs)` 用 `setExactAndAllowWhileIdle`（API 31 先查 `canScheduleExactAlarms`，被禁则诚实跳过）；`cancel`。在 Rust `scheduler_alarm_register/cancel` 成功后各调用一次（注意线程：Android 主线程 / Handler）。
- `AlarmReceiver.kt`：到点广播 → 把 System UI 提到前台（`FLAG_ACTIVITY_NEW_TASK|SINGLE_TOP|REORDER_TO_FRONT`）→ WebView 既有 `alarmNotify` 轮询即显示响铃动画。
- 需在 Manifest 声明 `<receiver AlarmReceiver/>` 并授予 `SCHEDULE_EXACT_ALARM`（Android 12+）、`POST_NOTIFICATIONS`。

仓库内可先行验证的“宿主循环契约”已加为集成测试 `crates/amos-scheduler/tests/alarm_host_cycle.rs`（arm → next_at 唤醒 → due 一次性触发 → 每日再武装；`cargo test -p amos-scheduler` 通过）。Kotlin 端按仓库约定为**结构交付**，需在生成 Android 工程/真机上编译验证。

### 真机验收清单（连接设备后）
1. `adb shell dumpsys alarm | grep amos` 应看到 `setExactAndAllowWhileIdle` 注册的 alarm。
2. 设一个 1 分钟后的闹钟 → 灭屏等待 → 到点设备应被唤醒并把 System UI 提到前台（WebView 弹出响铃动画）。
3. 关闭电源管理限制（省电白名单）后重复 2，验证“进程被杀→被 OS 复活”路径。
4. 取消闹钟 → `dumpsys alarm` 中该项消失。
