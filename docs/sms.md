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

### 真机踩到的两个问题（已修）
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

### 6. 测试与门禁（本机全绿）
- `amos-sms`：**19 例**（含地址规范化/拒绝、分段计数、GSM-7 判定、线协议上限与越界、错误类型映射、线程交叉校验、send 成功语义）。
- `amos-tauri --lib sms::`：**8 例**（含宿主空收件箱、mock/设备状态区分、发送前校验、地址掩码、**卡死 provider 超时**、阻塞结果传递）。
- 前端：`typecheck` / `typecheck:svelte` 0 error、`test:svelte` **358 例**（新增权限拒绝→重试恢复、空收件箱诚实态、宿主 mock 保持本地会话）。


