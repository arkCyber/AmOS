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
  `AndroidManager` service with `LaunchAndroidApp` + `GetInstalledApps`.
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
  `launch_apk`, `list_installed_apps`, and **APK icon extraction**
  (`extract_icon_bytes`).
- **`AndroidManagerService`**: a tonic gRPC server wrapping the runtime
  (`spawn_blocking` so subprocess calls don't stall the executor). Served on the
  same UDS as `AiAgent` by `amos-ai`.
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
| W4 | 检查 `wm_windows` 调试卡(设置页) | 每个已启动 APK 显示为一条 `legacy:<window_id> [System] 外部表面` 记录,参与聚焦/z 序;不再是 Tauri Webview 窗口 |

### 当前边界(诚实)
- **表面合成**(Wayland 层叠 / DMA-BUF 纹理,见上文「input method & gesture sharing」
  的 option 2)需要真实 Waydroid 设备;`W2` 只验证"启动命令已下发、返回 window_id",
  不验证像素是否已合成进 Tauri 窗口。
- `LaunchAndroidApp` 返回的 `window_id` 现会注册为 `amos-wm` 的**外部 `System` 窗口**
  (`legacy:<window_id>`,见 `wm.rs::open_surface`),在状态机中参与聚焦/z 序并出现在
  `wm_windows` 里,但**刻意不创建 `WebviewWindow`**(它是容器侧合成表面)。「合成 +
  多窗口」的像素层整合仍属后续工作。
- 在无 Waydroid 的 CI/开发机上,`W1`–`W4` 均可通过 `DemoRuntime` 验证(返回合成
  window id),这正是 `crates/amos-android` 端到端测试覆盖的路径。
