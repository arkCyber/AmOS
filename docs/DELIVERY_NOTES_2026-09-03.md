# 交付说明与遗留清单 (Delivery Notes & Known Limits)

**日期**: 2026-09-03
**范围**: 从"外部 AI 分析复核"开始，到 telephony P0–P2(事件核心) 与 voice daemon 侧接线实现。本文件供提交/归档使用。
**状态基线**: `main` @ `5ee568c`（本段改动均在其之上，工作树未提交）。

---

## 1. 可直接使用的提交说明（commit message）

按仓库既有提交风格（`feat(scope): …`）组织，覆盖本段全部改动；若想拆分成更细粒度再自行拆分。

```
feat(telephony): amos-telephony core + gRPC service + UI bridge (P0-P2 core)

Audit-driven: unified deployment strategy then filled the two real gaps
(phone + AI-assistant voice) that the external analysis mis-stated.

Strategy/docs
- Reconcile two "base" narratives: product = no-UI Android base;
  Waydroid is dev/prototype only (docs/no-ui-android.md, android-compat.md,
  ARCHITECTURE.md).
- docs/external-analysis-review.md: line-by-line audit of an external gap
  analysis vs the real tree (which claims were accurate / stale / wrong).
- FUNCTIONAL_GAP_ANALYSIS.md + README.md synced to reality; telephony.md,
  bidi-voice-asr.md, device-poc.md added.

Telephony (crates/amos-telephony) — P0 domain + P1 service + P2 event core
- Domain: Number/EmergencyMap classification, CallSession state machine,
  TelephonyProvider + separate EmergencyTelephonyProvider (emergency never
  shares the ordinary dial path), deterministic MockTelephonyProvider.
- Wire: proto/telephony.proto (amos_telephony: Dial/Answer/End/Status/Watch)
  wired into amos-proto codegen; TelephonyService mounted on amos-ai's shared
  UDS alongside AiAgent/AndroidManager.
- UI: amos-tauri telephony_* command bridge; PhoneApp dials via it; lock-screen
  emergency quick-dial 110 (i18n zh/en).
- P2: Watch upgraded from a one-shot listing to a real continuous event stream
  (ProviderEvent {Incoming,Connected{id,peer},...}); Mock reports events;
  TelephonyService::inject_incoming() for headless incoming-call simulation.

AI-assistant voice (daemon side) — closes server.rs Payload::Audio "not wired"
- amos-ai/src/chat_asr.rs: ChatAsr seam over amos_asr StreamingRecognizer
  (mock default; AMOS_ASR_BACKEND=off disables). Payload::Audio frames feed it;
  on utterance end the recognized text is enqueued as a Prompt, reusing the
  existing infer/audit/session path unchanged.

Tests (all green at write time)
- amos-telephony: 25 unit + 2 UDS e2e
- amos-ai --lib: 73 (incl. 4 ChatAsr); amos-proto/tauri compile; fmt+clippy clean
```

---

## 2. 改动清单

### 新增（未跟踪）
| 路径 | 说明 |
|---|---|
| `proto/telephony.proto` | telephony gRPC 契约（package `amos_telephony`） |
| `crates/amos-telephony/` | 新 crate：`src/{lib,error,number,session,provider,service}.rs` + `tests/telephony_rpc_e2e.rs` + `Cargo.toml` |
| `crates/amos-tauri/src/telephony.rs` | Tauri `telephony_dial/end/status` 命令桥 |
| `crates/amos-ai/src/chat_asr.rs` | daemon 侧语音识别 seam |
| `docs/telephony.md` | telephony 设计 + 契约 + 路线图 |
| `docs/bidi-voice-asr.md` | voice bidi→ASR 设计 + 状态 |
| `docs/device-poc.md` | 真机 POC 运行手册（交叉编译 + `chat_once`/UDS） |
| `docs/external-analysis-review.md` | 外部分析逐条复核 |

### 修改
| 路径 | 说明 |
|---|---|
| `Cargo.toml` | workspace 成员/依赖加 `amos-telephony`；加 `amos-asr` 进 amos-ai |
| `crates/amos-proto/{build.rs,src/lib.rs}` | telephony.proto 编入 codegen；暴露 `amos_telephony` 模块 |
| `crates/amos-ai/{Cargo.toml,src/lib.rs,src/server.rs}` | 依赖；`pub mod chat_asr`；bidi `Payload::Audio`→ASR；挂 `TelephonyService` |
| `crates/amos-tauri/{src/lib.rs, frontend-ts/*}` | 注册 telephony 命令；`backend.ts` 类型化桥；`PhoneApp` 拨号；锁屏紧急 110（i18n zh/en） |
| `README.md` / `FUNCTIONAL_GAP_ANALYSIS.md` | 索引与状态同步 |
| `docs/{ARCHITECTURE,android-compat,no-ui-android}.md` | 部署判定统一 |

---

## 3. 验证汇总（写时全绿）
- `cargo test -p amos-telephony` → 25 单测 + 2 UDS e2e。
- `cargo test -p amos-ai --lib` → 73（含 4 个 `ChatAsr`）。
- `cargo check -p amos-tauri`、`cargo check -p amos-proto` 编译通过。
- `cargo fmt --check`、`cargo clippy`（涉及 crate）干净。
- `bun run typecheck` + `bun run test`（frontend-ts）通过（含 lock-screen/PhoneApp 渲染）。
- 提示：期间你的 `tauri dev` 曾持 cargo 构建锁，本段验证在锁空闲时完成。

---

## 4. 已知限制 / 遗留事项（Known limits & leftover）

### 需要真机 / OEM（无法在无真机环境完成/验证）
- **telephony P3**：真 Android/Binder `TelephonyProvider` + `EmergencyTelephonyProvider`（`feature android` + `#[cfg(target_os)]` 已留占位，未实现）。
- **voice 真机采集 / 真 sherpa**：当前用 WebView `getUserMedia`；本地 sherpa 后端（`amos-asr` `sherpa` feature）与原生 AAudio/cpal 采集未接。
- **device POC 上机验证**：按 `docs/device-poc.md` 交叉编译 `amos-ai`、`adb push`、跑 `chat_once`/UDS 的实测未执行（需 12GB 真机）。
- **OEM 配合项**：Default Phone App/`ROLE_DIALER`、锁屏可信紧急入口、特权权限、`EmergencyMap` 司法区装配、交叉验证窗（见 `docs/telephony.md` §9）。

### 已知未完成（可无头但体量大/端到端依赖运行中 daemon）
- **telephony P2 剩余**：Watch **前端来电浮层 + Tauri 事件桥**。事件核心已做（Watch 真实流 + `inject_incoming`），但要让运行中的 GUI 显示来电，需要 amos-tauri 后台订阅 daemon Watch 并转成 Tauri 事件 → 前端浮层；端到端演示还依赖一条能对运行中 daemon 注入来电的通道。
- **voice transcript 回显**：`AgentChunk.transcript` 字段（区分"识别灰字"与"模型 token"）未加；会给 server.rs 所有 `AgentChunk` 字面量带来连锁改动。现行为识别成句后当 Prompt，interim 不单独回显。

### 已知暂缓 / 诚实标注
- `Watch` 的 `Status` 仍为"查询一次 live calls"（一次性）；来电推送走 `Watch` 流而非 `Status`。
- `MockTelephonyProvider` 是内存态、非并发安全的"单用户"模拟（适合无头演示，非生产）。
- `amos-telephony` `android` feature 存在但无内容（P3 占位）。
- telephony `Answer/End` 经普通 provider；紧急通话挂断语义（不可被普通逻辑吞掉）在真 provider（P3）落实。
- `ChatAsr` mock 只按样本数出固定短语（确定性、便于测试），非真实识别；真识别属 sherpa 后端。
- CI：本段未跑完整 `gated-native-backends`（涉及 sherpa/piper 联网下载）；本地 sherpa/Piper 门控未动。

### 建议的后续顺序
1. 拿到 12GB 真机 → 执行 `docs/device-poc.md` 的 POC（成本最低、去风险最大）。
2. 准备"真机落地 checklist + OEM 需求清单"文档（为设备到货与商务谈判备好）。
3. telephony P3 / voice 真机采集 / Watch 前端浮层 / voice transcript（各自依赖真机或运行中 daemon）。
