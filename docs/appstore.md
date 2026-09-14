# Amos 应用商店（App Store）

**Amos App Store** 是 Amos「软件下载与生态」的**领域核心**：定义「一个可安装的第三方应用」是什么、目录与安装包长什么样、版本如何演进、下载到的东西如何被证明没被篡改。

当前交付的是**纯 Rust 领域内核 crate**（`crates/amos-appstore`），不含 UI / CLI / Tauri 桥接——先把**契约**和**下载→校验→安装**的包管理核心钉死，再逐层接壳。这正是仓库一贯的拆分方式（参考 `amos-mail` / `amos-int` / `amos-tts`）。

> 状态：**领域内核 + Tauri 桥接 + CLI + HTTP 后端 + 发布签名 + 动态注册表 + F-Droid 兼容层已实现**（2026-09-12）。Rust 侧：离线领域内核 + provider seam + mock + 测试；`HttpStoreProvider`（`live` 门控）拉真实 HTTP 目录 + 下载包；Ed25519 **发布签名**（`DeveloperKey` 签名 manifest、引擎安装前验签）；**F-Droid 仓库兼容**（`FdroidRepoProvider`：官方 `index-v1.json` 双形态解析 → 同一 `AppManifest` 契约，APK 下载 + sha256 校验，已对 f-droid.org 实测）。已通过 `amos-tauri/src/appstore.rs`（managed `StoreBridge` + `appstore_*` 命令）与前端 `store*` typed 桥接暴露给 WebView；另有 `amos-appstore-cli` 在终端驱动同一引擎。系统 UI 已含「应用商店」应用页（目录/安装/卸载/升级），且**已装第三方应用会作为 tile 动态并入主屏**（`store:<id>`，点击打开占位容器）。剩余：installer（真实运行宿主）与 APK 静默安装的设备桥见文末[路线图](#路线图)。
>
> 另见 [`pwa-index.md`](./pwa-index.md)：**预装 PWA 的声明式索引**（`amos-app.toml` v0.1）与 `amos-app://` 私有协议网关——它和本文的商店是同一套 `amos-app://` 命名空间的两半（索引 = 出厂声明，商店 = 下载安装）。

---

## 1. 为什么需要它

今天 Amos 系统内的「应用」是**编译期写死**的内置 Svelte 屏幕（`frontend-ts/src/svelte/appRegistry.ts` 的 id→屏幕加载表）加少量本地 daemon，并没有「从远端拉取并安装一个第三方应用」的通道。要做一个**有第三方开发者参与**的生态，必须回答三个问题：

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
        ├── HttpStoreProvider     （真实 HTTP 目录/CDN）✓ 已实现（feature `live`，默认不编）
        └── FdroidRepoProvider    （F-Droid 仓库 index-v1 兼容）✓ 已实现（解析离线可用；联网 fetch 在 `live`）
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

**Tauri 侧**：设 `AMOS_APPSTORE_INSTALL_DIR` 后，`StoreBridge` 自动用该目录解包。**历史注记**：这里曾提供 `appstore_bundle_resource(id, path)`（逐文件 base64 + MIME + `nosniff`）供前端在**没有自定义协议**的情况下渲染本地资源；该通道已随 srcdoc 路径一起**删除**（REQ-A171），现行路径见 §4.10。

`tar` 的 `unpack` 会拒绝 `..`/绝对路径（防穿越）；解包后校验 `start` 文件存在并落 `manifest.json`。**宿主**把该目录 serve 出来即可真正运行（宿主/启动尚未实现，见路线图）。

### 4.9 Web-bundle 服务解析器

宿主把 `amos-app://<id>/<path>` 之类请求交给 `amos_appstore::resolve_request(dir, path)`：映射到该 bundle 目录内真实文件、给内容类型并强制 `nosniff`。规则：拒绝 `..`/绝对路径（防穿越）；空请求或目录→`index.html`；只用 canonicalize 确认落在目录内。

```rust
use amos_appstore::{resolve_request, WebInstaller};
let installer = WebInstaller::new("/data/amos/apps");
let dir = installer.dir_for(&id);
let f = resolve_request(&dir, "assets/app.js")?; // ServedFile{ path, content_type:"text/javascript…", nosniff:true }
```

### 4.10 运行时宿主：真 origin（现行）与 srcdoc 内联（被取代）

**现行路径**：三方应用现在运行在**自己的真 origin** 上。Rust 侧 `appstore_bundle_entry(id)`
（`crates/amos-tauri/src/appstore.rs`）先证明「这个 id 合法 + 该应用**确实已安装** + 它的入口
**确实可被服务**」（`read_bundle_meta` 拒绝穿越的 `start` 与缺失文件），再按**平台正确的**
形态返回入口 URL（macOS/iOS/Linux `amos-app://<id>/…`，Windows/Android
`http://amos-app.<id>/…`，见 `docs/pwa-index.md` §1）。前端 `svelte/ExtAppHost.svelte` 把它放进一个
`sandbox="allow-scripts allow-same-origin allow-forms"` 的 iframe（`Shell.svelte` 的 `store:<id>`
分支）——**没有** `allow-top-navigation` / `allow-popups` / `allow-modals`。`allow-same-origin`
在这里是**安全的**：MDN 警告的是「frame 与父页同源时它能把 sandbox 摘掉」，而 bundle 的 origin
（`amos-app://<id>`）与壳的 origin（`tauri://localhost`）**scheme 与 host 都不同**；没有它，
bundle 连自己的 `fetch('app.js')` 都发不出去，多页 / ESM bundle 也就跑不起来。
每个失败都**说出来**：没桥 / 宿主拒绝（原样带宿主的话，如
`no web install dir (set AMOS_APPSTORE_INSTALL_DIR)`）/ URL 不可信 —— 四种状态四段文案。

**被取代的路径**：`frontend-ts/src/lib/bundle.ts`（逐文件 base64 + MIME，把相对资源内联成
`data:` URL，塞进 `sandbox="allow-scripts"`（**无** `allow-same-origin`）的 `srcdoc` iframe）当年
是"无需自定义协议"的落地路径。它的**唯一消费者 `components/ExtApp.tsx` 在 React 移除时已经不在**，
且自定义协议宿主已经上线，所以它**今天没有任何生产调用点**；它作为**更严的**（不透明 origin）
宿主模式被 `scripts/unwired-allowlist.json` 显式保留并写明"下一轮若无人认领即删除"。
`lib/sandboxBridge.ts`（沙箱能力申请 → `perm_authorize` 单一收口）**两种模式都还需要**，理由不变。

> 诚实边界：真 origin 宿主的多页 / ESM / 自身 `fetch` 能力来自协议与 origin 的**设计**，组件测试
> 只覆盖「我们这一侧」的判定（iframe 的 `src`/`sandbox`、四种失败文案）；**真机未验收**。
- 旧的 base64 读通道（`appstore_bundle_resource` / `appstore_bundle_uri` 命令 + `read_bundle_resource` /
  `read_bundle_uri` + 前端 `storeBundleResource` / `storeBundleUri`）已**整体删除**（REQ-A171）：它只服务
  于 srcdoc 路径，且 `read_bundle_uri` 会**委托**给策略生产者 `serve_bundle` 再把策略**丢掉** —— 留着一个
  「能 serve 出没有策略的文档」的接缝，与下面新增的性质直接矛盾。

#### 4.10.1 bundle 的出口声明 → WebView 强制（声明变成承诺）

publisher 在自己的 `amos-app.json` 里声明它要访问的主机：

```json
{ "id": "org.amos.demo", "name": "Demo", "start": "index.html",
  "allowed_domains": ["api.example.com", "cdn.example.org"] }
```

* **同一份文法**：与 PWA 索引的 `[permissions.network].allowed_domains` 共用
  `pwa::validate_domain_pattern`（裸主机名；无通配形式）。装错形式（`*.host`、`https://…`、大写）在
  **安装期与读取期都拒绝**，不静默丢弃 —— 会被 CSP **授予**的规则不能未经检查。
* **声明在签名包内部**：`amos-app.json` 位于 `tar.gz` 里，因此它落在 sha256（与可选 Ed25519 签名）
  覆盖的字节里 —— 签名之后无法换成更宽松的一份。
* **强制点**：宿主（`amos-appstore::host::serve_bundle` → `pwa::bundle_csp`）为该 bundle **每个响应**
  生成 `Content-Security-Policy`，Tauri 处理器把它作为响应头发出。为什么必须是**响应头**：CSP 是
  **逐文档**执行的，而 bundle 是**自己 origin 上的另一个文档** —— 壳的策略（`tauri.conf.json` 里那份）
  对它**完全没有约束力**。
* **策略形状**：`default-src 'self'` / `script-src 'self'`（只能加载包内自己的代码 ⇒ publisher 不能引入
  远端的别人的代码）、`connect-src 'self'` **加上声明的主机**（`https://` 与 `wss://`，主机及其一级
  通配；**明文 `http://`/`ws://` 不授予**）、`form-action` 同一份清单、`img-src`/`media-src`/`font-src`
  允许 `data:`/`blob:`（静态包的内联资源）、`object-src 'none'`、`base-uri 'none'`、`frame-src 'none'`。
  空清单 = 「这个应用谁也不许连」。
* **索引命名空间**：`apps.json` 与图标是**数据不是文档**，带 `default-src 'none'; frame-ancestors 'none'`
  —— 即使有人把 JSON 框起来，那里也不会执行任何东西。**404 拒绝响应同样带策略**。

**未覆盖 —— 直说**：bundle 仍然可以把**自己的 frame 导航**到一个外部 URL，而那次导航可以把数据放进
路径。CSP 的 `navigate-to` 在我们出货的引擎里**没有实现**，所以这一条在这里关不掉。想关它需要一个真正的
出口守卫，而**逐 bundle 的出口守卫今天不可能**：bundle 与壳**同进程同 uid**，`amos-network-guard` 的
规则是 uid 维度的，包过滤器分不出两者。这条当作**结构性结论**记在这里，免得有人承诺一个做不到的东西。

> ⚠️ **shell 自己的 CSP（`tauri.conf.json` 的 `csp`）已在 REQ-A171 写入，但未在真实窗口验证**。
> 两个细节是读源码推出来的，不是猜的：① Tauri 的 `set_csp` 会给自己的注入脚本/样式**自动加 nonce**
> （`manager/mod.rs::replace_csp_nonce`），而 **CSP3 下 nonce 存在时 `'unsafe-inline'` 被忽略**；② 壳里有
> **15 处内联 `style=`**（壁纸 backdrop、相机变焦、dock…）。所以配置带了
> `dangerousDisableAssetCspModification: ["style-src"]`，让 `style-src 'self' 'unsafe-inline'` 真正生效 ——
> 代价是样式注入面变宽（而壳本来就需要内联样式），换来的是 `script-src 'self'` 这条真正有价值的约束。
> 这份配置的**键名**已被负控验证（写入一个假键 ⇒ `tauri-build` 报 `unknown field` 并列出合法键集），
> 但**策略本身是否打断 UI 未经验证**。

### 4.11 `amos-app://` 协议宿主（Rust 层，已就绪）

`crates/amos-appstore/src/host.rs` 提供了「未来 `amos-app://` 宿主」所缺的 **URI 层**，可直接被
Tauri 的自定义协议 handler 调用（host 可单测）：

```rust
use amos_appstore::{parse_bundle_uri, serve_bundle};

let (id, path) = parse_bundle_uri("amos-app://org.amos.pomodoro/assets/app.js")?;
// → ("org.amos.pomodoro", "/assets/app.js")

let b = serve_bundle(install_root, "amos-app://org.amos.pomodoro/")?; // → index.html bytes
// 宿主把 b.bytes 以 b.content_type 写出，并强制 nosniff（已内建）
```

安全不变量：URI 的 **netloc 必须是通过 `model::valid_id` 的应用 id**（`..`/`/`/空白/大写都无法当
id 寻址）；请求路径交给 `serve::resolve_request` 做 canonicalize + 防穿越 + 缺文件报错。

**Tauri 侧接线（已落代码）**：`amos-tauri/src/appstore.rs` 新增 `read_bundle_uri(root, uri)`
（纯、可单测）与命令 `appstore_bundle_uri(uri)`（已注册进 handler），System UI 可经
`lib/backend.ts` 的 `storeBundleUri(uri)` 以 URL 形式取回一个 web-bundle 文件（base64 + MIME +
nosniff）——这是未来自定义协议 handler 唯一要调的入口。同时给原 `read_bundle_resource(id, path)`
补上了 **id 校验**（旧的 `root.join(id)` 无守卫，恶意 `id` 如 `..` 可能越到 root 之外），与
`host` 模块共用 `is_valid_app_id`。真正把 `amos-app://` 注册成 WebView 协议并加 scheme 白名单仍属
GUI/设备接线（本仓库无 GUI runner），见路线图。

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

### 接 F-Droid 仓库（feature `live`，2026-09-12 实测通过）

`FdroidRepoProvider`（`crates/amos-appstore/src/fdroid.rs`）让同一引擎直接消费 **F-Droid 的
`index-v1.json` 目录**——我们的目录格式与 F-Droid 双向兼容（既可读也可导出，见 `catalog_to_fdroid_index_v1`）：

```bash
# 浏览 / 搜索官方仓库（拉取 <repo>/index-v1.json，~60MB，已对 f-droid.org 实测）
cargo run -p amos-appstore-cli --features live -- \
    --repo https://f-droid.org/repo find org.wikipedia
cargo run -p amos-appstore-cli --features live -- \
    --repo https://f-droid.org/repo info org.wikipedia      # 详情：版本/包URL/sha256/大小/描述
cargo run -p amos-appstore-cli --features live -- \
    --repo https://f-droid.org/repo search terminal

# 下载一个 APK 并按索引里的 sha256 校验后落盘（不安装）
cargo run -p amos-appstore-cli --features live -- \
    --repo https://f-droid.org/repo download org.fdroid.fdroid --out /tmp/fdroid-client.apk

# 把任意当前目录（离线 demo / --catalog / --repo）导出为 F-Droid index-v1 格式
amos-appstore-cli export index-v1.json --repo-address https://store.amos.local/repo
```

兼容性与诚实边界：

- **格式双向**：`FdroidIndexV1` ↔ `AppManifest`。官方索引的怪癖都被吸收——`packages`
  既接受官方的**按包名分组对象**也接受第三方常用的扁平数组（分组行缺省的
  `packageName` 从字典键回填）；数值字段同时接受数字与字符串编码（官方
  `suggestedVersionCode` 就是 `"1010200"`）；未知字段忽略。
- **本地化元数据**：`localized` 字典被消费——顶层 `name`/`summary`/`description`/`icon`
  缺失或为空时按 `en` → `zh*` → 首个 locale 回填（f-droid.org 大量应用的正文只存在于
  `localized`，实测 `info org.wikipedia` 直接得到中文描述）。
- **antiFeatures 显式过滤**：应用级与构建级的 `antiFeatures`（`KnownVuln`/`NSFW`/…）
  都被模型携带；`FdroidRepoProvider::with_exclude_anti_features(["KnownVuln"])` 按
  策略剔除（默认**不隐藏任何条目**——过滤是显式选择，被标记构建会退回最高干净构建）。
- **诚实跳过**：`packageName` 不是合法 Amos slug（含大写）的条目**跳过而非改名**（改名会
  破坏 PackageInstaller 交接）；没有可用 sha256 摘要的包跳过（联网商店绝不降级为无校验安装）。
- **版本映射**：`versionName` 能按 semver 解析就用它（两段式 `5.0` 补成 `5.0.0`）；否则按
  `versionCode` 做千进制拆分，保证升级排序永不因上游命名而断。导出方向对称地写入
  `suggestedVersionCode`（= semver 的千进制合成码），F-Droid 客户端会选中我们的构建。
- **大索引省内存**：无 pin 时索引**流式解析**（`serde_json::from_reader` 直接吃响应流），
  61MB 官方索引不再整块缓冲两份；带 `--pin` 时仍全量缓冲以校验精确字节。
- **下载体量有上限**：联网下载（索引 / 目录 / 包）都经 `CappedReader` 以
  `MAX_BODY_BYTES`（2 GiB）封顶，超出即 **fail-closed**（明确报错，绝不静默截断）——
  防止恶意/误配置的服务器无限流式推送，在 sha256 校验**之前**把内存耗尽。
- **落盘原子性**：CLI `download`/`export` 先写同目录临时文件、`fsync` 后 `rename`
  覆盖目标；进程中途被杀只会留下**旧文件或什么都没有**，绝不留半截产物给后续
  安装/校验步骤误信。
- **APK 落盘 ≠ 安装**：F-Droid 条目是 APK，引擎把它路由到 `install_apk()`（设备
  PackageInstaller 桥）。宿主上诚实的动作是 `download`（取字节 + 验摘要，**不装**）；
  静默安装待 `crates/amos-android` 的真实桥（见 `docs/fdroid-audit.md` 缺口 1）。
- **索引真实性**：官方用仓库 PGP 密钥签 `index-v1.jar.asc`，OpenPGP 验签**尚未实现**；
  过渡期用 `--pin <sha256>`（或 `FdroidRepoProvider::fetch` 的
  `pinned_index_sha256` 参数）钉住索引摘要。每个 APK 的 sha256 校验不受影响。
- 代理：live 抓取遵循 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`（含 socks5，ureq
  `socks-proxy` feature）；回环地址（测试/本地服务）永远直连。

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

`cargo test -p amos-appstore` —— 覆盖：版本解析与排序、sha256 校验与篡改拒绝、id slug 校验、manifest 校验、mock 目录往返与摘要盖章、**下载→校验→安装**成功路径、**篡改字节被拒**、未知/重复/缺失等干净错误、升级只升不降、卸载、注册表跨进程持久化、**F-Droid 兼容**（index 解析/映射/导出往返/字符串数字/分组形态/引擎拒绝 web 安装 APK/localized 回填/antiFeatures 显式过滤/`author` 回退/分类映射扩展与双向对称（全 8 分类导出→导回不变）/导出 `suggestedVersionCode`；`--features live` 下另有环回端到端：拉索引→目录→APK 下载→pin 校验，以及**下载体量上限 fail-closed**（配额读满即报错、不静默截断；含 256B 环回超限用例）；另有 `#[ignore]` 门控的**真实联网**端到端：对 f-droid.org 拉 61MB 索引 → localized 中文回填 → 下载最小 APK 并校验 sha256）。CLI 侧覆盖 `info`/`export` 解析与离线 dispatch（导出文件被 `FdroidRepoProvider` 回读验证）与**原子落盘**（覆盖写、无临时文件残留）。质量门禁：`clippy`（含 `deny(clippy::unwrap_used, …)`）与 `rustfmt` 均通过。测试数为**实跑值，且命令随数字一并记下**（避免再次成为无人复核的陈旧散文）：`cargo test --workspace` → **1719 passed / 0 failed**；本模块 `live` 口径 `cargo test --workspace --features amos-appstore/live,amos-appstore-cli/live` → **1731 / 0**（= 默认 1719 加上 appstore 两 crate 的 live 增量 +12）；若把 `amos-mail`/`amos-mail-cli` 的 `live` 也一并启用则 → **1745 / 0**（2026-09-12 实跑；此三数均无脚本门禁固定，改测试后需重新实跑。注意 `live` 半边的 `http.rs` 与 CLI 的 `--repo`/`--pin` 路径**不在** `make lint`/`make test` 里——它们由 `make gated-check` 编译并测试，见 `docs/fdroid-audit.md` 第四轮）。

---

## 路线图

- [x] **HTTP 后端**（feature `live` 门控，2026-09-03）：`HttpStoreProvider`（`crates/amos-appstore/src/http.rs`）拉远端目录（`MockCatalog` JSON 形态）并下载包；用 `ureq` 于 `spawn_blocking` 内执行，避免阻塞异步执行器；含环回端到端测试。默认不编，保持离线绿。
- [x] **CLI `amos-appstore-cli`**（2026-09-03）：无 UI 验证引擎的 demo/catalog/search/find/installed/updatable/status/install/upgrade/uninstall（镜像 `amos-mail-cli`；`--store` / `AMOS_APPSTORE_REGISTRY` 持久化）。
- [x] **Tauri 桥接命令**（2026-09-03）：`appstore_catalog/search/find/installed/updatable/status/install/upgrade/uninstall` 已由 `amos-tauri/src/appstore.rs` 的 managed `StoreBridge` 暴露并注册进 `generate_handler`；前端 typed 桥接见 `frontend-ts/src/lib/backend.ts` 的 `store*`。`AMOS_APPSTORE_REGISTRY` 可选持久化已装线。
- [x] **商店 UI 页**（2026-09-03）：系统 UI 新增「应用商店」应用（`frontend-ts/src/components/StoreApp.tsx`，入 `APPS`/`COMPONENTS`）——浏览目录（离线 demo 或 HTTP）、按 sha256 校验安装/卸载、检测可更新并升级；未在桌面壳内运行时优雅降级为离线提示。i18n 中/英齐全。
- [x] **`APPS` 动态注册表**（部分，2026-09-03）：store 已装应用经 `frontend-ts/src/lib/storeApps.ts` 作为 `store:<manifest-id>` tile 并入 `amos.home.layout` **上主屏**（`HomeDock`/标题/`AppComponent` 均已识别 ext tile），点击打开占位容器页 `components/ExtApp.tsx`；Store 页 install/upgrade/uninstall 后经 `notifyStoreTilesChanged()` 即时刷新。**边界**：dock/编辑主屏/Spotlight/Recents 目前仍只列出内置应用；真正"运行第三方代码"待 installer（真实 web-bundle 宿主）。
- [x] **发布签名**（2026-09-03）：Ed25519 作者签名（`DeveloperKey`/`sign_manifest`）+ 引擎安装前验签（不符 `BadPublisherSignature` 拒绝），钉死「谁发布的」；公钥信任准入（pin/密钥服务器）留给商店层。
- [x] **installer（web-bundle 后端）**（2026-09-03）：`amos_appstore::webinstall`（`WebInstaller`）——把 `tar.gz` 的 web-bundle（`index.html` + 资源 + `amos-app.json`）解包到 `<root>/<id>/`、校验入口、写 `manifest.json`、可卸载；tar 拒绝 `..` 路径。宿主把解包目录 serve 出来即可运行。
- [x] **web-bundle 运行时宿主（真 origin，现行）**（2026-09-13，REQ-A169）：三方应用运行在自己的真 origin 上——Rust `appstore_bundle_entry(id)` 证明「id 合法 + 已安装 + 入口可服务」后给出**平台正确**的入口 URL，前端 `svelte/ExtAppHost.svelte` 放进 `sandbox="allow-scripts allow-same-origin allow-forms"` 的 iframe（`Shell.svelte` 的 `store:<id>` 分支）——多页 / ESM / 自身 `fetch` 因此可用。旧的 srcdoc 内联路径（下面的条目）**已被取代**：它的唯一消费者 `components/ExtApp.tsx` 随 React 移除而不在，今天零生产调用点。
- [x] **web-bundle 宿主（前端 srcdoc 沙箱，已被取代）**（2026-09-04）：`components/ExtApp.tsx` 不再是占位页——若该 app 带可运行的 web 界面，就逐文件经 `storeBundleResource`（base64）取回，用 `lib/bundle.ts` 的纯函数把相对资源内联成**单一自包含文档**，再放进 `sandbox="allow-scripts"` 的 `srcdoc` iframe 运行（无 same-origin → 碰不到 OS 壳）；无 web 界面的仅清单安装回落为清单展示（`extApp.notWeb`），加载失败给错误并可重载。**现状（2026-09-13）**：React 壳已移除 ⇒ 该路径无生产调用点，`lib/bundle.ts` 与其单测仍在，但只有 allow-list 保留其"更严宿主模式"的身份（见 §4.10）。
- [x] **F-Droid 仓库兼容层**（2026-09-12）：`amos_appstore::fdroid`——官方 `index-v1.json` 双形态解析（`packages` 分组对象 / 扁平数组、数字/字符串数值）→ 映射为同一 `AppManifest` 契约（`FdroidRepoProvider`，即 `docs/fdroid-audit.md` 缺口 3 的内核半步）；反向 `catalog_to_fdroid_index_v1` 让我们的目录**以 F-Droid 格式发布**。CLI 增加 `--repo`（浏览/搜索/find）与 `download`（取 APK + sha256 验证落盘，不假装安装）。**已对 f-droid.org 实测**：find/search/download 全通；分类映射**双向对称**（导出→导回不变）；联网下载体量**有上限且 fail-closed**，CLI 落盘**原子**（无半截产物）；另有 `#[ignore]` 门控的真实联网端到端用例（`cargo test -p amos-appstore --features live -- --ignored`）。诚实边界：索引 PGP 验签未实现（先以 `--pin` sha256 过渡）；APK **静默安装**仍待设备桥（缺口 1）。**审计轮（同日）**又补掉 3 处真实缺陷：导出 `icon` 由绝对 URL 改为仓库相对文件名（此前「导出→导回」会双前缀成 `icons/https://…`）、代理回环判定由整串子串改为解析 host（此前 `localhost.evil.test` 会绕过出口代理）、悬空的 `--pin` 报错而不再静默变成「无 pin」。
- [~] **[桥] guest 容器安装通道**（缺口 1，**命令层 + gRPC 面已落地；消费者/接线仍未做**）：`AndroidController::install_apk`（`waydroid app install <path>`）+ `AndroidRuntime::install`，安装成功即把该包在 per-APK 能力账本里**重置为 deny-by-default**（`ledger.revoke_all`，不继承上一版构建的授权）；守护进程侧新增 gRPC `InstallAndroidApp`（`EnhancedAndroidManager::install_app` 有超时保护），已过真实 UDS 端到端验证。**仍未做**：Tauri 命令 / System UI 的消费者（本轮**刻意不**加没有消费者的 UI），以及 F-Droid APK 从商店到该通道的接线——见 `docs/fdroid-audit.md` 缺口 1。

