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
- ⏳ **真机流桥 + 接线**：把 `AndroidSensorProvider`（GNSS 已就绪）的相机帧 / IMU 采样桥补上，
  并在 System UI 启动时以真 `Context` 构造 `SensorManager`（替换 mock）——需设备 bring-up。
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
cargo test -p amos-sensor                      # 25 项单测（spec/provider/manager/error/service）+ 1 项真 UDS e2e（tests/sensor_rpc_e2e.rs）
cargo clippy -p amos-sensor --all-targets -- -D warnings
cargo fmt -p amos-sensor
# daemon 侧（Sensor 挂同一 UDS + Profile 在 get_status）：
cargo test -p amos-ai --test rpc_test sensor_service_mounted_and_profile_exposed
# headless 验收示例（需一个在跑的 daemon socket，如 /tmp/amos-ai.sock）：
cargo run -p amos-ai --example sensor_once -- /tmp/amos-ai.sock
```

## 6. 下一步（超出本次）

- **真机流桥（需设备 bring-up）**：`AndroidSensorProvider` 的 GNSS 已就绪；把相机帧与 IMU 采样桥补上
  - Camera → `Camera2`/`CameraDevice` 捕获会话 + NV21 `ImageReader`（权限 `CAMERA`，热点——发热源，纳入功率策略）。
  - IMU → `SensorManager` 注册 `TYPE_ACCELEROMETER`/`TYPE_GYROSCOPE` `SensorEventListener`，把最新
    样本缓存进 atomic，`imu_sample` 读缓存（`BODY_SENSORS`）。
- **System UI 接线（桌面已通，真机剩 Context 替换）**：`sensor_*` Tauri 命令桥 + 前端 `lib/sensors.ts` +
  设置页**传感器 tile**（`components/SensorPanel.tsx`，桌面 mock daemon 可读能量档/相机/定位/惯性）已落地；
  **真机**：System UI 启动时用真 `Context` 调 `AndroidSensorProvider::new` 构造 `SensorManager`（替换
  mock，需 tauri `android` feature + 权限）。`acquire_stream` 语义 = 一个订阅（PowerSave 拒绝在高耗电时
  再加订阅）。相机**原始帧字节**走独立媒体通道（本服务只给帧元数据 + 尺寸，见 `proto/sensor.proto` 头注释）。
- **模型/功耗联动**：把 `SensorManager` 与 `amos-profiling` 的功耗读数联起来——跑本地 LLM 时自动
  切 `PowerSave` 采样档并记录热/电（见 `docs/profiling.md`）。
