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

> **2026-09-16（REQ-A294）"未采集" ≠ `0.00`**：本节的链路里，快照路径（`imu_payload`）与实时路径
> （`toSensorData`）都曾把**没有上报**的轴/温度映射成 `0.0`（Rust `unwrap_or(0.0)`、TS `?? 0`），
> 而两个面板会把这些字段格式化显示 ⇒ 屏幕上的 `0.00` 是一个**设备从未测过的测量值**（且是最误导的
> 那个：读起来像"设备完全静止"），直接违反 `AEROSPACE_SOFTWARE_AUDIT` **P0-3**（"遥测不伪造：未采集
> 必须上报 `None`"）。现在这条链上"未知"是**一等事实**：
>
> * **Rust 快照**（`sensors.rs`）：`SensorImu` 的六个轴 + `temp_c` 是 `Option<f64>/Option<f32>`；
>   proto 的 `accel_m_s2`/`gyro_rad_s` 为 `None` ⇒ 对应轴为 `None`（**不再** `unwrap_or(0.0)`）。
> * **TS 归一化**（`lib/sensors.ts`）：`normalizeSnapshot` 逐字段归一 `imu`/`gnss`（此前是**原样透传**）
>   —— 非有限值/字符串/布尔一律 `null`，未知保持未知；顺带修掉"部分载荷打崩面板"：`SensorPanel`
>   会调 `temp_c.toFixed(1)` / `latitude_deg.toFixed(5)`，而透传的 `undefined` 会在渲染期 **抛 TypeError**
>   （负控实测：注入回透传 ⇒ `Cannot read properties of undefined (reading 'toFixed')`）。
> * **TS 实时**（`lib/sensorEvents.ts`）：`toImu` 不再 `?? 0`，`SensorImuDatum` 的轴/温度为 `number | null`。
> * **UI**：`LiveSensors` 与 `SensorPanel` 对未知显示 `—`（该字面量是这两个面板既有的"缺失"记号）；
>   GNSS 只要坐标缺失就整体显示 `—`，不把"测到的"和"没测到的"拼成一句话。
> * **守护**：`sensors.test.ts`（部分块 + 畸形值）、`sensorEvents.test.ts`（缺失/NaN/字符串轴）、
>   `sensor-live.svelte.test.ts`（未知轴渲染 `—` 且**不出现** `0.00`）、`settings-pages-uncovered`
>   （部分快照 ⇒ 面板照常渲染并显示 `—`）、`sensors::tests`（三组独立缺失 + 全家缺失）。

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

## 10. 诚实边界（Gap 3，未接线的部分绝不伪造）

- **未装机 = 未验证 ⇒ 无数据时 `sensor_snapshot` 返回 `None` / `Provider`，绝不返回编造的帧**：真机生产者（Kotlin `SensorEventListener` / Camera2 `ImageReader`）的代码**已落地**（§9）且可编译，但**从未在真机跑过**，因此不得据本字段宣称"相机/IMU 已接通"。另有一条**已注册、但没有任何生产者**的旧缝：`crates/amos-sensor/src/sim.rs` 的 `native_on_camera` / `native_on_imu`（Kotlin `SensorGlue.nativeOnCamera`/`nativeOnImu` 上呼的 Rust 半）由 `sensor_host.rs` 的 `no_mangle` 蹦床**注册**，但 Kotlin 从不调用这两个 external（活路径走 `SensorGlue.recordImu` / `CameraGlue.recordFrame`，见 §9），故一律返回类型化 `SensorError::Provider`——不产出帧、不产出样本。`sensor_host.rs` 侧同样：没有样本就 `snapshot().imu == None`，不填假样本。
- **JNI 两半"编译已验证、设备未验证"**：Kotlin 生产者 + Rust 蹦床的名字契约与载荷上限（16 MiB）是**编译期**可见并由主机单测钉住的；`SensorGlue.attachContext` / `CameraGlue.advertiseCamera` / `recordImu` / `recordVitals` / `recordFrame` 只在真机 APK 上才会真正运行。**未装机 = 未验证**，不得据此宣称"相机/IMU 已接通"。
- **`sim.rs` 是主机确定性模拟器，不是设备测量**：它按 `t_ms`/`phase` 生成棋盘格与正弦运动，用于在无设备时覆盖整条活读路径（帧校验、每相机 `seq` 单调、陈旧 IMU 丢弃、能量门控、`SensorHost` 扇出）；生命体征经 `SimHarness::push_vitals` 走同一总线（`SimHarness` 无生成器——`Option` 字段由调用方直接给，见 §12）。它产出的帧**由测试 harness 产生**，永不被当成设备读数（见 sim.rs 模块头）。
- **GNSS 是唯一例外**：`AndroidSensorProvider` 的 GNSS 走同步 `LocationManager#getLastKnownLocation`，不在上述流桥内。

## 11. 生命体征（步数 ∕ 心率）与「健康」屏（2026-09-25，REQ-A1454）

在 §6/§8 的同一流桥上新增第四族读数，供 System UI 的「健康」屏使用。走的是**流总线 + 宿主**而非
`SensorProvider` trait —— `SensorHost::snapshot()` 读的是 `LiveSensorProvider` 总线，不是 trait 的拉取缝。

- **领域层（`amos-sensor`）**：`spec.rs` 新增 `VitalsSample { timestamp_ms: u64, steps_total: Option<f64>,
  heart_rate_bpm: Option<f64> }` 与 `SensorKind::Vitals`；`steps_total` 是**自开机累计**计数
  （Android `TYPE_STEP_COUNTER` 语义），**不是**当日步数。`stream.rs` 新增 `VitalsLatest` 存储 ∕
  `StreamChange::Vitals` ∕ `record_vitals` ∕ `vitals_store`，并纳入 `clear_samples`。
- **宿主（`amos-tauri`）**：`sensor_host.rs` 的 `HostVitals`（`Option<f64>` 字段）挂在
  `SensorHostSnapshot.vitals`（`#[serde(default)]`）与 `SensorHostEvent` 上，新增 `record_vitals` 与命令
  `sensor_host_record_vitals`；真机样本经 §8 的同一通道广播成 `sensor-data` 事件的 `vitals` 块
  （`lib/sensorEvents.ts` 的 `"vitals"` 种类 + `lib/sensors.ts` 的 `vitals` 快照归一化）。
- **JNI 两侧**：`SensorGlue.recordVitals(tsMs: Long, stepsTotal: Float, hrBpm: Float)` ↔
  `Java_com_amos_ai_glue_SensorGlue_recordVitals(env, _cls, jlong, jfloat, jfloat)`；注册
  `TYPE_STEP_COUNTER` + `TYPE_HEART_RATE`；`SENSOR_STATUS_NO_CONTACT` 传 `Float.NaN` ⇒ `None`。权限
  `ACTIVITY_RECOGNITION`（API 29+，步数计数必需）与 `BODY_SENSORS`（API 31+），两者均以
  `<uses-feature required="false">` 声明并已登记 `android-permission-scan`。
- **前端纯逻辑（`lib/health.ts`）**：`stepDelta(prev, next)`（`next < prev` ⇒ 重启 ∕ 归零 ⇒ 重设基线、
  增量为 `0`）、`dayKey` ∕ `applyVitalsTick`（含午夜换日时关掉当天并重设基线）、`normalizeHeartRate`
  （拒绝非有限值与 `[25,250]` 外的值 ⇒ `null`）、`stepCalories`（无用户体重 ⇒ `null`）。
  `svelte/HealthApp.svelte` 拉 `sensorSnapshot().vitals` 并订阅 `sensor-data`。
- **持久化拆分**：`amos.health.history`（日历史 + 锻炼 = 用户内容）在 `lib/cloud.ts` 的 `SYNC_STORES`；
  `amos.health.counter`（原始自开机基线）在 `scripts/store-allowlist.json` 记作 `device-state`
  —— 过期还原会让下一次增量算错。
- **诚实规则同 §8 的 REQ-A294**：缺失读数端到端是 `Option` ∕ `null`，屏幕印 `—`，**绝不** `0`。
  这条规则**也覆盖聚合值**（REQ-A1476）：`recentDays` 的 `RecentDay.recorded` 是 `null` 与 `0` 的判别位
  —— 没有这一天行的日子画 2px 空槽而不是 0 长的柱，`weekRecorded === 0` 时页头印 `health.noReading`
  而不是把伪造的 0 合计成「本周共 N 步」（**向后兼容**：`steps` 对未观测日仍是 `0`）。
- **每帧的提交序（REQ-A1475）**：`HealthApp` 只在 `persistHealthTick(next)` **成功**后才把 `history` 与
  `counter` 一起前移。`persistHealthTick` 先写 counter 再写 history，其 retry 契约只保证 **under-count**，
  因此失败时必须保留**旧**基线，下一个样本才会重算这一帧丢掉的增量 —— 保留旧基线是这个契约的前提。
- **验证**：`cargo test -p amos-sensor --lib`（50 ∕ 0）；`cargo test -p amos-tauri --lib sensor_host::`
  （17 ∕ 0）；`bun test src/lib/__tests__/health.test.ts`（22 例）；`svelte-tests/health-tick-refusal.svelte.test.ts`
  与 `svelte-tests/health-week-unknown.svelte.test.ts`。
- **仍待（真机，本字段外）**：真实累计计数与它的重启归零、心率的有无接触语义、`(JFF)V` JNI 签名在运行时
  的解析、权限弹窗与 Android 编译均**未验证**；本机只钉住了与设备无关的 `stepDelta` ∕ 分桶纯逻辑。

## 12. 生命体征流的两处诚实缺口（2026-09-25，REQ-A1500 ∕ F-SEN-005）

对 §11 这一族做读代码审计时发现的**两处互补**缺陷（都在纯 Rust 侧、可离线证伪），以及一处过期的
文档断言与一条死缝：

- **缺陷（读入侧，`VitalsLatest::record`）**：`spec.rs` 的 `VitalsSample::has_reading` 规定
  「两个字段都为 `None` 的样本不值得存储 ∕ 播报」，但**没有任何生产调用者**——`record` 照存照播。
  症状：宿主快照的 `vitals` 块在**没有任何读数**时也变成 `Some(HostVitals{None,None})`（契约说该块
  在首个读数前保持缺席），并向 WebView 播出一条空的 `sensor-data`「vitals」事件。
  修复：`record` 拒绝「无读数且无可撤回」的样本；**例外是撤回**——手里握着读数时，无读数样本正是
  「传感器失去接触」的表示，必须存下并播报，否则界面永远画着上一个 bpm。
- **缺陷（JNI 缝，`android_glue::push_vitals`）**：该函数在 `steps` 与 `hr` 都为 `None` 时**提前返回**，
  把撤回样本在到达存储前丢掉。在「有心率、无计步器」（`ACTIVITY_RECOGNITION` 未授予）的设备上，
  心率失去接触正是 `(NaN, NaN)`——于是 `VitalsLatest` 那条撤回契约永远不会触发，界面停在最后一个 bpm。
  修复：缝只负责解码，**是否值得存**交给存储判定（`record_vitals_into` 不再提前返回）。
- **两处负控（各自单点钉住）**：撤掉存储侧守卫 ⇒ 只有 `vitals_latest_ignores_a_reading_less_sample_with_nothing_to_retract` 变红；
  在缝上恢复提前返回 ⇒ 只有 `android_glue::tests::a_lost_heart_rate_reaches_the_store_and_retracts` 变红。
- **补全（主机 harness）**：`SimHarness` 早于生命体征（Sep 20 vs §11 的 Sep 25），其模块头自称覆盖
  「整条活读路径」却不含第四族。新增 `push_vitals` + `vitals_announced` ∕ `vitals_ignored` 计数；
  「是否播报」**读存储自己的 `recorded` 计数**而不是在 harness 里再抄一遍物化规则（第二份规则会漂移）。
  无合成生成器：`Option` 字段的缺席语义应由调用方直接给出。
- **文档订正**：§10 曾称 `native_on_camera` ∕ `native_on_imu` 上呼的 Rust 半**未注册**、真机生产者
  「仍是桩」——与 §9（代码已落地）自相矛盾。实情是：蹦床**已注册**，但**没有生产者**接上去（Kotlin
  从不调用 `nativeOnImu` ∕ `nativeOnCamera`，活路径是 `recordImu` ∕ `recordFrame`），且**未装机 = 未验证**。
  这是「记录与现实不符、且无人失败」的老形状；本轮只订正措辞，**未删除**该旧缝（删它要动未编译的
  Kotlin 模板与本模块的 `no_mangle` 名字契约，属真机决定）。
- **验证**：`cargo test -p amos-sensor`（52 lib + 7 集成 + 1 doctest）；`cargo test -p amos-tauri
  --features android --lib android_glue::`（8）；`cargo clippy -p amos-sensor --all-targets -- -D warnings`
  与 fmt 干净。

## 13. IMU 采样率的「尚未协商」不得冒充测量值（2026-09-25，REQ-A1612 ∕ F-SH-821）

读 `sensor_snapshot` 这条桥（`crates/amos-tauri/src/sensors.rs`）做审计时发现：**同一个结构体的
八个字段里，七个遵循「缺席即未知」，第八个（采样率）把线上的「未知」折叠成了测量值 `0 Hz`**，
而 §10 早就写下了不许编造读数的规则。

- **缺陷**：`SensorImu::rate_hz` 是裸 `u32`，`imu_payload` 逐字 `rate_hz: i.rate_hz,`。proto 的
  `uint32 rate_hz = 5;` **没有字段存在性**，所以「尚未协商」在线上就是 `0`；而生产者的词汇自己
  定义 `0` = 尚未协商（`stream.rs` 的 `LiveSensorProvider`、「`0` = not negotiated yet」；
  `android.rs` 的 `AndroidSensorProvider::imu_rate_hz`、「the domain core treats 0 as unknown」；
  `MIN_SENSOR_RATE_HZ` 的注释「Zero is not a meaningful "off"」）。于是 IMU 监听器尚未协商速率时，
  诊断页的传感器卡印出「惯性 @0 Hz」——一个设备从未测到的采样率。
- **为什么没被门禁看见**：这里折叠发生在**纯 normalizer 的一个字段**上，`read-fold-scan` 的清单
  按**可空包装函数的形态**枚举（`export async function` 返回 `invoke` 直出），`write-scan` 只看存储
  写入判决；没有一条扫描比较「同一结构体的兄弟字段是否遵循同一条缺席规则」。还有一条**同谋**：
  `sensors.test.ts` 里一条题为「unknown, not a plausible zero」的例把折叠**当成契约**钉住
  （`expect(s.imu!.rate_hz).toBe(0)`），它的三个兄弟断言却都是 `toBeNull()`。
- **修复**：`SensorImu::rate_hz: Option<u32>`，payload 逐字 `(i.rate_hz != 0).then_some(i.rate_hz)`；
  TS 接口 `rate_hz: number | null`，normalizer 逐字 `imu.rate_hz === 0 ? null : optNum(imu.rate_hz)`
  （**两半都改**：Rust 端让新守护进程不再发 `0`，TS 端让旧守护进程发的 `0` 也不冒充速率）；
  `SensorPanel.svelte` 渲染改用 `sample(snap.imu.rate_hz, 0)`，与同面板的 `gnssLabel` ∕ `camLabel`
  同一个「未读即 `—`」的惯用法。
- **判据（为什么 `0` 读作未知不丢真实读数）**：`0` 在本域**从不**是合法的已协商速率 —— 生产者、
  `MIN_SENSOR_RATE_HZ`、proto 三处同词都把 `0` 定义为「尚未协商」。七个兄弟字段
  （`accel_*` ∕ `gyro_*` ∕ `temp_c`）与 `MIN_SENSOR_RATE_HZ` 一字未动。
- **验证**：`cargo test -p amos-tauri --lib sensors`（10 ∕ 10，新例
  `an_unnegotiated_imu_rate_is_unknown_not_zero_hz`）；`bun test src/__tests__/sensors.test.ts`
  （7 ∕ 7）；`npx vitest run svelte-tests/settings-pages-uncovered.svelte.test.ts`（16 ∕ 16，
  新例断言 `rate_hz: 0` 的快照印 `@— Hz` 而**绝不**印 `@0 Hz`）。三条负控各自恰 1 red，
  `cp` 快照 + `shasum -a 256` 逐字节还原。

## 14. GNSS 的「未报告精度」与「未数过的卫星数」不得冒充测量值（2026-09-25，REQ-A1623 ∕ F-SH-825）

读同一条 `sensor_snapshot` 桥的 GNSS 半边（`crates/amos-tauri/src/sensors.rs`）时发现：**有真实
坐标的 fix 一行印出「±0m · 0sats」** —— 一个接收机从未声称过的亚米级精度，和一个它从未数过的
卫星数。这正是 §13 那条规则的**卫星孪生**，只是这次落在同结构体的另外两个字段上。

- **缺陷**：`SensorGnss::accuracy_m` 是裸 `f64`、`sats` 是裸 `u32`，`gnss_payload` 逐字
  `accuracy_m: g.accuracy_m, sats: g.sats_in_view,`。proto 的 `double accuracy_m` ∕ `uint32
  sats_in_view` **都无字段存在性**，所以「未报告」在线上就是 `0`；而生产者的词汇自己定义 `0`
  = 未报告 —— `amos-sensor/src/android.rs` 逐字「`Location` carries no satellite count … 0 is
  honest \"not reported\", not a claim of zero sats」（且逐字 `satellites_in_view: 0`），
  `service.rs` 的 no-fix 分支逐字 `accuracy_m: 0.0, sats_in_view: 0`，Android 的
  `Location.getAccuracy()` 对没有精度估计的 fix 回 `0.0`。于是**仅仅「有 fix」**时渲染的
  `gnssFixLabel` 两道 `!== null` 门恒真，印出「31.23000, 121.47000 · ±0m · 0sats」。
- **判据（为什么 `0` 读作未知不丢真实读数，两处兄弟）**：①**同一结构体**的兄弟字段
  `SensorImu::rate_hz` 刚按同一条规则改成 `Option<u32>`（§13，REQ-A1612）；②**前端一个字段
  之外** `frontend-ts/src/lib/gps.ts::accuracyLabel` 逐字
  `if (!Number.isFinite(m) || m <= 0) return "—";`，其文档逐字称这是**卫星计数一个字段之外**
  已经遵守的同一条规则 —— 那句在诊断页这条线上此前**不成立**。`0` 在本域**从不**是合法读数。
- **为什么没被门禁看见**：`read-fold-scan` 的清单按**可空包装函数的形态**枚举（`export async
  function` 返回 `invoke` 直出），而这里折叠在 **Rust 载荷的两个字段 + TS 纯 normalizer 的两个
  字段**上；`write-scan` 只看存储写入判决；没有一条扫描比较「同一事件的兄弟面是否遵循同一条
  缺席规则」。
- **修复（真实实现，两半都改）**：`SensorGnss::accuracy_m: Option<f64>` ∕ `sats: Option<u32>`，
  payload 逐字 `(g.accuracy_m != 0.0).then_some(g.accuracy_m)` ∕
  `(g.sats_in_view != 0).then_some(g.sats_in_view)`；TS 接口两字段改 `number | null`，
  normalizer 逐字 `g.accuracy_m === 0 ? null : optNum(g.accuracy_m)` ∕
  `g.sats === 0 ? null : optNum(g.sats)`。`SensorPanel.svelte::gnssFixLabel` **一字未改** —— 它
  的 `!== null` 门本来就对，只是从未收到过 `null`（与 §13 的 IMU 不同，那次渲染半也承重）。
- **边界**：本轮只改 `SensorGnss`（`sensor_snapshot` → 诊断页）这条线；**姊妹结构**
  `sensor_host.rs::HostGnss`（`sensor_host_snapshot` → `gps.ts`）的
  `accuracy_m: fix.map(..).unwrap_or(0.0)` **一字未动** —— 它是另一个结构体、另一条路径
  （`GnssStatus` 无 `sats` 字段，消费者须读 `status`），已按 `<= 0` 如实门禁，与本轮是不同两面。
- **验证**：`cargo test -p amos-tauri --lib sensors`（**11 ∕ 11**，新例
  `an_unreported_accuracy_and_satellite_count_are_unknown_not_0m_and_0sats`）；`bun test
  src/__tests__/sensors.test.ts`（**8 ∕ 8**）；`bunx vitest run
  svelte-tests/settings-pages-uncovered.svelte.test.ts svelte-tests/sensor-live.svelte.test.ts`
  （**26 ∕ 26**，新例断言有 fix 的快照印坐标而**绝不**印 `±0m` ∕ `0sats`）。三条负控各自恰
  1 ∕ 2 ∕ 2 red（`cp` 快照 + `shasum -a 256` 逐字节还原）。**工作树为并发共享**：本轮的**后继**
  （`REQ-A1624 ∕ F-SH-826`，同日）随后在同一批前端文件上作业（`lib/sensors.ts` 新增
  `gnssAccuracyLabel`、`SensorPanel.svelte` 改用之，并在 `sensors.test.ts` 加 2 例 ⇒ 现值 10 ∕ 10），
  故上文计数为**本轮的时点值**；本轮交付时点 `crates/amos-tauri/src/sensors.rs` 的 sha256 =
  `574068327a380b51d64128c03bfe5f73201e2fd79882ad9107001c638009c53a`（本轮只动该文件）。

## 15. 折叠了零哨兵之后，定线的格式器不得把真实的次米精度印回 `±0m`（2026-09-25，REQ-A1624 ∕ F-SH-826）

§14 把 GNSS 两条零哨兵线的线上 `0` 折成未知，并断言 `SensorPanel.svelte::gnssFixLabel` 一字未改也
照样对（「它的 `!== null` 门本来就对，只是从未收到过 `null`」）。再读一遍这条渲染路径会发现：
**那半只对了一半** —— 门是对的，取整不是。

- **缺陷**：折叠去掉的是哨兵的**值**，不是格式器的取整。`gnssFixLabel` 仍逐字
  `if (acc !== null) parts.push(\`±${acc.toFixed(0)}m\`);`，而 `acc` 此刻是 `null` 或一个**真正的**
  读数（normalizer 已折过 `0`）。`(0.4).toFixed(0)` 得 `"0"` —— 一次 **0.4 m 的真实高精度定位**照样
  印出「31.23000, 121.47000 · ±0m · 9sats」：§14 要终结的「完美精度」串又回来了，且这一次连哨兵都
  不是。一个负 ∕ 非有限的 `accuracy`（`optNum` 只保证有限、不保证非负）则印成 `±-1m`。§14 的渲染例
  逐字 `expect(text).not.toContain("±0m")`，但它**只喂哨兵 `0`**，对「`0.4` ⇒ `±0m`」这条路径是盲的。
- **判据（同一字段的兄弟格式器）**：`lib/gps.ts::accuracyLabel` 逐字
  `if (!Number.isFinite(m) || m <= 0) return "—"; if (m <= 5) return "±5 m"; …` —— 它把正精度
  **分档**、`m <= 0` 回 `—`，任何正数都不会舍成 `0`。这正是 §14 逐字点名要照做的兄弟（「前端
  `gps.ts::accuracyLabel` 早就把同一个 `0` 渲染成 `—`」）。
- **为什么没被门禁看见**：`read-fold-scan` 的清单按**可空包装函数的形态**枚举（折叠永远不在格式器
  里）；`write-scan` 只看存储写入判决；§14 的负控只喂哨兵 `0`；没有一条扫描比较「同一字段的格式器
  是否与它的分档兄弟遵循同一条缺席 ∕ 取整规则」。
- **修复**：把精度子句抽成纯函数 `lib/sensors.ts::gnssAccuracyLabel(acc: number | null): string | null`，
  逐字 `if (acc === null || !Number.isFinite(acc) || acc <= 0) return null;
  return \`±${Math.max(1, Math.round(acc))}m\`;` —— `≤ 0` ∕ 非有限是哨兵与非法值，子句**丢弃**（与一个
  缺席字段被丢弃进同一规则）；正精度用 `Math.max(1, Math.round(acc))` **向上**取整、绝不落到 `0`
  （`±1m` 对一个 0.4 m 的 fix 仍成立，是保守方向）。`gnssFixLabel` 逐字改为
  `const accLabel = gnssAccuracyLabel(acc); if (accLabel) parts.push(accLabel);`。
- **验证**：`bun test src/__tests__/sensors.test.ts`（**10 ∕ 10**，新 `describe` 2 条，含正控
  `4.2 ⇒ "±4m"` ∕ `12.6 ⇒ "±13m"` ∕ `5 ⇒ "±5m"` —— 「永远回 ±1m」会挂在这三条上）；
  `bunx vitest run svelte-tests/sensor-panel-gnss-accuracy.svelte.test.ts`（**3 ∕ 3**，DOM 级：`0.4`
  不含 `±0m` 且含 `±1m`，`-1` 不含 `±-1m`，正控 `4.2` 仍含 `±4m`）；相关 svelte 套件 **26 ∕ 26**；
  `npx svelte-check --fail-on-warnings --output machine` **1511 FILES 0 ∕ 0**；`npx tsc --noEmit`
  rc=0。两条负控各恰 **2 red** ∕ **1 red**，`cp` 快照 + `shasum -a 256` 逐字节还原。
- **如实边界**：①无真机 ∕ 浏览器复核，证据是纯函数单测 + happy-dom 假桥；②本轮只改诊断页
  `SensorPanel` 这条线的**格式器** —— 姊妹 `LiveSensors.svelte` 走 `gps.ts::accuracyLabel`（本就分档，
  不受影响）；③`±1m` 是向上取整的**保守**陈述而非精确值；④`SensorGnss` 接口、Rust ∕ proto ∕
  normalizer 一字未动。

## 16. IMU 的模温不得伪造：缺席是一个事实，`25.0` 不是（2026-09-25，REQ-A1796 ∕ F-SEN-006）

- **缺陷**：`crates/amos-tauri/android-glue/com/amos/ai/glue/SensorGlue.kt` 修前逐字
  `private val DEFAULT_DIE_TEMP_C = 25.0f`，`TYPE_ACCELEROMETER` 与 `TYPE_GYROSCOPE` **两个**
  `recordImu(...)` 调用点都传它。胶水只读这两类传感器，Android 在两者背后**没有**模温传感器 ——
  诚实的值是「没有读数」。`0 °C` 一看就假，`25.0 °C` 却完全像室温读数：面板上那个数**没人测过**，
  排障时无法区分「这台设备没有该传感器」与「温度真的就是室温」。
- **缝的第二重错**：`crates/amos-tauri/src/android_glue.rs::finite_sample` 修前把模温也纳入
  整条样本的有限性校验，于是即便胶水改送 `NaN`，「没有模温源」也会因**整条样本被拒**而连带丢掉
  加速度 ∕ 陀螺这两条**本身即完整测量**的轴 —— 一个**可选**字段不配把关它的兄弟。
- **孪生面（同一文件、约 30 行之外）**：`android_glue.rs::reading(v, valid)` 的文档逐字
  「The Kotlin glue sends `Float.NaN` for 'this value is not available' … A `NaN` therefore means
  **absent**, and must become `None` — never `0`」—— 生命体征那两个标量正是这么做的，
  `crates/amos-sensor/src/spec.rs::VitalsSample` 用 `Option<f64>` 建模缺席并逐字写着
  「`None` is a distinct fact from `0`」。规则实现了一处、没施于兄弟。
- **消费面早已诚实**：`frontend-ts/src/lib/sensors.ts` ∕ `sensorEvents.ts` ∕ `svelte/SensorPanel.svelte`
  ∕ `svelte/LiveSensors.svelte` 都已是 `number | null` 并画 `—` —— 折的只有**生产者**这一半。
- **修复（真实实现，非桩）**：`ImuSample::temperature_c: Option<f32>`（`new(…, Option<f32>)`）；
  `SensorGlue.kt` 改送 `NO_DIE_TEMP_C = Float.NaN`；缝拆成 `finite_accel`（只校验加速度向量）、
  `decode_gyro`（三轴全 `NaN` = 「无陀螺仪」哨兵 → `None`）与 `die_temp_c`（`NaN` → `None`），
  `decode_imu` 只在加速度被毒 ∕ 陀螺三轴既非全有限又非全 `NaN` 时拒整条；`amos-sensor/src/service.rs`
  的纯 `imu_reply` 对 `None` 写本消息族既有的**零哨兵**（`rate_hz` ∕ GNSS 的 `accuracy_m` ∕
  `sats_in_view` 同一约定），`amos-tauri/src/sensors.rs::imu_payload` 把线上 `0` 读回 `None`
  （**未知**，绝不画成测量的 `0 °C`）；`sensor_host.rs::HostImu::temperature_c: Option<f32>`。
- **同族的兄弟字段（REQ-A1872 / F-SEN-008）**：模温修好之后，**陀螺仪三条轴**仍是同一个折
  —— `ImuSample::gyro_rad_s` 修前是裸 `Vec3`（缺席不可表达），而 `SensorGlue.kt` 的加速度分
  支把陀螺六个槽位硬写成 `0f, 0f, 0f`，于是**没有陀螺仪**的机型（实机 K-Touch S5，
  `dumpsys sensorservice` 逐字 `geomag fusion (no gyro)`）每一条加速度样本都带上「没有在旋转」
  这个**测量**。修法：`gyro_rad_s: Option<Vec3>`；胶水改为与加速度分支镜像地回放
  「最近一次陀螺读数」（`lastGyroX/Y/Z` 初值 `Float.NaN`，无陀螺传感器则永远是哨兵）；
  Tauri 宿主侧的 `HostImu::gyro_x/y/z: Option<f64>`。前端的 `sensors.ts` ∕ `sensorEvents.ts`
  **早已**是 `number | null` 并画 `—` —— 折的只有生产者这一半，消费面一直等着一个它拿不到的缺席。
- **源码钉**：`sensor_host.rs::tests::the_glue_reports_an_absent_die_temperature_as_nan_not_a_plausible_number`
  用 `include_str!` 读 `SensorGlue.kt`，断言声明行含 `Float.NaN`、`DEFAULT_DIE_TEMP_C` 不得存在、
  两个 `recordImu` 调用点都传哨兵 —— 占位符不得回流。
- **验证**：`cargo test -p amos-sensor` ⇒ **53 ∕ 53**；`cargo test -p amos-tauri --features android --lib
  android_glue:: sensor_host:: sensors::` ⇒ 全绿。**负控 ×6，逐条指名、互不相交**（`cp` 快照 +
  `shasum -a 256` 逐字节还原）：①拆掉 `die_temp_c` 的 `is_finite` 闸；②让 `decode_imu` 因非有限温度
  拒整条；③`sensors.rs` 折回 `Some(i.temperature_c)`；④`service.rs` 改 `unwrap_or(25.0)`；
  ⑤`From<ImuSample> for HostImu` 折 `or(Some(25.0))`；⑥`SensorGlue.kt` 把 `Float.NaN` 改回 `25.0f`
  —— 每一条**恰 1 红**，且落在不同的一条用例上。`make android-glue-check` 编译 Kotlin 半边
  （编译 + `-Werror` + Lint，0 finding）。
- **如实边界**：①**真机未复核** —— 本环境只能经 `make android-glue-check` 验证 Kotlin 半边；②
  `cargo test -p amos-tauri`（不带 `--features android`）在本工作区被**并轮**未提交的半迁移挡住，
  本轮在 `/tmp` 的隔离源码副本（仅中和那两文件）中跑通，副本不进任何提交。

## 相关文档

- [`android-glue.md`](./android-glue.md) —— Kotlin ↔ Rust 名字契约与真机 runbook。
- [`AEROSPACE_SOFTWARE_AUDIT.md`](./AEROSPACE_SOFTWARE_AUDIT.md) —— §5 P2-3（诚实 seam 登记）。
