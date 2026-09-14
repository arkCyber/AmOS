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
| `state` | `RadioMode`（Wifi/Bluetooth/Airplane/Hotspot）与 `RadioSnapshot{ wifi, bluetooth, airplane, hotspot }` |
| `provider` | `RadioProvider` trait —— **笨寄存器**：只 get/set 每一位；`MockRadioProvider`（内存、可播种） |
| `manager` | `RadioManager` —— 持有 `Arc<dyn RadioProvider>`，**独占策略** |

**策略（写在 manager，不在 provider）**：
1. 开启飞行模式 → 级联关闭 Wi-Fi、蓝牙与热点（AP）。
2. 飞行模式开启期间，无法单独打开 Wi-Fi/蓝牙/热点（返回 `RadioError::AirplaneActive`）。
3. `RadioManager::set` 返回**权威快照**，调用方以此镜像真实状态，而非相信自己的意图。

`provider` 故意「笨」、策略放 `manager`——与 telephony「策略在领域核、不在 provider」一致，
Mock 与未来真后端共享同一套规则与测试。

## 4. System UI 桥 `amos-tauri/src/radio.rs`

- `RadioBridge` 持有 `RadioManager`；启动时从持久化 `amos.settings` **播种** Mock（重启续状态）。
- `radio_status`：读当前射频状态。
- `radio_set(key, enabled)`：把开关交给 `RadioManager.set`（含级联/守卫），成功后用
  `SharedStore::set` 把权威快照合并回 `amos.settings`（保留 darkmode/dnd/location），触发
  `store-updated` 跨窗口同步。`key ∈ {wifi, bluetooth, airplane, hotspot}`。

## 5. 前端

- `lib/backend.ts`：`radioStatus()` / `radioSet(key, enabled)`。
- `lib/settings.ts`：纯函数 `flipRadio(s, key)`（与 Rust 策略一致的飞行级联 + 守卫），供
  **未 bridged** 的环境降级，保证行为一致；`NotificationCenter` 在 bridged 时走后端、否则走
  `flipRadio`。`RadioKey`/`QuickKey` 含 `hotspot`。
- `lib/hotspot.ts` + `settings/HotspotPage.svelte`：个人热点（AP）配置视图模型与页面（见 §7）。
- 单测覆盖：Rust（`manager` 15 项 + 回滚报告 1 项 + `radio.rs` seed/payload 若干）与 TS
  （`flipRadio`、`lib/hotspot`）。

## 6. 下一步（真机 Android 后端，feature `android`）

`crates/amos-radio/src/android.rs`（2026-09-04 已加骨架）：用可选 `jni` 依赖 + `android`
feature 门控（桌面/CI 默认不带），暴露 `AndroidRadioProvider`（实现了 `RadioProvider`，可直插
`RadioManager`）。可在本机验证编译：

```bash
cargo check --features android -p amos-radio      # 桌面可编译通过
cargo clippy --features android -p amos-radio --all-targets
```

- Wi-Fi：`WifiManager#setWifiEnabled/isWifiEnabled`（pre-API-29 路径）。**返回的布尔是平台答复**
  （「是否接受这次请求」）：`false` ⇒ `RadioError::Provider`，绝不当作成功（见 §8）。
- 蓝牙：`BluetoothManager#getAdapter` → `BluetoothAdapter#enable/disable/isEnabled`。`enable/disable`
  的布尔同理：`false`（用户/设备策略限制）⇒ provider error。**无 adapter** 的读取会记为 `false`
  （快照没有第三态），但**开关**会以明确错误拒绝（"no Bluetooth adapter on this device"）。
- 飞行：AmOS 侧位，且这是**平台限制而不是待办** —— 权威开关是 `Settings.Global.AIRPLANE_MODE_ON`，
  写入需 `WRITE_SECURE_SETTINGS`（signature|privileged），普通安装永远写不了；AmOS 保证的是另外
  一件完整的事：manager 级联关掉**真实** Wi-Fi/蓝牙/AP 并在关闭前挡住它们，`snapshot` 如实上报这个位。
- **_热点（Wi-Fi AP）_**：经 Kotlin `TetheringGlue` 调真栈（见 §7）；
  `TetheringManager#startTethering(TetheringRequest, Executor, StartTetheringCallback)` /
  `#stopTethering`。**公开 API 仅 API 36+**（android-34/35 的 `android.jar` 里没有该类，
  `ConnectivityManager` 的 tethering 成员是 `@SystemApi`），且需 `TETHER_PRIVILEGED`
  （signature|privileged）。

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

## 7. 个人热点（Wi-Fi AP / 网络共享，2026-09-13）

「Wi-Fi 热点」与 §1 的 Wi-Fi 是**两个不同的东西**：后者是 STA（连别人的网），前者是 AP
（把自己的网共享出去）。审计时全仓对 `hotspot|tether|softap|WifiAp|个人热点|网络共享`
**0 命中**，本轮按同一分层补齐。

- **领域核**：`RadioMode::Hotspot`（key `"hotspot"`）+ `RadioSnapshot.hotspot` +
  `RadioProvider::set_hotspot`；策略仍在 `RadioManager`（飞行级联关热点、飞行中禁开、
  `rollback_to` 恢复热点位）。
- **桥**：`radio_set("hotspot", …)` / `radio_status()` 的 payload 含 `hotspot`，并镜像进
  `amos.settings` —— 与 wifi/bt/airplane 完全同一条路径。
- **前端纯模型 `lib/hotspot.ts`**（store `amos.hotspot`，device-state）：配置 = 网络名 / 口令 /
  频段 / 安全性 / 最大连接数。**诚实规则**：不伪造运行中的 AP；`hotspotProblems`/`hotspotReady`
  在**空名称**或 **WPA 口令 < 8 位**时挡住开启（开关不宣称一个不可能存在的热点）；`open` 只给
  警告；**不编造已连接设备列表**（只有真机知道）。两个易被忽略的正确性点：口令建议取自**平台
  CSPRNG**（`crypto.getRandomValues`；无 `crypto` 的宿主回退 `Math.random` 并在注释里写明 ——
  它是 AP 的 Wi-Fi **PSK**，可预测即真实弱点），网络名按 **32 字节**（802.11 的 octet 上限，而非
  字符数）截断且**不切断码点**。
- **UI**：设置索引「个人热点」→ `HotspotPage.svelte`（主开关 = `qs.hotspot`，配置区在飞行模式
  外始终可见，便于先配置再开启）。
- **Android 真栈**：`AndroidRadioProvider::set_hotspot` 经 `find_class` + `call_static_method`
  调 `TetheringGlue.setWifiTethering(context, on)`（`crates/amos-tauri/android-glue/`）；glue 内走
  `TetheringManager#startTethering(TetheringRequest, Executor, StartTetheringCallback)` /
  `#stopTethering`——**回调式** API，raw JNI 造不出 request/callback 对象，故必须落在 Kotlin 侧。
  **API 事实（用本机 `android.jar` + `javap` 核实）**：`android.net.TetheringManager` /
  `TetheringInterface` **自 API 36 才进入公开 SDK**（android-34/35 的 `android.jar` 中不存在），
  `ConnectivityManager` 的 `startTethering`/`OnStartTetheringCallback` 是 `@SystemApi`（公开 SDK
  完全没有）⇒ **36 以下没有可写的公开 tethering 调用**，glue 如实返回 `false` 而不是假装有回退。
  返回 `false`（无公开 API、无 `TETHER_PRIVILEGED`、无上行）⇒ `RadioError::Provider`：**不翻转
  镜像、不谎报已开启**。`snapshot` 经 `isWifiTethering` 读**平台事件回调**（`TetheringEventCallback`
  → `onTetheredInterfacesChanged`）维护的**实时**状态，取不到时退回上一次被接受的状态。
  AP 的 SSID/口令/频段：**平台限制，不是我方待办** —— 用 `javap` 核实 android-36 的
  `android.jar`：公开的 `SoftApConfiguration.Builder` **只有 `setChannels`**，
  `setSsid`/`setPassphrase`/`setBand`/`setSecurityType` 均为 `@SystemApi` ⇒ 非特权安装**根本无法**
  构造一个带 SSID/口令的 `SoftApConfiguration`（也就无法填 `TetheringRequest.Builder#setSoftApConfiguration`）。
  故设置页配置是**用户意图**（持久化在 `amos.hotspot`），且从不声称 AP 已采用它；只有特权/系统签名
  构建才可能应用。详见 `docs/android-glue.md`。

**测试**：`cargo test -p amos-radio`（飞行级联关热点 / 飞行中禁开 / 热点位独立 / 热点步回滚
失败）、`cargo test -p amos-tauri --lib radio`、`src/__tests__/hotspot.test.ts`（20）、
`svelte-tests/hotspot-page.svelte.test.ts`（14）。

## 8. 平台拒绝即错误（REQ-A184，2026-09-13）

§7 的热点路径定下过一条规矩：平台的布尔是**答复**不是值 —— `setWifiTethering` 返回 `false`
（无公开 tethering API / 无 `TETHER_PRIVILEGED` / 无上行）就变成 `RadioError::Provider`，理由写在
代码里：「**不让 UI 声称一个平台已拒绝的 AP**」。本轮复核发现**同文件里相邻的两个方法没守这条规矩**：

| 站点 | 事实 | 后果 |
| --- | --- | --- |
| `AndroidRadioProvider::set_wifi` | `setWifiEnabled` 返回 `Z`，被 `.and_then(\|v\| v.z()).map_err(jerr)?;` **丢掉**，随后 `Ok(())` | API 29+ 该调用**只允许系统/设备所有者**调用并返回 `false` ⇒ **拒绝与成功不可区分**：飞行模式级联中「关 Wi-Fi 失败」不会触发 `rollback_to`，也不会有任何报错 |
| `bluetooth_set` | 文档写「Returns the boolean it reported」，函数体却丢弃它（`set_bluetooth` 因而永远声称成功） | 同形 + **文档本身在说谎**；`enable/disable` 被用户/设备策略挡住时同样静默 |

**修复**（三处，行为 + 契约 + 文档）：

1. `set_wifi`：取回该布尔，`false` ⇒ `RadioError::Provider("… setWifiEnabled returned false: a missing CHANGE_WIFI_STATE, or a non-system caller on API 29+")`。
2. `bluetooth_set` → `Result<bool>`（文档同步改成事实：`true` = adapter 接受，`false` = 策略拒绝）；`set_bluetooth` 把 `false` 变成带原因的错误。
3. `RadioProvider` trait 增写**总契约**：`Ok(())` 意味着平台接受并已应用该切换，拒绝（平台 `false` / 权限缺失 / 服务不存在）必须是错误 —— 因为**级联依赖这个语义回滚**，吞掉一个错误就等于让设备半途而废且无人报告。
4. 读取侧的诚实边界写明（而不是留给读者猜）：无 Bluetooth adapter 时读数为 `false`（快照只有两态），但**开关**会以明确错误拒绝；`set_airplane` 的 AmOS 侧位从「TODO(on-device)」改写成**平台限制**（`WRITE_SECURE_SETTINGS` 属 signature|privileged）+ AmOS 实际保证的行为。

**机械化（新增门 `scripts/jni-boolean-scan.mjs`，接入 `make lint`）**：对每个
`call_method`/`call_static_method`，若 JNI 签名返回 `Z`，则其布尔必须被**使用**（绑定 / 返回 /
判断 / 比较）；丢弃形态是「裸表达式语句，取到 `.z()` 后直接 `?;`」。当前扫描 **318** 个生产
`.rs`、**11** 个返回布尔的 JNI 调用、**0** 命中。门自身经历过一次真实教训：**第一版漏掉了它本就
要抓的缺陷** —— 语句切分按最近 `;`，而 `set_wifi` 上方的注释里正好有一个分号（"…into an error; this
is the same contract…"），于是语句从注释中间开始、分类器看到的是散文 ⇒ **由负控抓出**（把修复还原
后门仍然全绿），随后加了保偏移的注释剥离层并把这个用例写进 `--selftest`（19 断言）。

- **负控**：把 `set_wifi` 还原成历史形态 ⇒ `FAIL crates/amos-radio/src/android.rs:285 … (Z)Z → …（bind it, or turn a refusal into an error）`；把 `bluetooth_set` 还原成「丢弃 + `Ok(true)`」⇒ `FAIL …:204 … ()Z`；两处均 `cmp` 字节还原。
- **编译**：`cargo check -p amos-radio --features android`、`cargo clippy -p amos-radio --features android --all-targets` 干净；`make lint` 早已包含各 android crate 的 `cargo check --features android`。
- **测试**：`cargo test -p amos-radio`（`manager` 15 项 + `rollback_reporting`）—— 级联中**任一步返回错误**即回滚并把错误交给调用方，这条策略本就由 `FlakyProvider` 钉着；本轮的修复让 Android provider **真的可能**返回那个错误（此前构造上不可能，故该策略在真机上永远不会触发）。

**诚实边界**：门只覆盖 `Z`（布尔）返回 —— 对象/整数返回通常是**值**，调用方可以合法忽略；而布尔在这些 API 上是**裁决**。布尔被**绑定**到变量后在别处被丢弃的形态留给编译器（未使用绑定是警告，且 `make lint` 会 `cargo check --features android` 各 crate）。非 `call_*` 的 `.z()`（`JValue` 裸用法）不在门内；真机运行期仍未验收（本机无 Android VM）。


## 9. 真机验收：设备上「声明 vs 事实」（REQ-A185，2026-09-13）

在**真机**（S5，Android 14 / API 34，arm64，`adb` 直连）上跑完第一轮端到端验收，抓出四个
「编译通过、设备上不成立」的缺陷，逐个修复后**在设备上复验**：

| # | 缺陷（设备取证） | 修复 | 复验 |
| --- | --- | --- | --- |
| 1 | **清单里没有任何 Wi-Fi/蓝牙权限**，而 provider 每个调用都要它们（`dumpsys package` 的 requested 列表里 0 条） ⇒ 真机上必然 `SecurityException` | 追踪 fragment + 生成清单新增 `ACCESS_WIFI_STATE`/`CHANGE_WIFI_STATE`/`BLUETOOTH(_ADMIN)`(≤30)/`BLUETOOTH_CONNECT`(运行时)，并在启动时请求后者 | `dumpsys`：`ACCESS_WIFI_STATE: granted=true`、`CHANGE_WIFI_STATE: granted=true`、`BLUETOOTH_CONNECT: granted=true`（对话框"允许"） |
| 2 | **`AndroidRadioProvider` 从未被安装**：`RadioBridge::install_android` 没有调用者，设备上一直是 Mock（种子=store）⇒ UI 的开关只是本地翻转 | 新增 `RadioGlue.kt`（`attachNative` JNI 上送 VM+Context）+ Rust `Java_com_amos_ai_glue_RadioGlue_attachNative` + `SwitchableProvider`（启动先把 Mock 包起来，attach 后同一实例切到真栈）；接进 `AmosGlue.onStart` | 设备 `settings get global wifi_on=1 / bluetooth_on=0` 与 App 读到的 `wifi:true / bluetooth:false` **完全一致**（此前 UI 显示 Wi-Fi"关"而设备是开） |
| 3 | **JNI 待处理异常导致进程 SIGABRT**：`hotspot_is_on` 的 `find_class` 在 tokio 线程失败（bootstrap 加载器），异常挂起后下一次 `NewStringUTF` 触发 CheckJNI abort（真机 backtrace 落在 `amos_radio::android::system_service`） | ① 所有 JNI 调用经 `jni!` 宏：失败即 `exception_clear()`；② `TetheringGlue` 的 `jclass` 改为 **attach 时经 Context 的 ClassLoader 解析并缓存**（不再用线程相关的 `find_class`） | 同一个开关操作：**进程存活**（修复前必崩），日志出现如实错误 |
| 4 | **UI 从不读设备**：`radioStatus()` 只在失败回退里被调用 ⇒ 开机显示的是"上次意图" | `SettingsApp`/`NotificationCenter` 挂载时读一次真机状态（失败保持离线语义） | 开关显示 `checked=true` 与设备一致 |

**写侧如实拒绝（设备日志原文）**：

```
W Tauri/Console: [amos][backend] radio_set failed radio provider failure: the platform refused to
switch Wi-Fi off (setWifiEnabled returned false: a missing CHANGE_WIFI_STATE, or a non-system
caller on API 29+)
```

即：`CHANGE_WIFI_STATE` 已授予（否则是 `SecurityException` 而非 `false`），**API 29+ 的平台仍只允许
系统/设备所有者切换 Wi-Fi** ⇒ A184 的"平台拒绝即错误"在真机上按设计生效，UI 不谎报、进程不崩。

**工具链侧的两条事实（也在设备上暴露）**：`scripts/build-apk.sh`（自述"唯一规范的 APK 构建入口"）
**不重建前端 `dist`**（`tauri.conf.json` 的 `beforeBuildCommand` 为空）⇒ 它产出的 APK 里没有前端包；
`make android-app` 才是规范路径（mirror → `bun run build` → `cargo tauri android build --debug
--features android --target aarch64` → `adb install -r -g`）。debug APK 自带 debug 签名，是设备验收
唯一可安装的形态（release APK 未签名）。设备 UI 的驱动方式见
`docs/REAL_DEVICE_SYSTEM_UI_AUDIT.md` §5.5（`scripts/device-ui-eval.mjs`，CDP）。

## 10. 蓝牙补全：适配器名 · 已配对设备 · 两个平台限制（REQ-A199，2026-09-14）

§1–§9 把蓝牙当作**一个开关**做完了：真栈开关、清单权限、飞行级联、平台拒绝即错误、UI 读设备。
但设置页里关于蓝牙的**其余三行**此前只活在前端：`名称`/`可被发现` 写 `amos.bluetooth`（纯本地
偏好），`附近设备`是固定 4 条 `DEMO_DEVICES` 且每行恒显示「未配对」。问题不在"功能少"，而在
**形态**——它们与真射频开关同一页、同一个 `Switch`，读者会把「本机叫 X」「可被发现：开」当成
设备事实。本轮按同一分层补全，并把两个**平台限制**写成明说的边界。

### 10.1 先查平台事实（本机 `android.jar` + `javap`，可复现）

```bash
JAR=~/Library/Android/sdk/platforms/android-36/android.jar   # android-34 同样核对过
javap -cp $JAR android.bluetooth.BluetoothAdapter \
  | grep -E 'getName|setName|getBondedDevices|setScanMode|isEnabled|enable|disable'
javap -cp $JAR android.bluetooth.BluetoothDevice | grep -E 'getName|getAddress|getBondState|createBond|removeBond'
javap -cp $JAR 'android.Manifest$permission' | grep -i bluetooth
```

| API | 在公开 SDK？ | 结论 |
| --- | --- | --- |
| `BluetoothAdapter#getName` / `#setName` | ✅ | 本机名可读可写（需 `BLUETOOTH_CONNECT`） |
| `BluetoothAdapter#getBondedDevices` + `BluetoothDevice#getBondState` | ✅ | 已配对设备可读 |
| `BluetoothDevice#createBond` | ✅ | 发起配对可行（**本轮未做**：需要配对请求交互，属下一轮） |
| `BluetoothAdapter#setScanMode` | ❌ 不在公开 SDK | 普通安装**无法**自行设置「可被发现」 |
| `BluetoothDevice#removeBond` | ❌ 不在公开 SDK | 普通安装**无法取消配对** |
| `ACTION_REQUEST_DISCOVERABLE` + `BLUETOOTH_ADVERTISE`（API 31+） | ✅（常量/权限都在） | 只能经**系统对话框**（要 Activity），拿不到 Activity 就用不了 |
| `BLUETOOTH_SCAN` / `BLUETOOTH_ADVERTISE` 权限常量 | ✅ | 只有「搜索/被搜索」才需要；**本轮无对应调用，故不声明**（声明了就是清单说谎，`android-permission-scan` 会报 `stale`） |

**权限增量 = 0**：本轮新增的三类调用（`getName`/`setName`/`getBondedDevices`+`getBondState`）
只要 `BLUETOOTH_CONNECT` —— §9 已声明并运行时请求。蓝牙家族的 token 表已把新 API 登记进去，
所以将来漏声明会被门当场抓住。



### 10.2 领域核（`crates/amos-radio`）

- **`bluetooth.rs`（新模块）**：`BtPeer{ address, name }` + `display_name()`（平台没给名字时用
  **地址**当标签 —— 空标签等于一个用户认不出的设备）；纯规则 `normalize_local_name`：空名**拒绝**
  （`RadioError::Provider`），超长按**248 字节且不切断码点**截断（与平台 `setName` 的上限一致，
  这样"用户输入的""适配器回报的""store 记住的"三者一致）。**没有 Android 也能单测。**
- **`RadioProvider` 增三个带默认实现的方法**（`bluetooth_local_name` / `set_bluetooth_local_name`
  / `bluetooth_paired_devices`），默认返回 `RadioError::Unsupported`：Mock 没有适配器就必须说
  "不支持"，**而不是编一个名字或一份设备列表**；这正是 UI 用来区分「设备事实」与「本地偏好」的信号
  （`Provider` = 设备拒绝、用户可处理；`Unsupported` = 没人能问、保持偏好）。`SwitchableProvider`
  逐项委托 ⇒ glue attach 后**同一个 provider 实例**开始回答真值。
- **`RadioManager` 暴露三个包装，名字规则放在策略层**（与飞行级联同一位置）：空白名在**任何
  provider 被调用之前**就被拒绝（`RecordingNameProvider` 钉住这一点），截断后的名字才交给后端。

### 10.3 Android 真栈（`crates/amos-radio/src/android.rs`）

- `bluetooth_adapter()`：原先三处重复的 `BluetoothManager#getAdapter` 收敛为一处，返回
  `Ok(None)` 表示**无适配器** —— 读侧（`bluetooth_enabled`）照 §9 记为 `false` 并 debug 记录，
  写侧与详情侧（`set`/`getName`/`setName`/`getBondedDevices`）显式报
  `no Bluetooth adapter on this device`。
- **`getName`**：只读；平台 `null` 记为**空名**（有设备确实没有名字），非字符串则**报错**
  （`JNIEnv::get_string` 自己会校验类型，`read_java_string` 复用这一点）。
- **`setName`**：平台布尔**被使用**（`false` ⇒ `RadioError::Provider`，附"被用户/设备策略限制"），
  成功后**回读适配器名字**返回 —— 平台可能截断，回显请求就是把没验证过的东西当事实。
- **`getBondedDevices`**：`Set` → `Iterator` 显式遍历（raw JNI 没有 for-each）；**每个设备在自己的
  local frame 里读**（长列表耗不尽 512 槽局部引用表，读失败也会弹帧）；`getBondState != BOND_BONDED`
  的设备**略过**而不是改标签成 peer；平台给 `null` 集合则**报错**（"平台什么都没说" ≠ "没有已配对设备"）。

### 10.4 桥与 UI

- 三条命令：`bluetooth_adapter_name` / `bluetooth_rename_adapter`（返回**适配器随后报告的名字**）/
  `bluetooth_paired_devices`。**故意不写 `amos.bluetooth`**：那个 key 的形态
  （`name` + `discoverable` + `paired`）归屏幕所有，Rust 只给事实、屏幕自己镜像；`radio_set` 由
  Rust 写 store 是因为那些位本来就在 Rust 已拥有的 `amos.settings` 里。
- **`lib/bluetooth.ts`**：`BtPeer`（设备事实）与 `BtCfg`（离线偏好：`name` / `discoverable` /
  `paired: BtDevice[]`）分开；`peerToDevice` 让无名设备用地址当标签；`kindFromName` 明说是**名字
  启发式**（只决定字形，不是能力声明）；本地配对列表**封顶 16**（`slice(-MAX_PAIRED)` 保留最新）。
- **`RadioPage.svelte`**：进入蓝牙页时问一次设备（`null` = 没人能问）。
  - **有设备答案**：名字行显示**适配器名**；「已配对」来自**适配器**且**只读**，并写明
    "取消配对需要 Android 公开 SDK 未提供的 API"；**不再显示演示「附近设备」列表**（真适配器面前
    摆一份假邻居比不显示更糟）；`可被发现` 旁的说明从"演示"换成**真实限制**（系统只提供请求对话框）。
  - **没有设备答案**：名字/可发现性是本地偏好；演示列表可**配对/取消配对**（写 `amos.bluetooth`），
    沿用原来的说明文案。
  - **重命名**：有设备答案 ⇒ 请求发到设备、store 镜像**适配器报告的名字**；被拒 ⇒ 显示
    `设备拒绝了新名称，本机蓝牙名未改变。`、输入框回弹到权威值、**store 不写**；没有设备答案 ⇒
    只改本地偏好（原路径）。

### 10.5 验证与负控

| 项 | 结果 |
| --- | --- |
| `cargo test -p amos-radio` | **28 passed**（`bluetooth.rs` 5：Peer 显示名兜底 / 空名拒绝 / 248 字节码点边界 / `BOND_BONDED` 常量；`manager`：策略层拒绝空白名且**未触达 provider**、超长先截断再下发） |
| `cargo test --workspace` | **EXIT=0**（0 failed）—— 新错误变体/新命令没有牵动其它 crate |
| `cargo test -p amos-tauri -p amos-media --features amos-tauri/android,amos-media/android --lib` | **279 passed**（`make test` 的 android 面：新命令在 `--features android` 下编译并执行） |
| `cargo test -p amos-tauri --lib radio` | **4 passed**（含 `BluetoothPeerPayload` 双字段） |
| `cargo check` / `clippy -p amos-radio --features android` | 干净（`make lint` 的 android 面） |
| `cargo fmt --all --check` | 干净 |
| `node scripts/jni-boolean-scan.mjs` | **13** 个布尔返回全部被使用（新增 `setName`/`hasNext`）；自测 **19 → 23** 断言 |
| `node scripts/android-permission-scan.mjs` | OK（4 家族 / 6 权限；无 `stale`） |
| `bun run check`（前端） | EXIT=0：vitest **783 passed**、`tsc` 0、`svelte-check` 0、i18n 扫描 OK、store/write/unwired 扫描 OK |
| `make lint` | EXIT=0 |

**负控（每次破坏后 `cmp` 字节还原）**：

1. 从 `AndroidManifest.permissions.xml` 删掉 `BLUETOOTH_CONNECT` ⇒ `android-permission-scan`
   **FAIL** 并点名 `crates/amos-radio/src/android.rs` 的 bluetooth 路径（`undeclared`）。
2. 把 `setName` 的平台布尔改成丢弃形态 ⇒ `jni-boolean-scan` **FAIL**：`…:341 throws the platform's
   answer away: (Ljava/lang/String;)Z → jni!( env, env.call_method( &adapter, "setName" …`。
   **这条负控本身又抓出门的一个缺陷**：第一版跑出来是 **OK** —— 门的语句游走遇到 depth 0 的闭合括号
   就放弃（"尾表达式"），而 `jni!(env, call)` 包装宏的 `)` 正是那第一个闭合括号，于是**凡是被
   `jni!` 包住的丢弃都看不见**（REQ-A186 之后几乎每个调用点都是这种形态）。已修：语句起点若是宏调用
   就把宏自己的 `)` 吃掉继续走；自测补 4 条（宏包装丢弃**要**报、宏包装绑定**不**报、`Ok(…)` 里的
   布尔仍算尾表达式、包装语句被正确回报）。
3. 去掉 `peerToDevice` 的地址兜底 ⇒ DOM 用例 **FAIL**：`expected [ 'Buds', '' ] to deeply equal
   [ 'Buds', 'AA:BB:CC:DD:EE:01' ]`。第一条负控先暴露了**断言本身太弱**（地址在行尾也显示，
   `toContain` 抓不到兜底）⇒ 给行标签加 `data-testid="bt-peer-name"` 后再跑这条负控才真的红。

**诚实边界**：Android 侧代码只过**编译/静态门**（本机无设备）。**2026-09-14 补充：本节这一面已在
真机上验收**（S5 / Android 14 / API 34，`make android-app` 构建安装后经 CDP 驱动）—— 适配器名读出
`A17Pro`（= `dumpsys`/`settings get secure bluetooth_name`）、`bluetooth_paired_devices` 返回 `[]`
（= 0 个已配对）、改名 `AmOS-S5` 后**设备侧** `settings get secure bluetooth_name` 同步变化、还原后
回到 `A17Pro`、空名被拒时横幅出现且输入框回弹、`radio_status.bluetooth` 与 `settings get global
bluetooth_on` 一致、全程无 `AmosRust` 报错。剩下的部分：可发现性的理由在 §10.1 是**平台限制**（不是
待办）；**搜索/配对已由 §11 补上并在真机跑通**。`kindFromName` 只按名字猜字形，不解析
`BluetoothClass`；`RadioPage` 的设备问答在**页面挂载时**发生一次（不订阅适配器状态变化），所以设备
在别处改名后需要重进页面。


## 11. 蓝牙搜索与配对（REQ-A200，2026-09-14）——**真机验收**

§10 把蓝牙的**详情**补齐后，缺口分析里剩下的那条是「搜索新设备 / 发起配对（需 Kotlin
`BroadcastReceiver` + `BLUETOOTH_SCAN`/`ADVERTISE`）」。本轮做掉，并在**真机**（S5 / Android 14 /
API 34，`adb` 直连）上跑通 —— 与 §9 一样，本节所有结论都有设备取证或代码证据。

### 11.1 平台事实（本机 `android.jar` + `javap`，并在设备上复核）

| API | 结论 |
| --- | --- |
| `BluetoothAdapter#startDiscovery` / `#cancelDiscovery` / `#isDiscovering` | 公开 SDK；API 31+ 需**运行时** `BLUETOOTH_SCAN` |
| `BluetoothDevice#createBond` | 公开 SDK；需 `BLUETOOTH_CONNECT`；**只表示请求被接受**，配对由系统流程 + 对方确认完成 |
| `BluetoothDevice#ACTION_FOUND` | **受保护的系统广播**：只有系统能发；接收方要在清单里能拿到蓝牙权限 |
| `BluetoothAdapter#getDefaultAdapter` | 公开（本轮实际走 `context.getSystemService(BluetoothManager)`，与 Rust 侧同一条路） |
| `AndroidManifest.permission.BLUETOOTH_SCAN` | 已声明（`neverForLocation`）+ 启动时运行时请求；`BLUETOOTH_ADVERTISE` **仍不声明**（只有"被搜索"才需要，本轮无调用点） |

### 11.2 分层

- **Kotlin `BluetoothGlue.kt`（新）**：扫描是**回调式**的（结果走广播），raw JNI 无法托管
  `BroadcastReceiver`，所以 glue 拥有 receiver 并把累积状态答成 JSON：
  `startDiscovery` / `stopDiscovery` / `bond` 返回平台布尔，`scanState()` 返回
  `{discovering, capped, scan, devices:[{address,name,rssi,bonded}]}`。结果表**有上限**
  （`MAX_DEVICES = 64`）且**越界即 `capped: true`**（不静默截断 —— `DevCareGlue` 的同一条规矩）。
  注册 receiver 放在**首次扫描时**（不是开机），因为只有扫描期间才需要它。
- **领域核**：`bluetooth.rs` 增 `BtScan` / `BtScanDevice`（`display_name()` 地址兜底、`rssi: Option`）；
  `RadioProvider` 增四个**带默认实现**的方法（默认 `Unsupported`：不能扫就必须说"不支持"，而不是
  答"扫了，空的"）；`RadioManager` 暴露包装并把**地址校验放策略层**（空地址在触达 provider 前即拒）。
- **Android 真栈**：`BLUETOOTH_CLASS` 在 attach 时经 app 类加载器解析（与热点同路），四个静态调用 +
  **纯函数 `parse_scan_json`**（缺 `discovering`/`capped`/`scan` 任一字段即**报错**，绝不默认成空列表）。
- **桥 / UI**：`bluetooth_start_scan` / `bluetooth_stop_scan` / `bluetooth_scan_state` /
  `bluetooth_pair`；`lib/bluetooth.ts` 增 `scanRow` / `sortScanRows` / `mergeScanRows`（合并去抖 +
  按信号排序 + 上限）；`RadioPage` 在**有设备答案**时显示「附近设备」搜索区（搜索/停止、结果行、
  配对被拒/请求已发送的提示），并**离开页面即取消扫描**（`$effect` cleanup）。



### 11.3 真机验收（S5 / Android 14 / API 34）

| 验收项 | 设备取证 |
| --- | --- |
| 权限 | `dumpsys package com.amos.ai`：`BLUETOOTH_SCAN: granted=true`、`BLUETOOTH_CONNECT: granted=true` |
| 搜索能起来 | 点「搜索」后 `dumpsys bluetooth_manager`：`Discovering: true`、`DiscoveryEndMs` 有值；App 自读 `bluetooth_scan_state.discovering = true` |
| **搜到设备** | glue 日志逐条 `found <MAC> name="…" rssi=… bonded=false`（一次扫描 10 条，含 `name="midea"`）；UI 渲染出 **8 行**（`[data-testid="bt-scan-name"]` 计数），并显示「停止」按钮与「搜索中…」 |
| 停止 | 点「停止」→ `discovering: false` + `dumpsys Discovering: false` |
| 离开页面即取消 | 扫描中按「‹」返回 → 页面卸载（`bt-name` 消失）→ `dumpsys Discovering: false`（**电池规则真的生效**） |
| 配对请求=接受 | `bluetooth_pair("11:22:33:44:55:66")`（无此设备）→ `true`，而 `bluetooth_paired_devices` 仍是 `[]`：**"已发起" ≠ "已配对"** |
| 非法地址 | `bluetooth_pair("not-a-mac")` → 报错；glue 日志 `createBond failed for not-a-mac: IllegalArgumentException: not-a-mac is not a valid Bluetooth address` |
| 空地址 | `bluetooth_pair("   ")` → 策略层直接拒绝（`refusing to pair a Bluetooth device without an address`），**未触达设备** |
| 无副作用 | 全程 `dumpsys` 的 `Bonded devices:` 始终为空；测试后把适配器名与开关恢复原状（`A17Pro` / `bluetooth_on=0`） |

**真机抓出两个缺陷（都不是"跑不起来"，而是"跑起来但说谎/丢结果"）**：

1. **`RECEIVER_NOT_EXPORTED` 收不到 `ACTION_FOUND`**。第一版按"只收系统广播"的理由用了
   `RECEIVER_NOT_EXPORTED`；设备上扫描**真的完成了** —— 框架日志有
   `btif_dm_search_devices_evt`（两个 MAC）与 `BTA_DM_DISCOVERY_RESULT_EVT` ×7、`dumpsys` 也显示
   发现过程 —— 而 glue **一条 `ACTION_FOUND` 都没收到**，UI 照样显示「未搜索到设备」。这正是本仓
   最怕的形态：**界面在说谎**。改为 `RECEIVER_EXPORTED`（过滤器只有蓝牙 action，且 `ACTION_FOUND`
   是受保护广播、只有系统能发）后逐条收到。这条写进了 glue 的注释：**"系统广播一定能送到
   NOT_EXPORTED 接收者"是假设，不是事实。**
2. **`isDiscovering` 的启动竞态把轮询关掉了**。`startDiscovery()` 返回 `true` 之后的一瞬间，
   平台仍可能答 `isDiscovering == false`（启动是异步的）。UI 当时"相信"了这一次读取：轮询停止，
   于是设备**已经收到 10 个结果**而屏幕始终是「未搜索到设备」。修法在 UI：启动被接受即进入
   "搜索中"，**紧跟其后的那次读取不采信 `discovering`**（下一次轮询再采信），并把这个竞态写成
   回归用例（fake bridge 第一次读返回 `discovering:false`，后续返回结果 —— 列表必须仍然出现）。

### 11.4 诚实边界

- **没有完成过一次真实配对**：`createBond` 之后要在**对端设备**上确认，本机做不到；而
  `BluetoothDevice#removeBond`（取消配对）**不在公开 SDK**（§10.1 的 javap 取证），所以本轮**刻意
  没有**对真实设备发起配对 —— 那会在用户手机上留下一个**本 App 无法取消**的已配对项。因此"配对"
  这一侧验收的是：**请求被接受 / 被拒 / 非法与空地址的行为**，以及"已配对列表仍由
  `getBondedDevices` 决定"。要在真机上看到一次完整配对，需要一台愿意配合确认的设备（并接受只能从
  系统设置里取消）。
- **只做经典蓝牙（BR/EDR）搜索**：结果来自 `ACTION_FOUND`；BLE 设备经由 LE 广播
  （`BluetoothLeScanner`）是另一条路，本轮**未做**，UI 的说明文案如实写了这一点。
- 结果行里的 `name` 常常为空（设备不广播名字，或需要 `BLUETOOTH_CONNECT` 才读得到）：UI 按
  **地址**显示，不编造名字；`rssi` 用来排序，未展示。
- `capped` 只覆盖 **glue 侧**的上限（64）；UI 侧合并列表也另有 64 上限（按信号丢弃最弱的），
  两个上限各自独立、都写在代码注释里。
- 扫描不订阅 `BluetoothAdapter#ACTION_STATE_CHANGED`：适配器在扫描中途被关掉时，UI 会在下一次
  轮询（≤1.5 s）看到 `discovering: false` 并停止，而不是立即反应。
- 未做「连接 / 播放 / 取消配对」等配对之后的动作（属各 profile，且多数同样受平台限制）。

### 11.5 验证

| 项 | 结果 |
| --- | --- |
| `cargo test -p amos-radio --features android --lib` | **34 passed**（含 `bluetooth.rs` 的扫描类型、`android.rs` 的 **4 个 glue-JSON 契约**用例：正常载荷 / 空列表仍报 `scan` 许可 / 缺字段或坏 JSON **报错而非默认** / 无地址条目丢弃且 `capped` 可见） |
| `cargo test -p amos-tauri --lib radio` | **5 passed**（含 scan payload 的 `capped`/`scan_allowed` 不丢） |
| `cargo test --workspace` | EXIT=0 |
| Kotlin glue | `bash scripts/android-glue-nv21-check.sh`：`BUILD SUCCESSFUL` + `[glue] OK`（0 非弃用告警；编译门当场抓出一处 `UNUSED_PARAMETER`，改成经 `BluetoothManager` 取适配器） |
| 前端 | `bun run check` EXIT=0（vitest **790**；`__tests__/bluetooth.test.ts` **17**、`svelte-tests` 蓝牙 **14**）+ `bun run i18n:scan` OK |
| 门禁 | `android-permission-scan` 增 `bluetooth-scan` 家族（`startDiscovery`/`createBond`/`BluetoothGlue` → `BLUETOOTH_SCAN` 运行时 + `BLUETOOTH_CONNECT` + ≤30 的 `BLUETOOTH(_ADMIN)`）；`feature-test-scan` 因新增特性门测试模块而要求 `make test` 覆盖 —— 已加 `cargo test -p amos-radio --features amos-radio/android --lib`；`make lint` 见 CHANGELOG |
| 真机 | 见 §11.3（`make android-app` 构建安装后逐项取证） |

> §11.4 的两条边界已在 **§12（REQ-A201）** 做掉：LE 搜索已实现，"配对进度不可见"
> 已改为读设备的 raw bond state。下面 §11 保留当时的原文，作为那一轮的记录。

## 12. 蓝牙 LE（BLE）搜索 + 配对进度可见（REQ-A201，2026-09-14）——**真机验收**

§11.4 剩下的两条不是"平台限制"，而是**我方未做**：①只做经典蓝牙搜索（BLE 走
`BluetoothLeScanner`，未做）；②配对进度不可见（`bonded` 是 bool，而 glue 只更新**已在结果表里**的
设备）。本轮把两条做掉，并在同一台真机（S5 / Android 14 / API 34）上取证。

### 12.1 平台事实（本机 `android.jar` + `javap`，并在设备上复核）

| API | 结论 |
| --- | --- |
| `BluetoothLeScanner#startScan(ScanCallback)` / `#stopScan` | 公开 SDK（API 21+）；**权限与经典搜索同一枚 `BLUETOOTH_SCAN`** ⇒ 权限增量 = 0；清单里的 `neverForLocation` 同样覆盖它，**不需要位置权限**（真机复核：`BLUETOOTH_SCAN: granted=true` 即已扫到 20 个设备） |
| `ScanResult#getRssi()` / `getScanRecord().getDeviceName()` | 广告里的名字**不走 `BLUETOOTH_CONNECT`**（只有 `BluetoothDevice#getName` 走）——真机 20 条结果里 3 条带名字，含 `Bose Flex 2 SoundLink`，而 §11 的经典搜索 10 条里只有 1 条带名字 |
| `BluetoothDevice#BOND_NONE` / `BOND_BONDING` / `BOND_BONDED` | **10 / 11 / 12**。旧注释写作"11 = none, 12 = bonded, 13 = bonding"，两处偏移 1 —— 本轮把 raw 状态送过 JNI 时它会直接变成错误 UI，已修并两边钉住值 |
| `ACTION_BOND_STATE_CHANGED` | 每次迁移都发，**含对端拒绝/超时后的回落**：真机实测 `10 → 11`（08:54:39.333）再 `11 → 10`（08:54:52.148） |

### 12.2 分层

- **Kotlin `BluetoothGlue.kt`**：`startDiscovery` 现在同时起**经典发现 + LE 扫描**
  （`ScanSettings.SCAN_MODE_LOW_LATENCY`），`stopDiscovery` 停两者；结果表**按地址合并**，
  每行带 `le`（是否在 LE 广告里答过，`or` 合并——同一设备可以两条路都答）与 `bond`（raw 状态）；
  JSON 增 `classic` / `le` / `bonds[]{address,state}`，`discovering` 的含义收紧为"**任一**搜索在跑"
  （经典约 12 s 就结束，LE 不会，轮询因此不会提前停）。
  **会话级 bond 记录**（`bonds`，封顶 64、最旧先丢）是这轮的关键：`ACTION_BOND_STATE_CHANGED`
  说的是**用户正在配的那台设备**，而它可能不在结果表里（扫描被重启清表、设备停止广播，或地址来自调用方）
  ——旧版只更新结果表里已有的行，于是"框架真的跑了配对流程"这件事在屏幕可读的任何地方都不留痕。
  **LE 扫描窗口 30 s**：经典发现由平台自动结束，LE 不会，不设窗口就等于射频常开。
- **领域核 `bluetooth.rs`**：`BtScanDevice.bond: i32`（raw 三态）+ `le: bool`，`BtBond`，
  `BtScan{classic,le,bonds}` + `bond_state()/is_pairing()/is_bonded()`（**会话记录优先于行内读数**：
  迁移比建行时的那次读取更新）；`BOND_NONE/BOND_BONDING/BOND_BONDED` 常量。
- **契约 `parse_scan_json`**：把"决定屏幕能说什么"的字段全部设为**必需**——顶层
  `discovering/classic/le/capped/scan`、每设备 `bond` + `le`、每条 bond 记录 `state`；
  缺任何一个都**报错**，绝不当作默认值（把缺失 `bond` 读成"未配对"正是让中途配对中的设备又被
  提供"配对"按钮的路径）。
- **桥 / UI**：payload 增 `classic/le/bonds` 与设备 `bond`；`lib/bluetooth.ts` 增
  `BOND_*`、`rowIsBonded/rowIsBonding`、`pairingProgress(bonds, address, rows)`（`bonding` / `bonded`
  / `none`，会话记录优先）；`RadioPage` 增：搜索范围说明（经典 + LE / 仅经典 / 仅 LE）、行的
  `LE` 标签、`配对中…` 标签、**配对中或已配对时不再显示「配对」按钮**、配对提示由设备状态**派生**
  （不再是一句"请求已发送"），以及**配对完成后自动重读已配对列表**（不必离开页面）。
- **门禁**：`android-permission-scan` 的 `bluetooth-scan` 家族补上
  `BluetoothLeScanner`/`ScanCallback`（新 API 不列进家族就对该门不可见），权限增量 0。

### 12.3 真机验收（S5 / Android 14 / API 34，`make android-app` 构建安装后经 CDP 驱动真 UI）

| 验收项 | 设备取证 |
| --- | --- |
| 搜索起两个传输 | 真 UI 点「搜索」后 `bluetooth_scan_state`：`discovering=true, classic=true, le=true, scan_allowed=true`；屏幕出现「搜索范围：经典蓝牙 + 蓝牙 LE（BLE）。」 |
| **LE 真的搜到东西** | 扫描中读状态：11 个设备、其中 **10 个 `le=true`**、3 个带名字；`logcat` 逐条 `BluetoothGlue: found(le) <MAC> name="…" rssi=…`（含 `Bose Flex 2 SoundLink`）；glue 日志 `LE scan started` 08:53:11.303 |
| UI 渲染 | 真 UI：**8 行**结果 + **7 个 `data-testid="bt-le-tag"`**（经典-only 的行不带标签）、「停止」按钮在场 |
| LE 窗口 | `LE scan window (30000 ms) elapsed — stopping` 08:53:41.304（= 起后整 30 s）；随后状态 `discovering=false, classic=false, le=false`，UI 回到「搜索」、搜索范围说明消失、**20 行结果保留**（比 §11 的经典-only 一轮多一倍） |
| 会话 bond 记录不污染 | 扫描结束读状态：`devices=20` 而 **`bonds=0`**（第一版把每个被发现的设备都写一条记录，实测 14 条 = 设备数，已改成只刷新已存在的记录） |
| 配对请求 → 进度 | `bluetooth_pair("11:22:33:44:55:66")` ⇒ `true`；`logcat`：`bond 11:…:66 10 -> 11` 后 `11 -> 10`；读状态得到该地址的会话记录 `state=10`，而该地址 **不在结果表的 20 行里**（`inDeviceRows=false`）—— 这正是旧版会静默丢弃的形态 |
| 无副作用 | 全程 `dumpsys bluetooth_manager` 的 `Bonded devices:` 为空，`bluetooth_paired_devices` 始终 `[]`；测试后把蓝牙关回原状（`bluetooth_on=0`） |
| 非法/空地址 | `"   "` ⇒ 策略层拒绝（`refusing to pair a Bluetooth device without an address`），**未触达设备**；`"not-a-mac"` ⇒ glue `createBond` 失败并如实报错 |

### 12.4 本轮抓到的两个缺陷（都不是"跑不起来"，而是"跑起来但说错/费电"）

1. **会话 bond 记录被写成了结果表的副本**（自查发现，真机确认）：第一版 `remember()` 给每个被发现
   的设备都写一条 bond 记录，于是 `bonds` 里 14 条 = 14 个设备，把"配对历史"变成了第二份结果列表。
   真机读数（`devices=20 / bonds=0`）确认修复：只有**发生过迁移**（或已有记录被新读数刷新）的地址
   才留在 `bonds` 里。
2. **LE 扫描不会自己停**：经典发现约 12 s 后由平台结束，LE 扫描不会 —— 没有窗口就意味着射频常开、
   屏幕每 1.5 s 永远轮询下去。加 30 s 窗口（`Handler` + `postDelayed`）后真机实测到点自停，
   状态如实变回 `le=false`、UI 回到「搜索」。

### 12.5 诚实边界

- **仍未完成过一次真实配对**：`createBond` 之后要在**对端设备**确认，而 `removeBond` 不在公开 SDK
  （§10.1），所以依然**刻意没有**对真实设备点过「配对」。真机验的是：请求被接受/被拒/非法与空地址，
  以及"**配对进度来自设备**"这条**数据通路**（`bonds` 里 `11 → 10`、地址不在结果表里、
  已配对列表仍为 `[]`）。UI 的**渲染**（配对中/完成/未完成、按钮收起）由 DOM 用例覆盖
  （fake bridge 按 `10 → 11 → 12` 推进），未在真机屏幕上看到过真实配对流程的进度。
- **LE 只取**地址 / 名字 / RSSI / bond；不解析 `ScanRecord` 的 service UUID 与 manufacturer data
  （所以不做"这是耳机/这是信标"的能力判断，`kindFromName` 仍只是字形猜测）。
- LE 窗口 **30 s 写死**，到点即停且不自动重启；要再搜一次得再按「搜索」。
- 配对请求被接受后，屏幕会以 1.5 s 轮询**直到该地址的 bond 状态变成已配对**（或页面关闭）——
  真机上一次「无此设备」的请求在 **13 s** 内走完 `10 → 11 → 10`（08:54:39 → 08:54:52），所以这不是
  常开的轮询；但若平台始终不给任何迁移，轮询会一直跟着这个页面（页面在前台，且用户刚点过配对）。
- 传输说明随搜索结束而消失（`discovering` 变 false 时 `classic`/`le` 同时为 false，文案不再断言
  "搜过什么"），已搜到的结果保留 —— 宁可少说，不说过期的话。
- **本轮新发现的平台限制（不属于这两条改动，见 CHANGELOG）**：在 Android 14 真机上
  `radio_set("bluetooth", true)` 与 `radio_set("airplane", true)` 都被平台拒绝 ——
  `BluetoothAdapter#enable` 自 API 33 起对普通应用**恒返回 false**，`WifiManager#setWifiEnabled`
  自 API 29 起对非系统调用者恒返回 false（飞行级联的第一步就是关 Wi-Fi）。provider 如实报错
  （REQ-A184），但**用户看到的开关动不了**。可行的下一步是把拒绝转成"跳系统面板/请求对话框"
  （`ACTION_REQUEST_ENABLE`、`Settings.Panel`），需要 Activity 与新的 glue 方法 ——
  已在 **§13（REQ-A202）** 做掉：能力回答前置 + 打开系统面板。

## 13. 平台托管的射频开关：先拒绝，再给可执行路径（REQ-A202，2026-09-14）——**真机验收**

### 13.1 起点

§12.5 记的那条发现不是"另一个待办"，而是一个**界面在说谎**的形态：S5 / Android 14 上
`radio_set("bluetooth", true)` 与 `radio_set("airplane", true)` 都被平台拒绝，而屏幕**什么都不说** ——
前端 `invoke` 把命令失败收进诊断账本并返回 `null`，于是点一下开关就是"什么都不发生"。
平台事实（SDK 文档 + 真机复核）：

| API | 事实 |
| --- | --- |
| `BluetoothAdapter#enable/disable` | 对 **targetSdk ≥ 33** 的应用**恒返回 false**（方法已弃用并明确如此） |
| `WifiManager#setWifiEnabled` | API 29 起对非 system/device-owner 调用者恒返回 false |
| `Settings.Global.AIRPLANE_MODE_ON` | 任何版本都需要 `WRITE_SECURE_SETTINGS`（signature\|privileged） |

### 13.2 分层

- **领域核**：`RadioControl` = `AppControlled` / `PlatformManaged { surface, reason }`，
  `SystemSurface`（`wifi_panel` / `bluetooth_settings` / `airplane_settings` / `wireless_settings`）+
  `PlatformReason`（`switch_removed` / `privileged_only`）—— 全是**稳定机器 token**，Rust 不发用户文案；
  `RadioProvider::control()`（默认 `AppControlled`）与 `open_system_surface()`（默认 `Unsupported`）；
  新错误变体 `RadioError::PlatformManaged`，与 `Provider` 明确区分：后者是"设备拒绝了这次尝试"，
  前者是"没有任何应用能尝试"。
- **策略层**：`RadioManager::set` **先问平台再动手**（`refuse_if_platform_managed`）。
  飞行级联在开始前逐个检查成员（wifi/bluetooth/hotspot），任一被托管即**整体拒绝** ——
  否则第一步应用、第二步被拒，就留下 `rollback_to` 也修不回来的半应用状态（平台两个方向都禁止）。
- **Android 真栈**：`control()` 经新 glue `RadioGlue.managedSurface(key)`（**API 级别知识放在 Kotlin**，
  与其它 glue 的操作系统判定同处），Rust 只做纯解析 `parse_managed_surface`：`"app_controlled"` 或
  `"<reason>:<surface>"`，**任何读不懂的答案都回退到"照旧尝试写入"**（坏契约不允许把能用的开关判成"被禁"）。
  `open_system_surface()` 经 `RadioGlue.openSystemSurface(context, surface)`：`Intent` +
  `FLAG_ACTIVITY_NEW_TASK`（这些设置页/面板不需要返回结果），Wi-Fi panel 打不开时退回 Wi-Fi 设置页。
- **桥 / UI**：`radio_control(key)` → `RadioControlPayload{radio, app_controlled, surface, reason}`；
  `radio_open_settings(key)`（只有被托管的开关有 surface，否则报错而不是假装打开）。
  前端新纯模块 `lib/radioControl.ts`（**"没有答案" ≠ "被托管"**：`null` 一律当作可用，绝不因为一次
  失败调用就把开关变灰）+ 通知中心 tile（⚙ 标记、逐条说明行、点按打开系统设置、**打开失败可见**）+
  设置页主开关（禁用 + 说明 + 「打开系统设置」按钮）。权限增量 = 0（只有 `Intent`/`Settings`）。

### 13.3 真机验收（S5 / Android 14 / API 34）

| 验收项 | 设备取证 |
| --- | --- |
| 能力回答 | `radio_control("wifi")` ⇒ `{app_controlled:false, surface:"wifi_panel", reason:"switch_removed"}`；`bluetooth` ⇒ `bluetooth_settings`/`switch_removed`；`airplane` ⇒ `airplane_settings`/`privileged_only`；`hotspot` ⇒ `app_controlled:true` |
| 拒绝发生在**触达平台之前** | `radio_set("bluetooth", true)` 的报错从 §12 的"the platform refused to switch Bluetooth on"变成**策略层**的"the platform manages Bluetooth — an app cannot switch it (switch_removed); open `bluetooth_settings` instead"（`BluetoothAdapter#enable` 未被调用） |
| 飞行模式不再半应用 | `radio_set("airplane", true)` 报错点名 `airplane_settings`（飞行位**本身**就被托管，所以它在第一步就挡住了级联）；`radio_status` 前后逐位相同（`stateUnchanged: true`）。"成员被托管 → 级联整体拒绝"的另一半（飞行位可用、成员不可用）由 host 单测覆盖（`the_airplane_cascade_refuses_when_a_member_is_platform_managed`） |
| 系统面板真的打开 | 点通知中心 Wi-Fi tile 与设置页按钮 ⇒ `logcat` `RadioGlue: opened system surface wifi_panel`，`dumpsys window` 的 `mCurrentFocus=Window{… InternetDialog}`（Wi-Fi 面板在前台，AmOS 仍是底层 resumed activity） |
| UI 说清楚 | 真机通知中心：3 个 tile 带 `data-managed="system"`、aria 名为「无线 · 打开系统设置」等，下方三条逐 radio 说明；设置 → 无线局域网页：`role="switch"` 为 `disabled` 且仍显示设备真实状态（`aria-checked="true"`），旁边是说明 + 「打开系统设置」 |
| 不假装 | 未托管的 `hotspot` ⇒ `radio_control` 返回 `app_controlled`；`radio_open_settings("hotspot")` 如实报错（"`hotspot` is switched by this app on this device — there is no system surface to open"），热点页行为不变 |

### 13.4 诚实边界

- **答案按 API 级别 + targetSdk 判定**，不检测 device-owner/系统应用身份：若 AmOS 将来以 device owner
  安装，这一层会**过早**拒绝（真机上 AmOS 是普通应用，所以当前答案是真的）。
- `radio_open_settings` 打开的是**屏幕**，不改变任何开关，也不返回结果：开关状态在下一次读取
  （重开面板 / 进设置页）才更新 —— 面板自己会显示实时状态。
- ~~`radio_set` 的偶发拒绝在 UI 里只能从诊断账本查到~~ → **已解决（§14，REQ-A203，2026-09-14）**：
  拒绝变成 `Ok` 里的结构化数据（`applied:false` + 机器 token + 重读的权威状态），屏幕直接说
  「设备这次拒绝了」。
- `ACTION_REQUEST_ENABLE`（系统询问"允许打开蓝牙？"的对话框）**未采用**：它要 Activity 拿
  `onActivityResult`，而本轮选的是设置页/面板（应用上下文可直接打开）。

## 14. 拒绝即数据：`radio_set` 的结构化结果（REQ-A203，2026-09-14）——**真机验收**

§13 让**可预判**的失败在触达平台之前就被拒绝（并给出系统面板这条路），但**不可预判**的失败 ——
设备这次就是没答应（`WifiManager.setWifiEnabled` 返回 false、飞行级联成员写入中途被拒）—— 依旧
以 `Err` 上抛 ⇒ 前端 `invoke` 把失败收进诊断账本、返回 `null` ⇒ **点了开关，屏幕什么都不说**。
本轮把「拒绝」从一次失败的调用变成一条**数据**：

- **桥**：`radio_set` 改为 `Result<RadioSetPayload, String>`：
  - 成功 = `applied:true` + 写后的权威状态；
  - **拒绝 = `Ok(applied:false + RadioRefusalPayload)`** —— `kind/radio/surface/reason/detail`
    里前四个是**稳定机器 token**（与 §13 的 `surface`/`reason` 同一约定：Rust 不写用户文案，
    token 由 `RadioError::kind()/radio()` 派生），`detail`（领域错误的 Display）只进账本、
    不当屏幕主文案；`kind` 有四种：`platform_managed`（没有任何应用能碰）、`airplane_active`
    （飞行守卫挡下）、`provider_refused`（设备拒绝了**这一次**尝试）、`unsupported`（没人能服务）；
  - **拒绝应答的状态永远来自重读**：拒绝发生后再 `snapshot()` 一次，把设备**现在的样子**回给屏幕
    —— 不是请求的回声（被拒绝的写不得看起来像已应用；被回滚的级联不得由失败的请求描述）；
    只有连重读也失败才 `state:null`（此时对状态**什么都不声称**）；
  - `Err` 只剩一种：未知的开关名（调用者编程错误，不是设备的话）。
- **前端纯层**：`backend.ts` 定义 `RadioRefusal`/`RadioSetReply`，`radioSet()` 返回结构化应答；
  **账本口径不变** —— `applied:false` 照样 `amosWarn`（`invoke` 不再失败，但失败事实不能少记）。
  新纯函数 `radioRefusalView()` 把应答压缩成 `{noteKey, surface}`：
  - `platform_managed` 用**被点名那个 radio**自己的句子（级联被成员挡下时 `radio` 点名成员，
    而不是被请求的那个），并带上它的 surface ⇒ 屏幕**当场**就能提供「打开系统设置」；
  - `provider_refused` / `airplane_active` / `unsupported` 各有一句；
  - **读不懂的 kind ⇒ `noteKey:""`** —— 屏幕只知道"没应用"，不得发明理由；surface token 读不懂
    就丢弃，绝不渲染一个点了没反应的按钮。
- **UI**：通知中心 tile 与设置页（无线局域网 / 热点）在拒绝处显示一句话（`role="status"`），
  `platform_managed` 时附「打开系统设置」；写**成功**或离开页面即清除。kind 缺失或四类之外时，
  屏幕仍必须说「这个开关没能更改——设备没有说明原因」（`radio.refused.unknown`）——
  **不说话本身就是不诚实**。
- **测试**：`amos-radio` 41、`amos-tauri` radio 命令 10（新 4 条：applied 必带写后快照；
  refused 必带结构化拒绝、状态来自重读而非请求回声；只有未知 key 才 `Err`；refusal 的
  kind/radio/surface 逐字段钉值）；`radioControl` 视图压缩 8 条；通知中心 / 设置页的 svelte
  用例把假桥换成结构化应答，并新增 DOM 断言：拒绝句可见、无 surface 就无按钮、写成功清掉拒绝。
- **诚实边界**：`requested` 只是对照（「请求过」与「应用了」是两回事）；`detail` 不上屏幕
  （设备的话只有机器 token，句子是我们按 token 说的）；不改任何 Kotlin 契约 —— `flipRadio` 的
  glue 照旧，被拒绝的这一次只是被如实转述。

### 14.1 真机取证（S5 / Android 14 / API 34，YY000286，2026-09-14）

| 验收项 | 设备取证 |
| --- | --- |
| 拒绝句**上屏**（UI 级） | 设置 → 个人热点：为让 provider 真的拒绝（本机热点是 `app_controlled`，正常可直接开启），先经 adb 把**应用外**的飞行位置位（平台在飞行模式下拒绝 tethering；AmOS 的飞行位不追踪应用外改动，故内核守卫不先挡 —— 见 §14.2）；SSID=`AmOS-Hotspot` 与口令经原生 value setter + `input`/`change` 事件填入（直接改 DOM value 不够 —— `toggleHotspot` 在 `!ready` 时静默不动），点开关 ⇒ 拒绝行（`role="status"`，testid `hotspot-refused`）渲染「设备没有接受这次开关操作，状态未改变。可重试，或前往系统设置中操作。」= `radio.refused.device`，开关保持关 —— **状态来自拒绝后的重读，不是请求的回声**。截图 `/tmp/amos-a203-evidence/a203-hotspot-refused-row.png`（先 `cmd statusbar collapse` 收起系统 shade 再拍） |
| 桥级原始载荷（WebView CDP 直连 `invoke`） | `radio_set("airplane", true)` ⇒ `{kind:"platform_managed", surface:"airplane_settings", reason:"privileged_only"}`（§13 策略层，未触达平台）；`radio_set("hotspot", true)` ⇒ `{kind:"provider_refused", detail:…}`（Kotlin tethering 拒绝这一次写入，`detail` 只进账本）。两条都是 `Ok(applied:false + …)` 的**结构化数据** |
| kind 映射闭合 | `provider_refused → radio.refused.device`（`lib/radioControl.ts`），屏上中文与 `zh.ts` 逐字一致 |
| 自动化路径备注 | `adb input swipe` 从屏顶拉起的是**系统** shade，不是 AmOS NC —— NC 用壳根上的合成 PointerEvents 打开（x≈135，y 10→140）；本机 NC QUICK 网格**没有热点 tile**（wifi/bt/airplane 均被托管 ⇒ ⚙ 只走 `radio_open_settings`），所以 `radio_set` 的 UI 拒绝路径在 设置 → 个人热点 |

### 14.2 真机诚实边界

- **`airplane_active`（飞行守卫）在真机 UI 上结构不可达**：守卫读的是 AmOS **自有的持久化飞行位**
  （`amos.settings` 种子 → `AndroidRadioProvider` 的 `AtomicBool`，REQ-A184 的「AmOS-authored bit」——
  平台的 `AIRPLANE_MODE_ON` 普通安装写不了），而设备上这一位**永远无法置真**：§13 已在策略层把
  `radio_set("airplane", …)` 拒成 `platform_managed`。应用外（系统 QS / adb）的飞行改动**不会进入**
  这一位，守卫看到的飞行位恒为假，设备上真正拒绝的是 provider（本次取证正是如此，重启应用也不会
  重读 OS 的飞行位）。该 kind 由 `amos-radio` 单测、`radioRefusalView` 映射与 svelte DOM 断言覆盖；
  `unsupported` 同理属「无后端主机」场景。
- **设备上实际出现过的 kind**：桥级 `platform_managed`（airplane）+ `provider_refused`（hotspot）；
  UI 级 `provider_refused`（热点页拒绝行 + 截图）。
- **截图时序如实记录**：截图摄于飞行位经 adb 还原之后 —— 拒绝行按设计存留（写成功或离开页面才清除），
  所以它仍是那次拒绝的屏幕事实；取证结束时设备已还原（`airplane_mode_on=0`）。
