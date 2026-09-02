# 本地推理模型（sherpa ASR / Piper TTS）

下载并运行**真实本地识别/合成**的说明。模型文件体积大，统一放 `models/`（已 gitignore），
用脚本一次性拉取：

```bash
bash scripts/fetch-models.sh
```

脚本**串行 + 重试**下载（避免并行/后台截断大文件导致 onnxruntime 加载报错）。

## ASR：sherpa-onnx 流式 zipformer（英文, int8）

- **仓库**：`csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17`
- **文件**：`tokens.txt` + `encoder/decoder/joiner-*-int8.onnx`（int8 更小更快）
- 自带 `test_wavs/0.wav` + `trans.txt`（真实英文语音与参考转录）

运行真实流式识别（feature `sherpa`）：

```bash
# 直接流式识别一个 WAV（打印流式 partial → FINAL）
cargo run -p amos-asr --example sherpa_asr --features sherpa -- \
    models/sherpa-en-20m/test_wavs/0.wav

# 把真实 sherpa ASR 喂进 amos Session（System UI 的接线模式）
# sherpa_pipeline(cfg, translate) 组合 本地流式 ASR + 翻译委托；
# EndOfSpeech 会 flush 识别器 → 产出已翻译的 SegmentFinal。
cargo run -p amos-asr --example sherpa_session --features sherpa -- \
    models/sherpa-en-20m/test_wavs/0.wav
```

输出示例（流式 partial → FINAL）：
```
  [partial] THE YELLOW LA
  [partial] THE YELLOW LAMPS
  …（随音频逐块增长）
FINAL: THE YELLOW LAMPS WOULD LIGHT UP HERE AND THERE THE SQUALID QUARTER
```

> 参考转录（`trans.txt` 0.wav 行）：`AFTER EARLY NIGHTFALL THE YELLOW LAMPS …`。
> harness 从固定 400ms 块喂入，首段捕获点有偏移，但识别为真实推理结果。

要点：
- sherpa-onnx 构建脚本会下载**预编译静态库**（联网；离线设 `SHERPA_ONNX_LIB_DIR`）。
- 沙箱内若 `ALL_PROXY=socks5` 会报 "SOCKS feature disabled"——用
  `env -u ALL_PROXY -u all_proxy cargo run …` 走 HTTP 代理。
- 流式解码需喂入足够缓冲（`chunk`≈400ms），10ms 一帧太碎会丢结果。

## TTS：Piper（英文 medium）

- **仓库**：`rhasspy/piper-voices`，`en/en_US/lessac/medium/en_US-lessac-medium.{onnx,onnx.json}`
- 运行需 **espeak-ng**（`text_to_phonemes`）：`brew install espeak-ng`；
  onnxruntime 由 `piper-rs`(ort) 使用（本机已有 `/opt/homebrew/lib/libonnxruntime.dylib`）。

`amos-tts` 的 `PiperProvider` 已按 piper-rs 0.2 真实 API 校准：
`Piper::new(model, config)` + `create(&mut self, text, …) -> (Vec<f32>, u32)`。

## 闭环建议

下载 Piper 英文音色 + 用 TTS 合成一句话存 WAV，再喂给上面的 sherpa ASR ——
在无麦克风的机器上即可闭环验证「文本 → 语音 → 文本」。

已实测（macOS，本地无外网时用 `env -u ALL_PROXY -u all_proxy` 走 HTTP 代理）：

```bash
# ① Piper 真实合成（需 espeak-ng；low 音色 ~63MB）
brew install espeak-ng
bash scripts/fetch-models.sh   # 或手动下载 en_US-lessac-low.{onnx,onnx.json} 到 models/piper-low/
cargo run -p amos-tts --example piper_tts --features piper -- \
    'This is a real test.' models/piper-low/en_US-lessac-low.onnx \
    models/piper-low/en_US-lessac-low.onnx.json /tmp/piper_out.wav
# → synthesized 43520 samples @ 16000Hz -> /tmp/piper_out.wav (2.7s)

# ② sherpa 识别合成音频（文本→语音→文本）
cargo run -p amos-asr --example sherpa_asr --features sherpa -- /tmp/piper_out.wav
# （harness 按 400ms 块喂入 + 单次 finalize，首尾略有截断；识别为真实推理）
```

> 诊断备忘：
> - Piper/`say` 生成的音频均为 16k 单声道 16-bit，sherpa 可直接消费。
> - sherpa streaming 逐块喂入需 ≥ 少量缓冲才出字；结尾建议补一段尾静音让解码器 flush。
> - 并行/后台下载大文件可能截断（onnxruntime 加载报 `cannot catch foreign exceptions`），务必串行 + 校验大小。

# 把真实本地 ASR 接进 amos-tauri 的 WebView（feature `sherpa-asr`）

`amos-tauri` 提供可选 feature `sherpa-asr`（门控 + 编译 sherpa-onnx 原生库）。
开启时 `interpret_start` 会自动用**本地 sherpa 流式 ASR**（经 daemon 翻译委托）代替 daemon 的 mock ASR，
其余（`interpret_feed_audio`/事件流/落库）完全不变。

构建并运行（需先用 `bash scripts/fetch-models.sh` 下载模型）：

```bash
AMOS_SHERPA_MODEL_DIR=$PWD/models/sherpa-en-20m \
  cargo tauri dev --features sherpa-asr        # 或 cargo run -p amos-tauri --features sherpa-asr
```

- 未设 `AMOS_SHERPA_MODEL_DIR`、或目录里缺标准模型文件（`tokens.txt` + `encoder/decoder/joiner-epoch-99-avg-1.int8.onnx`）→ `interpret_start` 回退 daemon（默认行为不变）。
- 模型目录可用 `env SHERPA_MODEL_DIR`（ASR 示例）或 `AMOS_SHERPA_MODEL_DIR`（GUI）覆盖。
- CI / 默认构建不带此 feature，原生库只在显式开启时链接。

# 把真实本地 TTS 接进 amos-tauri 的 WebView（feature `piper-tts`）

对称地，`amos-tauri` 可选 feature `piper-tts`（开启 `amos-tts/piper`，链接 piper-rs/onnxruntime/espeak-ng）。
开启时 `tts_synthesize` 会经 `TtsBridge` 自动选用**本地 Piper 音色**（默认 mock 不变）：
启动时读 `AMOS_PIPER_MODEL_DIR`（内含 `en_US-lessac-low.onnx` + `.onnx.json`），模型缺失/加载失败回退 mock。

```bash
AMOS_SHERPA_MODEL_DIR=$PWD/models/sherpa-en-20m \
AMOS_PIPER_MODEL_DIR=$PWD/models/piper-low \
  cargo tauri dev --features sherpa-asr,piper-tts    # 本地 ASR + 本地 TTS 同时启用
```

两个 feature 可单独或一起开启；`make gated-check` 已编译二者组合（同 binary 链接 sherpa+piper，
macOS 会见到 espeak `duplicate symbol` 的**非致命** linker warning，退出码 0）。

## CI

`sherpa`/`piper` 为 feature 门控后端，`make gated-check`（CI `gated-native-backends` job）
编译 lib + 示例（`sherpa_asr` / `sherpa_session` / `piper_tts`）+ amos-tauri 桥接组合；真实推理需要模型文件，
不在 CI 覆盖范围。示例均标注 `required-features`，默认构建不受影响。
