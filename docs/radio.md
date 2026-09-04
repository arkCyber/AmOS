# AmOS Radio / Connectivity (Wi-Fi · Bluetooth · Airplane mode)

**日期**: 2026-09-04 · **范围**: `crates/amos-radio`（领域内核）+ `amos-tauri/src/radio.rs`（System UI 桥）

> 本文档回答「蓝牙 / Wi-Fi 功能代码需不需要加」：**不需要重复实现射频、驱动或协议栈**——
> 真机底座是无 UI Android（`docs/no-ui-android.md`），Wi-Fi（`WifiService`/HAL）与蓝牙
> （Bluetooth stack）已经由底层 Android 提供。AmOS 只补一层「UI 开关 ↔ 真实射频」的桥与
> 策略。本文即该桥的 P0/P1 形态。

## 1. 现状与定位（改动前）

改动前，通知中心的 `wifi / bluetooth / airplane / location` 只是 `amos.settings` 里持久化的
布尔开关：**没有任何系统能力调用**（`FUNCTIONAL_GAP_ANALYSIS.md` §二.21：模拟开关）。深色模式
虽「真生效」但也仅是前端 CSS 主题 + 亮度遮罩。

本改动把其中三个**真正的射频开关**（Wi-Fi / 蓝牙 / 飞行）从「纯持久化位」升级为走真实
provider 通道 + 策略的状态；`location / dnd / darkmode` 不属射频范围，保持不变。

## 2. 为什么桥放在 System UI（而非 headless daemon）

telephony 走 `WebView → Tauri command → gRPC(UDS) → amos-ai daemon → TelephonyProvider`，
因为电话信令归 daemon 管。而 Wi-Fi/蓝牙在无 UI Android 底座上由 **Android 系统服务**
（`ConnectivityManager`/`BluetoothManager`）提供，只能由**持有进程上下文/权限的 System UI
APK**（Tauri core）通过 JNI/binder 触达——headless `amos-ai` 拿不到。所以 radio 的 provider
直接挂在 `amos-tauri`，无需新增 gRPC 服务或触碰 daemon/proto。

```
[ NotificationCenter (TS) ]              radio_status / radio_set (Tauri command)
        │ invoke                              │
[ amos-tauri/src/radio.rs RadioBridge ] ─────┤  in-process
        │ RadioManager (策略: 飞行级联/守卫)    │
        │ RadioProvider (seam: Mock / 未来 Android)
        ▼
持久化镜像 → SharedStore("amos.settings")    ← 跨窗口 store-updated 同步
```

## 3. 领域内核 `crates/amos-radio`（transport-agnostic、离线可测）

仿 `amos-telephony`：内核 + provider seam + Mock。

| 模块 | 内容 |
|---|---|
| `state` | `RadioMode`（Wifi/Bluetooth/Airplane）与 `RadioSnapshot{ wifi, bluetooth, airplane }` |
| `provider` | `RadioProvider` trait —— **笨寄存器**：只 get/set 每一位；`MockRadioProvider`（内存、可播种） |
| `manager` | `RadioManager` —— 持有 `Arc<dyn RadioProvider>`，**独占策略** |

**策略（写在 manager，不在 provider）**：
1. 开启飞行模式 → 级联关闭 Wi-Fi 与蓝牙。
2. 飞行模式开启期间，无法单独打开 Wi-Fi/蓝牙（返回 `RadioError::AirplaneActive`）。
3. `RadioManager::set` 返回**权威快照**，调用方以此镜像真实状态，而非相信自己的意图。

`provider` 故意「笨」、策略放 `manager`——与 telephony「策略在领域核、不在 provider」一致，
Mock 与未来真后端共享同一套规则与测试。

## 4. System UI 桥 `amos-tauri/src/radio.rs`

- `RadioBridge` 持有 `RadioManager`；启动时从持久化 `amos.settings` **播种** Mock（重启续状态）。
- `radio_status`：读当前射频状态。
- `radio_set(key, enabled)`：把开关交给 `RadioManager.set`（含级联/守卫），成功后用
  `SharedStore::set` 把权威快照合并回 `amos.settings`（保留 darkmode/dnd/location），触发
  `store-updated` 跨窗口同步。

## 5. 前端

- `lib/backend.ts`：`radioStatus()` / `radioSet(key, enabled)`。
- `lib/settings.ts`：纯函数 `flipRadio(s, key)`（与 Rust 策略一致的飞行级联 + 守卫），供
  **未 bridged** 的环境降级，保证行为一致；`NotificationCenter` 在 bridged 时走后端、否则走
  `flipRadio`。
- 单测覆盖：Rust（`manager` 8 项 + `radio.rs` seed/payload 若干）与 TS（`flipRadio`）。

## 6. 下一步（真机 Android 后端，feature `android`）

`crates/amos-radio/src/android.rs`（2026-09-04 已加骨架）：用可选 `jni` 依赖 + `android`
feature 门控（桌面/CI 默认不带），暴露 `AndroidRadioProvider`（实现了 `RadioProvider`，可直插
`RadioManager`）。可在本机验证编译：

```bash
cargo check --features android -p amos-radio      # 桌面可编译通过
cargo clippy --features android -p amos-radio --all-targets
```

- Wi-Fi：`WifiManager#setWifiEnabled/isWifiEnabled`（pre-API-29 路径）。
- 蓝牙：`BluetoothManager#getAdapter` → `BluetoothAdapter#enable/disable/isEnabled`。
- 飞行：当前为 AmOS 侧位（manager 本就会级联关掉真实 Wi-Fi/蓝牙）。

**真机接通（后续，需 aarch64 交叉编译 + 真机）**：System UI APK 启动时把 Tauri 的
`JavaVM` + `Context`（global ref）喂给 `AndroidRadioProvider::new`，用它替换 Mock；
再把 Wi-Fi 升级到 `ConnectivityManager`、蓝牙加 `BLUETOOTH_CONNECT` 权限、飞行改用
`Settings.Global.AIRPLANE_MODE_ON`（`ContentResolver`）。接线路径同
`docs/no-ui-android.md` §4 的 `android_bridge`；UI 命令签名不变，仅换 provider。

**2026-09-04 接线就位（System UI 侧）**：
- `scripts/build-android.sh` 现额外交叉编译 `amos-radio --features android`（jni provider 为
  纯 Rust+ jni，无额外 NDK C 依赖）。
- `amos-tauri` 新增 feature `android = ["dep:jni","amos-radio/android"]`；`RadioBridge::from_android(vm, env, context, airplane)` 用真机 provider 构造桥（桌面默认仍 `mock_seeded`）。本机
  `cargo check -p amos-tauri --features android` 可验证接线可编译；真机运行仍需在
  `run()` 里用 Activity 的 `JavaVM`/`Context` 调 `RadioBridge::from_android` 替换
  `mock_seeded`（再 `cargo tauri android build --features android`）。
