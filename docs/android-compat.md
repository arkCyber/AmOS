# Android Compat Layer (Waydroid)

> **⚠️ 定位判定 (Deployment Decision, 2026-09-03)** — 本文描述的 **Waydroid / LXC 容器路径是「开发 / 原型」兼容层**：在**非 Android 主机（桌面 Linux / 通用硬件 / 尚无系统 Android 的测试机）**上验证「APK 启动 → 表面 → 与 `amos-wm` 多窗口协同」整条管线，也是 CI / 无真机开发时的端到端载体。
> 在**真机产品本体**上，底座是 **no-UI Android 基座**（见 `docs/no-ui-android.md`）：旧 APK 是**原生 Android 进程**直接运行，**不需要 Waydroid**；届时 `amos-android` 的 `AndroidRuntime` 驱动换成面向原生 app 的 driver（`am start` / SurfaceControl / VirtualDisplay）。本页的"合成 / 多窗口 / 输入法共享"协议思路在真机路径上继续适用，只是底层载体不同。
>
> 一句话：**Waydroid = 开发原型时跑 APK 用；产品 = no-UI Android 基座，APK 原生跑。**

The Tauri System UI never runs an APK directly. Legacy Android apps run inside a
**lightweight Android runtime container (Waydroid / LXC)**, and its capability is
**piped through gRPC** and composited into Tauri windows.

```
[ Tauri System UI (Launcher) ]
      │ 1. launch/control (gRPC)        ▲ 2. surface (Wayland / DMA-BUF texture)
      ▼                                 │
[ Rust core (amos-tauri) ] ──control──► [ Waydroid container (Android Runtime) ]
                                               │ executes
                                               ▼
                                       [ legacy APK (WeChat/Douyin) ]
```

## Implemented (`crates/amos-android`)

- **`proto/android_compat.proto`** (compiled into `amos-proto`):
  `AndroidManager` service with `LaunchAndroidApp` + `InstallAndroidApp` +
  `GetInstalledApps` (plus the Activity/LMK-proxy RPCs, see `docs/lmk-proxy.md`).
- **`AndroidRuntime` driver abstraction** (`runtime.rs`) so the layer works for
  real on any host:
  - `WaydroidRuntime` — drives the real container via its CLI (device default).
  - `DemoRuntime` — in-process runtime with a curated app list that records
    launches and returns window ids; **auto-selected when Waydroid is absent**,
    so the full frontend → gRPC → daemon → runtime pipeline works end-to-end in
    dev and CI.
  - `auto()` — picks Waydroid when present on `$PATH`, else Demo.
- **`AndroidController`** drives the container via an injectable `CommandRunner`
  (real `ShellRunner` for production; fake runner for tests):
  `launch_apk`, `install_apk` (`waydroid app install`, with the installed package
  reset to deny-by-default in `capability.rs`), `list_installed_apps`, and
  **APK icon extraction** (`extract_icon_bytes`).
- **`AndroidManagerService`**: a tonic gRPC server wrapping the runtime
  (`spawn_blocking` so subprocess calls don't stall the executor). Served on the
  same UDS as `AiAgent` by `amos-ai`.
- **LMK-proxy / Activity-Task lifecycle** (`lmk.rs`, 2026-09): an AmOS-side
  authority that proxies the container's silent `lmkd` — it tracks each launched
  package's top-Activity lifecycle + optional foreground service + LRU recency,
  derives its importance tier with the same rank ladder as
  `amos-applife`/`governor.proto`, and under memory pressure decides which tasks
  to freeze (`Background -> Cached`) or kill. Exposed over gRPC as `OnActivity` /
  `GetLmkSnapshot` / `TriggerLmk`; `launch_android_app` auto-adopts a launched app
  into the proxy. A `Kill` issues a real container `am force-stop`. Every container
  transition is also bridged **up** into the daemon's shared `ResourceGovernor`
  (`GovernorLmkHost`, `MoveApp`/`kill_app`) and host decisions are driven **back**
  into the container both by the daemon's governor beat (`drive_host_decisions` /
  `am force-stop`) and over the wire (`ApplyHostDecision` RPC, Freeze/Thaw/Reclaim),
  so host & container registries stay coherent **bidirectionally**. A server-streaming
  `WatchLmk` feed broadcasts every container LMK decision (`package_name` +
  `window_id` + kind) so a System UI subscriber can tear down / refresh the
  `legacy:<window_id>` surface. Full design & boundaries: `docs/lmk-proxy.md`.
- **Tauri commands**: `get_android_apps` / `launch_android_app`, plus a Launcher
  **「安卓应用」page** that lists app icons and launches them on tap.

Unit + end-to-end tests cover both runtimes, the gRPC handlers, icon extraction,
and the shared-UDS round trip (using fake/demo runtimes — no Waydroid needed).


## APK icon → web path flow (option 1)

1. `GetInstalledApps` → package names.
2. For each, read the APK (device path) and call `extract_icon_bytes`.
3. Write bytes to the Tauri `asset`-served dir as `icons/<pkg>.png`.
4. Set `AndroidApp.icon_path = "icons/<pkg>.png"`; frontend renders `<img>`.

## Design: input method & gesture sharing (option 2)

When the user focuses a text field inside a legacy app:

1. The legacy app's keyboard focus event is reported to the Rust core (via the
   container's IME/binder).
2. The Rust core tells the Tauri System UI to raise the **virtual keyboard**
   (Tauri overlay window).
3. Each key press is forwarded over gRPC to the container and injected as
   `input text` / key events into the focused app.

Gesture sharing mirrors the same path in reverse: system-level gestures (edge
swipe, Home, Recents) are captured by the Tauri System UI and injected into the
container or used to control the Rust `WindowManager` (see `docs/multi-window.md`).

## 验证：Waydroid 侧的多窗口行为

目标：在**有 Waydroid 的真实设备**上核对「legacy APK 启动 → 表面 → 与
`amos-wm` 多窗口协同」的整条链路。无 Waydroid 的主机由 `amos-android` 自动回退到
`DemoRuntime`(合成 window id),因此**除「真实表面合成」外的全链路**在开发机上也
可端到端跑通。

### 前置
- 设备装有 Waydroid(容器运行中),`waydroid` 在 `$PATH` 上,`amos-ai` 会自动选择
  `WaydroidRuntime`(可用 `AMOS_ANDROID_RUNTIME=waydroid` 强制指定)。
- `scripts/dev.sh` 启动守护进程 + System UI;桌面 `cargo tauri android init/build`
  产出 launcher APK(见 `docs/no-ui-android.md`)。

### 核对步骤

| # | 操作 | 预期结果 |
|---|---|---|
| W1 | 启动器打开「安卓应用」页 | 列表显示容器内已装 APK + 真实图标(`extract_icon_bytes`) |
| W2 | 点击「微信」 | 状态显示"已启动 · window_id = …";`amos-ai` 日志显示 `LaunchAndroidApp` 经 `WaydroidRuntime` 执行 `am start` |
| W3 | 连续启动两个 APK | 每次返回不同的 `window_id`,且**不与 Tauri 窗口 label 冲突**(安卓表面与 `amos-wm` 的 `WindowId` 各自独立命名空间) |
| W4 | 检查「窗口管理器 (调试)」卡片（设置 →「窗口与形态」页底部，REQ-A225 起位于此） | 每个已启动 APK 显示为一条 `legacy:<window_id> [System] Shown · 外部表面` 记录,参与聚焦/z 序;不再是 Tauri Webview 窗口 |

### 当前边界(诚实)
- **表面合成**(Wayland 层叠 / DMA-BUF 纹理,见上文「input method & gesture sharing」
  的 option 2)需要真实 Waydroid 设备;`W2` 只验证"启动命令已下发、返回 window_id",
  不验证像素是否已合成进 Tauri 窗口。
- `LaunchAndroidApp` 返回的 `window_id` 现会注册为 `amos-wm` 的**外部 `System` 窗口**
  (`legacy:<window_id>`,见 `wm.rs::open_surface`),在状态机中参与聚焦/z 序并出现在
  `wm_windows` 里,但**刻意不创建 `WebviewWindow`**(它是容器侧合成表面)。「合成 +
  多窗口」的像素层整合仍属后续工作。
- **外部表面不是分屏候选**（REQ-A226）：它的几何归容器，`apply_split_to_real` 不会为
  它摆位，所以宿主**不把它列进分屏候选**（`wm_split_candidates` / `LayoutSnapshot.candidates`
  由同一个 `pane_candidates` 剔除它）。因此 `W4` 的调试卡里能看到 `legacy:*`，而设置页的
  「可分屏窗口」看不到它——这是**如实**的差异，不是缺陷。**模型层仍可表达**（`enter_split`
  接受任意两个已注册窗口，那是"它们该在哪"的意图），但宿主会把**没能摆位**的窗格 `warn!`
  出来，而不是静默；若将来容器愿意服从窗格矩形，去掉那一处过滤即可。
- 在无 Waydroid 的 CI/开发机上,`W1`–`W4` 均可通过 `DemoRuntime` 验证(返回合成
  window id),这正是 `crates/amos-android` 端到端测试覆盖的路径。
- **LMK-proxy 的生命周期状态 + 容器侧 Kill 已落地,但「表面拆除」仍是 seam**：`TriggerLmk`
  的 `Kill` 会移除 proxy 内记录、返回确切 `window_id`(即该移除的 `legacy:<id>` 表面),
  并**真下发容器 `am force-stop`**(`WaydroidRuntime` 走 `waydroid shell am force-stop`;
  `DemoRuntime` 记录;离线用注入的 `CommandRunner` 断言)。仍属后续真机接线:向 `amos-wm`
  拆除 `legacy` 表面窗口、no-UI 基座 SurfaceControl teardown(`docs/lmk-proxy.md` §7)。

---

## 桌面形态的诚实边界：这台机器上到底有没有安卓运行时（REQ-A255）

「桌面操作系统应该也能兼容安卓 APP」是对的，但**它不是一句能力声明，而是一道平台选择题**——
安卓运行时需要一个 Linux 内核，而三种落地形态的内核归属完全不同：

| 宿主形态 | 安卓在哪跑 | 内核 | AmOS 今天的路径 |
|---|---|---|---|
| **Linux 桌面** | Waydroid（LXC 容器）**共享宿主内核** | 宿主自己 | ✅ 已实现（`WaydroidRuntime`，`waydroid` 在 `$PATH` 即自动选中） |
| **Android 真机（产品本体）** | 原生 Android 进程，**没有容器** | 设备内核 | 🟡 设计已定稿（`docs/no-ui-android.md` 的 no-UI 基座），驱动待接 |
| **macOS 桌面** | ❌ **没有可用的安卓容器** | 需要 Linux 内核；macOS 既无 KVM 也无 LXC，Waydroid 在这里构造上不可能 | ⛔ **未做**（见下方"要真做需要什么"） |

### 那么 macOS 上今天会发生什么（这一条曾经是缺陷）

`AndroidRuntime::auto()` 在**没有容器的主机**上回退到 `DemoRuntime`——一个**内置夹具**：
4 个写死的包名（微信 / 抖音 / 淘宝 / 高德）+ 合成窗口 id。它存在的理由是让整条管线
（前端 → gRPC → daemon → runtime）在开发机与 CI 上可端到端跑通。

问题在于这个「演示」此前**没有出口**：`GetInstalledApps` 只回 `apps`，于是 macOS 上的
「安卓应用」页把这 4 个应用**当成这台机器上装好的应用**列出来，点按后宿主还回报
「已启动 · waydroid_demo_com.tencent.mm」——而 `open_surface` 登记的
`legacy:waydroid_demo_*` 外部表面在这个宿主上**没有任何合成器在画**。

REQ-A255 的处置（三处，都在"谁能说这句话"的层面）：

1. **线缆带上身份**：`AppListResponse` 新增 `runtime`（`waydroid` / `demo`）与 `demo`
   （`bool`），由 `EnhancedAndroidManager::runtime_name()` / `is_demo()` 填充。
2. **界面自报家门**：`AndroidAppsReply.demo === true` 时，「安卓应用」页顶部出现横幅——
   *「本机没有 Android 运行时（Waydroid）：下面列出的是内置演示数据，不是这台机器上安装的
   应用，点按也不会启动任何真实应用」*，并显示 `runtime: demo` 供诊断。
3. **不再谎报成功**：演示模式下点按**不**显示「已启动」，也**不**写入「最近启动」
   （那份历史是假的）。`demo` 只认字面 `true`：字段缺失 = 未知，**不会**反过来冤枉真实容器。

> 真实容器（Linux + Waydroid）走的是同一条路径的另一半：没有横幅、`runtime: waydroid`、
> 启动照常报告并记录。两侧都有测试钉住（`cargo test -p amos-android` 的
> `the_list_carries_the_runtime_that_answered` + `vitest` 的 demo/real 两例）。

### 要真做需要什么（**新能力，未做**）

| 方案 | 代价 | 备注 |
|---|---|---|
| macOS 里跑 Android **VM**（Android Studio 模拟器 / Genymotion / Anbox-in-VM） | 每台机几 GB 磁盘 + 显著内存；首次启动分钟级 | 内核是**虚拟机里的** Linux，与宿主共享不了；`AndroidRuntime` 需要一个新驱动（adb / gRPC 控制通道），但**表面合成**要另想办法（VD 输出 → 纹理 → Tauri 窗口） |
| **远程 adb 设备 / 设备农场** | 需要网络与信任边界设计（谁能连、传什么） | 与 AmOS 的"先连上再说"相性不合：它意味着把 APK 执行权交给远端 |
| **不提供**（macOS 上如实为空） | 用户拿不到 Android 应用 | 今天就是这个状态，但**必须是"说清的为空"**，而不是"演示列表假装" |

三条都不在"顺手补一下"的量级：第一条要新驱动 + 像素通路，第二条要安全评审。本轮做的是
**把现状说清楚**（这是可以做完的部分），并把选择留给产品决策（登记为
`docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` §3 的 **G8**）。

### 顺带如实说明的两件事

* `legacy:<window_id>` 外部表面在**没有容器合成器**的宿主上只是一条状态机记录：
  `wm.rs::open_surface` 不创建 `WebviewWindow`，也没有人把容器像素贴进来。看到
  `legacy:waydroid_demo_*` 出现在"窗口与形态"调试卡里，**只**说明宿主把它登记进了
  z 序/焦点模型，不说明屏幕上有那个应用。
* `AMOS_ANDROID_RUNTIME=waydroid` 只能**强制指定**驱动；它不会让 `waydroid` 凭空出现——
  不存在时 `WaydroidRuntime` 的每一次调用都会如实失败（而不是悄悄换成夹具）。

