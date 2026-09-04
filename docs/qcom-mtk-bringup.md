# QCOM / MTK 真机 bring-up：推理加速 + 语音闭环 落地骨架

**日期**: 2026-09-04
**范围**: 让 AI 能力在 **Qualcomm (Snapdragon)** 与 **MediaTek (Dimensity)** Android
设备上"真落地"的接线骨架 —— 既有的外部 `allama` 子进程 GGML 路径、`Config.enable_acceleration`
死开关、以及语音采集→本地 ASR→推理链路中尚未接上**真机 silicon** 的部分。

> ⚠️ **前提诚实声明**：真机 NPU/GPU 驱动（QNN/NeuroPilot/AAudio）**必须**在装有对应
> 芯片 + NDK/SDK 的真机上编译、运行才能端到端验收。本仓库能保证的是：**host 可编译、
> feature/`target_os` 门控、单测绿** 的 seam 与判定清单。不把"能编译"当"已接通"。

---

## 0. 底座与总路线

- 真机产品本体 = **no-UI Android 基座**（`docs/no-ui-android.md`）；`amos-ai` 进
  `/system/bin`，System UI = Tauri launcher APK（持 `Context`）。
- **推理路线（推荐、可在两平台统一）**：
  1. 先 **aarch64 CPU（llama.cpp/Ollama）** 通 —— 两平台同一套，先验证链路；
  2. 再 **NNAPI / Vulkan**（两平台共通的加速路径，代码已预留）；
  3. 最后 **厂商 NPU SDK**（Qualcomm QNN · MediaTek NeuroPilot），feature 门控，需 OEM 提供 SDK。
- **语音路线**：AAudio 真采集（app 侧实时听麦）→ sherpa 本地流式 ASR（`amos-asr`，feature
  `asr-sherpa`）→ bidi `Payload::Audio` → 本地推理。见 `docs/audio-hal-bridge.md`。

---

## 1. 本次新增的代码 seam（本仓库内已完成、可 host 验证）

### 1.1 加速器域 `crates/amos-ai/src/accelerator.rs`（新，纯 std）

把曾经是死开关的 `Config.enable_acceleration` / NPU 叙事变成**可解析、可如实上报**的芯片画像：

- `SoCVendor::{Qualcomm, MediaTek, GenericAndroid, Host}` + `detect()`：
  `AMOS_SOC_VENDOR=qualcomm|mediatek|generic` 可覆盖（bring-up/cross 用）；非 Android host
  如实报 `Host`，**不猜测**厂商。
- `Accel::{Auto, Cpu, Vulkan, Metal, Nnapi, Qnn, NeuroPilot, Off}` + `AccelProfile`：
  `AMOS_ACCEL=auto|cpu|vulkan|metal|nnapi|qnn|neuropilot|off`。
- `AccelProfile::effective()/resolve()/label()/n_gpu_layers()/llama_args()/ollama_hint()`：
  - `auto` + Android → **NNAPI**（Qualcomm/MediaTek 共通 NPU 路径）；macOS host → Metal；其余 host → CPU。
  - 未 `--features qnn/neuropilot` 编译时请求 QNN/NeuroPilot → 如实降级 CPU 并给出 reason（`compiled_in()`）。
  - `resolve()` 返回 `(effective, reason_opt)`，从不说谎（`auto` 永远解析成具体值）。
- daemon 启动时在 `server.rs::build_backend_from_env()` 打日志：`vendor`/`accel`/`llama_layers`，
  或"accelerator downgraded: <reason>"。
- **如实上报**：`get_status` 现返回 `StatusReply.accelerator`（字段 15），且 System UI（Settings
  的 AI engine-truth 区）把它渲染出来——仅当**本地 ggml 引擎在服务**时报 `<vendor>/<accel>`
  （如 `android/nnapi` / `qualcomm/qnn`）；mock/远端后端为空。不再是只写日志或硬编码
  `gpu_util=0` 占位（见 `server.rs::EngineState` 与 `amos-tauri/src/ai_bridge.rs::DaemonStatus`、
  `frontend-ts aiEngine.ts`）。

### 1.2 本地 GGML 引擎的"诚实"开关（`inference/real.rs`）

- 新增 `AMOS_GGML_STRICT=1`：真实部署里 GGML/模型不可用 → **直接报错**，不再静默回落 mock。
- 默认 `off`（保住 `crates/amos-tauri/tests/ggml_command_e2e.rs` 的离线回落与 CI）。
- `mock` 应答仍带 `[amos-ai]` 签名（本来就可辨识）；strict 则是把"离线也能跑"与"真推理"
  的边界从"静默"提升为"显式报错"。

### 1.3 本地引擎真正消费加速器画像（闭环，`inference/real.rs`）

上一轮的 `AccelProfile` 不再只是"日志里的画像"，而是**真正驱动本地 GGML 引擎的 offload**：

- `GgmlBackend` 新增字段 `accel` 与构造器 `GgmlBackend::with_accel(path, profile)`
  （`new(path)` 保持默认＝ `AccelProfile::from_env()`，向后兼容）；daemon 的
  `BackendKind::Ggml::build()` 把启动时解析的那个 profile 传给引擎。
- 引擎命令参数抽成纯函数 `engine_argv(...)`（可单测）：
  - 默认 **`allama`** → 保持 `allama run <run> -p <prompt> --nowordwrap`，**不注入** llama.cpp
    专属参数（`allama` 自行管理 offload），不破坏 `ggml_command_e2e`。
  - **`AMOS_GGML_BIN` 指向 llama.cpp-class CLI**（如 `llama-cli`）→
    `-m <model> -p <prompt> -n <max>` **＋ `engine_offload_args(bin, accel)`**：
    CPU → 显式 `--n-gpu-layers 0`（防残留 GPU 默认）；加速 → `--n-gpu-layers <N>`
    （`N`＝ `AccelProfile::n_gpu_layers()`，默认全量 999，`AMOS_GPU_LAYERS` 可覆盖）。
- `engine_offload_args`/`engine_argv` 纯函数均有单测（allama 不变形、llama-cli 携带
  model/prompt/max_tokens/offload、CPU 显式归零）。

---

## 2. 接线点（device bring-up 时在真机执行）

> 每条都照 §0 底座：先 host 交叉编译门禁（`make gated-check`），再真机事实验收。

### 2.1 CPU 本地 LLM 先通（两平台统一）
```bash
# 设备上放一个 GGUF（先在真机用 ollama pull 或 llama.cpp 转换）
export AMOS_BACKEND=ggml
export AMOS_MODEL_PATH=/data/amos/models/qwen2.5:0.5b.gguf
export AMOS_GGML_MODEL=qwen2.5
export AMOS_GGML_STRICT=1      # 真实部署：宁可报错也不假装真推理
# 或用 on-device Ollama（内部就是 llama.cpp）：AMOS_BACKEND=ollama
```
**验收**：`chat_once`/UDS 回复**不带** `[amos-ai]` mock 签名；`get_status` 报 `engine` 为真实引擎。

### 2.2 加速器画像 → 本地引擎 offload（两平台）
```bash
# 真机设置 SOC 厂商（无则 daemon 报 android 而非具体 OEM，诚实）
export AMOS_SOC_VENDOR=qualcomm   # 或 mediatek
export AMOS_ACCEL=auto            # android → nnapi（共通 NPU）；想跑 GPU 用 vulkan
export AMOS_GPU_LAYERS=999        # 全量 offload；cpu 则自动 0
# 想让本地引擎真正吃到 offload：把 AMOS_GGML_BIN 指向 llama.cpp-class CLI（非默认 allama）
export AMOS_BACKEND=ggml
export AMOS_GGML_BIN=llama-cli     # 或设备上的 llama.cpp 可执行文件
```
**验收**：
- daemon 日志出现 `local-inference accelerator profile`，含
  `accel=nnapi vendor=qualcomm llama_layers=999`；请求 QNN/NeuroPilot 而未带对应 feature 时
  日志为 `accelerator downgraded: SDK not linked (…)` —— **不伪造 NPU 已用**。
- `AMOS_GGML_BIN=llama-cli` 时，实际推理命令含 `-m <model> … --n-gpu-layers 999`
  （可用 `strace`/日志/调试确认）；`AMOS_ACCEL=cpu` 时显式 `--n-gpu-layers 0`。
- 仍用默认 `allama` 时命令保持 `allama run …`（不注入 llama.cpp 参数），行为不变。

### 2.3 语音闭环（真采集 → sherpa → 推理）
- `crates/amos-audio` 的 **AAudio** seam（`target_os="android"` + `--features aaudio`）：
  把 `AAudioCapture::open(16000)` 交给 `amos-tauri/src/assistant_voice.rs` 的
  `VoiceLink::spawn_resident` / resident 采集线程（`docs/audio-hal-bridge.md` §"System UI 侧"）。
- `amos-ai` 需带 `--features asr-sherpa` + `AMOS_SHERPA_MODEL_DIR` 指向真模型（`scripts/fetch-models.sh`）。
- System UI AI 对话"按住说话"→ 流式 `Payload::Audio` → sherpa 转写 → 本地推理 → 回读。

**验收**：对着真机麦克风说话，AI 助手**以真实语音转录作答**（非文本手输）；`get_status`
`asr` 报 `sherpa`（非 mock）；无模型/未配 feature 时报"voice not configured"，绝不静默。

### 2.4 厂商 NPU（可选，需 OEM SDK）
- Qualcomm：`--features qnn`，接 QNN/SNPE 的离线编译→HTP 运行时（`docs/` 另述 OEM 集成）。
- MediaTek：`--features neuropilot`，接 NeuroPilot/联发科 NN 加速。
- 说明：`accelerator.rs` 只在编译进对应 feature 时 `compiled_in()` 为真，避免在未接入 SDK
  时把 NPU 当"已用"上报。

---

## 3. host 可验证的验收判据（本机即可跑）

```bash
cargo test -p amos-ai --lib              # 含 accelerator + ggml_strict + engine_argv/offload 单测（全绿）
cargo test -p amos-ai --features qnn,neuropilot --lib accelerator::   # feature 门控分支
cargo clippy -p amos-ai --all-targets --features qnn,neuropilot -- -D warnings
cargo fmt -p amos-ai -- --check
```

---

## 4. 与既有文档/判定衔接
- `FUNCTIONAL_GAP_ANALYSIS.md` §三.A 的"GGML 无进程内 C 绑定 / GPU-NPU 加速无实现"：
  本次把 **外部引擎的诚实边界**（strict）与 **加速器画像/解析 seam** 落地；真正
  进程内 llama.cpp C 绑定与厂商 NPU 运行时仍需真机 + SDK（见 §2.4）。
- 语音闭环主体已在 `docs/audio-hal-bridge.md` / `docs/native-voice.md` 落地；§2.3 是**唯一**
  尚未真机验收的一步（AAudio 采集线程喂进 resident capture）。
