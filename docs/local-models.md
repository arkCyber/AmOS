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
cargo run -p amos-asr --example sherpa_asr --features sherpa -- \
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

## CI

`sherpa`/`piper` 为 feature 门控后端，`make gated-check`（CI `gated-native-backends` job）
只做编译；真实推理需要模型文件，不在 CI 覆盖范围。
