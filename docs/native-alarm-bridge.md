# 原生精确闹钟桥（Native Exact-Alarm Bridge）— 设计 + 诚实边界

> 目标（§9 ③）：让 Clock 闹钟的「到时 / 响铃」**不依赖时钟 App/WebView 是否在前台计时**——到点唤醒交给原生侧。
> 状态：**原生纯核心已落地并测试**（`amos-scheduler` 的 `ExactAlarmClock`）；Tauri 命令已落地；**设备侧 `AlarmManager` 绑定已接线**（REQ-A369：Kotlin 上呼 `attachContext` + Rust `alarm_sched::android`）；**真机验收仍待做**（`dumpsys alarm` 从空变非空 + 到点真唤醒；本轮设备未连）。

## 现状与动机
- 时钟 App 与 OS 级到点提醒（`frontend-ts/src/lib/alarmCore.ts` 的 `syncDueAlarmAlerts`，由 `svelte/osAlarmWatcher.ts` 每 2s 驱动）都靠 WebView 里 `setInterval` 轮询 `amos.alarms` 计时——只要 **WebView 活着**，切到别处也会到点提醒（前几轮已落地）。
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

## 桥的接线
1. **前端**（`svelte/osAlarmArm.ts`，由 `svelte/osAlarmWatcher.ts` 驱动）：用纯 `lib/alarmCore.nextArmments` 算出每个**启用**闹钟的**下次发生 epoch-ms**，经 Tauri `invoke` 推给原生；**并在每次闹钟列表变化时对齐**——新增/重新启用 → `register`，停用/删除 → `cancel`（否则被关掉的闹钟仍会被原生调度器唤醒）。启动时也先对账一次，因为开机后可能根本不打开时钟 App。
   - 纯逻辑 `nextArmments` 亦被 `syncDueAlarmAlerts` 复用：**刚刚响过**的每日闹钟立刻 `register` 下一次（fire-once 核心 + 调用方循环）。
2. **宿主**（`amos-tauri`，**已落地** `crates/amos-tauri/src/alarm_sched.rs`，进程共享态 `AlarmSchedState` 包 `ExactAlarmClock`）：
   - `scheduler_alarm_register { id, atMs }`
   - `scheduler_alarm_cancel { id }`（前端已接线：`svelte/osAlarmArm` 在停用/删除时调用）
   - `scheduler_alarm_poll { nowMs? } -> { due: [id, …] }`（到点一次性返回并移除）——**前端刻意未接**：WebView 存活时的到点判定已由 `syncDueAlarmAlerts` 的墙钟对账覆盖，接上 poll 只会多一条可能重复的路径；等真机验证「进程被节流后恢复」再决定是否改走它。
   - 到点后由调用方把 id 抛给 WebView（触发既有响铃动画/横幅）；每日闹钟到点后再 `register` 下一天。
   - 已注册到 `invoke_handler` 与 `.manage`；`cargo test -p amos-tauri --lib alarm_sched::` 3 通过、clippy `-D warnings` 0。
3. **设备侧绑定（REQ-A369 已接线）**：`crates/amos-tauri/src/alarm_sched.rs` 的 `#[cfg(feature = "android")] mod android` 持有 `JavaVM` + `Context` 的 `GlobalRef`（由 Kotlin `AlarmGlue.bind` 在 `MainActivity.onStart` 上呼 `Java_com_amos_ai_glue_AlarmGlue_attachContext` 交进来），两个命令各自调用 `AlarmGlue.schedule(ctx, id, atMs)` / `AlarmGlue.cancel(ctx, id)`（`setExactAndAllowWhileIdle(RTC_WAKEUP, …)`）。到点由 `AlarmReceiver`（`AndroidManifest.components.xml`）拉起 System UI 前台，WebView 既有的 `osAlarmWatcher` → `syncDueAlarmAlerts` 显示响铃动画。
   - **接线是机器持有的**：生成工程 `crates/amos-tauri/gen/`（git-ignored）里那一行 `AlarmGlue.bind(applicationContext)` 会被 `cargo tauri android init` 重新生成 ⇒ 判据写进 `scripts/android-activity-wiring-check.sh`（REQUIRED 表）与 `scripts/android-glue-mirror.sh`（manifest 片段一致性）✓；权限与调用点的对应关系写进 `scripts/android-permission-scan.mjs` 的 `exact-alarm` 家族 ✓。
   - **回包是事实，不是空值**：`scheduler_alarm_register` 现在答 `AlarmArmed { id, atMs, device }`，`device` 是类型化的 `DeviceOutcome`（`scheduled` / `disallowed` / `unavailable` / `denied` / `unattached` / `host_only` / `unknown(词)`）；`scheduler_alarm_cancel` 答 `AlarmCanceled { id, wasRegistered, device }`。**只有 `scheduled` 意味着锁屏/息屏后手机真会被叫醒** ✓，其余状态由 Clock 闹钟页的横幅如实显示（`data-testid="alarm-native-wake"`）。

## 诚实边界（重要）
- **设备侧绑定已接线，但真机验收未做** ✗：`dumpsys alarm | grep -i amos` 应从**空变非空**、`atMs` 前后应看到**真的唤醒**（`AlarmReceiver` 拉起前台 + WebView 响铃）。本轮设备不在线，**没有**任何真机读数 ⇒ 只能给"代码 + 主机编译 + 门"三类证据，不能宣称它已在设备上工作。
- **系统可以拒绝精确闹钟**（Android 12+）：`canScheduleExactAlarms()==false` 时 `AlarmGlue.schedule` 答 `disallowed`（**不排程、不假装**），`setExact…` 抛 `SecurityException` 时答 `denied`。宿主据此让 Clock 页显示横幅而不是照旧显示"已设置"——**"平台说不行"必须看得见** ✓（`F-TAU-010`）。
- **权限选择的取舍**：`USE_EXACT_ALARM`（API 33+，闹钟类应用安装即得、无对话框）+ `SCHEDULE_EXACT_ALARM`（API 31/32 的 per-app 授权，`AlarmGlue.openExactAlarmSettings` 打开系统页）。**`POST_NOTIFICATIONS` 故意不声明** ✗ —— 响铃由 WebView 在 `AlarmReceiver` 拉起前台后绘制，本仓没有任何发通知的调用点，声明它只会变成 `android-permission-scan` 报的 stale 条目（与 `BLUETOOTH_ADVERTISE` 同理）；将来真有通知路径时再声明。
- 即便 WebView 被节流但**进程仍活**，用本核心 + 宿主线程轮询即可让到点判定脱离 JS 计时器（可在 dev/桌面验证）；"进程死→被 OS 复活"才是 AlarmManager 的范畴，且需要**真机 + 省电白名单**才能验。
- 每日重复由调用方在每次 `due` 后 `register` 下一天（核心保持 fire-once、最小语义）。

## 设备步骤（Android，已接真机时）
仓库已提供 **AlarmManager 绑定模板**（`crates/amos-tauri/android-glue/com/amos/ai/glue/`）：
- `AlarmGlue.kt`：`schedule(ctx,id,atMs)` 用 `setExactAndAllowWhileIdle`（API 31 先查 `canScheduleExactAlarms`，被禁则诚实跳过）；`cancel`。在 Rust `scheduler_alarm_register/cancel` 成功后各调用一次（注意线程：Android 主线程 / Handler）。
- `AlarmReceiver.kt`：到点广播 → 把 System UI 提到前台（`FLAG_ACTIVITY_NEW_TASK|SINGLE_TOP|REORDER_TO_FRONT`）→ WebView 既有的 `osAlarmWatcher` → `syncDueAlarmAlerts` 轮询即显示响铃动画。
- 需在 Manifest 声明 `<receiver AlarmReceiver/>` 并授予 `SCHEDULE_EXACT_ALARM`（Android 12+）、`POST_NOTIFICATIONS`。

仓库内可先行验证的“宿主循环契约”已加为集成测试 `crates/amos-scheduler/tests/alarm_host_cycle.rs`（arm → next_at 唤醒 → due 一次性触发 → 每日再武装；`cargo test -p amos-scheduler` 通过）。Kotlin 端按仓库约定为**结构交付**，需在生成 Android 工程/真机上编译验证。

### 真机验收清单（连接设备后）
1. `adb shell dumpsys alarm | grep amos` 应看到 `setExactAndAllowWhileIdle` 注册的 alarm。
2. 设一个 1 分钟后的闹钟 → 灭屏等待 → 到点设备应被唤醒并把 System UI 提到前台（WebView 弹出响铃动画）。
3. 关闭电源管理限制（省电白名单）后重复 2，验证“进程被杀→被 OS 复活”路径。
4. 取消闹钟 → `dumpsys alarm` 中该项消失。
