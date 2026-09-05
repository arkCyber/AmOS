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

## 诚实边界（本机不可端到端验证）

- **Rust 半侧已 host 验证**：`cargo check -p amos-tauri --features android`、`cargo clippy
  --features android --lib -- -D warnings`、以及 `android_glue` 的 2 项纯逻辑单测全绿。
- **Kotlin 半侧结构性交付**：本机无 Android SDK/模拟器/真机，无法编译或跑通；须先 `tauri
  android init` 生成工程，把 `android-glue/` 拷入 `gen/android/app/src/main/java/com/amos/ai/`，
  在真机上验证权限、线程、`JNI` 上送签名与 `tauri.conf.json` 的 `identifier`（`com.amos.ai`）一致。
- JNI 方法名由包/类推导：`com.amos.ai.glue.SensorGlue` → `Java_com_amos_ai_glue_SensorGlue_*`，
  `CameraGlue` → `..._CameraGlue_*`。若改名须同步 `android_glue.rs`。
