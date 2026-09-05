# AmOS Flashlight / Torch（手电筒 · 照明）

**日期**: 2026-09-05 · **范围**: `crates/amos-flashlight`（领域内核）+ `amos-tauri/src/flashlight.rs`（System UI 桥）
**状态**: 领域内核 + Mock + Android 真机骨架/设备 seam + System UI 内存桥 + 通知中心快捷开关 + 状态栏指示灯均已落地；`scripts/build-android.sh` 交叉编译 `amos-flashlight --features android`。

> 本文档回答「手电筒 / 照明功能代码需不需要加」：**不需要重复实现相机、闪光灯 HAL 或驱动**——
> 真机底座是无 UI Android（`docs/no-ui-android.md`），照明 torch 由底层 Android `CameraManager`
> （后置相机的闪光灯单元 `FLASH_INFO_AVAILABLE`）提供。AmOS 只补一层「开关 ↔ 真实 torch」的
> **策略 + Provider seam**，域内核离线可测，与 Mock / 真后端共享同一套规则。

## 1. 现状与定位

改动前，本仓库没有手电筒/照明的领域描述或开关。照明是一个**硬件开关域**（点亮/熄灭），形态与
`amos-radio`（Wi-Fi/蓝牙/飞行 开关域）一致：内核 + provider seam + Mock，策略放 manager。

## 2. 领域内核 `crates/amos-flashlight`（transport-agnostic、离线可测）

仿 `amos-radio`/`amos-telephony`：内核 + provider seam + Mock + `android`-gated 真机骨架。

| 模块 | 内容 |
|---|---|
| `state` | `FlashlightState { on, torch_present }` —— 点亮位 + 「设备确有可用 torch」硬件事实 |
| `provider` | `FlashlightProvider` trait —— **笨寄存器**：`snapshot()` / `set_on(on)`；`MockFlashlightProvider`（内存、可播种） |
| `manager` | `FlashlightManager` —— 持有 `Arc<dyn FlashlightProvider>`，**独占策略** |
| `android` | `AndroidFlashlightProvider` —— `android` feature-gated 骨架，走 `CameraManager#setTorchMode` |
| `error` | `FlashlightError::{ NoTorchHardware, Provider(String) }` |

**策略（写在 manager，不在 provider）**：
1. 设备**无可用 torch**（无带闪光灯的后置相机）时，**拒绝点亮** → `FlashlightError::NoTorchHardware`
   （与 radio「飞行模式开启期间禁开 Wi-Fi/蓝牙」同型的守卫）。
2. 熄灭始终允许（幂等 + 防御），即使无 torch 也不会报错 —— 开关位总能安全同步当前意图。
3. `FlashlightManager::set_on`/`toggle` 返回**权威快照**，调用方以此镜像真实状态，而非相信自己的意图。

`provider` 故意「笨」、策略放 `manager`——与 telephony「策略在领域核、不在 provider」一致，
Mock 与未来真后端共享同一套规则与测试（`manager.rs` 内嵌用例）。

## 3. Android 真机后端（`android`-gated 骨架）

无 UI Android 底座上，torch 由 `CameraManager`（`context.getSystemService("camera")`）提供，只能由
持有进程上下文的 **System UI APK**（Tauri core）经 JNI/binder 触达——headless `amos-ai` 拿不到
（同 radio/sensor 的 host 决策）。`AndroidFlashlightProvider` 因此放在 System UI 侧。

- `set_on`：真实调用 `CameraManager#setTorchMode(cameraId, enabled)`（API 23+）。当相机被其他 App
  占用、或设备过热/电量过低时抛 `CameraAccessException` → 如实映射为 `FlashlightError::Provider`，
  **不假装灯已亮**。
- `torch_present` / `on` 为 AmOS 位（构造播种）。`TODO(on-device)`：由 System UI glue 遍历
  `getCameraIdList` + `CameraCharacteristics#FLASH_INFO_AVAILABLE` 解析出带闪光灯的后置相机 id 作为
  `camera_id`。
- `cargo check --features android` 保证该模块在宿主上也能编译（仿 `amos-radio`）。

## 4. System UI 桥 + 前端入口（已接线）

仿 `amos-tauri/src/radio.rs`，手电筒也走 **in-process** 桥（torch 是 Android 系统能力，只能由
System UI APK 触达，故不经 headless daemon，也无新增 gRPC/proto）:

- `amos-tauri/src/flashlight.rs` —— `FlashlightBridge` 持有 `FlashlightManager`；启动时从持久化
  `amos.flashlight` 播种 Mock（重启续状态）；`flashlight_status`（读）与 `flashlight_set(on)`
  （写，成功后把权威快照镜像回 `amos.flashlight` 触发跨窗口 `store-updated`）。
- 前端 `lib/backend.ts`：`flashlightStatus()` / `flashlightSet()`；`lib/settings.ts`：
  `FLASHLIGHT_KEY` + `FlashlightStore` + 纯函数 `flipFlashlight`/`torchOn`/`normalizeFlashlight`
  （未 bridged 时本地降级，行为一致）。
- **通知中心快捷开关**（`components/NotificationCenter.tsx`）：手电筒全宽 tile（🔦/🔆），bridged
  走后端、否则走本地 flip；**读 `FLASHLIGHT_KEY` 为 store 响应式**（`useStoreValue`），打开面板时再向
  `flashlight_status` 校准权威态。
- **状态栏指示灯**（`components/StatusBar.tsx`）：`torchOn` 时显示 🔦，随 store 实时/跨窗口更新。
- **实时 OS→UI 推送**：真机 `TorchCallback` → `FlashlightGlue_onTorchChanged` → device seam
  `note_torch` → `SharedStore::set(FLASHLIGHT_KEY)`（持久化 + 广播 `store-updated`）→
  `useStoreValue(FLASHLIGHT_KEY)` 让状态栏 **和开着的通知中心 tile** 立即随 OS 外驱变化（他 App 抢占、
  过热熄灭、拍照）点亮/熄灭——无需打开面板或轮询。`lib.rs::setup`（android feature）安装 pusher。
- 持久化用专用 store key `amos.flashlight`（区别于 `amos.settings` 偏好开关，因为照明是瞬态硬件态）。

单测覆盖：Rust（`amos-flashlight` 12 项 + `flashlight.rs` seed/payload/boot 4 项）与 TS（`settings.test`
新增 flip/torch/normalize + NotificationCenter/StatusBar 手电筒 DOM 用例）。

## 5. 真机接线（Android provider + System UI boot）

镜像 `amos-radio` 的 device-seam 做法，`amos-tauri` 在 `android` feature 下用真机后端替换 Mock：

- `flashlight.rs::FlashlightBridge::from_android(vm, env, context, camera_id, torch_present)` 工厂已具备
  （`AndroidFlashlightProvider`，走 `CameraManager#setTorchMode`）。
- **boot 切换**：`flashlight::boot_bridge(seed)` 供 `run()` 调用——桌面/CI（无 `android`）恒返回
  持久化播种的 Mock；`android` 下若 Kotlin glue 已把真机 Context + 相机喂上来则返回真机桥，否则回退
  Mock（保证壳在任何 attach 顺序下都能确定性启动）。
- **设备 seam（upcall 风格，仿 `clipboard_glue`）**：`#[no_mangle]
  Java_com_amos_ai_glue_FlashlightGlue_attach` 把 Kotlin 传来的 Activity `Context` + 相机 id +
  `hasFlash` 构造成 `AndroidFlashlightProvider` 并安装进 `OnceLock`；`#[no_mangle]
  Java_com_amos_ai_glue_FlashlightGlue_onTorchChanged` 把 OS 驱动的 torch 变化
  （`CameraManager.TorchCallback`）经 `note_external_state` 回灌进真实后端，使 `snapshot()` 不撒谎。
- **`amos-flashlight` 真机行为**：`set_on` 走真实 `setTorchMode`（API 23+）；成功才置 `on`；
  同时接受 `TorchCallback` 推送（外部 App 点亮/过热熄灭/拍照抢占）；`NoSuchMethodError`（< API 23）
  与 `CameraAccessException` 如实上报，绝不假亮。
- **Kotlin 侧**：`android-glue/.../FlashlightGlue.kt` 解析带闪光灯的后置相机（优先 rear +
  `FLASH_INFO_AVAILABLE`，退回任意带闪光相机；无则空 id 且保持惰性），注册 `TorchCallback`；
  `AmosGlue.onStart` 调 `FlashlightGlue.bind`；权限授予后再经 `AmosGlue.onCameraPermissionGranted`
  重新 bind（首次 bind 可能在弹窗未答时是空操作）。
- `scripts/build-android.sh` 现额外交叉编译 `amos-flashlight --features android`。
- 本机验证：`cargo check/clippy -p amos-tauri --features android --lib` 与 `-p amos-flashlight
  --features android` 全绿；真机点亮仍需在带真 torch 的相机设备上验收（见下方 checklist）。

**诚实边界**：`run()` 与 Kotlin `onStart` 的先后属于设备时序，`boot_bridge` 在 upcall 尚未到达时回退
Mock（模拟桌面语义），这是把真机接线做成“骨架 + 编译门控 + 真机验收”的既有 repo 惯例（同 radio）。
真机熄灭时若相机被其他 App 占用/过热/低电，`setTorchMode` 抛错 → `FlashlightError::Provider` 如实上报，
绝不假亮。

## 真机验收 checklist（已连设备，SDK 34 / arm64）

1. adb 授权：`adb devices` 显示 `device`（已确认）。设备为 SDK 34 / Android 14，torch API 23+
   与 `TorchCallback` 均可用。
2. Tauri Android 工程已存在（`gen/android/`），且 `android-glue/`（含 `FlashlightGlue.kt`）已拷入
   `gen/android/app/src/main/java/com/amos/ai/glue/`；`AndroidManifest.xml` 已声明 `CAMERA` 与
   `android.hardware.camera.flash(required=false)`。
3. `MainActivity.kt` 已接 `AmosGlue`/`PermissionWire` 生命周期：`onStart` 请求 `CAMERA` 并在已持有时启动
   生产者（torch bind）；`onRequestPermissionsResult` 授予后在 `AmosGlue.onCameraPermissionGranted`
   重新 bind 真机 torch；`onStop` 释放相机/传感器。**注意**：`gen/android` 由 `cargo tauri android init`
   生成——若重新 init 会覆盖 `MainActivity.kt`，需按 `android-glue/.../MainActivity.Wiring.kt` 重挂。
4. 构建并部署：`cd crates/amos-tauri && cargo tauri android build --features android`（`--features
   android` 使 `FlashlightBridge` 经 `FlashlightGlue_attach` 用真机 provider 替换 Mock）。本会话已单独
   验证 `amos-flashlight` 对 `aarch64-linux-android --features android` 可编译（NDK 链接）。
5. 安装后打开通知中心手电筒 tile：点亮 → 状态栏出现 🔦；用另一 App（系统相机/另一手电筒）抢占再释放，
   确认 tile 如实回到熄灭（`TorchCallback` → `FlashlightGlue_onTorchChanged` 生效）；熄屏/过热 OS 熄灭
   时状态同样如实。
6. 诚实断言：相机被占时 `flashlight_set(true)` 返回错误而非假亮；无 torch 设备 tile 应不可点亮。

## 6. 后续（可选）/ 安全与诚实性

- 快捷开关/状态栏已接线；如需经 gRPC 暴露给 daemon 供 AI 助手控制照明，可另加服务（非 radio/torch 的
  原生路径）。
- 视觉/可达性：点亮态在通知中心与状态栏持久可见；真机需保证在相机 App 占用时如实报错而非假亮。

## 7. 安全与诚实性

- 非审定软件（research/prototype），不用于任何 DAL-A/飞行/医疗控制（见根 README）。
- 绝不伪造 `on=true`：`AndroidFlashlightProvider::set_on` 仅在 `setTorchMode` 成功后置位。
- 无 torch 设备上的点亮请求是硬错误，不是静默成功。
