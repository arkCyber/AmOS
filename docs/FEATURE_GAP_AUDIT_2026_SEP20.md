# AmOS 功能缺口审计（2026-09-20）

> **方法**：只写**本次实测可复现**的结论。每条缺口都给出「证据文件/命令」与「口径」
> （`实测` = 本次跑出来 / `台账` = 仓库自己的 baseline·allowlist 里带理由的决定 /
> `文档` = 既有文档结论，未被本次实测推翻）。
> 本文不重复既有审计文档的叙事，也不把「设备才能闭环」写成「已完成」。

## 0. 一句话结论

AmOS 的**领域内核 + seam + Mock + 门禁**已经非常完备（`cargo check --workspace` 通过、
3366 个 `#[test]`/`#[tokio::test]` 标注、97 个门禁脚本全部在册），缺的不是"更多代码"，而是三类**接线与平台侧**
的东西：

1. **有内核、有 Rust 命令、但前端没有界面消费的半成品**（NFC / BLE / 云同步 / 远端推送 /
   双向沙箱 / 蜂窝信号 / 通话录音采集 / 企业模板库）——`unwired-*` 台账把它们逐条记着；
2. **平台侧交付物缺席**：可引导镜像、HAL/驱动、Doze/AlarmManager 的真机绑定、桌面端
   真实分发（Tauri 包/签名/更新）；
3. **消费级 App 的空缺**（健康/健身/股市/播客/图书/钱包/屏幕使用时间/AirDrop/多用户/OTA）。

---

## 1. 本次实测的仓库健康度

| 项 | 命令 | 结果 |
|---|---|---|
| Rust 全工作区编译 | `cargo check --workspace --message-format short` | ✅ `EXIT=0`（16.64s，增量） |
| Rust 未接线门禁 | `node scripts/rust-unwired-scan.mjs` | ✅ 585 文件 / 21 条已入账（0 新增）/ 1 个孤儿模块 |
| 门禁索引完整性 | `node scripts/gate-index-scan.mjs` | ✅ 97 脚本 / 97 行 |
| i18n 门禁 | `cd crates/amos-tauri/frontend-ts && node scripts/i18n-scan.mjs` | ✅ 全 OK（en/zh parity、无硬编码文案） |
| 前端未接线门禁 | `cd crates/amos-tauri/frontend-ts && node scripts/unwired-scan.mjs` | ⚠️ 审计开始时 **FAIL**（1 条 baseline 已接线未收缩），审计过程中已被收缩 ⇒ 现为 **OK**（详见下方说明） |

> **审计中发现的第一处状态变化（工程侧）**：审计开始时
> `crates/amos-tauri/frontend-ts/scripts/unwired-baseline.json` 里的
> `src/lib/backend.ts::realDial` 已经**被接线**（`unwired-scan --json` 报
> `fixedValues: ["src/lib/backend.ts::realDial"]`，`PhoneApp.svelte` 是它的消费者），
> 但台账没有收缩 ⇒ 该门禁退出码非零（按工具自身的 R2「棘轮必须收缩，不能腐坏」）。
> **本次审计过程中该条目已从 baseline 移除**，门禁现已为绿：
> `node scripts/unwired-scan.mjs` → 无 FAIL 行（该次输出的计数为 96 条；**2026-09-25 实测已收缩为
> 72 条：66 条仅测试引用、6 条无任何引用**，见 §2 证据），
> `git --no-pager diff --stat crates/amos-tauri/frontend-ts/scripts/unwired-baseline.json`
> 显示 `1 file changed, 1 deletion(-)`。
> 结论：这是一次**并发会话的棘轮收缩**，不是遗留待办；记录在此是为了说明"同一工作树上有多个
> 会话在同时改动"这一事实本身会影响任何一次审计快照的可复现性。

**规模基线（本次统计）**：49 个 workspace crate、10 个 `.proto` / 64 个 RPC、
288 个 `#[tauri::command]`、3366 个 `#[test]`/`#[tokio::test]` 标注、107 个 Svelte 组件、
253 个 `src/lib` TS 模块、34 个主屏 app tile（33 个有 Svelte 屏幕 loader）。

---

## 2. 缺口 A：有内核 / 有命令，但**没有界面消费**（半成品）

证据：`crates/amos-tauri/frontend-ts/scripts/unwired-allowlist.json`（模块级，带理由）、
`unwired-baseline.json`（2026-09-20 写作时为 96 条值导出无生产调用点、其中 82 条仅测试引用、14 条无任何引用；**2026-09-25 实测已收缩为 72 条：66 条仅测试引用、6 条无任何引用**）、
`scripts/tauri-command-allowlist.json`（命令已注册但无屏幕调用）。

| # | 缺口 | 现状（实测） | 缺的那一半 |
|---|---|---|---|
| A1 | **NFC** | `android-glue/.../NfcGlue.kt` + `lib/nfc.ts`（246 行，NDEF 编解码 + 标签读写/格式化 + 事件订阅）+ 13 个 `nfc_*` 命令 + `jni_glue.rs` 的 `take_tag`/`peek_tag` 都在 | ~~没有 NFC 屏幕~~ → **✅ 本轮已补（REQ-A610）：`src/svelte/NfcApp.svelte`（18 条 DOM 用例）**。13 条命令豁免已撤，模块豁免已撤 |
| A2 | **蓝牙 / BLE** | `BluetoothGlue.kt` + `BluetoothGattGlue.kt` + `lib/ble.ts`（GATT 客户端：扫→连→服务→特征→读/写/订阅）+ 7 个 `ble_*` 命令 | ~~没有 BLE 屏幕~~ → **✅ 本轮已补（REQ-A610）：`src/svelte/BleApp.svelte`（19 条 DOM 用例）+ `lib/ble.ts` 的三个纯值函数与 `bleSetNotifications`** |
| A3 | **云同步** | `lib/cloudSync.ts`：完整的**调度器**（间隔、Wi-Fi/电量门控、指数退避、4 个冲突解决器、指标） | **传输不存在**：`grep -in 'cloud\|sync' proto/*.proto` 只命中无关注释 ⇒ 既无云 RPC 也无宿主通道。台账明确拒绝"把本地重快照伪装成同步"，因为那会让 `totalBytesSynced` 报一次没发生的传输 |
| A4 | **远端推送** | `amos-tauri/src/push_notifications.rs`（677 行：APNs 载荷建模、token 台账、历史、12 个 `push_*` 命令，含 APNs 标准 kebab-case 键修复）+ `lib/pushNotifications.ts`（627 行） | **没有投递传输**：文件内无任何 HTTP/网络客户端，只有 `push_simulate_receive`（模拟接收）。`pushNotifications.ts` 有 **24 条导出**在 baseline 里。即：这是"APNs/FCM 形状的本地模型"，不是推送服务（无服务端、无 token 上报、无后台唤醒） |
| A5 | **双向沙箱（第三方 web-bundle 的能力发放）** | **已接线（REQ-A721，2026-09-20）**：`lib/sandboxBridge.ts` 是 deny-by-default 决策 seam；宿主半边已齐 —— postMessage 监听器 `lib/sandboxCapabilityHost.ts`（按 `event.source` **身份**绑定 frame，非 origin）+ `svelte/ExtAppHost.svelte` 挂载时 `installSandboxCapabilityHost` + daemon 卡点 `privacyBackend.daemonAuthorize` → `invoke("perm_authorize")` → `privacy.proto:105 Authorize` | ~~postMessage 监听器 + daemon 的 `perm_authorize` 卡点~~ = **过时判定，已接线**。**仍缺**：真实的第三方能力消费者（生态）与真机验证 —— 因此"无授予策略即 deny"仍是**正确的默认行为**，但不再是"监听器不存在"的结果 |
| A6 | **蜂窝信号/信号格** | **已补宿主半边（2026-09-25）**：`crates/amos-tauri/src/cellular.rs`（纯 fold `cellular_signal_from(supported, present, level)` + `cellular_signal` 命令）+ `TelephonyGlue.kt` 三个探针（`FEATURE_TELEPHONY` / `SIM_STATE_READY` / `getSignalStrength().level`，API 28+ 且 `READ_PHONE_STATE` 未授予时返 -1）+ `lib/cellularHost.ts`（`radioSignalFrom` 收窄 + `installCellularSignal`）+ `NotificationCenter.svelte` 挂载时安装 | ~~宿主命令不存在~~ = **过时判定**。`setCellularRadio` 的 allowlist 条目已因此撤销（棘轮收缩）；仍留 `clearCellularRadio` —— 目前没有诚实的清除时机（store 装的是**设备**的 radio 状态，窗口卸载不使它不成立）。**仍缺**：真机验证（本机无 `TelephonyManager`，桌面路径按 `supported:false` 走）。**注意**：`signal` 只在 `1..=4` 有值，`0`/越界/读不到一律 `None` ⇒ 同一条"无信号"文案 |
| A7 | **通话录音** | `crates/amos-tauri/src/recording.rs`（存储台账：m4a + JSON 索引、原子写、按 call_id 去重、8 个测试） | **采集半边不存在**：`crates/amos-telephony/src/android.rs:234/241` 明确返回 "requires a call-audio tap (audio pipeline, not yet wired)"。整个模块在 Rust 台账里以 `recording.rs::*` 记为一个 orphan |
| A8 | **企业模板库** | `svelte/modules/TemplateLibrary.svelte` + `templateManager` | **数据源没有生产者**：`syncTemplates`/`initializeEnterprise` 只有测试调用；今天挂载会渲染一个永久空屏（挂载它需要 MDM 同步生产者） |
| A9 | **MDM 配置加密** | **已交付且本轮加固（REQ-A1440 / F-SH-698）**：`lib/crypto/mdmCrypto.ts`（AES-GCM-256 + PBKDF2-SHA256 100k + 设备指纹，`__tests__/mdmCrypto.test.ts` 26 条）+ `lib/enterprise/mdm.ts` 的异步 `loadConfig`/`saveConfig` + 审计（`enterprise-mdm-boot.test.ts` 16 条） | ~~路线图全未勾选~~ = **文档滞后，不是实现缺失**；路线图已标注为"已交付的历史计划"。本轮补的是真缺口：**信封锁死时的行为** —— 原 `loadConfig` 把信封当明文解析，篡改/密钥变更 ⇒ 采纳垃圾配置（`isEnabled()` 静默 false，MDM 全线失效）且自动迁移把垃圾重加密覆盖原密文（`apiKey` 永久丢失）。现为：`isEncryptedEnvelope` 区分信封/明文，信封 + 解密失败或无 Web Crypto ⇒ **硬失败、保留原密文、写审计**；旧明文仍一次性迁移。**并隔离迁移的"写"**：原先迁移失败会冒泡进 `loadConfig` 的外层 catch，把**读成功**的明文配置一并丢弃（`this.config = null`）并记错原因（"加载失败"）；现迁移的 `saveConfig()` 有独立 try/catch + 独立审计，本次仍以明文运行（读失败与写失败是两回事，由新测试钉住）。`MDMPanel` 加「加密存储」卡片；卡片文案是**能力声明**（"保存时以 … 加密"）而非状态声明 —— 面板只能证实 "Web Crypto 存在"，证不出"盘上的字节是信封"（迁移被拒时就不是）。**仍未做**：路线图的性能基准（<10ms p99）、跨浏览器矩阵、Beta/Staging 部署；`ENTERPRISE_TODO_ITEMS.md` 的用户系统占位（`installedBy:"user"`、`userId:"system"`）未动 |
| A10 | **GPS/GNSS 前端入口** | `MapsApp.svelte:107/128` 与 `LiveSensors.svelte:139` 消费 `readGnss()`（Rust 真实现 `LocationManager#getLastKnownLocation` 已有 UI 出口） | ~~无生产屏幕消费、Maps 走 `navigator.geolocation`~~ = **过时判定**，已接线。**已清**：`gnssSnapshot`/`gnssStatus`/`gnssEnabled`/`gnssHasFix`/`sensorMode` 五个旧导出被 `readGnss`/`GnssRead` 取代且 0 生产读者（`gnssStatus` 的唯一调用者 `gnssSnapshot` 同批删除），2026-09-25 连同其测试一并删除；其中 4 条原在 baseline 里，故 baseline 76 → 72 |
| A11 | **hostFs 字节级读写** | **本轮已接线（REQ-A1443 / F-SH-699）**：`FilesApp.svelte` 主机浏览器每行 ⓘ 调 `hostFsStat`（新鲜 stat，`exists:false` 即"列表已过期"）、导出面板「保存到主机文件」把 `exportBundle` 文本按 UTF-8 经 `bytesToBase64` + `hostFsWriteBytes` 写入带时间戳文件名、主机标题栏「活动监视」计数读 `hostFsWatchList`。**补记（同轮复审计）**：文件名原为秒级时间戳，而 `host_fs_write_bytes` **没有 create-only 标志** —— 同一秒内的两次保存会落在同一路径，第二次**静默覆盖**第一次的产物（注释却写着"两次导出不可能同名"）；现加毫秒位，并由新用例冻结时钟验证同秒两次保存路径不同（去掉毫秒位该用例即失败）。**再补（同轮第三遍复审计）**：主机浏览器的三处"回包"都没有"列表是否还是当初那一个"的判据 —— 导航用的行按钮**从不 disabled**，所以按 ⓘ 后立刻进文件夹、或连点两个文件夹，读的答复会在用户离开之后到达，把 stat 卡片／`<pre>` 预览／甚至整个列表**画回**一个已经离开的目录（列表那处更隐蔽：面包屑与列表会一致地都指向旧目录，屏幕上没有任何东西看起来是错的）。三处均加判据：卡片与预览取请求时的 `hostCwd`（只在读**成功**时移动，故同目录的 watcher 重列不会误伤），列表用每次导航自增的 `hostNavGen`；被取代的回包不得清 `hostBusy`（新调用已接管该标志）。三条"延迟回包"负控用例均改前失败 | ~~0 生产调用点~~ = 三个符号已撤出 baseline（79 → 76）。`hostFsReadBytes` 早在 `lib/hostFileOpen.ts:88` 被消费，`hostFsWriteText` 在 `FilesApp.svelte:1363`（新建文件）被消费 —— 两项原本就已在生产 |

---

## 3. 缺口 B：**消费级 App 层面的空缺**

实测方法：在 `crates/amos-tauri/src` + `crates/amos-tauri/frontend-ts/src` 内对关键词做文件级 grep，
并与 `lib/appMeta.ts`（34 个 tile）/`svelte/appRegistry.ts`（33 个 loader）逐一对照。

| 功能 | 实测命中 | 判定 |
|---|---|---|
| 健康 (Health)、健身 (Fitness) | 无独立内核/App | ❌ 缺失 |
| 股市 (Stocks)、播客 (Podcasts)、图书 (Books/阅读) | `podcast` 0、`stocks` 0、`books` 0 | ❌ 缺失 |
| 钱包 / 支付 (Wallet) | `wallet` 1 命中（注释提及） | ❌ 缺失（无 NFC-SE / HCE / 支付框架） |
| AirDrop | `airdrop` 0（有 AirPlay：`airplay.rs`/`airplay_platform.rs`/`AirPlayPanel.svelte`） | ❌ 缺失（近场分享通路不存在） |
| 屏幕使用时间 (Screen Time) | `screen time` 0、`screenTime` 0（有 `focusPrefs`/`FocusPage`，语义不同） | ❌ 缺失 |
| 系统级分享面板 | 无 `navigator.share` / `ShareSheet`；`ios-parity-audit-status.md` 自述"现为剪贴板占位" | ⚠️ 占位 |
| 多用户 / 用户档案 | `multi-user` 0、`multiuser` 0 | ❌ 缺失 |
| OTA / 自更新 | `grep -rn 'updater' Cargo.toml crates/*/Cargo.toml` **零命中** | ❌ 缺失 |
| 打印 / 打印服务 | 无 PrintService / 打印面板（PDF 只做解析：`amos-pdf-parser`） | ❌ 缺失 |
| 全局剪贴板跨设备 | `clipboard*.rs`（含 guest/link）本地与容器通路已在 | ⚠️ 跨**设备**缺席 |

> 说明：**相机/相册/日历/时钟/计算器/电话/信息/邮件/文件/地图/天气/音乐/播放器/备忘录/
> 提醒/语音备忘录/终端/AI/同传/商店/PWA Hub/隐私/联系人/放大镜/监控/设备管家/
> 快捷指令/指南针/测距仪/浏览器(WebMan)/原生应用** 等 34 个 tile 都有真实屏幕（`实测`）。

### 3.1 浏览器（WebMan）的边界要说清楚

`WebManApp.svelte` + `lib/webman.ts` 是**真做了**的（标签/地址栏/书签/历史/下载面板/隐私模式/
快捷键/ErrorBoundary/i18n）。但它的内容承载是 **`<iframe sandbox>`（无 `allow-same-origin`）**，
不是浏览器引擎：

* **下载管线已经是真的**（REQ-A1170 校正本条）：Rust 侧 `crates/amos-tauri/src/webman_download.rs` 有
  streaming HTTP GET + 进度事件 + 取消 + 4 GiB 上限 + RFC 6265 cookie 罐；Android 的落点走
  MediaStore「下载」集合（`content://`），桌面走真实 Downloads 目录。仍然**没有的**是「拦截 iframe
  内链接点击发起的下载」——那是宿主 WebView 的事，属子 WebView 引擎范围。
* **`frame-src` 曾经把每一个远程站点都拦掉**（REQ-A1168 / F-SH-465）：壳 CSP 写的是
  `frame-src amos-app: http://amos-app.*`，不含 `http:`/`https:` ⇒ 桌面/平板内容区的
  `<iframe src={activeTab.url}>` 被自己的策略拒掉（F-SH-225 已证明该 CSP 运行时真生效）。已放开为
  `amos-app: http: https:`，并加门禁把「浏览器能导航的协议」与「CSP 允许嵌入的协议」绑在一起。
* 无 cookie/站点数据管理、无扩展、无书签/历史云端同步、无真正的权限对话框；
* 跨站登录态、`X-Frame-Options: DENY` 的站点、需要 Service Worker 的站点都会失败
  （sandbox 无 `allow-same-origin` ⇒ 不透明来源；被站点拒嵌时**有出路**：工具条「在外部浏览器中打开」）。

---

## 4. 缺口 C：平台 / 真机侧（host 无法闭环）

证据：`docs/device-bringup-checklist.md`、`docs/bottom-layer-os-audit.md`、
`docs/ios-parity-audit-status.md`（📱 段）、`crates/amos-telephony/src/android.rs`。

| # | 缺口 | 证据 |
|---|---|---|
| C1 | **通话中控制 / 来电注入 / 录音采集** | `amos-telephony/src/android.rs`：真机起呼走 `ACTION_CALL`+`tel:`；`answer`/`end`/录音/实时 status 显式 `Provider(...)` 未实现（应迁 `TelecomManager#placeCall` + InCallService/TelephonyCallback） |
| C2 | **相机 / IMU 流桥** | `amos-sensor` 的 GNSS 为真实现；Camera/IMU 需 `CameraDevice`+`ImageReader` / `SensorEventListener` 桥，当前返回显式 `Provider` 错误。`docs/device-bringup-checklist.md` 另记一个**已存在的真机缺陷**：授予 CAMERA 后 `CameraGlue/Nv21` 线程崩溃（DirectByteBuffer 访问）——已登记未修 |
| C3 | **电量/热/电压真采样** | `amos-profiling/src/android.rs` 只读 `CURRENT_NOW`，电压默认硬编码 3700mV（未接 `EXTRA_VOLTAGE`）；`with_voltage_mv` 在 Rust 台账里无人调用 |
| C4 | **原生音采集/回放** | 现在走 WebView `getUserMedia` + Web Audio；`amos-audio/src/android/{aaudio,tinyalsa}.rs` 的 FFI seam 已写但**未在真机验证**（`header_layout_notes` 也是 `host-missing`） |
| C5 | **AP / 热点** | `TetheringGlue.kt` 已接真 API，但公开 `TetheringManager` 自 **API 36** 才有、且需 `TETHER_PRIVILEGED`；`SoftApConfiguration` 的 SSID/口令是 `@SystemApi` ⇒ 非特权安装无法设置 SSID/口令（**平台限制，不是待办**） |
| C6 | **Doze / AlarmManager / JobScheduler 真绑定** | `amos-scheduler` + `amos-applife` + `Governor` gRPC 的**内核 + 闭环 + 服务化已落地**；缺的是把 `next_wake`/`due` 绑到真 `AlarmManager`/`JobScheduler` 与 Doze 广播（`docs/device-bring-up.md`） |
| C7 | **真机 GUI 验收** | 最新平板报告（`TABLET_OS_COMPLETION_20260920.md`）自述"未做真机 GUI 验证"；仓库有 `scripts/gui-smoke.sh`、`scripts/device-ui-eval.mjs` 作为实测入口 |

---

## 5. 缺口 D：底层 OS 职能（要分清"委托"与"自建"）

`docs/bottom-layer-os-audit.md` 的战略判定是：**真机底座 = no-UI Android**，驱动/HAL/LMK/Doze
属于**平台委托**，不应自造。按这个口径：

* **属于委托（不算缺口）**：Wi-Fi/BT/Modem 驱动与协议栈、PMIC、`lmkd`、Doze、RIL、
  `oom_score_adj -1000` 保活（`deploy/android/amos.rc` 已有）。
* **属于真缺口（只在"脱离 Android 的独立 OS"口径下成立）**：
  * 没有**可引导**能力：`deploy/android` 只有 init.rc 骨架 + 单 launcher APK，无内核/引导器；
  * `docs/bottom-layer-os-audit.md` 原文结论："AmOS 目前本质是跑在宿主 OS 之上、拥有整套领域
    内核 + seam + 诚实 Mock 的高层 UI/服务壳"；
  * `FUNCTIONAL_GAP_ANALYSIS.md` §二.J.40 同结论（"不是可引导 OS"）。

> 建议：把这条**在 README 与产品叙事里保持显式**。审计中最大的风险不是缺功能，而是
> "AI-first mobile OS"的对外说法与"Android 之上的系统 UI 壳"的实现之间的距离。

---

## 6. 建议的推进顺序

**P0（低成本、纯 host 可闭环，收益立刻可见）**

1. **保持棘轮为绿**：`realDial` 那条 baseline 条目在审计期间已被收缩（§1），
   留 P0 的意义是"每次审计后跑一遍 `unwired-scan`/`rust-unwired-scan`，别让棘轮腐坏"。
2. ~~**补两个屏幕，一次点亮 20 个命令**~~ → **✅ 本轮已完成（REQ-A610）**：NFC 屏（A1）与蓝牙/BLE 屏（A2）落地，
   撤销 13 条命令豁免 + 2 条模块豁免，`unwired` 棘轮 96 → 82，`tauri-command-scan` 豁免 31 → 18。
   下一个同等形态的候选是 **A3/A4 之前**先做的低风险项：`docs/ios-parity-audit-status.md` 里列的三个离线可测边角
   （列表语境一致性、秒表暂停态计圈、相机双击与点按锁定手势互斥）。
3. **让诚实默认值可解释**：蜂窝信号（A6）在无宿主形态下，UI 应显式写明"无基带读数"
   （仓库已用 `absent` 做到，只需在通知中心/设置里给出文案与 i18n）。
4. **修 C2 的相机崩溃**：这是**已发生的真机缺陷**（不是缺口），优先级应高于任何新功能。
5. **补真机 GUI 验收流程**：把 `gui-smoke.sh` + `device-ui-eval.mjs` 落成每次 bring-up 的固定步骤。

**P1（需要设计与外部依赖，别用 Mock 冒充）**

6. **云同步（A3）与远端推送（A4）要先定协议**：前者需要 `proto/` 里出现真正的同步 RPC 或宿主通道，
   后者需要投递服务器 + token 上报 + 后台唤醒对齐（与 C6 共用一条路）。
   **在两件事落地前，保持"台账登记 + 诚实不可用"是正确状态**——不要用本地重快照/模拟接收去
   "点亮"这两个功能。
7. **通话录音（A7）**：先落 audio tap（依赖 C4），再让 `recording.rs` 台账接上采集端；
   存储契约已经写好，不要重造。
8. **双向沙箱（A5）**：宿主半边**已接线**（REQ-A721，见 §2 A5 行）—— postMessage 监听器
   `lib/sandboxCapabilityHost.ts` 与 daemon `perm_authorize` 卡点均已存在（这条 P1 曾把两者列为
   缺失，与 §2 的"已接线"判定相矛盾，已一并订正）。**仍缺**的是真实的第三方 web-bundle
   消费者（生态）与真机验证 —— 这才是该生态当前的准入条件。

**P2（产品化，按需）**

9. 消费级 App：健康/健身 → 股市/播客/图书 → 钱包（**钱包建议暂缓**：金融合规与 SE/HCE 硬件依赖）。
10. **OTA / 自更新**：桌面端先做（Tauri updater + 签名），Android 侧走 PackageInstaller；
    当前发布脚本（`scripts/release-artifacts.sh`）只交付 8 个无头二进制的 tarball，不含 Tauri 包/APK。
11. 多用户 / 屏幕使用时间 / AirDrop（后者需要近场传输栈，建议放最后）。

**不建议做（避免重复造轮子）**

* HAL/驱动/RIL/PMIC/协议栈：平台已提供（`docs/no-ui-android.md`）；自造反而危险。
* 给 daemon 再加更狠的保活：`oom_score_adj -1000` + UDS 心跳 + `amos-supervisor` 已在，
  缺的是**应用层**生命周期使用者（`Governor` 已服务化，缺宿主注册真实 App）。
* 重写已成熟的领域内核（radio/telephony/sensor/audio/profiling/appstore/…）：缺口在"真机 provider
  接线 + 装配"，不在内核。

---

## 7. 证据索引

| 主题 | 证据文件 |
|---|---|
| 半成品台账（前端） | `crates/amos-tauri/frontend-ts/scripts/unwired-allowlist.json`、`unwired-baseline.json` |
| 半成品台账（Rust） | `scripts/rust-unwired-baseline.json`、`docs/rust-unwired-audit.md` |
| 命令无调用方（台账） | `scripts/tauri-command-allowlist.json`（含 13 条 `nfc_*`/`ble_*`） |
| 门禁总索引 | `docs/GATES.md` + `scripts/gate-index-scan.mjs` |
| 底层职能/委托口径 | `docs/bottom-layer-os-audit.md`、`docs/no-ui-android.md` |
| 真机待办 | `docs/device-bringup-checklist.md`、`docs/device-bring-up.md`、`docs/qcom-mtk-bringup.md` |
| iOS 对齐剩余缺口 | `docs/ios-parity-audit-status.md` |
| 全量历史缺口 | `FUNCTIONAL_GAP_ANALYSIS.md`（§二 J.40 定位、§三 未完成项） |
| 浏览器边界 | `WEBMAN_COMPLETION_FINAL_2026_SEP20.md`、`crates/amos-tauri/frontend-ts/src/svelte/WebManApp.svelte` |
| 推送建模（无传输） | `crates/amos-tauri/src/push_notifications.rs` |
| 通话录音（无采集） | `crates/amos-telephony/src/android.rs:234,241`、`crates/amos-tauri/src/recording.rs` |
| 云同步（无传输） | `crates/amos-tauri/frontend-ts/src/lib/cloudSync.ts`（`proto/` 无对应 RPC） |
| 企业待办 | `ENTERPRISE_TODO_ITEMS.md`、`MDM_ENCRYPTION_ROADMAP.md` |

---

**审计人**: Cline（本次会话 · 只读审计 + 报告）
**实测时间**: 2026-09-20
**未做**: 未修改任何生产代码；未收缩 baseline；未做真机验证（无设备）。
