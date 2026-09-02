# Amos 同声翻译 daemon（`amos-translate`）

独立的同声翻译 CLI 后端 daemon，与 AmOS 多 daemon 架构一致：gRPC over UDS、
可插拔模型后端、由 `amos-supervisor` 托管。

## 架构

```
[ System UI / amos-ai ]
        │  gRPC over UDS (translate.proto)
        ▼
[ amos-translate daemon ]
        │  TranslationProvider (trait)
        ├─ OllamaProvider (默认)  → Ollama /v1/chat/completions
        ├─ MockProvider (测试/离线)
        └─ (可扩展: Hermes / API)
        │  SpeechRecognizer (trait)  — Voice 按钮/音频段
        ├─ MockRecognizer (测试/离线)
        ├─ WhisperProvider → /v1/audio/transcriptions
        └─ (可扩展: 其它 ASR)
```

## 接口（`proto/translate.proto` → `package translate`）

| RPC | 类型 | 说明 |
|-----|------|------|
| `Translate` | unary | 单发文本翻译（可指定源/目标语言，空=用配置默认） |
| `Transcribe` | unary | 语音转写：音频字节 → 文本 + 是否识别（Voice 按钮核心） |
| `StreamTranslate` | bidi | 同传：客户端发文本段（或音频段，先经 ASR 转写），服务端逐段流回译文 |
| `GetStatus` | unary | 运行状态 / 模型 / 默认语言对 |

## 语音转写（ASR）

`src/asr.rs` 提供可插拔 `SpeechRecognizer`，由 `AMOS_ASR_BACKEND` 选择：

- `mock` — 确定性转写（离线 / 测试）
- `whisper` — `WhisperProvider`，调 OpenAI 兼容 `/v1/audio/transcriptions`
  （multipart 上传；配置 `AMOS_ASR_ENDPOINT` / `AMOS_ASR_MODEL` / `AMOS_ASR_API_KEY`）
- `none`（默认）— `Transcribe` 返回 `recognized=false`；流式音频段返回"[语音] …ASR 未接入"

未配置识别器时守护进程仍诚实应答；接入真实 ASR 只需实现 trait + 设置环境变量。

### System UI 集成

- `crates/amos-tauri/src/translate.rs`：`transcribe_audio` / `translate_text` 命令经 UDS 调本 daemon。
- 前端 `window.AmosVoice.transcribe(bytes)` / `.translate(text)`（无 Tauri 时优雅降级）。
- `deploy/daemons.json` 的 `amos-translate` 已配 `AMOS_ASR_BACKEND=mock`，开箱即可演示。
- **`crates/amos-translate/src/grpc_pipeline.rs`**：`amos_int::Pipeline` 的 gRPC 实现，
  用本 daemon 的 `StreamTranslate`（ASR）+ 一元 `Translate` 驱动 `amos_int::Session`，
  e2e 见 `tests/grpc_pipeline.rs`。

## 运行

```bash
# 启动（默认 Ollama 后端，模型 llama3.2）
AMOS_TRANSLATE_HOST=http://localhost:11434 \
AMOS_TRANSLATE_MODEL=llama3.2 \
cargo run -p amos-translate

# 覆盖 socket / 语言对 / 用 mock
AMOS_TRANSLATE_SOCKET=/tmp/tr.sock \
AMOS_TRANSLATE_SOURCE=en AMOS_TRANSLATE_TARGET=zh \
AMOS_TRANSLATE_BACKEND=mock \
cargo run -p amos-translate
```

## 用 `amos-supervisor` 托管

```rust
use amos_supervisor::{DaemonSpec, RestartPolicy, Supervisor};

let spec = DaemonSpec {
    name: "translate".into(),
    program: "amos-translate".into(),          // 或绝对路径
    args: vec!["--socket".into(), "/tmp/amos-translate.sock".into()],
    env: vec![
        ("AMOS_TRANSLATE_HOST".into(), "http://localhost:11434".into()),
        ("AMOS_TRANSLATE_TARGET".into(), "zh".into()),
    ],
    restart: RestartPolicy::default(),
};
let sup = Supervisor::new();
sup.start(spec).await?;
```

## 扩展新 provider

实现 `TranslationProvider` trait（`crates/amos-translate/src/provider.rs`）：
```rust
#[async_trait]
impl TranslationProvider for MyProvider {
    async fn translate(&self, text: &str, source: &str, target: &str) -> Result<String> { ... }
    fn metadata(&self) -> ProviderMeta { ... }
}
```
然后在 `provider_from_env()` 加一个分支即可，gRPC/传输层不变。

## 测试

- 单测：`parse_openai_content`、`build_prompt`、`MockProvider` 路由、`TranslatorService`
  （translate/回退语言/status/transcribe 有/无识别器）、`parse_whisper_text`、`build_multipart`
- e2e（`tests/translate_e2e.rs`）：真实 UDS 起 daemon（mock provider）→ tonic 客户端 →
  `Translate`/`StreamTranslate`/`GetStatus`，以及 `transcribe_over_uds_with_recognizer`
