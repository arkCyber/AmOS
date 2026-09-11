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

## 相机帧 plane buffer 的 `buffer is inaccessible`：根因与修复（2026-09-11）

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
  `make android-glue-check`（= `scripts/android-glue-nv21-check.sh`：同步到 `gen/` 后跑
  `:app:compileArmDebugKotlin` + `:app:testArmDebugUnitTest`）。钉住：
  NV21 的 **V 先 U 后** 交织、I420 紧凑布局、semi-planar U/V 共缓冲（V 从共享 buffer +1 起）、
  luma 行填充被跳过、**短窗口零填而不抛**、奇数/非正几何返回 `null`。
- **编译**：`./gradlew :app:compileArmDebugKotlin`（JDK 17）通过。
- **诚实边界**：单测覆盖的是 stride/边界数学；**“native 内存已释放”的那条竞态无法在宿主复现**，只能
  真机验收（下节）。

### 设备验收步骤（真机；未在本环境执行）

1. `adb logcat -s AmosGlue`：授权 `CAMERA` 后不再出现 `frame encode dropped: ... buffer is
   inaccessible`。
2. 反复 `HOME` → 回前台（多次触发 `onStart`）：无 FATAL；`droppedFrameCount()` 不持续增长；
   `dumpsys media.camera | grep -i client` 只有一个 AmOS 客户端连接。
3. 读侧能取到帧：`LiveSensorProvider` 最新帧 `seq` 递增（`docs/sensors.md` §8 的 `sensor-data`）。
