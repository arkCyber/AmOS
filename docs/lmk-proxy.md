# Android LMK-proxy：Activity/Task 生命周期代理（`amos-android::lmk`）

> **定位**：让「AmOS 管控容器内 legacy APK 的生死」成为一条 **可离线验证**的管线。
> 本页对应 `crates/amos-android/src/lmk.rs` + `android_compat.proto` 的
> `OnActivity` / `GetLmkSnapshot` / `TriggerLmk`。**Waydroid = 开发/原型载体；
> 真机 = no-UI Android 基座**（`docs/android-compat.md` 顶部定位判定）——本代理是
> 「载体无关」的，两种底座上它都夹在「Android ActivityManager/lmkd 侧」与
> 「AmOS 侧」之间。

## 1. 它解决什么问题

Tauri System UI 永远不直接跑 APK。APK 在 Waydroid / 容器里运行，表面被合成为
AmOS 窗口。问题在于：**默认 Android 的 `lmkd`（Low Memory Killer）会背着 AmOS
静默决定杀哪个进程**，与 AmOS 的窗口/能量治理脱节——用户可能正盯着一个可见表面，
却在不知道的情况下被容器回收；或相反，后台一堆僵尸进程把内存占满。

**LMK-proxy = 把「杀谁」的决定权从容器 lmkd 收到 AmOS 手里**，并用与 daemon 侧
`ResourceGovernor` / `governor.proto` **同一套重要性阶梯**（`foreground / visible /
foreground_service / background / cached / stopped`）来表达。

## 2. 与 AmOS host 生命周期（`amos-applife`）的分工

仓库里 `amos_applife::{AppId, AppState}` + `amos-ai::ResourceGovernor` 已实现
**AmOS host 进程**模型（register/move/freeze/thaw/reclaim + LRU）。其中 `Visible`
在设计上「由表面可见性派生、不可经 wire 设置」（`governor_service.rs`）。

因此本模块 **只复用 `amos_applife::AppState` 这个类型**（rank/key 与 governor 零漂移），
**registry 自成一体**：它建模 **Android 容器内进程重要性**（top-Activity `Paused` 仍可见时
必须留在保护层、绝不能成为回收候选），与 host 模型是两个命名空间。`docs/device-bring-up.md`
§4 里 daemon 侧那条 `Governor` 服务管 host 注册的 app；本 proxy 管容器侧 APK 的任务。
**两者已打通**：`AndroidManagerService` 的每个容器转移都会经一个 `LmkHost` sink 上送
daemon 共享的 `ResourceGovernor`（`register_app`/`move_app`/`kill_app`，见 §8）。

```
[ Tauri core / daemon ] --OnActivity--> [ LmkProxy ] --importance(AppState)--> 与 governor 同词表
        ^                                    |  under MemoryPressure  (Low/Critical)   │
        └------ TriggerLmk (victims) --------┘                                          ▼
                       │   Freeze -> 留表面、转 Cached          LmkHost 桥 ──► ResourceGovernor
                       └── Kill   -> 容器 am force-stop（已接线）         (register/move/kill)
                                      + amos-wm legacy 表面 teardown（seam，真机）
```

## 3. 状态机

每个已启动包一条 `Record`：

| 字段 | 含义 |
|---|---|
| `window_id` | 该 legacy 表面在 `amos-wm` 注册的 id（`legacy:<window_id>`） |
| `activity` | top Activity 生命周期（`Created/Started/Resumed/Paused/Stopped/Destroyed`） |
| `service` | 进程是否在跑用户可感知前台服务（媒体/通话） |
| `cached`   | 是否已被冻结成 `Cached` 墓碑 |
| `seq`      | LRU 单调序（越大越新用） |

**派生重要性**（`Record::importance`）：

| 条件 | `AppState` | 可否回收 |
|---|---|---|
| `cached` | `Cached` | ✅（最先） |
| `activity==Resumed` | `Foreground` | ❌ |
| `activity∈{Created,Started,Paused}`（可见） | `Visible` | ❌ |
| `activity∈{Stopped,Destroyed}` 且 `service` | `ForegroundService` | ❌ |
| `activity∈{Stopped,Destroyed}` 且非 `service` | `Background` | ✅（最后） |

事件 → 转移：`launch`（建表到前台）、`resume`（→Foreground）、`pause`（→Visible）、
`stop`（→Background）、`destroy`（移除表）、`start_service`/`stop_service`、
`freeze`（仅 `Background`→`Cached`，保护层不动）、`thaw`。

## 4. 内存压力裁决（`plan` / `apply`）

`MemoryPressure`：`None`（不动）／`Low`（只冻结，不杀）／`Critical`（回收杀）。

- **Low**：LRU 的 `Background`（按 `seq`）→ 冻结成 `Cached`，留表面与 saved state。
- **Critical**：先回收 `Cached` 再 `Background`（同层内 LRU 在前）→ 移除任务（proxy 内），
  并由 service 对每个 `Kill` victim 真下发容器 `am force-stop`（见 §5）。

保护层（`Foreground/Visible/ForegroundService`）永不被选；`plan` 只读不改变状态，
`apply` 决定并就地转移，返回 `LmkDecision{victims, cached_now, background_now}`，
每个 victim 带 `window_id` 与 `action`（Freeze/Kill）。

## 5. wire（`android_compat.proto`，additive）

| RPC | 作用 |
|---|---|
| `OnActivity(ActivityEventRequest)` | 把容器观察到的 Activity 事件推给 proxy，返回派生 importance `state_key` |
| `GetLmkSnapshot(Empty)` | 列出每个跟踪任务 + 当前 tier + cached/background 计数 |
| `TriggerLmk(LmkRequest)` | 按压力跑 `apply`；对每个 `Kill` victim 真下发容器 `am force-stop`，返回 victims（`killed`=已杀） |
| `ApplyHostDecision(HostActionRequest)` | **反向**：System UI / 宿主把 host 决定经 wire 下发容器——`Reclaim`→真 `am force-stop`+移除任务，`Freeze`/`Thaw`→镜像 proxy tier |
| `WatchLmk(Empty) → stream LmkEvent` | **server-streaming**：推送容器 LMK 决定（`RECLAIMED`/`FROZEN`/`THAWED`/`DESTROYED` + `package_name` + `window_id`）；System UI 据 `window_id` 拆/刷新 `legacy:<id>` 表面。best-effort 广播，慢订阅者错过则用 `GetLmkSnapshot` 重同步 |

`launch_android_app` 成功时自动把该包登记为前台任务（resumed + `window_id`），
后续生命周期即由 AmOS 接管。`state_key` 复用 `AppState::key()`（与 governor 同词）。

## 6. 验证路径

- 纯逻辑单测（`lmk.rs`）：重要性派生、LRU 冻结/回收次序、保护层不被选、`plan` 不改状态、
  `foreground_service` 保护隐藏 Activity、`plan`/`apply`、0 budget、key 稳定、计数。
- service 级（`service.rs` 测试，不走 socket）：launch 收养 → Activity 事件推进 importance
  → snapshot → Critical 回收 / Low 冻结；`UNSPECIFIED` pressure/event → `InvalidArgument`。
- 真 UDS e2e（`tests/e2e_test.rs`）：`launch → OnActivity(Stop) → GetLmkSnapshot →
  TriggerLmk(Critical)` 一轮真实往返，victim 的 `window_id` 与 `killed=true` 就位，
  且**同一条 recorded runner 上验证「launch 下发 `waydroid app launch`、Kill 下发
  `waydroid shell am force-stop <pkg>`」**（容器侧执行已真正接线，见 §5）。
- **host 桥（service 级，假 `RecordingHost`）**：launch→`state=foreground`、OnActivity
  Stop→`state=background`、TriggerLmk Critical→`kill` 均被上报；`Pause`（容器 `Visible`）
  映射为 host `Foreground`——**host 永不见 `visible`**（host 无该可设状态）。
- **host 桥（daemon 集成，`amos-ai/tests/lmk_governor_bridge.rs`）**：在**同一个共享
  `ResourceGovernor`** 下（`GovernorService` 读、android 服务经 `GovernorLmkHost` 写），
  launch/OnActivity/TriggerLmk 依次反映为 host `register→Foreground`、`MoveApp→Background`、
  `kill→移除`，经 `Governor::GetState` 读回，两套 registry 一致（§8）。

- **反向驱动（daemon 集成，`amos-ai/tests/lmk_reverse_drive.rs`）**：同一共享 governor +
  记录式 `WaydroidRuntime` 下，`observe(memory_pressure)` 回收后，`drive_host_decisions`
  只对**容器管理** app 下发真 `am force-stop`（host-native app 不误杀），proxy 任务被移除、
  managed 集合清空（§8）。

```bash
cargo test -p amos-android            # 52 单测 + 1 真 UDS e2e（e2e 亦含 ApplyHostDecision + WatchLmk 往返）
cargo test -p amos-ai --test lmk_governor_bridge   # 正向桥集成
cargo test -p amos-ai --test lmk_reverse_drive     # 反向驱动集成
cargo test -p amos-tauri --lib        # 67（含 android_lmk::surface_payload 3 项）
cargo clippy -p amos-android -p amos-ai -p amos-tauri --all-targets -- -D warnings
cargo fmt -p amos-android -p amos-ai -p amos-tauri -- --check
cd crates/amos-tauri/frontend-ts && bun run typecheck && bun run test   # lmk.test.ts 5 项
```

## 7. 诚实边界（本机 / 无真机不可端到端验证的部分）

- **容器侧 Kill 已执行；状态机层拆除 + 通知链路已闭环（真机像素 teardown 除外）**：`LmkAction::Kill` 现会移除 proxy 记录、
  返回 `window_id`，并**真下发容器 `am force-stop`**（`WaydroidRuntime` 走
  `waydroid shell am force-stop <pkg>`；`DemoRuntime` 记录 `stops()`；service 的
  `TriggerLmk` 对每个 Kill victim 经 `EnhancedAndroidManager::force_stop_app` 调用，
  `CommandRunner` 可注入、离线可断言）。**状态机层的拆除原语与通知均已具备**：System UI
  侧 `amos-tauri::wm` 的 `open_surface("legacy:<id>")` 注册 external 表面，`close`/
  `wm_close` 在状态机层把它移除（`Closed` 事件对 external 只跳过 host 端真实关闭）；daemon
  经 `WatchLmk` 推送（governor-beat 与容器侧都接入同一广播），`amos-tauri::android_lmk` 订阅并
  转发为 `lmk-surface`，前端 `lib/lmk.ts::startLmkSurfaceWatcher` 在 `close_surface` 时对
  `legacy:<id>` 调 `wm_close`（另有周期 reconcile 兜底）。真正的剩余是**真机像素层**：no-UI
  基座（`SurfaceControl`）的进程/表面 teardown，以及把移除/回收翻译到 Waydroid 合成表面的视觉层。
- **容器事件喂入是 seam**：`OnActivity` 由调用方（System UI/桥）按容器实际 Activity
  回调填入；本模块不解析 binder/lmkd。真实 Android 一个进程可含多 Activity：当
  `ActivityEventRequest.activity_id` **为空**时按「每包一 top-Activity 任务」建模（由适配器
  折叠成顶层事件）；**带上 activity_id** 时走「活动折叠」——**存活性与 importance 解耦**：
  `STARTED(id)` 把该活动记为存活（任务只在**最后一个**活动 Destroy 时才拆），`Resume` 才把
  它升为顶层驱动 importance，且**针对非顶层的 `Stop`/`Pause` 不改变包 tier**（叠层里被盖住的
  “stopped 兄弟”既不误降前台、也不在顶层结束时被误拆）。离线单测已覆盖该语义。真正接线仍需
  能命名活动的真容器适配器把 identity 填上。
   `amos-android::activity_observer` 已提供**稳定 identity（`ComponentName#instance`）+ 顶层折叠**
   的可离线测试核心（onStart→STARTED / 顶层 Resume/Pause/Stop / onDestroy→带 id）。剩下的接线是把
   真机 **ActivityManager（binder / `dumpsys activity`）** 的活动回调喂进该折叠器。

- **「每包一个任务」的简化**：demo/单 surface 路径成立；真实 split/多任务需扩展为
  per-task 栈。VM 无法在 mac 上起 Waydroid 验证像素层。
- **桥已双向（容器→host 上报 + host→容器回收驱动），但「物理执行」限于 force-stop**：
  正向 `GovernorLmkHost` 上送；反向由 `serve()` 的 governor beat 在每次 `observe` 后经
  `drive_host_decisions` 只对**容器管理** app 执行真 `am force-stop`/冻结/解冻镜像（§8）。
  已留的 seam：no-UI 基座 `SurfaceControl` teardown、以及把 host 解冻（thaw）翻译成容器内
  真实 surface 唤醒——「kill 推送」已不再是缺口（见上一条与 §8）。

## 8. container ↔ host 双向桥（正向上报 + 反向驱动，均已接线）

容器 proxy 与 daemon host 闭环原来分处两库、词表相同但互不相知。本桥把每一处容器转移
经一个 `LmkHost` sink 上送 daemon 的**同一个** `Arc<Mutex<ResourceGovernor>>`，让
`Governor::GetState` / daemon 周期 beat 都能看到容器内 legacy APK 的真实状态与生死；
并把 host 的回收/冻结决定**反向**驱动回容器。

**组件**

| 位置 | 角色 |
|---|---|
| `amos-android::lmk::{LmkHost, NoopLmkHost, host_state, HostAction}` | sink trait + 默认 no-op + 映射 + 反向动作 |
| `amos-android::service::{with_manager_and_host, with_runtime_and_host, with_parts, with_parts_and_events, apply_host_action}` | 注入 host sink / 共享 proxy+manager / 反向落地 |
| `amos-ai::governor_service::GovernorLmkHost` | 实现 `LmkHost`，绑定共享 `ResourceGovernor` + 记录容器管理包集合 |
| `amos-ai::governor_service::drive_host_decisions` | 把 `GovernorOutcome` 的 reclaimed/frozen/thawed 只对**容器管理** app 反向驱动 |
| `amos-ai::server.rs::serve()` | 用共享 proxy/manager/host 构建 android 服务；beat 在每次 `observe` 后调 `drive_host_decisions` |

**正向触发点（`AndroidManagerService`）与映射**

- `launch_android_app` 成功 → proxy 前台 → `report_state(Foreground)` → host `register_app`（未注册则建前台）。
- `OnActivity`（Resume/Pause/Stop/Destroy）→ 派生容器 tier → `report_state(host_state(tier))`。
  容器事件流对 proxy 是**权威来源**，因此对「未跟踪」包也**自愈收养**（daemon 重启清空 registry 但容器 app 仍在跑、或 app 自容器内/通知前台化时，靠事件流即可重建，无需人工 relaunch）：`Resume`→前台、`Pause`→`Visible`（受保护）、`Stop`→`Background`、`Destroy`→任务移除（本就未跟踪则良性 `stopped`）；已跟踪包走常规状态迁移。无事件喂入的静默 app 无法凭空重建（需适配器在重启后补发当前态事件）。**可选 `activity_id`**：带上时走「活动折叠」——`STARTED` 记存活、`Resume` 升顶层驱动 importance、`Stop`/`Pause` 只作用于顶层、`Destroy` 仅在**最后**存活活动时才拆任务/发 `Destroyed`（见 §7）。
- `TriggerLmk`：`Freeze` victim → `report_state(Cached)`；`Kill` victim → `am force-stop` + `report_killed()`（host `kill_app`，无 saved state）。
- `host_state`：容器 `Visible` → host `Foreground`（host 无可设 `Visible`；保证「可见但失焦」的 legacy 仍受 host 保护）；其余 tier 一一对应。容器权威的 `visible` 仍由 `GetLmkSnapshot` 精确上报。

**反向（host → 容器）**

- `serve()` 的 governor beat 每次 `observe` 后调用 `drive_host_decisions(&outcome, &host, &proxy, &manager)`。
- **System UI / 宿主也可经 wire 主动下发**：`AndroidManager::ApplyHostDecision(HostActionRequest)`（Freeze/Thaw/Reclaim），
  内部走 `AndroidManagerService::apply_host_action`。
- `GovernorLmkHost` 维护「容器管理」包集合（首次 `register_app` 时加入、`kill`/反向回收时移除），
  因此只有**真实容器 app** 会被反向驱动；host-native app（如 System UI 自注册的 "notes"）**不误杀**。
- `reclaimed` → 真 `am force-stop` + proxy 移除；`frozen`/`thawed` → `proxy.freeze`/`thaw` 镜像 tier。
- **反向驱动的失败不再被吞掉（REQ-A146）**：`proxy.freeze/thaw/destroy` 与 `manager.force_stop_app`
  的 `Err` 以前是 `let _ =`（既没有重试、也没有日志），于是「host 认为已墓碑 / 容器仍在跑」这种**双方状态
  分叉**对任何观察者都不可见。现在每个失败的镜像操作都按 `op`/`package`/`error` 记 `warn`
  （`mirror_failed`），best-effort 语义不变（照旧继续，不阻断 tick）；正向的 `report_state` 同理：
  容器报的 tier 若 host 无法表示（`Visible` 没有对应 host 状态，`move_app` 返回 `InvalidTransition`），
  或 `register_app` 被拒，都会记 `warn` 并说明「host 保留上一状态」。测试见
  `crates/amos-ai/tests/lmk_reverse_drive.rs`（捕获日志断言，非仅断言行为）。

**LMK 事件推送（`WatchLmk`，daemon 侧已建）**

`AndroidManagerService` 持一个 best-effort `broadcast`，在每一处**容器侧/System-UI 可见**的决定
（`TriggerLmk` 的 Kill/Freeze、`ApplyHostDecision` 的 reclaim/freeze/thaw、`OnActivity` Destroy）
上广播 `LmkEvent{package_name, window_id, kind}`；`WatchLmk(Empty) → stream` 把同一 fan-out 推给
订阅方。`serve()` 用共享 channel 装配（`with_parts_and_events`），**governor-beat 的
`drive_host_decisions`（host 主动回收）也已接入同一广播**，因此容器侧与 host 侧的所有 LMK
决定都出现在事件流上。**System UI 后端已订阅**：`amos-tauri::android_lmk::spawn_lmk_watch`
（`setup()` 启动）打开 `WatchLmk` 并把每个事件转发为 WebView 的 `lmk-surface` 事件，载荷
`LmkSurfacePayload{window_id, kind, close_surface}`——`RECLAIMED`/`DESTROYED` 时
`close_surface=true`。**前端已闭环**：`lib/lmk.ts::startLmkSurfaceWatcher`（`App.tsx` 启动期
订阅）在 `close_surface` 时对 `legacy:<window_id>` 调 `wm_close`（纯映射有单测）。仍剩：端到端
需在**真起 Tauri host + daemon** 上目视验证（GUI 无法离线跑）。

`GovernorLmkHost::report_state` 先查 host 现状：与目标相同则**跳过**（避免每次 `move_app`
都 bump LRU 使 recency 失真）；未注册先 `register_app` 再 `move_app`。

