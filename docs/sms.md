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
2. **真实数据混入本地会话/通知 `$effect`** 会在真机 shell 下引发整窗卡死：改为**独立真实态**（`realThreads`/`realMsgs`/`realActiveId`，探测 `$effect` 用 `probed` 一次性守卫），本地会话与通知同步完全不受影响，离线行为不变。
3. 另注（非应用缺陷）：重装 APK 后偶发 `SandboxedProcessService ... process is bad`，WebView 渲染沙箱需重启设备才恢复；属设备侧 WebView 状态，重启后一切正常。

