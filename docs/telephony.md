# Amos 电话（Telephony）设计稿 + 契约

**日期**: 2026-09-03
**状态**: ✅ **P0 + P1 + P2(事件核心) 已实现（2026-09-03）**：`crates/amos-telephony` 领域内核（`number`/`session`/`error`/`provider` + `MockTelephonyProvider`）、`proto/telephony.proto` 契约与代码生成、`service` 模块与 UDS 挂载（`amos-ai` 同 socket 新增 `Telephony` 服务）、Tauri 命令桥 + 拨号器/锁屏紧急入口 110、`Watch` **真实持续事件流 + 注入式来电模拟** 均已落地并通过（25 单测 + 2 UDS e2e）。剩余：**Watch 前端来电浮层 / Tauri 事件桥** → **✅ 已完成（2026-09-04，见 §10.3）**；**通话录音（2026-09-04 追加实现）**：`RecordingState{Off,On,Failed}` 领域状态机 + `TelephonyProvider::start/stop_recording`（provider 允许/拒绝/审计，紧急号硬拒绝）+ proto `RecordingState`/`CallSnapshot.recording` + `StartRecording/StopRecording` RPC + gRPC/Tauri 桥 + `PhoneApp` 通话页录音开关与「正在录音」指示 + en/zh i18n（41 单测 + 3 DOM 测；真实音频采集仍属音频管线）。**Phase A+C 审计校正与拨号器生产化（2026-09-04，见 §12）**：✅ 真电话宿主进程与责任边界定稿、`EmergencyMap` 司法区化（`for_region`/`quick_dial`，未知区域回退全局）、锁屏紧急一键用共享单一来源并可自恢复、`PhoneApp` 无 daemon 拨号优雅降级并给用户错误（Rust 单测 51 + 前端新测，全绿）。**P3（真机 Android/Binder backend）代码仍 ⏳ 待做**（见 §10.4，含宿主进程与实现要点已定稿）。
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
- **宿主进程（§12 审计校正 #1）**：真实 Android provider 持 `Context` + `ROLE_DIALER`，必须宿主于 **System UI（`amos-tauri` APK）进程**，由 Tauri 桥进程内驱动（复刻 `amos-radio` 的 `AndroidRadioProvider`/`RadioBridge` 模式），**不**由 headless `amos-ai` daemon 承载。daemon 的 `TelephonyService`（gRPC/UDS）是领域/桌面层，真机拨号在其上层由 System UI 实现并回灌事件；桌面继续用 demo/mock provider。`android.rs` 实现要点随之更新（见 §10.4）。

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

### Android 实现要点（提案，含 §12 校正）
- 真机**拨号/接听/来电都宿主在持有 `Context` + `ROLE_DIALER` 的 System UI（`amos-tauri`）进程**，进程内 JNI `getSystemService("telecom"/"phone")` → `TelecomManager`/`TelephonyManager`（复刻 `amos-radio` 的 `AndroidRadioProvider`：`AndroidContext(GlobalRef)` + 每线程 attach + feature `android` + 可选 `jni` 门控）。Binder 是框架 IPC 的底层机制，**不需要也不应**从无 Context 的 daemon 手写 `/dev/binder` 事务去「直连 TelecomManager」——受支持的正确接线是 APK 内 Java 系统服务 API（经 JNI）。兜底可用 `intent`（`ACTION_CALL`）起系统拨号。
- **责任边界（§12 校正 #2）**：紧急号路由的"无 SIM/锁屏/崩溃仍可拨"硬保证**不在用户态 crate**，而在 (i) Android Telecom 框架 + EmergencyNumber DB、(ii) RIL/厂商 HAL 的合规放行、(iii) 平台锁屏紧急拨号器（无 launcher 也可达）。`amos-telephony`/本壳能做的是：分类 + **独立紧急 provider**（不与普通拨号共享实现）+ 审计留痕（豁免限速、不免审计）+ `ROLE_DIALER` 注册 + 锁屏可信紧急入口。真机验收按 §8 对"紧急硬通路"一栏执行（需 OEM/root + 真机交叉窗）。**切勿对外宣称用户态实现了"内核绝对保护通路"。**
- 需 OEM 在 **`ROLE_DIALER`（Default Phone App）+ 特权权限**（`MANAGE_OWN_CALLS` 等）上出厂授权，并在锁屏把本壳的紧急入口算作可信 surface。
- 在 no-UI 基座上，即使 Tauri 壳未被前台渲染，也要求系统在锁屏给本包一个可点的紧急入口（**厂商配合项**，见 §9）。

### 审计与安全
- 紧急呼出**必须留痕**（`operation="emergency_dial"`）但**豁免限速、不免审计**。已落地：`crate::audit::AuditLog`（有界）+ `TelephonyService::dial` 逐条落审计；普通拨号**限速、紧急豁免**（`crate::rate::DialRateLimiter` + daemon `demo_server_limited`，见 §12 #6/#7）。daemon（`amos-ai`）侧 `AiAgentService` 的安全门/每客户端限速与 telephony 分开，真机 provider 接入时再统一。
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
message MuteRequest   { CallIdMsg call = 1; bool muted = 2; } // 期望状态，非 toggle（2026-09-22）
message CallSnapshot  {
  CallIdMsg call = 1; string peer = 2; CallDirection dir = 3;
  CallState state = 4; EndReason end_reason = 5; bool emergency = 6;
  RecordingState recording = 7; // 通话录音状态（2026-09-04）
  bool muted = 8;               // 本机送话是否静音；通话结束后恒 false（2026-09-22）
}
message CallStateEvent { CallSnapshot call = 1; }

service Telephony {
  rpc Dial(DialRequest) returns (CallIdMsg);                 // emergency=true 走紧急 provider
  rpc Answer(AnswerRequest) returns (CallIdMsg);
  rpc End(EndRequest) returns (CallIdMsg);
  rpc StartRecording(CallIdMsg) returns (CallSnapshot);      // 仅 ACTIVE + 非紧急号可录（2026-09-04）
  rpc StopRecording(CallIdMsg) returns (CallSnapshot);       // 返回权威快照供 UI 呈现 recording
  rpc SetMuted(MuteRequest) returns (CallSnapshot);          // 任何存活通话可静音，紧急号亦可（2026-09-22）
  rpc Status(google.protobuf.Empty) returns (stream CallSnapshot); // 冷启动恢复
  rpc Watch(google.protobuf.Empty) returns (stream CallStateEvent); // 来电/状态广播
}
```
- 服务挂到 `amos-ai` 同一 UDS（与 `AiAgent`/`AndroidManager` 并列，见 `server.rs` 的 `add_service` 模式）。
- `Dial{emergency=true}` 在服务端分派到**紧急 provider**，并打 `emergency_dial` 审计；普通 `Dial` 才走常规权限/限速。
- **录音（2026-09-04）**：`StartRecording/StopRecording` 走 `TelephonyProvider::start/stop_recording` seam；域内核（`CallSession::start/stop_recording`）强制「仅 `Active` + 非紧急号 + 未在录」，provider 另有权衡（consent/辖区）可拒绝（不影响呼叫）；成功后返回携带 `recording` 的权威 `CallSnapshot`（`Status`/Watch 同步携带）。
- **静音（2026-09-22）**：`SetMuted` 走 `TelephonyProvider::set_muted` seam；域内核（`CallSession::set_muted`）允许**任何存活通话**（`Dialing`/`Ringing`/`Active`）、幂等、通话结束后拒绝；与录音的**刻意不对称**是紧急号**可以**静音 —— 静音自己的麦克风是机主自己的决定，而"录下 110"是硬性法律禁止（`session.rs` 的两个单测分别钉住这两个方向）。provider 侧 `ProviderEvent::MutedChanged` 与 `RecordingChanged` 一样广播，且**两个事件都同时携带 `recording` 与 `muted`**：订阅方按快照套用，只带一个字段的事件会把另一个悄悄清掉。

---

## 7. UI / 集成点

- **拨号器**：`components/PhoneDialer.tsx`（自 `CommsApps.tsx` 再导出 `PhoneApp`）——标签页 `键盘/最近/常用/紧急`，拨号调 `telephony.dial`，渲染以 `CallStateEvent` 为准；**紧急页**一键特权拨号（共享号源）；通话中（talking）提供录音 + 静音 + DTMF 键；锁屏另有紧急一键入口（见 §12 #4/#5）。无 daemon 时拨号降级并给本地化错误。
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
4. **P3（需真机/OEM；宿主进程已在 §12 定稿）**：宿主于 **System UI（`amos-tauri` APK）进程**的 `AndroidTelephonyProvider`/`AndroidEmergencyTelephonyProvider`（feature `android` + 可选 `jni`）。→ **编译骨架已落地（2026-09-04，见 §12 #8）**：`crates/amos-telephony/src/android.rs` 以 `TelecomManager#placeCall` 真实起呼（Binder 化 + 紧急路由统一层，见 §12 #9），`cargo check --features android` + `clippy` 通过；**仍 ⏳ 待真机/OEM 验收**：接 `InCallService`/`TelephonyCallback` 的接听/挂断/来电/录音、锁屏无 UI 紧急拨号验证（按 §5 硬性保证，需 OEM/root + 交叉窗）。紧急号分类复用 §3 `EmergencyMap`、强制路由复用 §12 #9 `crate::route`。

### 10.5 通话录音：采集已接线，边界在音频源（2026-09-20 起草，2026-09-25 接线 REQ-A540 → REQ-A1579）

> **状态订正**：本节原先写「真实音频采集仍属音频管线（未落地）」，`crates/amos-telephony/src/android.rs` 也以 `requires a call-audio tap (audio pipeline, not yet wired)` 具名拒绝。**该 provider 不在 APK 里**（`amos-tauri` 不依赖 `amos-telephony`），所以那句话描述的不是线上路径。真正的缺口在**已编译进 APK** 的 Kotlin 胶水 `AmosInCallService.setRecording`：它曾答「参数」而非设备（§12 #35），后来改成四个拒绝（诚实但**录不到任何东西**）。REQ-A1579 在这条真链上接了采集。

- **采集走真机路径**：`AmosInCallService.beginRecording()` 驱动真实 `MediaRecorder`（MPEG_4 + AAC、44.1 kHz、96 kbps、单声道），写 `<filesDir>/recordings/<id>.m4a`；`finishRecording()` 停止并 `release()`，把一次性报告 `"<id>|<startedAtMs>|<source>"` 挂在胶水里，Rust 在同一个 `Off` 的调用里读走并落进 `recording.rs` 的台账（`add_recording`）。
- **目录约定是承重的**：Tauri 的 `app_data_dir()` 在 Android 上解析为 `Context.getDataDir()`（`…/<pkg>`），而胶水持久化在 `Context.getFilesDir()`（`…/<pkg>/files`）。Rust 侧 `recording::app_data_root` 在 `feature = "android"` 下 `join("files")`，与 blocklist / SMS 回收站 / IME 三处同一先例。两个根会让音频落在没有任何台账行指向的地方。
- **音频源是诚实边界（本节的中心）**：
  - `VOICE_CALL` —— 混音后的**双向**通话流 —— 由 `CAPTURE_AUDIO_OUTPUT` 门控，这是 `signature|privileged` 权限，正常安装的应用**永远拿不到**，只有平台签名构建（AmOS 作为 OS 出厂）才有。
  - 运行期检查该权限：**授予 ⇒ `VOICE_CALL`（双向）；未授予 ⇒ 回退 `VOICE_COMMUNICATION`**（只需 `RECORD_AUDIO`，录**本机麦克风一侧**）。
  - **实际用了哪个源写进台账**（`RecordingMeta.source` = `voice_call` / `voice_communication`），设置页逐行画出来（`recordings.sourceCall` ∕ `recordings.sourceMic`）。**绝不在拿到单侧录音时声称录到了对端**。普通安装的回退路径录不到对方的声音 —— 这是 Android 的规则，不是本仓的实现缺陷。
- **录音状态只如实呈现 `Off` / `On` / `Failed`，绝不四舍五入**：宿主 `incall.rs` 用类型化枚举 `RecordingChange{On,Off,Failed,Unknown(词)}` 收 Kotlin `AmosInCallService.setRecording` 的答复；纯函数 `recording_change_from_state` 只认 `On`/`Off`/`Failed`，空串或没分类的词一律 `Unknown(...)`——**绝不**把 `Failed` 当成功（F-TEL-002）。**且词只能落在设备动作之后**：`On` 在 `start()` 返回后、`Off` 在 `stop()` + `release()` 返回后（§12 #35 的「参数」缺陷由这条顺序钉住）。
- **录音属于「开始它的那通电话」**：`MediaRecorder` 是**服务级**对象，而服务活得比任何一通电话都长（`onCreate` 置位、`onDestroy` 才清）——「有录音在跑」与「有电话在跑」是两件事。录音**记住**它开始于哪通电话（`recordingCall`，在 `beginRecording` 里、`prepare()` 之前闩住），那通电话离场时由 `forget(call)` 逐字 `if (call === recordingCall) abortRecording()` **就地了结**它。用 abort 而非 finalize 是有意的：Rust 的 `Off` 通路（`real_set_recording(false)`）需要一通活着的电话，此刻已无人能读那份完成报告，而没人读的报告就是盘上一个没有台账行的孤儿文件 —— 正是 `abortRecording` 自己写的「no file, no row」规则。这是 `onDestroy` 既有 `abortRecording()` 的**寻常离场孪生**（REQ-A1859 / F-TEL-048）。
- **只有默认拨号器能切**：Android 只有把 AmOS 设为默认电话应用（`ROLE_DIALER`）才会绑定 `AmosInCallService`；未绑定时 `set_recording_for_window` 直接答 `"AmOS is not the default dialer, so no in-call service is bound"` 的错误，**不假装成功**（与 `real_answer`/`real_hang_up` 同形，§12 #8 已有的诚实划线）。
- **「是不是默认拨号器」之前还有一道前提：平台肯不肯把这个包当作候选**（2026-09-26，REQ-A1873 / F-AND-018）：RoleManager 判资格用的是 role 的 `RequiredComponent` —— 对 `ROLE_DIALER` 是**带 action DIAL、不带 data URI** 的 intent；只被 `<data android:scheme="tel"/>` 限定的 DIAL 过滤器接不到这条查询（`IntentFilter.matchData` → `NO_MATCH_DATA`），应用于是根本不出现在「默认电话应用」列表、`cmd role add-role-holder` 逐字拒绝、`AmosInCallService` 永不绑定。**两个 DIAL 过滤器缺一不可**（裸的拿资格、`tel` 的接链接），由 `scripts/android-role-scan.mjs` 按**过滤器形状**门禁（`android-glue-mirror.sh` 只按 `android:name` 比对，看不见这种增删）。真机上 AmOS 拿到 role 后，`AmosInCallService` 以 `requestedType: 1`（`DEFAULT_DIALER_UI`）被 Telecom 绑定、挂断时 `isCrashed: false`（§12 #43）。
- **仅前台窗口可切**：`set_recording_for_window` 先过 `require_foreground(&WmState, caller)`（与 `clipboard_read` 同一条规则）；后台应用或后台 WebView 里的脚本无法偷偷开录（F-TEL-001 隐私）。
- **能力 ≠ 时机**：`recordings_capture_status` 答的是**运行期能力**（是否 Android 构建 ∕ 是否绑定默认拨号器 ∕ 是否授予 `RECORD_AUDIO`），刻意**不含**「此刻是否正在通话」—— 能力不随通话起落闪烁，而录音键本来就只在通话中可达。缺哪一项就报哪一项的具名原因（`CAPTURE_NO_SEAM_REASON` ∕ `CAPTURE_NOT_DIALER_REASON` ∕ `CAPTURE_NO_MIC_REASON`）。
- **诚实划线**：宿主半（Tauri）的规则由主机单测与 Kotlin 源码钉（`include_str!` + 去注释）钉住、**编译期可见**；`MediaRecorder` 在真实蜂窝通话中 `start()` 是否成功、录到的**实际内容**、以及 `VOICE_CALL` 在平台签名构建上是否真的拿到，**本环境无法真机复核** —— 胶水侧只有 `make android-glue-check`（编译 + 警告即错 + Lint）。
- **录音的运行时状态机**（`amos-telephony` 域内核 + gRPC `StartRecording`/`StopRecording`，§6）与本节宿主半是两层：域内核只保证"仅 `Active` + 非紧急号 + 未在录"的合法迁移；REQ-A1579 的采集走的是 Tauri 这条链，与那个 provider 无关（见 `crates/amos-telephony/src/android.rs` 的模块头）。

---

## 11. 关键开放问题（已拍板，见 §12）
- 普通通话经**系统电信栈 `TelecomManager` 为主**，`TelephonyManager` 兜底（宿主 System UI 进程）。✅
- 来电默认**不给** `amos-ai`「静音接听前」钩子（隐私），保留后续开关。✅
- 紧急号表**自维护一份 `EmergencyMap` + 可被司法区覆盖**（`for_region`/`quick_dial`），不做运行时依赖 AOSP DB。✅

---

## 12. 审计校正与生产化记录（2026-09-04，Phase A+C）

外部把 telephony 描述为"静态页面 + 完全缺基带通信"并不准确（领域/服务/桥/桌面闭环已在 P0–P2 落地）；真正缺口是 P3 真机 backend 与若干生产化薄弱点。本轮据此校正并落地：

### #1 真电话宿主进程（架构定稿）
- 真实 Android provider 必须持 `Context` + `ROLE_DIALER` → **宿主于 System UI（`amos-tauri` APK）**，进程内 JNI 驱动（复刻 `amos-radio` 的 `AndroidRadioProvider` 模式）；**headless `amos-ai` daemon 不承载真机拨号**（它无 Context/无 ROLE_DIALER）。daemon 的 gRPC `TelephonyService` 定位为领域/桌面层。
- 结论落地于 §2 宿主进程 bullet 与 §10.4。

### #2 紧急硬保证的责任边界（口径纠正）
- Android 上"无 SIM / 锁屏 / 崩溃仍能拨 110/112"由 **framework(EmergencyNumber DB) + RIL/厂商 HAL + 平台锁屏紧急拨号器** 保证，**不是**用户态 Rust crate 能做或应宣称的"内核绝对保护通路"；也没有从 daemon 手写 `/dev/binder` 直连 TelecomManager 这条受支持路径。
- 本壳负责：分类 + **独立紧急 provider**（普通/紧急不共用实现）+ 审计（豁免限速、不免审计）+ `ROLE_DIALER` + 锁屏可信紧急入口。见 §5「责任边界」。真机验收仍需 OEM/root + 交叉窗（§8）。

### #3 `EmergencyMap` 司法区化（代码，已测）
- `crates/amos-telephony/src/number.rs`：新增 `EmergencyMap::for_region`（CN/US/GB/IE/AU/NZ/JP/KR/EEA…，每集恒含国际 112，去重）、`EmergencyMap::quick_dial(region)`（CN/CN-HK/CN-MO/JP→110，**KR→112**，US/CA/MX→911，**AU/NZ→000**，其余→112）、`codes()`；未知/空区域**回退 `common_global()`，绝不为空**（防把 110/112 误当普通号被 SIM 拒）。**一键拨号码必须是该司法区自己的号**：KR 的紧急号是 112/119（110 不在其列），AU/NZ 是 000（911 拨不通）——两张表由 `quick_dial_is_always_in_its_own_region_table` 交叉校验（REQ-A685）。
- Rust 单测：`cn_region_*`、`unknown_region_*`、`quick_dial_*`、`region_kind_*` 新增（51 通过）；前端 `lib/emergency.ts` 镜像 `quick_dial`（`quickEmergencyNumber`）。
- 第三份副本：host 的 `AmosInCallService.kt::is_emergency` 刻意不跨 JNI seam 而保留**本地扁平表**。它此前缺日本 118，已补齐；`the_host_copy_recognizes_every_canonical_emergency_code` 用 `include_str!` 读回该 Kotlin 源，断言 `for_region` 能产出的**每一个**码都在其中以 `digits == "<code>"` 出现——拓宽任一司法区而漏改 host 即红（REQ-A685）。

### #4 拨号器生产化（前端，已测）
- **锁屏紧急一键去硬编码**：`SystemPanels.tsx` 拨号与标签同取 `lib/emergency.ts::EMERGENCY_QUICK_NUMBER`；i18n `shell.emergency*` 改 `{num}` 插值（en/zh）。失败（无 daemon）时**自恢复**（重新可用）并给出 `shell.emergencyUnreachable`，不再永久卡在假"正在呼叫…"。
- **`PhoneApp` 无 daemon 拨号降级**：`telephonyDial` 返回 null 即退出 calling、回到键盘并提示 `phone.dialFailed`，不再滞留无 id 的假呼叫屏（原行为）。`endCall` 清错误。
- 前端测试：`emergency.test.ts`（单一来源/区域镜像/必须是紧急族）、`lockEmergency.test.tsx`（标签用共享号、无服务自恢复）、`PhoneRecording.test.tsx` 原"no daemon"用例改为断言新降级语义。`tsc --noEmit` 通过。

### #5 全功能拨号器（前端，已测）
- `PhoneApp` 抽出到独立 `components/PhoneDialer.tsx`（自 `CommsApps` 再导出），改为**标签页拨号器**：`键盘 / 最近 / 常用 / 紧急`。最近/常用为列表页（点选即回填键盘，select-then-place）；**紧急页**一键直拨共享的 `lib/emergency.ts::EMERGENCY_NUMBERS`（CN 集 + 通用 112，按职能标注，主号码高亮）并走 `telephony_dial(…, emergency: true)` 特权通路。
- 通话中（talking）增 **静音（Mute）** 与 **DTMF 拨号键**。**DTMF 仍为本地 UI 态**（按键音属音频管线）；**静音已不再是本地态（2026-09-22 更正）**：它现在经 `telephony_set_muted` → `SetMuted` 由 **daemon 持有**，与 `recording` 同形（权威快照回填、拒绝走 `inCallError`），因为「本地翻转」会让这块屏成为唯一相信用户已静音的界面 —— §12 #5 原先把两者都记成"本地 UI 态"，那句话对 DTMF 成立、对静音不成立。无论哪种，**真实麦克风静音/按键音仍属音频管线**（`docs/native-voice.md`），界面照旧如实说明、绝不假称音频已变。录音开关/挂断保持不变。
  - **「界面如实说明」这句话曾是一句空头支票（REQ-A1067 / F-SH-382，2026-09-22 补）**：键盘区既没有那句说明，每个按键的可访问名还是「**发送**按键 N」—— 一个**主动**声称「已发送」的名字，而 `pressDtmf` 只往本地 `dtmf` 串追加、没有任何通路把按键音送到通话（真实拨 IVR 时按 1，IVR 听不到，界面既不怪自己也不怪管线）。现补 `phone.dtmfLocal`（zh/en 同键）渲染在键盘下方，写法与 `phone.muted` 同形（说清哪些是真、哪些不是），并把 `phone.dtmfKey` 由「发送按键 {key}」改为「按键 {key}」（en `Send key {key}` → `Key {key}`）。回归：`svelte-tests/phone.svelte.test.ts` 新增一例（红先行：41 passed / 1 failed）；负控两向各恰 1 红（拿掉说明删一条 / 把名字改回「发送」删另一条）。
- 测试：`PhoneDialer.test.tsx`（紧急特权拨号、接通后可静音、DTMF 键开合）、`PhoneApp.test.tsx` 改写（Recents/Frequent 标签 + 点选回填）；`PhoneRecording`/`MessagesApp`/emergency/lock/i18n 仍绿；`tsc --noEmit` 通过。

### #6 服务端硬化与审计核查（2026-09-04 追加）
- `Number` 服务端权威**长度上限**：新增 `MAX_LEN = 18`（与拨号器 UI 对齐；E.164 ≤15，余量给本地区号），超过即 `InvalidNumber`——被构造的 gRPC `Dial` 无法让 provider 拨打病态超长号。按规范化**位数**计数（忽略分隔符/前导 `+`）。单测 `number_length_is_server_capped` 通过。
- 核查确认：`amos-ai` daemon 在共享 UDS 上真实挂载 `amos_telephony::service::demo_server()`（`amos-ai/src/server.rs`），拨号器→Tauri→daemon→provider 链路是活的，非死代码。
- **记录待办（未在本轮实现）：** 普通拨号的**每客户端速率限制**仍是 daemon（`amos-ai`）安全层的事；`TelephonyService` 不在 AiAgentService 的 security 门内。
- **紧急拨号审计已实现（本轮）**：新增 `crate::audit`（`AuditLog`，有界 1024、最新在前、`Accepted/Rejected`），`TelephonyService::dial` 对每个被解析的拨号落审计——紧急自动路由/强制紧急记为 `operation="emergency_dial"`（豁免限速、绝不遗漏），普通为 `"dial"`；拒绝同样留 `Rejected`。**不可解析的超长/垃圾输入不落审计**（避免回显攻击者控制的巨型串）。访问：`TelephonyService::audit_log()`。Rust 全量 **56 单测 + 2 UDS e2e** 通过、`clippy -D warnings` 干净、`amos-ai` check 通过。

### #7 普通拨号限速、紧急豁免（已实现）
- 新增 `crate::rate::DialRateLimiter`：**每客户端**固定窗口计数（默认 `_default` 桶；gRPC 元数据 `x-client-id` 可选细分，设备上通常单一 System UI 主体）。**有界**：不同 client 上限（默认 256，`with_clients` 可配），过期窗口随访问剪除——伪造海量 `x-client-id` 无法撑爆内存（memory-DoS）。
- `TelephonyService::dial`：**紧急**（自动路由或强制）**永不限速**；**普通**在有 limiter 时先 `allow(client)`，超限返回 `ResourceExhausted` 且留审计（`dial` Rejected rate limit exceeded）。未配置 limiter（strict/mock、headless e2e）保持不限速，既有测试不受影响。
- daemon 改用 `amos_telephony::service::demo_server_limited(30)`（`amos-ai/src/server.rs`）——普通拨号 30/分/客户端，紧急豁免。新增构建器 `with_mock_demo_limited(cap)` 与 `demo_server_limited(cap)`。
- 测试：`rate` 模块（window 内达上限拦截、按客户端隔离）+ 服务层（普通限速后紧急仍可拨、`a/b` 两客户端预算独立）。Rust 全量 **60 单测 + 2 UDS e2e**、`clippy -D warnings` 干净、`amos-ai` check 通过。

### #8 P3 真机接线骨架落地（编译门控，真机待验）
- `crates/amos-telephony/src/android.rs`（feature `android` = `dep:jni`，lib 侧 `#[cfg(feature)]` 门控并导出 `AndroidTelephonyProvider`/`AndroidEmergencyTelephonyProvider`）：
  - 复用 `amos-radio` 的 `AndroidContext(GlobalRef)` + 线程 attach 模式；`dial`/`emergency_call` 用 `ACTION_CALL` + `tel:` intent 从 System UI `Context` **真实起呼**，返回 provider call id；`subscribe` 挂到 `EventBus` 注册表（真机回调接入后广播）。
  - 诚实划线：`answer`/`end`/录音/实时 `status` 明确返回 `Provider(...P3 device-validated...)`，不假装；TODO(device) 标注 `ACTION_CALL`→`TelecomManager#placeCall` 迁移与 InCallService/TelephonyCallback 接入。
- 验证：`cargo check --features android`、`cargo clippy --features android -D warnings` 均通过；默认(desktop/CI) 构建不含 JNI 栈、不受影响。
- 真机仍需：System UI(ROLE_DIALER) APK 交叉编译、真实起呼/接听/来电注入与锁屏无 UI 紧急拨号按 §5 验收。

### #9 Binder 化 `TelecomManager#placeCall` + 紧急路由统一层（2026-09-08，编译门控、真机待验）
- 把 §12 #8 里 `android.rs` 的 `ACTION_CALL` intent 起呼**替换为 `TelecomManager#placeCall(Uri, Bundle)`**（System UI `Context` 经 `getSystemService("telecom")` 直取，即 Binder `ITelecomService` 事务的 JNI 等价物），不再走广播 intent。仍诚实划线：`answer`/`end`/录音/实时 `status` 保持 `Provider(P3 device-validated)`，接听/挂断/来电/录音需 `InCallService`/`TelephonyCallback` 桥（P3，真机验收）。
- **新增 `crate::route` 紧急路由统一层**（VM-free，主机可测）：`DialRoute{Emergency,Regular}` + `route()` + `guard_regular()`/`guard_emergency()`。`MockTelephonyProvider`（`provider.rs`）与 Android 两个 provider **共用同一决策**：普通 provider 拒绝紧急号（新错误变体 `TelephonyError::MustUseEmergencyPath`，措辞区别于紧急路径拒绝普通号的 `NotEmergency`），紧急 provider 拒绝普通号 → 110/112 永不落入 SIM 路径、普通号永不被特权路径静默放行。`AndroidTelephonyProvider`/`AndroidEmergencyTelephonyProvider::new` 现需携带 `EmergencyMap` 以便在 Binder 事务前强制分离。
- 工程边界（与 §1 硬性红线一致）：`placeCall` 宿主于 `system_server` 的 `ITelecomService`，**`/dev/binder` 手写 ioctl 只是重新实现这一调用且毫无崩溃免疫**——"无 SIM/锁屏/无 UI 也能通 110/112"由 modem/RIL 在网络层路由保证；OS 完全卡死属 OEM 硬件（独立供电域）。见 `android.rs` 模块头文档。
- 验证：`cargo test -p amos-telephony --lib` **68 通过** + `tests/telephony_rpc_e2e.rs` **2 通过**；`cargo clippy -p amos-telephony --all-targets -- -D warnings` 干净；`cargo check --features android` + `cargo clippy --features android -D warnings` 通过；`cargo check -p amos-ai` 通过。

### #10 来电铃声/振动页的旧 `vibrate` 位退休（前端，2026-09-22，REQ-A1076 / F-SH-391）

- 背景：`RingtonePage.svelte`（「来电铃声与振动」）在 REQ-A993 / F-SH-314 之后把**振动位**统一到 `lib/sound` 的 `amos.sound.vibrate`，做法是挂载时把旧记录 `amos.ringtone` 里的 `vibrate` 一次性搬过去（`saveSound`）。**但旧记录里的那位没删掉**，而 `lib/callRingtone.normalizeRingtonePrefs` 的读法是「旧位存在则优先」（`typeof fields?.vibrate === "boolean" ? fields.vibrate : vibrateFallback`），于是它**永远压过**策略位。
- 缺陷（实测）：升级用户（旧记录带 `vibrate:false`）在本页打开「来电时同时振动」、`amos.sound.vibrate` 也为 `true` 时，`callTone.playIncomingRing` 仍拿到 `plan.vibrate === false` —— 开关显示 ON、来电不振动；反向亦然（旧 `vibrate:true` 永远压过被关掉的策略位）。模块头写着旧位只读 **once**、页面注释写着「之后只写 `selected`」—— 文档承诺的退休，代码没做。
- 修复：`lib/callRingtone` 新增纯函数 `hasLegacyVibrate(raw)`（与 `normalizeRingtonePrefs` 共用抽出的 `parseStoredFields` 容错解析）；`RingtonePage.svelte` 在迁移之后，只要旧记录仍带布尔 `vibrate`，就把 `amos.ringtone` 重写成 `{selected}`。迁移当次仍读旧位（旧关→新关），只是搬走后不再留痕。
- 验证：新 DOM 用例（先证后修：未改前 `rawRingtone().vibrate === false`、纯探针 `incomingRingPlan('{"selected":"guitar","vibrate":false}', true).vibrate === false`）；NC-A 停用退休写 / NC-B `hasLegacyVibrate` 恒 `false` 各 **恰 1 红**，`cp` 到 /tmp 后逐字节还原；`bunx vitest run` **166 files / 1987 passed**，`tsc`/`svelte-check` 0 error 0 warning。

### #11 PhoneApp 黑名单「实时预览」的过期答复落地（前端，2026-09-22，REQ-A1077 / F-SH-392）

- 背景：`PhoneApp.svelte` 的拦截页有一条「实时预览」`$effect`：把正在输入的地址防抖 250ms 后问宿主 `blocklist_check(addr, channel)`，只有**正命中**才把结果写进 `blockPreview`（该 effect 注释承诺 `Only a positive match is kept`，并自带 `addr === ""` 时置 `null` 的守卫）。
- 缺陷（实测）：effect 的清理函数是 `return () => window.clearTimeout(id)` —— 取消的只是**尚未触发的防抖定时器**，而在飞行中的 `blocklistCheck` **promise** 无人失效。用户输入一串号码、防抖已触发请求已发出，随即清空（或改动）输入框：effect 重跑执行了置 `null` 的守卫，但**迟到的答复**随后 `blockPreview = r` 又把预览写了回来 —— **空输入框上重新长出「将被拦截：匹配规则「10086*」」**，为一个已放弃的号码画出匹配。这正是 memory `project_async_read_lands_after_the_switch` 那一族：要守的是**落地**，不是排程。
- 修复：预览 effect 的闭包加 `let live = true`；`.then` 落地前 `if (!live) return;`；清理函数改为 `() => { live = false; window.clearTimeout(id); }` —— 排程（定时器）与落地（promise）同受一个生命周期约束，输入／频道／标签一变两处同时失效。不改 `blocklistCheck`（无状态、无副作用），不新造 store 键，不动 250ms 防抖。
- 验证：新 DOM 用例 `a preview reply landing after the field is cleared is dropped, not drawn (REQ-A1077)`（受控 promise ⇒ 等 300ms ⇒ 清空 ⇒ 断言无预览 ⇒ resolve 匹配 ⇒ 断言仍无预览）；先证后修（未改前清空后 `block-preview` 仍在）；NC-A 停用落地守卫 / NC-B 清理不置 `live=false` 各 **恰 1 红**，`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原；`bunx vitest run svelte-tests/phone.svelte.test.ts` **43 passed**。

### #12 来电浮层被拒提示的「动作名/状态」纠正（前端，2026-09-22，REQ-A1088 / F-SH-402）

- 背景：`IncomingCall.svelte` 的 `leave()` 是**一个函数支撑两个键** —— 振铃面的「拒绝」（`aria-label={t("phone.decline")}`）与通话中面的「挂断」（`aria-label={t("phone.hangup")}`）。两条路径在 `telephony_end` 被主机拒绝时都写同一条 `t("phone.declineFailed", { detail: why })`。
- 缺陷（实测，对 HEAD 先于本轮存在）：旧文案 `phone.declineFailed` =「**挂断**失败：{detail}——这通电话仍在**通话中**」。于是**在振铃时按「拒绝」**被拒，屏幕说的是**挂断**失败、并断言这通电话「仍在**通话中**」—— 而它其实还在**振铃**：动作名与状态**同时说错**。这不是有意统一：同表面的 `answer()` 早已用正确的状态词（`phone.answerFailed` =「接听失败：…仍在**振铃**」），兄弟面 `PhoneApp.svelte` 的通话中挂断早已用 `phone.hangupFailed`（「挂断失败：…**没有被挂断**」）；本页只是把一句错话复用到两个键，而 `declineFailed` 的**键名**（decline）与**旧文案**（挂断）本就互相矛盾，名字与文案之间没有任何仪器。既有用例 `a refused hang-up keeps the call on screen` 只断言弹窗仍在、错误含 `unavailable`，**从不检查是哪一句**。
- 修复：`leave()` 按 `phase === "ringing"` 分流 —— `declining ? t("phone.declineFailed") : t("phone.hangupFailed")`；`zh.ts`/`en.ts` 把 `phone.declineFailed` 改正为「拒绝失败：{detail}——这通电话仍在振铃」/ "Decline failed: {detail} — the call is still ringing"（键名终于与文案一致）；通话中挂断**复用** `phone.hangupFailed`，不新增键；`crates/amos-tauri/src/telephony.rs` 的文档注释同步（旧注释把 `declineFailed` 说成 "still live"）。
- 验证：`svelte-tests/incoming-call.svelte.test.ts` 新增两条以**字面短语**断言的镜像用例（拒绝 ⇒ 含「拒绝失败」「仍在振铃」、**不含**「仍在通话中」；挂断 ⇒ 含「挂断失败」「没有被挂断」）—— 用字面量而非本地化键，避免 memory `project_unfailable_assertion_matches_default` 那种「期望值等于坏默认值」的不可失败断言。**NC-A**（折回单一 `declineFailed`）⇒ 恰 1 红、**NC-B**（还原 zh 旧文案）⇒ 恰 1 红，`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原（`IncomingCall.svelte` sha `de4bb673…`、`zh.ts` sha `7085a0a5…`）。`bunx vitest run svelte-tests/incoming-call.svelte.test.ts` ⇒ **16 passed**；全量 `bunx vitest run` **168 文件 / 2010 例** 全绿；`tsc --noEmit` 0 error、`svelte-check` 0 error 0 warning、`i18n-scan` 四项 OK。

### #13 来电「接通/结束」两条边的方向与号码保真（Rust 线上契约，2026-09-22，REQ-A1095 / F-SH-409）

- 背景：`crates/amos-telephony/src/provider.rs` 的 `ProviderEvent` 是守护进程向每个 `Watch` 订阅者推送的信令事件。枚举自己的文档承诺每个事件都 "Carries just enough to build a wire snapshot without a state round-trip"；`RecordingChanged` / `MutedChanged` 两个变体确实携带了 `peer` + `state` + `direction`（这正是 REQ-A992 那一轮的结论：事件被订阅者**当作快照整体应用**，少带一个字段就会把别的字段静默清掉）。
- 缺陷（实测，对 HEAD 先于本轮存在）：`Connected` / `RemoteEnded` / `LocalEnded` / `Failed` 这四个变体**只带 id**，于是 `service.rs::event_to_state_event` 只能自造答案 —— 四个分支一律硬编码 `ProtoDirection::Outgoing`，后三个还把 `peer` 写成 `String::new()`。读者 `IncomingCall.svelte` 第 81 行的守卫恰是 `if (c.direction !== "Incoming") return;`（呼出电话归 Phone 页面自管），第 103 行写通话记录还要求 `c.peer` 为真。于是**来电**只有 Ringing 一条边能过：接听后的 Active、拒接/挂断与对端挂断的 Ended 全被丢弃。后果两条：**(a)** `amos.calllog` 收不到任何来电（含未接）—— Ended 分支是该日志**唯一的生产写入者**，也是 REQ-A150 的「被拒写入转 pending 队列」（`queuePendingCall`）的**唯一生产调用点**，该缓解在生产里因此从未被执行；**(b)** 对端挂断后覆盖层不消失，屏幕被钉在已结束的「通话中」。
- 为什么全绿：`svelte-tests/incoming-call.svelte.test.ts:83` 直接 `emit` 了一条「Ended 边带 Incoming 方向」的形状 —— **生产端从不发出这种形状**，读者守卫在测试里因此恒真；Rust 侧 `every_change_event_carries_both_mutable_flags` 只断言 `connected.state === Active`，从不问它的 direction（同 memory `project_fixture_omits_the_field`：夹具与生产者不一致的绿是假绿）。
- 修复：①四个变体携带 `peer: Number` + `direction: CallDirection`，与 `*Changed` 同形；②四个发射点（`simulate_connected` / `answer` / `simulate_remote_ended` / `end`）改为**先把快照抓下来（peer + direction），再改状态 / 移出 map** —— 结束边是**最终快照**，事件到达时该呼叫已不在 `status()` 里；③mapper 改用 `peer.as_str().to_string()` 与 `proto_direction(direction)`；④`ProviderEvent::Incoming` 仍不携带方向（振铃只有一种方向），文档注释写明这处不对称是**有意**的。前端**未改**：`IncomingCall.svelte` 的守卫与通话记录写入本就是正确契约，此前只是对着一个说谎的生产端在运行。
- 验证：`service.rs` 新增 `incoming_call_keeps_direction_and_peer_through_to_the_end`（注入来电 → 接听 → 本地挂断，三条边逐条断言 `direction == Incoming` 且 `peer` 仍在）；`provider.rs` 新增 `ended_events_for_an_answered_incoming_call_stay_incoming`，并把 `answering_an_incoming_call_broadcasts_connected`、`local_hangup_broadcasts_local_ended` 升格为**整体相等**断言（带上 peer 与 direction）。**先证后修**：新用例对未改前的 mapper 运行 ⇒ 恰 1 红（`left: 0, right: 1`，即 Active 边被标成 Outgoing）；**负控**（mapper 四个分支还原成 `String::new()` + `ProtoDirection::Outgoing`）⇒ 恰 2 红、既有 87 例仍绿，`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原（`service.rs` = `cdbe4407d0ea31a2768d66c7bfe5ac363fbf864a2dd50ee657b730b4f14a6ec0`、`provider.rs` = `f61ea1afc5d5633d5d0e525bbf003b6efd746086c7caafade9d63d1601db8af8`），绝不用 `git checkout --`。`cargo test -p amos-telephony` ⇒ 89 passed（lib）+ 2 passed（e2e）；`cargo clippy -p amos-telephony --all-targets` 0 warning；`cargo check --workspace` 通过；前端 `bunx vitest run svelte-tests/incoming-call.svelte.test.ts` ⇒ 16 passed。如实边界：只改线上事件的方向/号码保真，未动命令/路由/限速/审计；`ProviderEvent::Failed` 在 mock 中无发射点，仍按同形状补齐以消除不对称。

### #14 「模拟来电」按钮丢掉自己那条命令的拒绝，并先弹 Dock 再发命令（前端，2026-09-22，REQ-A1096 / F-SH-410）

- 背景：键页面底部那条 `phone.simIncoming`（「模拟来电」）是 demo 入口，用于在桌面上手动唤起来电浮层。它调 `telephonySimulateIncoming(from)` → Tauri `telephony_simulate_incoming`（`crates/amos-tauri/src/telephony.rs:585`），后者在守护进程不可达或拒绝注入时回一个 **typed `AmosError`**（`TelephonyRpcFailed` / `TelephonyNumberTooLong`）；共享的 `invoke` 把它折成 `null`，原因留在 `bridgeDiag("telephony_simulate_incoming")`。
- 缺陷（实测，对 HEAD 先于本轮存在）：`PhoneApp.svelte::simIncoming` 形如 `const s = surface(); if (…) emitDockBounce("phone"); await telephonySimulateIncoming(from);` —— 它**既不读返回值也不读 `bridgeDiag`**。于是被拒的注入：没有来电、没有半个字解释，而 `emitDockBounce` 已在 `await` **之前**触发（弹跳本身就宣告「有来电接入」）。同文件的兄弟动作 `telephony_end` / `telephony_start_recording` / `telephony_stop_recording` / `telephony_set_muted` 全部 `callActionOutcome(bridgeDiag(command))` 并渲染拒绝（各有专门用例 PIN），故这是此处独有的疏漏而非约定。
- 渲染点：拒绝必须写进 `dialError`（`PhoneApp.svelte` 第 703 行 `{#if !calling}`，键页面自己的失败槽）；`inCallError` 在第 726 行 `{#if calling}` **之内**，键页面没有它的渲染点 —— 与 §12 #12（REQ-A997）同一条推理。
- 修复：①入口先清 `dialError` / `notice`（「每动作的判词槽在下个动作开始时被清」的仓库惯例，与 `startCall` / `toggleRecord` / `toggleMute` 一致）；②`await` 之后 `callActionOutcome(bridgeDiag("telephony_simulate_incoming"))` 读判决，`refused` 时写 `dialError = t("phone.simIncomingFailed", { detail })`（detail 为空回落 `phone.actionNoReason`）并 `return`；③`emitDockBounce` **移到**判词之后 —— 只有确认的注入才弹码头。新增文案键 `phone.simIncomingFailed`（zh + en）。`crates/amos-tauri/src/telephony.rs` **未改**。
- 验证：`svelte-tests/phone.svelte.test.ts` 新增 `a refused simulate-incoming says so and does not bounce the Dock`（宿主抛 `amos.telephony.rpc_failed` ⇒ 断言键页面出现 `[role="alert"]`、含宿主原话与折语、且 `dock-bounce` 事件不含 `phone`）与对照 `a granted simulate-incoming bounces the Dock and reports nothing`。**先证后修**：两条用例对未改前的 `simIncoming` 运行 ⇒ 恰 1 红（拒绝用例无告警）；授权用例在负控下仍绿 —— 它是「若把修复做成『一律拒绝』就会红」的边界对照。**负控**：还原成 HEAD 版「先弹码头再 await、不读判决」⇒ 1 红 ∕ 46 绿（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `PhoneApp.svelte` = `30054728555520a555b223965b671aa9d990112d2cc0a5392898a570fd978bee`，绝不用 `git checkout --`）。`bunx vitest run svelte-tests/phone.svelte.test.ts` ⇒ **47 passed**（原 45）。如实边界：只改一个动作与一个文案键；`MAX_TELEPHONY_DIAL_BYTES=64` 而键盘 `MAX_DIAL_LEN=18`，故「号码过长」分支不可达，真正可达的拒绝是 RPC 失败 ∕ 未桥接。

### #15 前端的紧急号判定没做 daemon 的规范化（前端，2026-09-22，REQ-A1105 / F-TEL-010）

- 背景：§3 的 `EmergencyMap` 分类发生在 Rust 侧，输入已经被 `Number::new`（`crates/amos-telephony/src/number.rs`）规范化过 —— 它 `trim()` 后剥掉空格/连字符/左右括号（`filter(|c| !matches!(c, ' ' | '-' | '(' | ')'))`），再由 `digits()` 去掉可选前导 `+`，才交给 `EmergencyMap::is_emergency`。本文件 §5 保证 #5 把这个结果写成要求：「紧急号去空格/连字符后仍须命中 `EmergencyMap`；命中即走紧急通路，绝不落进普通 dial 被 SIM 判断拒掉」，§5 验收表也据此列了「带连字符/空格仍命中」一条。
- 缺陷（实测，对 HEAD 先于本轮存在）：前端另有一份分类实现 `crates/amos-tauri/frontend-ts/src/lib/emergency.ts::isEmergencyNumber(number)`，它做的是 `(EMERGENCY_CODES as readonly string[]).includes(number.trim())` —— **只 trim，不剥号内分隔符**。它不是一个纯展示函数：`lib/phone.ts::placeOutgoingCall` 用它决定一个号码在**无 daemon** 时是否允许落到普通 `ACTION_CALL`（`realDial`），即 §5 保证 #5 所说「绝不落进普通 dial」的那道闸门。
- 可达路径：联系人电话字段由 `lib/contacts.ts::cleanPhones` 处理，**只 `trim()`**（`"1 1 0"` 原样保存）→ `ContactsApp.svelte::callNumber(num, …)` → `placeOutgoingCall(num, isEmergencyNumber(num), …)`。无 daemon 的桥下，`isEmergencyNumber("1 1 0")` 为 false ⇒ 号码被当作普通号交给 `real_dial`（`ACTION_CALL`）——daemon 眼中是 110、前端眼中是普通号。
- 为什么没有门禁看见：`declaredMirrors.test.ts` 只把 `EMERGENCY_CODES` 的**码表**与 `EmergencyMap::common_global()` 两向绑定，不绑规范化；`emergency.test.ts` 原有 3 例只覆盖「两端空白不算另一个号」。
- 修复：`isEmergencyNumber` 按 daemon 的同一规范化再比对 `EMERGENCY_CODES` —— `number.trim().replace(/[-() ]/g, "").replace(/^\+/, "")`。剥离集合与 `Number::new` 逐字一致；`EMERGENCY_CODES` 仍是唯一码表，`quickEmergencyNumber` / `regionFromLocale` / 一键拨号路径与全部 Rust 代码未改。
- 验证：`src/__tests__/emergency.test.ts` 13 → 14 例（`"1 1 0"` / `"1-1-0"` / `"(110)"` / `"11-2"` / `"9 1 1"` / `"0 0 0"` / `"1 (1) 9"` 全数命中；`"1 100"` / `"1 1 00"` / `"11 0 0"` / `"-110-1"` / `"(1100)"` 全数不命中 —— 后半是不可丢的一侧，否则修复会把每次无 daemon 呼叫都拒掉）；`svelte-tests/contacts.svelte.test.ts` 33 → 34 例（联系人存 `"1 1 0"`、daemon 不在、`real_dial` 可用 ⇒ 界面写「无法呼叫」而非「已交给系统拨号器」、呼叫记录为空）。**先证后修**：两条新断言对未改前的代码运行 ⇒ 各 1 红（界面逐字渲染出「已交给系统拨号器」）。**负控**：还原成 `trim()` 版 ⇒ 恰 1 红 ∕ 13 绿 + 1 红 ∕ 33 绿（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `emergency.ts` = `a2fcb70005d4ab72b1389819607407cafa8042f538017c799bb22c934a3fdd30`，绝不用 `git checkout --`）。如实边界：只改一道前端兜底判定；daemon 侧仍按自己的表重分类（本文件模块头已声明），故本缺陷只影响**无 daemon 的兜底**这一段；未做真机复核。

### #16 通话中的时长读数不是「可查询」的（前端，2026-09-22，REQ-A1114 / F-SH-427）

- 背景：本文件 §7 的通话界面上，通话时长是这条界面上**唯一**一个每秒自己变化的活读数。它的同类 —— 四个时钟面（`StatusBar.svelte:119` / `LockScreen.svelte:159` / `modules/ClockWidget.svelte:59` / `modules/StageClock.svelte:44`）—— 都由 REQ-A284 定为「按需查询」：`role="timer"` + 稳定 `aria-label`，**不加** `aria-live`（每秒播报是敌意行为）。
- 缺陷（实测，对未改前的工作树）：`crates/amos-tauri/frontend-ts/src/svelte/PhoneApp.svelte:733` 把名字挂在 `<div aria-label={t("a11y.callDuration")}>{fmtCallDuration(elapsedSec)}</div>` 上 —— 一个**没有 role** 的 `<div>`。role-less 元素上的 `aria-label` 对辅助技术什么也没命名（generic role 不支持命名），于是通话中的读屏用户永远问不出这通电话打了多久；同类的四个面全都有 `role="timer"`，唯独通话面没有。
- 为什么没有门禁看见：`scripts/a11y-scan.mjs` 的 R5（live-region）是**按文件**放行的 —— PhoneApp 里已有 `role="status"`(:716) 与 `role="alert"`(:720)，整份文件对 R5 直接 bail out，这个**元素级**遗漏从不被报；`svelte-tests/live-region-a11y.svelte.test.ts` 只枚举四个时钟面，不含任何通话面；`svelte-tests/phone-outgoing.svelte.test.ts:93` 对它的断言是**存在性**（`querySelector` 到即通过），从没问过角色。
- 修复：给该 `<div>` 加 `role="timer"`，与四个时钟面同一契约；保持**静态**角色、**不加** `aria-live`。`fmtCallDuration` / `elapsedSec` 计时器 / `placeOutgoingCall` / 紧急号通路 / 录制 ∕ 静音标志一律未动，不改 Rust ∕ proto ∕ 事件流 ∕ i18n 键。
- 验证：`svelte-tests/phone-outgoing.svelte.test.ts`（4 例，:93 由存在性加强为 `role="timer"` + 稳定标签 + 时长形值 `^\d{1,2}:\d{2}(:\d{2})?$`）。**先证后修**：加强后的断言对未改前组件运行 ⇒ 恰 1 红 ∕ 3 绿（`expected null to be 'timer'`）。**负控**：去掉 `role="timer"` ⇒ 恰 1 红 ∕ 3 绿（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `PhoneApp.svelte` = `0e4a087fb9c19f8b55c115cfd7973fed7d125a5b9a398592d983f5cf39e3d05e`，绝不用 `git checkout --`）。如实边界：只加一个静态角色 + 加强一条断言；同一形状在 `ClockApp.svelte:481/534/726`（另一个 app 的三处读数）仍在，本轮如实记为边界、不在窗口内；未做真机复核。

### #17 从联系人拨出的电话在通话记录里没有方向（前端，2026-09-23，REQ-A1117 / F-TEL-011）

- 背景：§13 的通话记录页读的是一条共享记录 —— `lib/calllog.ts::recordCall(list, number, name?, now = Date.now(), direction?)` 写进 `amos.calllog`，历史页的行首方向字形（`↗` ∕ `↙` ∕ 中性 `•`）、无障碍名（`dirLabel` → 「去电」∕「来电」∕「未接」∕「通话」）与「去电」筛选（`filterHistory(list, "outgoing")` 用 `r.direction === "outgoing"`）都只读这一个字段。
- 缺陷（实测，对未改前的工作树）：`crates/amos-tauri/frontend-ts/src/svelte/ContactsApp.svelte::recordOutgoing` 调的是 `recordCall(callLog, num, name)`，**第 5 个参数 `direction` 整个省略**；而同一动作在拨号盘侧的兄弟 `PhoneApp.svelte:474::recordOutgoing` 写的是 `recordCall(callLog, number, name, Date.now(), "outgoing")`。两条路径写的是**同一个** `amos.calllog`。`recordCall` 的签名里 `direction` 可选，省略即 `undefined`；`normalizeCallLog` 只在 `normalizeDirection(o.direction)` 命中时才写 `rec.direction`，所以该行在存储里同样没有 `direction` 字段。后果：从联系人拨出的一通电话，方向为 `undefined` ⇒ 行首画中性圆点 `•`（而非 `↗`）、`dirLabel(null)` 报「通话」，并且被历史页自己的「去电」筛选**藏掉** —— 一次用户真的拨出的通话，在**它自己的**记录页里找不到。
- 为什么是缺陷而非省略：`PhoneApp.svelte` 在 **managed** 与 **handed-off** 两条分支上都调同一个 `recordOutgoing`，即无论走 daemon 还是落到系统拨号器，那一次拨出都记为「去电」；联系人页走的是**完全同一个** `placeOutgoingCall`，两者语义相同、写法不同。`grep -n "recordCall(" src/svelte/` 三处生产调用 —— `IncomingCall.svelte:106` 传 `answered ? "incoming" : "missed"`、`PhoneApp.svelte:474` 传 `"outgoing"`、`ContactsApp.svelte:629` **不传**，本轮扫过全部兄弟调用点，只有这一处漏。
- 为什么没有门禁看见：`svelte-tests/contacts.svelte.test.ts:205` 只断言 `expect(callLog()).toHaveLength(1)` —— **存在性**，从不问方向；`src/__tests__/calllog.test.ts` 覆盖的是 `recordCall` ∕ `filterHistory` 这些**纯函数**（它们对传进来的 `direction` 一律正确），没有任何一例问「联系人页拨出时传了什么」。
- 修复：`recordOutgoing` 补上 `Date.now(), "outgoing"`，与拨号盘逐字一致；不改 `recordCall` 的默认值、不新增第二个写入口；不改既有无方向行（`direction` 仍可选，旧记录照旧渲染为中性行 —— 它的注释写明「records written before directions existed have none, and the UI shows a neutral row for those rather than pretending they were outgoing」）。不改 Rust ∕ proto ∕ 事件流 ∕ i18n 键，不改 `filterHistory` ∕ `dirLabel`。
- 验证：`svelte-tests/contacts.svelte.test.ts`（34 例，:205 加强）：`an accepted dial records the call and the notification` 追加 `expect((callLog()[0] as { direction?: unknown }).direction).toBe("outgoing")` —— 断言读的是**记录本身**，而不是界面上的字形（字形依赖 `dirLabel` 的另一条链，会把两件事混在一起）。**先证后修**：加强后的断言对未改前的 `ContactsApp.svelte` 运行 ⇒ 恰 1 红 ∕ 33 绿（`expected undefined to be 'outgoing'`）。**负控**：去掉方向参数 ⇒ 恰 1 红 ∕ 33 绿（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `ContactsApp.svelte` = `b4e0a0ae6bc67bc42f6d91e924af0ace6bf7a49ca8981e30974bc4b39357a7cc`、`contacts.svelte.test.ts` = `da3f16136b62a780dd9605c391ed0a614a18e3c6054255904eb4ed0a90809299`，绝不用 `git checkout --`）。如实边界：只保证**新写的**拨出带方向；纯记录保真缺陷，不影响拨号是否真的发生（daemon ∕ `ACTION_CALL` 通路一律未动）；未做真机复核。

### #18 联系人表单只在第一个号码上查重（前端，2026-09-23，REQ-A1119 / F-TEL-013）

- 背景：联系人表单的电话字段是一个**列表** —— 它自己的 aria-label 就逐字写着「电话号码（逗号/换行分隔）」，`submit` 也按 `/[,，\n]/` 把它拆成多个号码 `ph`，随后 `addContact` ∕ `editContact` → `cleanPhones` 原样保存整组。查重用的 `contactsWithPhone(list, raw)` 的语义是「这个号码属于谁」（数字归一化 + 后缀规则），一次问一个号。
- 缺陷（实测，对未改前的工作树）：`crates/amos-tauri/frontend-ts/src/svelte/ContactsApp.svelte::submit` 只拿 **`ph[0]`** 去问 —— `editing ? contactsWithPhoneExcept(contacts, ph[0]!, editing.id) : contactsWithPhone(contacts, ph[0]!)`（`git show HEAD` 同样如此）。于是「139…, 138…」（第二个号已属于**别人**）照样保存：两个联系人共享一个号码。后果不止「重复」本身：反向查找 `contactNameFor` 取 `contactsWithPhone(...)[0]`，即列表里的**第一条**匹配，来电浮层于是报出**错的名字**；`primaryPhone` 取 `phones[0]`，快速拨号也不会指向被顶替的那位。编辑路径同理（`contactsWithPhoneExcept` 的臂）。
- 为什么是缺陷而非有意的简化 —— **同仓反证**：`lib/contactTransfer.ts::mergeImported` 的注释逐字写着它「mirroring the manual add dup-guard」，而它的实现是 `const dup = phones.some((p) => contactsWithPhone(list, p).length > 0);` —— **逐号**检查，注释还写着「a bulk import must never create a same-number duplicate」「nothing is merged silently」。也就是说：vCard 导入路径做对了，手动路径才是那个**不符合同一个描述**的；两者本该同形（这正是本仓刻意的镜像约定）。
- 为什么没有门禁看见：`svelte-tests/contacts.svelte.test.ts:91` 的 `duplicate number is rejected (dup guard)` 只喂**一个**号码（`addContact(host, "B", "13800000001")`），从没有一例把重复号放在第二位；`src/__tests__/contacts.test.ts` 覆盖的是 `contactsWithPhone` ∕ `contactsWithPhoneExcept` 这些**纯函数**（它们对传进来的**单个**号码一律正确），不属于「表单传了哪几个号」的问题。
- 修复：守卫改为 `const dup = ph.some((p) => (editing ? contactsWithPhoneExcept(contacts, p, editing.id) : contactsWithPhone(contacts, p)).length > 0);`，与 `mergeImported` 同形。不改 `contactsWithPhone` ∕ `contactsWithPhoneExcept` ∕ `addContact` ∕ `editContact` ∕ `cleanPhones` ∕ i18n 键 ∕ Rust ∕ proto，`status` 仍用同一个 `contacts.dup`。
- 验证：`svelte-tests/contacts.svelte.test.ts`（36 例，+2）：`a duplicate in any position is rejected, not just the first`（新增：`13900000009, 13800000001` ⇒ 拒绝、B 未加入）与 `the edit path also blocks a duplicate in any position`（编辑：A 保留自己的号、加入 B 的号 ⇒ 拒绝；被编辑行用**行内号码**定位，不靠「第一个 编辑 按钮」——列表按姓名排序，位置不可靠）。**先证后修**：两条新用例对未改前守卫运行 ⇒ 恰 2 红 ∕ 34 绿。**负控**：把守卫折回 `ph[0]` ⇒ 恰 2 红 ∕ 34 绿（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `ContactsApp.svelte` = `2b84ab04ba368b5f2f63e33182fa4896624b2133eea4d7064de59fb10f89168f`、`contacts.svelte.test.ts` = `5b800071ff4cf36c4802dfe79db8c4f9520f2ac8e0dcf4d8e26c9ff9e0b5280c`，绝不用 `git checkout --`）。如实边界：只改 `submit` 一处守卫；同一表单的「名字」没有查重（既有行为，未改）；未做真机复核。

### #19 编辑多号码联系人时，两个号在单行输入框里被粘成一个（前端，2026-09-23，REQ-A1122 / F-TEL-015）

- 背景：§18 里那个电话字段是**多项**的（`Contact.phones: string[]`）：它的 aria-label 自述「逗号/换行分隔」，`submit` 按 `/[,，\n]/` 拆分，`cleanPhones` 原样保存整组，vCard 导入（`mergeImported`）也会产生多项。编辑入口 `openEdit` 负责把这组值放回**同一个**字段。
- 缺陷（实测，对未改前的工作树）：`crates/amos-tauri/frontend-ts/src/svelte/ContactsApp.svelte::openEdit` 预填 `phones = c.phones.join("\n")`，而该字段是一个**单行** `<input>`。HTML 对 text input 的取值净化（value sanitisation）按规范**剥掉 CR/LF**，所以 `["13800000001","222"]` 在框里显示成 `"13800000001222"`。此后用户在框里按**任何一个键**，`input` 事件把 **DOM 值**（已净化的拼接串）写回 `phones` 状态；保存即把该联系人的两个号码覆盖成这一个错号 —— 实测存储从 `["13800000001","222"]` 塌成 `["138000000012229"]`。用户看不到任何提示。
- 为什么是缺陷而非「字段本来就只收一个号」：字段的 aria-label 逐字写着「电话号码（逗号/换行分隔）」，`placeholder` 也用它 —— **逗号能活下来、换行不能**，即该字段承诺的两样分隔符里正好有一半装不下已有数据。
- 为什么没有门禁看见：既有编辑相关用例只喂**一个**号码；`openEdit` 的预填值从未被断言过。更隐蔽的是 —— `submit` 对**未触碰**的编辑行（不触发 `input` 事件）拆的是状态里的原始串 `"13800000001\n222"`，所以「打开编辑、什么都不改、直接保存」这条路径反而是**正确**的；缺陷只在键入之后显形，任何只走「打开即保存」的测试都会漏掉它。
- 修复：`phones = c.phones.join(", ")` —— 用字段自己承诺、且能活过单行输入的分隔符。`submit` 的 `/[,，\n]/` 本就能拆逗号，`cleanPhones` 会 `trim()` 掉 `", "` 里的空格。不改 `cleanPhones` ∕ `submit` ∕ `addContact` ∕ `editContact` ∕ i18n 键 ∕ Rust ∕ proto，也不把字段改成 `<textarea>`（更大的界面改动，逗号已是既有约定）。
- 验证：`svelte-tests/contacts.svelte.test.ts`（37 例，+1）：`editing a two-number contact keeps the numbers separated in the field` —— 新增一个两项号码的联系人 ⇒ 点开该行的 编辑 ⇒ 断言 `input.value === "13800000001, 222"`。断言读的是**框里的值**（用户看到的、也是下一次 `input` 要写回状态的那个值），不是状态变量 —— 状态里那个未净化的串正是让「直接保存」碰巧正确的原因，读它会把这个缺陷藏起来。**先证后修**：该用例对未改前组件运行 ⇒ 恰 1 红 ∕ 36 绿（`expected '13800000001222' to be '13800000001, 222'`）。**负控**：把 `", "` 折回 `"\n"` ⇒ 恰 1 红 ∕ 36 绿（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `ContactsApp.svelte` = `25f245ba03b938e2915dcefd4a481ffa148b4668678972a3a0441ce1b033c19c`、`contacts.svelte.test.ts` = `accc4938188e20164335772805a5857b6aae74c238b1f0ac5a6958d0be61d737`，绝不用 `git checkout --`）。如实边界：只改 `openEdit` 一处预填；未做真机复核。

### #20 联系人界面把共享通讯录读一次就冻结在 `$state` 里（前端，2026-09-23，REQ-A1126 / F-SH-435）

- 背景：`amos.contacts` 是**多写者**的存储键。拆分窗格会把联系人屏与拨号盘并排挂着；设置里的恢复、vCard 导入（`mergeImported`）、`IncomingCall` 都会写它。本仓对这个键的既定约定是**订阅** —— 姊妹件 `PhoneApp.svelte:347-353` 用 `createStoreValue(CONTACTS_KEY)` 订阅，其注释逐字写着订阅的理由：「a **split pane** keeps it mounted beside the Contacts screen, so a contact added or renamed in the other pane must reach the recents/history labels」；`IncomingCall.svelte` 同样订阅。
- 缺陷（实测，对未改前的工作树）：`crates/amos-tauri/frontend-ts/src/svelte/ContactsApp.svelte` 用 `readStoreValue<unknown>(CONTACTS_KEY, [])` 在挂载时读一次（`:64`）赋给 `$state`，此后再不订阅。而它的每一次本地变更都把**它自己那份冻结的数组**写回：`persist()` → `writeStoreValueChecked(CONTACTS_KEY, next)`（`:70`），收藏（`:905`）、删除（`:915`）、新增（`submit`）都走它。于是：①别处写入的联系人**在本屏永远不出现**；②本屏随手点一下收藏 ∕ 删除，就把那份写入**整条覆盖** —— 实测外部写入一条联系人后点「收藏」，存储里那条被删掉。是**数据销毁**（不可逆，除非用户自己记得原联系人），不是「显示旧了」。
- 为什么是缺陷而非「只读一次的简化」：该键**有多个写者**，本仓对它的既定约定就是订阅（同键的姊妹件都订阅了，且 PhoneApp 的注释写明了订阅的理由）；只读一次既漏显示又毁数据，后者不是任何「快照」语义能辩护的。
- 为什么没有门禁看见：既有用例都在**同一个**组件里写入与读取，没有任何一条**从外部**写该键；而 `persist` 的写回行为在单写者假设下与订阅等价 —— 只有当「外部写」与「本地写回」同时存在时才暴露。
- 修复：加 `createStoreValue<unknown>(CONTACTS_KEY, [])` + `$effect(() => contactsStore.subscribe((v) => { contacts = normalizeContacts(v); }))`，与同键姊妹件同形；初值仍用 `readStoreValue` **同步读一次**，避免订阅生效前出现空窗（先渲染「暂无联系人」再跳变）。不改 `lib/contacts.ts` ∕ `amosStore.ts` ∕ 存储键 ∕ vCard ∕ Rust ∕ proto。
- 验证：`crates/amos-tauri/frontend-ts/svelte-tests/contacts.svelte.test.ts`（39 例，+2）：`a contact written by another surface reaches this screen`（渲染后由外部写入该键 ⇒ 断言 DOM 出现新联系人）与 `the next local edit does not erase a contact another surface wrote`（外部写入后点一下收藏 ⇒ 断言存储里那条仍在）。**先证后修**：两条新用例对未改前组件运行 ⇒ 恰 2 红 ∕ 37 绿。**负控**：把订阅折回「只在挂载时读一次」⇒ 恰 2 红 ∕ 37 绿（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `ContactsApp.svelte` = `bc01fccb568821efe1a3c08ef4bc64c72ddfce24273c51c5c77c0dceda6b99f7`、`contacts.svelte.test.ts` = `1bd82aaa45d51203d049468ac46b5ab9eea8357fe0934385cd9b6c4dc038c4ae`，绝不用 `git checkout --`）。如实边界：只加一处订阅 + 两条 DOM 用例；未改数据层 ∕ 存储 ∕ vCard ∕ Rust ∕ proto；未做真机复核。

### #21 「屏蔽未知/隐藏号码」开关是执行横幅的输入，却从不重读状态（前端，2026-09-23，REQ-A1136 / F-SH-442）

- 背景：拨号盘「拦截」页的横幅（`data-testid="block-role-needed"` ∕ `block-role-held`）闸在 `filtersCalls` 上（`PhoneApp.svelte:340`，= `!!blockStatus?.filters_calls`）。`filters_calls` 由宿主从**规则 ∪ 未知开关**算出：`BlocklistState::filters_calls()`（`blocklist.rs:181`）= `has_rules_for(Call) || block_unknown()`，经 `status_of` ∕ `blocklist_status` 暴露。也就是说**开关本身就是横幅的一个输入**（这正是 REQ-A1132 确立的）。
- 缺陷（实测，对未改前的工作树）：页内其余每个写入者都在写完之后重读状态 —— `addBlockRule`（`:278`）、`removeBlockRule`（`:297`）、`clearAllRules`（`:256`）、`requestBlockRole`（`:324` 调 `loadBlockStatus`）—— **唯独 `toggleBlockUnknown` 没有**（`:299-311`，写完 ∕ 回滚之后即返回）。于是：用户在**空规则**下打开「屏蔽未知/隐藏号码」，宿主确实武装了拒接（`shouldBlockCall("")` 折到 `blocks_call("")`，与 #20 的 REQ-A1132 同一机制），可本屏的 `blockStatus` 仍是开关前那份 ⇒ 既不亮「需要授权」横幅、也不给授权按钮，也不说「已生效」—— 拒接已武装而界面一无所知，用户即使想授权也无从下手，直到切走再切回「拦截」页（或重启）才刷新。
- 为什么是缺陷而非「乐观更新的简化」：开关是横幅的**输入**（`filters_calls` =「有来电规则 **或** 开关开」），不只是规则列表的开关；同页的其余四个写入者都重读了，缺这一个使「开关」与「规则」两条输入对横幅的可见性不一致。
- 为什么没有门禁看见：既有用例的 fixture 要么在进页时横幅就已武装（`filters_calls: true` 的固定 fixture，见 `phone.svelte.test.ts:986` 等），要么从不去点那个开关；没有任何一条把「进页时未武装 → 点开关 → 断言横幅」串起来。而在 `filters_calls` 开始依赖开关之前（REQ-A1132 之前），开关确实不是横幅的输入，这条缺失的刷新**不可能**显形。
- 修复：`toggleBlockUnknown` 在写入（含失败回滚）之后加 `await refreshBlock()`，与 `addBlockRule` ∕ `removeBlockRule` ∕ `clearAllRules` 逐字同形。不改 `blocklist.rs` ∕ 命令协议 ∕ `filters_calls` 判据 ∕ 乐观更新 ∕ i18n 键 ∕ 规则存储。
- 验证：`crates/amos-tauri/frontend-ts/svelte-tests/phone.svelte.test.ts`（49 例，+1）：`flipping the unknown-number switch re-probes the enforcement banner`（假桥按 `blocklist_set_unknown` 的入参**动态**重算 `filters_calls`，与宿主 `BlocklistState::filters_calls` 同构：进页未武装 ⇒ 断言无横幅；点开关 ⇒ 断言 `block-role-needed` 出现）。**先证后修**：新用例对未改前组件运行 ⇒ 恰 1 红 ∕ 48 绿（`expected null to be truthy`）。**负控**：把 `PhoneApp.svelte` 还原为改前快照 ⇒ 恰 1 红 ∕ 48 绿（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）。如实边界：只加一处 `await refreshBlock()` + 一条 DOM 用例；未做真机复核；未改 Rust ∕ proto ∕ i18n。

### #22 紧急拨号页的标签查表折成空串，兜底判据是死的；标签表与号码清单互不绑定（前端，2026-09-23，REQ-A1138 / F-SH-445）

- 背景：紧急拨号页按 `EMERGENCY_NUMBERS`（`lib/emergency.ts:45`）逐个画按钮，标签来自 `PhoneApp.svelte` 的内联 `EMERGENCY_LABEL`。前者是页面**号码清单**，后者是**标签表** —— 两份清单，键集逐字相同。
- 缺陷（静态，对未改前的工作树）：内联查找以 `return m[code] ?? ""` 收尾（返回类型 `string`），而调用点是 `{EMERGENCY_LABEL(code) ?? t("phone.emergencyGeneric", { num: code })}` —— **`""` 不是 nullish，那个兜底永不触发**：表里没有的号码会画出**没有名字**的按钮，只剩右侧的号码。同理，表若漏了一个码而清单里有，页面立刻多出一个无名按钮，且没有任何门禁 ∕ 用例会报警。
- 同仓反证：同一份文件的姊妹查找 `contactNameFor`（`lib/contacts.ts:251`）返回 `string | null`，其调用点的 `?? target`（`PhoneApp.svelte` 的 `recordOutgoing` 两处）是**活的**。两种形状在同一个仓库并存，正是「这个 `??` 是死的」的证据 —— 一个把「没有」表达成 `null`，一个表达成 `""`。
- 为什么没有门禁看见：唯一能喂进「表里没有的号码」的输入就是那条 `const` 号码清单，而它当前与标签表的键集相等 ⇒ **没有任何测试能构造出那个输入**，这条兜底是不可证伪的。另一面，`isEmergencyNumber` 有 `declaredMirrors.test.ts` 把它绑到 Rust 的表，而**标签表没有对应物** —— 两份清单之间的漂移无人读。
- 修复：①把标签表搬到它标注的清单旁边 —— `lib/emergency.ts` 新增 `EMERGENCY_LABEL_KEYS`（号码 → i18n 键）；②新增 `emergencyLabelKey(code)` 返回**消息键**（表里没有就返回 `"phone.emergencyGeneric"`），调用点改为 `t(emergencyLabelKey(code), { num: code })` —— 兜底从「一条永远不触发的 `??`」变成「一个函数的结构性默认返回值」，同时内联 `EMERGENCY_LABEL` 与死 `??` 一并删除；③补上缺失的门：`emergency.test.ts` 双向绑定（每个清单里的号码都有标签键 **且** 表里没有清单外的码）+ 未知码仍得到 generic 键 + 每个键在 zh ∕ en 词典里都能解析（`translate()` 对缺失键会原样吐出键名，`i18n.ts:43`）。不改号码清单本身 ∕ `isEmergencyNumber` ∕ 拨号通路 ∕ Rust ∕ proto ∕ i18n 键。
- 验证：`crates/amos-tauri/frontend-ts/src/__tests__/emergency.test.ts`（17 例，+3）。**负控（两条，互相独立）**：从 `EMERGENCY_LABEL_KEYS` 删掉 `"122"` ⇒ 恰 1 红 ∕ 16 绿；把 `emergencyLabelKey` 折回 `?? ""`（即重演那条死兜底）⇒ 恰 1 红 ∕ 16 绿（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `emergency.ts` = `7e4255b87d5595f423e13cc483a7a5551392b6db05b61f5c646c92ac52b234c0`，绝不用 `git checkout --`）。紧急页行为未变：`svelte-tests/phone.svelte.test.ts` 49 例全绿；`tsc --noEmit` 干净、`svelte-check` 0 错 0 警。如实边界：这是**潜伏**缺陷 + 补门（今天无行为变化）；用例的落点是新函数 `emergencyLabelKey` 而非旧的内联表（旧表已删）；未做真机复核。

### #23 三条电话命令有实现、有类型化拒绝，却没有任何画面调用（前端 + 接线，2026-09-23，REQ-A1146 / F-SH-453）

- 背景：宿主侧 `telephony_play_dtmf` ∕ `telephony_set_speaker` ∕ `telephony_set_hold`（`crates/amos-tauri/src/telephony.rs:582` ∕ `:625` ∕ `:667`）都已有完整实现：DTMF 把单个音交给绑定的在通话服务，没有服务时诚实返回 `Ok(false)`；扬声器与保持在没有服务时以 `TelephonySpeakerRefused` ∕ `TelephonyHoldRefused` 拒绝，而不是伪造 `Ok`。三条都在 `lib.rs` 注册。
- 缺陷（静态，对未改前的工作树）：`frontend-ts/src/lib/backend.ts` 里没有这三条的包装（同族的 `telephonySetMuted` 有），`PhoneApp.svelte` 的按键处理 `pressDtmf` 只写 `dtmf = dtmf + k`，扬声器与保持**没有控件**。`node scripts/tauri-command-scan.mjs` 用恰好三行指名了它们：`is registered but no screen calls it`。
- 后果（设备侧）：在 AmOS 身为默认电话应用、`is_default_dialer_bound()` 为真的那台设备上，通话中按 IVR 的 1 送不到对端 —— 而屏幕底部那句 `phone.dtmfLocal`（「仅本机显示（按键音属音频管线，尚未送到通话）」）把责任推给音频管线，**恰好说反**：不是管线送不出去，而是界面没问过宿主。扬声器与保持同理，用户没有任何入口。
- 为什么没有门禁看见：唯一能看见的仪器是 `scripts/tauri-command-scan.mjs`，而它**不在** `bun run check` 链里；`scripts/tauri-command-allowlist.json` 也没有这三条的条目。一份「已注册、有实现、有类型、无人调用」的清单没有任何读者。
- 修复：①`src/lib/backend.ts` 新增 `telephonyPlayDtmf`（`boolean` 或 `null`：`true` 仅当绑定的在通话服务把音交给 Telecom）、`telephonySetSpeaker`、`telephonySetHold`，并给 `TelephonyCall` 补 `speaker?: boolean` ∕ `hold?: boolean`（文档写明「absent 即无主张」，与 `muted` 同规）；②`PhoneApp.svelte` 的 `pressDtmf` 改为 async：除本地回显外把音交给宿主，按 `callActionOutcome(bridgeDiag("telephony_play_dtmf"))` 分流 —— 拒绝 → `inCallError`（`phone.dtmfFailed`），否则 `dtmfReached = res === true`，说明在 `phone.dtmfSent` 与 `phone.dtmfLocal` 之间切换；`false` 是宿主诚实的「没送到」，**不是**错误，所以不画 alert；③新增 `toggleSpeaker` ∕ `toggleHold`，与 `toggleMute` 共用同一条判据规则（只在宿主确认后才移动标志），在通话控制行加两个按钮（`aria-pressed`、`volume` ∕ `pause`、拒绝时用 `phone.speakerFailed` ∕ `phone.holdFailed` 报出），并给保持态加一句 `phone.onHold`；事件流按「absent 即无主张」补 `speaker` ∕ `hold`。不改 Rust ∕ proto ∕ 拨号通路 ∕ 静音 ∕ 录音 ∕ 号码清单 ∕ `phone.dtmfKey` 的可及名（REQ-A1067 的「单个键不假称发送」仍成立：一键的名字不预告结果）。
- 验证：`crates/amos-tauri/frontend-ts/svelte-tests/phone.svelte.test.ts`（+6 例，49 → 55）：`a DTMF key is handed to the call, and the pad stops disclaiming the far end`、`a tone the host did not deliver keeps the pad's local-only note`、`a refused DTMF tone says so rather than failing silently`、`the in-call speaker toggle goes through the host and only moves on its answer`、`a refused speaker switch says so and leaves the button alone`、`the in-call hold toggle goes through the host and shows the held caption`。
- **负控（三条，互相独立）**：①`pressDtmf` 不调宿主（只回显）⇒ 恰 **3 红 ∕ 52 绿**；②去掉 `toggleSpeaker` 的拒绝早退并乐观 `speaker = next` ⇒ 恰 **1 红 ∕ 54 绿**；③`dtmfReached = res === true` 折成 `= true` ⇒ 恰 **1 红 ∕ 54 绿**（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `PhoneApp.svelte` 负控快照 = `1b8fe8b5922815c07ffba7d5012b454e4c93e5625cc0b5bfdf526188e5388809`（该文件此后被并行回合改动，故工作树 sha 已不同），绝不用 `git checkout --`）。
- 门禁：`node scripts/tauri-command-scan.mjs` 由 **FAIL（恰这三条）** 变 **OK**（311 注册命令，288 个字面调用）；`bun run check` 全链绿（`tsc --noEmit` 干净）、`svelte-check` 0 错 0 警。如实边界：设备侧（音真的送进 Telecom、扬声器与保持真的生效）**未做真机复核**；桌面档两条命令会如实拒绝并把宿主原话显示给用户。

### #24 来电覆盖层把「absent 即无主张」的录音字段当有值读了两次（前端，2026-09-23，REQ-A1150 / F-SH-455）

- 背景：`TelephonyCall.recording` 是**可选**字段，文档（`frontend-ts/src/lib/backend.ts`）写明规则：一次静音 ∕ 扬声器 ∕ 保持的回复**不携带**录音状态，「逐字段套用该载荷的调用方必须保留它已有的录音状态」。宿主侧 `crates/amos-tauri/src/incall.rs:94` 的在通话桥上行**故意**发 `recording: None`，注释记着原因：在那里声称 `Some("Off")` 会在**每一次**状态变化时把界面的录音指示器复位成 Off，**包括在通话开关（保持 ∕ 扬声器 ∕ 静音）自己触发的那几次**（三者都调 `onCallStateChanged`），于是刚按下录音的用户眼看着它悄悄消失。
- 缺陷（静态，对未改前的工作树）：姊妹面 `PhoneApp.svelte:630` ∕ `:754` 两处都按 `typeof … === "string"` 读；`IncomingCall.svelte:94`（事件处理 `recording = c.recording as "Off" | "On" | "Failed"`）与 `:200`（切换录音的回复 `if (res) recording = res.recording as …`）把 `undefined` 直接投进这个三值类型 —— 上游注释防的那个故障在来电浮层上**依然活着**。
- 后果（设备侧）：来电浮层是用户实际接电话的那一屏 —— 徽章「录音中」被清、按钮从 `phone.recordStop` 退回 `phone.recordStart`，界面**自己谎报录音已停**，而设备仍在录；有三个同族开关（保持 ∕ 扬声器 ∕ 静音）会触发这条路径，命中率高。
- 为什么没有门禁看见：既有的串扰用例 `a recording event never clears the mute flag (nor a mute event the recording)` 的 `evt` 辅助**每次都带 `recording: "Off"`**，于是「事件压根没提录音」这个用例从未被执行；两条守卫在姊妹面存在，本面无对应测试（同 `project_sibling_site_of_a_repaired_predicate`：一处修好的判据，兄弟调用点要扫）。
- 修复：`IncomingCall.svelte` 两处补上与 `PhoneApp.svelte` 同形的守卫（`if (typeof c.recording === "string") { recording = … }` ∕ `if (res && typeof res.recording === "string") { recording = … }`），并在源码写明这条规则。不改 `PhoneApp.svelte` ∕ `backend.ts` ∕ Rust ∕ proto ∕ i18n 键 ∕ 静音 ∕ 通话记录。
- 验证：`crates/amos-tauri/frontend-ts/svelte-tests/incoming-call.svelte.test.ts`（+2 例，16 → 18）：`an event that makes no recording claim does not clear a live recording`、`an accepted recording reply that makes no claim leaves the indicator alone`。红先证：未改前恰 **1 红 ∕ 16 绿**（新用例死在 `expect(container.textContent).toContain(zh["phone.recording"])`）。
- **负控（两条，互相独立）**：①把事件路径的守卫折回无守卫的 cast ⇒ 恰 **1 红 ∕ 17 绿**；②把回复路径的守卫折回无守卫的 cast ⇒ 恰 **1 红 ∕ 17 绿**（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `IncomingCall.svelte` = `589d68d4722e9ead601fbf50325aa4a9a09834e427f1ef228d7e17b4afcd4477`，绝不用 `git checkout --`）。
- 门禁：`tsc --noEmit` 干净、`svelte-check` 0 错 0 警、`bun run check` 全链绿。如实边界：**未做真机复核**（真机上来电浮层的录音指示器是否随保持 ∕ 扬声器 ∕ 静音事件保持，尚未在设备上验证）；两条负控各自只折一处守卫，证明两处独立。

### #25 设备侧的在通话方向仍是「从会变的状态推导」出来的（Kotlin glue，2026-09-23，REQ-A1155 / F-TEL-016）

- 背景：`AmosInCallService.onCallStateChanged()` 是 ROLE_DIALER 桥的**上行**（`nativeState` JNI upcall → Rust `incall` → 前端 `telephony-event`）。它决定三件事：`direction` ∕ `state` ∕ `peer`。其中 `direction` 是前端**分流**用的：`IncomingCall.svelte:81` 的守卫是 `if (c.direction !== "Incoming") return;`（呼出电话归 Phone 页面自管，§12 #13 已记）。
- 缺陷（静态，对 HEAD）：HEAD 的 Kotlin 逐字写着 `val direction = if (state == "Ringing") "Incoming" else "Outgoing"`，其上一行的注释断言 `// This SDK exposes no readable Call.Details.direction; infer it from the`。两处都不成立：①API 29（`Q`）起 `Call.Details` 有 `getCallDirection()` 与 `DIRECTION_INCOMING` ∕ `DIRECTION_OUTGOING` ∕ `DIRECTION_UNKNOWN`（本机 `javap -p android.telecom.Call$Details` 实测，工程 `compileSdk = 36`）；②`Ringing` 只在**等待接听**时为真 —— 一旦接听，`state` 变 `Active`，同一通**来电**立刻被判成 `Outgoing`。
- 后果：真机上一通**被接听**的来电，从接听那一刻起它的整块覆盖层丢弃自己这通电话的每一条后续事件（挂断的 `Ended` 边也在内）—— 用户挂不断，屏幕被钉在已结束的「通话中」，通话记录也收不到（`Ended` 是该日志唯一的生产写入者）。这正是 `docs/FMEA.md` §13（REQ-A1095 / F-SH-409）修好的那个缺陷的**设备侧孪生**：那一轮修的是 daemon 发出的事件，这一处是设备推上来的事件。
- 为什么没有门禁看见：`make android-glue-check` 做的是**编译 + Android Lint** —— 能答「这个 API 在 minSdk 上存不存在」，答不了「这一处推导对不对」；HEAD 的 `incall.rs` 也不读 Kotlin 源码（无 `include_str!`），所以 Rust 侧没有一条钉看得到它。
- 修复：①新增 `private var latchedDirection: String?`，在 `onCallAdded` **就地**把方向钉住（`call.state == Call.STATE_RINGING` ⇒ `"Incoming"`，否则 `"Outgoing"`），在 `onCallRemoved`（仅当 `call === active`）与 `onDestroy` 清空；②新增 `private fun callDirection(c: Call?, state: String): String`，权威顺序 **platform > latch > state**：API-29+ 的 `c.details?.callDirection` 是平台自己的答案（`DIRECTION_INCOMING` ∕ `DIRECTION_OUTGOING` 直接返回，`DIRECTION_UNKNOWN` 与 null `Details` 落到下一级，且整个分支在 `Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q` 守卫内）；`latchedDirection?.let { return it }` 是次选；`if (state == "Ringing") "Incoming" else "Outgoing"` 是**最后**手段，因为它正是那个会随接听而变的答案；③`onCallStateChanged()` 改调 `val direction = callDirection(c, state)`。
- **写第一版时写错了，门把它抓到了**：初版用的是 `c.details?.direction` —— 平台的 API 名是 `getCallDirection()`（Kotlin 属性 `callDirection`），`make android-glue-check` 立刻 `e: …/AmosInCallService.kt:97:30 Unresolved reference: direction` 报红；补齐后 Android Lint 又报了 `SwitchIntDef`（`when` 缺 `DIRECTION_UNKNOWN`），按 REQ-A380 的规矩在源码里显式补 `else -> Unit` 并写明理由，而不是加抑制。这两次都是**这道门**（不是任何 Rust 测试）发现的 —— Rust 侧的字面量钉读的是文件名与函数签名，读不出 API 名与 IntDef 的完备性。
- 验证：`crates/amos-tauri/src/incall.rs`（+1 例，861 通过 ∕ 0 红）：`the_call_direction_is_latched_once_and_prefers_the_platform_answer` —— 读 Kotlin 源码（**先剥注释**，`strip_kotlin_comments`），钉三件事：①latch 的赋值逐字；②权威顺序是**序**（`c.details?.callDirection` 的位置 < `latchedDirection?.let` 的位置 < `if (state == "Ringing")` 的位置）；③上报点用的是 `val direction = callDirection(c, state)` 而非裸 `state`。**负控（实测）**：把 latch 的两个词对调 ⇒ 恰 **1 红 ∕ 857 绿**（`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `AmosInCallService.kt` = `9321e9f8…`，绝不用 `git checkout --`）。实测边界：这是**潜伏**缺陷（HEAD 的 Kotlin 从未在设备上跑过），判据是源码钉 + 负控 + Kotlin 编译与 Android Lint，**未做真机复核**。
- **订正（REQ-A1305 ∕ F-TEL-029，2026-09-23）**：本节写下的「latch 是**一个**字段（`private var latchedDirection`）、在 `onCallRemoved`（仅当 `call === active`）与 `onDestroy` 清空」已随 §12 #38 更新 —— latch 现为 `latchedDirections: MutableMap<Call, String>`（**每通电话各自**记住方向，另一通的来去改不动它），离开时经 `forget()` 把 `active` 槽位重挑给仍活着的最新一通；`callDirection` 的权威顺序仍是 **platform > latch > state**，只是 latch 那一级从 `latchedDirection?.let` 变成 `latchedDirections[it]?.let`。本节钉的断言（`the_call_direction_is_latched_once_and_prefers_the_platform_answer`）名字与三件事不变，两条字面量随之更新。

### #26 设备侧的在通话控制（静音 ∕ 扬声器 ∕ 保持 ∕ DTMF）在 HEAD 上整个不存在（Kotlin + Rust，2026-09-23，REQ-A1156 / F-TEL-017）

- 背景：§12 #23（REQ-A1146 / F-SH-453）把前端接到 `telephony_set_muted` ∕ `telephony_set_speaker` ∕ `telephony_set_hold` ∕ `telephony_play_dtmf` 上，并写明该轮「未改 Rust」。但**对 HEAD 而言**，那三条命令**根本不存在**：`git show HEAD:…/telephony.rs | grep -c 'telephony_set_muted\|telephony_set_speaker\|telephony_set_hold\|telephony_play_dtmf'` = **0**；`crates/amos-tauri/src/incall.rs` 在 HEAD 只有 `is_default_dialer_bound` ∕ `nativeState` ∕ `real_answer` ∕ `real_hang_up`（无 `real_set_muted` ∕ `real_set_speaker` ∕ `real_set_hold` ∕ `real_play_dtmf` ∕ `ToggleChange`）；`AmosInCallService.kt` 的 companion 在 HEAD 只有 `isServiceBound` ∕ `answerActive` ∕ `hangUpActive`（无 `muteActive` ∕ `speakerActive` ∕ `holdActive` ∕ `playDtmf`）。三层全空。
- 后果（设备侧）：在 AmOS 身为默认电话应用的那台设备上，通话中**没有静音 ∕ 扬声器 ∕ 保持 ∕ 按键音的任何一个入口**，IVR 的 `1` 送不到对端。`InCallService#setMuted` ∕ `#setAudioRoute` ∕ `Call#hold()` ∕ `Call#playDtmfTone()` 都是**只在默认拨号器绑定后才可用**的实例方法 —— 缺了这三层，`ROLE_DIALER` 那条架构承诺在最需要它的时刻是空的。与 F-SH-453 是同一族的两侧：那里是「有命令、没人调用」，这里是「连命令都没有」（`tauri-command-scan` 只问**已注册**的命令有没有画面调用，不存在的命令它看不见）。
- 修复（三层一次落齐）：
  - **Kotlin** `AmosInCallService` 的 companion 新增 `@JvmStatic setRecording(active: Boolean): String`（紧急号守卫保留：`is_emergency` 命中即 `"Failed"`）、`muteActive` ∕ `speakerActive` ∕ `holdActive`（同答 `On` ∕ `Off` ∕ `Failed`；`speakerActive` 走 `setAudioRoute(ROUTE_SPEAKER|ROUTE_EARPIECE)`，`holdActive` 走 `c.hold()` ∕ `c.unhold()`，异常折成 `"Failed"` 而非静默）、`playDtmf(tone: String): Boolean`（`DTMF_ALPHABET` 校验 + `postDelayed` 在 `DTMF_TONE_MS = 180L` 后 `stopDtmfTone()`）。`muteActive` **有意**不做紧急门 —— 静音自己的麦克风是机主的决定，录紧急线才是禁止的（§6 把这处不对称记为有意；`setRecording` 的 KDoc 也写明了）。
  - **Rust 桥** `incall.rs` 新增 `ToggleChange{On, Off, Failed, Unknown(String)}` 与 `pub type RecordingChange = ToggleChange`（`recording_change_from_state` 退化成转发），`toggle_change_from_state` 只认那三个词、**空串或没分类的词一律 `Unknown(词)`**（空串给的是 `"the glue answered with an empty toggle state"`，绝不是 `Off`）；`set_recording_for_window`（`require_foreground` 门 + 默认拨号器门）；`real_set_recording` ∕ `real_set_muted` ∕ `real_set_speaker` ∕ `real_set_hold` ∕ `real_play_dtmf`（后者用 `crate::telephony::is_dtmf_tone` 校验 —— 那个常量不能放这里，因为 `incall` 是 `#[cfg(feature = "android")]`，而命令面必须在默认档也拒绝一个畸形音）。
  - **命令面** `telephony.rs` 新增 `telephony_set_muted` ∕ `telephony_set_speaker` ∕ `telephony_set_hold`（三条走同一个 `in_call_toggle_reply`）与 `telephony_play_dtmf`。`in_call_toggle_reply` 是**唯一的折叠点**：`Ok(On)` ∕ `Ok(Off)` ⇒ `Ok(只声明这一次切换测到的那一位的 payload)`；`Ok(Failed)` ⇒ `Err(定型 AmosError(code, "…was refused by the in-call service (Failed)"))`；`Ok(Unknown(词))` ⇒ `Err(…原话保留…)`；`Err(门禁错误)` ⇒ 保留它自己的 `code` 与 `cause`（前缀上切换名）。这是「**拒绝不粉饰**」：一条被折成 `Ok` 的 `Failed` 会让按钮在什么都没变的情况下亮着（§10.5）。没有绑定的在通话服务时，扬声器与保持以 `TelephonySpeakerRefused` ∕ `TelephonyHoldRefused` 拒绝并给出原因，DTMF 则诚实 `Ok(false)`（**没送到不是错误**）。`error.rs` 新增四个 wire 码（`amos.telephony.mute_refused` ∕ `speaker_refused` ∕ `hold_refused` ∕ `dtmf_refused`，`FROZEN_VARIANT_COUNT` 90 → 93），`lib.rs` 注册四条命令。
- 验证：`incall.rs` **+2 例** —— `every_toggle_word_is_pinned_to_the_kotlin_source_in_the_on_direction`（循环 `["muteActive","speakerActive","holdActive"]`（原为四元；`setRecording` 已在 REQ-A1239 ∕ F-TEL-026 移出 —— 录音不再答状态，方向无从可钉，它的极性由 `the_recording_words_are_pinned_to_the_kotlin_source` 管），从剥注释后的 Kotlin 源码读出 `if (active) "…" else "…"` 的两个词、各按方向跑 `toggle_change_from_state` ⇒ `On` ∕ `Off`；只查字面量存在不够 —— 词对调后两个词都还在文件里）与 `the_dtmf_alphabet_is_pinned_to_the_kotlin_source`（Kotlin `DTMF_ALPHABET` 逐字等于 `crate::telephony::DTMF_TONES`）。`telephony.rs` **+6 例** —— `is_dtmf_tone_accepts_exactly_one_alphabet_character` 与 `mod in_call_toggle_reply` 的 5 例（On 只声明它测的那一位 ∕ Off 声明 Off 而不是什么都不说 ∕ Failed 是定型拒绝而非亮的按钮 ∕ 未分类词保留 glue 原话 ∕ 门禁错误保留自己的 code 与 cause）。**负控（四条，互不重叠，一次窗口内合跑，逐条指名）**：①把 `in_call_toggle_reply` 的 `Failed` 臂折成 `Ok(payload)`；②`AmosInCallService.kt` 的 latch 两词对调；③`DTMF_ALPHABET` 去掉 `D`；④`muteActive` 的 `On` ∕ `Off` 对调 ⇒ **恰 4 红 ∕ 857 绿**（红的正是各自指名的那一条），`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原（`telephony.rs` = `41db848d…`、`AmosInCallService.kt` = `9321e9f8…`），绝不用 `git checkout --`。门禁：`cargo check -p amos-tauri`（默认档）与 `cargo test -p amos-tauri --features android --lib` **861 通过 ∕ 0 红**；`make android-glue-check` 绿。如实边界：**未做真机复核** —— 音真的进了 Telecom、扬声器 ∕ 保持真的生效、DTMF 真的被对端 IVR 收到，均未在设备上验证；桌面档四条命令会如实拒绝 ∕ 诚实答 `false`，因为这一层只存在于 Android。

### #27 通话时长读数被「再广播的 Active」重置（前端，2026-09-23，REQ-A1159 / F-TEL-018）

- 背景：§12 #16（REQ-A1114 / F-SH-427）给通话中的时长读数加了 `role="timer"`，理由写的是「每秒自变的值必须能被按需查询」。本节说的是同一条承诺的另一面：那个值本身必须是**通话的**时长。
- 现象：`PhoneApp.svelte` 的事件处理里，`activeAtRef = Date.now()` 写在 `if (call.state === "Active")` 之内。`Active` 不是一次性的转变 —— daemon 在静音 ∕ 录音切换时会把该通话**当前**状态**再广播一遍**：`crates/amos-telephony/src/service.rs::event_to_state_event` 对 `RecordingChanged` ∕ `MutedChanged` 送的是 `proto_state(state)`（一次活跃通话即 `Active`），同一个 id。真机侧的在通话桥同理 —— `crates/amos-tauri/src/incall.rs` 的注释自己写着 hold ∕ speaker ∕ mute 都会触发 `onCallStateChanged`，而 Kotlin 的 `onCallAudioStateChanged` ∕ `Call.Callback#onStateChanged` 都回头调它。
- 后果：通话中按静音 ∕ 扬声器 ∕ 保持 ∕ 录音中的任何一个，屏幕上的时长从当前值跳回 `0:00`，再从零往上爬。这个读数被标为「通话时长」，却实际量的是**用户最后一次按键** —— 越依赖它（录音时长、计费自查）越被误导。
- 为什么长期全绿：时长读数此前没有任何用例；既有 in-call 用例都在 adopt 之后就只看按钮与标题。而 `adoptLiveCall`（`telephony_status` 那条路）自己会给 `activeAtRef` 打戳，所以「被 adopt 的通话」这条路本来就对，缺陷只在**第二次 `Active`** 时显形。
- 修复：只在进入 talking 的**边**上打戳 ——

  ```ts
  if (call.state === "Active") {
    if (!talking) {            // 第二次 Active 不是新通话
      talking = true;
      activeAtRef = Date.now();
      elapsedSec = 0;
    }
  }
  ```

  同时**保留另一片叶子**：从 `Dialing` 被 adopt 的通话（`activeAtRef` 为 null、`role="timer"` 尚未渲染）仍必须在那条 `Active` 到达时开始计时，否则时钟永远停在 `0:00`。
- 验证：`svelte-tests/phone.svelte.test.ts` **+2 例** —— `a repeat Active event does not restart the call's elapsed clock`（等到读数 ≥ 2 s → 送同 id 的 `state: "Active"` → 等 1.2 s → 断言 ≥ 前值 + 1）与 `the elapsed clock starts when the dialling call is answered`（`Dialing` adopt → 无 `role="timer"` → 送 `Active` → 时钟出现并前进）。**负控（两条，互不重叠，一次窗口内合跑）**：`if (!talking)` 折成 `if (true)` ⇒ 恰 **1 红 ∕ 56 绿**；折成 `if (false)` ⇒ 恰 **1 红 ∕ 56 绿**。`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `PhoneApp.svelte` = `48eeb34b93e45f43e30d9c54452e0d11fcae024798f71d162ea9eff6cc8f6c3f`（改前 = `e41afc3b7e6afc0befd89b10fa4840ef58b7d4761f490c3b0b259d65c24d6bc5`），绝不用 `git checkout --`。
- 如实边界：组件用真实 `setInterval` 计时，Bun ∕ jsdom 下无法虚拟化时钟，所以判据写成**性质**（「重复 `Active` 之后数值仍在前进」，余量 ≥ 1 s）而不是精确读数；未做真机复核。


### #28 两个「只有真机才答得动」的在通话控制只挂在错的那块表面上（前端，2026-09-23，REQ-A1166 / F-TEL-019）

- 背景：§12 #26（REQ-A1156 / F-TEL-017）把设备侧的在通话控制三层补齐（Kotlin companion ∕ `incall.rs` 桥 ∕ `telephony.rs` 命令面）；§12 #23（REQ-A1146 / F-SH-453）把前端的调用点接上。本节说的是那两次交付之间漏掉的一件事：**接上的那块表面不是用户实际看得见的那块**（并且——见下一条——初稿里「这两块表面谁能成功」的说法是错的，已订正）。
- 缺陷（静态，对未改前的工作树）：`telephony_set_speaker` ∕ `telephony_set_hold` 的前端唯一调用点是 `PhoneApp.svelte`，**订正（2026-09-23 复核，这是初稿的错误）**：初稿说它「驱动 daemon 传输、没有音频路由，宿主在那里必然拒绝」。错。`crates/amos-tauri/src/telephony.rs` 里这两条命令的拒绝条件与调用者无关 —— `#[cfg(feature = "android")]` 下判据是 `crate::incall::is_default_dialer_bound()`（Kotlin `isServiceBound`），一个**设备**事实；命令也不知道哪块前端调用了它，`call_id` 除长度检查外不再被读。真正的缺陷是**能成功的那个用户界面在真来电时按不到**：`IncomingCall.svelte` 是 AmOS 身为默认电话应用时**真来电**的覆盖层、**接管整屏**（`incall.rs` 把 `telephony-event` 推进来），而它通话态那行只有静音 ∕ 录音 ∕ 挂断三个键 —— `grep -c 'speaker\|hold' IncomingCall.svelte` = 0（仅一处注释提到）。
- 后果（设备侧）：在 AmOS 身为默认电话应用、`is_default_dialer_bound()` 为真的那台设备上，接通后**没有扬声器键、没有保持键** —— 这两个最常用的通话控制缺失，而这正是它们唯一能生效的地方 —— 那一刻用户看的只有 `IncomingCall.svelte`，`PhoneApp.svelte` 的副本不在屏幕上；保持态也没有任何显示（`phone.onHold` 此前只在那块按不到的表面画过）。
- 为什么没有门禁看见：唯一能看见「有没有画面调用」的仪器是 `scripts/tauri-command-scan.mjs`，它的判据是**有没有调用者**，不是**调用它的那块表面能不能成功**。一个已接线的孪生把空心 twin 藏住了。
- 修复（只改前端的**一块**表面，不加新层）：
  - `IncomingCall.svelte` 的通话控制行新增扬声器 ∕ 保持两键（`aria-pressed`、图标 `volume` ∕ `pause`），与 `toggleMute` 共用同一条判据规则：拒绝取自 `bridgeDiag(command)`（`invoke` 把定型 `AmosError` 折成 `null`，与 `void` 成功同值），标志只在宿主确认后移动。
  - 加一句保持态标题 `phone.onHold`（与 `PhoneApp.svelte` 同一句）。
  - 事件流按「absent 即无主张」读 `speaker` ∕ `hold`；`Ringing` ∕ `Ended` 两处复位。
  - 三层（Kotlin ∕ Rust 桥 ∕ 命令面）**一行未动**。
- 验证：`svelte-tests/incoming-call.svelte.test.ts` **+3 例**（18 → 21）—— `the loudspeaker toggle is on the real-call surface and goes through the host`（断言期望态而非开关、地址是这次的 call id）、`a refused loudspeaker switch says so and leaves the button alone`（宿主原话 + `phone.speakerFailed` 前缀，按钮不动）、`the hold toggle is on the real-call surface and shows the held caption`。**负控（两条，互不重叠，一次窗口内合跑）**：`toggleSpeaker` 去掉拒绝早退并乐观 `speaker = next` ⇒ 恰 **1 红 ∕ 20 绿**；`{#if hold}` 折成 `{#if false}` ⇒ 恰 **1 红 ∕ 20 绿**。`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `IncomingCall.svelte` = `6c1361434d1ee92f877fb9a4e85af34a0b9329bffe9d6fbfdc5639cd09f8cb5d`（改前 = `589d68d4722e9ead601fbf50325aa4a9a09834e427f1ef228d7e17b4afcd4477`），绝不用 `git checkout --`。
- 支撑「看得见的那块表面是 `IncomingCall.svelte`」的正向证据：真机桥的载荷就是为它准备的 —— `crates/amos-tauri/src/incall.rs:64` 的注释写着它 re-emit 成 `telephony-event`（与 daemon Watch 同形，「so the existing IncomingCall…」）。**订正（同一次复核内，初稿此处又错了一次）**：初稿说「`PhoneApp.svelte` 从不监听该频道」—— 错，它**监听**（`PhoneApp.svelte:749` 调 `onTelephonyEvent`，即 `lib/backend.ts:871` 对 `TELEPHONY_EVENT` 的订阅；`grep 'telephony-event'` 只命中有意用包装名的调用点，故初稿的 grep 漏了它）。准确的差别在**处理器的第一行**：`PhoneApp` 是 `if (call.id !== activeRef) return;`（`PhoneApp.svelte:750`），而 `activeRef` 只由 `startCall` 或 `adoptLiveCall`（读 `telephony_status`，daemon）设定 —— 所以真机桥的事件本身**不会**把 PhoneApp 推进在通话界面；`IncomingCall` 则以 `direction === "Incoming"` 接管整屏。这正是「看得见的那块是 `IncomingCall.svelte`」的依据。
- 如实边界（一）：`call_id` 在命令面是装饰性的 —— `telephony_set_speaker` ∕ `telephony_set_hold` 除长度检查外**从不读那个参数**，动作一律打向设备上那个已绑定的在通话服务，而回执里的 id 是**调用者传进来的**那个（`in_call_toggle_reply(id, …)`）。在当前排布下这不构成用户可见缺陷 —— **可查的**依据是 daemon 根本报不出一条真通话：`crates/amos-telephony/src/android.rs` 的 Status 一节自述 answer ∕ end ∕ recording ∕ muting 与实时 `status` **尚未接线**（需要 `InCallService` ∕ `TelephonyCallback` 桥，未就绪前返回显式 provider 错误），而 `incall.rs` 正是那座桥；于是 `PhoneApp.adoptLiveCall`（读 `telephony_status`）永远 adopt 不到真通话，真通话的界面只有 `IncomingCall.svelte` 的覆盖层，且它的 `call.id` 恒为真机桥的 `"real"`。话虽如此，但它意味着「我按的是这条通话」在命令面没有约束力 —— 将来若两块表面同时显示不同通话就会显形。
- 如实边界（二）：真机桥的**上行**至今不带 `speaker` ∕ `hold`（`incall.rs` 的 upcall 只有 direction ∕ state ∕ peer），所以由系统 UI 或对端发起的保持不会回显到本表面 —— 只有本表面自己按下并获得宿主确认的那一次会。要把外部发起的保持也显示出来，得改 `nativeState` 的 JNI 签名（三参 → 带两位标志），那是一次**线上契约**变更，本轮不做，留作后续。未做真机复核。**订正（2026-09-23）**：那次线上契约变更已经做了 —— §12 #37（REQ-A1268 / F-TEL-028）把 `nativeState` 从三参扩到六参（`direction ∕ state ∕ peer` + `muted ∕ speaker ∕ known`），于是**音频那一半**（静音 ∕ 扬声器路由）现在是平台自己的事实、由 `onCallAudioStateChanged` 每次变化时推上来，本节剩下的未覆盖面只有 `hold`：`CallAudioState` 不携带保持，外部发起的保持仍不可见。


### #29 设备侧在通话的**前置条件**（默认电话应用 ∕ ROLE_DIALER）没有任何一层能查、能申请（Kotlin 桥 + Rust 命令 + 前端，2026-09-23，REQ-A1180 / F-TEL-020）

- 背景：§12 #25（REQ-A1155）、#26（REQ-A1156）、#23（REQ-A1146）、#28（REQ-A1166）四轮把设备侧的在通话链路补齐了 —— 接听 ∕ 挂断 ∕ 静音 ∕ 扬声器 ∕ 保持 ∕ DTMF ∕ 录音，三层都落地。这条链路**全部门在同一个前提上**：AmOS 必须是本机的默认电话应用（`RoleManager.ROLE_DIALER`），否则 Android 根本不绑定 `AmosInCallService`，`crates/amos-tauri/src/incall.rs::is_default_dialer_bound()` 一路返回假，每条命令都以「AmOS is not the default phone app on this device」定型拒绝。本轮把这**唯一的前提**本身接上：查得到、申请得到、说得出。
- 缺陷（静态，对 HEAD 与工作树同时成立 —— 这是**缺失**，不是回归）：`grep -rn 'ROLE_DIALER\|createRequestRoleIntent' --include='*.kt'` 在整个仓库里只命中**注释**（`AmosInCallService.kt` 的类注释提到这个角色名），没有任何一处调用 `RoleManager.isRoleHeld` ∥ `createRequestRoleIntent`；`grep -rni 'request_role\|defaultDialer\|default_dialer' --include='*.rs' --include='*.ts' --include='*.svelte'` 只命中**姊妹角色**的那一套（`blocklist.rs::blocklist_request_role` ∕ `backend.ts::blocklistRequestRole` ∕ `PhoneApp.svelte` 的授予按钮）。也就是说：**来电筛选角色（ROLE_CALL_SCREENING）有一整条「查状态 → 申请 → 前端按钮」的通路，默认电话应用角色一行也没有。**
- 后果（设备侧）：一台零售设备上，用户没有任何界面内的办法把 AmOS 设为默认电话应用，也没有任何界面告诉他「现在是 ∕ 不是」；他能遇到的只有通话控制里那句拒绝，而那句拒绝指向的补救办法**不在应用里**（只能自己摸进「设置 → 应用 → 默认应用 → 电话」）。§12 #25 ∕ #26 ∕ #28 三轮补齐的控制，在最需要它们的那台设备上默认按不到 —— 这不是缺一个按钮，是整条链路的**前置条件没有入口**。
- 为什么没有门禁看见：`tauri-command-scan` 只问「**已注册**的命令有没有画面调用」，不存在的命令它看不见；`android-glue-check` 是编译 + Lint，答得了「用了的 API 存不存在」、答不了「这个角色有没有人申请」。**一个已完整接线的孪生（来电筛选角色）把空心的这一个藏住了**（与 F-SH-453 同族：唯一的仪器问的是错的那个问题）。
- 修复（三层一次落齐，照抄姊妹角色的形状而不是另立一套）：
  - **Kotlin**（`android-glue/…/TelephonyGlue.kt`，拨号器自己的 glue）：新增 `appContext` ∕ `activityRef`（弱引用）与 `attachActivity(activity)`；`dialerRoleSupportedBound()`（`FEATURE_TELEPHONY`）、`dialerRoleReady()`（glue 是否已 bind）、`dialerRoleHeldBound()`、`requestDialerRoleBound()`；查询逐 API 分岔 —— **API 29+ 用 `RoleManager#isRoleHeld(ROLE_DIALER)`，以下是 `TelecomManager#defaultDialerPackage`**（角色的前身拼法），两者都是**平台自己的答案**。角色的问法刻意**不**用 `isServiceBound`：service 只在有通话时绑定，拿它当答案会让一台配置正确的手机在两次通话之间自称「不是拨号器」。
  - **Rust**（`crates/amos-tauri/src/real_dial.rs`，已经是拨号器模块）：新增 `DialerRoleStatus { role_supported, role_held, role_requestable }` —— 字段名与 `BlocklistStatusOut` **逐字相同**，两块角色界面因此不可能各自漂移；纯函数 `dialer_role_status_from(supported, held, ready)`（`supported: Err` 或假 ⇒ 三者全假；`held: Err` 落 `false`、**不**升格为设备主张；`role_requestable = supported && ready`）；`dialer_role_probe()` ∕ `request_dialer_role()` 各带 `cfg` 两臂（非 Android 走同一个折叠函数的「无胶」臂，不写字面三元组）；两条命令 `telephony_default_dialer_status` ∕ `telephony_request_default_dialer`。
  - **类加载**：`glue_class()` 经**已存 Context 的 `getClassLoader()`** `loadClass` 解析 `com.amos.ai.glue.TelephonyGlue` —— 刻意**不**用 `env.find_class`：后者取的是**调用线程**的加载器，而命令跑在 tokio worker 上（bootstrap 加载器），`BlocklistGlue` ∕ `incall` 正是被记进 `scripts/jni-allowlist.json` 的那条限制（它们只从 Java 上行线程发问，所以没暴露）。这里的问题只能从命令线程问，于是从 Context 取加载器，那条失败模式根本不会出现。
  - **前端**：`backend.ts` 新增 `DialerRoleStatusOut` ∕ `telephonyDefaultDialerStatus` ∕ `telephonyRequestDefaultDialer`（**复用** `BlocklistStatusOut` 的三字段词汇）；`PhoneApp.svelte` 在**键盘页**渲染两种「未持有」状态 —— 可申请（给授予按钮）与**问不到**（原生桥未就绪，说明而不是画一个按不动的按钮），并在 `recheck`（`focus` ∕ `visibilitychange`）里重读状态，因为授予发生在系统自己的 Activity 里、`telephony_request_default_dialer` 返回之后才有答案。
- 「拒绝不粉饰」的继承：`dialer_role_status_from` 保证**问不到 ≠ 未持有**（`role_requestable` 单独一位承载「我们问不到」），前端只在 `role_supported && !role_held` 时渲染，`role_supported === false`（桌面 ∕ 无电话功能的设备）**整块不渲染**；授予的判据取自**重读的状态**，不取自命令的返回值（`invoke` 把定型拒绝折成 `null`，与「成功但没什么可说」同值 —— 同一条判据规则贯穿 §12 #23 ∕ #28）。
- 验证：`crates/amos-tauri/src/real_dial.rs` **+6 例**（`a_held_role_reads_held_and_askable` ∕ `an_unheld_role_is_askable_but_not_held` ∕ `an_unsupported_device_reports_neither_held_nor_askable` ∕ `an_unreachable_probe_reports_unsupported_rather_than_a_verdict` ∕ `a_held_probe_that_errors_collapses_to_unheld_not_to_held` ∕ `a_request_is_never_askable_without_a_deliverable_bridge`），全部纯函数、无 JVM；`frontend-ts/svelte-tests/phone.svelte.test.ts` **+5 例**（未持有 → 提示 + 按钮真的发命令且**状态重读后**提示消失 ∕ 不可递交 → 说明且无死按钮 ∕ 命令被拒 → `dialer-role-error` 报出且提示留在原地 ∕ 无此角色的宿主 → 整块不渲染 ∕ resume 时重探且**双向**如实）。
- 门禁：`cargo test -p amos-tauri --lib` **843 通过 ∕ 0 红**（837 + 6）；`cargo check -p amos-tauri --features android` 干净；`make android-glue-check` **绿**（Kotlin 编译 + Android Lint：我方 glue 0 findings）；前端 `tsc --noEmit` 干净、`i18n-scan` 绿、`svelte-tests/phone.svelte.test.ts` **62 通过**。
- 如实边界：**未做真机复核** —— 真机上按这个按钮是否真的弹出系统「默认电话应用」对话框、授予后 `RoleManager#isRoleHeld` 是否立刻为真，均未在设备上验证；本轮的证据是编译器（Kotlin 编译 ∕ Lint ∕ Rust 类型）加上纯函数与 DOM 测试。另：`dialerRoleHeld` 在 API 26–28 上走 `TelecomManager#defaultDialerPackage`，那条分支**同样未真机验证**（工程 `minSdk = 26`）。


### #30 DTMF 拨号键盘也只挂在错的那块表面上（前端，2026-09-23，REQ-A1188 / F-TEL-021）

- 背景：§26（REQ-A1156）把设备侧的在通话控制一次补齐 —— 静音 ∕ 扬声器 ∕ 保持 ∕ **DTMF（按键音）** ∕ 录音，三层（Kotlin ∕ Rust 桥 ∕ 命令面）俱全。§28（REQ-A1166 / F-TEL-019）随后发现扬声器与保持这两个「只有真机才答得动」的控制的**唯一前端入口**在 `PhoneApp.svelte`，而真来电时接管整屏的是 `IncomingCall.svelte`（`absolute inset-0 z-[90]`，由 `Shell.svelte` 挂载，`incall.rs` 用 `telephony-event` 喂它）—— `PhoneApp` 的按钮那一刻按不到。本轮修的就是那一次**落下第三个**：DTMF。
- 缺陷（前端，对 HEAD 与工作树同时成立）：`telephony_play_dtmf` 的前端唯一调用点是 `PhoneApp.svelte`；`IncomingCall.svelte` 的通话态控制行只有静音 ∕ 录音 ∕ 挂断三个键。`grep -in 'dtmf' crates/amos-tauri/frontend-ts/src/svelte/IncomingCall.svelte` 在改动前 **0 命中**。这与 §28 是**同一块表面、同一条规则**：`tauri-command-scan` 的判据是「已注册的命令有没有调用者」，`PhoneApp` 的调用就足以让它闭嘴 —— 一个**已接线的孪生**把空心的这一个藏住了。
- 后果：真来电来自自动总机（「按 1 确认 ∕ 请输入分机号」）时**无处送号** —— 这恰恰是 DTMF 唯一有意义的场合：来电覆盖层盖住了唯一有键盘的那块表面，用户按不到；功能缺失 + 诚实性，无崩溃、不越权。
- 修复（照抄 `PhoneApp.svelte` 的形状，不另立一套）：
  - **披露而非常驻**：`IncomingCall.svelte` 通话态新增 `data-testid="dtmf-open"` 按钮（`aria-label` = `phone.dtmf`，`aria-expanded` 绑定 `padOpen`），点开才画键盘，避免挤占通话屏幕。
  - **键盘本体**：`{#if padOpen}` 内 `data-testid="dtmf-pad"` 容器 —— `data-testid="dtmf-echo"` 回声条（`{dtmf || " "}`）、12 键 3×3 网格（`DTMF_KEYS = ["1"…"9","*","0","#"]`，每键 `data-testid="dtmf-key"`、`aria-label` = `phone.dtmfKey`）、清空键（`phone.dtmfClear`）、以及 `data-testid="dtmf-note"` 状态行。
  - **同一条判据规则**：`pressDtmf(k)` 先本地回声（`dtmf` 是按键反馈，限 12 位），再 `telephony_play_dtmf(call.id, k)`；判决取自 `bridgeDiag("telephony_play_dtmf")` —— 定型拒绝报 `phone.dtmfFailed` 且**通话不关**；**`false` 不是失败**，是宿主诚实地说「这次没送出去」，保留 `phone.dtmfLocal` 免责声明，只有 `res === true`（有绑定的在通话服务把号交给 Telecom）才改口 `phone.dtmfSent`。
  - **状态复位**：新来电（`Ringing`）与挂断（`Ended`）两条边都清 `dtmf` ∕ `dtmfReached` ∕ `padOpen`，重开披露时也清，避免上一通电话的号串到下一通。
  - **不加新层**：Rust ∕ proto ∕ 命令面一行未动 —— 三层早已存在，本轮只把它们接到能生效的表面上。
- 验证：`crates/amos-tauri/frontend-ts/svelte-tests/incoming-call.svelte.test.ts` **25 例（较前 +4）**：`the DTMF keypad is on the real-call surface and sends each key through the host` ∕ `a refused tone says so and does not claim the far end heard it` ∕ `a host that answers 'not delivered' keeps the pad's own disclaimer` ∕ `the keypad's echo clears when the disclosure closes`。**负控 ×2，各自打在一条分支上，一次窗口内合跑**：`dtmfReached = res === true` 改 `= true` ⇒ 恰 **1 红 ∕ 24 绿**（红的正是 `not delivered` 那条）；拒绝早退 `return` 折成吞掉 ⇒ 恰 **1 红 ∕ 24 绿**（红的正是被拒那条）。`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `IncomingCall.svelte` = `d122c257498e7ec7d35a30dcb98261a692a78380c2191cf642e8db16ee7972ac`（改前 = 改后），绝不用 `git checkout --`。
- a11y 门禁：键盘与回声条沿用本文件既有的 `bg-white/10 text-white` 玻璃片（静音 ∕ 录音键同款，均画在 `bg-neutral-950` 的来电覆盖层上）。`a11y-scan` 的 R6 规则做**平面合成**，会把 `bg-white/10` 当纯白，算出白底白字 **1.00:1** 的假阳性 —— 按该扫描器自己为此准备的分类（REQ-A565 定的按 pair 白名单 `R6_UNVERIFIABLE`）逐对登记，理由写明 **ALWAYS-DARK FILE：根是 `bg-neutral-950 text-white`**，并注明该理由**只在根保持深色时成立**（根一旦改浅，此条目失效、必须重算）。这不是「加一行放过」，而是把「扫描器读不到的那部分事实」写进声明处。
- 如实边界：**未做真机复核** —— `PlayDtmf` 的 Kotlin 侧是否真把号交给 Telecom（以及自动总机是否收到）未在设备上验证；同 §29，本轮的证据是 DOM 测试加重控。

### #31 默认电话应用下，`ACTION_CALL` 把呼出交回的「系统」就是本应用 —— 而屏幕说「已交给系统」（前端 + 模块注释，2026-09-23，REQ-A1222 / F-TEL-022）

- 背景：`placeOutgoingCall`（`lib/phone.ts`）把守护进程放在首位（它绑定**我们自己的**在通话 UI，还能放回铃音），守护进程不应答时对**非紧急号**回落到 `realDial`（`crates/amos-tauri/src/real_dial.rs`，发 `Intent(ACTION_CALL, tel:…)`）。这条兜底正是 `real_dial` 存在的理由：没有守护进程的设备不该只能显示「拨号失败」。§29（REQ-A1180）刚把这条链的**前置条件**（`RoleManager.ROLE_DIALER`）补成可查 ∕ 可申请，本轮撞上的就是它在位的那个分支。
- 缺陷（前端，对 `git show HEAD` 成立）：`PhoneApp.svelte` 的 `handed-off` 分支逐字
  ```ts
  if (outcome.kind === "handed-off") {
    calling = false;
    notice = t("phone.handedToSystem");
    recordOutgoing(target, …);
    return;
  }
  ```
  但 **AmOS 持有 `ROLE_DIALER` 时，「系统拨号器」就是本应用**：Telecom 把这通电话路由回我们自己的 `AmosInCallService`（`incall.rs`），它以**固定 id `real`** 推一条 `telephony-event`（`direction: "Outgoing"`）。而前后两道守卫都不接它 —— `PhoneApp.svelte` 逐字 `if (call.id !== activeRef) return;`（`activeRef` 此刻为 null），`IncomingCall.svelte` 逐字 `if (c.direction !== "Incoming") return;`。于是**一通活的呼出电话在整块屏幕上没有任何界面**：没有挂断键、没有时长、没有静音 ∕ 扬声器 ∕ 保持 ∕ DTMF，来电浮层也不会接管它（它只认 Incoming）。
- 为什么长期全绿：`real_dial.rs` 的模块注释自己写着「this intent only fires when the user has chosen to use the System UI's dialer button **without changing the default dialer**」——一个**错误的前提**，把复核引开；`docs/telephony.md` 的设计意图（「呼出电话归 Phone 页面自管」）与之矛盾却无人比对；既有用例 `no daemon → a regular call falls back to the system dialer (real_dial)` 把 `handedToSystem` + 无挂断键**当成期望**钉住，而它的桩从不回答 `telephony_default_dialer_status`，于是整条角色分支在套件里**不可执行**（memory `project_fixture_omits_the_field`）；`tauri-command-scan` 只问「已注册命令有没有调用者」。
- 修复（前端一处分流 + 一条订正；Rust ∕ Kotlin 未加层）：
  - **`lib/phone.ts` 新增 `REAL_CALL_ID = "real"`** —— 文档注明它是**所有者**的标记（谁在报这通电话），不是标识符：`incall.rs` 对每一通真实通话都用同一个值，而守护进程每通电话都铸新 id（`tel_…`）。这正是本页在把拨出交给 Telecom 之后需要知道的事。
  - **`handed-off` 分支改问「谁拥有这通电话」**：写通知前 `await telephonyDefaultDialerStatus()` **重读**角色（授权在独立的系统 Activity 里完成，挂载时读到的 `dialerRole` 会过期）。`role_held` 为真 ⇒ `calling = true; talking = false; activeId = activeRef = REAL_CALL_ID; activeAtRef = null`，把真实的 `Dialing` ∕ `Active` ∕ `Ended` 事件交给本屏驱动 —— 挂断 ∕ 录音 ∕ 静音 ∕ 扬声器 ∕ 保持 ∕ DTMF 全部经 `real_call_route`（`telephony.rs`）落到绑定的在通话服务上，`endCall` 的 `telephony_end(REAL_CALL_ID)` 也走同一条路由。
  - **探针失败（`null`）不降级**：`if (role) dialerRole = role;` —— 保留上一次读数，绝不因一次失败的探针把一通真实通话降级成「已交给系统」（`null` 是「没有判决」，不是「未持有」）。
  - **不叠加回铃音**：本文件为守护进程垫的 MP3 等待音（守护进程的传输没有音频通路）改以 `activeId !== REAL_CALL_ID` 为门 —— 真实通话由网络的回铃音发声，否则同时响两个等待音。
  - **订正 `real_dial.rs` 那条错误的前提注释**：写明这条 Intent **不是**只在 AmOS 非默认拨号器时才触发，以及角色在位时调用方必须认领回来的那通电话（固定 id `real`）。
- 验证：`crates/amos-tauri/frontend-ts/svelte-tests/phone-outgoing.svelte.test.ts` **6 例（较前 +2）**：`no daemon + AmOS is the default phone app → the hand-off comes back to our own in-call service, which we adopt`（断言不再出现 `phone.handedToSystem`、挂断键在、`id: "real"` 的 `Active` 边进入 talking 且出现静音键、`Ended` 边收屏）与其孪生对照 `no daemon + AmOS is NOT the default phone app → the hand-off is still another dialer's call`（同一个桩把角色翻成 false，断言旧的键盘 + 通知路径仍在 —— 「无条件认领」会让它红）。**负控 ×2，逐叶独立**：`if (dialerRole?.role_held)` 改 `if (false)` ⇒ 恰 **1 红 ∕ 5 绿**（red 正是 adopt 那条）；改 `if (true)` ⇒ 恰 **2 红 ∕ 4 绿**（red 含既有的 `no daemon → a regular call falls back to the system dialer`，证明角色判据承重而非装饰）。`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `PhoneApp.svelte` = `928c00599488e22641ff9a632eb66693e05d6b79676125d33e6afdaca613ab48`（改前 = 改后），绝不用 `git checkout --`。三件套 `phone-outgoing` ∕ `phone` ∕ `incoming-call` 合跑 **93 passed**；`tsc --noEmit` 0 error、`svelte-check --fail-on-warnings` 0 error 0 warning、`i18n-scan` ∕ `unwired-scan` ∕ `a11y-scan` ∕ 其余扫描脚本全绿；`fmea-gen --check` OK（774 modes）。
- 如实边界：**未做真机复核** —— 证据是 happy-dom 下的 DOM 断言；`role_held` 为真而 Telecom 尚未绑定 `AmosInCallService` 的窗口内不会收到任何事件，本屏会停在「拨号中」，直到用户按挂断（该次 `telephony_end` 的判决由 `real_call_route` 如实给出：服务已绑定则清屏，未绑定则回落守护进程并如实报错），这段窗口未在设备上测量。

### #32 通讯录沿用了 #31 订正前的前提：兜底交回的「系统」可能就是本应用，通话界面没打开（前端，2026-09-23，REQ-A1232 / F-TEL-023）

- 背景：`ContactsApp.svelte::submit` 与 `PhoneApp.svelte` **共用** `placeOutgoingCall`（`lib/phone.ts`）。§31（REQ-A1222）把 `PhoneApp` 的 `handed-off` 分支改成「先问谁拥有这通电话」，但**没有回头看第二个调用者** —— 而两个调用者若在同一个手势上给出相反结果，那就是缺陷（memory `project_twin_shares_the_helper_not_the_predicate`）。
- 缺陷（前端，对工作树成立）：
  - `ContactsApp.svelte` 的 `handed-off` 分支逐字 `status = t("phone.handedToSystem")`，**不查角色、不打开 Phone**。
  - 而 AmOS 持有 `ROLE_DIALER` 且守护进程缺席时，`realDial` 的 `ACTION_CALL` 会被 Telecom 路由回**本应用自己的** `AmosInCallService`（固定 id `real`）—— 屏幕说「已交给系统拨号器」，实则这通电话归本应用所有，而没有任何一块表面接管它：从通讯录拨出的电话**没有挂断键**、没有时长 ∕ 静音 ∕ 扬声器 ∕ 保持 ∕ DTMF（来电浮层只认 `Incoming`）。
  - **孪生叶子（同轮）**：即使打开了 Phone 页，`AppPane.svelte:126` 的 `{#key id}` 会在挂载时造一个全新的 `PhoneApp`，而 `real_dial` 的 `ACTION_CALL` **在 Telecom 把电话加进来之前就返回** —— 挂载那一刻 `adoptLiveCall` ∕ `realCallSnapshot` 查不到任何可收养的通话，随后第一帧事件又被 `if (call.id !== activeRef) return;`（`activeRef` 为 null）丢掉。
- 为什么长期全绿：REQ-A1049 的用例桥对 `telephony_default_dialer_status` 一律答 `null`（角色分支在套件里不可执行），且其中一条把 `handedToSystem` + 无 `wm_open` **当成期望**钉住；已修好的 `PhoneApp` 把空心的 `ContactsApp` 藏住了（memory `project_sibling_wired_hides_hollow_twin`）。
- 修复（前端两处；Rust ∕ Kotlin 未加层）：
  - **`ContactsApp` 的兜底分支改问「谁拥有这通电话」**：`await telephonyDefaultDialerStatus()` **重读**角色（授权在独立系统 Activity 完成，挂载时读到的会过期），`role_held` 为真 ⇒ `wmOpenReported("phone", "contacts")` 打开 Phone 页（其挂载收养渲染真实通话表面），打开失败则如实报新增的 `contacts.callUiFailed`；`role_held` 为假才回落旧文案。
  - **探针失败（`null`）按未持有处理** —— 与 §31 的分歧是有意的：那里已确认拥有一通**活的**通话，一次失败的探针不许把它降级；这里尚在决定归属，`null` 是「没有判决」，按未持有走保守路径。
  - **`PhoneApp.svelte` 新增收养臂**：未拥有（`activeRef` 为 null）、`direction: "Outgoing"`、`id === REAL_CALL_ID` 且状态为 `Dialing` ∕ `Active` 的事件即进 talking；**状态白名单**（而非「非 `Ended`」）挡掉 `onCallRemoved` 之后那条 `state: "Unknown"` 的尾巴（见 §33）。
- 验证：`contacts.svelte.test.ts` **43 例（较前 +4）**（新 describe「交回的呼出必须有人接管（角色决定归属）(REQ-A1232)」）；`phone-outgoing.svelte.test.ts` **9 例（较前 +3）**（新 describe「adopts an un-owned platform call from the event stream」）。**负控 ×3，逐叶独立**：`if (role?.role_held)` → `if (false)` ⇒ 恰 **2 红 ∕ 41 绿**；收养状态白名单 → `call.state !== "Ended"` ⇒ 恰 **1 红 ∕ 8 绿**；去掉方向过滤 ⇒ 恰 **2 红 ∕ 7 绿**。`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原 `ContactsApp.svelte` = `cdb40f07cc4a2034cdb29abe48f947d832da7b8e697c50f9318acae626e42a30` ∕ `PhoneApp.svelte` = `7053ad932c8cc606b406439feca0e52d8fb80c1a4914cf6398cc72b6019165e4`，绝不用 `git checkout --`。
- 如实边界：**未做真机复核** —— 证据是 happy-dom 下的 DOM 断言与桥调用计数；`role_held` 为真而 Telecom 尚未绑定 `AmosInCallService` 的窗口内 Phone 页会停在「拨号中」。

### #33 在通话桥把「没有通话」发成了「一个状态未知的通话」（Kotlin glue + Rust 源码钉，2026-09-23，REQ-A1233 / F-TEL-024）

- 背景：`AmosInCallService` 是 §29 之后 AmOS 身为默认电话应用时真实通话的宿主，它把每一次状态变化经 JNI `nativeState(direction, state, peer)` 上推为 `telephony-event`。
- 缺陷（设备侧 Kotlin，对 `git show HEAD` 成立）：`onCallStateChanged()` 逐字
  ```kotlin
  val c = active
  val state = when (c?.state) { … else -> "Unknown" }
  ```
  `active` 为 null 时落进 `else -> "Unknown"`，再以 `direction: "Outgoing"`、`peer: ""` 推上去 —— 而 `Unknown` 本是给**确实在线**却不在本桥分类里的通话（`STATE_HOLDING`）准备的词。`onCallRemoved` ∕ `onCallDestroyed` 先把 `active` 置空再调它，`onCallAudioStateChanged` 也可能在无通话时触发 —— 于是「挂断之后的尾巴」与「一通正在保持的电话」在校验侧**逐字节相同**。前端 `noteRealCall`（REQ-A1231）只在 `Ended` 时清记录、`adoptLiveCall` 的过滤只排除 `Ended`，两者都收下这条 `Unknown`：每次真实通话结束后都留下一具幽灵记录，重挂载时被当活电话画出来，其挂断键对 null 通话调 `disconnect()`（`hangUpActive` 当时仍答 `true` —— 那半边的折叠已在 §12 #34 ∕ REQ-A1236 修掉：`true` 现在只代表「真的挂断了一通电话」）。
- 为什么长期全绿：`incall.rs` 的在通话用例直接构造事件、**不经过 Kotlin 的 null 路径**；`android-glue-check` 只做编译；没有任何门禁问「`active` 为 null 时这个函数说了什么」。
- 修复（在两种事实仍可分辨的那一层，即 Kotlin 源头）：
  - `val c = active ?: return` —— 没有通话就没有可报告的东西。离开的通话已由 `onStateChanged(DISCONNECTED)` → `Ended` 送过；未被观察到离开的通话是本服务描述不了的，`Unknown` 不是「没有通话」的词。
  - `when (c.state)` 去掉多余的 `?.`（`c` 已非空），否则触发 `UNNECESSARY_SAFE_CALL`，而胶水门禁把非弃用告警当错误；`c.details` 同去 `?.`。
- 验证（Rust 源码钉，钉方向不钉存在）：`crates/amos-tauri/src/incall.rs` 新增 `the_no_call_tail_never_reaches_the_state_mapping` —— `include_str!` 读入 Kotlin 源、`strip_kotlin_comments` 去注释后：断言 `val c = active ?: return` 出现在 `val state = when (` **之前**（顺序），且存在 `val state = when (c.state)` 且**不存在** `when (c?.state)`，`else -> "Unknown"` 仍在。`cargo test -p amos-tauri --features amos-tauri/android --lib incall` **16 passed ∕ 0 failed**；镜像进 `gen/` 逐字节相同；`make android-glue-check` 6/6 绿。**负控**：把 Kotlin 还原成 `val c = active` ∕ `when (c?.state)` ⇒ 该钉恰 **1 红**（顺序与拼写两条断言都红），还原后逐字节相符。
- 如实边界：**未做真机复核** —— 该钉只在 `--features amos-tauri/android` 下编译运行（`#[cfg(feature = "android")]`）。


### #34 「在通话服务被绑定」被当成了「这通命令有一通真实电话」（Kotlin glue + Rust 源码钉，2026-09-23，REQ-A1236 / F-TEL-025）

- 背景：`real_call_route`（answer ∕ hang-up 的路由）用 `is_default_dialer_bound()` 决定「谁拥有这条命令」，它的文档把 `Ok(false)` 读作「在通话服务在门禁与调用之间解绑了 —— 没有真实通话拥有这条命令，守护进程路径是对的」；`real_answer()` 的 KDoc 同样把 `true` 说成「a bound in-call service answered it」。
- 缺陷（设备侧 Kotlin，对 `git show HEAD` 成立）：`answerActive()` ∕ `hangUpActive()` 的形状是
  ```kotlin
  val s = self ?: return false
  s.answerIncoming(); return true
  ```
  而 `answerIncoming()` = `val c = active ?: return` + `if (c.state == Call.STATE_RINGING)`（无通话 ∕ 非振铃即空操作），`hangUp()` = `active?.disconnect()`（无通话即空操作）。于是「服务实例存在」被当成了「真的接听 ∕ 挂断了」。而 `is_default_dialer_bound()` 就是 `self != null`，`self` 的生命期是**整个默认拨号器任期**（`onCreate` 置位、`onDestroy` 才清），比任何一通电话都长 ——「绑定但无通话」是常态，不是边界。`telephony_answer` ∕ `telephony_end` 由此 `Ok(true)` ⇒ `Handled` ⇒ 直接 `Ok(())`，守护进程拥有的那通 `tel_…` 电话（用户正看着的通话界面）既不 `answer` 也不 `end`：界面显示「接听成功」∕「已挂断」，电话从未接通 ∕ 从未挂断。同一折叠正是 `real_call_route` 自己文档里 `Err` 臂要防的那个（「报告了一个它没达成的通话状态」），只是还留在 `Ok(true)` 这一层 —— 与 §12 #33 的「`Unknown` 同时表示『没有通话』与『保持中的通话』」同族：一个值承载两个事实。
- 为什么长期全绿：`real_call_route` 的单测直接喂 `Ok(true)` ∕ `Ok(false)`，从不去问 Kotlin 的那个 `true` 是怎么产生的；`an_unreachable_in_call_service_…` 只覆盖 `Err` 臂；`android-glue-check` 只做编译 —— 没有任何门禁问「`self != null` 而 `active == null` 时这两个静态说了什么」。
- 修复（在两种事实仍可分辨的那一层，即 Kotlin 源头）：
  - `answerIncoming()` ∕ `hangUp()` 返回 `Boolean`：无通话 ∕ 非振铃即 `return false`，只有真的调用了 `c.answer(VideoProfile.STATE_AUDIO_ONLY)` ∕ `c.disconnect()` 之后才 `return true`。
  - `answerActive()` ∕ `hangUpActive()` 原样上抛实例方法的答复（`return s.answerIncoming()` ∕ `return s.hangUp()`），删掉无条件的 `return true`。
  - 于是 `real_call_route` 的 `Ok(false)` 臂第一次名副其实：在通话服务什么都没做（实例已解绑，或绑定但无可操作的通话）⇒ 守护进程接管该命令。该臂的理由注释与单测注释（旧句断言「`false` 恰在实例为 null 时」）一并订正。
- 验证（Rust 源码钉，钉极性不钉存在）：`crates/amos-tauri/src/incall.rs` 新增 `the_answer_and_hangup_prove_a_call_was_acted_on_not_that_a_service_exists` —— `include_str!` 读入 Kotlin 源、`strip_kotlin_comments` 去注释后：断言 `fun answerIncoming(): Boolean {` 体内 `val c = active ?: return false` 与 `if (c.state != Call.STATE_RINGING) return false` 俱在，且 `c.answer(...)` ∕ `c.disconnect()` 出现在 `return true` **之前**；两个伴生静态体内**不存在** `return true`、**存在** `return s.answerIncoming()` ∕ `return s.hangUp()`。`telephony.rs` 的单测改名 `a_bound_service_that_performed_nothing_yields_the_command_to_the_daemon`。`cargo test -p amos-tauri --features amos-tauri/android --lib incall` **17 passed ∕ 0 failed**、`… --lib telephony` **20 passed ∕ 0 failed**；镜像进 `gen/` 逐字节相同；`make android-glue-check` 绿（0 dead declarations、0 findings in our glue）。**负控**：把 `answerActive` 还原成 `s.answerIncoming(); return true` ⇒ 该钉恰 **1 红**；再整文件还原 ⇒ 同样恰 **1 红**（签名不再匹配即红）。
- 如实边界：**未做真机复核** —— 该钉只在 `--features amos-tauri/android` 下编译运行（`#[cfg(feature = "android")]`）。前端一行未动：`IncomingCall` ∕ `PhoneApp` 早已从诊断槽读判决（F-SH-236 修的读侧），这条修复只补写侧。


### #35 设备侧的录音开关答的是一个「参数」而不是设备（Kotlin glue + Rust 源码钉，2026-09-23，REQ-A1239 / F-TEL-026）

- 背景：`telephony_start_recording` ∕ `telephony_stop_recording` 在 AmOS 身为默认电话应用时走 `crate::incall::set_recording_for_window` → `real_set_recording(active)` → JNI 调 Kotlin 伴生静态 `setRecording(active)`，答复是 `On` ∕ `Off` ∕ `Failed` 之一，Rust 经 `ToggleChange` 折成 payload 的 `recording` 字符串，`PhoneApp.svelte` 据此点亮屏幕上那个红点。
- 缺陷（设备侧 Kotlin）：`AmosInCallService.setRecording` 的空操作体是
  ```kotlin
  val s = self ?: return "Failed"
  val c = s.active ?: return "Failed"
  if (is_emergency(c.details?.handle?.schemeSpecificPart)) return "Failed"
  return if (active) "On" else "Off"
  ```
  —— 最后一行的答案是**从参数读出来的**：它没有调用任何平台方法，也没有任何采集在跑。它的三个兄弟开关都调用平台（`muteActive` → `setMuted`、`speakerActive` → `setAudioRoute`、`holdActive` → `hold()`），只有它答得理直气壮。而 KDoc 声称「the actual media capture is delegated to the platform's `MediaRecorder` (API 24+)」—— `MediaRecorder` 在整个 `android-glue/` 里只出现在那句 KDoc 里。于是真机上按下录音键：界面亮起红点「录音中」，那通电话一个字节都没被写，用户以为存在的录音文件永远不会出现；按「停止」得到的 `"Off"` 同样是对一次从未发生的动作的确认。这与仓库自己的记载直接矛盾 —— `crates/amos-tauri/src/lib.rs` 写着「The capture half does not exist」、`crates/amos-telephony/src/android.rs` 的兄弟路径诚实拒绝（`requires a call-audio tap (audio pipeline, not yet wired)`）、本节 §10.5 也把设备侧录音记为未实现。
- 为什么长期全绿：既有钉问的是那个开关臂的**方向**（哪个词对应 `active = true`），方向一直是对的；没有任何门禁问「这个 `On` 是不是从设备来的」。`android-glue-check` 只做编译。
- 修复（在两种事实仍可分辨的那一层，即 Kotlin 源头）：`setRecording` 不再从 `active` 读出答案，四个分支全是**拒绝** —— 无绑定服务 ∕ 无活动通话 ∕ 紧急线路 ∕ 本构建无采集。`active` 由那条拒绝日志（`Log.i(TAG, "recording toggle refused (active=$active): …")`）消费，因为胶水的 `-Werror` 把未用参数当错误。`is_emergency(...)` 保留：它是该 helper 在本文件里的**唯一**调用点，删掉会留下一个 `-Werror` 拒绝的 dead declaration，且 F-TEL-001 的 110/112/911 硬规则正活在那次调用里。前端一行未动 —— `PhoneApp.svelte` 早已有 `recording === "Failed"` ∕ `phone.recordUnavailable` 与诊断槽判决两条路径，Rust 把 `Failed` 折成 `ErrorCode::TelephonyRecordingRefused`。
- 验证（Rust 源码钉，钉极性不钉存在）：`crates/amos-tauri/src/incall.rs::the_recording_words_are_pinned_to_the_kotlin_source` 重写为 —— 读 `include_str!` 进来的 Kotlin 源、`strip_kotlin_comments` 去注释后取 `setRecording` 的函数体，断言体内**不存在** `if (active) "`、**不存在** `"On"`，且体内每一个 `return "…"`（恰 4 个）经 Rust 自己的 `recording_change_from_state` 都映射到 `Failed`；紧急门必须仍在（第三条断言钉的是它的**存在**而非位置：四个答案已是同一个词，重排不再改变任何可观察的结果 —— 实测把守卫挪到拒绝之后，旧的次序断言照样报绿，故删掉那个不会失败的检查）。`every_toggle_word_is_pinned_to_the_kotlin_source_in_the_on_direction` 的循环由 `["setRecording", …]` 收缩为 `["muteActive", "speakerActive", "holdActive"]` 并注明录音的去处。**负控（各恰 1 红，逐条指名）**：①还原旧折叠 `return if (active) "On" else "Off"` ⇒ 红在「不得从参数作答」；②紧急拒绝的词改 `"Nope"` ⇒ 红在四个拒绝的计数；③守卫实参改 `toString()`（计数仍 4）⇒ 红在「紧急门必须存在」；④把 `setRecording` 放回方向钉的循环 ⇒ 红在该钉的 panic。`AmosInCallService.kt` 用 `cp` 至 /tmp + `shasum -a 256` 逐字节还原（`35abeef9…`），绝不用 `git checkout --`。`cargo test -p amos-tauri --features amos-tauri/android --lib incall` **17 passed ∕ 0 failed**、`… --lib telephony` **20 passed ∕ 0 failed**；默认档 `cargo test -p amos-tauri --lib telephony` **15 passed ∕ 0 failed**；`make android-glue-check` 绿（12 条全为 deprecation、0 dead declarations、0 findings in our glue），镜像进 `gen/` 逐字节相同。
- 如实边界：**未做真机复核** —— 该钉只在 `--features amos-tauri/android` 下编译运行（`#[cfg(feature = "android")]`）。这条修复让真机录音**诚实不可用**，而不是让它变得可用：Android 把 `AudioSource.VOICE_CALL`（以及通话中的 `MediaRecorder`）只交给系统应用，真采集属音频管线（§10.5）。桌面档与 mock daemon 路径不受影响 —— 录音仍由 daemon 支持。


### #36 设备侧的静音 ∕ 扬声器开关把「服务被绑定」当成了「有一通电话」（Kotlin glue + Rust 源码钉，2026-09-23，REQ-A1267 / F-TEL-027）

- 背景：AmOS 身为默认电话应用时，在通话界面的静音 ∕ 扬声器开关经 `telephony_set_muted` ∕ `telephony_set_speaker` 路由到设备侧（门是 `is_default_dialer_bound()`），由 JNI 调 Kotlin 伴生静态 `muteActive(active)` ∕ `speakerActive(active)`，答复经 `ToggleChange` 折成 payload 的 `muted` ∕ `speaker` 字段，`PhoneApp.svelte` 据此点亮状态。
- 缺陷（设备侧 Kotlin，对 `git show HEAD` 成立）：两个开关的形状是
  ```kotlin
  val s = self ?: return "Failed"
  s.setMuted(active)          // 或 s.setAudioRoute(...)
  if (active) "On" else "Off"
  ```
  —— 唯一的问题是**有没有绑定的服务**，不问**有没有通话**。而 `self` 在 `onCreate` 置位、`onDestroy` 才清，寿命是整个默认拨号器任期，比任何一通电话都长；`is_default_dialer_bound()` 恰好就是 `self != null`，于是「服务在」与「这条命令有一通电话」在这条路径上逐字节相同。兄弟 `holdActive` 早已是 `val c = s.active ?: return "Failed"`（先问通话），只有这两个没有。AOSP 的 `InCallService` 把 binder 消息送进 `mHandler` 时逐字 `if (mPhone == null && msg.what != MSG_SET_IN_CALL_ADAPTER) return;` —— 无通话时请求被**静默丢弃**：既不抛异常（`try/catch` 接不到），也不产生任何效果，体后那句 `if (active) "On" else "Off"` 照样执行。后果是隐私面：用户据屏幕上的「静音」决定说的话，被完整送给对端；扬声器方向同理（以为外放共享而实际没有，或以为私密而实际外放）。这与 §12 #34（绑定当成命令的通话）同族，与 §12 #35（控制把意图答成结果）同形，只是落在两个从未被当成可疑的兄弟上。可达性见 §12 #28 的如实边界：`PhoneApp.adoptLiveCall` 从不认领真实通话，但守护进程可以报出通话 —— 通话界面因此会在「绑定但无通话」时亮着，这两个开关就在它上面。
- 为什么长期全绿：`every_toggle_word_is_pinned_to_the_kotlin_source_in_the_on_direction` 问的是**方向**（哪个词对应 `active = true`），方向一直是对的；没有任何门禁问「在没有通话时这两个体说了什么」。`android-glue-check` 只做编译。
- 修复（在两种事实仍可分辨的那一层，即 Kotlin 源头）：两个伴生静态体在 `val s = self ?: return "Failed"` 之后各加一行 `if (s.active == null) return "Failed"`，与 `holdActive` 已有的门对齐。写成裸 `if` 而非 `val c = s.active ?: …`：胶水的 `-Werror` 把未用局部变量当错，而这两个体只用通话对象的**存在**、不用它本身，绑定一个 `c` 会红。同时订正 `crates/amos-tauri/src/telephony.rs::in_call_reply` 的 KDoc 那条被据以判定的假前提（原写「`state: "Active"` 是唯一给定：这些开关每一个都只能从通话界面到达，而通话界面只在通话起来时存在」—— 这正是本缺陷的根）。前端一行未动。
- 验证（Rust 源码钉，钉存在与计数而非位置）：`crates/amos-tauri/src/incall.rs` 新增 `mute_and_speaker_require_a_call_not_merely_a_bound_service` —— `include_str!` 读入 Kotlin 源、`strip_kotlin_comments` 去注释后取每个方法体，遍历 `["muteActive", "speakerActive"]`，断言体内**存在** `s.active` 且体内 `return "Failed"` **恰 2 个**（一个都不少 = 无服务 ∕ 无通话都被拒）。`cargo test -p amos-tauri --features amos-tauri/android --lib incall` **18 passed ∕ 0 failed**；`make android-glue-check` 绿（0 dead declarations、0 findings in our glue），镜像进 `gen/` 逐字节相同；`node scripts/fmea-gen.mjs --check` OK。**负控（各恰 1 红、互不遮蔽）**：①去掉 `muteActive` 的 `if (s.active == null) return "Failed"` ⇒ 恰 **1 红**（该钉报 `muteActive`）；②去掉 `speakerActive` 的同名守卫 ⇒ 恰 **1 红**（该钉报 `speakerActive`）—— 两叶独立，钉一个方法绿不了另一个。`AmosInCallService.kt` 用 `cp` 至 /tmp + `shasum -a 256` 逐字节还原（`973b46cc…`），绝不用 `git checkout --`。
- 如实边界：**未做真机复核** —— 该钉只在 `--features amos-tauri/android` 下编译运行（`#[cfg(feature = "android")]`）。这条修复让静音 ∕ 扬声器在「绑定但无通话」时**诚实拒绝**（Rust 把 `Failed` 折成 `ErrorCode::TelephonyMuteRefused` ∕ `TelephonySpeakerRefused`，`PhoneApp.svelte` 早已有诊断槽判决），而不是让它变得可用 —— 真机上的可操作通话仍取决于 `PhoneApp` 认领真实通话（§12 #28）。


### #37 真机桥丢掉了平台自己的音频事实 —— 在通话屏幕只记得用户按下的最后一笔（Kotlin glue + Rust 源码钉，2026-09-23，REQ-A1268 / F-TEL-028）

- 背景：§12 #35 ∕ #36 把设备侧在通话的**下行**（用户按键 → 平台）逐条钉牢；本节说的是同一条桥的**上行**。`AmosInCallService.onCallAudioStateChanged(state: CallAudioState)` 是平台唯一「这通电话的静音 ∕ 路由变了」的通知，而 `onCallStateChanged()` 经 JNI `nativeState` 把 `direction ∕ state ∕ peer` 推成 `telephony-event`，前端 `IncomingCall.svelte` 的 `Active` 分支按「absent 即无主张」逐字只在 `typeof c.muted === "boolean"` ∕ `typeof c.speaker === "boolean"` 时采纳。
- 缺陷（对 `git show HEAD` 成立）：回调的体只有一句 `onCallStateChanged()` —— 入参被**逐字丢弃**，`getCallAudioState()` 在全胶水里一次都没出现；而 `crates/amos-tauri/src/incall.rs` 的 `Java_com_amos_ai_glue_AmosInCallService_nativeState` 只有三个 `jstring`，载荷逐字 `muted: None, speaker: None`（注释自称「this upcall measured none of them」）。于是这块屏幕只剩下**用户自己按下的最后一笔**：蓝牙耳机接入 ∕ 摘下、有线耳机、系统通话界面改的路由全部不可见 —— 扬声器键亮在一通走在听筒上的电话上（或暗在一通外放的通话上），而用户据屏幕判断「对方能不能听见同房间的人」（后者是隐私面）。这与 §12 #35（控制把意图答成结果）同族：那次把**参数**当成了设备，这次把**用户的最后一笔**当成了设备。
- 为什么长期全绿：`incall.rs` 的在通话用例都直接构造事件、不经过 Kotlin 的这条路径；`android-glue-check` 只做编译；没有任何门禁问「这个回调拿到 `state` 之后做了什么」。
- 修复（在两种事实仍可分辨的那一层，即平台自己的对象）：
  - `onCallAudioStateChanged(state)` 把入参交给 push：`onCallStateChanged(state)`。
  - `onCallStateChanged(audio: CallAudioState? = getCallAudioState())` —— 每次推送读**一次**平台状态（其余调用方走默认参数自取），把 `audio?.isMuted == true` ∕ `audio?.route == CallAudioState.ROUTE_SPEAKER` ∕ `audio != null` 三个布尔接在 `nativeState` 的 `direction ∕ state ∕ peer` 之后。
  - `incall.rs`：导出签名加三个 `jboolean`，新增 `apply_audio_facts(&mut payload, muted, speaker, known)` 盖进 `muted` ∕ `speaker`。
  - **`known` 不是常量**：`audio == null` 是平台的「没有通话有音频」，走 `known = false` = 线上的「无主张」，两个字段保持**缺席**；写死 `false` 会把「读不到」谎报成「未静音、在听筒」（与 §12 #33 的「一个 `null` 两个事实」同形）。
  - **不记忆**：读一次、用一次，没有跨推送的缓存 —— 缓存的事实会活得比它描述的那通电话更久。
  - 前端一行未动（它早已按「absent 即无主张」读这两个字段）。
- 验证：`crates/amos-tauri/src/incall.rs` 新增 4 例 —— `an_unread_audio_state_is_no_claim_not_a_default`（`(_, _, known=false)` ⇒ 两字段为 `None` **且不出现在 JSON 里**）、`a_read_audio_state_stamps_exactly_the_two_facts_it_measured`（反向两叶：`muted=true, speaker=false` 与 `muted=false, speaker=true`，互换即红；`hold` 仍缺位）、`the_platform_audio_facts_ride_on_every_state_push`（读去注释的 Kotlin 源：断言回调体**把入参交下去**、默认值是 `getCallAudioState()`、三布尔都从 `audio` 派生）、`the_push_arity_agrees_across_the_jni_boundary`（`include_str!` 同时读 Kotlin 与 `incall.rs` —— JNI 按**名字**解析符号，两边必须各 3 个 String ∕ 3 个布尔，别的门禁不比这对签名）。`cargo test -p amos-tauri --features amos-tauri/android --lib incall` **22 passed ∕ 0 failed**（本轮 +4，此前 18）；`make android-glue-check` 绿（BUILD SUCCESSFUL、0 dead declarations、0 findings in our glue），镜像进 `gen/` 逐字节相同。**负控 ×3（各恰 1 红、互不遮蔽）**：①回调体改回 `onCallStateChanged()` ⇒ 恰 **1 红**；②`apply_audio_facts` 去掉 `if !known { return; }` ⇒ 恰 **1 红**；③Kotlin 声明 `speaker: Boolean` → `speaker: Int` ⇒ 恰 **1 红**。`cp` 至 /tmp + `shasum -a 256` 逐字节还原（`AmosInCallService.kt` = `3598cb84…`，改前 = `973b46cc…`；`incall.rs` = `8b002966…`），绝不用 `git checkout --`。
- 如实边界：**未做真机复核**；该钉只在 `--features amos-tauri/android` 下编译运行（`#[cfg(feature = "android")]`）。`hold` 不在 `CallAudioState` 里 —— 由系统 UI 或对端发起的**保持**仍然不可见（§12 #28 的如实边界（二）据此订正），本轮只兑现音频那一半。

### #38 单个 `active` 槽位让一通**还活着**的电话从线上消失（Kotlin glue + Rust 源码钉，2026-09-23，REQ-A1305 / F-TEL-029）

- 背景：`AmosInCallService` 用一个 `private var active: Call?` 表示「当前通话」，`onCallStateChanged()` 以 `val c = active ?: return` 决定推什么，控制命令（`answerIncoming` ∕ `hangUp` ∕ `muteActive` ∕ `speakerActive` ∕ `holdActive` ∕ `setRecording`）也都以 `active` 为对象；方向钉 `latchedDirection` 是**一个**字段。
- 缺陷（对 `git show HEAD` 成立）：
  - ① `onCallAdded(call)` 无条件 `active = call` —— 第二通（来电等待、第二条 VoIP 腿）到达时，第一通**整条**从线上消失（状态、对端、控制面都没有了），而它还在响 ∕ 还在通话。
  - ② 第二通结束时 `onCallRemoved` 只做 `if (call === active) { active = null; latchedDirection = null }` —— 于是 `onCallStateChanged` 的 `?: return` 推**什么都没有**：屏幕上一通电话都没有，而用户还在一通电话上（无对端、无计时、无挂断键）。
  - ③ `onCallDestroyed` 同样只 `if (call === active) active = null`，即使这通已经 dead，也照样可能把槽位清空。
  - ④ `onDestroy` 只 `active?.unregisterCallback(callback)` —— 其余在册通话的 callback 泄漏在正在消失的服务上。
  - ⑤ 方向钉是一个字段：第二通覆盖它；第一通回来时（API < 29，本工程 `minSdk = 26`）只能从会变的状态**重新推导**，正是 §12 #25 修掉的那个错误答案。
- 为什么长期全绿：`incall.rs` 的在通话用例都直接构造事件、不经过 Kotlin 的这条多通话路径；`android-glue-check` 只做编译；没有任何门禁问「槽位被覆盖 ∕ 被清空时说了什么」。方向钉只钉**一通**电话的时序（单通话下那些位置都对）。
- 修复（在两种事实仍可分辨的那一层，即 Kotlin 源头）：
  - `private val liveCalls = linkedSetOf<Call>()`（插入序，最新在末）与 `private val latchedDirections = mutableMapOf<Call, String>()`（方向按**每通**电话各自记住）。
  - `onCallAdded` 先记入两者、再 `active = call`。
  - 新增 `private fun forget(call: Call)`：从两者移除，**然后** `if (call === active) active = liveCalls.lastOrNull()` —— 离开必须把槽位**交给仍然活着的最新一通**，而不是清空；顺序是承重的（先移除再重挑，否则会把槽位交回刚走的那通）。
  - `onCallRemoved` ∕ `onCallDestroyed` 都走 `forget`；`onDestroy` 遍历 `liveCalls` 逐个 `unregisterCallback` 后清空两者。
  - 线形与控制语义不变：仍一次只推一通（`active`），命令仍作用于 `active`（最新一通）。
- 验证：`incall.rs` 新增 `dropping_a_call_refills_the_slot_instead_of_emptying_it`（`include_str!` 读去注释的 Kotlin 源）：①成员是插入序的 `linkedSetOf`、方向是**每通**的 map、且不存在单字段 `private var latchedDirection:`；②`forget` 体内 `liveCalls.remove` ∕ `latchedDirections.remove` 的位置**先于** `active = liveCalls.lastOrNull()`，且体内**不存在** `active = null`；③`onCallRemoved` 先 unregister 再 `forget`、`onCallDestroyed` 也 `forget`、`onDestroy` 遍历 `liveCalls` 并清空两者。同时把既有的 `the_call_direction_is_latched_once_and_prefers_the_platform_answer` 的两条字面量断言更新为新的（`latchedDirections[call] = if (…)` 与 `latchedDirections[it]?.let`）。`cargo test -p amos-tauri --features amos-tauri/android --lib incall` **23 passed ∕ 0 failed**（本轮 +1，此前 22）；`--lib` 全量 **900 passed ∕ 0 failed**；默认特性 `--lib telephony` **15 passed ∕ 0 failed**；`make android-glue-check` 绿（BUILD SUCCESSFUL、0 dead declarations、0 findings in our glue），镜像进 `gen/` 逐字节相同；`node scripts/fmea-gen.mjs --check` OK。**负控 ×4（各恰 1 红、互不遮蔽）**：①`forget` 的 `active = liveCalls.lastOrNull()` → `active = null` ⇒ 恰 1 红（新钉）；②`callDirection` 去掉 `latchedDirections[it]?.let` 那一级 ⇒ 恰 1 红（方向钉）；③`onDestroy` 的 `for (c in liveCalls)` 改成遍历空列表 ⇒ 恰 1 红（新钉）；④`onCallAdded` 的 latch 两词对调 ⇒ 恰 1 红（方向钉）。`cp` 至 /tmp + `shasum -a 256` 逐字节还原（`AmosInCallService.kt` = `5a3c1792…`，改前 = `3598cb84…`），绝不用 `git checkout --`。
- 如实边界：**未做真机复核**；该钉只在 `--features amos-tauri/android` 下编译运行（`#[cfg(feature = "android")]`）。**线上仍一次只推一通电话** —— 本轮修的是「一通还活着却从屏幕上消失」，不是「同时画出两通电话」（多通并发显示 ∕ 通话切换是另一件事，本轮未做）。§12 #25 的单字段叙述（F-TEL-016）按本轮**订正**：latch 现按每通电话各自记住。

### #39 通话录音的**采集半边**从未接线 —— 设备动作之后没有文件产生（Kotlin glue + Rust 接线，2026-09-25，REQ-A1579 / F-TEL-038）

- 背景：`crates/amos-tauri/src/recording.rs` 的**账本半边**早就写好（`<app_data>/recordings.json` 索引、原子写、`safe_call_id` 路径校验、增删、前台门禁、三个 Tauri 命令），`RecordingsPage.svelte` 也把它画得清清楚楚。缺的是另一半：**谁去录**。
- 缺陷（对 `git show HEAD` 成立）：
  - ① `recording.rs::add_recording` 在工作区里**零调用者**；`CAPTURE_WIRED = false` 是编译期常量，于是 `recordings_capture_status` 永远答「采集未接线」。用户在通话屏按录音键，红点亮起，**盘上没有任何文件** —— 账本永远空。
  - ② 用户指向的 `crates/amos-telephony/src/android.rs:234/241`（`AndroidTelephonyProvider::start_recording` 返回「requires a call-audio tap…not yet wired」）**是死代码**：`amos-tauri` 根本不依赖 `amos-telephony`（只有 `amos-ai` 依赖，且不带 `android` feature），那个 provider 从不进 APK。真正编译进 APK 的 seam 是 Kotlin 胶水 `AmosInCallService.setRecording`（`android-glue/com/amos/ai/glue/AmosInCallService.kt`）← `crates/amos-tauri/src/incall.rs::real_set_recording` ← `telephony.rs::telephony_start/stop_recording`。修复落在**这条真链**上，死代码只改措辞使其不再误导。
- 修复：
  - **Kotlin 半边**（真机路径）：`MediaRecorder` + `MPEG_4`/`AAC`/44.1k/96kbps/单声道，写 `<context.filesDir>/recordings/<id>.m4a`（**`filesDir` 而非 `dataDir`** —— 与 blocklist ∕ SMS 回收站 ∕ IME 同一套跨语言目录约定，见 `lib.rs` 的对齐注释）。`setRecording(active)` 六个拒绝（无 self、无活动通话、紧急线路、已在录 ∕ 未在录、`setAudioSource` 抛、`start()` ∕ `stop()` 抛），**词只在设备动作之后才可能出现**（`beginRecording()` 先于 `"On"`、`finishRecording()` 先于 `"Off"`），`is_emergency` 仍是**唯一**调用者且仍先于一切 `MediaRecorder` 提及。id 由 Kotlin **铸造**（`"real-" + System.currentTimeMillis()`），与线缆 payload 的 `"real"` 不同 —— 账本 key 必须唯一，否则两通电话互相覆盖并被去重成一。
  - **源降级**：运行时 `checkSelfPermission(CAPTURE_AUDIO_OUTPUT)` 授予 ⇒ `VOICE_CALL`（双向，系统签名权限，只有平台签名 ∕ 出厂构建拿得到）；未授予 ⇒ `VOICE_COMMUNICATION`（**仅本机麦克风一侧**）。两者都真落盘，**实际用了哪个源**记进台账供 UI 如实呈现。
  - **一次性报告**：`@JvmStatic recordingResult(): String` 返回 `"<id>|<startedAtMs>|<source>"` 并**置空**字段（第二次读返回 `""`）—— 走既有的 `call_static_string`（描述符 `()Ljava/lang/String;`），**不新增 `external fun`**（`the_push_arity_agrees_across_the_jni_boundary` 与 `jni-contract-scan` R2 不动），也杜绝陈旧报告被重复落账。
  - **Rust 半边**：`incall.rs` 记一个「正在录的那通电话的对端」会话（`On` 时盖、`Off` 时读走并清空，空 peer 推送**不清除**已知 peer —— 与 payload 字段同规则）。`file_finished_recording` 逐条 fail-closed：空报告 ⇒ 无文件即无行；解析失败 ⇒ 拒绝；`safe_call_id` 校验；`std::fs::metadata` 存在且 `len() > 0`（文件缺失 ∕ 零长**不落账**）；`duration_sec` 由 `now - device_start` 得并 clamp ≥ 0；`source` 只认两个已知词，其余拒绝。**落账失败但文件已存在**：文件保留（删用户音频更糟），返回带类型的 `Err` 且消息**点名幸存路径**。
  - **能力判据改为运行时**：删掉 `CAPTURE_WIRED` ∕ `CAPTURE_UNAVAILABLE_REASON` ∕ `capture_status_from`，新增纯函数 `capture_status_for(CaptureFacts { platform_supports_capture, dialer_bound, mic_granted })`，三个缺失事实各自点名对应常量（无 in-call seam ∕ 不是默认电话应用 ∕ 无 RECORD_AUDIO），**`available == reason.is_empty()` 由构造保证**。`capture_facts()` 在 android 下取 `incall::is_default_dialer_bound()` ∕ `is_mic_granted()`，非 android 三字段全 false。「正在进行通话吗」**刻意不作为判据** —— 能力 ≠ 时机。`recordings_capture_status()` 保持**零参数**（仍在前台门禁之外，既有源码钉 `the_ledger_read_propagates_the_foreground_gate` 不变）。
  - **目录对齐**：`recording.rs::app_data_dir` 改名 `pub app_data_root`，android 下 `join("files")` —— Kotlin 写 `filesDir/recordings/`，Rust 把录音根解析为 `<app_data_dir>/files`，`recording_path` 的 `<app_data>/recordings/<id>.m4a` 契约不变。
  - **前端如实呈现**：`RecordingMeta` 增可选 `source`（旧行照旧解析）；行内画本地化源标签（`data-source` 供 locale-neutral 断言）；`available === true` 时新画 `recordings.micOnlyNote`（「能录，但这台只录本机一侧」）—— 与「采集不可用」两句**互斥**。
- 验证：`cargo test -p amos-tauri --features amos-tauri/android --lib -- incall:: recording::` **60 passed ∕ 0 failed**（本轮新增报告解析 ∕ 空报告 ∕ 文件缺失 ∕ 零长 ∕ 成功落账 ∕ 恶意 id ∕ 空 peer 不清除 ∕ 时钟回拨不欠账 ∕ 会话一次性 ∕ 8 组合能力不变量 ∕ 本机诚实等）；`node scripts/fmea-gen.mjs --check`、`trace-scan`、`rust-unwired-scan`、`claim-scan`、`android-permission-scan`、`jni-contract-scan`、`i18n-scan` 全绿；`bun run test`（含 i18n 奇偶）+ `test:svelte`（recordings 页 **8 例**）；`make android-glue-check` 绿（**唯一可得的 Kotlin 编译验证** + `-Werror` + Lint 零发现）。**负控（各恰 1 红、逐条指名）**：词上移到设备动作之前 ⇒ 顺序钉红；删 `is_emergency` ⇒ 顺序钉红；`filesDir`→`dataDir` ⇒ 路径钉红；删 `release()` ⇒ 录音器钉红；源检查反序 ∕ 删回退 ⇒ 源钉红；`takeFinishedReport` 不置空 ⇒ 一次性测试红；`split('|')` 不校验长度 ⇒ 解析钉红；不查 `metadata()` ⇒ 「文件缺失不落账」红；`capture_status_for` 某臂返回 `available:true` + 非空 reason ⇒ 不变量红；给 `recordings_capture_status` 加前台门禁 ⇒ 既有门禁钉红。全部 `cp` 快照 + `shasum -a 256` 逐字节还原，**不用 `git checkout --`**。
- 如实边界：**未做真机复核** —— `MediaRecorder` 在真实蜂窝通话中 `start()` 是否成功、实际录到了什么、`VOICE_CALL` 是否真拿得到，本环境均无法验证；Kotlin 半边只有 `make android-glue-check`（编译 + 警告即错 + Lint）。零售安装回退到 `VOICE_COMMUNICATION` 时**只录本机侧，对端声音不保证**。`incall::CLASS` 只在首次 `nativeState` 之后才有，故**首次通话之前**能力判断会保守地报「需要成为默认电话应用」（绝不夸大）。进程在通话中被杀 ⇒ 会话丢失，后续 `Off` 无报告可落 ⇒ 不落账（无文件即无行，诚实）。

### #40 删一条录音：账本行已经写掉、文件却删不掉时，命令回 `Err` —— 一次**已经完成**的删除被画成「删除失败，未删除该录音」（Rust 判据，2026-09-25，REQ-A1602 / F-TEL-039）

- 背景：`recording.rs::remove_recording` 的删除顺序是**先写账本再删音频** —— 这个顺序本身是对的（反过来的话，`save_index` 失败会留下一条指向已消失音频的行，正是 `add_recording` 存在的意义所在）。这一轮修的是它**之后的判据**。
- 缺陷（对 `git show HEAD` 成立，逐字）：
  - ① `remove_recording` 逐字 `let mut index = load_index(app_data)?; index.retain(...); save_index(app_data, &index)?;` —— **账本行已经落盘、已经从列表里消失** —— 紧接着 `if file.exists() { std::fs::remove_file(file)?; }`。
  - ② 音频 unlink 一失败，那个 `?` 把整条删除变成 `Err`。`recording_delete` 原样上抛（`map_err(...)?`），前端的 `recordingDelete` 把失败的 `invoke` 折成 `null`，`RecordingsPage.remove()` 逐字 `if (after == null) { refused = callId; return; }`：**不重画列表**（行留在屏幕上）并渲染 `recordings.deleteFailed`（「删除失败，未删除该录音。」）。
  - ③ 而账本里那一行**已经没了**。用户离开这一屏再回来（`onMount` 重读）或窗口重新获得焦点，那一行就自己消失了。
- 为什么是缺陷：**账本行才是用户看得见的「删除」**，而它已经提交；删除音频是善后。命令的判据（`Err`）说的却是「什么都没发生」，与它自己刚刚造成的状态（行已消失）相反。用户于是先被告知「没删掉」，随后看见它**自行**消失 —— 一次被拒的删除静悄悄地成功了。
- 修复：unlink 改**尽力而为**。`NotFound` 是预期情形（行在、音频从未落盘）；其它 `Err` 只 `tracing::warn!`（点名那个变成孤儿的路径），函数一律 `Ok(())`。账本行是删除的判据；音频删不掉就是**留在盘上的孤字节**，记日志，绝不反过来推翻一次已经完成的删除。
- 验证：`cargo test -p amos-tauri --lib recording::` **32 passed ∕ 0 failed**。新例 `a_recording_whose_audio_cannot_be_unlinked_is_still_deleted` 在录音路径上放一个**目录** —— `exists()` 为真（旧守卫会放行）、`remove_file` 必失败，是确定性且密闭的 unlink 失败替身（真实的「文件被占用」或文件系统错误两者都不确定）—— 断言 `remove_recording` 返回 `Ok`、行已从账本消失、那个删不掉的路径仍在原地（**不假装它没了**）。正控 `remove_recording_updates_index_and_deletes_file`（正常路径仍真的删掉文件）与 `remove_recording_succeeds_if_file_missing` 保持全绿。**红先**：修前该新例逐字红 —— `the row is gone from the ledger, so the delete happened: Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" }`。**负控**：把 unlink 还原成 `if file.exists() { std::fs::remove_file(file)?; }` ⇒ **恰 1 红**，且就是这条新例（`31 passed ∕ 1 failed`）；`cp` 快照 + `shasum -a 256` 逐字节还原（`ed117d1d…`），**不用 `git checkout --`**。
- 如实边界：触发条件是**音频文件删不掉**（磁盘路径被别的东西占住、文件系统错误）。这是一条窄窗，本环境**无法在真机上构造** —— 测试用的是目录占位这一确定性替身，不是真机复现。另有一处**同形**的窄窗本轮**未改**：`recording_delete` 在 `remove_recording` 成功之后**再读一次**账本（`load_index(...)?`），若那次读失败，命令同样回 `Err` 而其实已经删掉；它需要「刚写成功的文件立刻读不出来」，比 unlink 失败更不可能，留着并在此点名。

### 验收
- `cargo test -p amos-telephony --lib`：**89 通过**（§12 #13 之后；早先记录的 68 已随各轮新增用例增长）；`cargo test -p amos-telephony`（含 `telephony_rpc_e2e.rs`）：**2 e2e 通过**；`cargo clippy -p amos-telephony --all-targets -D warnings`：干净；`cargo check --features android` + `cargo clippy --features android -D warnings`：通过。
- 前端：`bun test` 目标文件通过、`tsc --noEmit` 通过（全量 `bun test` 在本机环境存在个别文件空转，非本轮改动引入）。

---

## 13. 通话记录页（Call History，前端，2026-09-10）

电话 App 的「最近」标签从"最近 4 个号码"升级为**完整通话记录页**，每行可 **回电 / 回短信 / 拉黑**。

### 数据模型（`lib/calllog.ts`，纯逻辑）
- `CallRecord` 增可选 `direction: "incoming" | "outgoing" | "missed"`：
  - `normalizeDirection` 白名单校验，未知值一律丢弃（**不猜**）；
  - **向后兼容**：历史记录没有方向时保持 `undefined`（UI 显示中性「通话」），绝不假装是去电；
  - `normalizeCallLog` / `recordCall(list, number, name?, now?, direction?)` 读写方向并保持不可变 + 上限 60。
- 新增页面辅助（locale-neutral，便于测试与本地化）：`callHistory`（最新在前、有界）、`missedCalls`（未接计数）、`callWhenLabel`（today/yesterday/date/unknown）、`callDateStamp`（YYYY-MM-DD）、`fmtCallClock`（HH:MM）。
- **筛选与清空**：`CallFilter = "all" | "incoming" | "outgoing" | "missed"`；`filterHistory(list, filter)` 复用 `callHistory` 的同一归一化（旧的无方向记录只在「全部」出现，绝不被算作某方向）；`clearCallHistory()` 是清空的具名 seam（空日志的单一出处）。
- 写入端：去电 `recordOutgoing` 记 `outgoing`；来电 `IncomingCall` 在 `Ended` 时按"是否接通过"记 `incoming` / `missed`（此前不区分，来电一律无方向）。

### UI（`PhoneApp.svelte`「最近」标签）
- 标题「通话记录」+ 未接计数 + **两段式「清空」**（先 arm 后确认，带取消，避免误触清库）；清空后回到「全部」筛选。
- **方向筛选 chips**：全部 / 来电 / 去电 / 未接（`data-filter`，`filterHistory` 驱动，只显示该方向的记录）；筛选后无记录时显示「该筛选下暂无记录」，与空日志的「暂无最近通话」**区分**（`data-testid="history-empty"`）。
- 行 = 方向图标（↗ 去电 / ↙ 来电 / 红色 ↙ 未接）+ 名称/号码 + 相对时间（`今天|昨天|YYYY-MM-DD HH:MM`）。
- 每行三个动作：**回电**（`telephony_dial`，走既有 AmOS 托管呼叫）、**回短信**（深链到「信息」并预填该号码）、**拉黑**（写入 `exact/both` 拦截规则）；动作按钮 **40×40px**（真机量测原 32×32 偏小，已放大）。
- 无联系人名的行不再把号码重复打印两遍（标题即号码时，次行只显示时间）。**「常用」页同规则**（REQ-A1085 / FMEA F-SH-398）：尾格也只在 `label !== num` 时才画号码，避免「10086 10086」；该页原先既没照做也无 DOM 断言，现由 `svelte-tests/phone.svelte.test.ts` 的一对镜像断言（无联系人只出现一次 / 有名字则名字与号码俱在）钉住。
- 底部诚实说明（本机最多 60 条、来电与去电都记录）。

### 跨应用深链（`svelte/appLinks.ts`）
- 壳一次只挂载一个应用（`Shell.svelte`），因此「回短信」先写目标应用的 props 通道再切面：`composeSmsTo(number)` = `messagesChannel().set({composeTo, nonce}) + shellState.open("messages")`。
- `MessagesApp` 订阅该通道：**真机后端**预填真实短信撰写框（`newTo`/`showNew`）；**宿主/离线**则打开（或选中）同号本地会话；后端探测未完成时暂存，落定后补发。链接在应用后**消费并清空**，因此再从桌面打开「信息」不会重复触发。
- 诚实边界：深链只是"请求撰写"，从不声称已发送。

### 测试与门禁
- 纯逻辑 `src/__tests__/calllog.test.ts`：**17 例**（方向白名单/写入/旧记录不猜、`callWhenLabel` 跨午夜日历日、`callDateStamp`/`fmtCallClock` 补零与未知时间、`callHistory` 顺序/上限 + `missedCalls`；**+2**：`filterHistory` 各方向/旧的 neutral 行只在 all/上限、`clearCallHistory`）。
- DOM `svelte-tests/phone.svelte.test.ts`：记录页方向/未接统计 + 回电真实调 `telephony_dial`；回短信写入 `messages` 通道并切到 `messages` 面；**+3**：方向筛选收窄、空筛选态诚实文案、两段式清空（arm/cancel/confirm + 持久化为空）。
- DOM `svelte-tests/messages.svelte.test.ts`：深链在离线态打开同号本地会话且链接被消费；**+2**：真机线程「屏蔽此号码」写入 `exact/both` 规则 + 成功态、被拒时显式 `role="alert"` 报错。同时新增 `afterEach` 清理假桥接，避免设备态泄漏进离线用例。
- 本机全绿：`bun run check`（`bun test` 含 i18n 奇偶校验、`tsc`/`svelte-check` 0 error、`test:svelte` **374 例**）、`vite build` ✓。

### #41 同一个 `CallSnapshot` 的两个出口对同一通紧急呼叫说了两种话（Rust 线上契约，2026-09-25，REQ-A1776 / F-TEL-046）

- 背景：`ProviderEvent` 是 provider 向每个 `Watch` 订阅者推送的信令事件；`CallStateEvent` 是同一份 `CallSnapshot` 的两个出口之一（另一个是 `Status`）。§#13 已经确立「事件被订阅者**当作快照整体应用**，少带一个字段就会把别的字段静默清掉」这条判据，并据此给四个结束 ∕ 接通变体补上了 `peer` + `direction`。
- 缺陷（对 `git show HEAD` 成立，逐字）：`service.rs::event_to_state_event` 构造 `CallSnapshot` 时逐字 `emergency: false,`（常量），而**同一文件**的 `snapshot_of` 逐字 `emergency: c.emergency,`（模型真值）。于是用户按下 `112` 之后，`Status` 说 `emergency=true`，而 `Watch` 推来的**同一个** `CallStateEvent` 说 `false`。
- 为什么是缺陷（可达）：`Status` 与 `Watch` 是同一个结构体的两个出口，对同一通呼叫必须给同一个答案；而事件流是订阅者（来电浮层、通话记录、未来的合规消费者）唯一能看到的那一份。
- 方向安全 ≠ 无害：紧急判定确实在更早的 route 层完成（`TelephonyService::is_emergency` ∕ `route::guard_regular` ∕ `guard_emergency`），112 必走特权 provider、必不被限流（`dial_limiter` 只在 `!emergency` 时生效）、必不可录音（`CallSession::start_recording` 逐字拒），所以这一处**不改路由**；改的是「事件流里那个字段是不是真的」。
- 为什么既有测试全绿：`event_to_state_event` 的既有断言只覆盖 `state` ∕ `direction` ∕ `muted` ∕ `recording`，没有一例问过 `emergency`；两条路的答案只在 `Watch` 与 `Status` **同时**被读到某通紧急呼叫时才冲突。
- 修复：①`ProviderEvent` 每个携带呼叫的变体（`Incoming` ∕ `Connected` ∕ `RemoteEnded` ∕ `LocalEnded` ∕ `Failed` ∕ `RecordingChanged` ∕ `MutedChanged`）都加 `emergency: bool`，由**持有呼叫的 provider** 从 `Call::emergency` 盖章（`snap.emergency`；`simulate_incoming` 取 `sess.snapshot().emergency`）；②`event_to_state_event` 改从事件的 `emergency` 字段构造 `CallSnapshot`。携带理由与 `MutedChanged` 携带 `recording` ∕ `RecordingChanged` 携带 `muted` **逐字相同**：事件是**被当作快照**应用的。前端**未改**。
- 验证：`cargo test -p amos-telephony` ⇒ **97 ∕ 97**（新增 `service::tests::watch_events_keep_an_emergency_call_marked_emergency`：`dial("112")` 后 `Watch` 首帧 `emergency == true`；再 `set_muted(id, true)` —— 静音在紧急呼叫上合法，`session.rs::emergency_call_may_be_muted` 已钉，因而是能合法驱动一次**信号事件**的入口 —— 其 `MutedChanged` 事件仍 `emergency == true` 且同帧 `muted == true`）、`--test telephony_rpc_e2e` **2 ∕ 2**、依赖方 `cargo test -p amos-telemetry-spy` **25 ∕ 25**、`cargo check -p amos-ai --lib` 干净；`clippy --all-targets -- -D warnings` ∕ `rustfmt --check` 干净；`rust-unwired-scan` **0 new**。**负控**：把 `CallStateEvent.emergency` 扰回字面 `false` ⇒ **恰 1 红**（`96 passed ∕ 1 failed`，断言处逐字 `expected false to be true`）；`cp` 快照 + `shasum -a 256` 逐字节还原（`service.rs` = `129c7bd5…`、`provider.rs` = `601862b9…`），**不用 `git checkout --`**。
- 如实边界：①mock 的 `CallSession::start_incoming` 本身把 `emergency` 定为 `false`（**来电的紧急号分类不在本层**，mock 只产出来电普通号），故 `Incoming` 事件目前恒 `false` —— 但那是**模型自己的值**（`snapshot_of` ∕ `status()` 读的是同一个字段），不是事件层另造的常量；真要分类来电紧急号，应落在模型 ∕ route 层并**同时**改变两条出口；②`ProviderEvent::Failed` 全仓**无构造点**（修前亦然），本轮为枚举一致性补字段、未新增构造；③**无真机** —— mock 的紧急 provider 不广播 `Connected` 等事件，证据是域 ∕ 服务层单测 + 源码钉；④未动命令 ∕ 路由 ∕ 限速 ∕ 审计。

### #42 通话结束而录音不停 —— `MediaRecorder` 在整段默认拨号器任期里继续采麦克风，且录音**再也开不起来**（Kotlin glue + Rust 源码钉，2026-09-26，REQ-A1859 / F-TEL-048）

- 背景：§#39 把录音的采集半边接上了真 `MediaRecorder`（`beginRecording` / `finishRecording` / `abortRecording`），六个拒绝、词只在设备动作之后。本轮接着审计它**最新**加的那层，问的是「谁会了结一个**已经没人要**的录音」。
- 缺陷（对 `git show HEAD` 成立，逐字）：`AmosInCallService` 的 `recorder` ∕ `recordingId` ∕ `recordingFile` 全是**服务级**字段，服务寿命是整个默认拨号器任期（`onCreate` 置位、`onDestroy` 才清），比任何一通电话都长。而只有 `onDestroy` 逐字 `abortRecording()`。于是用户在通话中点「录音」（`On`，设备真的在写文件），直接**挂断**：
  - ① `forget(call)` 只做 `liveCalls.remove` ∕ `latchedDirections.remove` ∕ 重挑 `active`，**不碰** `recorder` —— `MediaRecorder` 在**没有通话**的情况下继续采麦克风；
  - ② 写出的 `<filesDir>/recordings/<id>.m4a` **没有任何台账行**会指向它（报告只在 `finishRecording` 里闩，而它需要一次 `setRecording(false)`）——「no file, no row」被反过来违反：有文件、无行；
  - ③ `setRecording(false)` 此刻逐字 `val c = s.active ?: return "Failed"` ⇒ **无通话即 `Failed`**，那条 `Off` 通路（也就是唯一能 finalize 并闩报告的路径）**结构性地不可达**；
  - ④ 更要紧的是 `if (active && s.recorder != null) return "Failed"` —— `recorder` 非空 ⇒ **此后每一次 `setRecording(true)` 都拒**。录音**永久坏掉**，直到服务被销毁。
- 为什么既有测试全绿：`incall.rs` 的源码钉只按 `kotlin_body` 读 `beginRecording` ∕ `finishRecording` ∕ `abortRecording` ∕ `setRecording` **各自体内**的断言，没有一例问过「谁在**通话离场**时了结录音」；`RecordingContractTest` 是纯半边（无 `Context`），`onDestroy` 的 `abortRecording()` 是既有先例、但只覆盖「服务死」这一条离场。
- 修复（最小，落在 Kotlin 源头）：
  - ① 新增实例字段 `private var recordingCall: Call? = null` —— 录音**记住**它开始于哪通电话；「有录音」与「有通话」由此成为两个可分辨的事实。
  - ② `beginRecording()` 里 `recordingCall = active` 与其余 live 状态**同批**闩住，位置在 `rec.prepare()` **之前**（同理由：prepare/start 抛出的路径要留给 `forget` 分辨是哪通电话，且 `abortRecording` 会清它）。
  - ③ `forget(call)` 末尾逐字 `if (call === recordingCall) abortRecording()` —— 只了结**离场的那通**电话自己的录音；另一通电话正在录的录音不受影响（`===` 判据即为此）。
  - ④ `finishRecording()` 与 `abortRecording()` 各自清 `recordingCall = null`（两条出口），使一个已离场电话的录音槽不会残留到以后。
  - 用 **abort**（release + 删部分文件）而非 finalize：`Off` 通路需要一个活着的 `active`，此刻已无读者，无人读的报告就是孤儿文件 —— 与 `abortRecording` 自己写的「no file, no row」一致，也与 `onDestroy` 的既有选择一致。**不**新增 JNI 出口、**不**改 Rust 命令面、**不**改前端（`PhoneApp.svelte` 在 `Ended` 时本来就只把本地 `recording` 翻成 `Off`；真值现由胶水的状态推送上行）。
- 验证（本节可得的**唯一** Kotlin 编译验证 + 主机可跑的行为）：
  - `incall.rs` 新增源码钉 `a_recordings_own_call_resolves_it_on_departure`（`include_str!` 读去注释 Kotlin 源）：①`recordingCall` 是实例字段且初值 `null`；②`beginRecording` 体内 `recordingCall = active` 的下标**小于** `rec.prepare()`（顺序是**量出来的**，不是假设的）；③`forget` 体内逐字 `if (call === recordingCall) abortRecording()`（只了结离场那通的）；④`finishRecording` 与 `abortRecording` 体内各有 `recordingCall = null`。
  - `cargo test -p amos-tauri --features amos-tauri/android --lib` ⇒ **1109 ∕ 0**（本轮 +1）。
  - **负控 ×3（各恰 1 红，互不遮蔽）**：①删 `forget` 里那行 ⇒ 恰 1 红（`forget must resolve the recording of the departing call…`）；②只删 `abortRecording` 的 `recordingCall = null` ⇒ 恰 1 红（`…must clear the call latch…`）；③把 `recordingCall = active` 从 `prepare()` 之前移到 `rec.start()` 之后 ⇒ 恰 1 红（`…must be latched to its call before prepare()/start()…`，报下标 `latch 1114, prepare 1072`）。全部 `cp` 到 `/tmp` + `shasum -a 256` 逐字节还原（`AmosInCallService.kt` = `d4ae25aa…`），**不用 `git checkout --`**。
  - 同时补齐 §#39 抽取 `RecordingContract` 后**失同步**的既有源码钉（纯半边搬家后的跟随更新，非新缺陷）：`the_recording_source_prefers_voice_call_and_falls_back` 改读委托点 `RecordingContract.audioSourceName(source)` + `RecordingContract.audioSourceName` 体（`VOICE_CALL -> SOURCE_VOICE_CALL` / `else -> SOURCE_VOICE_COMMUNICATION`）+ 两个 `const val SOURCE_*` 字面量；`the_finished_report_is_one_shot_and_carries_id_start_and_source` 改读委托点 `RecordingContract.buildReport(id, startedAt, src)` + `buildReport` 体的 `"$id$REPORT_DELIMITER$startedAtMs$REPORT_DELIMITER$source"`。同轮把 §#39 引入的 `non_snake_case` 测试名 `setRecording_drives_…` 改成 snake_case（`--all-targets -- -D warnings` 会红）。
- 如实边界：本环境**无法真机复核** —— ROLE_DIALER 在本机由 `com.google.android.dialer` 持有（改默认拨号器是用户同意 ∕ 系统设置层面的更改，本轮不擅自改），故真机上「挂断后麦克风是否真的松开」与「录音键是否真的又能按」只能由 Kotlin 源码钉 + 主机可跑的 `RecordingContractTest` 作证；胶水侧另有 `make android-glue-check`（编译 + 警告即错 + Lint 扫 `com/amos/ai/glue/`）。修的是一处**确定性**的字段生命周期缺陷，不是一次真机观察。




### #43 一个只被 `<data>` 限定的 DIAL 过滤器永远无法让应用**获得** ROLE_DIALER —— 真机上「拨号器候选」这一格从来没有过（清单片段 + 生成清单 + 结构感知门禁，2026-09-26，REQ-A1873 / F-AND-018）

- 背景：§#29 加了「查询 ∕ 申请 ROLE_DIALER」的前端入口，§#34/#35/#36 的每一次设备动作都以「AmOS 是默认电话应用」为前提、未绑定时逐字具名拒绝。这一轮上了真机（S5，Android 14），要验的就是那个前提**能不能成立**。结论：不能 —— 而且不是因为用户没在设置里点，是因为这个包**在平台看来根本不具备候选资格**。
- 缺陷（对 `git show HEAD` 成立，逐字）：`crates/amos-tauri/android-glue/AndroidManifest.activity.xml`（以及手抄进生成清单的那份）里的 DIAL 过滤器写成
  ```xml
  <intent-filter>
      <action android:name="android.intent.action.DIAL" />
      <category android:name="android.intent.category.DEFAULT" />
      <data android:scheme="tel" />
  </intent-filter>
  ```
  平台判一个包够不够格拿 `android.app.role.DIALER`，是拿这个 role 的 `RequiredComponent` 去问 PackageManager：对 DIALER 而言就是**带 action DIAL、不带任何 data URI** 的 intent —— 平台自己在拒绝日志里逐字写了 `IntentFilterData{mDataScheme='null', mDataType='null'}`。而 `IntentFilter.matchData` 遇到「过滤器声明了 `<data>` scheme、进来的 intent 没有 data」时答 `NO_MATCH_DATA`。于是这个过滤器能接 `tel:` 链接，**永远接不到** role 那条无 data 的查询。
- 真机证据（修前）：`adb shell cmd package query-activities -a android.intent.action.DIAL` 只返回 `com.google.android.dialer`；加上 `-d tel:110` 才出现 `com.amos.ai/.MainActivity`。`cmd role add-role-holder android.app.role.DIALER com.amos.ai` 逐字拒绝：`Package does not qualify for the role, package: com.amos.ai, role: android.app.role.DIALER`（`E RoleControllerServiceImpl`）。APK 编译、安装、启动全绿 —— **没有任何一步会失败**，这个面只是永远不可达。
- 为什么没有任何门禁看见它：`scripts/android-glue-mirror.sh` 比对两份清单只按 `android:name` **字符串**，而一个「裸」DIAL 过滤器**不引入任何新 name** —— 增删那个够格的过滤器对它完全不可见；`scripts/android-component-scan.mjs` 判的是 `<service>` ∕ `<receiver>`，不判 `<activity>` 的过滤器；`scripts/android-permission-scan.mjs` 读的是 `<uses-permission>`。这正是本仓的经典缺陷类：**没有东西抛错**。
- 修复（最小，两处清单同步）：把 DIAL 拆成**两个**过滤器 —— 一个**裸**的（action + DEFAULT，无 `<data>`，只负责 get role 资格），一个 `tel` 限定的（原样保留，负责 dial 链接）。Google 自己的拨号器为完全相同的理由也带两个 DIAL 过滤器。（`android.intent.category.DEFAULT` 在两个过滤器里都写是有意的：隐式 `startActivity` ∕ `queryIntentActivities` 只匹配带 DEFAULT 的过滤器。）
- 新增结构感知门禁 `scripts/android-role-scan.mjs`（**新增文件**，~300 行）：`ROLE_REQUIREMENTS` 是「role → 平台解析 `RequiredComponent` 所用的 action/category，且**无 data**」的**记录表**；对跟踪片段与生成清单（存在时）各跑一遍 —— 某个 role 的 action 有过滤器声明、但**每一**个都被 `<data>` 限定 ⇒ `role-filter-scoped-by-data`（就是本次 S5 的缺陷）；完全没声明 ⇒ `missing-role-filter`；裸过滤器漏了 DEFAULT ⇒ `role-filter-without-category`。`tel` 限定的兄弟过滤器是**具名报告**（它是真实产品面，不是缺陷）而非判负。挂进 `make gated-check`（`--selftest` 钉解析器 ∕ 分类器 + 正式扫）。
- 验证：`node scripts/android-role-scan.mjs --selftest` **14 ∕ 0**；`node scripts/android-role-scan.mjs` ⇒ `1/1 role(s) qualify; 1/1 in the generated manifest; 2 scoped sibling(s) reported`。**负控 ×2（各恰 1 红，互不遮蔽）**：①把裸过滤器删掉（只留 `tel` 那个）⇒ `role-filter-scoped-by-data` 恰 1 红；②把裸过滤器的 `<category DEFAULT>` 删掉 ⇒ `role-filter-without-category` 恰 1 红。两次都 `cp` 到 `/tmp` + `shasum -a 256` 逐字节还原片段（片段 = `6b3a7c17…`），**不用 `git checkout --`**。修后真机：裸 DIAL 查询返回 `com.amos.ai/.MainActivity`（`match=0x108000`，与 Google 的同值）；`cmd role add-role-holder` 成功；`mDefaultDialerCache` = `com.amos.ai`。
- 端到端真机复核（用户同意后拨 `10010`）：Telecom `InCallController` 逐字 `getComponents, pkgname: com.amos.ai … requestedType: 1`（= `DEFAULT_DIALER_UI`），`found: ComponentInfo{com.amos.ai/com.amos.ai.glue.AmosInCallService} isRequestedtype:true`，`defaultDialer: [ComponentInfo{com.amos.ai/com.amos.ai.glue.AmosInCallService} …]`；`dumpsys activity services` 显示 `ServiceRecord{… com.amos.ai/.glue.AmosInCallService}` 由 `callingPackage: com.android.server.telecom; callingUid: 1000` 绑定。挂断后 `ICSBC#disconnect: unbinding after 12667 ms … isCrashed: false` —— **`AmosInCallService` 在真机上绑定成功，零崩溃**。
- 如实边界：①**role 会间歇性回落到 `com.google.android.dialer`**，一次重新授予曾返回 `ExecutionException: java.lang.RuntimeException: Failed`，随后再试又成功 —— 这是设备 ∕ 系统设置层面的行为，本仓不做手脚，按约定验完已把 `com.google.android.dialer` 还原为持有者；②Google 的拨号器是 `/product/priv-app` 特权产品应用、持有 `CONTROL_INCALL_EXPERIENCE`（`control: true`），侧载的 AmOS 是 `control: false, ui: true` —— 这也解释了早前 `Skipping binding to %s:%s, control: %b, car-mode: %b, ui: %b` 那行只在 role 回落时出现；③本门禁的 role 表是**手工维护**的，没人列出的 role 不可见；它断言的是**资格**（平台会把这个包列出来），从不断言 role 已被授予或绑定的服务行为正确 —— 那是设备事实；④`AndroidManifest.activity.xml` 片段本身**不是自足合法 XML**（其头注释里嵌套了 `<!-- AndroidTV support -->`，第 16 行 col 18），这是**既有**现象、非本轮引入，镜像脚本是 grep 它而非解析它。
