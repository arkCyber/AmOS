# Amos 移动端 targets 初始化指南（Android / iOS）

AmOS 的 Tauri 壳（`crates/amos-tauri`）已按 `staticlib`/`cdylib` 结构就绪，
但尚未初始化移动平台目录。以下是**在具备 SDK 的机器上**执行的确切命令。

> 本指南无需在无 SDK 的普通开发机上运行；请在有 Android SDK / Xcode 的机器上按序执行。

---

## 0. 前置检查

```bash
# Rust 移动目标
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim

# Tauri CLI（版本需与 Cargo.toml 的 tauri = "2" 一致）
cargo install tauri-cli --version ^2 --locked

# 确认工具链
cargo tauri --version
java -version          # Android 需要 JDK 17+
```

## 1. 初始化 Android

```bash
cd crates/amos-tauri

# 交互式：选择包名（建议 org.amos.mobile）、应用名（Amos）、生成签名
cargo tauri android init

# 生成 Rust 侧 Android 工程与绑定
cargo generate -g tauri-apps/wry -n amos-android  # 仅当 wry 需要手动生成时
```

生成的目录：
```
crates/amos-tauri/gen/android/
crates/amos-tauri/src-tauri/   # 已有
```

## 2. 初始化 iOS

```bash
cd crates/amos-tauri
cargo tauri ios init
```
生成 `crates/amos-tauri/gen/apple/`。

## 3. 构建（Debug / 模拟器）

```bash
# Android —— 需要 ANDROID_HOME / ANDROID_SDK_ROOT 指向 Android SDK
export ANDROID_HOME="$HOME/Library/Android/sdk"     # macOS 默认
cargo tauri android build --debug
# 产物: gen/android/app/build/outputs/apk/debug/

# iOS 模拟器
cargo tauri ios build --debug -- --target aarch64-apple-ios-sim
# 产物: gen/apple/Amos.app
```

## 4. 运行（真机 / 模拟器）

```bash
# Android 模拟器（需先启动 AVD）
cargo tauri android run

# iOS 模拟器
cargo tauri ios run
```

## 5. Release（签名与上架）

```bash
# Android：先在 gen/android 配置 release keystore（tauri.conf.json 的 bundle 段）
cargo tauri android build --release

# iOS：用 Xcode 打开 gen/apple/Amos.xcodeproj 配置签名
cargo tauri ios build --release
```

---

## 关键配置点

| 项 | 位置 | 说明 |
|----|------|------|
| 包名/应用名 | `cargo tauri android/ios init` 交互 | 决定 bundle id |
| 图标 | `crates/amos-tauri/icons/` | 需补齐 Android/iOS 各尺寸 |
| UDS socket 路径 | `amos-proto::socket::default_socket_path()` | Android 已在代码中落到 `/data/local/tmp/amos-ai.sock` |
| 隐私权限 | Android `AndroidManifest.xml` / iOS `Info.plist` | 相机需 `CAMERA` / `NSCameraUsageDescription`；定位需 `ACCESS_FINE_LOCATION` / `NSLocationWhenInUseUsageDescription` |
| 后台 AI 服务 | `deploy/android/amos.rc` | 已提供 init.rc 骨架，需按目标设备接入 |

## 6. 权限（与本轮实做的相机/定位对应）

相机走 WebView `getUserMedia`，iOS 需在 `Info.plist` 加：
```xml
<key>NSCameraUsageDescription</key>
<string>相机用于拍照并保存到相册</string>
```
定位（地图 app）iOS 加：
```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>地图需要您的位置以定位</string>
```

---

## 说明

* 运行上述 `init` 需要真实的 Android SDK / Xcode；当前开发机未安装，故仓库内尚未生成 `gen/android`、`gen/apple` 目录。
* 生成后可用 `make mobile-check` 复核工具链，用 `make mobile-init` 查看本指南。
