# RK3588 bring-up：RKNN NPU 与进程内 llama.cpp 的接线清单

**范围**: 让 `amos-ai` 在 Rockchip **RK3588** 上把大模型推理跑进 **NPU（RKNN）**，
并给"进程内 llama.cpp"（不再是每个请求 spawn 一个 `allama` 子进程）一条落地路径。

> ⚠️ **前提诚实声明**：本文描述的两个后端 **今天都只是 seam，不是 binding**。
> `crates/amos-ai/src/inference/rknn.rs` 与 `crates/amos-ai/src/inference/llama_cpp.rs`
> 里的 `new()` **永远返回 typed 错误**（`Provider(...)` 或 `NotImplemented(...)`），
> **绝不**返回伪造成功，也 **绝不**静默回退到 `MockBackend`。真机 NPU 必须在装有
> RK3588 + `librknnrt.so` 的板子上编译、转换模型、端到端验收；本仓库保证的只是
> **host 可编译、feature 门控、单测绿** 的 seam 与判定清单。不把"能编译"当"已接通"。

相关文件：

- `crates/amos-ai/src/inference/rknn.rs` —— Rockchip NPU seam（`RKNN_BRINGUP_DOC`）。
- `crates/amos-ai/src/inference/llama_cpp.rs` —— 进程内 llama.cpp seam。
- `crates/amos-ai/src/accelerator.rs` —— `Accel::Rk3588Npu` + `compiled_in()`。
- `crates/amos-ai/Cargo.toml` —— `[features] rknn` / `llama-cpp-inproc`。
- `docs/qcom-mtk-bringup.md` —— 同族的 Qualcomm / MediaTek seam，规则一致。

---

## 1. 当前状态（本仓库内已完成、可 host 验证）

| 部位 | 行为 | 判定 |
| --- | --- | --- |
| `Accel::Rk3588Npu` | `AMOS_ACCEL=rknn`（大小写不敏感，别名 `rk3588` / `rk3588npu`）解析为该变体 | `accelerator.rs` 单测 |
| `compiled_in()` | `cfg!(feature = "rknn")` —— 唯一的可用性判据 | `rknn_without_feature_resolves_to_cpu_with_reason` |
| `resolve()` 降级 | 未编译时回退 **CPU** 并给出 reason：`RKNN SDK not linked (see docs/rk3588-bringup.md)` | 同上 |
| `Rk3588Backend::new` | 无 `rknn` feature → `BackendError::Provider(...)`；有 feature → `NotImplemented(...)` | `rk3588_backend_new_without_sdk_returns_provider_error` |
| 路径校验 | 空白 / 超过 `MAX_RKNN_MODEL_PATH_BYTES`(4096) → `BackendError::ModelNotFound` | `rk3588_backend_refuses_blank_and_oversized_paths` |
| `AMOS_BACKEND=rknn` | 构造失败时 daemon 返回 `UnconfiguredBackend` 并 `tracing::error!`，**不回退 mock** | `build_backend_from_env_with_rknn_value_uncompiled_returns_cpu_or_provider` |
| `AMOS_BACKEND=llama-cpp` | 同上（别名 `llamacpp` / `llama_cpp`） | `llama_cpp_in_process_without_feature_returns_provider_error_not_mock` |

`rknn` / `llama-cpp-inproc` 两个 feature **今天不门控任何代码**——它们只把
`cfg!(feature = …)` 的运行期分支从"SDK 未链接（`Provider`）"翻到"binding 未写（`NotImplemented`）"。
这也意味着 **production 行为不变**：daemon 的本地引擎仍是外部 `allama`/`AMOS_GGML_BIN` 子进程。

---

## 2. RK3588 NPU（RKNN）落地步骤

### 2.1 FFI 表面

RK3588 通过 `librknnrt.so`（RKNN runtime）暴露一套 C API：

```
rknn_init        rknn_query      rknn_inputs_set
rknn_run         rknn_outputs_get  rknn_destroy
rknn_mem_create / rknn_mem_map / rknn_mem_sync / rknn_mem_destroy   (零拷贝 family)
```

建议做法：

1. 新建 `amos-rknn-sys` 这个 `-sys` crate，用 `bindgen` 从 Rockchip `rknn-toolkit2`
   SDK 的 `include/rknn_api.h` 生成 wrapper。
2. 用 `build.rs` 的 `cargo:rustc-link-lib=rknnrt` + `cargo:rustc-link-search` 链接
   `librknnrt.so`（交叉编译时指向 NDK sysroot / 板端 vendor 库）。
3. 在 `amos-ai` 里把 `rknn` feature 从 `[]` 改成 `["dep:amos-rknn-sys"]`。

### 2.2 模型格式（关键约束）

LLM 权重 **必须在主机** 用 `rknn-toolkit2` 转换：

```python
rknn.load_... → rknn.config(...) → rknn.build(...) → rknn.export_rknn("model.rknn")
```

**设备侧无法在运行期转换**——这正是 daemon 的 `AMOS_MODEL_PATH` 对 RKNN 路径要求 `.rknn`
而不是 `.gguf` 的原因。转换的量化参数（`do_quantization`、目标平台 `rk3588`、
core mask）是 bring-up 决策，需与模型一起版本化。

### 2.3 接线

实现 `InferenceBackend` for `Rk3588Backend`：

- 载入 `.rknn`（`rknn_init`，记录 `RKNN_QUERY_IN_OUT_NUM` / `…SDK_VERSION`）；
- tokenize（目前 llama.cpp 的 vocab 需一并导出，或走 sidecar tokenizer）；
- prefill/decode 循环：`rknn_inputs_set` → `rknn_run` → `rknn_outputs_get`；
- 用现有 `super::TokenStream` 流式吐 token；
- NPU core mask（RK3588 三核）用 `rknn_set_core_mask`，是 bring-up 决策。

### 2.4 翻牌条件（必须同时满足）

只有第 2.3 步真正跑通后，才允许：

1. 让 `Rk3588Backend::new` 在 SDK 确实链接时返回 `Ok` —— 是 **运行期探测已加载的
   `librknnrt.so`**，不只是 feature flag；并且
2. 保持 `Accel::Rk3588Npu::compiled_in()` = `cfg!(feature = "rknn")` 不变。

> 顺序很重要：`compiled_in()` 现在是诚实的 `cfg!` 门。**不要**为了"让功能看起来可用"
> 而在 binding 未完成时把它改成 `true`——那正是 F-NPU-001 要防的"声称支持却无 SDK"。

---

## 3. 进程内 llama.cpp（`llama-cpp-inproc`）落地步骤

今天 daemon 走外部子进程（`GgmlBackend` → `allama` / `AMOS_GGML_BIN`）：每次生成一个
进程 spawn，且设备镜像多一个第三方二进制。进程内方案把它消除：

1. 依赖一个在维护的 binding（`llama-cpp-rs` / `llama_cpp-2`），**或** 自建 `amos-llama-sys`
   用 `bindgen` 包上游 `llama.h`，并 vendored / build-from-source `llama.cpp`。
2. 实现 `InferenceBackend`：载入 GGUF → 用 accelerator profile 的 `n_gpu_layers`
   （`crate::accelerator::AccelProfile`）建 context → prefill/decode → `TokenStream`。
3. **保留 `GgmlBackend` 作为 fallback 引擎**；只有运行期确实加载成功时才把
   `LlamaCppInProcessBackend::new` 翻成 `Ok`。
4. 加一条 e2e：从 tiny GGUF 真生成一次，断言回复 **非空且非 mock**。

> RK3588 上两条路会汇合：NPU 卸载用的是 Rockchip 的 llama.cpp fork（RKNN offload
> backend），所以 `rknn.rs` 与 `llama_cpp.rs` 在板端收敛到同一处。见 §2.1。

---

## 4. FMEA（诚实边界）

| ID | 失效模式 | S | P | D | RPN | 缓解 |
| --- | --- | --- | --- | --- | --- | --- |
| F-NPU-001 | 声称支持 RKNN 但 SDK 未链接 | 4 | 2 | 4 | 32 | `compiled_in()` = `cfg!(feature="rknn")` 是唯一判据；未链接 → `Provider(...)` |
| F-NPU-002 | 操作员选了 RKNN，设备却跑 CPU 且无解释 | 3 | 4 | 4 | 48 | `AccelProfile::resolve()` 返回降级 reason（含本文路径） |
| F-NPU-003 | binding 未写却返回伪造成功 / 静默 mock | 5 | 1 | 3 | 15 | `new()` 在 feature 开时返回 `NotImplemented`；`infer()` 拒绝；daemon 转 `UnconfiguredBackend` |

---

## 5. 门与验证

- **build/lint**：`cargo check -p amos-ai --features rknn,llama-cpp-inproc`
  （在 `make lint` —— `scripts/feature-surface-scan.mjs` 要求每个非默认 feature 有一步编译）。
- **单测**：`cargo test -p amos-ai --features rknn,llama-cpp-inproc --lib inference::`
  （在 `make test`），覆盖 `NotImplemented` 分支；默认 feature 下覆盖 `Provider` 分支。
- **诚实 smoke**：`bash scripts/ai-honesty-smoke.sh`、`bash scripts/ai-backend.sh`。
- **device-only（本仓库未验证）**：`librknnrt.so` 链接、`.rknn` 转换、NPU core-mask、
  板端 `/data/amos` 模型 staging、真机吞吐。这些必须在 RK3588 板 + NDK/SDK 上验收。
