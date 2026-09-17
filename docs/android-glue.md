# Android producer glue — Kotlin 侧推进 record_*（骨架）

真机 no-UI Android 基座里，IMU/Camera 只能由 **System UI APK（持 Context）** 采集。上一轮把
**读侧**（`SensorHost`/`LiveSensorProvider` 流桥 + `SensorManager` 门控）与命令入口落成；本轮补
**生产者侧骨架**：Kotlin 监听器把真机事件经 JNI upcall 推进同一个 bus。

```text
                       ┌──────────── System UI APK (Context) ────────────┐
   SensorEventListener.onSensorChanged ─► SensorGlue.recordImu(*) ─┐      │
   Camera2 ImageReader.onImageAvailable ─► CameraGlue.recordFrame(*)┤      │
                       └───────────────────────────────────────────┼──────┘
                                                                    ▼
                          amos-tauri/src/android_glue.rs  (Rust, #[no_mangle])
                                                                    │
                                         GLUE_BUS: LiveSensorProvider
                                            (arm 自 SensorHost.producer())
                                                                    │
                                             SensorHost (host 读侧，能量门控)
```

## 文件

| 位置 | 内容 |
|---|---|
| `crates/amos-tauri/android-glue/com/amos/ai/glue/SensorGlue.kt` | 注册 `TYPE_ACCELEROMETER`+`TYPE_GYROSCOPE` `SensorEventListener`；`onSensorChanged` 调 native `recordImu(tsMs, ax..az, gx..gz, tempC)`。 |
| `.../CameraGlue.kt` | `Camera2` `CameraDevice` 预览会话 → NV21 `ImageReader`；`onImageAvailable` 调 native `recordFrame(id,w,h,fmt,fps,bytes)`。 |
| `.../Nv21.kt` | `YUV_420_888 → NV21` 打包（AmOS `CameraFrame` 负载布局）。 |
| `.../AmosGlue.kt` | 装配 facade：请求 `CAMERA` 权限、`onStart` attach / `onStop` detach。 |
| `crates/amos-tauri/src/android_glue.rs`（`#[cfg(feature="android")]`） | **Rust 回调 stub**：`GLUE_BUS` + `arm(bus)`/`is_armed()` + `#[no_mangle]` JNI 上送 `Java_com_amos_ai_glue_SensorGlue_recordImu` / `..._CameraGlue_recordFrame`（解码进 `LiveSensorProvider`）。 |
| `SensorHost::producer()` | 把读侧同一 bus 交给 `android_glue::arm`，glue 写、host 读一致。 |
| `android-glue/AndroidManifest.permissions.xml` | **跟踪**的清单片段（权限 + `uses-feature`）：合并进 `gen/.../AndroidManifest.xml`（§5.1）。 |
| `android-glue/AndroidManifest.components.xml` | **跟踪**的组件片段：`AmosInCallService`（默认拨号应用的在通话 UI）、`AmosCallScreeningService`（来电筛选/拦截）、`SmsReceiver`（进程不在也收得到短信）。此前这三个注册**只存在于 git-ignored 的生成清单里**。 |
| `scripts/android-glue-mirror.sh` | 把整棵 `android-glue/` 镜像进 `gen/`（替换而非合并），并**校验**三件事：① 生成清单含全部片段声明的 `android:name`；② **包身份一致**（`tauri.conf.json` 的 identifier ↔ glue 的 Kotlin `package` ↔ Rust 里硬编码的 JNI 类名前缀）；③ 生成 Activity 调用了全部 glue 入口。编译门 / `build-apk.sh` / `make android-app` 共用。 |
| `scripts/android-activity-wiring-check.sh` | 校验生成的 `MainActivity.kt` 是否真的调用那 15 个 glue 入口（只存在于 git-ignored 生成文件里的"手工拷贝"装配）。 |

## Rust 侧接线（boot，真机）

```rust,ignore
// in amos-tauri::run()（未来 System UI 引导路径）
let host = SensorHost::new();
app.manage(host);                     // 命令读侧
android_glue::arm(host.producer());   // Kotlin glue 写同一个 bus
// GNSS/radio：SensorHost::bind_android(vm, env, context) + radio::from_android(...)
```

Kotlin 侧在 `AmosGlue.onStart` 里 `SensorGlue.attach(ctx)` + `CameraGlue.attach(ctx)`。Rust 读侧须先用
`SensorHost::set_cameras` 上报与相机相同的 id/尺寸，否则 `record_frame` 因相机未上报而被拒、或帧不可读。

## 方向：把 VM/Context 交给 Rust 的范式（`RadioGlue.kt`，REQ-A185）

`SensorGlue`/`FlashlightGlue`/`SmsGlue`/`TelephonyGlue` 都用同一个范式：Kotlin 声明
`external fun`（JNI 名 `Java_com_amos_ai_glue_<Glue>_<method>`），Rust 侧 `#[no_mangle]
extern "system"` 接收 `(JNIEnv*, this, …)` 并把 provider/bridge 装进进程级状态。

**`RadioGlue` 是补上的那一个**：在它存在之前，`amos-tauri` 的 `RadioBridge::from_android`/
`install_android` **没有任何调用者**，于是设备上永远跑 `MockRadioProvider`（种子=持久化 store）——
快捷设置/状态栏显示的是"上次意图"而不是设备状态（实测：UI 说 Wi-Fi 已关，真机 Wi-Fi 仍开着）。
现在 `AmosGlue.onStart → RadioGlue.attach → attachNative → RadioBridge::install_android`
把 `AndroidRadioProvider` 装进 `SwitchableProvider`（同一 manager/策略实例，切换发生在
provider 层）。装配失败只记日志、留在 Mock（离线语义不变）。

## JNI 两个"设备专属"陷阱（真机 backtrace 取证，REQ-A185）

1. **失败调用会挂起异常，下一次 JNI 调用直接 abort 进程**。实测：`hotspot_is_on` 在 **tokio
   worker 线程**上调 `JNIEnv::find_class` 失败（该线程的类加载器是 bootstrap：
   `DexPathList[[directory "."]]`，看不到 `com.amos.ai.glue.*`），异常保持 pending；随后
   `snapshot()` 里的 `system_service → NewStringUTF` 触发 CheckJNI
   `JNI DETECTED ERROR IN APPLICATION … pending exception java.lang.ClassNotFoundException` ⇒
   **SIGABRT**。修：本模块所有 JNI 调用走 `jni!` 宏 —— 失败即 `exception_clear()`（宏而非函数，
   是因为 JNI 包装器要 `&mut self`，函数式写法会与借用/生命周期冲突）。
2. **`find_class` 依赖调用线程的类加载器**。修：glue 的 `jclass` 在 **attach 时**（Java 线程）
   经 `Context#getClassLoader().loadClass(...)` 解析并缓存为 `GlobalRef`，之后再从任何线程使用。

两条都是"编译期看不见、只有设备上才炸"的类型，也解释了为什么 `make android-glue-check`
（真 SDK 编译 + 宿主 JVM 单测）全绿却仍需要真机验收。

## Rust 侧日志的落点：logcat（REQ-A187，2026-09-13）

设备轮次的另一个"代码说一套、设备另一套"：`crates/amos-tauri` 的 `run()` **从未安装
`tracing` subscriber** —— 于是 Android 路径里所有"如实报告"（相机帧被丢弃、glue bus 未 arm、
平台拒绝切换、provider 未装配）都是 `tracing::warn!`/`info!`，而**没有订阅者的事件等于空操作**：
真机上一条都看不到（A185 的"Rust tracing 不落 logcat"到这里才说清 —— 不是"不落 logcat"，而是
**没有任何落点**）。

补全：新增 `crates/amos-tauri/src/host_log.rs`（**REQ-A229 前的文件名是 `android_log.rs`**；该模块现在是**一个订阅点、两个 sink**——Android 走 logcat，桌面走 stderr，见 `docs/multi-window.md` §1.5 的 PC 实机验收），在 `run()` 的**第一行**安装
`tracing_subscriber` 的一个 layer，把每条事件经 `__android_log_write(prio, "AmosRust", line)`
写进 logcat —— 不需要新依赖（`liblog` 已因 NDK 音频路径被链接），失败静默（logging 不能成为
新的故障源），`try_init` 保证幂等。

设备验证（真机 S5 / Android 14，安装后冷启动）：

```bash
adb logcat -c && adb shell am start -n com.amos.ai/.MainActivity
adb logcat -d -s AmosRust
# I AmosRust: amos::radio message=Android radio provider installed — radio_status/radio_set now read and drive the device
# I AmosRust: amos_tauri_lib message=clipboard guest link inert: AMOS_GUEST_CLIPBOARD_SOCKET is not set
# W AmosRust: amos_tauri_lib message=AI daemon not reachable on boot: … /data/local/tmp/amos-ai.sock: transport error
```

第一行是 **RadioGlue 装配成功的直接证据**（A185 只能用行为间接证明）；**过滤前后对比**：未加
target 过滤时 25 秒内 **9905 行**（几乎全是 `jni` crate 的逐调用 `log` 记录），加上
`Targets::new().with_target("amos", DEBUG)` 后只剩上面 **3 行** —— 一个设备日志如果不能读，就等于
没有。

## 共享 JNI 助手 `crates/amos-jni`（REQ-A186）



A185 在真机上抓到的 SIGABRT 不是 `amos-radio` 独有的形态：**全仓 15 个模块、52 个 JNI 调用点，而清待处理异常的实现只有 1 处**（修 radio 时加的）。于是把它收敛成一个 crate：

| 帮手 | 为什么 |
| --- | --- |
| `amos_jni::attached(vm)` | 替代 `JavaVM::attach_current_thread*`：attach 的同时**先清一次待处理异常** —— tokio 的工作线程是复用的，上一个操作留下的 pending 异常会让这里的第一条 JNI 调用直接 abort |
| `amos_jni::with_env(vm, f)` | 整个操作一个 `JNIEnv`，失败后**再清一次**（异常不外溢给下一个操作） |
| `amos_jni::jni_call!(env, …)` | 逐调用清理：失败后同一操作里还有 JNI 调用时用它（`amos-radio` 全部站点都是） |
| `amos_jni::resolve_class(env, ctx, "com.amos.ai.glue.X")` | 经 `Context#getClassLoader()` 解析 glue 类并缓存 `GlobalRef`，替掉依赖**调用线程**加载器的 `find_class` |

**接入范围**：`amos-radio`/`amos-sensor`/`amos-media`/`amos-power`/`amos-profiling`/`amos-flashlight`/`amos-sms`/`amos-telephony`/`amos-clipboard` 以及 `amos-tauri` 的 `blocklist`/`clipboard_glue`/`devcare_device`/`incall`/`mic_permission`/`real_dial` —— 15 个文件全部改为经 `amos_jni::attached` 取 env；`amos-radio` 的本地宏与类解析改为复用共享实现（单一实现，调用点不变）。

**门禁** `scripts/jni-exception-scan.mjs`（接入 `make lint`）：

1. `attach_current_thread*` 不得出现在 `crates/amos-jni/` 之外；
2. `find_class(` 不得出现在 `crates/amos-jni/` 之外 —— 只有只握有 `JavaVM`（没有 `Context`）的站点例外，且必须在 `scripts/jni-allowlist.json` 里**写明理由**，同时把调用包进 `jni_call!`；条目失效（站点已不存在）同样 FAIL。

自测 6/6；实扫 319 个生产 `.rs`、2 处允许清单站点；**负控**：把 `amos-flashlight` 改回裸 `attach_current_thread` ⇒ 点名该文件；把允许清单条目改到不存在的文件 ⇒ 报 "stale allow-list entry"；两处均 `cmp` 字节还原。
## 诚实边界（本机不可端到端验证）




- **Rust 半侧已 host 验证**：`cargo check -p amos-tauri --features android`、`cargo clippy
  --features android --lib -- -D warnings`、以及 `android_glue` 的 2 项纯逻辑单测全绿。
- **Kotlin 半侧**：本机无 Android VM，但**编译已在真实 SDK 上被门禁覆盖** ——
  `make android-glue-check`（`scripts/android-glue-nv21-check.sh`）先用
  `scripts/android-glue-mirror.sh` 把整棵 `android-glue/` 镜像进 `gen/`（**不要手工 `cp`**：
  手工拷贝会陈旧、新增文件根本进不去），再校验生成清单/包身份/Activity 装配，最后跑
  `:app:compileArmDebugKotlin` + `:app:testArmDebugUnitTest`。真机上仍需验收权限、线程与
  `JNI` 上送签名。
- JNI 方法名由包/类推导：`com.amos.ai.glue.SensorGlue` → `Java_com_amos_ai_glue_SensorGlue_*`，
  `CameraGlue` → `..._CameraGlue_*`。若改名须同步 `android_glue.rs`。

## 平台权限清单：代码声明的能力必须有对应声明（REQ-A185，2026-09-13）

**缺陷（真机坐实）**：`crates/amos-radio/src/android.rs` 的 `AndroidRadioProvider` 经 JNI 调
`WifiManager#isWifiEnabled` / `#setWifiEnabled`、`BluetoothAdapter#isEnabled/enable/disable`，
而 `AndroidManifest.permissions.xml` 里**一个 Wi-Fi/蓝牙权限都没有**（讽刺的是，唯一声明过的
`TETHER_PRIVILEGED` 恰恰是永远拿不到的特权权限）。于是真机上这些调用全部
`SecurityException`：无线电快照与快捷设置磁贴是死的，而**所有门禁仍然绿** —— `android-glue-check`
是在真实 SDK 上编译的，`android.jar` 里**有**这些方法；权限是**安装/运行时**事实，编译器看不见。

**设备取证（S5，Android 14 / API 34，arm64）**：

```bash
adb shell dumpsys package com.amos.ai | grep -cE 'ACCESS_WIFI_STATE|CHANGE_WIFI_STATE|BLUETOOTH'
# 0   ← 代码却调用了要求这些权限的 API（修复前）
```

**修复**：

| 层级 | 内容 |
| --- | --- |
| 追踪清单 | 新增 `ACCESS_WIFI_STATE` / `CHANGE_WIFI_STATE`（normal，装包即授予）、`BLUETOOTH` / `BLUETOOTH_ADMIN`（`maxSdkVersion=30`）、`BLUETOOTH_CONNECT`（31+，**运行时**） |
| 生成清单 | 按 §5.1 合并进 `gen/android/…/AndroidManifest.xml`（host-local，`scripts/android-glue-mirror.sh` 会**校验**合并是否完整并给出缺项） |
| 运行时请求 | `MainActivity.Wiring.kt::requestNeeded` 在启动时一并申请 `BLUETOOTH_CONNECT`（`Build.VERSION.SDK_INT >= S` 才申请；≤30 的 legacy 对是装包授予） |
| 机械化 | 新增门 `scripts/android-permission-scan.mjs`（接入 `make lint`）：平台 API → 所需权限的**成文映射表**，逐条对照追踪清单；运行时权限还必须在 Kotlin 里有 `requestPermissions` |
| 死代码清理 | Kotlin 编译器同时报出 3 处"声明了却没用"：`ClipboardGlue.pushTextClipboard` 的 `seq`（两侧删除，JNI 签名 `(Ljava/lang/String;)V`）、`AmosGlue.onStop(context)`（显式 `@Suppress` + 理由）、`FlashlightGlue` 的 elvis 死回退（删除，注释改写） |

**诚实边界**：`CHANGE_WIFI_STATE` 是 normal 权限（装包即授予），但 **API 29+ 的平台仍只允许系统/
设备所有者调用** `setWifiEnabled` —— 普通安装下它会返回 `false`，于是 A184 的"平台拒绝即错误"路径
会如实报错（不会假装切换成功）；`BLUETOOTH_CONNECT` 需用户同意，拒绝后读取会以 provider error 呈现，
而不是显示成"蓝牙已关"。映射表是手工维护的，因此**没列进去的平台 API 看不见**。



真机（S5，Android 14）授予 `CAMERA` 后 `amos-camera` 线程曾在 `Nv21` 读 plane buffer 时抛
`IllegalStateException: buffer is inaccessible`。旧修法是把 `CameraGlue.onImageAvailable` 整段帧编码
包进 `try/catch(Throwable)` **丢帧**——进程不再 FATAL，但**每次失效都丢一整帧**，等于用一个静默的
黑屏换取不崩。本轮把根因定位并真正修掉。

### 根因（AOSP 证据，非猜测）

`buffer is inaccessible` **不是**「HAL 的 buffer 不给 Java 读」。它是 `java.nio.DirectByteBuffer`
自己的守卫：该类的每个读写方法都先查 `memoryRef.isAccessible`，而 `MemoryRef.free()` 会置
`isAccessible = false; allocatedAddress = 0; isFreed = true`——即**底层 native 内存已被释放**
（见 Android SDK `sources/android-*/java/nio/DirectByteBuffer.java`）。对 `ImageReader` 的
`Image.Plane.buffer` 而言，这块内存在 **Image 被 `close()`、或 `ImageReader` 被 `close()`/槽位被回收**
时释放。所以真实失效模式是 **use-after-free：回调在读一个已经关闭的 reader 交出来的图像**。

触发它的具体路径：`MainActivity.onStart` 每次回到前台都会 `AmosGlue.onStart` →
`CameraGlue.attach`；旧 `attach` 只要 `camera != null` 就先 `detach()` 再重建，而旧 `detach()` 在
**调用线程**上直接 `reader.close()`——同时 `onImageAvailable` 正跑在 `amos-camera` 线程上。
close 释放了在途图像的内存，回调继续读它 → `buffer is inaccessible`。

另一处真实缺陷：旧 `attach` 在 `CAMERA` 未授权时提前 `return`，但此时 `HandlerThread` 与
`ImageReader` **已经建好**——授权前的每次 `onStart` 都泄漏一份，且泄漏的 reader 仍挂着监听器、从
第二条线程继续回调。

### 修复

1. **`attach` 幂等**：同一相机已在采集就直接返回，绝不为「重建」去拆一个活着的会话。
2. **`detach` 串行化到相机线程**：先清字段（排队中的回调立刻认不出自己而退出），再把
   `session/device/reader` 的 close **post 到同一个 looper**，最后 `quitSafely()`（已入队的 close
   先执行、线程随后退出）；looper 已死则内联 close（此时不可能有在途回调）。
3. **陈旧 reader 守卫**：`onImageAvailable` 先比 `reader !== this.reader`，陈旧就
   `acquireLatestImage()?.close()` 后返回——绝不读它交出来的图像。
4. **授权检查前置**：先查 `CAMERA`，再建线程/reader，不再泄漏。
5. **`onOpened` 守卫**：打开期间若已被拆解（`reader == null`）则关掉 device，不泄漏相机。
6. **纪元守卫（`generation`）**：每次拆解自增；`CameraDevice`/`CameraCaptureSession` 的每个回调都
   带着自己那次 open 的 epoch 并回查——迟到的 `onDisconnected`/`onConfigured` 绝不再写进新一代
   状态（否则会把刚打开的相机的引用置空、或把一个已关闭的会话塞进 `session`）。
7. **打包器重写（`Nv21Packer`）**：把易错的 stride 数学从 `Nv21.copyRowStrided` 抽成**不碰
   Android 类型的纯函数**，并修掉两处真实缺陷——旧代码 `buffer.rewind()` 后按
   `row*rowStride + col*pixelStride` **无上界绝对读**，既会误读短窗口、也可能索引越 `limit()`。
   新实现只在 `limit()` 内读（读不到的尾字节留 `0`，绝不抛）、支持 `pixelStride` 1/2 与任意
   `rowStride`、luma 连续行走整行批量拷贝。
8. **可观测**：`CameraGlue.droppedFrameCount()` 暴露被守卫丢弃的帧数；防御性 `try/catch` 保留为
   纵深防御，但不再是唯一手段。

### 验证

- **宿主 JVM 单测（无需设备）**：`android-glue/tests/.../Nv21PackerTest.kt`，入口
  `make android-glue-check`（= `scripts/android-glue-nv21-check.sh`：把**整棵** `android-glue/`
  树镜像到 `gen/` 后跑 `:app:compileArmDebugKotlin` + `:app:testArmDebugUnitTest`）。钉住：
  NV21 的 **V 先 U 后** 交织、I420 紧凑布局、semi-planar U/V 共缓冲（V 从共享 buffer +1 起）、
  luma 行填充被跳过、**短窗口零填而不抛**、奇数/非正几何返回 `null`。
- **编译（门禁的覆盖面）**：镜像 + 校验步骤只有**一个实现** —— `scripts/android-glue-mirror.sh`
  （`mkdir -p` + `rm -f` + 整树 `cp`；随后**三项校验**：生成清单含片段声明的每个 `android:name`、
  **包身份一致**（identifier ↔ glue `package` ↔ Rust 的 JNI 前缀）、生成 Activity 调用了 15 个 glue
  入口），由**编译门**、`scripts/build-apk.sh` 与 `make android-app` 共用。它替换而非合并，所以
  (a) 门禁编译的 Kotlin 集合**恰好等于**仓库跟踪的集合、任意机器可复现，(b) **APK 里不会缺/不会
  带上陈旧的文件**，(c) 两处**手工合并的漂移会响亮失败**。此前这里是手写清单 + 文档里一句 `cp -r`
  + §5.2 一句"把调用拷进生成的 Activity"：热点 glue **从未被编译**、alarm glue 从未被镜像、新增
  glue 可能**根本不进 APK**、三个组件注册与整段 Activity 装配**只存在于本机**、权限漂移无人知晓
  —— 见 REQ-A174/A175/A176/A177。
- **编译**：`./gradlew :app:compileArmDebugKotlin`（JDK 17）通过。
- **诚实边界**：单测覆盖的是 stride/边界数学；**“native 内存已释放”的那条竞态无法在宿主复现**，只能
  真机验收（下节）。

### 设备验收步骤（真机；未在本环境执行）

1. `adb logcat -s AmosGlue`：授权 `CAMERA` 后不再出现 `frame encode dropped: ... buffer is
   inaccessible`。
2. 反复 `HOME` → 回前台（多次触发 `onStart`）：无 FATAL；`droppedFrameCount()` 不持续增长；
   `dumpsys media.camera | grep -i client` 只有一个 AmOS 客户端连接。
3. 读侧能取到帧：`LiveSensorProvider` 最新帧 `seq` 递增（`docs/sensors.md` §8 的 `sensor-data`）。

## 个人热点 glue（`TetheringGlue.kt`，2026-09-13）

手机的 **Wi-Fi 热点（个人热点 / 网络共享）** 走 Android 的 tethering 栈，而该 API 是
**异步 + 回调式**的，raw JNI 造不出回调对象 —— 与 `SmsGlue`/`FlashlightGlue` 同理，调用必须
落在 Kotlin 侧（`docs/radio.md` §7）。

| 位置 | 内容 |
|---|---|
| `crates/amos-tauri/android-glue/.../TetheringGlue.kt` | `@JvmStatic setWifiTethering(context, enable)`：`TetheringManager#startTethering(TetheringRequest, Executor, StartTetheringCallback)` / `#stopTethering(TetheringRequest, Executor, StopTetheringCallback)`（`TetheringRequest.Builder(TETHERING_WIFI).build()`）。`@JvmStatic isWifiTethering(context)` 读 `TetheringEventCallback#onTetheredInterfacesChanged` 维护的**实时**状态。 |
| `crates/amos-radio/src/android.rs`（`android` feature） | `AndroidRadioProvider::set_hotspot` → `find_class("com/amos/ai/glue/TetheringGlue")` + `call_static_method("setWifiTethering","(Landroid/content/Context;Z)Z")`；返回 `false` ⇒ `RadioError::Provider`（**不翻转镜像、不上报"已开启"**）。`snapshot` 经 `isWifiTethering` 读夹层状态，取不到时退回**上一次被平台接受**的状态（best-effort，不把整份 radio 快照打空）。 |
| `crates/amos-tauri/android-glue/AndroidManifest.permissions.xml` | 记录 `TETHER_PRIVILEGED` 是 **signature\|privileged** 权限（普通安装拿不到 ⇒ `SecurityException` ⇒ glue 返回 `false` ⇒ provider 错误），以及 `ACCESS_NETWORK_STATE` 的用途。 |

**诚实边界（设备侧）**：

- **API 现实（`javap` 核实，非推测）**：`android.net.TetheringManager` / `TetheringInterface`
  **自 API 36 才进入公开 SDK** —— android-34/35 的 `android.jar` 里**没有**这个类；
  `ConnectivityManager` 的 `startTethering` / `OnStartTetheringCallback` 是 `@SystemApi`，
  公开 SDK 中**完全不存在**。所以 **API < 36 没有任何可写的公开 tethering 调用**，glue 在
  36 以下如实返回 `false`（不会假装有 ConnectivityManager 回退）。`TetheringManager` 的三个
  callback 类型是**接口**（方法为 `default`），故 Kotlin 的 `object :` **不带括号**。
- **权限现实**：`startTethering` 需要 `TETHER_PRIVILEGED`（signature\|privileged）。普通安装下
  热点**开不起来是如实结果**：glue 返回 `false`，Rust 报 provider 错误，UI 因此不会显示一个不
  存在热点。要真正开启需要特权安装（系统应用）。
- **AP 配置（SSID/口令/频段）**：**平台限制，而非"待接线"** —— `javap` 核实 android-36 的
  `android.jar`：公开的 `SoftApConfiguration.Builder` **只有 `setChannels`**（`setSsid`/
  `setPassphrase`/`setBand`/`setSecurityType` 全为 `@SystemApi`）⇒ 非特权安装**无法**构造带
  SSID/口令的 `SoftApConfiguration`，因此 `TetheringRequest.Builder#setSoftApConfiguration`
  对普通应用不可用。设置页配置是**用户意图**（持久化在 `amos.hotspot`），本 glue **不**声称已
  应用；只有特权/系统签名构建才可能（见 `docs/radio.md` §7）。
- **状态**：`active` 由 `TetheringEventCallback#onTetheredInterfacesChanged` 维护，因此
  **在 AmOS 之外开关的热点也会被如实反映**（不是只反映我们自己的请求）。
- **验证**：Kotlin 侧由 `make android-glue-check`（`scripts/android-glue-nv21-check.sh`）把
  **整棵** `android-glue/` 树镜像进生成工程并跑 `:app:compileArmDebugKotlin` —— **真实 SDK 上的
  编译门**（本文件第一版正是在这里被查出用了不存在的 API）。真机运行/权限/线程仍需设备验收。


## 组件与库名：平台在**实例化时按名字找类**的东西也得有门（`android-component-scan.mjs`，REQ-A379）

`AndroidManifest.components.xml` 是本仓**跟踪**的片段，那 4 条 `<service>`/`<receiver>` 就是设备上**唯一**让
在通话界面、来电筛查、短信常驻接收、精确闹钟存在的原因 ✓（片段自己的注释里写着 F-TAU-007 的教训 ✓）。
而每一条都是一个**平台在实例化时按名字找类**的字符串 ✓：名字对不上类（打错一个字母，或 Kotlin 侧改了名）
⇒ **编译照样过、启动也不报错** ✗ —— 组件**永远不运行** ✗：

| 组件 | 名字错位的后果 |
|---|---|
| `AlarmReceiver` | 闹钟响了，**什么都不发生**（F-TAU-007 的症状出现在同一个 seam 的另一侧） |
| `SmsReceiver` | 短信只在应用恰好在运行时才到达 |
| `AmosInCallService` / `AmosCallScreeningService` | 没有在通话界面 / 拦截静默失效，**没有任何错误** |

**既有门管到哪** ✓：`scripts/android-glue-mirror.sh` 证明的是**两个文件**里名字一致 ✓（片段 ↔ 生成的
manifest）—— 它可以照旧通过，而两边写着**同一个错名字** ✗ ⇒ 没人看过 Kotlin 那一侧 ✓。新门补上三条：

| 判据 | 内容 | 失败即 |
|---|---|---|
| **K1** | 片段的每条 `<service>`/`<receiver>` 名字必须解析到本仓 glue 里**存在**的类，且**种类对**（`<receiver>` ⇒ `BroadcastReceiver`；`<service>` ⇒ `Service` 或平台已知子类） | 平台实例化不到（功能静默死亡） |
| **K2**（反向） | glue 里一个**顶层**且继承组件种类的类必须被片段登记 | 类编进 APK，平台永远不会实例化它 |
| **K3** | 每个 `System.loadLibrary("x")` 的 `x` 必须是某个 workspace crate 的 `[lib] name`（或包名 `-`→`_`） | 类初始化 `UnsatisfiedLinkError` |
| **K4** | 声明**内部**的名字：`<action>` 必须是**闭合表** `PLATFORM_ACTIONS` 里的平台 action、必须投递给**这种**组件（`<receiver>` 的动作不能挂在 `<service>` 上），且受保护广播必须声明平台要求的**发送方权限** | 拼错的动作 ⇒ 组件永不触发；`SMS_RECEIVED` 的导出接收器缺 `BROADCAST_SMS` ⇒ **任何应用都能注入假短信** |

`PLATFORM_ACTIONS` 是**故意闭合**的 ✓：表里没有的动作**直接失败** ✓ —— 因为从这里看，"没见过的平台动作"与"拼错的平台动作"**长得一样** ✓，而后者就是一个永不运行的组件 ✓；加一条新动作是**有意的登记**（要把平台要求的发送方权限一起写进去 ✓），不是猜 ✓。`<meta-data>` 的名字没有这样的后果表 ⇒ **只报告** ✓。

**诚实边界**：①**相对名按 `tauri.conf.json` 的 `identifier` 解析**（`.glue.X` → `com.amos.ai.glue.X`），所以
"命名空间"与"组件名"两处不能悄悄漂开；②`<activity>`/`<provider>` **只报告不判定**（Activity 由 Tauri 生成），
**app 命名空间之外**的组件（如 `androidx.work.…`）同样只报告（不是本仓的类）；③种类检查读的是**声明里的父类
文本**（一文件一类的 glue 惯例）；自有基类 ⇒ "读不出来" ⇒ **失败 + allowlist**，而不是放过；④K2 只认识它被指向
的那一个片段（由别的 manifest 登记的组件要写 allowlist 理由）；⑤K4 的表**闭合**（未列出的 action 失败 ⇒ 必须
有意登记）；⑥**未在真机上复验** ✗ —— 本门是静态判据。

**自检与负控**：`--selftest` ⇒ **40 断言** ✓（含"注释里的组件不算声明" ✓、"相对名解析" ✓、"无名组件" ✓、
"读不出父类 ⇒ 失败" ✓、`[lib] name` 优先于包名 ✓、"拼错的动作是发现" ✓、"动作投给了错种类的组件" ✓、
"导出接收器缺发送方权限" ✓、"发送方权限写错" ✓、"`<meta-data>` 只报告" ✓）；**真树负控（逐字节还原，`cmp` 一致）**
✓：**(A)** 把 `AlarmReceiver` 改一个字母 ⇒ `missing-kotlin-class` ✓ **并**报反向的 `unregistered-component` ✓；
**(B)** 把该 `<receiver>` 改成 `<service>` ⇒ `wrong-kind` ✓；**(C)** `SensorGlue` 的 `loadLibrary` 改名 ⇒
`unknown-library` ✓；**(D)** 去掉 `SmsReceiver` 的 `android:permission="…BROADCAST_SMS"` ⇒ `missing-sender-permission` ✓；
**(E)** 把 SMS 动作拼错 ⇒ `unknown-action` ✓；**(F)** 把 `InCallService` 动作拼错 ⇒ `unknown-action` ✓。
当前树 ⇒ **EXIT=0**（4 个组件 ✓、3 个动作 + 发送方权限 ✓、1 条 meta-data 报告 ✓、4 个库名 ✓）。

## Android Lint 终于在这棵树里跑起来了（REQ-A380，2026-09-17）

**为什么之前没看见**：`make android-glue-check` 只做两件事 —— 把整棵 glue 镜像进生成工程、跑
`:app:compileArmDebugKotlin` +（主机 JVM 单测）、再把**我们自己 glue 的 Kotlin 警告**当错误 ✓。它能证明"**编得过**" ✓，
但证明不了另外两件事 ✗：**这些 API 在 `minSdk = 26` 的设备上存在吗** ✗、**这个调用需要一枚没人检查的权限吗** ✗ ——
而这两件事正是**平台自己的 linter**（Android Lint）回答的，本仓**从未跑过它** ✓。

首跑（`./gradlew :app:lintArmDebug`，compileSdk 36 / minSdk 26）在**我们的 glue** 里报了 **20 个 error**：

| 位置 | 判据 | 真身 |
|---|---|---|
| `TetheringGlue.kt` ×5 | `NewApi`（API 36 的 `TetheringManager` / `TetheringEventCallback` / `TetheringInterface#getType`、API 28 的 `Context#mainExecutor`） | **不是设备缺陷**：两个调用方都先判了 `SDK_INT` ✓ —— 但 **lint 不跟随调用方里的守卫** ✗。修法：把要求**声明在函数上**（`@RequiresApi(TETHERING_API)`）⇒ lint 会**逐个调用点**核对 ✓（比函数体里再判一次更强：以后有人从无守卫处调用，**lint 当场报错**，而不是真机上 `NoSuchMethodError`）。函数体里那版 `SDK_INT` 复查**故意不留** —— 有注解它就可证明是死代码，`ObsoleteSdkInt` 也这么说 ✓ |
| `BluetoothGlue.kt` ×8 | `MissingPermission` | **不是缺陷**：每个调用都在 `try/catch (Throwable)` 里，平台拒绝会被转成如实的 `false` / 日志 ✓（`startDiscovery` 还先过 `canScan()` ✓）—— lint 两边都看不见 ✗ ⇒ **逐点 `@SuppressLint("MissingPermission")` + 写明理由** ✓（第一处写了完整理由，其余七处引用它） |
| `MediaStoreGlue.kt` ×4（warning `InlinedApi`） | `MediaStore.VOLUME_EXTERNAL_PRIMARY`（API 29） | **真的缺陷** ✓：`MediaStore.*.getContentUri(String volume)` **本身就是 API 29 的 API** ⇒ 在 API 26..28 上是 `NoSuchMethodError`，被本类的错误路径接住 ⇒ **那些路径在 26..28 上等于静默死亡** ✗（而 `minSdk` 就是 26 ✓）。修法：`mediaCollection(legacy, volumeBased)` —— API ≥ 29 用卷形式、以下退回 `EXTERNAL_CONTENT_URI` ✓ |

### 16 条 warning 逐条裁定（这一半才是「报告不是决定」的地方）

| 判据 | 条数 | 裁定 |
|---|---|---|
| `ObsoleteSdkInt` | 3 | **删掉死代码** ✓（`minSdk 26` 是权威）：`AlarmGlue` 的 `SDK_INT >= O`（26）与 `SDK_INT >= M`（23）分支、`FlashlightGlue` 的 `SDK_INT < 23` 早退 —— 三条都**永远为真/为假**，删掉是**行为等价**的，留着的只是"一个什么也不做的 API 级别声称" ✓（`TORCH_API` 常量随之删除，否则会变成未使用的私有常量，被编译门抓住 ✓） |
| `StaticFieldLeak` | 6 | **抑制 + 理由** ✓：三个 `object` 单例（`ClipboardGlue`/`DevCareGlue`/`SmsGlue`）存的都是 `context.applicationContext` ✓（`bind()` 里赋值 ✓，`ClipboardGlue.unbind()` 还置空 ✓）⇒ **与进程同生命周期，不是泄漏** ✗；lint 分不清 Activity context 与 application context（它看不穿 `bind()` 的调用者）✓ |
| `UseKtx` | 5 | **抑制 + 理由** ✓：lint 建议 `String.toUri()`，那是 **androidx.core-ktx** 的扩展 ✓ —— 生成工程不依赖 core-ktx ✓，而 `Uri.parse` 是平台 API ✓（加依赖要手改 git-ignored 的 `gen/`，比这 5 处建议贵得多 ✓） |
| `InlinedApi` | 2 | **抑制 + 理由** ✓：`Manifest.permission.BLUETOOTH_SCAN`（API 31）与 `Settings.Panel.ACTION_INTERNET_CONNECTIVITY`（API 29）都是**编译期内联的常量**（值被内联，不是 API 调用 ✓）；后者在 29 以下**不解析** ⇒ 被 catch 接住并**回退到 `ACTION_WIRELESS_SETTINGS`** ✓（已有行为 ✓，只是 lint 看不见 ✓） |

**门现在做什么**：`make android-glue-check` 的第三阶段跑 `:app:lintArmDebug`（默认 `--offline`）并：
①**我们 glue 的 findings 必须为 0** ✓（**error 与 warning 都算** ✓ —— 上表满 16 条已全部裁定 ✓）；有则按 `文件:行` 列出并失败 ✗；
②**「接受」只能写在源码里** ✓（`@SuppressLint("…") // 理由` ✓）⇒ **新出现的 warning 就是"没人做过的决定"** ✓，而不是被基线悄悄吞掉 ✓；
③**生成工程 / Tauri 自己的 findings 只报告** ✓（按 issue id 归类打印：`UnusedResources` 12 ✓、`PermissionImpliesUnsupportedHardware` 8 ✓、`GradleDependency` 8 ✓、`SelectedPhotoAccess` 2 ✓ ……）—— 其中 **`PermissionImpliesUnsupportedHardware` / `…ChromeOsHardware` / `SelectedPhotoAccess` 其实源自我们声明的权限** ✓（`CAMERA`/`RECORD_AUDIO`/`BLUETOOTH_*`/`READ_MEDIA_*` ⇒ Android/Play 会推断"需要这些硬件" ✓）。**本轮的决定**：**接受**（AmOS 是装到**已知硬件**上的系统 UI，走 adb 不走 Play ✓）⇒ 若要上 Play，得加一份 `<uses-feature android:required="false">` 片段并接进手工合并流程 ✓（记为下一步 ✓）；
④**没有报告文件 ⇒ 失败** ✓（"读不到"不等于"没问题"）；
⑤分类器带**自检** ✓（一条 glue error + 一条 generated error + 一条 glue warning ⇒ 必须数出 1/1 ✓）。

**诚实边界**：①这一阶段需要**已初始化的 `gen/` + JDK 17 + Gradle 依赖缓存**（首次需要联网跑一次 `:app:lintArmDebug`；之后 `--offline` 可复现 ✓）⇒ 它挂在 `android-glue-check`（`make verify` 的一条），**不在** `make lint` 里 ✓（CI 的快速路径不需要 SDK）；②**只判我们的 glue** ✓，生成工程的 7 个 error / 若干 warning 只打印 ✓；③**warning 不判定** ✓（下一步：逐条裁定 `StaticFieldLeak`/`UseKtx`/`ObsoleteSdkInt`/`InlinedApi`）；④**真机未复验** ✗（本门是静态判据；`MediaStoreGlue` 的 26..28 回退路径**没有设备**可验，只能给出"API 29 以下走 `EXTERNAL_CONTENT_URI`"这条平台事实 ✓）。

**负控**（逐字节还原，`cmp` 证明）✓：把 `TetheringGlue.bindCallback` 的 `@RequiresApi(TETHERING_API)` 拿掉 ⇒ 门 **FAIL** 并点名
`TetheringGlue.kt:167/168/169/174: Error: Call requires API level 36 (current min is 26) … [NewApi]` ✓（总 error 数 **7 → 12**，多出来的 5 条全在我们 glue 里 ✓ —— 其余 7 条属生成工程，只打印 ✓）。

## Kotlin ↔ Rust 的名字契约由门钉住（`scripts/jni-contract-scan.mjs`，REQ-A377）

JNI 的名字**一边是字符串、另一边是声明**，两个编译器都看不见对面。REQ-A376 的真机读数把代价记了下来：
`alarm_sched.rs` 用 `call_static_method` 调 `AlarmGlue.schedule`，而 Kotlin 侧是 `object` 的**成员**
（实例方法，不是静态方法）⇒ 真机第一次调用就
`java.lang.NoSuchMethodError: no static method "…AlarmGlue;.schedule(…)Ljava/lang/String;"` ✗ —— 而
Kotlin 编译过 ✓、Rust 编译过 ✓、APK 里有那个类 ✓、签名串也对 ✓ ⇒ **没有任何门看得见** ✗。

于是 `make lint` 里多了一道门（**三条**判据，同一条边界的三种走法）：

| 判据 | 内容 | 失败时的真机后果 |
|---|---|---|
| **R1** | 每一处 `call_static_method(<glue class>, "<成员>", …)` 对应的 Kotlin 成员**必须**带 `@JvmStatic`（顶层 `fun` 也不行 —— 它编译到 `<File>Kt`） | `NoSuchMethodError`：第一次调用即失败（F-TAU-014） |
| **R2** | 每个 Kotlin `external fun` **必须**有对应的 Rust `Java_…` 导出，反之亦然 | `UnsatisfiedLinkError`：Kotlin 第一次调用即失败 |
| **R3** | 每一处 `call_method(<glue/bridge 句柄>, "<成员>", <签名>, …)` 对应的 Kotlin `fun` **必须存在且签名一致**：**元数**与**类型**（每个参数 + 返回值）都从 JNI 描述符解析并与 Kotlin 声明比对（R1 同样查类型） | `NoSuchMethodError`：JNI 按**名字 + 签名**解析，Kotlin 改名、改参数或改类型即报错（F-TAU-016） |

**它怎么读 Rust**（调用点持有的是 `JClass`/`GlobalRef`，不是字符串）：字面量 → **本函数内的 `let` 绑定** →
文件级 `const`/`static` → `fn` 体内的 `self.<字段>`（`amos-radio` 的形状：`let class = self.radio_glue()?`
→ `self.radio` → `RADIO_CLASS`）→ **外层函数里唯一的那个 glue 字面量**（`incall.rs`/`blocklist.rs` 的
`find_class(...)`）。成员名若是**参数**（`call_static_bool(method: &str)`、`call0/call1/call2`），就用调用方
传进去的字面量 —— 只认字面量的门会漏掉这种形状。

**R3 怎么认「句柄」**（这是它唯一需要判断的地方，所以写死成名字规则）：接收者表达式自身出现 `…glue…`/`…bridge…`
（`bridge.glue.as_obj()`、`glue`、`self.bridge.as_obj()`），**或**接收者是一个本函数内由这类表达式绑定的标识符
（`let obj = self.bridge.as_obj();`）。**字符串与注释里的提及不算数** ✓ —— 加法测试时它当场纠正过一次误报：
`real_dial.rs` 的 `Intent#setData/addFlags/startActivity` 因为一句文档字符串写着
`call TelephonyGlue.nativeAttach at boot` 而被当成 glue 调用 ✗。平台对象（`Intent`/`Location`/`Iterator`）
按**跳过**计数 ✓（当前 50 处 `call_method` 里 37 处如此）。

**诚实边界**：①**只管本仓的 `com.amos.ai.glue.*`** —— 平台类（`android/net/Uri`、`Location` 等）按跳过计数
（静态 2 处 / 实例 37 处）；②**R3 查的是「名字 + 元数」，不是类身份**（在整棵 Kotlin glue 树里找），且句柄只按
上面的名字规则认 —— **句柄名里没有 `glue`/`bridge` 就看不见** ✗（这是 R3 与 R1 并存而不是取代它的原因）；
③**读不懂就失败**：未解析/有歧义的调用点必须带理由写进 `scripts/jni-contract-allowlist.json`（条目失配即失败），
因为"静默跳过读不懂的东西"正是这道门要防的缺陷；④Kotlin 侧是**文本阅读、一文件一类**（本仓 glue 均如此），
`@JvmStatic` 从声明上方的注解行读（中间夹 KDoc/注释无妨），继承来的成员与生成工程（`MainActivity`）不在范围内；
⑤R2 的**重载**名（`Java_…_m__<签名>`）只**报告**不判定；⑥R3 的**默认参数/`vararg`** 会让 Kotlin 的声明元数与
JNI 调用元数不同（本仓 glue 未使用；一旦使用，门会失败并要求写进 allowlist，而不是放宽判据）；
⑦**类型映射是一张表** ✓（基础类型／可空装箱／泛型擦除／按 `import` 解析简单名／本仓 glue 类名 ✓）—— **映射不出来
的类型（lambda、无 `import` 的裸名）按「报告 + 计数」处理，绝不当成一致** ✗（因此这类参数的**类型漂移**看不见 ✓）。

**自检与负控**（都进仓库）：`node scripts/jni-contract-scan.mjs --selftest` ⇒ **75 断言** ✓；**负控 A**：
拿掉 `AlarmGlue.schedule` 的 `@JvmStatic` ⇒ 门点名
`crates/amos-tauri/src/alarm_sched.rs:448 missing-jvmstatic: AlarmGlue.schedule`（并指出
`AlarmGlue.kt:295`）✓；**负控 B**：把 Rust 的
`Java_com_amos_ai_glue_ClipboardGlue_onContainerCopy` 改名 ⇒ **两个方向同时报** ✓
（Kotlin 侧 `missing-export` + Rust 侧 `stale-export`）；**负控 C**：把 `MicPermissionGlue.isGranted` 改名为
`isGrantedNow` ⇒ 门点名 `crates/amos-tauri/src/mic_permission.rs:120 missing-kotlin-member` ✓；
**负控 D**：给 `SmsGlue.snapshot` 加一个参数 ⇒ 门点名
`crates/amos-sms/src/android.rs:79 arity-mismatch`（指出 `SmsGlue.kt:193` 是 2 个参数）✓；**负控 E（类型，R3）**：把
`SmsGlue.snapshot(folder: String)` 的参数类型改成 `Int` ⇒ `signature-mismatch` ✓；**负控 F（类型，R1，走 `let sig`）**：
把 `alarm_sched.rs` 里 `let sig = "(…Ljava/lang/String;J)…"` 的 `J` 改成 `I` ⇒ 门点名
`#3: Kotlin Long (J) vs JNI I` ✓（**连 `let` 里拼出来的描述符也读** ✓）；**负控 G（返回类型，R1）**：把
`BluetoothGlue.scanState` 的返回类型改成 `Int` ⇒ `return: Kotlin Int (I) vs JNI Ljava/lang/String;` ✓ —— 七次都逐字节还原、
`cmp` 一致 ✓。

