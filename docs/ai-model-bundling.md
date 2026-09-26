# AI 模型打包与解析（bundled model resolution）

**范围**: 回答三个问题 —— daemon 的本地模型**从哪来**、**怎么解析**、**没有模型时会怎样**。
对应 Gap 4（`crates/amos-ai/src/bundled_model.rs`）与 Gap 8（`crates/amos-ai/src/chat_asr.rs`
的 ASR 模型目录链）。

> ⚠️ **前提诚实声明**：daemon **不再**在缺省情况下静默回退到 `MockBackend`。
> 没有 staged 模型时它如实报告 **`unconfigured`**（`UnconfiguredBackend`，`infer`/`health_check`
> 返回 typed 错误），并把原因写进日志。mock 只在**显式** `AMOS_BACKEND=mock` 或
> `#[cfg(test)]` 里出现。

---

## 1. 文本推理模型（GGUF）

### 1.1 解析链（`resolve_model_path`）

按优先级，**返回第一个真实存在、可读的文件**：

1. **`AMOS_MODEL_PATH`** —— 运维/现场覆盖，最高优先级。
   若设置了但**不存在**：记 `warn!` 并继续往下走（不是静默换一个文件）；
   `operator_env_path()` 会把原值**逐字**回显，让后续"模型文件找不到"的错误说的是**操作员的路径**。
2. **Bundled assets** —— `${AMOS_BUNDLE_ASSETS_DIR}/models/<file>`，然后是固定板端根：

   | 根目录 | 用途 |
   | --- | --- |
   | `/data/amos` | AOSP 镜像默认 staging 位 |
   | `/system/share/amos` | 只读系统分区 |
   | `/system/etc/amos` | 兜底 |

3. **用户安装** —— `$AMOS_USER_MODELS_DIR/<file>`，然后 `~/.amos/models/<file>`。

固定的 bundled 文件名：`qwen2.5-0.5b-q4_k_m.gguf`（相对路径 `models/qwen2.5-0.5b-q4_k_m.gguf`）。

`bundled_model_resolver()` 与 `resolve_model_path()` 的区别：前者面向"交给引擎的路径"，
操作员覆盖**即使不存在也返回**（typo 要报成"文件缺失"而不是悄悄换模型）；后者只返回
**确实存在**的文件，供 `unconfigured` 判定使用。

### 1.2 缺省后端链（`AMOS_BACKEND`）

| 取值 | 行为 |
| --- | --- |
| 未设置 / `auto` | 取决于编译期 `bundled-model` feature：**ON** → 调 `bundled_model_resolver()`，路径 `is_file()` 时起**真实 `ggml`**，否则 **`unconfigured`**；**OFF**（默认）→ 不做任何模型查找，直接 **`unconfigured`**。两种状态都**不**回退 mock |
| `mock` | 显式 mock（仅 dev/CI）；日志标注为 mock |
| `ggml` | 用 `bundled_model_resolver()` 的路径起 `ggml` |
| `rknn` / `llama-cpp`（含别名） | 构造 bring-up seam；失败 → `unconfigured` + `tracing::error!`，**不回退 mock**（见 `docs/rk3588-bringup.md`） |
| `ollama` / `hermes` 等 | 远端后端 |

`bundled-model` 是 `amos-ai` 的**编译期** feature，**默认关闭**（`crates/amos-ai/Cargo.toml`）。
它只控制"未设置 / `auto` 时要不要去找 bundled 模型"：关闭时该分支在**任何文件系统查找之前**
就返回 `unconfigured`，因此一个普通构建**永远不会**因为盘上恰好有模型而静默换成真实推理。
要交付带 bundled 模型的板端镜像，显式 `--features bundled-model`。运行时覆盖仍走
`AMOS_BACKEND=ggml`（用 `bundled_model_resolver()` 的路径）或 `AMOS_BACKEND=<远端>`。

### 1.3 输入边界

- `validate_model_path`：空白或超过 `MAX_MODEL_PATH_BYTES`(4096) → `None`（**绝不截断**成意外路径）。
- 每个 env 值都先过 bound + validate 才变成 `PathBuf`；模块**不会 panic**。
- 不读 CWD 相对路径（板端 CWD 可能可写，属安全风险）。

### 1.4 无模型时的行为（`unconfigured`）

`UnconfiguredBackend`：`name = "unconfigured"`、`max_context_length = 0`、
`supports_streaming = false`；`infer()` 与 `health_check()` 返回 `Err`，`get_stats()` 返回
"未知"（全 `Option::None`，**不伪造 0**）。`get_status` 会如实上报，
并在 `tracing::error!` 里指明去读本文。

---

## 2. 语音模型（sherpa ASR 目录）

`chat_asr` 的 `asr-sherpa` **默认开启**（`--no-default-features` 可关）。
`resolve_sherpa_model_dir()` 按序：

1. `AMOS_SHERPA_MODEL_DIR`（运维覆盖）；
2. `${AMOS_BUNDLE_RES_DIR}/sherpa` → `${AMOS_BUNDLE_MODELS_DIR}/sherpa`（AOSP 构建设置）；
3. `BUNDLED_SHERPA_DIRS`：`/data/amos/sherpa`、`/system/share/amos/sherpa`。

候选目录**只有含 `tokens.txt` 才算数**——仅仅"存在一个目录"不会被当成可用模型。
全部落空时 `default_asr()` **记 `error!` 并回退 mock**，且把后端**如实标注为 `"mock"`**
（`ChatAsr::backend_label()`），所以上层能看出来这不是真实识别。

`AMOS_ASR_BACKEND=off` 明确关闭；`=sherpa` 在未编译 `asr-sherpa` 时返回 `None`（不是 mock）。

---

## 3. 板端打包（AOSP 镜像）

镜像构建时把模型放到上面任一 bundled 根，并（可选）导出 `AMOS_BUNDLE_ASSETS_DIR` /
`AMOS_BUNDLE_RES_DIR`。大小与分区约束：

- GGUF 模型体积大，`/system` 只读分区放不下时走 `/data/amos`；
- 权限：daemon 进程需对该目录**可读**；
- 校验：镜像脚本应对模型做 checksum，避免半截文件被当成可用模型
  （`resolve_model_path` 只判 `is_file()`，不做内容校验）。

> 下载/拉取真实开发模型用 `bash scripts/fetch-models.sh`（见 `docs/local-models.md`）。

---

## 4. 门与验证

- **单测**：`cargo test -p amos-ai --lib bundled_model::` 与 `chat_asr::`。
  覆盖：env 覆盖优先、bundled 优先于用户目录、无模型 → `None`、超长/空白被忽略、
  ASR 目录链（含"目录存在但无 `tokens.txt`"的负向控制）。
- **诚实 smoke**：`bash scripts/ai-honesty-smoke.sh`。
- **device-only（本仓库未验证）**：板端 `/data/amos`、`/system/share/amos`、
  `/system/etc/amos` 的 staging、`AMOS_BUNDLE_ASSETS_DIR` 的实际取值、
  真实 GGUF / sherpa 模型加载。这些必须在设备镜像上验收。
