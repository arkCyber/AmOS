# Audio HAL Bridge — hardware-level duplex audio → 本地 ASR

把语音从"纯文本 mock"推到 **真正能跑**：AOSP 硬件音频（AudioFlinger / Audio HAL，
经 TinyALSA/AAudio）→ 麦克风 PCM → 本地流式 ASR（sherpa）→ bidi `Chat` 的
`Payload::Audio` → 本地推理。

> 范围说明：这是第 1 个断层（Audio HAL Bridge）的落地。**它不等于**已经能在真机
> 拦截 SIM 通话语音做同传——通话/语音流拦截属于系统级（需对应 HAL/DSP 音频路由
> 钩子），代码里已留好 seam 与说明，见 §设备 seam。

## 现状（改动前）

- `amos-ai` 的 bidi `Payload::Audio` 分支只接 `MockStreamingRecognizer`
  （`chat_asr.rs`），没有真 ASR。
- 全仓没有任何 AOSP 原生采集绑定（文档里的 `cpal/AAudio/TinyALSA` 都是"待接"）。
- `amos-asr` 已有可消费真实 16 kHz f32 PCM 的 sherpa 后端，但没被接进 bidi。

## 新增：`crates/amos-audio`（纯 std 音频抽象层）

```text
[ TinyALSA / AAudio ]            [ TinyALSA / AAudio ]
      read() ▼                             ▲ write()
┌─────────────────────────────────────────────────────────┐
│  AudioCapture trait            AudioSink trait            │
│  (mono f32, 任意设备采样率)                              │
│  LinearDownsampler  device ──▶ 16 kHz ASR                 │
│  Mock: SineMic / FrameMic / SilenceMic / MockSink / NullSink │
└─────────────────────────────────────────────────────────┘
         │ Payload::Audio (mono 16k f32le bytes)
         ▼
   amos-ai bidi Chat ──▶ sherpa 本地 ASR（feature asr-sherpa）
```

- `spec`：`AudioSpec`、`ASR_SAMPLE_RATE=16k`、i16↔f32、多声道降混、f32-le 编码。
- `capture` / `sink`：`AudioCapture`（pull `read`）/ `AudioSink`（push `write`）trait，
  单调 f32，`for_each` 便于直接把麦推到识别器。
- `resample`：流式 `LinearDownsampler`（下采样，跨 chunk 相位连续）；`resample_linear`
  一次性任意比例。设备能直接开 16 kHz 时跳过。
- `mock`：确定性、离线，供测试/CI/demo（与真机 seam 同 contract）。
- `android`（设备 seam）：按 `target_os="android"` + feature 门控的**手写直接 FFI**
  绑定——`tinyalsa`（AOSP 系统侧 / 通话语音流位置）与 `aaudio`（app 侧实时听麦）。
  宿主不编译、不链接，默认工作区保持轻。

## amos-ai bidi 接真 ASR

- `amos-ai/Cargo.toml` 新增 feature：`asr-sherpa = ["amos-asr/sherpa"]`（默认关闭）。
- `chat_asr.rs`：`ChatAsr::from_env` 按 `AMOS_ASR_BACKEND` 选择后端；
  `sherpa` 需 `asr-sherpa` feature + `AMOS_SHERPA_MODEL_DIR`（文件名约定与
  `amos-tauri/src/interpret.rs` 一致）。未配置 → 明确告警并回退 `None`
  （诚实"语音未配置"），绝不静默降级到 mock。
- bidi e2e：`amos-ai/tests/bidi_sherpa_audio.rs`（feature `asr-sherpa` 门控）——
  把 `models/sherpa-en-20m/test_wavs/0.wav` 的真实语音 PCM 以 `Payload::Audio`
  帧喂进 daemon，断言识别结果（"YELLOW…"）被真实 sherpa 转写并作答。

## 验证命令

```bash
# 核心（host，默认 feature，轻且绿）
cargo test -p amos-audio
cargo run -p amos-audio --example mic_to_asr
# host 上开启全部 feature 仍不触碰 android seam（被 cfg 完全隔离）
cargo build -p amos-audio --all-features

# amos-ai 默认（mock 语音）测试
cargo test -p amos-ai
# 真 ASR：feature + 模型目录
cargo test -p amos-ai --features asr-sherpa --lib
cargo test -p amos-ai --features asr-sherpa --test bidi_sherpa_audio
# lint（两种 feature 配置）
cargo clippy -p amos-audio --all-targets
cargo clippy -p amos-ai --all-targets
cargo clippy -p amos-ai --features asr-sherpa --all-targets
```

## 设备 seam（Android/NDK）说明

`android/` 模块仅在 `--target <android>` + 对应 feature 时编译：
```bash
cargo build -p amos-audio --features tinyalsa --target aarch64-linux-android --release
cargo build -p amos-audio --features aaudio  --target aarch64-linux-android --release
```
- `TinyAlsaCapture/Sink`：绑 `libtinyalsa` PCM（card 0 / device 0）。普通 app 无法直开
  `/dev/snd`；它面向 AOSP 系统组件 / 通话语音流位置（仍需 HAL 路由钩子才能拦通话）。
- `AAudioCapture/Sink`：绑 NDK `libaaudio`，app 侧实时听麦的可行路径（AI 助手常驻监听用）。
- 这两个模块是手写 `extern`（无 bindgen/三方原生依赖），需在 NDK 交叉构建与真机
  bring-up 时编译/联调；CI 的 Linux/macOS host 只保证其余 crate。

## System UI 侧：常驻听麦流式推送（2026-09-04）

把采集真正接到 System UI/daemon 的流式链路（`amos-tauri/src/assistant_voice.rs`）：

```text
[ mic (AAudio / mock) ]          amos-ai daemon
  AudioCapture.read()              │ Chat(bidi, Payload::Audio)
  → LinearDownsampler 48k→16k      ▼
  → encode_f32_le               ChatAsr → local ASR → infer
  → ── Payload::Audio ─────────▶   │ AgentChunk(回复 token / done)
  ◀─ VoiceEvent ───────────────┘   → WebView `assistant-voice-event`
```

- `VoiceLink`（Tauri-free 核心）：开一条**长驻** bidi `Chat`（不推 Prompt），可跨多轮
  应答持续复用；`feed_bytes` 逐帧推 16 kHz f32-le `Payload::Audio`，读取端把
  `AgentChunk` 转成 `VoiceEvent`（Listening/Token/TurnDone/Stopped/Error）。
- **Push-to-talk 松手成句**：`ClientMessage` 新增 `Payload::AudioEnd`；`ChatAsr::finish()`
  强制成句并 reset；daemon `Chat` 对 `AudioEnd` 把已识别内容转成 prompt（语义卡/推理/审计/历史复用）；
  客户端 `VoiceLink::finish_turn()` / Tauri `assistant_voice_end` / TS `assistantVoiceEnd()` 暴露。
  UDS e2e：喂一段**不足 endpoint** 的语音再发 `AudioEnd` → 仍被作答。
- Tauri 命令 `assistant_voice_start/feed/end/stop`（受管 `VoiceSession`），事件以
  `assistant-voice-event` 发给 WebView。
- headless e2e `tests/assistant_voice_e2e.rs`：真 daemon(mock ASR) + `amos-audio`
  48 kHz 正弦麦 → 下采样 16k → f32-le → `Payload::Audio` 推送 → 断言"你好，Amos"被识别并作答。
- **常驻多轮**（energy-gated `AudioEnd`）：`has_signal` 能量门做本地切句；同一条流上
  两段语音各在尾静音门处 `AudioEnd` → 断言**两轮都被作答**
  （`resident_stream_answers_multiple_successive_utterances`）。这是设备 AAudio
  采集线程将喂进的客户端切句循环。
- **正式 resident 采集线程**：`spawn_resident_capture` / `VoiceLink::spawn_resident`
  在命名线程上读 `amos_audio::AudioCapture` → 16k 下采样 → 推 `Payload::Audio` →
  尾静音门 `AudioEnd`；`ResidentVoiceHandle`（`stop()` join、`submitted()` 计数）。
  设备 AAudio seam 只需把 `AAudioCapture::open(16000)` 传入。已纳入 `gated-check`
  （`cargo test -p amos-tauri --test assistant_voice_e2e`）。
- 前端（打通桥层）：`lib/audio.ts` `encodeF32le`/`frameToAssistantChunk`，
  `lib/voice.ts` `pcmToAssistantChunk`/`parseVoiceEvent`，`lib/backend.ts`
  `assistantVoiceStart/Feed/End/Stop`；`voice.test.ts` 新增单测。

## 下一步（超出本次）

- 通话/SIM 语音流实时同传拦截：系统级 audio route / 双工 tap + `TinyAlsa` 设备 seam +
  `amos-translate` 同传管线（仍缺特权音频访问与 HAL 钩子）。
- 在 AI 应用 UI 上落一个"常驻听麦"控件：`VoiceMicButton` 改用
  `assistantVoiceStart/Feed/End` 流式推 `Payload::Audio`（替代整段 WAV `transcribe_audio`），
  并订阅 `assistant-voice-event` 渲染中间/最终回复。
- 设备 AAudio 采集线程（`amos-audio`）真正喂进 `assistant_voice_feed`。
- 逐句语义卡等 UI 中间态（`AudioEnd` 的 wire 语义已落地）。
