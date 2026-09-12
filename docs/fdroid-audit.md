# F-Droid 分发链路审计：AmOS 能否"从 F-Droid 商店下载"？

**日期**: 2026-09-12（同日**缺口 3 的内核半步已实现**，状态更新见 §0.1）
**范围**: 全 workspace 对照 "第三方 App 经 F-Droid 分发" 这一叙事（`docs/microg.md` §0/§2/§3、`docs/appstore.md`）
**方法**: 以代码为准核验（全库 grep + 逐文件读 seam + 实跑测试），区分"已实现 / 只有 seam / 仅规划 / 概念不成立"四类。

## 0. 一句话结论

**"AmOS 从 F-Droid 商店下载"这一说法在内核层现已成立（2026-09-12），设备安装层仍缺：**

1. **AmOS 本体不是 Android 应用**——它是一个 Rust Cargo workspace（领域内核 + Tauri 桌面 UI 的
   移动 OS 原型，见 `FUNCTIONAL_GAP_ANALYSIS.md` #40：*"当前是 Tauri 桌面应用模拟移动 OS，
   不是可引导 OS"*）。F-Droid 只分发 Android APK，**静默装进系统**仍需设备桥（缺口 1）。
2. **内核层已实现**（缺口 3 的半步，本次交付）：`amos_appstore::fdroid` 的
   `FdroidRepoProvider` 直接消费官方 `index-v1.json`（对 f-droid.org **实测通过**：find/search/
   download 全通，真实下载 12.4MB APK 且 sha256 验证成功）；`catalog_to_fdroid_index_v1`
   让我们的目录**以 F-Droid 格式发布**（"商城格式与 F-Droid 一样"）。CLI：`--repo` + `download`。
3. **guest 容器叙事**（`docs/microg.md`）仍为 "已决策、计划中"——无 MicroG guest 镜像；
   容器层已有 `waydroid app install` **命令通道**（2026-09-13，见 §0.1 的第五轮），
   但 gRPC/Tauri 面与「商店下载 → 该通道」的接线仍未做（缺口 1）。文档对该点保持诚实标注。

## 0.1 2026-09-12 交付更新（内核层）

| 交付物 | 位置 | 实测 |
|---|---|---|
| index-v1 解析（双形态 `packages`、数字/字符串数值、未知字段忽略） | `crates/amos-appstore/src/fdroid.rs` | 对 f-droid.org 61MB 官方索引解析成功 |
| `FdroidRepoProvider`（`StoreProvider` 实现，目录/搜索/取包） | 同上 + CLI `--repo` | `find org.wikipedia` → `v0.50.605`；`search terminal` → 2 条 |
| APK 下载 + sha256 校验落盘（`download`，不假装安装） | CLI `download <ID> --out` + 引擎新 `AppStore::download()` | 下载 `org.fdroid.fdroid` v1.23.2（12,426,276 字节）sha256 验证通过 |
| 导出：Amos 目录 → F-Droid index-v1 格式 | `catalog_to_fdroid_index_v1` | 往返单测覆盖 |
| 索引摘要 pin（过渡期真实性方案） | `FdroidRepoProvider::fetch(..., pinned_index_sha256)` / CLI `--pin` | 单测覆盖（对/错 pin） |
| **第二轮审计补全（2026-09-12 同日）** | | |
| `localized` 本地化元数据消费（顶层缺失时 `en` → `zh*` → 首个 locale 回填 name/summary/description/icon） | `fdroid.rs` `effective_display` + `FdroidLocalized` 模型 | 实测 `info org.wikipedia` 直接得到中文描述；单测覆盖 |
| `antiFeatures` 模型携带 + 显式过滤策略（应用级/构建级、大小写不敏感；默认不隐藏任何条目，被标记构建退回最高干净构建） | `FdroidRepoProvider::with_exclude_anti_features` | 单测覆盖（默认保留/策略剔除两路） |
| 大索引**流式解析**（无 pin 时 `serde_json::from_reader` 直接吃响应流，不再整块缓冲两份；pin 时仍全量缓冲验字节） | `http.rs` `blocking_get_json`/`fetch_json_async` + `fetch` 分流 | 实测 f-droid.org 61MB 索引 `find` 5.9–6.7s（两次实跑）；环回单测覆盖 |
| `author` 字段回退（部分第三方仓库不写 `authorName`） | `FdroidApp.author` + 映射回退 | 单测覆盖 |
| 分类映射补官方全集（+`Theming`→System、`Money`→Tools；未映射保持 `Other` 不猜）；导出方向**双向对称**（`Tools`→官方同名 `"Tools"`，不再被导回 `System`） | `map_category` / `category_to_fdroid` | 单测覆盖 + 全部 8 个分类导出→导回不变的断言 |
| 导出对称性：`suggestedVersionCode` = semver 千进制合成码（F-Droid 客户端选中我们的构建） | `catalog_to_fdroid_index_v1` | 单测断言 |
| CLI `info <ID>`（详情：版本/包URL/sha256/大小/描述/状态） | CLI `Op::Info` | 实测 + 单测 |
| CLI `export <FILE> [--repo-address <URL>]`（任意目录 → F-Droid index-v1 格式落盘） | CLI `Op::Export` + `catalog_to_fdroid_index_v1` | 单测：导出文件被 `FdroidRepoProvider` 回读验证 |
| **第三轮审计补全（2026-09-12 同日）** | | |
| 联网下载**体量上限 fail-closed**（索引/目录/包统一经 `CappedReader`；超 `MAX_BODY_BYTES` **明确报错而非静默截断**——防在校验前的内存耗尽 DoS） | `http.rs` `CappedReader` / `MAX_BODY_BYTES` / `blocking_get_*_capped` | 单测：恰好等于配额放行、超 1 字节明确报错；环回 256B 体 + 64B 配额拒绝 |
| CLI 落盘**原子化**（`download`/`export` 同目录临时文件 → `fsync` → `rename`，不留半截产物） | CLI `write_atomic` | 单测：覆盖写内容正确、无 `.tmp.` 残留 |
| `#[ignore]` 门控的**真实联网端到端**（对 f-droid.org：61MB 索引 → localized 中文回填 → 取最小 APK 校验 sha256） | `fdroid.rs` `live::real_fdroid_org_index_and_apk` | 实跑 **17.73s** 通过（1 passed / 80 filtered out） |

| **第四轮审计补全（2026-09-12 同日）** | | |
| 图标往返：导出写**仓库相对文件名**（客户端取 `<repo>/icons/<icon>`），导入不再给绝对 URL 二次前缀 | `fdroid.rs` `icon_filename` / `icon_url_from` | 单测：导入 → 导出 → 再导入是**不动点**（修复前双前缀成 `icons/https://…`） |
| 代理回环判定：由**整串子串**改为**解析 host**（`127.0.0.0/8` / `localhost` / `::1`），不再被 `localhost.evil.test` 或 URL 路径里的 `127.0.0.1` 骗过而绕过出口代理 | `http.rs` `is_loopback_url` | 单测正反两路（`live`） |
| CLI：悬空的取值旗标（尤其 `--pin`）**报错而非静默取消校验** | `amos-appstore-cli` `VALUE_FLAGS` | 单测：`--repo X --pin` 现在报错（回退版返回 `Ok(Help)`，即 pin 被静默丢弃） |
| **第五轮（同日后半）：注册表落盘原子化 + 补上「无人编译 live 半边」的门禁缺口** | | |
| `AppStore::save_file` 由 `std::fs::write`（先截断后写）改为**原子写**（同目录临时文件 → `fsync` → `rename`）；原子写收敛为引擎内**唯一实现** `amos_appstore::write_atomic`，CLI 的 `download`/`export` 也改用它 | `crates/amos-appstore/src/atomic.rs`（新）、`client.rs`、`amos-appstore-cli/src/lib.rs` | 单测：先打开的 fd 必须仍读到**旧**内容（截断式实现下 FAIL）；无 `.tmp.` 残留；损坏注册表是**明确报错**而非静默当空 |
| `live` 半边（`http.rs` + CLI `--repo`/`--catalog`/`--pin`）此前**没有任何门禁编译它**——实测往 `http.rs` 放 `compile_error!`，`make lint`/`make test` 仍全绿 | `Makefile` `gated-check` +2 条（CI 的 `gated-native-backends` job 已调用） | 全环回、不需联网；唯一真实联网用例 `#[ignore]` 门控 |
| **第六轮（同日）：缺口 1 的「命令通道」** | | |
| 容器安装 APK：`AndroidController::install_apk` → `waydroid app install <path>`；空路径/空包名**在任何进程启动前**拒绝；容器静默失败（非 0 退出且 stderr 为空）也**绝不返回空错误串** | `crates/amos-android/src/controller.rs`（`command_error` + `install_apk`）、`runtime.rs`（`AndroidRuntime::install`） | 单测：命令恰好是 `waydroid app install <path>`（记录型 runner 断言 argv）、失败时**不回滚**账本 |
| 安装结果接进 per-APK 能力账本：成功后 `revoke_all(package)`，**新构建 deny-by-default、不继承上一版授权**；`AndroidController::ledger()` / `AndroidRuntime::capabilities()` 供策略钩子读取（demo 运行时报 `None`，且安装报「cannot install」而非假装成功） | 同上 + `capability.rs`（此前是**零调用点**的 seam） | 单测：先 grant → install → `granted()` 为空；demo 两断言 |

| **第七轮（2026-09-13）：共享原子写的并发暂存 + 两处「伪造/误丢弃」** | | |
| 暂存文件名补上**进程内单调序号**（原先只有 pid）：同进程内两个写入方不会再共用同一个暂存文件、把对方写到一半的字节 `rename` 成正式文件（或虚假失败） | `crates/amos-appstore/src/atomic.rs` | 单测：两线程 × 200 次写同一路径 ⇒ 每次都必须成功、且最终内容**恰好等于其中一个载荷**（长度不同，混合体无法冒充） |
| F-Droid `size` 为**负数**时不再变成 `Some(0)`（那是**伪造的「0 字节」**），改为未知 `None` | `fdroid.rs` `flex::opt_u64` | 单测：`size:-1` ⇒ `None`（含映射出的 `size_bytes`）、`size:42` ⇒ `Some(42)` |
| `hashType` 为**空白串**时按「未声明」处理（官方 de-facto 形态 = sha256），不再整个包被丢弃；**声明**为其它算法仍拒绝 | `fdroid.rs` `sha256_checksum`（`.map(str::trim)`） | 单测：`hashType:"   "` + 64-hex ⇒ 可用；`sha1` ⇒ 仍拒绝 |

| **第八轮（2026-09-13）：真实上游复核 + 两处「伪造/虚假承诺」** | | |
| 对**真实 f-droid.org** 重跑 `#[ignore]` 端到端（61MB 官方索引 → localized 中文回填 → 真实 APK 下载 + sha256），确认本会话全部改动没有在真数据上回归 | `fdroid.rs` `live::real_fdroid_org_index_and_apk` | **实跑 8.63s 通过**（`cargo test -p amos-appstore --features live -- --ignored`） |
| 上游缺作者时不再填字面量 `"F-Droid"`（那是**伪造归属**：F-Droid 是分发方，而 UI 把该字段渲染成「作者」），改为空串＝未知 | `fdroid.rs` `manifest_for_app` | 单测：无 authorName/author 的 App ⇒ `author == ""`（负控：改回字面量 ⇒ FAIL，`left: "F-Droid"`） |
| `version_code_from` / `map_version` 的文档原话是**无条件**「导出→导入往返版本」，实际只在每一位 < 1000 时成立（`1.1000.0` 进位成 `2.0.0`）；现把前提写进两处文档注释并用测试钉住边界 | `fdroid.rs` 两处文档注释 | 单测：`0.0.0`/`1.2.3`/`999.999.999` 往返；`1.1000.0` ⇒ `2.0.0`（进位，已声明的边界） |

| **第九轮（2026-09-13）：bundle 软链接通道（安装期 + 读取层各修一处）** | | |
| 安装期：`tar::unpack` 只拒绝 `..`/绝对**名字**，**不拒绝链接**——软链接条目会被原样落盘。现在解包**之前**扫描条目，拒绝 symlink / hard link（fail-closed、点名条目），并据此改正模块头文档（原话「unpack 拒绝 `..`，所以恶意归档跑不出 dir」是**不完整的论证**） | `webinstall.rs` `reject_link_entries` + 文档 | 单测：带 symlink 的 bundle 被拒且**不产生部分解包**；带 hard link 的同样被拒 |
| 读取层：`read_file` 走 `safe_join`（只约束**请求名**）+ `File::open`（**跟随软链接**）⇒ 实测读出了安装目录之外的宿主机文件；现改为复用宿主侧那条**已加固**的解析器 `serve::resolve_request`（`canonicalize` + `starts_with(dir)`），两条读路径不再各说各话 | `webinstall.rs` `read_file`、`serve.rs` 复用 | 单测（unix）：手工植入指向外部文件的软链接 ⇒ `read_file` 与 `serve_bundle` **都拒绝**，正常文件仍可读 |
| 写穿越（软链接目录 + 后续条目写入）：**实测 tar-rs 本来就拒绝**（`trying to unpack outside of destination path`，外部文件不存在）——所以严重性并非「任意外写」；该性质被钉成永久测试，防止将来升级 tar 时静默失效 | `webinstall.rs` 测试 | 单测：直接用 `unpack` 解这类归档 ⇒ 断言外部目录**未**出现文件 |

**仍未实现（保持诚实）**：索引 PGP（`index-v1.jar.asc`）验签；APK 静默安装的设备桥（缺口 1）；
guest 镜像（缺口 2）。`web install` 对 F-Droid 条目会诚实报错并指引 `install_apk`。

## 1. 证据盘点（2026-09-12 更新后）

| 判据项 | 代码证据 | 状态 |
|---|---|---|
| F-Droid 客户端/仓库协议（index-v1/v2.json、JAR+PGP 验签、`FdroidRepoProvider`） | ✅（2026-09-12）`amos_appstore::fdroid`：index-v1 解析 + `FdroidRepoProvider` + 导出器，**对 f-droid.org 实测通过**；⚠️ PGP/JAR 验签仍未做（以 `--pin` sha256 过渡） | 🟢 协议层已实现（PGP 缺） |
| MicroG + AOSP guest 镜像（F-Droid/Aurora 预装进 data 层的载体） | `docs/microg.md` 顶部自述：*"已决策、计划中（尚未实现）"*；无任何镜像构建脚本/`LOCAL_PRIVILEGED_MODULE` 产物 | 🔴 仅规划 |
| 容器 APK 安装命令 | ✅（2026-09-13）`AndroidController::install_apk` 跑 `waydroid app install <path>`（另有 `launch_apk` / `list_installed_apps` / `force_stop`）；`AndroidRuntime::install` 在 runtime 层可达，安装成功后把该包在 `CapabilityLedger` 里**重置为 deny-by-default**；gRPC 面已加 `InstallAndroidApp`（`EnhancedAndroidManager::install_app` 带 launch 超时保护），**端到端过真实 UDS 已验证**（host 上是 demo runtime ⇒ 返回 `success=false` + 原因，不伪造成功）。⚠️ 仍缺**消费者**：没有 Tauri 命令/UI 去调它，也没有「商店下载的 APK → 该通道」的接线 | 🟢 命令层 + 服务面已实现（UI 消费者缺） |
| 宿主 APK 静默安装桥 | `crates/amos-appstore/src/android.rs`：`PackageInstallerBridge` trait + `SideloadOnlyBridge` **占位**（`write_apk` 为 no-op、`commit` 返回确定性假成功/`PendingUserAction`）+ `ffi` 模块只是 `repr(C)` "文档即类型"；真实 JNI/priv-app 桥未实现（模块头自述诚实） | 🟠 seam + 占位，未接真机 |
| 自建商店（非 F-Droid）web-bundle 路径 | `amos_appstore::client`（sha256 硬校验 + Ed25519 验签 + 生命周期）+ `webinstall`（tar.gz 拒绝 `..` 穿越）+ `serve`/`host` + Tauri `StoreBridge` + 商店 UI 页 + 动态主屏 tile；`cargo test -p amos-appstore` **71 passed / 0 failed**（默认）/ **80**（`--features live`）（2026-09-12 实跑） | ✅ 已实现（装的是 web-bundle，非 APK） |
| 宿主商店消费 F-Droid 仓库的接入点 | `StoreProvider` seam 上的 `FdroidRepoProvider` **已落地**：目录/搜索/取包全走既有 `AppStore` 引擎，APK 下载 sha256 校验落盘（`AppStore::download` / CLI `download`） | ✅ 已实现（安装侧见缺口 1） |

## 2. 审计判定

- **诚实性**：✅ 通过。仓库没有把 F-Droid 叙事虚报为已实现——`docs/microg.md` 明写
  "计划中（尚未实现）"，`docs/appstore.md` 明写装的是 web-bundle、真正运行 APK 待
  installer 特权桥。对外（OEM/用户）引用时请沿用这两个文档的措辞，**不要说
  "应用可从 F-Droid 下载"**。
- **功能完善度**：按 "F-Droid 分发" 判据为 **未实现**；按 "自建商店分发 web-bundle" 判据为
  **领域内核 + 宿主完整**。两者不可混为一谈（`docs/microg.md` §0 非目标已钉死此边界）。

## 3. 若要兑现 "F-Droid 分发" 叙事的最小缺口（按依赖顺序）

1. **[桥] guest 容器安装通道**：`AndroidController::install_apk`（`waydroid app install <apk>`）
   ✅（2026-09-13）——安装成功后把该包在既有 per-APK 能力账本里重置为 deny-by-default
   （`amos-android/src/capability.rs`，不旁路、不继承上一版授权）；`AndroidRuntime::install`
   让它在 runtime 层可达；gRPC `InstallAndroidApp`（`AndroidManagerService` +
   `EnhancedAndroidManager::install_app` 超时保护）让守护进程的客户端也能调，已用**真实 UDS**
   端到端验证（host 上是 demo runtime，故返回 `success=false` + 原因）。**仍缺**：Tauri 命令 /
   System UI 的消费者，以及 F-Droid 下载的 APK 接到该通道的实际接线（那需要先定「宿主 JNI/priv-app
   桥」还是「guest 容器通道」——`amos-appstore/src/android.rs` 的模块文档把桥的落地明确留在设备侧）。
2. **[镜像] guest 镜像预装 F-Droid/Aurora + MicroG**：按 `docs/microg.md` §3 落 AOSP
   构建（signature spoofing 白名单仅 GmsCore/GsfProxy；F-Droid 放 data 层）。
3. **[内核, 可选] 宿主商店直连 F-Droid 仓库**：为 `StoreProvider` 写
   `FdroidRepoProvider`（index-v1/v2 解析 + PGP/JAR 验签 → `AppManifest`），使宿主
   商店 UI 无需 guest 也能浏览/装 APK——**前提**是第 1/桥接层已能真正落包。
4. **[决策] 先钉底座口径**：`FUNCTIONAL_GAP_ANALYSIS.md` §六已判 "真机 = no-UI Android
   基座，Waydroid 仅开发/原型"——F-Droid 走 guest 镜像（方案 A）还是宿主直连
   （方案 B），应先定夺，避免两套叙事（`docs/microg.md` §1 的单一叙事纪律）。

## 4. 边界声明

本审计只核对 "F-Droid 分发" 这一判据，不覆盖 F-Droid 上游政策（如收录审核、可复现
构建要求）——即便实现上述缺口，把任何产物**提交进 F-Droid 官方仓库**还需满足其上游
政策，属于独立的外部流程，本仓库文档未涉及，也不应声称。
