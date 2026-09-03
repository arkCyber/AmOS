# Amos 应用商店（App Store）

**Amos App Store** 是 Amos「软件下载与生态」的**领域核心**：定义「一个可安装的第三方应用」是什么、目录与安装包长什么样、版本如何演进、下载到的东西如何被证明没被篡改。

当前交付的是**纯 Rust 领域内核 crate**（`crates/amos-appstore`），不含 UI / CLI / Tauri 桥接——先把**契约**和**下载→校验→安装**的包管理核心钉死，再逐层接壳。这正是仓库一贯的拆分方式（参考 `amos-mail` / `amos-int` / `amos-tts`）。

> 状态：**领域内核 + Tauri 桥接 + CLI + HTTP 后端 + 发布签名 + 动态注册表已实现**（2026-09-03）。Rust 侧：离线领域内核 + provider seam + mock + 测试；`HttpStoreProvider`（`live` 门控）拉真实 HTTP 目录 + 下载包；Ed25519 **发布签名**（`DeveloperKey` 签名 manifest、引擎安装前验签）。已通过 `amos-tauri/src/appstore.rs`（managed `StoreBridge` + `appstore_*` 命令）与前端 `store*` typed 桥接暴露给 WebView；另有 `amos-appstore-cli` 在终端驱动同一引擎。系统 UI 已含「应用商店」应用页（目录/安装/卸载/升级），且**已装第三方应用会作为 tile 动态并入主屏**（`store:<id>`，点击打开占位容器）。剩余：installer（真实运行宿主）见文末[路线图](#路线图)。

---

## 1. 为什么需要它

今天 Amos 系统内的「应用」是**编译期写死**的内置 React 组件（`frontend-ts/src/apps.tsx` 的 `APPS`）加少量本地 daemon，并没有「从远端拉取并安装一个第三方应用」的通道。要做一个**有第三方开发者参与**的生态，必须回答三个问题：

1. **契约**：开发者以什么格式发布一个应用（manifest + 安装包）？
2. **完整性**：下载到的东西如何证明是开发者发布的原样（而不是被篡改/损坏）？
3. **生命周期**：安装 / 升级 / 卸载怎么走，状态怎么查？

`amos-appstore` 用 provider-seam 模式把答案写进可离线测试的纯 Rust。

---

## 2. 分层与架构

```
[ 未来 CLI / Tauri 桥接 / 商店前端 ]
        │  调用（目录 / 安装 / 升级 / 卸载 / 状态）
        ▼
[ AppStore<P> 引擎 (client.rs) ]      ← 本地「已安装」注册表 + 生命周期规则
        │  通过 StoreProvider seam 取目录 & 包字节
        ▼
[ StoreProvider trait (provider.rs) ]
        ├── MockStoreProvider     （确定性、内存态、离线可测）✓ 已实现
        └── HttpStoreProvider     （真实 HTTP 目录/CDN）✓ 已实现（feature `live`，默认不编）
```

- **`model.rs`**：领域模型与**发布契约**（开发者发布一个 app 要满足的字段），见 §4。
- **`error.rs`**：`StoreError` 错误集（非法 id / 版本 / 校验和 / 未知 app / 未安装 / 已安装 / 无更新 / 校验和不匹配 / provider 错误）。
- **`provider.rs`**：`StoreProvider` 是唯一的外部接线点（列目录 + 取包字节）。只做「取」，**不决定**完整性；完整性由引擎用 manifest 里声明的 sha256 校验。
- **`client.rs`**：`AppStore<P>` 引擎，持有本地「已安装」注册表，执行下载→校验→记录 的规则，并支持注册表 JSON 持久化。

引擎本身**不做任何网络 I/O**，也不在磁盘展开安装包——它只记录「已通过校验的 manifest 快照」。真实安装（把字节落到磁盘、解包、注册成系统可启动的 app）留给未来的 installer。

---

## 3. 应用生命周期

对每个 app id，状态机为：

| 状态 | 含义 | 何时发生 |
|---|---|---|
| `Available` | 目录里有，未安装 | 未安装时调用 `status(id)` |
| `Installed` | 已安装（可能是当前版本，或目录已下架） | `install` 成功后；或目录无更新时 |
| `Updatable` | 已安装，目录有**更高**版本 | 开发者发布了新版本后 `status(id)` |
| `NotInstalled` / `UnknownApp` | 错误态 | 对未安装/目录里没有的 id 做非法操作 |

引擎只允许**升级**（不允许同版本重装或降级）：
- `install(id)`：目录里已存在 → `AlreadyInstalled`。
- `upgrade(id)`：已是最新 → `NoUpdate`；未安装 → `NotInstalled`。
- `uninstall(id)`：未安装 → `NotInstalled`。

`Version` 采用语义化版本比较（数字比较 + pre-release 早于 release），因此目录里发布 `1.1.0` 会让装着的 `1.0.0` 变为 `Updatable`。

```
download → 校验 sha256（不匹配则拒绝，什么都不记录）→ 记录 manifest 快照为已安装
```

---

## 4. 发布契约（开发者必读）

一个 app 在目录里就是一条 **`AppManifest`**。下面用 Rust 类型 ↔ JSON 字段对齐。

### 4.1 顶层 manifest（catalog 里的一条）

Rust：`model::AppManifest`

| 字段 | 类型 | JSON 形态 | 说明 |
|---|---|---|---|
| `id` | `String` | 字符串 | **全局唯一 app 标识**，受 slug 校验，见 §4.3 |
| `name` | `String` | 字符串 | 展示名（不可为空） |
| `summary` | `String` | 字符串 | 列表页一句话简介 |
| `description` | `String` | 字符串 | 详情页长描述（可空则省略） |
| `author` | `String` | 字符串 | 发布方（生态署名） |
| `version` | `Version` | 对象 `{major,minor,patch,pre}` | 本 manifest 的版本 |
| `category` | `AppCategory` | 字符串（见 §4.2） | 分类 |
| `homepage` | `String` | 字符串 | 开发者主页（可空则省略） |
| `icon_url` | `String` | 字符串 | 图标 URL（可空则省略） |
| `package` | `PackageRef` | 对象（见 §4.4） | 要下载安装的产物 |
| `publisher` | `PublisherSig` | 对象（见 §4.7） | 可选：开发者 Ed25519 签名（验签不过引擎拒绝安装）；缺省=未签名 |

示例（`homepage`/`description`/`icon_url` 非空时才会序列化出来）：

```json
{
  "id": "org.amos.pomodoro",
  "name": "Pomodoro",
  "summary": "A focus timer",
  "description": "Work in 25-minute focus sprints.",
  "author": "Amos Labs",
  "version": { "major": 1, "minor": 2, "patch": 0, "pre": null },
  "category": "tools",
  "homepage": "https://example.dev/pomodoro",
  "icon_url": "https://cdn.example.dev/pomodoro/icon.png",
  "package": {
    "format": "tar_gz",
    "url": "https://cdn.example.dev/pomodoro/pomodoro-1.2.0.tgz",
    "sha256": { "algorithm": "sha256", "value": "<64 hex>" },
    "size_bytes": 1048576
  }
}
```

### 4.2 分类 `AppCategory`

序列化为 snake_case 字符串：`other` · `tools` · `media` · `communication` · `games` · `productivity` · `education` · `system`（`other` 为默认）。

### 4.3 `id` slug 规则（硬校验）

- 非空；仅小写 `a-z`、`0-9` 与分隔符 `.` `_` `-`；
- 首字符必须是字母/数字；不能**以分隔符开头/结尾**、不能**连续分隔符**；
- 建议使用反向域名风格，如 `org.amos.pomodoro`。

不符合会被 `AppManifest::validate()` / `MockStoreProvider::add()` 拒绝，返回 `InvalidAppId`。

### 4.4 安装包 `PackageRef`

| 字段 | 说明 |
|---|---|
| `format` | 产物封装格式：`tar_gz` / `zip`（当前引擎当作**不透明字节**，只校验不解包） |
| `url` | 下载地址（引擎通过 provider 拉取） |
| `sha256` | **完整性承诺**：下载字节必须等于该摘要，否则拒绝安装 |
| `size_bytes` | 声明体积（给进度条用，非强校验） |

`Checksum` 编码：`{ "algorithm": "sha256", "value": "<64 位小写 hex>" }`；构造时会把输入归一为小写，非 64 位 hex 会返回 `InvalidChecksum`。

### 4.5 目录整体形态

`MockStoreProvider` 提供了可往返的目录结构（对应 `provider::MockCatalog`）：

```json
{ "name": "mock-store", "apps": [ { "AppManifest 如上" } ] }
```

真实 HTTP 目录（未来）也建议输出该形态，只是多包一层列表 / 分页。

### 4.6 本地「已安装」注册表持久化

`AppStore` 的注册表可存成 JSON（引擎级文件，镜像 `amos-mail` 的 store 文件）。顶层为：

```json
{ "apps": { "<id>": { "manifest": { "AppManifest 如上" }, "installed_at": 1725345600 } } }
```

`AppStore::open(path)` 载入（不存在则空表），`save_file(path)` 落盘；每次 install/upgrade/uninstall 后调用一次即可跨重启保留。Tauri 侧设环境变量 `AMOS_APPSTORE_REGISTRY` 指向该文件，`StoreBridge` 会自动载入并在每次变更后写回。

### 4.7 发布签名 `publisher`（Ed25519）

`PublisherSig` = `{ "public_key": "<64 hex>", "signature": "<128 hex>" }`。开发流程：

```rust
use amos_appstore::{sign_manifest, DeveloperKey};

// 真实场景从系统熵取 32 字节作 seed（核心保持无 PRNG、确定性、可测）
let key = DeveloperKey::from_seed([0u8; 32]);      // 私钥，勿外泄
let signed = sign_manifest(&key, manifest)?;        // 盖上 publisher
// 把 signed 连同包发布到目录即可
```

签名覆盖 manifest **排除 `publisher` 字段自身**的规范字节（`AppManifest::manifest_payload_bytes`），因此自指、且对同一 manifest+key 可复现。安装/升级前引擎自动验签（`amos-appstore::verify_manifest_signature`），不符 → `BadPublisherSignature` 拒绝。请**先**把 `package.sha256` 算好再签名（`MockStoreProvider.add` 只重盖同一摘要，签名保持有效）。

### 4.8 Web-bundle（可运行安装包）

第三方应用的可运行产物 = 一个 `tar.gz` **web-bundle**：`index.html`（+ 静态资源）+ `amos-app.json`（`{"id","name","start"}`）。引擎先 sha256/签名校验，再由 `WebInstaller` 解包落盘：

```rust
use amos_appstore::WebInstaller;
let installer = WebInstaller::new("/data/amos/apps");
installer.install(&verified_manifest, &archive_bytes)?; // -> <root>/<id>/ 含 index.html + manifest.json
installer.uninstall(&id)?;
```

也可直接让引擎在 install/upgrade 时自动解包（设置安装目录即可，卸载一并清理）：

```rust
use amos_appstore::{AppStore, MockStoreProvider};
let store = AppStore::new(provider).with_web_install_dir("/data/amos/apps".into());
store.install("org.amos.pomodoro").await?; // 校验通过后即解包到 /data/amos/apps/<id>/
```

**Tauri 侧**：设 `AMOS_APPSTORE_INSTALL_DIR` 后，`StoreBridge` 自动用该目录解包；宿主可用命令 `appstore_bundle_resource(id, path)` 取回 bundle 文件（base64 + MIME，`nosniff`），无需自定义协议即可在 UI 内渲染本地资源。

`tar` 的 `unpack` 会拒绝 `..`/绝对路径（防穿越）；解包后校验 `start` 文件存在并落 `manifest.json`。**宿主**把该目录 serve 出来即可真正运行（宿主/启动尚未实现，见路线图）。

### 4.9 Web-bundle 服务解析器

宿主把 `amos-app://<id>/<path>` 之类请求交给 `amos_appstore::resolve_request(dir, path)`：映射到该 bundle 目录内真实文件、给内容类型并强制 `nosniff`。规则：拒绝 `..`/绝对路径（防穿越）；空请求或目录→`index.html`；只用 canonicalize 确认落在目录内。

```rust
use amos_appstore::{resolve_request, WebInstaller};
let installer = WebInstaller::new("/data/amos/apps");
let dir = installer.dir_for(&id);
let f = resolve_request(&dir, "assets/app.js")?; // ServedFile{ path, content_type:"text/javascript…", nosniff:true }
```

---

## 5. 快速上手（Rust）

```rust
use amos_appstore::{AppManifest, AppCategory, PackageFormat, PackageRef, Version};
use amos_appstore::{MockStoreProvider, AppStore};

// 1) 建一个离线目录（MockStoreProvider.add 会自动把真实 sha256 盖进 manifest）
let provider = MockStoreProvider::new();
provider.add(
    AppManifest {
        id: "org.amos.pomodoro".into(),
        name: "Pomodoro".into(),
        summary: "A focus timer".into(),
        description: String::new(),
        author: "Amos Labs".into(),
        version: Version::new(1, 2, 0),
        category: AppCategory::Tools,
        homepage: String::new(),
        icon_url: String::new(),
        package: PackageRef {
            format: PackageFormat::TarGz,
            url: "https://cdn.example.dev/pomodoro.tgz".into(),
            sha256: None, // add() 会补上真实摘要
            size_bytes: None,
        },
    },
    b"...package bytes...".to_vec(),
)?;

// 2) 引擎跑下载→校验→记录
let store = AppStore::new(provider.clone());
store.install("org.amos.pomodoro").await?;           // 状态 → Installed
store.status("org.amos.pomodoro").await?;            // AppStatus::Installed{..}

// 3) 开发者发了 1.3.0 之后
// keep.add(…同名 app v1.3.0…); store.upgrade("org.amos.pomodoro").await?;

// 4) 持久化（可选）：save_file 落盘；open 载入（provider 可 clone 复用）
let p = std::path::Path::new("/tmp/amos-installed.json");
store.save_file(p)?;
let _store2 = AppStore::open(provider, p)?;
```

> 示例仅示意；完整可编译用法与错误语义见 `crates/amos-appstore/src/` 及 crate 内单元测试（默认 21，`live` 下 24，含 HTTP 环回端到端）。

### 接真实 HTTP 目录（feature `live`）

目录 URL 返回 §4.5 的 `MockCatalog` JSON 即可；构造 HTTP provider 后，其余引擎调用**与 mock 完全一致**：

```rust
// 编译时开启 live：cargo build -p amos-appstore --features live
use amos_appstore::{AppStore, HttpStoreProvider};

let store = AppStore::new(HttpStoreProvider::new("https://example.dev/catalog.json"));
store.install("org.amos.pomodoro").await?; // 从 manifest.package.url 下载并按 sha256 校验
```

CLI 侧同样支持切真实后端（构建需 `--features live`，未开时给明确报错而不是静默退回 demo）：

```bash
cargo run -p amos-appstore-cli --features live -- \
    --catalog https://example.dev/catalog.json install org.amos.pomodoro
```

---

## 6. 安全要点

- **sha256 硬校验**：下载字节与 manifest 声明的摘要不符 → `ChecksumMismatch`，**拒绝安装且不记录任何状态**。这是防损坏/防篡改的第一道门。
- **只信 provider 的「取」、不信它的「判」**：完整性永远由引擎依据 manifest 里的摘要判定，provider 即便被攻破也只能喂坏字节，进不了已安装表。
- 目录/包 URL 建议一律 **HTTPS**，避免传输中被替换（摘要校验兜底的是内容，仍建议传输层加密）。
- **Ed25519 发布签名**（2026-09-03 已实现）：`sha256` 只保证「内容完整」；**发布签名**再把「谁发布的」钉死——开发者用 `DeveloperKey`（私钥）对 manifest 的规范字节签名（排除 `publisher` 字段自身），签名（含公钥）作为 manifest 的 `publisher` 字段随目录发布；引擎在安装/升级**前**验签，签名与内容不符 → `BadPublisherSignature` 拒绝。注意：验签证明"内容出自该公钥"，是否**信任该公钥**是商店的密钥准入（pin/密钥服务器）职责，留在核心之外。
- 未来把字节真正落盘/解包为可执行 app 时，需在 installer 层做沙箱/权限声明，本文档不含该部分。

---

## 7. 第三方开发者投稿规范（生态接入清单）

要让你写的 app 进入 Amos 生态，对照以下清单准备一条 **`AppManifest` + 一个安装包**：

1. **起个反向域名 id**：`<作者域名反写>.<应用名>`，全小写、无空格的 slug（见 §4.3）。
2. **填全发布信息**：`name`、`summary`（一行）、`description`（可选）、`author`、`homepage`（可选）、`icon_url`（可选）、`category`。
3. **打一个安装包并计算 sha256**：把你的产物打成 `tar.gz`（或 `zip`），计算摘要，写进 `package.sha256`。
4. **遵守语义化版本**：`version` 用 `major.minor.patch`（可带 `-pre`）。发布新功能 → 升版本；升的版本会让所有装着旧版的用户看到「可更新」。
5. **提交到目录**：把 `AppManifest`（含包 URL 与 sha256）交给 Amos 商店维护方合入目录（见 `provider::MockCatalog` 形态 / 未来的 HTTP 目录服务）。
6. **发布新版本 = 更新同 id 的 manifest 并把版本号抬高**（引擎按 id 取目录里最高版本做升级判定）。

---

## 8. 测试

`cargo test -p amos-appstore` —— 覆盖：版本解析与排序、sha256 校验与篡改拒绝、id slug 校验、manifest 校验、mock 目录往返与摘要盖章、**下载→校验→安装**成功路径、**篡改字节被拒**、未知/重复/缺失等干净错误、升级只升不降、卸载、注册表跨进程持久化。质量门禁：`clippy`（含 `deny(clippy::unwrap_used, …)`）与 `rustfmt` 均通过。

---

## 路线图

- [x] **HTTP 后端**（feature `live` 门控，2026-09-03）：`HttpStoreProvider`（`crates/amos-appstore/src/http.rs`）拉远端目录（`MockCatalog` JSON 形态）并下载包；用 `ureq` 于 `spawn_blocking` 内执行，避免阻塞异步执行器；含环回端到端测试。默认不编，保持离线绿。
- [x] **CLI `amos-appstore-cli`**（2026-09-03）：无 UI 验证引擎的 demo/catalog/search/find/installed/updatable/status/install/upgrade/uninstall（镜像 `amos-mail-cli`；`--store` / `AMOS_APPSTORE_REGISTRY` 持久化）。
- [x] **Tauri 桥接命令**（2026-09-03）：`appstore_catalog/search/find/installed/updatable/status/install/upgrade/uninstall` 已由 `amos-tauri/src/appstore.rs` 的 managed `StoreBridge` 暴露并注册进 `generate_handler`；前端 typed 桥接见 `frontend-ts/src/lib/backend.ts` 的 `store*`。`AMOS_APPSTORE_REGISTRY` 可选持久化已装线。
- [x] **商店 UI 页**（2026-09-03）：系统 UI 新增「应用商店」应用（`frontend-ts/src/components/StoreApp.tsx`，入 `APPS`/`COMPONENTS`）——浏览目录（离线 demo 或 HTTP）、按 sha256 校验安装/卸载、检测可更新并升级；未在桌面壳内运行时优雅降级为离线提示。i18n 中/英齐全。
- [x] **`APPS` 动态注册表**（部分，2026-09-03）：store 已装应用经 `frontend-ts/src/lib/storeApps.ts` 作为 `store:<manifest-id>` tile 并入 `amos.home.layout` **上主屏**（`HomeDock`/标题/`AppComponent` 均已识别 ext tile），点击打开占位容器页 `components/ExtApp.tsx`；Store 页 install/upgrade/uninstall 后经 `notifyStoreTilesChanged()` 即时刷新。**边界**：dock/编辑主屏/Spotlight/Recents 目前仍只列出内置应用；真正"运行第三方代码"待 installer（真实 web-bundle 宿主）。
- [x] **发布签名**（2026-09-03）：Ed25519 作者签名（`DeveloperKey`/`sign_manifest`）+ 引擎安装前验签（不符 `BadPublisherSignature` 拒绝），钉死「谁发布的」；公钥信任准入（pin/密钥服务器）留给商店层。
- [x] **installer（web-bundle 后端）**（2026-09-03）：`amos_appstore::webinstall`（`WebInstaller`）——把 `tar.gz` 的 web-bundle（`index.html` + 资源 + `amos-app.json`）解包到 `<root>/<id>/`、校验入口、写 `manifest.json`、可卸载；tar 拒绝 `..` 路径。宿主把解包目录 serve 出来即可运行。
- [ ] **web-bundle 宿主/启动**：把 `<root>/<id>/` 里的 bundle 用宿主（iframe/独立 webview）真正 serve 并打开，接上动态注册表的占位容器页。Rust 侧安全解析器已就绪（`amos_appstore::serve`），见 §4.9。

