# System UI 装配点：设备传感器 host + 常驻 mic（命令入口，2026-09-04）

真机 no-UI Android 基座里，传感器 HAL（Camera2/`SensorManager`）与麦克风硬件都只能由
**System UI APK（持 `Context`）**访问，headless `amos-ai` daemon 摸不到。本文是“System UI
装配点”的 **Rust 侧落地**：受管状态 + Tauri 命令入口，host 可编译/可测。Kotlin/NDK 生产者
glue（把真机事件推进来）是下一步（见末节）。

## 1. 传感器 host：`crates/amos-tauri/src/sensor_host.rs`

受管 `SensorHost`（`.manage(SensorHost::new())`）= 一个 `amos_sensor::LiveSensorProvider`
流桥 + `SensorManager` 能量策略。生产者（设备 glue / host/dev）把每帧/每样本推进来，读端取最新，
受能量档门控。**与 daemon 无关**——它正是 docs/sensors.md 想要的“System UI 深度绑定”读侧。

- 方法（Tauri-free，host 可单测）：`set_cameras` / `record_imu_values(accel,gyro,temp)` /
  `record_imu(sample)` / `record_frame_bytes(id,w,h,fmt,fps,bytes)`（负载按 `CameraConfig::frame_len`
  校验）/ `set_mode` / `mode` / `snapshot` / `acquire_gate(kind,hz)`。
- **命令入口**：
  - `sensor_host_snapshot` → `{backend,mode,cameras,gnss,imu,stream_gate}`
  - `sensor_host_set_mode(mode)`
  - `sensor_host_record_imu(accel:[f64;3], gyro:[f64;3], temperature_c)`（host/dev/glue-harness）
  - `sensor_host_record_frame(camera_id,width,height,format,fps,bytes)`
  - `sensor_host_acquire(kind,hz)`（能量门控预检，无副作用）
- **Android 绑真 Context**：`#[cfg(feature="android")] SensorHost::bind_android(vm,env,context)`
  用真 `JavaVM`+`Context` 构造 `amos_sensor::AndroidSensorProvider`，其同步 `LocationManager`
  GNSS 读进 snapshot 的 `gnss`；相机/IMU 仍由 glue 推同一流桥。仿 `radio::from_android`。

## 2. 常驻 mic：`assistant_voice.rs` 内 `DeviceMic` + `device_mic_*`

受管 `DeviceMic`（`.manage(DeviceMic::new())`）持有正在跑的常驻听麦 worker
（`ResidentVoiceHandle`）。`open_platform_mic()` 用 Option-A 的
`amos_audio::PlatformMic::open_device()`：Android 开真 AAudio（或 TinyALSA）；host 无原生麦 →
**明确报错**（不伪造）。

- **命令入口**：
  - `device_mic_start(session_id?)` → 开真麦 → 开 daemon `Chat` → 起常驻采集线程（尾静音切句 +
    `AudioEnd`），返回 backend 标签（`aaudio`/`tinyalsa`）。
  - `device_mic_stop` → cancel daemon 流 + join 采集线程。
  - `device_mic_status` → `{running,backend,submitted}`。

## 3. 验证

```bash
cargo test -p amos-tauri --lib              # 61 passed（原 54；+4 sensor_host +3 device_mic）
cargo check -p amos-tauri --features android
cargo clippy -p amos-tauri --lib --features android -- -D warnings   # 绿
cargo fmt -p amos-tauri -- --check          # clean
```

## 4. 下一步（Kotlin/NDK glue，真机）

读侧/命令入口已就绪；缺的是**生产者 glue**（无法在无真机时端到端验证）：
- IMU：System UI APK 注册 `SensorEventListener`（`TYPE_ACCELEROMETER`/`TYPE_GYROSCOPE`，
  `BODY_SENSORS`），`onSensorChanged` → 推进 `SensorHost`/`AndroidSensorProvider.record_imu`。
- Camera：`Camera2` `CameraDevice` + NV21 `ImageReader`，`onImageAvailable` → `record_frame`；
  `set_cameras` 上报 `CameraCharacteristics` 能力（`CAMERA` 权限）。
- 常驻 mic：把真 `Context` 的权限流程接到 `device_mic_start`（真机 AAudio 已由 `PlatformMic`
  就绪）。
- 引导时：System UI 启动用真 `Context` 调 `SensorHost::bind_android` + `radio::from_android`
  （替换 mock）。
