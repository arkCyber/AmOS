# AmOS 同声翻译应用：架构与落地路线

本文档是 **用 Rust + Tauri 重构 [sokuji](https://github.com/kizuna-ai-lab/sokuji)
（实时双向同声翻译）功能**的蓝图：先做代码分析，再给出与 AmOS 现有骨架的映射，
最后是分阶段落地路线。

---

## 1. sokuji 是什么（技术栈全貌）

sokuji 是一个成熟的双向实时同声翻译应用（v0.39，~3150 commits，**AGPL-3.0**）。
技术栈是 **Electron + React/TS + Python sidecar**，并非 Rust。

| 层 | 技术 | 职责 |
|----|------|------|
| **桌面壳** | Electron (`electron/main.js` + preload) | 窗口、单实例、原生音频采集、sidecar 生命周期、IPC |
| **渲染层** | React 19 + TS + Zustand + i18next | UI、Web Audio 采集/降噪/VAD、状态机、provider 配置 |
| **本地推理 sidecar** | **Python** (`sidecar/sokuji_sidecar/`) | ASR / 翻译 / TTS / 模型下载管理 / 硬件探测 —— **真正的"CLI daemon"** |
| **音频宿主** | C++(Win) / Swift(macOS) 短命 CLI (`native/audio-host/`) | 单应用音频环回采集（`--list`/`--target`，PCM 打 stdout，JSON 打 stderr）|
| **浏览器扩展** | Chrome/Edge MV3 | 会议平台采集 |

### sokuji 的守护进程模型（对 CLI 改写最关键）

- Electron 用 `NativeHostManager` **spawn Python sidecar**（`python -m sokuji_sidecar`），
  sidecar 在 `127.0.0.1:0` 绑一个 **WebSocket**，把端口**打印到 stdout 作为握手协议**，
  之后 stderr 进日志。有 90s 握手看门狗 + 崩溃快速失败。
- 前端 `SidecarConnection` 与之建立 **WS-RPC**：JSON 请求/响应带 **correlation id + 超时**；
  **二进制帧**传音频（ASR 输入、TTS 输出）；无 id 的**推送**传 `partial` 转写、下载进度、TTS 流式 chunk。
- `wire.py` 维护 `wire_schema.json`（出站消息契约）：严格模式下测试校验，生产 fail-open；
  前端用 `nativeProtocol.consistency.test.ts` 反向把 TS 接口钉在契约上。
  **这是最值得学习的一点：双向契约测试防漂移。**

## 2. sokuji 的架构精华（值得移植的设计）

1. **ProviderDescriptor 抽象**（`src/services/providers/`）——11 个 provider
   （OpenAI Realtime / Gemini / Soniox / Volcengine / Palabra / Zoom /
   OpenAI-compatible / Local / Kizuna…）统一成
   `getConfig()` / `createClient()` / `validateAndFetchModels()` / `buildSessionConfig()`，
   凭证归一化为 `Credentials`，UI 从不关心 provider 私有字段；`BothModePlan` 区分
   "单会话双向" 与 "双会话拆分"。
2. **会话状态机**（`stores/sessionStore.ts` + `audioStore.ts`）——采集 → VAD → 分段 →
   ASR 流式 `partial`/`result` → 翻译 → TTS → 播放/虚拟麦克风，全程可中断、可回滚。
3. **音频管线**（`lib/modern-audio/`）——Web Audio API + AudioWorklet：麦克风/系统环回/
   单应用（audio-host）/WebRTC 多路采集；GTCRN 降噪、VAD、回声消除、播放高亮。
4. **本地模型治理**（`sidecar`）——`catalog.py`（模型清单）+ `planner.py`（按硬件/内存
   挑量化档）+ 下载进度/校验/删除 + `hardware_info` 探测。
5. **契约测试文化**——前后端共享 schema 双向钉死。
## 3. 改写目标：Tauri + CLI —— 架构映射

关键结论：**不是从零写，而是把 sokuji 的领域设计（provider 抽象、会话状态机、音频/ASR
管线、协议契约）移植到 AmOS 已搭好的 Rust/Tauri 骨架里。**

| sokuji | AmOS 现状（已有） | 差距 |
|--------|------------------|------|
| Electron 壳 + preload | **Tauri**（`amos-tauri`） | ✅ 已用 Tauri 替代 |
| Python sidecar（CLI daemon, WS） | **Rust daemon**：`amos-translate`/`amos-ai`（gRPC over UDS）+ `amos-supervisor` 托管 | ✅ 用 gRPC/UDS 替代 WS |
| WS-RPC 协议 | **gRPC proto**（`amos-proto`）| ✅ 已有 `Translate`/`Transcribe`/`StreamTranslate` |
| ProviderDescriptor | `TranslationProvider` trait + `SpeechRecognizer` trait | 🟡 只有 mock/ollama/whisper-stub，缺云实时 provider |
| 会话状态机 / 分段 / 双向 | **`amos-int`（本仓库新增）**：`Session` 状态机 + `UtteranceBuilder` + `Pipeline` trait + `BothMode` | ✅ 领域核心已落地 |
| 音频采集/VAD/降噪 | ❌ 无 | 🔴 需新增（WebView 里 Web Audio 可行）|
| 流式 ASR（partial） | `amos-int` 已定义 `AsrEvent::Partial/Final` 语义；`amos-translate` 只有整段 `Transcribe` | 🟡 需接 sherpa-onnx-rust 做真实流式 |
| TTS | ❌ 无（`amos-int` 已定义 `Pipeline::synthesize`/`TtsRequest`）| 🟡 需 `TtsProvider` 实现（Piper/Edge-TTS/本地 ONNX）|
| 模型 catalog/planner | ❌ 无 | 🔴 可后置 |

### `amos-int` —— 同传会话引擎（首个高质量 crate）

`crates/amos-int` 把 sokuji 的领域核心抽成**传输无关**的纯 Rust 引擎，CLI daemon 和
Tauri UI 都只做薄适配：

```text
[ WebView / CLI ]  --SessionEvent-->  [ Session ]  --Pipeline trait-->  [ provider ]
                                        (amos-int)          \            ASR/translate/TTS
                                                             \___ InterpretationOutput (partials, segments, TtsRequest)
```

关键模块：

| 模块 | 内容 |
|------|------|
| `state.rs` | `SessionState`（Idle/Starting/Collecting/Interpreting/Speaking/Paused/Ended/Error）+ 校验过的状态迁移 |
| `segment.rs` | `Speaker`/`Segment`/`PartialSegment` + `UtteranceBuilder`（流式 partial → stable 前缀 → final）|
| `language.rs` | `Language`（BCP-47 + "auto" 哨兵）/ `LanguagePair::resolve`（自动检测钉定源语言）|
| `pipeline.rs` | `Pipeline` trait（feed_audio/translate/synthesize）+ `AsrEvent` + `MockPipeline`（确定性测试）|
| `session.rs` | `Session` 状态机：`handle(SessionEvent)` 进、`InterpretationOutput` 出（channel），自身零 I/O |
| `config.rs` | `SessionConfig`（语言对/说话人/TTS/自动检测）+ `BothMode`（shared/split/disabled）|
| `event.rs` | 输入/输出事件词汇表（唯一跨层耦合点）|

设计原则（对齐 sokuji 的长处）：
- **可插拔**：`Pipeline` trait 是一个 seam，换 provider 不动会话机/CLI/UI。
- **诚实状态机**：非法迁移直接拒绝，不静默损坏。
- **纯事件 I/O**：引擎不做任何网络/磁盘 I/O，可完全离线单测。
- **确定性 mock**：`MockPipeline` 让 CLI/daemon 集成测试不依赖真实模型。

### `GrpcPipeline` —— 把引擎接到真实 daemon（阶段 1）

`crates/amos-translate/src/grpc_pipeline.rs` 是 `Pipeline` 的 gRPC 实现，把
`amos-int::Session` 接到 `amos-translate` daemon（gRPC over UDS）：

- `feed_audio`：PCM → 经 `StreamTranslate` 音频路径做 ASR → 识别文本作为 `AsrEvent::Final`。
- `translate`：调用一元 `Translate` RPC（尊重源/目标语言）。
- `synthesize`：返回"TTS 暂不支持"（daemon 尚无 TTS）。

链路已跑通并被 e2e 覆盖：
`audio → daemon ASR → Session 状态机 → daemon translate → SegmentFinal`。

```bash
cargo test -p amos-translate --test grpc_pipeline   # 真实链路 e2e
```



### 全链路真机冒烟（headless）

`crates/amos-translate/tests/full_chain.rs` 无头跑通 System UI 同传 App 的完整链路
（无需显示器），与 `interpreter.js`（`AmosInterp.audio → partial → segment_final → 🔊 AmosTts`）一致：

```bash
cargo test -p amos-translate --test full_chain -- --nocapture
# [full-chain] partials = ["你","你好","你好，Amos"]
#              translated = "[译](zh->en)你好，Amos"
#              tts = 2880 samples @ 16000Hz
```

链路：`音频 PCM → AsrPipeline(本地流式 ASR: Partial/Final) → GrpcPipeline(amos-translate daemon: 翻译) → amos-tts(可播放 TtsAudio)`。

### 无头界面冒烟（GUI 逻辑）
前端测试（59）里已含同传 App 的**无头 UI 冒烟**：渲染 App → 模拟 `AmosInterp.onOutput`
partial/segment_final → 断言 partial 追加、译文段落含 🔊 朗读按钮、勾选自动朗读后每段译文被
`AmosTts.synthesize`。这样在无显示器环境也能"看到"界面层执行结果。

### 健壮性
- `GrpcPipeline.translate` 失败会 `invalidate` 缓存 → daemon 重启后自动重连（e2e 覆盖）。
- bidi 音频流读响应/打开均有超时（30s / 10s），daemon 卡死会报错而非永久挂起。
- `Session` 翻译失败自动重试一次（`SessionConfig.translate_retries`，默认 1）：短暂 daemon 抖动 /
  过期 channel（重连路径）被吸收，仅持续失败才进入 `Error`。`FlakyPipeline` 测试覆盖。

### CI / 冒烟入口
```bash
make test          # workspace + 前端
make lint          # fmt + clippy -D warnings
make smoke         # headless 端到端：int-cli-smoke.sh + full_chain
make gated-check   # (联网机器) 编译 sherpa/Piper 门控后端
```

### 可复现冒烟脚本（headless）
- `scripts/int-cli-smoke.sh`：起 mock daemon + 管道喂文本给 `amos-int-cli`，断言译文（文本同传端到端）。
- `scripts/gui-smoke.sh` / `gui-smoke-check.sh`：真机 GUI 冒烟 / headless 前置校验。

## 4. 分阶段落地路线

### 阶段 0：地基（已完成）
- ✅ `docs/interpretation-architecture.md`（本文档）。
- ✅ `crates/amos-int` 同传会话引擎（状态机 + 分段 + Pipeline 抽象 + BothMode），
  24 单测 + 1 集成测试，clippy 零告警。
- **可复用会话**：`Session::restart()` 让结束后的会话重新运行（重置分段计数/语言）；
  CLI `.restart` 命令、Tauri `interpret_restart`（复用同一 session id）、同传 App 结束再「▶ 开始」。

### sherpa 后端：本地验证说明（阶段 2 收尾）
`sherpa-onnx` crate 的构建脚本会**从 GitHub 下载预编译静态库**；在无外网的构建沙箱里
会失败（`SOCKS feature disabled`）。因此 `SherpaOnlineRecognizer` 以 `sherpa` feature 门控，
默认构建不受影响。**在可联网或设置了 `SHERPA_ONNX_LIB_DIR` 的环境**执行：

```bash
cargo build -p amos-asr --features sherpa    # 下载并链接 sherpa-onnx 预编译库
```
然后用真实流式模型（zipformer/transducer：tokens.txt + encoder/decoder/joiner .onnx）配置
`SherpaOnlineRecognizerConfig`，并校准各 `*Config` 字段名（按 sherpa-onnx 1.13.7 文档）。
本仓库已按文档 API 编写该模块；建议本地 `--features sherpa` 构建做一次字段校准。

### 阶段 1：MVP —— 文本同传打通（1–2 周）
- ✅ **`GrpcPipeline`**（`amos-translate/src/grpc_pipeline.rs`）：`Pipeline` 的 gRPC 实现，
  用 `StreamTranslate` 音频路径做 ASR + 一元 `Translate` RPC 做翻译；e2e 已跑通
  `audio → daemon ASR → Session → daemon translate → SegmentFinal`。
- ✅ **`amos-int-cli`**（`crates/amos-int-cli`）：文本同传 CLI。stdin 进文本、译文出，
  点命令控制会话（`.lang`/`.status`/`.pause`/`.resume`/`.stop`/`.quit`）。
  行处理核心 `exec_line` 用 `MockPipeline` 可单测；冒烟测试已跑通真实 daemon。
- ✅ **Tauri 桥接**（`crates/amos-tauri/src/interpret.rs`）：`interpret_*` 命令
  （start/text/audio/end_of_speech/pause/resume/stop/abort/status）+ `interpret-output`
  事件；前端 `window.AmosInterp` 封装 + main.js 监听。System UI 可开同传会话。

### 阶段 2：真 ASR（流式，2–3 周）
- ✅ **`amos-asr`**（`crates/amos-asr`）：流式识别框架。
  - `StreamingRecognizer` trait（reset/push_samples/is_endpoint/finalize）+ 确定性 `MockStreamingRecognizer`。
  - `AsrPipeline`：把识别器接到 `amos_int::Pipeline`，`feed_audio` 产出真实 `AsrEvent::Partial/Final`；
    可组合 translate 委托（如 `GrpcPipeline`），实现"本地流式 ASR + 远端翻译"。
  - `SherpaOnlineRecognizer`（feature `sherpa`）：sherpa-onnx `OnlineRecognizer` 后端，产出增量 partial + endpoint。
- 🟡 真实 ASR 模型接入：需网络下载 sherpa-onnx 预编译库 + 模型文件（沙箱受限，见下）。

### 阶段 3：TTS + 播放（2 周）
- ✅ **`amos-tts`**（`crates/amos-tts`）：`TtsProvider` trait（`synthesize(text, lang) -> TtsAudio`）
  + 确定性 `MockTtsProvider` + `PiperProvider`（feature `piper`，本地 Piper 模型）。
- ✅ **Tauri 桥接**：`tts_synthesize` 命令 + 托管 `TtsProvider`；前端 `window.AmosTts.synthesize()` 拿
  PCM → Web Audio 播放（`playPcm`）。`TtsRequest` 可落地为可播放音频。

### 阶段 5（前置）：System UI 同传 App
- ✅ **`frontend/js/apps/interpreter.js`**（同传 App）：
  - 会话控制（开始/暂停/继续/结束）+ 语言选择
  - 麦克风采集（`getUserMedia` → 16k mono f32 → `AmosInterp.audio` 流式喂入）+ 键入文本（`AmosInterp.text`）
  - 渲染实时 partial + 翻译后的 final，`🔊 朗读` 调 `AmosTts` 播放
  - `onMount` 接管 `AmosInterp.onOutput`，`onUnmount` 恢复；已加入 dock

### 阶段 4：云实时 provider（2–3 周，可选但价值高）
- 把 `ProviderDescriptor` 移植成 Rust trait + 配置：OpenAI Realtime、Gemini 等。
- 复用 `BothMode`：单会话双向 vs 双会话拆分。

### 阶段 5：完整产品化
- 字幕浮层窗口（Tauri 多窗口仿 sokuji `subtitle-window`）。
- 本地模型 catalog + 按硬件选量化档（抄 `catalog.py`/`planner.py` 设计到 Rust）。
- Chrome MV3 扩展（可后置）。

## 5. 关键风险与建议

1. **许可证**：sokuji 是 **AGPL-3.0**。若要闭源/商用，**不能直接搬源码**，只能借鉴
   "设计/接口形状"，全部重写实现。AmOS 的 `amos-int` 是本仓库自研实现，不依赖 sokuji 代码。
2. **音频采集是最硬的部分**：Electron 有成熟系统音频环回，Tauri 没有内置。方案：WebView
   里 `getUserMedia`/`getDisplayMedia`（覆盖大部分场景）+ 平台原生小工具（仿 audio-host 的
   CLI 模式）。**先做麦克风直采，再做环回/虚拟麦克风。**
3. **不要为移植而移植**：sokuji 的 WS + Python sidecar 是为 Electron 服务的；AmOS 用
   gRPC/UDS + Rust 更合适。**保留现有栈，只搬领域设计。**
4. **分层复用 AmOS**：`amos-supervisor`（守护编排）、`amos-proto`（契约）、
   `TranslationProvider`/`SpeechRecognizer`（可插拔）、`amos-int`（领域核心）已指向目标形状——
   **让它们长全，而不是另起炉灶。**

## 6. 质量门禁

```bash
cargo test -p amos-int                 # 领域引擎测试
cargo clippy --workspace --all-targets # 零告警
cargo test --workspace                 # 全仓回归
```

新增 crate 遵循：纯领域逻辑（零外部 I/O）、确定性 mock、非法状态拒绝、
`Pipeline` 单一 seam、契约测试防漂移。
