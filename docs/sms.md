# 真实短信（SMS）— 领域与接入

AmOS 的“信息”此前只有本地演示会话。本页定义把 **真实短信**（读设备收件箱 / 发送）端到端接起来的架构与进度，遵循仓库 `domain + Provider seam (Mock / Android)` 范式（对照 `amos-flashlight`、`amos-telephony`）。

## 数据流（目标形态）
```
Android SmsGlue (Kotlin)
   read content://sms 收件箱 / SmsManager.sendTextMessage
   ├─ JSON (threads / messages)
   ▼
amos-sms AndroidSmsProvider (jni, android feature)  ──► SmsProvider trait
amos-sms MockSms (host/tests)
   ▼
amos-tauri sms bridge (Tauri command: sms_snapshot / sms_send)
   ▼
前端 MessagesApp：桥接真机时展示真实线程；离线(host)退回本地会话
```

## 已落地（可在本机全面测试）
- **`crates/amos-sms` 领域 crate**（`docs` 之外新增）：
  - `spec.rs`：`SmsThread` / `SmsMessage`（id/address/display_name/last_text/ts/unread；thread_id/from_me/read）。
  - `error.rs`：`SmsError::{Unavailable, Failed, Invalid}`。
  - `provider.rs`：`SmsProvider` trait（snapshot / messages / send）；`MockSms`（`new()`=空收件箱·诚实“host 无短信”；`seeded()`=固定演示收件箱，仅开发/测试）。
  - `wire.rs`：纯 JSON 契约解析 `parse_snapshot` / `parse_messages`（缺字段/坏类型一律 `Invalid`，绝不伪造）。
  - 测试 **6 例** 全绿；`cargo fmt`/`clippy -D warnings` 干净。
- workspace 注册该 crate。
- **`amos-tauri` SMS 桥**（`src/sms.rs`）：`SmsBridge`（host= `MockSms::new()` 空收件箱·诚实；`with_provider` 供设备/测试）+ 命令 `sms_snapshot` / `sms_messages` / `sms_send`（`send` 成功返回 `"sent"` 以便区分成功/错误/离线）；序列化镜像 `SmsThreadOut` / `SmsMessageOut`。lib.rs 已 `manage` + 注册。测试 **3 例**（host 空 inbox / seeded 映射 / send 拒空）全绿；`clippy`/`fmt` 干净。
- **前端桥函数**（`lib/backend.ts`）：`smsSnapshot()` / `smsMessages(threadId)` / `smsSend(address,text)`（离线返回 `null`/`false`，绝不伪造）。

## 已接入（设备侧，待真机验收）
1. **`amos-sms` Android provider**：`src/android.rs::AndroidSmsProvider`（`feature android = ["dep:jni"]`，仅设备构建拉 jni）。持有 `JavaVM` + Kotlin `SmsGlue` 全局引用，经 JNI 调实例方法 `snapshot()` / `messages(threadId)` / `send(address,text)`，一律 String↔String JSON，再用 `wire.rs` 解析（send 回 `{"ok":true}` / `{"error":…}`）。门禁：`cargo check -p amos-sms --features android`。
2. **Kotlin `SmsGlue.kt`**（`crates/amos-tauri/android-glue/com/amos/ai/glue/`）：`bind(context)` 存 `applicationContext` 并 `external fun attach(this)` 上升给 Rust；`snapshot()` 查 `content://sms` 按 `thread_id` 聚合（最新一条 + 未读计数，newest-first 单次扫描）、`messages(threadId)` 按 `date ASC`、`send()` 走 `SmsManager.sendTextMessage`（API31+ `getSystemService`，否则 `getDefault()`）。无权限/异常→诚实空结果或 `{"error":…}`，绝不伪造。
3. **权限**：`AndroidManifest.permissions.xml` 声明 `READ_SMS` / `SEND_SMS` / `RECEIVE_SMS`；`AmosGlue.onStart` 内 `startQuietly("sms") { SmsGlue.bind(...) }`（首个 bind 早于授权也没关系：glue 在调用时检查权限，授权后即生效，无需重绑）。
4. **amos-tauri 设备装配**：`src/sms.rs` 的 `#[cfg(feature="android")] mod device` 提供 `DEVICE: OnceLock<Arc<dyn SmsProvider>>` 与 JNI upcall `Java_com_amos_ai_glue_SmsGlue_attach`（照 media/flashlight 的 exactly-once 安装）；命令经 `active(&state)` **设备优先**解析 provider，否则回退 host `MockSms`。`Cargo.toml` 的 `android` feature 已含 `amos-sms/android`。门禁：`cargo check -p amos-tauri --features android`。
5. **MessagesApp 接真实线程**：`$effect` 探一次 `smsSnapshot()`；有真实线程则切换为真实收件箱（每个 thread → 会话，选中即 `smsMessages()` 载入），发送走 `smsSend(address,text)` 成功后重载线程，并在标题显示 `📡 真实短信` 标识、隐藏本地“新建/删除会话”入口；无真实 SMS（host/离线）完全退回原有本地会话，行为不变。

### 本机验证（已完成）
- `cargo test -p amos-sms`（6 例）+ `cargo check -p amos-sms --features android` + `clippy -D warnings` 全绿。
- `cargo test -p amos-tauri --lib sms::`（3 例）+ `cargo check -p amos-tauri --features android` 全绿。
- 前端：`bun run test` / `typecheck` / `typecheck:svelte`（0 error）与 `test:svelte` **355 例**（含新增“桥接后显示真实线程”用例）全绿。
> 注：本机只能证明“编译/契约/前端行为”；真实收件箱读取与发送必须在 Android 设备上验收。


## 真机验收结果（2026-09-10，YY000286 / S5，arm64 debug）
已装 APK 并逐项验证（`adb` + WebView CDP 实调命令/读 DOM）：

- [x] 权限：`adb install -g` 后 `READ_SMS` / `SEND_SMS` 均 `granted=true`。
- [x] 读收件箱：`sms_snapshot` 返回真实线程（如 `10010` 未读 2、`18516766470`、`+8610655777` 等），含最近一条与未读计数。
- [x] 读线程：`sms_messages` 返回真实往来（`from_me` / `ts_ms` 正确），UI 中切换会话即加载（18516766470 → “现在无法接听。有什么事吗？”）。
- [x] 发送路径：空地址调用 `sms_send` → `SMS operation failed: Invalid destinationAddress`（Kotlin → Rust → 命令 → JS 全链路真实到达 `SmsManager`，诚实报错不伪造）。
- [x] UI：打开“信息”显示真实线程 + `📡 真实短信` 标识 + 真实消息气泡 + 发送输入框；`sms_messages` 参数键为 camelCase。
- [ ] **真正发出一条短信**：留给你在 UI 输入并点发送（会真实发送/计费，故由你确认目标后再做）。
- [ ] 收新短信后刷新：点“刷新”重读当前会话。

### 加固版真机复核（2026-09-10，YY000286 第二次装机）
- [x] `sms_status` → `{"provider":"android-sms","device":true}`（UI 据此进入真实态）。
- [x] 有界快照：`sms_snapshot` 返回 7 个真实线程（含新收到的“刚刚好 10:00”），未再全表扫描。
- [x] `sms_messages` camelCase `threadId` → 线程消息正常（交叉校验通过）。
- [x] **边界校验**：`sms_send(address="abc")` → `invalid SMS payload: invalid character 'a' in SMS address`；空正文 → `invalid SMS payload: blank SMS text`——均在域层拒绝，**未触达 `SmsManager`**。
- [x] **诚实权限态**：`pm revoke READ_SMS` → 重启后信息页显示「短信权限被拒绝 / 请在系统设置中授予后重试 / 重试」，既不是假空收件箱也不是本地演示会话。
- [x] **恢复**：`pm grant READ_SMS` 后点「重试」→ 立即回到真实收件箱（`📡 真实短信` + 线程 + 消息）。
- [ ] 真正发出一条短信：仍留给你在 UI 确认目标后执行（会真实发送/计费）。

1. **Tauri 参数命名**：`sms_messages` 必须传 **camelCase `threadId`**（Rust 参数是 `thread_id`）；原先 `backend.ts` 传 `thread_id` 被拒（`missing required key threadId`），导致线程消息读不出（UI 显示“无法读取该会话”）。已在 `lib/backend.ts` 修正并加测试断言锁定。
2. **真实数据混入本地会话/通知 `$effect`** 会在真机 shell 下引发整窗卡死：改为**独立真实态**，本地会话与通知同步完全不受影响，离线行为不变。
3. 另注（非应用缺陷）：重装 APK 后偶发 `SandboxedProcessService ... process is bad`，WebView 渲染沙箱需重启设备才恢复；属设备侧 WebView 状态，重启后一切正常。

## 工程加固（航空航天级审计，2026-09-10）
按“**有界 · 诚实 · 可审计 · 可测试**”四条准则逐层加固，全部在本机确定性验证；设备侧仍按上文清单复核。

### 1. 输入校验与分段（`crates/amos-sms/src/validate.rs`，新增）
- `normalize_address`：剥离 `- 空格 ( ) .`，保留首个 `+`；位数 3..=20（E.164 ≤15、短号更短）；非数字/纯 `+`/`+` 非首位一律拒绝。返回**规范化地址**，杜绝把用户原串直接交给基带。
- `validate_text`：拒绝空、NUL、>1600 字符（≈10 段）；超出**报错而非静默截断**（截断会篡改用户消息）。
- `is_gsm7` / `segment_count`：GSM 03.38 七位字母表判定 → 160/153 段；其余 UCS-2 → 70/67 段（非 BMP 字符按 2 个 UTF-16 单元计）。桥层用它产出审计用的段数。

### 2. 线协议有界 + 类型化错误（`wire.rs`）
- 尺寸/数量上限：载荷 4 MiB、线程 500、消息 1000、单条正文 16 KiB；**超限即 `Invalid`**（协议违规，不静默截断）。
- 取值范围：时间戳必须 ≥0（负值渲染成假日期）；`id`/`address` 不得为空。
- `{"error":…,"error_kind":…}` → 类型化错误：`permission`→`PermissionDenied`、`unavailable`→`Unavailable`、`invalid`→`Invalid`，其余→`Failed`；**错误绝不等价于“空收件箱”**。
- `parse_messages_for(payload, expected)`：回包线程 ID 必须等于请求 ID（否则会静默显示**别的会话**）。
- `parse_send_reply`：只有 `{"ok":true}` 才算成功；`{}`/畸形回包 → `Invalid`，**永不假设已发送**。

### 3. 桥层：不阻塞 UI、硬超时、审计（`crates/amos-tauri/src/sms.rs`）
- 命令改为 `async`，provider 调用经 `tauri::async_runtime::spawn_blocking` 卸载到阻塞池，并套 `tokio::time::timeout`（**8s**）。理由：Tauri 的**同步**命令跑在主线程，而 ContentResolver/JNI 是阻塞调用——否则大收件箱查询会冻结整个 WebView。超时后调用方得到诚实错误（阻塞任务无法取消，但不再拖住 UI）。测试用 50ms 超时 + 500ms 阻塞闭包验证。
- 新增 `sms_status`（无 I/O）返回 `{provider, device}`，让 UI 能区分**真机后端**与**宿主 mock**（后者不是“空收件箱”）。
- `sms_send` 先做域校验（规范化地址 + 正文 + 段数），再下发；成功/失败各记一条 `tracing` 审计日志，地址**掩码**为 `***后四位`，正文永不入日志（隐私）。
- `SmsProvider` 增加 `name()`（`"mock"` / `"android-sms"`，常量 `MOCK_PROVIDER`）。

### 4. Kotlin glue（`SmsGlue.kt`）
- **有界查询**：`snapshot()` 单次 `date DESC LIMIT 4000` 窗口内推导“每线程最新一条 + 未读计数”（不再全表扫描）；输出受 `MAX_THREADS` 约束。文档明确：仅统计窗口内的未读（**有界并已声明**的取舍，而非静默）。
- `messages()`：线程 ID 必须为 ≤20 位纯数字；`date DESC LIMIT 1000` 取最新后**反转为时间序**，并在回包中回显 `thread_id` 供 Rust 交叉校验。
- `send()`：先查 `SEND_SMS` 权限；地址/正文按域规则复校；用 `SmsManager.divideMessage` **真分段**（>1 段走 `sendMultipartTextMessage`）；`SecurityException`→permission、`IllegalArgumentException`→invalid、其余→failed。
- `SmsPermissions`（READ/SEND）与 `MediaPermissions` 同构；所有失败返回 `{"error":…,"error_kind":…}`，不再把异常吞成“空收件箱”。

### 5. 前端状态机（`backend.ts` + `MessagesApp.svelte`）
- `smsStatus()` + `smsSnapshotResult()`：把「成功（可能为空）」「权限被拒」「其它失败」「未桥接」区分开。
- UI 三态：`device=false`（宿主 mock）→ 保持本地会话；“真实收件箱为空”→ **本机暂无短信**（不显示本地演示会话）；读取失败 → 红字错误 + 授权提示 + 「重试」按钮（重试会重新探测后端状态）。读取期间按钮置灰（`smsBusy`）。

### 6. 收发能力补全（2026-09-10）
- **推式接收（真正“收”）**：`SmsGlue` 双保险注册 `SMS_RECEIVED`：
  1. **动态接收器**（`bind()` 内，API 33+ 用 **`RECEIVER_EXPORTED`**——实测 `NOT_EXPORTED` **收不到**该广播）；
  2. **清单接收器** `SmsReceiver`（`android:exported="true"` + `android:permission="android.permission.BROADCAST_SMS"`），进程未运行时也能被系统唤起。
  两者都经 JNI upcall `SmsGlue.onIncoming(address)` → Rust `sms::events` 用 `AppHandle` 发射 `sms-received`（负载只含平台给出的发件人，缺省空串）→ 前端 `subscribe("sms-received")` **重读**收件箱**并重载当前打开的会话**（新消息立即出现在打开的聊天里）。
- **新短信撰写**：真机态顶部「新短信」工具条 → 收件人 + 内容 → `sms_send` → 成功后重读收件箱；系统会把已发送短信写入 provider，新线程自动出现。
- **探测竞态修复**：`sms_status` 可能在 Kotlin `Attach` 之前返回（glue 在 Activity `onStart` 注册），原先一次性探测会**永久停在本地会话**；改为**有界重试**（4 次 × 1.5s，无无限轮询），之后诚实地落到 local。
- **UI 结构**：真机态顶部固定「新短信 / 刷新」工具条；其下三态（错误 / 空收件箱 / 线程面板）。

### 6b. 顺带修复的两个**跨领域**前端缺陷（本次真机调试发现）
1. **`window.__TAURI_INTERNALS__.listen` 并不存在**（Tauri v2 只注入 `invoke`/`transformCallback`）。原 `backend.ts::bridge()` 直接转发 `listen`，调用即抛错并被 `try/catch` 吞掉 → `subscribe()` 与 `wm.onLayoutChanged()` **全部静默失效**。现由 `bridge()` **合成** `listen`：优先宿主自带，否则走事件插件 `plugin:event|listen` + `transformCallback`（与 `@tauri-apps/api` 同款），`plugin:event|unlisten` + `unregisterCallback` 取消。
2. **缺少 capabilities → 事件插件被 ACL 拒绝**：真机报 `event.listen not allowed. Permissions associated with this command: core:event:allow-listen, core:event:default`。新增 `crates/amos-tauri/capabilities/default.json`（`windows: ["*"]`，`permissions: ["core:event:default"]`）。这同时**解除了所有事件驱动 UI 的封锁**（sms-received / ai-token-received / sensor-data / layout-changed / telephony-event / store-updated 等）。

### 7. 真机实测：真实的“发 + 收”闭环（2026-09-10）
用 `service call iphonesubinfo 15` 解出本机号码 **+8618616091470**，随后：
1. 经 App 命令发送 `AmOS self-test <ISO 时间>` → 返回 `sent`（真实 `SmsManager`）。
2. 约 2s 后回环到达：线程 id 9，消息 `id=11 from_me=true`（我方发出）+ `id=12 from_me=false read=false`（收到），线程 `unread=1`。—— 证明**发送、入库、接收、读取**四条路径均真实工作。
3. **推式接收（无手动刷新）**：打开该会话后经命令发送 `LIVE4-…`，logcat 显示 `SmsGlue: SMS_RECEIVED from '18616091470'`，WebView 原始事件计数 +2，**DOM 自动出现新收到的消息**。
4. **UI 撰写**：点「新短信」→ 填号码/内容 → 发送 `UISEND-…`，provider 中出现 `from_me=true` 与回环 `from_me=false` 两条，DOM 同步可见。

### 9. 文件夹全面实现：收件箱 / 发件箱 / 草稿（2026-09-10）
Android 把所有短信放在一张表里，用 `type` 打标签；文件夹就是该标签。本次把这一模型贯通全栈：

| 层 | 实现 |
|---|---|
| 域 | 新增 `crates/amos-sms/src/folder.rs`：`SmsFolder{Inbox,Sent,Draft}`（wire 名 `inbox/sent/draft`，`android_type()` = 1/2/3，`from_wire` 未知值**诚实报错**）+ `SmsFolderCounts`。`SmsProvider` 契约改为 `snapshot(folder)` / `messages(thread_id, Option<folder>)` / `counts()`；Mock 改用**单一数据源**（`seeded_rows()`）派生三个文件夹的线程、消息与计数（收件箱才有未读，发件箱/草稿永不“未读”） |
| 线协议 | `parse_counts()`（`{"inbox":n,"sent":n,"draft":n}`，缺省 0）；线程/消息解析沿用既有加固（上限、越界、错误类型、线程交叉校验） |
| 桥 | `sms_snapshot(folder)`、`sms_counts`、`sms_messages(threadId, folder?)`；文件夹名在桥层解析（非法值在调用 provider 前就被拒）；仍为 `async` + `spawn_blocking` + 8s 超时 |
| Kotlin glue | `snapshot(folder)` 按 `type = ?` 过滤（含 `LIMIT` 有界窗口，未读只在收件箱统计）；`messages(threadId, folder)` 叠加 `type` 过滤（空文件夹=整段会话）；`counts()` 三个有界的去重线程计数；未知文件夹 → `error_kind:"invalid"` |
| 前端 | `smsFolderSnapshot(folder)` / `smsCounts()` / `smsMessages(threadId, folder)`；`MessagesApp` 增加文件夹标签（含计数）、切文件夹即重读该文件夹的线程与消息 |
| **草稿** | 系统草稿（`type=3`）由平台写入，**只有默认短信应用能写**；因此 AmOS 草稿存在本地（`lib/smsDrafts.ts`，纯函数 + 上限 + 去重，一个地址一条草稿），UI 明确标注「AmOS 草稿（写入系统草稿需将 AmOS 设为默认短信应用）」；若设备本身有系统草稿，则另列一节「系统草稿（只读）」。草稿标签计数 = 平台草稿线程数 + 本地草稿数（两者都真的可见，不为凑数） |

**真机验收（YY000286）**：`sms_counts → {inbox:7, sent:2, draft:0}`；UI 标签「收件箱7 / 发件箱2 / 草稿」；发件箱只列已发送消息（不含回环收到的）；草稿页显示说明与「暂无草稿」；新建草稿后标签变「草稿1」且列表可见；点草稿→编辑器预填→发送→**草稿被消费**（回到「暂无草稿」）且该文本真实出现在发件箱（`from_me=true`）。

**工程保障**：新增 `make android-app`，把「先 `bun run build` 再 `tauri android build` 再 `adb install -g`」固定成一条命令——本轮真机上曾因忘记重建 `dist` 而装出旧 UI（`tauri.conf.json` 的 `beforeBuildCommand` 为空，构建会原样嵌入既有 `dist/`），该目标专门防止这类回归。

### 11. 骚扰拦截（黑名单）：来电 + 短信（2026-09-10）
按仓库 `domain + Provider` 惯例新增独立域 crate 与三处执法点，规则只有**一处真相**：

| 层 | 实现 |
|---|---|
| 域 `crates/amos-blocklist`（新增） | `Rule{pattern, kind∈exact\|prefix, channel∈call\|sms\|both, label}` + `Blocklist`：号码规范化（`+`/分隔符/`00`/前导 0）、**同号等价匹配**（`+8618616091470` ≡ `18616091470` ≡ `8618616091470` ≡ `0086…`，只允许丢弃 1–3 位前导国家码，绝不误并无关号码）、前缀规则最短 3 位、未知/隐藏号码开关、一地址一条去重、上限 500（超限淘汰最旧）、JSON 往返且**不信任**损坏文件（版本/非法规则/超限 → 诚实报错） |
| Rust 桥 `amos-tauri/src/blocklist.rs` | 进程级共享状态（命令 / SMS 过滤 / JNI 三处共用）；命令 `blocklist_snapshot/add/remove/clear/set_unknown/check`；持久化到 `app_data_dir/blocklist.json`（临时文件 + rename 原子写；损坏文件记日志后以空表启动，不崩） |
| **短信执法** | `sms_snapshot` 过滤被屏蔽发件人（带 `hidden` 计数日志）；`sms_messages(threadId, folder, address)` 命中规则即拒绝（诚实报错并指出规则）；**实时收信**在 JNI upcall 里先查黑名单，命中则**不发事件**（不通知、不刷新）；文档明确边界：系统短信库由默认短信应用拥有，AmOS 无法删除行 |
| **来电执法** | Kotlin `AmosCallScreeningService`（`CallScreeningService` + 清单声明 `BIND_SCREENING_SERVICE`）对每个来电询问 Rust（JNI `BlocklistGlue.shouldBlockCall`），命中则 `disallowCall+rejectCall+skipNotification` —— **系统级拒接**；`BlocklistGlue` 自身可 `configure(filesDir)`，因为系统可能为一次来电冷启动进程。原生不可用时**失败开放**（不静默拦截所有来电） |
| 权限/角色 | 来电拦截需系统 `ROLE_CALL_SCREENING`：`BlocklistGlue.requestScreeningRoleIfNeeded` 在「存在来电规则且未授权」时于启动后请求（系统弹窗）；`AmosGlue.onStart` 调用 |
| UI | 电话 App 第 5 个标签「拦截」：号码 + 精确/前缀 + 来电/短信/两者 + 加入/移除、未知号码开关、角色说明；`smsDrafts` 之外的 i18n 中英 |

**真机验收（YY000286）**：
- `CallScreeningService` 已注册：`dumpsys package` 显示 `com.amos.ai/.glue.AmosCallScreeningService` + `android.telecom.CallScreeningService` + `BIND_SCREENING_SERVICE`。
- 黑名单生效：加入 `1069`（前缀/短信）与 `+8618616091470`（精确/短信）后，收件箱 **7 → 3**（3 个 1069 号段 + 本机号被隐藏）。
- 持久化：重装 + 重启后 `blocklist_snapshot` 仍有这两条规则（读自 JSON 文件）。
- 读取拒绝：对被屏蔽线程 `sms_messages` 返回 `blocked by rule: …`（含规则 id/pattern/channel）。
- **实时抑制**：被屏蔽号码来信 `sms-received` 事件 **0 次**（未屏蔽时为 2 次，动态+清单两个接收器），UI 不刷新、不通知；移除规则后再发 → 事件恢复、线程回归（3 → 4）。
- 号码等价（真机发现并修复的缺陷）：网络把回环短信给成国内格式 `18616091470`，而规则是 `+8618616091470` —— 修前 `blocklist_check("18616091470")` 为 `null`，修后命中同一条规则（`same_number` 容忍国家码/前导 0）。
- UI：电话 App 出现「拦截」标签，规则列表（`1069 · 前缀 · 仅短信 · bulk`）、未知号码开关、移除均可用；移除后列表为空（测试规则已清理）。

#### 11.1 审计修复：来电拦截页"不正常"的根因（2026-09-10）

真机反馈「拦截（电话）页面不正常」，逐层审计出四个缺陷并修复：

1. **规则库被拆成两个目录（严重）。** `lib.rs::setup` 持久化到 `app_data_dir()`，而在 Android 上 Tauri 的该路径等于 `Context.getDataDir()`（`…/<pkg>`，见 `tauri-2.11.5/mobile/android/.../PathPlugin.kt` 的 `getDataDir → activity.dataDir`）；Kotlin `BlocklistGlue.bind` 却配置 `Context.filesDir`（`…/<pkg>/files`）。`BlocklistState::configure` 会**替换**路径并重新载入，于是两处互相覆盖；而 `MainActivity` 只在**授予 CAMERA** 时才调 `AmosGlue.onStart` → 未授相机时 UI 停在 `dataDir`、来电筛选服务用 `filesDir`，**UI 加的规则永远到不了来电拦截**。修复：`lib.rs` 在 Android 上把 `files` 追加到 `app_data_dir()`，与 glue 收敛到**同一个文件**，`configure` 因此幂等（早返回、不再清空内存表）。
2. **来电筛选角色不可见、且只有后台申请路径。** UI 无法知道是否真持有 `ROLE_CALL_SCREENING`，而唯一申请来自应用上下文的 `startActivity`（受 Android 10+ 后台启动限制，可能静默失败）。修复：新增命令 `blocklist_status`（`has_call_rules/has_sms_rules/role_supported/role_held/role_requestable`，经 JNI 调 Kotlin `screeningRoleSupported/screeningRoleHeldBound`）与 `blocklist_request_role`（前台显式申请，`requestScreeningRoleBound`）；UI 增加状态横幅与「授予来电筛选权限」按钮。
3. **诚实错误被丢弃。** `addBlockRule/loadBlocklist/toggleBlockUnknown` 只有 `.then()` 没有 `.catch()`，而 Tauri 对域拒绝是 **reject** → 非法号码**不报任何错**、快照失败显示空列表。修复：全部改为 `async/await + try/catch`，非法规则显示本地化原因，保存失败回滚开关，并加 `blockBusy` 防重复提交。
4. **缺少一键入口。** 通话记录「最近」行新增「拦截」按钮：一键写入 `exact/both` 规则并切到拦截页（命令层早已就绪）。

另外：`MainActivity.onStart` 现在**无条件** `BlocklistGlue.bind(applicationContext)`（不再受相机授权门控），保证路径一致与 JNI 角色可达；`MainActivity.Wiring.kt` 记录该接线以便 `tauri android init` 重生成后重新挂上。

#### 11.2 「信息」页屏蔽此号码（2026-09-10）

真机在线程页给出与通话记录对称的**一键入口**——但只对**真机后端**开放（离线/宿主态会话按名字而非号码组织，写入号码规则没有意义，诚实起见不显示该入口）：

- 打开的真机线程标题栏右侧新增「屏蔽此号码」按钮（`aria-label="block-sender-<address>"`），点击写入 `exact/both` 规则到**同一共享规则库**（电话「拦截」标签、`sms_snapshot` 过滤、`CallScreeningService` 三处同源）。
- 结果**显式可见**：成功 → 状态条「已屏蔽 <addr>：其短信不再显示，来电将被拒接」（`data-ok="true"`）；失败（`blocklist_add` 被域拒绝，`invoke()` 吞成 `null`）→ 红色 `role="alert"`「屏蔽失败，请重试」并 `bridgeDiag()` 留证。绝不静默假装已屏蔽。
- 成功后线程在刷新时被 `sms_snapshot` 过滤消失（当它是最后一条线程时显示「本机暂无短信」），状态条**留在列表上方**解释原因，不会让用户以为数据丢失。

### 11.3 真机（YY000286 / S5 / API 34）审计：两个真实缺陷（2026-09-10）

用 WebView DevTools 协议直连真机页面（`adb forward tcp:9401 localabstract:webview_devtools_remote_<pid>` → CDP `Runtime.evaluate`）逐屏驱动 UI 后，发现并修复：

1. **「拦截」标签把整个「紧急号码」页渲染在拦截面板之上（用户报的「拦截页面不正常」的真因）。** `PhoneApp.svelte` 的标签链 `{#if calling}{:else if keys}{:else if recent}{:else if frequent}{:else}` 以**裸 `{:else}`** 结尾，拦截面板另起一个独立的 `{#if tab === "block"}`，于是 `tab === "block"` 时**两个分支同时成立** —— 紧急呼叫 110/119/120/122/112 整页 + 「紧急号码」标题出现在黑名单列表上方。修复：末端改为 `{:else if tab === "emergency"}`，并把拦截面板并入同一链 `{:else if tab === "block"}`，结构上不可能再共渲染。真机复验：拦截页只剩黑名单面板（无「紧急号码」/「紧急呼叫 110」）；「紧急」标签仍正常。
2. **「授予来电筛选权限」按钮谎报成功、系统对话框不出现。** `blocklist_request_role` 返回 `true`，但 `role_held` 仍为 `false`。两层原因：(a) 角色对话框用 **application context** 的 `startActivity` 启动，被 Android 10+ 后台启动规则吞掉；(b) 即使改从 Activity 启动，普通 `startActivity` 不建立 caller 身份，PermissionController 立刻记 `RequestRoleActivity: Package name cannot be null or empty: null` 并在 ~100 ms 内 self-finish。修复：`MainActivity.onStart` 通过新的 `BlocklistGlue.attachActivity(this)` 交出前台 Activity，`BlocklistGlue.requestScreeningRole(activity)` 改用 **`startActivityForResult`**（建立 caller 身份），并在 `screeningRoleIntent` 里补 `Intent.EXTRA_PACKAGE_NAME`（部分 ROM 读取该 extra）。真机复验：点按钮 → 出现系统「要将Amos设为您的默认来电显示和骚扰电话屏蔽应用吗？」→ 选 Amos + 设为默认应用 → `role_held` 变 `true`，页面横幅变为「来电拦截已生效（已获系统「来电筛选」权限）。」；随后 `cmd role remove-role-holder` 反向验证 `role_held` 回到 `false`（状态链路诚实）。

其余真机确认（同一轮）：

- **一键拉黑（信息页）**：真机线程页点「屏蔽此号码」→ 规则写入共享库（`blocklist_snapshot` 得 `+8618616091470/exact/both`）→ 该发件人被 `sms_snapshot` 过滤、**线程从收件箱消失**（7 → 6）→ 状态条「已屏蔽 +8618616091470：其短信不再显示，来电将被拒接」。
- **拦截页增删/校验**：输入 `1069` 加入黑名单 → 规则即时出现且持久化；输入 `abc` → 诚实报「号码无效：至少 3 位数字（可带开头 +）」，不静默失败；未知号码开关可切「已开」。
- **通话记录**：注入 4 条记录（去电/来电/未接/旧记录无方向）→ 方向图标（↗/↙/红↙/•）+「今天|昨天|YYYY-MM-DD HH:MM」全部正确；方向筛选收窄行数；两段式清空可取消、可确认，确认后持久化为空并回到空态。
- **UI 打磨（真机量测）**：拦截页号码输入框由 **65×32 → 336×36**（原单行布局在 360px 宽屏上连占位符都放不下）；通话记录行内动作由 **32×32 → 40×40**；筛选 chip / 清空按钮 / 标签栏 / 信息页工具栏均加高（20–28 → 28–32）；无横向溢出。

> **本机构建备注（非仓库代码）**：这台 macOS 上 `cargo tauri android build` 会在 Gradle 阶段楔死（wrapper 停在 `ProcessHandleImpl_waitForProcessExit`，daemon 收不到构建请求；`gen/android/buildSrc/.../BuildTask.kt` 里的 `cargo tauri android android-studio-script` 递归任务持续挂起）。`gen/` 是 git-ignored 的生成树，本地做了三处旁路：该 rust 任务改为 no-op（Tauri 自身已编译并 symlink `.so`）、`org.gradle.daemon=false`、`org.gradle.vfs.watch=false`；之后 `./gradlew :app:assembleUniversalDebug --no-daemon`（`JAVA_HOME` 指向 Android Studio JBR；本机默认 JDK 26 会让 AGP 报 `26.0.1` 配置错误）**8–11 秒**出包，`adb install -r -g` 安装。重新生成 `gen/` 会恢复上游行为。


- `amos-blocklist`：**14 例**（规范化/同号等价/前缀保守性、渠道、未知号码、命中原因、去重、上限淘汰、JSON 往返、损坏载荷拒绝）。
- `amos-tauri --lib blocklist::`：**9 例**（增删查、非法 kind/channel、重启持久化、损坏文件起源、短信线程过滤、仅来电规则不影响短信、`status_of` 渠道判定、宿主无来电筛选角色时的诚实状态、持久化路径单一来源）。
- `amos-sms` **23 例**、`amos-tauri --lib sms::` **10 例**、`clippy -D warnings`（host + `--features android`）。
- 前端：`test:svelte` **374 例**（含「拦截」标签增删规则、非法规则诚实报错、来电筛选角色横幅+授权、通话记录一键拉黑、**通话记录方向筛选/两段式清空**、**「信息」屏蔽此号码成功/被拒两态**）+ `tsc`/`svelte-check` 0 error；纯逻辑 `calllog.test.ts` 含**方向筛选与清空**共 **17 例**。

#### 11.4 一致性补全：文件夹徽标 + 角色状态（2026-09-10）

对上文的短信执法与来电执法做一致性审计，补两处用户可见的缺口：

| 缺口 | 根因 | 修复 |
|---|---|---|
| 拉黑发件人后**列表少一条、标签徽标仍多一** | `sms_snapshot` 走 `filter_threads` 过滤被屏蔽线程，`sms_counts` 却直接返回平台 `counts()`，两者不同源 | `sms.rs` 新增纯函数 `filtered_counts(provider, rules)`：**存在短信规则**时按同一 `filter_threads` 从各文件夹快照派生计数（徽标 = 可见列表长度，**按构造相等**）；无规则时仍用平台 `counts()`（不引入额外读取）。纯函数可测：`sms::tests` +2 |
| 授予来电筛选角色后**横幅不更新**（仍显示「未获权限」） | `blocklist_request_role` 只负责**弹出**系统对话框；作答发生在**另一个 Activity**，耗时远晚于命令返回，`loadBlockStatus()` 早已读回旧值 | `PhoneApp` 在 `document.visibilitychange` / `window.focus`（回到前台）与**每次切到「拦截」标签**时重新探测 `blocklist_status`，横幅立即翻转；外部 `cmd role remove-role-holder` 撤销也会如实回到「需授权」。DOM 回归用例 +1 |
| 「信息」页屏蔽成功文案**过度承诺**（未持角色也说来电会被拒接） | `message.blockSenderDone` 固定说「来电将被拒接」 | 改为「其短信不再显示；AmOS 持有「来电筛选」权限时来电将被拒接」（中英同步） |
| 仅开启**「拦截未知号码」开关**时，徽标又比列表多 | `Blocklist::check` 把**无法解析的地址**（字母数字发送者 ID，如 `TM-ALIPAY`）判为 `Unknown` 而非「放行」→ 列表被 `filter_threads` 隐藏；但 `sms_counts` 的守卫只看 `has_sms_rules()`（此时一条规则都没有）→ 退回平台计数 | `BlocklistState::filters_sms()` =「有短信规则 **或** 未知开关开启」作为唯一守卫，`sms_counts` 改用它；`sms.rs` 测试 +1（字母数字发送者 ID 在开关开启时不计入、逐文件夹等于可见列表长度；关掉开关后平台计数重新生效）、`blocklist.rs` 测试 +1（守卫由规则或开关任一武装，仅来电规则不启用短信过滤） |
| **有来电规则但平台无法执法时，横幅完全不渲染** | `block-role-unavailable` 分支被 `needsCallRole` 打开，而 `needsCallRole` 要求 `role_supported` → 桌面端 / 无角色 Android 上「规则已记录但没人执行」看起来像「一切正常」（或什么都没发生） | 横幅改为三段式且**互斥穷尽**：`role_held` → 生效；`role_supported && role_requestable` → 需授权 + 前台授权按钮；**其余一律**渲染「不可用」说明（无授权按钮）。移除不可达的 `needsCallRole`，`phone.blockRoleUnsupported` 措辞覆盖三种成因（桌面端 / Android 10 以下 / 原生桥未就绪）。DOM 用例 +2（不可用态可见且无授权按钮；已持角色只显示生效） |
| 被屏蔽后**打开中的线程仍被读取** | `refreshReal` 只判断「列表里还有没有别的线程」，活动线程消失且列表为空时仍按旧 id 调 `sms_messages`（真机上该读取会被 `sms_messages` 的屏蔽判定拒绝） | 改为在**新列表**里查找活动线程：消失则切到最新线程，或清空 `realActiveId`/`realMsgs`/`realErr`；屏蔽后不再读取不可见线程。`messages.svelte.test.ts` 增断言（屏蔽后 `sms_messages` 调用次数不增加） |

其它清理：删除从未被引用的文案键 `phone.blockAction`（中英）。

> 说明：`sms_counts` 的过滤只在**确实可能隐藏线程**时启用（有短信规则，或「拦截未知号码」开关开启），因此正常量级下不增加任何 ContentResolver 读取；这也是把「是否过滤」的判定放在桥层（读取进程级规则状态）而非 Kotlin 的原因——规则只有一份真相在 Rust。
>
> 守卫为什么不能只看规则：`Unknown` 是**地址解析失败**（服务号/字母发送者 ID）的分类，与「有没有规则」无关。只按规则守卫会留下一个必然复现的缝隙（开关开、规则空），因此守卫被提炼为 `filters_sms()` 这一处语义。

**本节验证（本机）**：`cargo test -p amos-tauri --lib` **194 例**（`sms::` **13**、`blocklist::` **10**）；`clippy -D warnings`（host + `--features android`）、`fmt --check` 干净；`bun run check` **EXIT=0**、`test:svelte` **378 例**、`tsc`/`svelte-check` 0 error、i18n 奇偶保持。

### 12. 余额脱敏：显示路径不透出银行余额（REQ-A41，2026-09-11）

银行短信的核心敏感字段是**余额**（扣款/到账通知），而 AmOS 的「信息」页此前把平台短信库返回的正文**原样显示**——演示投屏、他人借用手机的场景下余额一览无余。现按航宇级审计标准（`docs/AEROSPACE_SOFTWARE_AUDIT.md`）补上**显示路径脱敏**：进入 UI 的正文/线程预览中的余额金额一律替换为 `***`；平台短信库原文不动（AmOS 是视图层，不改写系统库）。

**规则（`crates/amos-sms/src/redact.rs`，纯函数、单遍 O(n)、有界窗口、panic-free、未命中零分配 `Cow`）**：

| 规则 | 触发 | 示例 |
|---|---|---|
| A. 内容规则（**任何发件人**） | 余额关键词（`余额/账户资金/可用额度/available balance/balance`…，CJK 子串 + 拉丁词边界 + ASCII 大小写不敏感）后，在有界填充窗口内的金额（数字/分组逗号/小数/正负号/`元￥$€£` 后缀），金额整段替换 | `余额12,345.67元` → `余额***`；`Balance: -$50.00` → `Balance: -***` |
| B. 发件人规则（**银行短号**，`is_bank_sender`：`95588/95533/HSBC`…） | 银行发件人的正文里，任何紧跟 `:`/`：` 的金额一律脱敏 | `尾号1234：5,000.00` → `尾号1234：***` |

性质与诚实边界：
- **幂等**：对已脱敏文本再跑一遍输出逐位相同（测试钉住）；关键词本身保持可见（`余额：***`），用户仍知道这是什么字段。
- **全角数字（`１２３`）不识别**——当前诚实地**不**当作金额处理，测试写明这是已知边界，而不是假装覆盖。
- 修复过程中顺带发现并修正一个确定性缺陷：关键词匹配的 ASCII 大小写比较此前只折文本侧、漏了关键词侧，导致 `USD`/`INR` 等大写货币词永远匹配不上；现为双侧 `eq_ignore_ascii_case`。

**接线（单一漏斗）**：`crates/amos-tauri/src/sms.rs` 的 `sms_snapshot`（线程预览）与 `sms_messages`（正文）是 UI 取短信的**仅有的两条路**，两者统一改走 `redact_for(发件人, 正文)`；发件人缺失/未知时退化为纯内容规则（脱敏从不依赖发件人已知）。事件路径（`incoming_payload`）本就只携带地址、不含正文，Kotlin 层无需改动。审计日志只记**掩码条数**（`tracing::info!`，`amos::sms` target），**绝不记录内容**。

**本节验证（本机）**：`cargo test -p amos-sms` **41 例**（`redact::` **18**：规则 A/B、幂等、有界窗口、panic-free 模糊、BMP/多字节边界、固定向量表）；`cargo test -p amos-tauri --lib` **231 例**（`sms::` **16**，+3：预览脱敏而存储映射不动、按发件人分级、种子演示数据零掩码即诚实 no-op）；`clippy --all-targets -D warnings`（host 与 `--features android`）、`fmt --check`、`cargo check -p amos-sms --features android` 全干净。

### 13. 回收站：视图层隐藏/恢复（REQ-A42，2026-09-11）

平台短信库由**默认短信应用**拥有，AmOS 拿不到删除能力——但「删不掉」不该等于「只能看着」。现补上**视图层回收站**：把短信从 AmOS 的所有读取路径隐藏（线程列表、正文、徽标、预览），随时可恢复；系统库里原文不动。与 §11.3 的诚实边界一致：UI 明说「仅从 AmOS 隐藏，系统短信应用仍保留原短信」，**清空 = 全部恢复显示**，绝不销毁任何数据。

**领域内核（`crates/amos-sms/src/trash.rs`，纯逻辑 + `RwLock` 共享 + 可持久化）**：
- `add` 语义（桥层先验）：仅当 `(thread, message)` 仍出现在**该文件夹的可见快照**中才收——对已不在的行报「未找到」（列表过期时**诚实报错**，不假装成功）；被屏蔽发件人拒收（与 §11 的过滤一致）；重复回收是幂等 no-op（仅刷新时间）。**预览改写**：当被回收的是线程最新*可见*消息时，预览换到回收前的上一条可见消息——`was_latest` 按「回收前的可见集」判定（预读快照、排除已在回收站的行），因此同线程**连续回收**会正确刷新覆盖，不会被已回收的行卡住；该线程来了**更新的消息**后覆盖自动失效（按 `last_ts_ms` 判staleness）。
- `restore` / `purge`：单条恢复与全部恢复都会清掉对应线程的预览覆盖（那是按回收态算出来的，恢复后由调用方按 provider 重算）。
- 容量上限 `DEFAULT_TRASH_CAP = 256`，**回收最旧**（FIFO 淘汰 = 该条自动恢复显示，绝不静默吞掉可见性之外的任何东西），淘汰时同步清理孤儿预览。
- 持久化 `to_json`/`from_json`（版本化 `v1`）：**只存 id 与时间戳，绝不存正文**；条目与预览各自有界、超限拒绝、逐条带序号报错。

**桥与命令（`crates/amos-tauri/src/sms.rs`）**：进程级共享 `SmsTrash`（`RwLock`，锁内仅毫秒级内存操作，同 §3 的不阻塞纪律）；四个命令 `sms_trash_add(folder?)`（三态结果 `{trashed:true} | {trashed:false, reason} | {trashed:false, notFound:true}`，包装域错误经 `SmsError::Failed` 单层映射）、`sms_trash_list`、`sms_trash_restore`、`sms_trash_purge`；**三条读取路径统一过滤**——`sms_snapshot` 走 `apply_trash`、`sms_messages` 按回收站逐条剔除、`sms_counts`/徽标走纯函数 `filtered_counts`（块名单 + 回收站一起扣，**徽标与可见列表由构造保证一致**）；数据目录 `sms-trash.json`，启动时加载、每次变更落盘（同块名单的模式）。

**前端（`backend.ts` + `MessagesApp.svelte` + i18n 中英）**：真机模式气泡悬停出现「移入回收站」按钮；工具栏「回收站 (n)」切换面板，列出隐藏条目（线程名 + 时间），支持单条**恢复**与**清空**；三态结果以状态条明示——成功文案写明「系统短信应用中仍保留」，陈旧 id 报「该短信已不在当前文件夹中」，失败报「移入回收站失败」。`sms_trash_add` 对 Tauri v2 的 camelCase 参数（`threadId`/`messageId`）与 `sms_messages` 同一约定。

**本节验证（本机）**：`cargo test -p amos-tauri --lib` **237 例**（`sms::` +6：预览换到上一条可见消息、整线程隐藏、未知 id 诚实报错、恢复出自然预览 + 未读徽标、新消息到来后预览覆盖失效、落盘/重载 round-trip）；`cargo test -p amos-sms` **55 例**（`trash::` 纯域用例）；`clippy --all-targets -D warnings`（host 与 `--features android`）、`fmt --check`、`cargo check -p amos-sms --features android` 全干净；前端 `tsc --noEmit` 与 `svelte-check` 0 错 0 警、vitest **471 例**全绿。

**诚实边界**：这不是系统级删除——短信仍在平台短信库里（换一个短信应用仍可见）；彻底删除需将 AmOS 设为默认短信应用（平台限制，见下节）。回收站满 256 条时 FIFO 淘汰最旧条目，其含义是「自动恢复显示」，并在文档与测试中写明。

### 已知边界 / 下一步
- 系统短信库由默认短信应用拥有：AmOS 只能在**自己的视图与通知**层面屏蔽短信，无法删除系统行（除非 AmOS 成为默认短信应用）。§13 的回收站就是这条边界的视图层实现：隐藏/恢复/清空都不触碰系统库。
- 来电拦截需用户授予系统「来电筛选」角色；未授权时仅记录规则、不拒接（UI 现在**明确显示**状态并提供前台授权按钮）。
- 一键入口已做两处：**通话记录「最近」→「拦截」**（写入 `exact/both` 规则并切到拦截页）与**「信息」真机线程标题栏 →「屏蔽此号码」**（同一共享规则库；成功后该发件人被 `sms_snapshot` 过滤、线程消失，并以状态条说明原因）。


