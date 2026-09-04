# Amos 电话（Telephony）设计稿 + 契约

**日期**: 2026-09-03
**状态**: ✅ **P0 + P1 + P2(事件核心) 已实现（2026-09-03）**：`crates/amos-telephony` 领域内核（`number`/`session`/`error`/`provider` + `MockTelephonyProvider`）、`proto/telephony.proto` 契约与代码生成、`service` 模块与 UDS 挂载（`amos-ai` 同 socket 新增 `Telephony` 服务）、Tauri 命令桥 + 拨号器/锁屏紧急入口 110、`Watch` **真实持续事件流 + 注入式来电模拟** 均已落地并通过（25 单测 + 2 UDS e2e）。剩余：**Watch 前端来电浮层 / Tauri 事件桥** → **✅ 已完成（2026-09-04，见 §10.3）**；**P3（Android/Binder 真实现）** 待做。**通话录音（2026-09-04 追加实现）**：`RecordingState{Off,On,Failed}` 领域状态机 + `TelephonyProvider::start/stop_recording`（provider 允许/拒绝/审计，紧急号硬拒绝）+ proto `RecordingState`/`CallSnapshot.recording` + `StartRecording/StopRecording` RPC + gRPC/Tauri 桥 + `PhoneApp` 通话页录音开关与「正在录音」指示 + en/zh i18n（41 单测 + 3 DOM 测；真实音频采集仍属音频管线）。
**关联**：`FUNCTIONAL_GAP_ANALYSIS.md` §六（真缺口 #1）；`docs/external-analysis-review.md` §1.2；`docs/no-ui-android.md`（产品底座 = no-UI Android，telephony 走 **Binder**）；前端现有 `PhoneApp`（`CommsApps.tsx:213`）目前是纯 UI，无任何真实拨号。

---

## 1. 为什么需要它 / 范围

### 目标
AmOS 作为真机手机 OS，必须有**真实、合规、可用**的电话能力：

1. **法律强制的紧急呼叫**：即使无 SIM、锁屏、甚至无桌面 UI 可用，也要能一键呼出 **110/112**（中国 110 公安/火警、112 国际/欧盟统一紧急号）。这是任何手机 OS 的准入红线，**优先级最高、不可被任何安全策略拦截**。
2. **普通通话**：SIM 拨号、来电、接听/挂断/拒接、通话状态同步给 UI 与 AI（`amos-ai` 可在来电时注入上下文）。
3. **厂商/产品位**：把 `amos-tauri` 壳注册为系统的 **Default Phone App（ROLE_DIALER）**，由 OEM 出厂授权——这是与 OEM 合作要谈的硬性权益之一。

### 范围界定（诚实划线）
- **本期只做「领域契约 + 状态机 + Mock 提供方 + gRPC/前端接线骨架」**，真实拨号交给 provider。
- **做**：呼叫状态机、拨号/接听/挂断/拒接、来电监听、号码规范化、紧急呼叫专用硬通路、审计。
- **本期不做**：RCS/volte 配置、多卡精细策略、闪信/彩信、电话簿联系人管理、SMS（SMS 另立 `amos-sms` 或后续）。避免把「电话」与「短信」糊成一个巨大 crate。（**通话录音**已于 2026-09-04 追加为领域状态机 + provider 允许/拒绝 seam + gRPC/Tauri/前端开关，见本文状态行——真实音频采集仍属音频管线。）
- **音频**：真实双向通话音频（AudioFlinger/PipeWire/AAudio）属**独立音频管线**工作（见 `docs/native-voice.md` 与路线图），本文不展开；本文只保证「呼叫建立/状态/信令」正确。

---

## 2. 分层与架构

沿用 provider-seam：

```
[ frontend PhoneApp / 来电表面 / amos-ai 来电上下文 ]
        │  经 Tauri 命令 + 事件（dial / hangup / state-change）
        ▼
[ TelephonyService (gRPC, telephony.proto) ]   ← 可挂在 amos-ai 同一 UDS 上（新增服务）
        │  领域操作经 CallSession + 状态机
        ▼
[ amos-telephony 领域内核 ]
        ├── model.rs    呼叫/号码/状态模型 + 状态机（传输无关，离线纯测试）
        ├── error.rs    TelephonyError（无 SIM / 不可达 / 已挂断 / provider 错误 …）
        ├── provider.rs TelephonyProvider trait（唯一的真实接线点，只发「信令」）
        ├── android.rs  AndroidTelephonyProvider（feature `android` + `#[cfg(target_os)]`）
        │        ├── Binder → TelecomManager / TelephonyManager（生产路径）
        │        └── EmergencyTelephonyProvider（紧急 110/112 特权硬通路，独立于普通路径）
        └── mock.rs     MockTelephonyProvider（确定性、内存态、离线可测）✓ 先实现
```

- **领域内核不做任何 Binder/系统调用**：它只维护「一次通话的合法状态迁移 + 号码规则 + 审计点」。
- **`TelephonyProvider` 只负责「发出信令」**（dial/answer/end + 上报状态事件），不决定状态机合法性——合法性由内核判定。
- **紧急路径是独立 provider**（不是普通 Dial 的特例参数）：因为它在权限、可达性、绕过锁屏上的保证与普通呼叫**根本不同**（见 §5）。

---

## 3. 领域模型与状态机

### 号码 `model.rs`
```rust
/// 已规范化的电话号码。紧急号用专用构造，禁止被普通号码规则拒绝。
pub struct Number(String);

pub enum NumberKind {
    Emergency,   // 110/112/119/120/999 …（各司法区映射，启动时装配）
    Regular,     // 走 SIM/IMS 的普通呼叫
}

impl Number {
    /// 判断并规范化：仅当确属紧急号才返回 Some(Emergency)。
    pub fn classify(&self, spec: &EmergencyMap) -> Option<NumberKind>;
}
```
紧急号判定需**平台装配的紧急号表**（`EmergencyMap`，含各国家/地区 110/112/911/999…），不能只硬编码中文三码。

### 单次呼叫状态机 `CallSession`
```
Idle ──dial──▶ Dialing ──established──▶ Active(Ringing|Talking)
  ▲                  │                       │ answer/establish
  │                  └──────── end ──────────▶ Ended
  │   incoming──▶ Incoming(Ringing) ──answer─▶ Active(Talking)
  └──────────────◀──────────── end ───────────┘
```
- 合法迁移白名单判定在**内核**（`session.transition(Event)`），非法事件返回 `TelephonyError::IllegalState`。
- `Call` 元数据：`CallId`（独立命名空间，勿与 `amos-wm` 的 `WindowId` 混用）、`direction`（Outgoing/Incoming）、`peer`、`started/ended`、`EndReason`（LocalEnd/RemoteEnd/CallFailed/Emergency）。
- 状态变更由 provider 上报（`on_event`），内核校验后经 gRPC `CallStateEvent` 广播给 UI + AI。

### 状态
| 状态 | 含义 | 关键进入条件 |
|---|---|---|
| `Idle` | 无通话 | 初始 / 通话结束 |
| `Dialing` | 已请求呼出 | `dial(regular)` |
| `Incoming(Ringing)` | 有来电 | provider 上报来电（可带 CallerId/紧急标记） |
| `Active(Ringing/Talking)` | 已接通 | `answer` / provider 报 established |
| `Ended` | 已结束（终态） | `end` / 对端挂断 / 失败 |

---

## 4. Provider seam 契约（Rust，提案）

`provider.rs` 是**唯一的真实接线点**；先写 `MockTelephonyProvider`，再写 Android 实现。trait 尽量小，只表达信令与上报。

```rust
#[async_trait]
pub trait TelephonyProvider: Send + Sync {
    /// 主动呼出。返回 provider 侧分配的 call id。
    async fn dial(&self, n: &Number, opts: DialOptions) -> Result<CallId, TelephonyError>;

    /// 应答一条来电。
    async fn answer(&self, id: CallId) -> Result<(), TelephonyError>;

    /// 结束一条通话（挂断 / 拒接共用）。
    async fn end(&self, id: CallId) -> Result<(), TelephonyError>;

    /// 同步查询当前是否有活动/来电（供 UI 冷启动恢复）。
    async fn status(&self) -> Result<Vec<Call>, TelephonyError>;

    /// 订阅 provider 的信令事件（呼出建立、来电、对端挂断、失败…）。
    /// 内核据此驱动状态机。
    fn subscribe(&self) -> mpsc::Receiver<ProviderEvent>;
}
```

### 紧急 provider（独立，见 §5）
```rust
/// 独立的特权紧急通路：无 SIM 也可用、绕过锁屏、拒绝被安全/限速拦截。
#[async_trait]
pub trait EmergencyTelephonyProvider: Send + Sync {
    /// 紧急硬通路：一键/长按呼出紧急号。实现方保证尽力可达。
    async fn emergency_call(&self, n: Number) -> Result<CallId, TelephonyError>;
}
```
> 为什么独立成第二个 trait：普通 `dial` 需要 SIM/账户、可能被飞行模式或策略影响；紧急号**必须**走系统级紧急拨号 API（Android `TelecomManager`/`TelephonyManager` 的紧急通路），语义与权限都不同。让普通与紧急**不共用一个实现**，防止将来有人把普通逻辑悄悄插进紧急路径。

---

## 5. 紧急 110/112 硬通路（设计的重心）

### 硬性保证（不可协商，验收即按此测）
1. **可达性**：锁屏、无 UI 前台、无 SIM、甚至拨号器自身进程挂了（改由独立/系统入口触发）都能触发。
2. **不可拦截**：不走 `amos-ai` 的常规 security rate-limit / permission 门（见 `security.rs::validate_request`）——紧急请求在安全层里是**白名单豁免**，但**仍强制审计**（谁在何时拨的紧急号）。
3. **离线可用**：不依赖云端、不依赖 MicroG/GMS 拨号服务（走系统电信栈，不是厂商网关注册）。
4. **UI 直达**：锁屏上永远有一个紧急入口；物理按钮（见 `docs/hardware-buttons.md`）可绑定「长按 → 紧急」。
5. **号码正规化兜底**：紧急号去空格/连字符后仍须命中 `EmergencyMap`；命中即走紧急通路，绝不落进普通 dial 被 SIM 判断拒掉。

### Android 实现要点（提案）
- 生产路径走 **Binder**（见 `docs/no-ui-android.md` §4 的 `binder` crate 计划），调 `TelecomManager`/`TelephonyManager` 的紧急 API；兜底可用 `intent` 起系统拨号/紧急服务。
- 需 OEM 在 **`ROLE_DIALER`（Default Phone App）+ 特权权限**（`MANAGE_OWN_CALLS` 等）上出厂授权，并在锁屏把本壳的紧急入口算作可信 surface。
- 在 no-UI 基座上，即使 Tauri 壳未被前台渲染，也要求系统在锁屏给本包一个可点的紧急入口（**厂商配合项**，见 §9）。

### 审计与安全
- 紧急呼出在 `security.rs` 审计日志中**必须留痕**（`operation="emergency_dial"`），但 `validate_request` 对它放行——**豁免限速、不免审计**。
- 状态机对紧急呼叫：一旦建立不可被普通挂断逻辑吞掉（挂断是用户显式操作才允许）。

---

## 6. gRPC 契约（`proto/telephony.proto`，提案）

新增 `.proto`，作为 UI/daemon/前端之间的单一真源（编译进 `amos-proto`，参考 `translate.proto` 引入新文件）。

```proto
syntax = "proto3";
package amos_telephony;

enum CallDirection { OUTGOING = 0; INCOMING = 1; }
enum CallState { IDLE = 0; DIALING = 1; RINGING = 2; ACTIVE = 3; ENDED = 4; }
enum EndReason { LOCAL = 0; REMOTE = 1; FAILED = 2; EMERGENCY = 3; }
enum RecordingState { RECORDING_OFF = 0; RECORDING_ON = 1; RECORDING_FAILED = 2; } // 2026-09-04

message CallIdMsg { string id = 1; }
message DialRequest { string number = 1; bool emergency = 2; }
message AnswerRequest { CallIdMsg call = 1; }
message EndRequest    { CallIdMsg call = 1; }
message CallSnapshot  {
  CallIdMsg call = 1; string peer = 2; CallDirection dir = 3;
  CallState state = 4; EndReason end_reason = 5; bool emergency = 6;
  RecordingState recording = 7; // 通话录音状态（2026-09-04）
}
message CallStateEvent { CallSnapshot call = 1; }

service Telephony {
  rpc Dial(DialRequest) returns (CallIdMsg);                 // emergency=true 走紧急 provider
  rpc Answer(AnswerRequest) returns (CallIdMsg);
  rpc End(EndRequest) returns (CallIdMsg);
  rpc StartRecording(CallIdMsg) returns (CallSnapshot);      // 仅 ACTIVE + 非紧急号可录（2026-09-04）
  rpc StopRecording(CallIdMsg) returns (CallSnapshot);       // 返回权威快照供 UI 呈现 recording
  rpc Status(google.protobuf.Empty) returns (stream CallSnapshot); // 冷启动恢复
  rpc Watch(google.protobuf.Empty) returns (stream CallStateEvent); // 来电/状态广播
}
```
- 服务挂到 `amos-ai` 同一 UDS（与 `AiAgent`/`AndroidManager` 并列，见 `server.rs` 的 `add_service` 模式）。
- `Dial{emergency=true}` 在服务端分派到**紧急 provider**，并打 `emergency_dial` 审计；普通 `Dial` 才走常规权限/限速。
- **录音（2026-09-04）**：`StartRecording/StopRecording` 走 `TelephonyProvider::start/stop_recording` seam；域内核（`CallSession::start/stop_recording`）强制「仅 `Active` + 非紧急号 + 未在录」，provider 另有权衡（consent/辖区）可拒绝（不影响呼叫）；成功后返回携带 `recording` 的权威 `CallSnapshot`（`Status`/Watch 同步携带）。

---

## 7. UI / 集成点

- **拨号器**：替换 `CommsApps.tsx` 的 `PhoneApp` 静态 `calling` 状态——拨号时调 `telephony.dial`，渲染以 `CallStateEvent` 为准；加锁屏紧急入口与一键 110/112。
- **来电表面**：`Watch` 流在**任意 app 前台**收到 `RINGING` 时，经 `amos-wm` 在顶层弹出可接听/拒接的来电卡（含 AI 助手注入"来电人"上下文的钩子，供 `amos-ai` 做后续 VLM/翻译）。
- **快捷键/按钮**：`amos-tauri/src/buttons.rs` 加「长按语音键 → 紧急呼叫」硬件路径。
- **音频**：接通后进入未来音频管线；本期来电仅信令 + UI，不播放铃声（铃声属音频管线）。

---

## 8. 测试策略

| 层 | 方式 | 判据 |
|---|---|---|
| 领域状态机 | 纯单测 + 迁移白名单 + 非法事件 | 每个合法迁移只允许一次；非法事件返回 `IllegalState` |
| 号码规范化 | 单测 + 确定性 `EmergencyMap` | 110/112/911/999 命中 `Emergency`；带连字符/空格仍命中；普通号不误判 |
| Mock provider | 确定性端到端（dial→established→end） | 状态序正确、事件齐 |
| gRPC | 无头：起 daemon 挂 Telephony 服务，客户端驱动 | Dial/Answer/End/Watch 在 UDS 上往返正确 |
| 前端 | `bun` 无头（现有 harness） | `PhoneApp` 事件驱动、锁屏紧急入口可用 |
| 紧急硬通路（真机，需 OEM/root） | 无 SIM 环境、锁屏态、禁用普通 provider | `emergency_call` 成功、审计留痕、不被限速拦截 |
| 故障注入 | provider 断线/挂断竞争 | 状态机不卡死、能收敛到 `Ended` |

---

## 9. 给 OEM 的配合项（商业谈判里提前要）

1. **出厂注册本壳为 `ROLE_DIALER`（Default Phone App）**，并把普通/紧急拨号所需特权权限授予（platform/privapp）。
2. **锁屏可信紧急入口**：即使无桌面 UI 前台，锁屏也能直达本壳的一键紧急入口。
3. **紧急号表**：按目标市场司法区装配 `EmergencyMap`（若随 AOSP 走则确认本地化映射）。
4. 交叉真机验证窗（跑 `docs/device-poc.md` §0-§5 流程的那类机器）。

---

## 10. 落地顺序（在 crate 内）

1. **P0**：`crates/amos-telephony` 领域内核（`model`/`error`/`provider`/`CallSession` 状态机 + `EmergencyMap`）+ `MockTelephonyProvider` + 全单测。→ **✅ 已完成（2026-09-03）**：`number.rs`/`session.rs`/`error.rs`/`provider.rs`，17 单测通过，可在无真机时完成并进 CI。
2. **P1**：`proto/telephony.proto` + `amos-proto` 代码生成 + `TelephonyService` 挂进 `amos-ai` UDS + 无头 gRPC 测试。→ **✅ 已完成（2026-09-03）**：`service.rs`（`mock_server()`）、`amos-ai/src/server.rs` 经 `add_service` 挂载、`tests/telephony_rpc_e2e.rs` 真 UDS 往返（Dial/Status/End、112 自动紧急路由）。
3. **P2**：前端接线 + 来电 surface。→ **✅ 完成（2026-09-03/04）**：`PhoneApp` 拨号接线、锁屏紧急入口 110、**`Watch` 真实持续事件流**（`ProviderEvent` 增 `Incoming/Connected{id,peer}`，Mock 上报；`service.inject_incoming()` 供无头注入）；**2026-09-04 闭环**：Tauri `Watch` 事件桥（`spawn_telephony_watch` 长连 `telephony-event`，带退避重连）+ 前端**来电浮层 `IncomingCall`**（Ringing→接听/拒接；接通 Active→含录音开关的通话条 + 挂断）+ `telephony_answer` + 拨号出局 **demo 自动接通**（`demo_server()`：出局普通号短响铃后到 Active，桌面拨号→通话→录音→挂断真实可操作；`mock_server()` 仍确定性供无头 e2e）＋ `SimulateIncoming` RPC（mock 专用，真 provider 返回 `Unavailable`）+ `telephony_simulate_incoming` + PhoneApp「模拟来电」demo 入口，**来电浮层也可桌面手测**（生产来电仍走真机注入/Binder）。
4. **P3（需真机/OEM）**：`android.rs` 的 `AndroidTelephonyProvider`（Binder/`cfg(target_os="android")`，feature `android` 门控）+ `EmergencyTelephonyProvider`；真机按 §5 硬性保证验收。→ ⏳ 待做。

---

## 11. 关键开放问题（实现前需拍板）
- 普通通话是否**只**经系统电信栈（`TelecomManager`），还是也要在 no-UI 基座上直接驱动 `TelephonyManager`？（建议：`TelecomManager` 为主，`TelephonyManager` 兜底。）
- 来电要不要先给 `amos-ai`「静音接听前」钩子（隐私决策）？默认否。
- 紧急号表维护来源：随 AOSP `res`/数据库，还是自维护 `EmergencyMap`（建议自维护一份 + 可覆盖）。


