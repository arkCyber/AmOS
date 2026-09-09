# AmOS 设备传感器 / 多媒体领域内核（Camera · GPS/GNSS · IMU）

**日期**: 2026-09-04 · **范围**: `crates/amos-sensor`（领域内核）

> 本文回答审计提出的断层——除 `amos-audio` 与基础 Telephony 外，**没有**对移动端核心硬件
> （Camera HAL / 原生定位 GPS-GNSS / IMU 陀螺仪·加速度计）提供标准服务总线与高层 API 抽象。
> 这一轮按「领域内核 + seam」落地 `amos-sensor`（纯 domain core、离线可测）；真正的**服务总线
> （gRPC over UDS 挂进 daemon）与真机 Camera2/Gnss/SensorManager HAL 接线**留 seam，后续轮次接。

## 1. 现状与定位（改动前）

改动前全仓没有相机/定位/惯性测量域的抽象：系统里 `location` 只是通知中心一个持久化布尔位
（`FUNCTIONAL_GAP_ANALYSIS.md` §二.21：模拟开关），相机与 IMU 没有任何代码面。这与 `amos-audio`
（采集/播放 trait + 16 kHz PCM 线格式 + TinyALSA/AAudio seam）和 Telephony 的成熟形态不一致。

## 2. 范围边界（已接线 → 只剩真机流桥与 System UI 客户端）

- ✅ **领域内核**：类型 / 采样 / 三族 provider seam / 确定性 Mock / 能量策略 manager + 单测。
- ✅ **服务总线（daemon 侧）**：`proto/sensor.proto`（package `amos_sensor`）→ `amos-proto` 生成 →
  `amos-sensor/src/service.rs` 的 `SensorService`（ListCameras / CaptureCamera / GetGnss / GetImu /
  GetMode / SetMode / AcquireStream）→ **已 `add_service` 挂进 `amos-ai` 的 `serve()`**，与
  `AiAgent`/`AndroidManager`/`Telephony` 同一条 UDS（`rpc_test.rs` 的
  `sensor_service_mounted_and_profile_exposed` 真 UDS 往返验证）。
- ✅ **真机 Android 骨架（`feature android`，2026-09-04）**：`amos-sensor/src/android.rs`
  `AndroidSensorProvider`（仿 `amos-radio`/`amos-telephony` 的 `android.rs`）——
  **GNSS 真实现**（`LocationManager#getLastKnownLocation`，同步）；**相机/IMU 是流**，
  需要的 `CameraDevice`+`ImageReader` / `SensorEventListener` 桥在设备上验证前返回显式
  `Provider` 错误（诚实不假装）。宿主 = System UI APK（持 `Context`）。`cargo check -p amos-sensor
  --features android` 可编译（已入 `make gated-check`）。
- ✅ **真机流桥 backend（2026-09-04）**：新增 `amos-sensor/src/stream.rs` —— 相机/IMU 这类**流**的正确读法。线程安全 atomic 最新样本桥 `ImuLatest` / `FrameLatest`（生产者线程 push 最新值，读端取最新；帧负载按 config 校验、`seq` 单调）+ 非 gated 的 `LiveSensorProvider`（实现 `SensorProvider`，读这些缓存）。`AndroidSensorProvider` 现在**持有**一个 `LiveSensorProvider`，`imu_sample`/`camera_capture` 经它返回最新真值（此前是硬编码报错）。host 装配测试（6 项）：跨线程 push→`SensorManager` 读、首样本前诚实 `Provider` 错、帧校验、not-found、PowerSave 门控叠加。`cargo check --features android` 编译绿。
- ⏳ **真机流桥接线（设备 glue + System UI Context）**：`AndroidSensorProvider` 的 GNSS 已真同步；IMU 需在 System UI APK 里用真 `Context` 注册 `SensorEventListener`、相机需 `Camera2` `CameraDevice` + NV21 `ImageReader`，各在其监听线程调 `record_imu`/`record_frame`/`set_cameras` 把样本推进上面的桥（即本轮的**生产者侧**，仍是设备 bring-up 步骤）。
- ✅ **System UI 桌面桥（2026-09-04）**：Tauri `sensor_snapshot` / `sensor_set_mode` /
  `sensor_acquire` 命令桥（`amos-tauri/src/sensors.rs`，仿 telephony 桥）+ 前端 `lib/sensors.ts`
  （类型 + `normalizeSnapshot` 等纯归一化 + 命令包装，`__tests__/sensors.test.ts`）——桌面/mock daemon
  即可从 UI 读相机/定位/IMU 与能量档。
- ⏳ **System UI 客户端桥**：Tauri `sensor_*` 命令 + 前端 `lib/sensors.ts` → **后续轮**（wire 已定）。

## 3. 领域内核 `crates/amos-sensor`（纯 std、离线可测）

| 模块 | 内容 |
|---|---|
| `spec` | 描述符与采样：`SensorKind`、`SensorMode`、`CameraConfig`/`CameraFrame`（RGBA8 / NV21）、`GeoFix`/`FixMode`、`ImuSample`/`Vec3`；PowerSave 与硬件采样上限常量 |
| `error` | `SensorError`（`TooFast` / `PowerSaveRate` / `CameraNotFound` / `InvalidArguments` / `Provider`）|
| `provider` | `SensorProvider` seam —— **笨读寄存器**：单次拉取（帧 / fix / sample）；确定性 `MockSensorProvider` |
| `manager` | `SensorManager` —— 持有 `Arc<dyn SensorProvider>` + **独占能量策略** |

**为何 provider「笨」、策略放 manager**：与 radio/telephony 一致——Mock 与未来真后端共享同一套
规则与测试。能量策略（把「本地跑大模型 + 传感器」的功耗压住）：

1. **单次读取永远允许**：一帧 / 一次 fix / 一个 IMU sample 几乎不耗电，AmOS 永不拒绝拉取。
2. **连续采样按能量档门控**：app 以 `acquire_stream(kind, rate_hz)` **声明**一段连续采样意图；
   - 任何档位都先受**硬件上限**约束（`SensorError::TooFast`，如 IMU >1000 Hz）。
   - `SensorMode::PowerSave` 下，超过该族 save 上限（Camera 15 FPS / GNSS 1 Hz / IMU 25 Hz）
     的连续流被拒（`SensorError::PowerSaveRate`）。
3. **Camera 预览同理**：PowerSave 下要求高于 save 上限 FPS 的相机在 `camera_capture` 帧级即拒，
   app 需开低 FPS 预览。

```text
[ apps / System UI ] ── 高层 API：拉帧 / fix / sample / acquire_stream
        │
┌───────▼────────┐
│  SensorManager  │  策略：能量档门控（PowerSave 上限 / 硬件上限）+ 类型化读
│ (Arc<dyn Provider>)│
└───────┬────────┘
        │ 笨读寄存器（单次拉取）
┌───────▼────────┐
│  SensorProvider │  seam：Mock（今天） · Android Camera2/Gnss/SensorManager HAL（未来）
└────────────────┘
```

## 4. 采样上限（`spec.rs` 常量 + `SensorKind::{hw_max_hz, power_save_max_hz}`）

| 族 | 硬件上限 | PowerSave 上限 |
|---|---|---|
| Camera | 240 FPS | 15 FPS |
| GNSS | 10 Hz | 1 Hz |
| IMU | 1000 Hz | 25 Hz |

## 5. 验证

```bash
cargo test -p amos-sensor                      # 34 项单测（spec/provider/manager/error/service/stream）+ 1 项真 UDS e2e（tests/sensor_rpc_e2e.rs）
cargo clippy -p amos-sensor --all-targets -- -D warnings
cargo fmt -p amos-sensor
# daemon 侧（Sensor 挂同一 UDS + Profile 在 get_status）：
cargo test -p amos-ai --test rpc_test sensor_service_mounted_and_profile_exposed
# headless 验收示例（需一个在跑的 daemon socket，如 /tmp/amos-ai.sock）：
cargo run -p amos-ai --example sensor_once -- /tmp/amos-ai.sock
```

## 6. 最新样本流桥 backend（2026-09-04）

Camera/IMU 是**流**不是 getter：Android 把每个新帧/运动样本投递给监听器（`SensorEventListener`、
`ImageReader`），AmOS 按需取最新值。此前 `AndroidSensorProvider` 对二者直接返回"not yet wired"错，
**没有**任何样本落地处。本轮补上 `crates/amos-sensor/src/stream.rs`（非 gated、host 全绿）：

```text
[ Android SensorEventListener / Camera2 ImageReader ]    [ host/dev feeder ]
      onSensorChanged / onImageAvailable                          │
        └──────────►  ImuLatest / FrameLatest  ◄──────────────────┘
                       （线程安全 atomic：生产者 push 最新，读端取最新）
                                  ▲ SensorProvider（LiveSensorProvider）
                                SensorManager（能量门控）
```

- `ImuLatest`：只存最新 `ImuSample`；时间戳乱序（更旧）的 push 被丢弃，读端永不回退。
- `FrameLatest`：按相机存最新 `CameraFrame`；负载长度按 `CameraConfig::frame_len` 校验后才收，
  每相机 `seq` 单调递增。
- `LiveSensorProvider`（`Send + Sync`，实现 `SensorProvider`）：上面缓存的读侧；生产者推入前读
  返回显式 `Provider("no … yet")`（诚实，不伪造）。GNSS 不在其中（Android 走同步 `LocationManager`）。
- `AndroidSensorProvider` 现在**持有**一个 `LiveSensorProvider`：`camera_configs` / `camera_capture`
  / `imu_rate_hz` / `imu_sample` 经它读取；并暴露生产者入口 `set_cameras` / `set_imu_rate_hz` /
  `record_imu` / `record_frame`（+ `imu_store`/`frame_store` 共享给监听线程）。GNSS 保持真同步 JNI。
- **host 装配测试（9 项，`stream::tests`）**：跨线程 push → `SensorManager` 读最新；首样本前诚实错；
  帧负载校验与 `seq` 递增；未配置相机 `CameraNotFound`；PowerSave 门控叠加在 `LiveSensorProvider`
  之上依然生效；`clear`/`clear_samples`（detach 清空防陈旧回读）。

**接线（设备 glue，需真机，属 §7 生产者侧）**：System UI APK 用真 `Context` 注册
`SensorEventListener`（`TYPE_ACCELEROMETER`/`TYPE_GYROSCOPE`，`BODY_SENSORS`）与 `Camera2`
`CameraDevice` 捕获会话 + NV21 `ImageReader`（`CAMERA`），各自监听线程调上面的 `record_*` 把样本
推进同一桥；真机 `set_cameras` 上报 `CameraCharacteristics` 协商出的能力。相机原始帧字节走独立媒体
通道（本服务只给帧元数据+尺寸）。

## 7. 下一步（超出本次）

- **真机流桥（需设备 bring-up，生产者侧 glue）**：把 §6 的 `LiveSensorProvider` 生产者接上
  - IMU → System UI 用真 `Context` 注册 `TYPE_ACCELEROMETER`/`TYPE_GYROSCOPE` `SensorEventListener`，
    在其 `onSensorChanged` 调 `AndroidSensorProvider::record_imu`（`BODY_SENSORS`）。
  - Camera → `Camera2`/`CameraDevice` 捕获会话 + NV21 `ImageReader`，`onImageAvailable` 调
    `record_frame`（权限 `CAMERA`，热点——发热源，纳入功率策略）；`set_cameras` 上报能力。
- **System UI 接线（桌面已通，真机剩 Context 替换）**：`sensor_*` Tauri 命令桥 + 前端 `lib/sensors.ts` +
  设置页**传感器 tile**（`components/SensorPanel.tsx`，桌面 mock daemon 可读能量档/相机/定位/惯性）已落地；
  **真机**：System UI 启动时用真 `Context` 调 `AndroidSensorProvider::new` 构造 `SensorManager`（替换
  mock，需 tauri `android` feature + 权限）。`acquire_stream` 语义 = 一个订阅（PowerSave 拒绝在高耗电时
  再加订阅）。相机**原始帧字节**走独立媒体通道（本服务只给帧元数据 + 尺寸，见 `proto/sensor.proto` 头注释）。
- **模型/功耗联动**：把 `SensorManager` 与 `amos-profiling` 的功耗读数联起来——跑本地 LLM 时自动
  切 `PowerSave` 采样档并记录热/电（见 `docs/profiling.md`）。

## 8. System UI 实时数据流广播（2026-09-09，`sensor-data` 事件）

补上此前「传感器数据向 System UI 的实时 Context 总线广播」的缺口：除了按需快照（拉取），现在 System
UI 的 `SensorHost` 是一个**实时推送源**——凡向共享流桥推入一个被接受的 IMU 样本 / 相机帧、能量档真实
切换或 glue detach 清空样本，都会把一条 `sensor-data` 事件 `emit` 给 WebView（镜像
`telephony-event` / `telemetry-spy-hit` / `clipboard-changed` 的事件语义）。

```text
[ Android glue / WebView record_* / host feeder ]
        │  record_imu / record_frame（进入同一 bus）
        ▼
 LiveSensorProvider（共享流桥）
        │  StreamChange{Imu|Frame|Cleared}  （accept 才触发：陈旧 IMU 与非法帧不广播）
        ▼
 SensorHost（持 Weak→manager，附当前 mode/backend）
        │  SensorNotifier（sensor_host::set_notifier 安装）
        ▼
 Tauri emit("sensor-data", SensorHostEvent)
        ▼
 前端 lib/sensorEvents.ts：subscribeSensorData / toSensorData（防御式）
```

- **领域层（`amos-sensor`）**：`LiveSensorProvider` 新增 Tauri-free 订阅点——`subscribe(Arc<dyn
  Fn(&StreamChange)> + Send + Sync)`，`ImuLatest::record` 改为返回 `bool`（是否 accept）以只在真收到
  更新时通知；`record_frame` 只在校验通过后广播带 `seq` 的最新帧；`clear_samples` 广播 `Cleared`。
  `notify` 先快照订阅者列表、**释放锁后**再调用，杜绝死锁/重入。
- **System UI（`amos-tauri`）**：`SensorHost` 增 `manager: Arc<SensorManager>` + `sink: EventSink`；
  `set_notifier` 安装广播；`wire_bus_observer` 把 `StreamChange` 映射成扁平 `SensorHostEvent`
  （`ts_ms`/`kind`/`backend`/`mode`/`imu`/`frame`/`prev_mode`，`SENSOR_DATA_EVENT="sensor-data"`）。
  相机事件只带**元数据**（id/尺寸/format/seq），原始帧字节永不上 UI 事件总线（留在媒体平面）。
  能量档仅在**真实变化**时广播并带 `prev_mode`。boot 在 `lib.rs::setup()` 用
  `host.set_notifier(handle.emit(SENSOR_DATA_EVENT, …))` 接上 WebView。
- **验证**：`amos-sensor` stream 新增 3 项单测（accept→imu+frame 事件、陈旧/非法 push 不广播、
  clear→Cleared）；`amos-tauri` sensor_host 新增 4 项（live 事件含 mode/backend/元数据、非法/未
  通告帧不广播、mode 仅变化一次带 prev_mode、未装 notifier 时静默 no-op）；前端
  `lib/sensorEvents.ts` + `__tests__/sensorEvents.test.ts`（7 项，事件名/归一化/防御/订阅 no-op）。
  `cargo test -p amos-sensor`（37+1 e2e）、`cargo test -p amos-tauri --lib`（165）、
  `cargo clippy -p amos-sensor/-p amos-tauri --lib -- -D warnings`、fmt、前端 `bun test`+`tsc`、
  `cargo check -p amos-tauri --features android --lib` 全绿。
- **System UI 消费端（本轮）**：新增 `lib/sensorLive.ts`（纯 reducer `applySensorLive` + 订阅式
  `createSensorLive`，`start()` 打开 `sensor-data` listen 并从 `sensor_host_snapshot` 尽力 seed
  能量档/后端；`pushRaw` 走与真实监听同一归一化器）与 `svelte/LiveSensors.svelte`（挂在
  `DiagnosticsPage`，事件驱动刷新：绿色 LIVE 点、IMU/预览帧/清空计数、最近 IMU 样本、最近帧元数据、
  能量档变化实时更新；无数据时显示等待提示而非假样本；重置仅清零本端计数，不动宿主总线）。前端测试：
  `__tests__/sensorLive.test.ts`（7 项，事件驱动刷新/计数/防御/订阅/reset）+ `svelte-tests/
  sensor-live.svelte.test.ts`（1 项 mount 冒烟）。桌面 host 演示：WebView 调
  `sensor_host_record_imu`/`record_frame` 即触发 `sensor-data` → 卡片实时刷新（无需 daemon）。
- **仍剩（真机，本字段外）**：把 §7 的设备侧 producer glue（`SensorEventListener` /
  Camera2 `ImageReader`）真正跑起来并 `arm` 到同一 `bus`——那样真机推入的样本会自动经 §8 广播到
  System UI 的 `LiveSensors` 卡片；桌面/host 已用 `sensor_host_record_*`/测试覆盖同一条推送路径。

## 9. 真机 Rust↔Kotlin 接线（2026-09-09，代码已落地 · 装机验证待跑）

把 §7「System UI 宿主侧接线」从注释级补到代码级，使 Kotlin 生产者能把真实样本真正送进 Rust 总线：

- **arm 共享总线（`amos-tauri/src/lib.rs`，android cfg）**：boot `setup()` 里用
  `android_glue::arm(host.producer())`，把托管 `SensorHost` 的 `LiveSensorProvider` 设为 Kotlin
  `SensorGlue.recordImu`/`CameraGlue.recordFrame` 上行的落点——这样真机样本与 §8 的 `sensor-data`
  实时广播、`LiveSensors` 卡片同一条链路。
- **GNSS 惰性绑定（`amos-tauri/src/sensor_host.rs`，android cfg）**：`android_ctx` 模块存一次由
  Kotlin `SensorGlue.attachContext(context)` 上行给的真实 `AndroidSensorProvider`
  （`LocationManager`）；`SensorHost::read_gnss` 首次读时 `ensure_gnss()` 把它采纳进 `gnss` 字段，
  于是快照反映真实定位（无需显式 boot 时序）。新增 no_mangle
  `Java_com_amos_ai_glue_SensorGlue_attachContext`。
- **相机能力通告（`amos-tauri/src/android_glue.rs` + Kotlin `CameraGlue.kt`）**：`CameraGlue.attach`
  在拿到 CAMERA 后按协商出的 NV21 尺寸调 `advertiseCamera(id,w,h,fps)` → no_mangle
  `Java_com_amos_ai_glue_CameraGlue_advertiseCamera` 把相机写进已 arm 的总线，快照的相机列表因此反映
  真机能力。
- Kotlin 端改动都在 `android-glue/` 模板（`SensorGlue.attachContext`/`CameraGlue.advertiseCamera`，
  均 try/catch 防缺 native 符号崩溃），并已同步拷贝进 `gen/android/app/.../glue/`。
- **验证**：`cargo check/clippy -p amos-tauri --features android --lib -- -D warnings` 与宿主
  `--lib` 全绿、fmt 干净。**仍待（本环境无法稳定跑长任务的真机 APK 构建）**：`cd crates/amos-tauri &&
  cargo tauri android build --apk --debug` 装机启动后，用 adb 观测
  `dumpsys sensorservice`（活跃 IMU 连接）/ `media.camera`（CONNECT device 0）与 `logcat` 里
  `SensorGlue`/`AmosGlue`/`record*` 日志，确认样本真到达总线（runbook 见 docs/android-glue.md）。
