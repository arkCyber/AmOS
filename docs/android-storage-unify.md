# AmOS 对接「标准安卓文件目录」— 架构审计与补码清单（MediaStore / 外部存储统一）

**日期**: 2026-09-08 · **范围**: System UI 全栈（Rust 后端 seam + Tauri 命令层 + Android Kotlin glue / 权限 + Svelte/TS 前端）
**状态**: 📋 设计评审稿 → ✅ Phase A（`crates/amos-media` 领域内核）、Phase B（`amos-tauri` `media_*` 命令层 + TS `lib/media.ts` 桥 + `AMOS_MEDIA_ROOT`→HostFs 运行时选择）、Phase D-核心（`lib/photoLibrary.ts` 合并模型）、Phase C-host（`load` seam）、Phase C-prep（`mapping` + manifest）、Phase C-device 骨架（`AndroidMediaProvider` + Kotlin `MediaStoreGlue.kt` + REQ_MEDIA）、Phase E 装置（`HostFsProvider` + `scan_dir`）以及**设备 boot 接线（`SwitchableProvider` 运行期替换 + `attach(android_backend)`，`--features android` 编译验证）**已落地（2026-09-08）；真机接线（Kotlin `ContentResolver` 实装 + 设备层调用 `android_backend`+`attach` + 授权/10ms 实测）、Phase D 渲染（PhotosApp/FilesApp mount）、Phase E 真机 bring-up 未实现。
本文件仍是**审计与补码清单**（不含已落地上线的完整实现）。

> 一句话结论：**AmOS 目前并【没有】与安卓真机的文件目录树（`/sdcard`、`/storage/emulated/0`、
> `DCIM/`、`Pictures/`、`Download/`）统一**。Files / Photos / Camera / 语音备忘录都是"应用内
> 虚拟存储"，彼此不打通、也不读真机媒体。真正的统一应走 **MediaStore / SAF（系统标准资源）**，
> 而不是前端裸扫 `/storage/emulated/0/DCIM`（受 Android 10+ **分区存储 / scoped storage** 限制，
> 见 §2）。本文给出沿用仓库既有 "Provider seam + `android`-gated JNI" 惯例的目标架构与逐步清单。

---

## 1. 你方需求（问题重述）

> "希望对接标准的安卓文件目录，充分使用安卓的标准资源，帮助审计与补全代码。"

目标能力（对标真实安卓用户可见存储）：

1. **Photos（相册）** 能列出真机所有原生照片/视频（相机所拍 `DCIM/Camera/`、截屏 `Pictures/Screenshots/`），而非只显示 `amos.photos` 里的渐变假图块与 WebView 拍的帧。
2. **Files（文件）** 能浏览真实 `/storage/emulated/0/` 根下的 `Download/`、`Pictures/` 等，而不仅是 `amos.files` 虚拟树。
3. **Camera 快门 / 语音备忘录 / 备忘录导出** 产生的内容，能写进用户可见的 `DCIM` / `Recordings` / `Download` 并进入系统图库/媒体索引，被其它应用看到。
4. **自建商店下载的 APK** 若能落到 `Download/` 并触发系统扫描，可复用户标准安装流程。

## 2. 关键技术背景与一次纠偏（先对齐认知）

### 2.1 标准目录布局（你对的部分）

对应用层，Linux 底层用户可见"手机存储根目录"虚拟路径恒为 `/sdcard`（符号链接）→
`/storage/emulated/0`。其下官方目录：

| 目录 | 用途 |
|---|---|
| `DCIM/Camera/` | 系统相机照片 / 视频（Digital Camera Images） |
| `Pictures/Screenshots/` | 截屏 / 录屏 / 三方应用图片 |
| `Pictures/WeiXin/` 等 | 三方应用（微信/浏览器）存图 |
| `Download/` | 浏览器/PDF/APK 默认落点 |
| `Recordings/` | 语音备忘录/录音（Android 10+ 独立集合） |
| `Movies/` / `Music/` | 视频 / 音频集合 |

### 2.2 纠偏：`std::fs::read_dir("/storage/emulated/0/DCIM")` 在真机上**并不成立** ⚠️

"Rust 后端用 `std::fs::read_dir` 扫 `DCIM/Camera/` 即可瞬间抓全原生照片、无需 SDK" —— 这在
**root / 系统签名 / Waydroid(Linux 容器)** 场景成立，但对**普通三方应用（Android 10 / API 29 及以后）**
不成立：

- Android 10（API 29）起启用 **scoped storage / 分区存储**：对 `DCIM`、`Pictures`、`Download`
  等共享集合，普通应用**没有 `read_dir` 原始路径的权限**，裸读返回 `EACCES` / 空。
- 官方正路是 **MediaStore**（`ContentResolver.query(Images/Video/Audio.Media.EXTERNAL_CONTENT_URI)`，
  得到 `content://` URI，需声明 `READ_MEDIA_*` 权限并运行时请求）或 **SAF**
  （`ACTION_OPEN_DOCUMENT` / `ACTION_OPEN_DOCUMENT_TREE`，得到用户授予的 `content://` 树）。
- 写入共享集合：API 29+ **无需存储权限**即可用自己的 `MediaStore` insert 贡献到图库/下载；
  API ≤28 才需 `WRITE_EXTERNAL_STORAGE`。

**架构推论**：真正的统一应当是一个 **`MediaProvider` seam（Mock ↔ Android MediaStore 真后端）**，
真后端在 Kotlin glue 里用 `ContentResolver` 查询再经 JNI 回来 —— 这与你仓库 `amos-sensor` /
`amos-radio` / `amos-power` 的 "Provider seam + Mock + `android`-gated JNI" 惯例完全同构，
而不是在前端裸扫绝对路径。AmOS 若未来以 **系统组件 / root / Waydroid** 形态部署，才可选一条
`HostFsProvider`（直接 `read_dir`）通道；两条通道共存于同一 trait 下，由部署形态决定后端。

## 3. 现状审计（改动前 —— 每项都给到文件位置）

### 3.1 Photos / Camera —— 前端虚拟 store，无"列原生媒体"

- `frontend-ts/src/lib/photos.ts`：`Photo` 对象持久化在 **`amos.photos`** 共享 store key。
  种子/渐变图是 `{emoji, a, b}` 假图块；真拍照是 `newCapturePhoto` 把一帧 JPEG 以
  **base64 data-URL** 直接塞进 `data` 字段（base64 约 +33% 膨胀，全部驻内存/store）。
- `frontend-ts/src/svelte/PhotosApp.svelte`、`CameraApp.svelte`：`writeStoreValue(PHOTOS_KEY, ...)`。
- **没有任何** "列出真机相册/原生媒体" 的 Rust 命令；`amos-tauri/src/lib.rs` 的 `invoke_handler`
  里没有 `media_*` 面。

### 3.2 Files —— 虚拟树，非真实目录

- `frontend-ts/src/lib/files.ts`：`FEntry { id, type, name, parent, content }` 扁平虚拟树，
  全部持久化在 **`amos.files`**；文件内容只是 `content` 字符串，可自建文件夹 —— 与真实
  `Download/` / `Pictures/` 完全无关。

### 3.3 二进制媒体 —— IndexedDB，不落盘

- `frontend-ts/src/lib/mediaStore.ts`：语音备忘录等 Blob 走 IndexedDB（测试用内存降级），
  不进入安卓 `Recordings/`；元数据存 `amos.vmemos`。

### 3.4 Rust 侧唯一的真实写盘 —— 备忘录导出（离目标最近的一处）

- `amos-tauri/src/note_export.rs`（命令 `notes_export_txt`）：唯一直接 `fs::write` 的命令，
  但目标目录是 `$AMOS_EXPORT_DIR`（未设时 `<tmp>/amos-exports`）——**应用私有/临时目录**，
  并非用户可见 `Download/`。CHANGELOG 诚实边界明确写：调起系统分享面板(SAF/`ACTION_SEND`)
  需真机 Kotlin glue 把 `AMOS_EXPORT_DIR` 指到外部可见目录并接 JNI 下行，**本机只做到落盘 + 回退剪贴板**。

### 3.5 权限清单 —— 缺媒体读权限

- `crates/amos-tauri/android-glue/AndroidManifest.permissions.xml`（模板，合并进
  `gen/android/.../AndroidManifest.xml`）：只有 CAMERA / RECORD_AUDIO / MODIFY_AUDIO_SETTINGS /
  INTERNET / ACCESS_NETWORK_STATE / CALL_PHONE。**没有 `READ_MEDIA_*`（API 33）/ `READ_EXTERNAL_STORAGE`（API ≤32）**，
  也没有运行时请求这些权限的 `MainActivity.Wiring.kt` 分支（其现有 `REQ_CAMERA` 流程可照抄）。


### 3.6 现有可复用的"硬接线"资产（不是缺口，是地基）

| 资产 | 位置 | 说明 |
|---|---|---|
| Provider seam + Mock 惯例 | `crates/amos-sensor/src/provider.rs`、`radio`、`power`、`audio` | trait（哑读）+ 确定性 Mock，策略放 Manager |
| `android`-gated 真后端 | `crates/amos-sensor/src/android.rs`（`AndroidSensorProvider`）| `cargo check -p amos-sensor --features android` 可编译 |
| Rust↔Kotlin glue upcall | `amos-tauri/src/android_glue.rs`（`Java_..._SensorGlue_*`）、`clipboard_glue.rs` | 收/发 JNI，`#[no_mangle]` 符号与 `.kt` 对齐 |
| Kotlin glue 模板 | `crates/amos-tauri/android-glue/`（SensorGlue.kt / CameraGlue.kt / AmosGlue.kt 等）| 复写进 `gen/android`，包 `com.amos.ai.glue` |
| 运行时权限模板 | `gen/android/app/src/main/java/com/amos/ai/glue/MainActivity.Wiring.kt` | `requestNeeded`/`onResult`，现只做 CAMERA，可加媒体 |
| WebView 已用 MediaStore 的钩子 | `gen/android/.../generated/RustWebChromeClient.kt`（`MediaStore.ACTION_IMAGE_CAPTURE`）| 佐证 MediaStore 通路可用 |
| Tauri 命令注册点 | `crates/amos-tauri/src/lib.rs` `invoke_handler`（~line 100–235）| 新 `media_*` 命令在此追加，`android` feature 门控 |

## 4. 目标架构（沿用仓库惯例的 `MediaProvider` seam）

```text
 [ Svelte: PhotosApp / FilesApp / StoreApp / 语音备忘录 ]
        │ 纯逻辑 lib（normalize / diff / 收藏合并，离线可测）
        ▼
 [ Tauri 命令层 amos-tauri/src/media.rs ]   media_list_images / media_list_files /
        ▲  (注册进 lib.rs invoke_handler)      media_open / media_save_to_gallery …
        │ MediaManager（策略：缓存、合并 amos.* store、权限档位、API 版本适配）
┌───────┴────────┐
│ MediaProvider   │  seam —— 笨读寄存器（列目录/集合、读字节/URI、写回集合）
│  · MockMediaProvider（今天，确定性种子图/文件）
│  · AndroidMediaProvider（feature android：JNI 下行查 MediaStore / 存 MediaStore）
│  · HostFsProvider（可选：root/Waydroid 形态，read_dir /storage/emulated/0）
└────────────────┘
        │ JNI upcall/downcall
 [ Kotlin glue：MediaStoreGlue.kt ]  ContentResolver.query(Images/Video/Audio/Downloads)
                                       + MediaScannerConnection / MediaStore insert
```

设计要点（对齐仓库铁律）：

- **Provider 是"哑读寄存器"**，策略全在 `MediaManager`：API 版本（33 用 `READ_MEDIA_*`，≤32
  用 `READ_EXTERNAL_STORAGE`）、权限未授予时的诚实降级（返回 `Provider(Unauthorized)` 而非空列表）、
  真机集合与 `amos.*` 虚拟层（收藏/本地新建）的合并规则。
- **Android 后端宿主的 ContentResolver 拿不到 Rust 侧** → 查/写必须在 Kotlin `MediaStoreGlue.kt`
  里做，Rust 侧是 `#[no_mangle]` JNI（收 `content://` 列表 / 字节）+ `ManagedState`
  （bridge 对象下行调用），形状完全照抄 `clipboard_glue.rs` / `android_glue.rs`。
- **本地/CI 全程绿**：默认构建只含 `MockMediaProvider`；`--features android` 编译验证 JNI 接线；
  真机行为按仓库惯例标"诚实边界：需真机验收"，不假装。
- **返回的是 `content://` URI / 展示元数据，不是把整张图 base64 拉进 store** —— 修正 §3.1 的
  膨胀问题。缩略图走 MediaStore 的 `ThumbnailUtils`（Kotlin 侧）或流式按需加载。


## 5. 缺口清单（Gap · 每一项都给了落点与建议签名）

| # | 缺口 | 落点 | 建议形状 |
|---|---|---|---|
| G1 | 无"列原生媒体"后端 | 新建 `crates/amos-media`（或 `amos-tauri/src/media.rs`） | `MediaProvider` trait：`list_images(filter) -> Vec<MediaItem>`、`list_files(dir) -> Vec<MediaItem>`、`load_thumbnail(uri)`、`save_to_collection(bytes, kind, name)`；`MockMediaProvider` 确定性种子 |
| G2 | 无 API 版本/权限策略 | 同上 `media/manager.rs` | `MediaManager { provider: Arc<dyn MediaProvider>, app_photos: store }`：判定 READ_MEDIA_* vs READ_EXTERNAL_STORAGE、未授权诚实报错 |
| G3 | 无 `media_*` Tauri 命令 | `crates/amos-tauri/src/lib.rs` `invoke_handler` | `media_list_images`、`media_list_files`、`media_save_to_gallery` 等（`serde` 负载，仿 `telephony` 桥）；Android 后端 `cfg(feature="android")` 门控 |
| G4 | 无权限声明 | `crates/amos-tauri/android-glue/AndroidManifest.permissions.xml` + 生成清单 | API 33+：`READ_MEDIA_IMAGES/VIDEO/AUDIO`；API ≤32：`READ_EXTERNAL_STORAGE`（可选 `maxSdkVersion="32"`）；写集合 API≤28：`WRITE_EXTERNAL_STORAGE` |
| G5 | 无运行时权限请求分支 | `gen/android/.../glue/MainActivity.Wiring.kt` | 仿 `REQ_CAMERA` 增加 `REQ_MEDIA` 分支，授权后回填 `MediaStoreGlue`/通知 Rust |
| G6 | 无 Kotlin MediaStore 查询/写入 glue | `crates/amos-tauri/android-glue/MediaStoreGlue.kt`（模板）+ 复写进 `gen/android` | `queryImages(…)/queryFiles(…)/saveToGallery(bytes,…)/scanFile`；`external fun` 与 Rust `#[no_mangle]` 对齐 |
| G7 | Photos 不消费原生媒体 | `frontend-ts/src/lib/photos.ts` + `PhotosApp.svelte` | 增加"真机相册"数据源（经 backend 桥），与 `amos.photos` 本地收藏层按 G1 manager 合并；保留离线 Mock |
| G8 | Files 不浏览真实目录 | `frontend-ts/src/lib/files.ts` + `FilesApp.svelte` | "根"可选为 `/storage/emulated/0`（下载/图片等）；经 backend 桥列集合，本地新建仍落 `amos.files` |
| G9 | Camera 快门不写 DCIM | Camera 捕获链 + G6 | 快门额外 `media_save_to_gallery` 写 `DCIM/Camera` 并触发媒体扫描（WebView 流仍先落 `amos.photos`） |
| G10 | 语音备忘录不写 Recordings | `lib/mediaStore.ts`/vmemos + G6 | 新增可选"存入系统录音" |
| G11 | 备忘录导出不落 Download | `crates/amos-tauri/src/note_export.rs` | `$AMOS_EXPORT_DIR` 真机默认指外部可见（Kotlin 侧取得 `Download/`/`context` 并设 env / JNI 下行），或接 SAF `ACTION_SEND` 分享 |
| G12 | 自建商店 APK 不落 Download | `amos-appstore` 落点 + G6 | 可选：下载字节经 Kotlin 写 `Download/` + `MediaScannerConnection`（交由安装器/系统识别） |

## 6. 分阶段落地清单（Roadmap · 每阶段结束都应可独立验证）

> 每阶段都遵循：**默认构建离线全绿 + `--features android` 可编译 + 真机行为标"诚实边界需真机验收"**。
> 阶段 A–C 纯 Rust/Tauri（host 可测），阶段 D 前端，阶段 E 真机 bring-up。

- **Phase A — 领域内核 `crates/amos-media`（纯 std，离线可测）**
  - `spec`：`MediaKind`（Image/Video/Audio/File/Download）、`MediaItem`（`content://` URI / display name / mime / 相对路径 / ts / bytes-hint）、`CollectionId`。
  - `error`：`MediaError`（`Unauthorized` / `NotFound` / `Provider` / `InvalidArguments`）。
  - `provider`：`MediaProvider` seam + 确定性 `MockMediaProvider`（种子照片/文件，供测试/CI/demo）。
  - `manager`：`MediaManager`——持有 `Arc<dyn MediaProvider>` + API 版本/权限档位策略 + 与 `amos.*` 收藏层的合并。
  - 单测覆盖 Mock 列/空态/权限降级/合并。**验收**：`cargo test -p amos-media` 绿。

- **Phase B — Tauri 命令层 + host 装配**
  - `amos-tauri/src/media.rs` 命令（`media_list_images` / `media_list_files` / `media_save_to_gallery`…），在 `lib.rs` `invoke_handler` 注册并 `.manage(MediaManager)`。
  - 默认装配 Mock；前端即可在桌面/mock daemon 走通命令。**验收**：`cargo test`（桥单测）+ `cargo check --features android` 编译绿。

- **Phase C — Android MediaStore 真后端 + Kotlin glue + 权限**
  - `amos-media/src/android.rs` `AndroidMediaProvider`（JNI 下行调 bridge），feature `android` 门控。
  - `android-glue/MediaStoreGlue.kt`（模板）→ 复写进 `gen/android`；`ContentResolver.query`（Images/Video/Audio/Downloads）+ `MediaStore` insert + `MediaScannerConnection`；`external fun` 与 Rust `#[no_mangle]` 对齐。
  - 权限：`AndroidManifest.permissions.xml` 加 §G4 声明；`MainActivity.Wiring.kt` 加 `REQ_MEDIA` 运行时分支。
  - **验收**：`cargo check --features android` 绿；**诚实边界**：真机行为（列表/权限弹窗/落图库）需真机 + `tauri android` 验收。

- **Phase D — 前端消费真实媒体（Svelte/TS）**
  - `lib/photos.ts`/`FilesApp`/`CameraApp`/vmemos/store 接 Phase B 桥；真机集合与本地层合并；离线仍有 Mock 回退。
  - **验收**：`tsc clean`、`svelte-check 0/0`、vitest、`bun [bun-iso] OK`、`vite build`；新 DOM/纯逻辑用例补齐。

- **Phase E — 真机 bring-up 与端到端验收**
  - 设备上验证：授权后相册列出原生 DCIM 照片、快门/录音/导出写入用户可见目录并可被系统图库看到、商店 APK 落 Download。
  - **诚实边界**：把各"只能真机验证"的项逐条在 CHANGELOG 注明，避免误声称。


## 7. 权限矩阵速查（写代码时照这张表）

| 目标操作 | API ≤28 (Android 9-) | API 29-32 (10–12L) | API 33+ (13+) |
|---|---|---|---|
| 读共享媒体（列相册/下载） | `READ_EXTERNAL_STORAGE`（运行时） | `READ_EXTERNAL_STORAGE`（运行时；`requestLegacyExternalStorage` 可选） | `READ_MEDIA_IMAGES/VIDEO/AUDIO`（运行时，分集合） |
| 写自己产生的共享媒体 | `WRITE_EXTERNAL_STORAGE` | MediaStore insert（无需权限） | MediaStore insert（无需权限） |
| 任意目录树浏览 | `WRITE/READ` + 完整路径 | SAF `ACTION_OPEN_DOCUMENT_TREE` | SAF `ACTION_OPEN_DOCUMENT_TREE` |
| 系统级裸 `read_dir /sdcard` | 需相应权限 | root / 系统签名 / `MANAGE_EXTERNAL_STORAGE` | root / 系统签名 / `MANAGE_EXTERNAL_STORAGE` |

> AmOS 以 System UI（普通 APK 权限）形态 → 走 MediaStore/SAF；以系统组件 / Waydroid 形态 → 才走
> `HostFsProvider` 裸 `read_dir`。两条都包在 `MediaProvider` trait 后，`MediaManager` 只管策略。

## 8. 诚实边界（本设计与既有工程红线对齐）

- **Rust 拿不到 `ContentResolver`**：任何 MediaStore 查询/写都必须经 Kotlin glue，Rust 侧只做
  seam + JNI。这不是漏码，是平台架构约束（§3.6/§4 已落实地）。
- **scoped storage 下裸 `read_dir` 不成立**（普通 APK）——§2.2 已纠偏；真需要再开 `HostFsProvider`。
- **每阶段真机项必须标"需真机验收"**，绝不静默降级到 mock（沿用 `amos-audio`/`note_export`
  的诚实降级先例）。
- 仓库 `#![deny(clippy::unwrap_used / expect_used / panic)]`（生产）：新代码不得在这些位置
  unwrap/expect/panic；JNI 回调错误要显式处理或 no-op，不崩溃（沿用 `android_glue.rs` 安全注释）。

## 9. 建议的下一步（最小但完整的第一个 PR）

按仓库"小步、可独立验收"的风格，第一个 PR 建议 = **Phase A（`crates/amos-media` 领域内核，
纯 std + Mock + 单测）**。它：不碰真机、不碰权限、纯 host 全绿，直接复用 `amos-sensor` 的
crate 形态；Phase B–E 只是给它接线。落地后从 `Makefile` / `scripts/` 补一条 gated-check 挂进
`make gated-check`，并在 `CHANGELOG.md` 记一条"诚实边界"条目，即可闭环。

