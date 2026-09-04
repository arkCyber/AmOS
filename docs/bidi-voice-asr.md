# AI 助手语音输入接线方案：bidi `Payload::Audio` → 本地 ASR

**日期**: 2026-09-03
**状态**: 🟡 **daemon 侧已实现（2026-09-03）**：`amos-ai` 新增 `ChatAsr`（`amos-asr` 确定性 Mock 默认，`AMOS_ASR_BACKEND=off` 可关），`server.rs` 的 bidi `Payload::Audio` 分支已改为逐帧喂识别器，endpoint 到达时把识别文本作为 Prompt 复用既有推理/审计/会话路径（73 amos-ai lib 测试通过）。**仍未接**：真机原生采集（现 WebView `getUserMedia`）与真 sherpa 后端（`amos-asr` `sherpa` feature + 模型目录）。
**问题**：`amos-ai` 的 bidi `Chat`（`proto/ai_agent.proto`）客户端能推 `Payload::Audio` 帧，但 daemon 对音频帧**诚实忽略**——`crates/amos-ai/src/server.rs:559` 回一句"ASR 尚未接入，请改用文本输入"并用 mock token 应答。本方案把这条语音通道接上本地 ASR，让「对 AI 助手说话 → 语音转写 → 走推理回复」端到端跑通。
**关联**：`FUNCTIONAL_GAP_ANALYSIS.md` §C.11（真缺口之一）；`docs/native-voice.md`（仓库语音现状与 seam 原则）；`crates/amos-asr`（`StreamingRecognizer` seam 已就绪）。

---

## 1. 现状盘点（先看清三条语音路径，别混淆）

仓库里其实**已有**语音能力，但和「AI 助手 bidi」是三条不同路径：

| 路径 | 音频来源 | ASR 在哪 | 现状 |
|---|---|---|---|
| 同传 native | WebView `getUserMedia` → PCM | **本地 sherpa** 在 `amos-tauri` native（`interpret.rs`，feature `sherpa-asr`） | ✅ 已接线（见 `docs/native-voice.md`） |
| VoiceMicButton（一次性） | WebView 录一段 → **整段 WAV** | `amos-translate` daemon `Transcribe`（`SpeechRecognizer`：Mock/Whisper） | ✅ 已接线（整段识别，非流式） |
| **AI 助手 bidi `Chat`** | （proto 已留 `audio` 字段） | **无**——daemon 对帧诚实忽略 | ❌ 本方案要接的 |

**关键事实（先对齐再动手）**：
1. `StreamingRecognizer` trait 已就绪（`amos-asr/src/recognizer.rs`）：`reset()` / `push_samples(&[f32]) -> Option<Hypothesis>` / `is_endpoint()` / `finalize()`；采样规格为 **mono PCM 16 kHz f32**。附确定性 `MockStreamingRecognizer`（离线可测）+ `SherpaOnlineRecognizer`（feature `sherpa`）。
2. **今天没有任何客户端把帧推给 daemon 的 bidi `Audio`**——前端 `VoiceMicButton` 是"录整段→`transcribeAudio`(translate daemon)"，不往 `Chat` 里推流。所以本方案要改**两端**：daemon 的 `Payload::Audio` 分支 **和** 前端/桥接的采集推送。
3. `amos-asr` 目前**不是** `amos-ai` 的依赖（仅 `amos-tauri` 在 `sherpa-asr` feature 下用它做同传）。要在 daemon 内做 ASR，需给 `amos-ai` 加**可选** `amos-asr` 依赖 + feature。

---

## 2. 方案与决策（A：daemon 端 ASR vs B：沿用 native 端 ASR）

### 方案 A（推荐，契合"关掉 server.rs 那个分支"）：daemon 内做流式 ASR
`Payload::Audio` 帧在 `amos-ai` 内喂给 `amos-asr` 的 `StreamingRecognizer`，逐段出 interim（回显给前端），端点到后 `finalize()` 出文本，**当作一次 Prompt** 走现有 `backend.infer()`（复用语义卡片/审计/会话/token 计量），token 在**同一条 bidi** 流回。

```
[mic] --16k mono f32 帧--> Chat(bidi) Audio --> amos-ai
      amos-ai: ChatAsr(StreamingRecognizer)
          每帧 push_samples → interim 文本回显(transcript)
          is_endpoint / AudioEnd → finalize → 文本当 Prompt
              └─ backend.infer() → 逐 token 回 → UI 渲染模型回复
```
- **Mock 默认**（无 sherpa 依赖也能离线/CI 全绿）；`sherpa` feature 开真模型。
- ASR 生命周期跟随会话，`ChatAsr` 是可注入句柄（照 `build_backend_from_env()` 的模式），非硬编码。

### 方案 B（仓库 native-voice.md 曾倾向的 seam）：ASR 留在 `amos-tauri` native，daemon 只收文本
既然 `amos-tauri` 已为同传宿主 sherpa，AI 助手也可**复用同一份本地 sherpa**，在 native 侧把 mic 帧转成文本后，只把文本作为 `Prompt` 发 `Chat`；`Payload::Audio` 保持可选/预留。
- 优点：不把重原生库再塞进 `amos-ai` 一个 daemon；符合 `native-voice.md`「ASR 放 `amos-asr`/native，别在 daemon 里重复灌重库」的原则。
- 缺点：**没关掉** server.rs 的 `Payload::Audio`"诚实忽略"分支（要接就得接）；语音链路的中间态（interim）需 native 自己处理并在 `Chat` 里以别的方式传。

### 决策建议
**默认走方案 A**，理由：① 外部分析与本仓库都把"server.rs `Payload::Audio` 未接"列为真实缺口，方案 A 直接闭合它；② ASR 放 daemon 使整条语音→推理链路可**无头（UDS）端到端测试**，不依赖 GUI/`getUserMedia`；③ 复用**同一个 `amos-asr` crate**（非每个 daemon 各写一份 sherpa），`sherpa` feature 门控，默认不增重。方案 B 作为真机生产路径的候补（真机采集是 WebView，native sherpa 就近更省带宽），但**两条路的 proto 契约与 `ChatAsr` seam 应一致**，这样日后在 native/daemon 间迁移 ASR 位置不用改契约。
---

## 3. proto 契约改动（`proto/ai_agent.proto`，提案）

核心原则：**把「ASR 中间结果」与「模型 token」分开**，避免把转写文本塞进 token 通道造成 UI 混排。

```proto
// ---- 新增：client → server 音频流握手（在第一条 Audio 前先发）----
message AudioConfig {
  uint32 sample_rate_hz = 1;   // 固定 16000
  uint32 channels = 2;         // 固定 1（mono）
  // 采样为 f32 little-endian（与 amos-asr::push_samples(&[f32]) 一致）
}
// 复用现有 client_message.Payload：
//   Audio(audio)        每条 = 一帧 f32 mono PCM bytes；首帧前应先发 AudioConfig。
//   AudioEnd（新增）   客户端松开麦/结束本次说话 → 触发 daemon finalize + 当 Prompt。
//   Cancel(..)          取消本次会话（保持现有语义）。

// ---- 新增：server → client 的转写回显字段（挂到现有 AgentChunk）----
message AgentChunk {
  // …既有字段（session_id/token/done/error/card）不变…
  string transcript = N;  // 可选：ASR interim/final 文本，非模型 token；
                          // UI 应据此单独渲染"正在识别…"（灰色字），不当作模型回复。
}
```

**契约约定**：
- 音频统一 **16 kHz mono f32**（与 `amos-asr` 一致）。若前端原生只给别的规格（如 Int16/48k），由采集端重采样到 16k mono 再发（同传 `InterpApp` 已是 16k mono，可直接复用规格）。
- **`transcript` 与 `token` 二者在一帧内互斥**：`transcript` 有值时是转写（interim 或 final），模型 token 用既有 `token` 通道。UI 判定：看见 `transcript` 显示识别灰字；看见 `token` 追加到模型气泡。
- 保持向后兼容：老客户端不发 `AudioConfig`/`AudioEnd`、不读 `transcript` 也正常（Audio 分支缺省退回现在的"诚实提示"）。

---

## 4. daemon 侧 seam：`ChatAsr`（`amos-ai`）

新增一个可注入句柄（对齐现有 `build_backend_from_env()` 的后端工厂模式），不把 recognizer 硬编码进 `Chat` 循环：

```rust
// amos-ai/src/chat_asr.rs（提案）
/// 一次 bidi 会话的语音转写句柄：持有并驱动一个 StreamingRecognizer。
pub struct ChatAsr {
    rec: Box<dyn StreamingRecognizer>,   // amos-asr
    finalized_text: Option<String>,       // 已 finalize 的文本（本次 utterance）
}

impl ChatAsr {
    /// 按 AMOS_ASR_BACKEND 构造：mock(默认,确定性) | sherpa(需 feature)。
    pub async fn from_env() -> Option<Self>;   // 未启用/无配置 → None（退回诚实提示）

    pub fn feed_frame(&mut self, samples: &[f32]) -> Option<Hypothesis>; // interim
    pub fn should_finalize(&self) -> bool;        // recognizer.is_endpoint()
    pub fn finalize(&mut self) -> String;          // 取文本并 reset，准备下一句
}

// server 的 Chat 服务初始化时（镜像 monitor/sessions 字段）：
//   let asr = crate::chat_asr::ChatAsr::from_env().await;  // Option<ChatAsr>
- 默认（无 feature）也内置 `MockStreamingRecognizer`（经 `amos-asr`），只是 `sherpa` 真模型需开 feature + `AMOS_SHERPA_MODEL_DIR`（同 `native-voice.md` 的同传参数）。

---

## 5. server.rs `Payload::Audio` 分支改造（核心改动）

现有循环在 `server.rs` 的 bidi handler 里按 `client_message.Payload` 分派：`Prompt`(→语义卡或 infer)、`Audio`(→诚实忽略，`:559`)、`Cancel`(→break)。改为在 `Chat` 会话内维护一个 `Option<ChatAsr>`，`Audio`/`AudioEnd` 分支如下：

```
状态变量：asr: Option<ChatAsr>   （每会话一个，冷启动按 env 建）

分支 Payload::Audio(audio)：
  asr = asr 或 from_env()（无则按现状回"语音未启用"提示）
  samples = 解码 audio → &[f32]（校验 16k mono；规格不符则报错帧）
  if let Some(h) = asr.feed_frame(samples):        # interim
      send AgentChunk{ transcript=h.text }          # 回显灰字（不占 token）
  # 不在此刻做 infer——等 endpoint 或 AudioEnd 再一次性成句

分支 Payload::AudioEnd（新增）或 检测到 asr.should_finalize()：
  if let Some(t) = asr： text = asr.finalize()
  # 将 text 当作本轮 Prompt，复用到既有逻辑：语义卡 detect → 或 backend.infer()
  #   → 逐 token 走同一条 bidi 回 UI；沿用现有 token 计量 / security / 会话 append。
  # 完成后 asr.reset()，准备下一句。Cancel 在任意时刻 break（同现语义）。
```

**要点**：
- **成句门槛**：一条语音只在「`AudioEnd` 到达」或「recognizer `is_endpoint()`（VAD/静音）」时 finalize 一次并触发推理——避免每帧都打一次模型。interim 只回显、不触发模型。
- **复用而非新写**：finalize 出的文本直接走 `Prompt` 那套（语义卡 + `backend.infer` + token 计量 + `security` 审计 + `sessions`），保证 AI 助手语音/文本行为一致。
- **Cancel 优先**：bidi 的 `select!` 已监听 `Cancel`；ASR 期间用户取消即丢弃当前 utterance（可省得把噪音送进模型）。
- 会话/token 记账沿用现有 `sessions.update(&session_key, add_tokens)`——转写文本不作为"生成 token"计，只有模型回复才计。

---

## 6. 前端 / Tauri 桥接接线

要让 daemon 真收到音频，得把「录音→送 `transcribeAudio`（整段 WAV）」与「录音→实时推 `Chat` Audio 帧」分开：

1. **新采集模式（AI 助手流式语音）**：在 `amos-tauri` native 或 WebView 侧，把 mic 数据实时切成 **16k mono f32 帧**，经 `Chat` 客户端逐个 `Payload::Audio` 发；开麦先发 `AudioConfig`，松麦发 `AudioEnd`。
   - 复用同传已验证的采集规格（`InterpApp` 已是 16k mono）与权限门控（`CapabilityGate` mic，见 `docs` 的权限落地）。
2. **渲染分流**：收到带 `transcript` 的帧 → 灰色"正在识别：…"；收到 `token` 帧 → 追加进 AI 回复气泡。不混排。
3. **保留整段模式**：`VoiceMicButton`→`transcribeAudio` 的"录一段一次性转写"仍可用（文案区分"整段转写"与"流式对话语音"）。
4. **离线降级**：无 Tauri/无 daemon 时该入口降级（沿用现有 harness 对 backend 缺失的容错）。

> 说明：真机上的**原生采集**（AAudio/cpal，而非 WebView getUserMedia）属另一项（见 `FUNCTIONAL_GAP_ANALYSIS` §C / `docs/device-poc.md`）。本文只保证「wire 级 + 领域级」链路——契约、daemon ASR、桥接推送方式，使任一采集端接上即可用。

---

## 7. 配置 / feature / CI 影响

| 项 | 值 |
|---|---|
| `amos-ai` feature | 新增 `sherpa-asr`（可选 `amos-asr`）；**默认关闭**，默认行为/构建不变 |
| 运行时 | `AMOS_ASR_BACKEND=mock`（默认，确定性）/ `sherpa`（需 feature + `AMOS_SHERPA_MODEL_DIR`） |
| CI | 默认 `mock` → `lint-and-test` 不需 sherpa，保持绿；`sherpa-asr` 纳入现有 `gated-native-backends`（与 `amos-asr`/`amos-tts` 的 sherpa/Piper 同一道门，见 `Makefile` `gated-check`） |
| 回退 | `ChatAsr::from_env()` 返回 None（未配置）时，`Payload::Audio` 走现状诚实提示——不破坏老客户端 |

---

## 8. 测试策略

| 层 | 方式 | 判据 |
|---|---|---|
| `ChatAsr` 单测 | 喂 `MockStreamingRecognizer` 帧序列 | interim 递增、endpoint 后 finalize 出预期文本、reset 后可复用 |
| daemon 端到端（无头 UDS） | 起真实 server，客户端 bidi 发 `AudioConfig`+若干 Audio 帧+`AudioEnd`（用确定词表） | 先收到 `transcript` interim，再收到模型 `token` 到 `done`；token 计数正确、会话被 append |
| 取消路径 | 发帧中途发 `Cancel` | 立即终止，无孤儿推理、无非法状态 |
| 语义卡语音 | final 文本命中意图（如"放音乐"） | 走 `semantic::detect` 返回 `card`（与文本 Prompt 一致） |
| 兼容性 | 老客户端只发 Prompt | 与现状行为逐字节一致（Audio 分支不触发） |
| sherpa（feature） | `gated-native-backends` 用真模型跑一轮 | interim/final 非空、无 panic |

---

## 9. 边界与待拍板开放问题

**边界**：
- 单帧过大/空帧、非 16k mono、畸形 bytes → 报错帧或丢弃，不 panic（守 `P0-1` 门，见各 crate `deny(clippy::unwrap…)`）。
- `is_endpoint` 永不触发（用户不松麦无 VAD）→ 靠 `AudioEnd` 兜底；两者皆缺 → 静音超时（后续可加 `AMOS_VAD_TIMEOUT`）。
- 长句跨多帧中断（网络/进程）→ 会话态 `reset` 收敛，不卡死。

**开放问题**：
1. interim 回显频率：默认每 hypothesis 一条？还是限流（如 200ms）？建议后端节流避免刷屏。
2. `AudioEnd` 是否必须由客户端显式发，还是可仅靠 daemon VAD 定界（推荐**两者都要**，客户端定界更可靠）。
3. 转写文本的**语言**：`Hypothesis.lang` 现可带 `Language`；是否让模型回复跟随源语言（默认跟随）。
4. 真机生产最终走 A（daemon sherpa）还是 B（native sherpa 复用同传）——建议先在 A 上无头验证，再按耗电/带宽决定 B。

```

**依赖/feature**：
- `amos-ai` 增 `amos-asr = { path = "../amos-asr", optional = true }`，feature `sherpa-asr = ["dep:amos-asr", "amos-asr/sherpa"]`（与 `amos-tauri` 的命名一致）。
- 默认（无 feature）也内置 `MockStreamingRecognizer`（经 `amos-asr`），只是 `sherpa` 真模型需开 feature + `AMOS_SHERPA_MODEL_DIR`（同 `native-voice.md` 的同传参数）。

