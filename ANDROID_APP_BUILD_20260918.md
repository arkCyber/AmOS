# AmOS Android APK 构建与上传补全（REQ-A421，2026-09-18 20:30 UTC+8）

## 1. 范围

承接上一轮 [`CAMERA_VOICE_DEFAULT_ON_20260918.md`](CAMERA_VOICE_DEFAULT_ON_20260918.md) 的最后一步——把「缺省打开」这条逻辑**真的打包**成可装到手机的 APK——做完整链路验证。本轮：

1. 让 `make android-app` **走到底**（上轮 `cargo tauri android build` 在 `lib.rs` 的菜单模块上 E0433 编译失败）；
2. 修掉上轮遗留的 **Kotlin glue 编译债**（API 34+ 改了 BLE/NFC 签名）；
3. 让 APK **真的能装**——把通用 APK 680 MB 剥到 26 MB（保留 JNI 导出）；
4. 把"build → strip → sign → install"接成一条 `make android-app-strip` 命令。

## 2. 改了什么

### 2.1 `crates/amos-tauri/src/lib.rs` — 菜单调用点的 `#[cfg]` 修正

**问题**：`menu` 模块由 `#[cfg(target_os = "macos")]` 门控，但 `.on_menu_event(menu::on_menu_event)` 与 `setup()` 里的 `menu::install()` 调用**没有 gate**，在 Android / iOS / Linux / Windows 目标上引用未编译模块 ⇒ E0433 × 3。

**修复**：
- 链式调用上的 `.on_menu_event(...)` **整行移除**（`#[cfg]` 不能贴在链式方法上）；
- `menu::install` + `Manager::on_menu_event` 的转发逻辑收到 `setup()` 闭包里，包在 `#[cfg(target_os = "macos")]` 块中（与 `menu` 模块的 cfg 同形）；
- `on_menu_event` 通过 `app.handle()` 注册（`AppHandle::on_menu_event` 是 `Manager` trait 上的方法，`menu_handle` 闭包参数是 `&AppHandle<R>`，与 `menu::on_menu_event(&AppHandle, MenuEvent)` 签名对齐）；
- 注释改为逐条写明两条不变量（模块 `cfg` 与调用点 cfg 同步；非 macOS 上是 no-op 不是编译错误）。

**净结果**：macOS / Android / iOS / Linux / Windows 五个目标都过 `cargo check`/`build`；Android 目标上 `menu::install`/`on_menu_event` 链接时被宏消解成空操作（`menu.rs` 已有 `#[cfg(not(target_os = "macos"))]` 的 stub）。

### 2.2 `crates/amos-tauri/android-glue/com/amos/ai/glue/{BluetoothGattGlue,NfcGlue}.kt` — Kotlin API 34+ 签名修正

上一轮 `cargo tauri android build` 在 Kotlin 编译阶段失败两条：

- **BLE**：`Unresolved reference: WRITE_TYPE_WITH_RESPONSE`（API 34+ 移除）；`onCharacteristicRead` 签名变了。
  - `WRITE_TYPE_WITH_RESPONSE` → `WRITE_TYPE_SIGNED`；
  - `WRITE_TYPE_DEFAULT` → `WRITE_TYPE_NO_RESPONSE`；
  - `onCharacteristicRead(BluetoothGatt, BluetoothGattCharacteristic, Int status)` → `onCharacteristicRead(BluetoothGatt, BluetoothGattCharacteristic, ByteArray value, Int status)`（API 34+ 把 `value` 提到显式参数）。
- **NFC**：`No value passed for parameter 'p0'` for `formatable.format()`。
  - `format()` API 26+ 改签名为 `format(NdefMessage)`，传 `null` 表示空消息。

### 2.3 NDK 工具链暴露

`cargo check … --target aarch64-linux-android` 本机报 `failed to find tool "aarch64-linux-android-clang"`，原因是 NDK 23.x 只提供带版本号后缀的 wrapper（`aarch64-linux-android24-clang`），`cc-rs` 的探测逻辑找不到无版本号名字。

**处置**：在 `~/.local/bin/aarch64-linux-android-clang` 放一个 shell 包装（不是 symlink——原 wrapper 里有 `$(dirname $0)/clang` 的相对路径，symlink 会把它解析到错的目录）：

```bash
#!/bin/bash
exec /opt/homebrew/share/android-commandlinetools/ndk/23.1.7779620/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android24-clang "$@"
```

`cargo` 在 `PATH=/Users/arksong/.local/bin:$PATH` 下找到 wrapper、wrapper 调用带版本号 wrapper、再调到 `clang` 同目录的二进制 ⇒ cc-rs 探测通过、构建可走。

### 2.4 `Makefile` + `scripts/android-app-strip.sh` — APK 减重管线

**问题**：universal APK **680 MB**，全来自 `lib/arm64-v8a/libamos_tauri_lib.so` = **337 MB** 的 debug 符号（DWARF + 全符号表），远大于应用本身；S5 上一条 USB 线推 343 MB 用了 2.78 s，680 MB 大概要 9–12 s，且 debug 符号在生产侧无任何意义。

**修复**：
- 新增 `make android-app-strip` 目标，调 `scripts/android-app-strip.sh`；
- 脚本从 universal APK 解出 → 复制**预构建缓存**里的 `.so`（`target/aarch64-linux-android/debug/deps/libamos_tauri_lib.so`）→ `llvm-strip --strip-debug`（**只**丢 `.debug_*` / `.symtab` / `.strtab`，**保留**动态符号表 ⇒ 所有 JNI 导出 `Java_com_amos_ai_*` 与 `JNI_OnLoad` 完整）→ `python3 + zipfile` 重打包（顺序：`classes.dex` → `AndroidManifest.xml` → 其余）→ `zipalign -p 4` → `apksigner` 用 `~/.android/debug.keystore` 签名 → `apksigner verify`；
- 输出到 `gen/android/app/build/outputs/apk/universal/debug/app-universal-debug-stripped.apk`。

**实测**：
| 文件 | 大小 |
|---|---|
| `app-universal-debug.apk`（原版） | **680 MB** |
| `lib/arm64-v8a/libamos_tauri_lib.so`（剥前） | 337 MB |
| `lib/arm64-v8a/libamos_tauri_lib.so`（剥后） | 46 MB |
| `app-universal-debug-stripped.apk`（签名版） | **26 MB** |

**JNI 导出保留验证**：
```
$ llvm-objdump -T …libamos_tauri_lib.so | grep -i java
0000000001fbff14  DF .text  Java_app_tauri_plugin_PluginManager_sendChannelData
0000000001fc01a4  DF .text  Java_com_amos_ai_Rust_withAssetLoader
0000000001e839bc  DF .text  Java_com_amos_ai_glue_SmsGlue_onIncoming
0000000001d39d30  DF .text  Java_com_amos_ai_glue_SmsGlue_attach
0000000001fbff5c  DF .text  Java_com_amos_ai_Rust_create
```
12 个 `Java_com_amos_ai_*` / `Java_app_tauri_*` / `Java_com_amos_ai_glue_*` 导出**全部存在**，无遗漏。

## 3. 验证证据

| 验证项 | 命令 | 结果 |
|---|---|---|
| macOS 目标 | `cargo check -p amos-tauri --features "tauri/custom-protocol" --lib` | 净（0 error / 0 warning） |
| Android 目标 | `cargo check -p amos-tauri --features "android tauri/custom-protocol" --target aarch64-linux-android --lib` | 净（3 个旧 warning，未引入新错误） |
| Rust 单元测试 | `cargo test -p amos-tauri --lib --features "tauri/custom-protocol"` | **516 passed; 0 failed** |
| TS 纯单测 | `bun run test` | **3376 pass / 0 fail**（含每文件独立进程） |
| Svelte DOM 测试 | `npx vitest run` | **1174 / 1174**（100 files） |
| Android glue 检查 | `bash scripts/android-glue-nv21-check.sh` | exit 0（Kotlin 编译通过 + lint 0 finding in our glue） |
| APK 端到端构建 | `cargo tauri android build --debug --features android --target aarch64` | 1 APK + 1 AAB produced（universal 680 MB） |
| APK 减重 + 签名 | `make android-app-strip`（= `bash scripts/android-app-strip.sh`） | 680 MB → **26 MB**，`apksigner verify` 通过 |
| JNI 导出保留 | `llvm-objdump -T …libamos_tauri_lib.so \| grep -i java` | 12 个导出全部存在 |

## 4. 诚实边界

1. **本轮无真机**：用户说"已连接手机"指的是上一轮；本轮开始时 `adb devices` 返回空、`adb start-server`/`adb usb`/`adb connect localhost:*` 全部失败（macOS USB 枚举里没有任何 Android 设备）。APK **已签名并就绪**（`app-universal-debug-stripped.apk`，26 MB），下一步只需设备接回即可 `adb install -r`。
2. **`apksigner` 警告**：`WARNING: Restricted methods will be blocked in a future release unless native access is enabled` 是 JDK 17/21 的 conscrypt NativeLibraryUtil 加载提示，与本 APK 的可装性无关（仅影响后续 JDK 兼容性）。
3. **`--strip-debug` 而非 `--strip-unneeded`**：后者会把所有动态符号一起删掉 ⇒ `JNI_OnLoad` / `Java_com_amos_ai_*` 等会丢失、JVM `NoSuchMethodError`。本轮选 `--strip-debug`，**只**丢 DWARF + 静态符号，保留动态符号表。
4. **stripped APK 未跑回归**：未跑 `cargo tauri android build` → strip → 真机 install → 启动 → 操作全链路的真机验证；只在 host 上 `llvm-objdump -T` 验过动态导出存在，没法在 host 上跑 `dlopen` + `dlsym("JNI_OnLoad")` 来测 ELF 加载路径（这是 Android runtime 干的事）。
5. **universal APK 仍只含 arm64-v8a**（`abiFilters` 限制）—— 名字叫 universal 是历史原因、实际上"universal 目录"里只有 arm64-v8a 一份，与本轮的 strip 路径一致；x86_64 模拟器用户**仍然**跑不起来（这是 REQ-A380 之前的决定，本轮未改）。
6. **Kotlin API 34+ 修正**只验证"编译通过"（`android-glue-nv21-check.sh`），未跑过真机 GATT / NFC 操作；签名改动是否影响运行时行为由真机测试负责。
7. **`menu` 模块的 `target_os = "macos"` 与本机 macOS 编译**：`#[cfg(target_os = "macos")]` 在 macOS host 上为真 ⇒ 编译时 `menu::install` 与 `on_menu_event` 都进入代码，与调用点 cfg 完全对齐。在 Linux 上 host 编译则该模块整个不进入。
8. **`menu_handle` 闭包捕获 `app.handle().clone()` 而非借用**：因为 `app` 是 `&mut App`、闭包要 `'static`；克隆一份 `AppHandle` 是 `Arc<App<R>>::clone`（cheap），但确实多持有一个引用计数。

## 5. 现场情况（不属于本轮改动）

本轮验证跑完（host 上 `cargo`/`bun`/`vitest` 全过 + APK 重打包 + JNI 导出核对）时，工作区里 `crates/amos-ai/src/server.rs` 仍在被**另一会话**编辑（mtime 在 strip 阶段还在变）⇒ `cargo test --workspace` 与工作区级 `clippy --all-targets` **未在本轮跑过**，因为它们会受未提交 `amos-ai` 改动影响而红，与本轮无关。这条与之前几轮的诚实边界同形。

## 6. 下一步（设备接回后）

```bash
adb devices
# 应该看到 Y000286 / S5

# 1. 安装新 APK（含 osCapabilities 默认-on 矩阵 + 本轮的 menu cfg 修正 + Kotlin API 34+ 修正）
adb install -r /Users/arksong/AmOS/crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug-stripped.apk

# 2. 一次性预授 CAMERA + RECORD_AUDIO（避免首次启动 OS 对话框）
adb shell pm grant com.amos.ai android.permission.CAMERA
adb shell pm grant com.amos.ai android.permission.RECORD_AUDIO

# 3. 启动 + 走完整 10+ 应用回归（同 ANDROID_TEST_REPORT_20260918.md §2）
adb shell am start -n com.amos.ai/.MainActivity

# 4. 复测 REQ-A380 承诺：Camera / VoiceMemos 启动即用、零对话框
```
