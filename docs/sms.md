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

## 待接入（下一步，逐层做，真机验收）
1. **`amos-sms` Android provider**（feature `android = ["dep:jni"]`）：`AndroidSmsProvider`，经 JNI 调 Kotlin `SmsGlue`，把 JSON 用 `wire.rs` 解析成领域类型。桌面/CI 不拉 jni。
2. **Kotlin `SmsGlue.kt`**（`crates/amos-tauri/android-glue/.../glue/`）：注册 upcall 提供 `Context`；`snapshot()`（查 `content://sms`，按 thread_id 聚合 address/body/date/read）+ `messages(threadId)` + `send(address,text)`（`SmsManager`）。
3. **权限**：`AndroidManifest` 声明 `READ_SMS` + `SEND_SMS`（参照仓库 permissions fragment 惯例），运行时请求。
4. **MessagesApp 接真实线程**：桥接真机时用 `sms_snapshot`/`sms_messages` 展示真实线程并 `sms_send` 发送；离线退回本地会话。

## 真机验收清单（需在你的设备 YY000286 上）
- [ ] 授予 READ_SMS（及 SEND_SMS）；System UI 为默认短信应用（`SmsManager` 发送需要）。
- [ ] 打开“信息”：能列出真实收件箱线程（地址/显示名/最近一条/未读数）。
- [ ] 打开某线程：按时间列出真实往来消息（含是否本人发出）。
- [ ] 回复/发送：调用系统 `SmsManager` 真正发出一条；对照系统短信应用确认。
- [ ] 断网/无权限路径：诚实错误而非伪造线程。
- [ ] 首次真机在系统短信里新收一条，回 AmOS 验证刷新。
