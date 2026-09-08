# 媒体 / 外部存储 — 设备 bring-up 执行清单（真机）

**日期**: 2026-09-08 · **关联**: `docs/android-storage-unify.md`（设计与审计）、`docs/media.md`（Phase A 内核验收）
**目的**: host 上能编译/能测的全部已就绪；本文给出测试机到手后"照着做"的真机步骤与验收点。

> 诚实边界：以下均需 **root / Waydroid 或已授权普通 App** 的 Android 真机；在拿到设备前它们无法在 host 闭环，故不作为"已完成"。

## 0. 现状（host 侧已就绪）
- 领域内核 `crates/amos-media`：spec/provider(MediaProvider)/manager(Grant 权限)/mapping(Android 权限·MIME·路径)/hostfs(裸 read_dir)/android(MediaStore 真后端 `AndroidMediaProvider`) —— **45/46 例测试**。
- `amos-tauri`：`MediaBridge`（`SwitchableProvider` 运行期替换 + `mock/hostfs/attach`）+ 8 条 `media_*` 命令 + `#[cfg(android)] media::android_backend(vm, env, glue)` —— **11 例命令级测试**，`--features android` 编译/测试通过。
- Kotlin 模板 `crates/amos-tauri/android-glue/MediaStoreGlue.kt`（含 `MediaPermissions.request`，list/save/load 桩标注 DEVICE）。
- 权限片段 `android-glue/AndroidManifest.permissions.xml`（READ_MEDIA_* / READ_EXTERNAL_STORAGE / WRITE_EXTERNAL_STORAGE 已声明）。
- 例程 `crates/amos-media/examples/scan_dir.rs`（裸扫 DCIM 出 JSON，交叉编译命令见其头注释）。

## 1. 路径 A：root 测试机先验 `scan_dir`（最快验证裸读通路）
```sh
# 交叉编译（本仓库方式：直连 NDK clang，非 cargo-ndk）
export NDK=~/Library/Android/sdk/ndk/<VER>; PREBUILT=$NDK/toolchains/llvm/prebuilt/darwin-x86_64
LINKER=$(ls $PREBUILT/bin/aarch64-linux-android*-clang | sort -V | tail -n1)
export PATH="$PREBUILT/bin:$PATH" CC_aarch64_linux_android=$LINKER \
       AR_aarch64_linux_android=$PREBUILT/bin/llvm-ar \
       CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$LINKER
cargo build --release --target aarch64-linux-android -p amos-media --example scan_dir
adb push target/aarch64-linux-android/release/examples/scan_dir /data/local/tmp/
adb shell chmod 755 /data/local/tmp/scan_dir
adb shell /data/local/tmp/scan_dir /storage/emulated/0 camera download   # 2>&1 | tail -c 800
```
**✅ 实测（2026-09-08，S5 · SDK 34 · arm64 · 以 `shell` 非 root 运行）**：
扫 `DCIM/Camera` + `Download` 共 **47 项 → 7.68 ms**（< 10ms 目标），JSON 含真实
`uri`(绝对路径)/`size_bytes`/`ts`(mtime)。→ 裸 `read_dir` 通路**验证通过**。
> 说明：这台设备 adb `shell` 对 `/sdcard` 有读权限（ROM 未对该 uid 收严 scoped storage），
> 故无需 root 即可裸读；App 进程路径仍走 MediaStore（见路径 B）。

## 2. 路径 B：System UI（普通 App）走 MediaStore
1. **Kotlin 实装 `MediaStoreGlue`**（✅ 已写好并**编译通过**：`crates/amos-tauri/android-glue/com/amos/ai/glue/MediaStoreGlue.kt`，含 `MediaPermissions` + `listCollection`(query+RELATIVE_PATH 过滤) / `saveCollection`(insert+IS_PENDING) / `loadContent`(openInputStream)）。已并入 gen 并 `./gradlew :app:compileArmDebugKotlin` → BUILD SUCCESSFUL。
2. **attach 接线**（✅ 全链路代码实现并编译通过；**已在真机运行验收**）：`SwitchableProvider` device-first 路由 + Rust `Java_com_amos_ai_glue_MediaStoreGlue_attach`；Kotlin `MediaStoreGlue.attach()` external + `PermissionWire.requestMedia/onResult/ensureAttached`（预授权即 attach）；`MainActivity.kt onStart` 已调 `requestNeeded/requestMedia/ensureAttached` 并转发 `onRequestPermissionsResult`。**manifest**：媒体权限 `READ_MEDIA_*`/`READ_EXTERNAL_STORAGE`/`WRITE_EXTERNAL_STORAGE` 需并入生成 `AndroidManifest.xml`（`android-glue/AndroidManifest.permissions.xml` 为模板，regen 后要重新合并）。**真机实测（2026-09-08, S5）**：授权后 logcat 见 `AmosMediaWire: media backend attached (MediaStore)`，进程存活、无 FATAL——`AndroidMediaProvider` 已装入 `DEVICE`，`media_*` 走真机 MediaStore。**注意**：本设备 CAMERA 授予会让既有 `CameraGlue/Nv21` 的 `amos-camera` 线程崩溃（DirectByteBuffer 访问，与媒体功能无关的既有 bug）——验证媒体时暂撤销 CAMERA 可绕开；该相机崩溃需单列修复。
3. **权限**：设备首次进入按 `MediaPermissions.request` 弹授权；授权回调里再把 attach 走一遍（或先 attach、list 在未授权时返回错误串由 UI 提示）。
4. **构建**：`cargo tauri android dev --features android`（或按仓库 `build-android.sh`）。
**验收点**: 授权后 `media_list camera` 返回真机 DCIM 照片；快门后 `media_save` 写入 `DCIM/Camera` 并出现于系统图库。

## 3. 路径 C：Waydroid/Linux（无需真机、裸读合法）
设环境变量让 System UI 直接吃真实目录：
```sh
AMOS_MEDIA_ROOT=/storage/emulated/0 cargo run -p amos-tauri   # Waydroid 内
# 或桌面指向一个样本目录，用同一 media_* 链端到端：
AMOS_MEDIA_ROOT=$HOME/Downloads/media-sample cargo run -p amos-tauri
```

## 4. 关联测试/门禁（改完跑）
```sh
cargo test -p amos-media
cargo test -p amos-media --features android
cargo check -p amos-tauri --features android      # attach/android_backend 接线
cargo test -p amos-tauri --lib media::
make gated-check                                   # 已含 amos-media --features android
```

## 5. 各路径状态速查
| 路径 | 场景 | host 可测 | 真机需做 | 状态 |
|---|---|---|---|---|
| A | root + ADB 二进制裸扫 DCIM | scan_dir 已 host 跑通(≈215µs 样本) | 交叉编译+ADB+10ms 实测 | ✅ 实测通过（S5 · 47 项 · 7.68ms · shell 非 root）|
| B | 普通 App 走 MediaStore | AndroidMediaProvider 编译/契约 + attach 测试 | Kotlin 并入 gen + gradle 编译 + 授权 + attach | Kotlin 实装就绪（模板）· 待并入/编译/设备 |
| C | Waydroid / 桌面 dev | `AMOS_MEDIA_ROOT`→HostFs 已 host 端到端测试 | 指向真实目录即用 | 已可跑 |
