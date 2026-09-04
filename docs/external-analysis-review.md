# 外部 AI 分析逐条复核报告 (External Analysis Review)

**日期**: 2026-09-03
**审查对象**: 一份第三方 AI 生成的、关于 AmOS 商业化缺口的分析（"与 OEM 合作 / 12GB 真机 / 去谷歌化预装 MicroG"）。
**审查基准**: 当前 `main`（HEAD `5ee568c`，工作树干净）。所有结论均以仓库内真实源码为准并给出定位，不推测。
**结论摘要**: 该分析整体框架（管道已通、核心多为演示/占位）与仓库自评一致，但**相当一部分"缺失"在现树里其实已有实现或已有骨架**；另有几处对架构的刻画（Waydroid vs 无 UI Android 基座、App Store 装 APK vs web-bundle）与仓库文档**互相冲突**，需先统一战略再谈实现。详见下。

---

## 逐条复核

### 一、🔴 高优先级（外部文档称"缺失、急需攻克"）

| # | 外部文档主张 | 判定 | 仓库实况（证据） |
|---|---|---|---|
| 1.1 | "bidi 语音已接线，但底层 ASR 未接入，仍以诚实 Mock 文本应答" | ✅ **属实（但仅限 AI 助手语音通路）** | `crates/amos-ai/src/server.rs:559-595`：bidi `Payload::Audio` 分支确实写"ASR 尚未接入，请改用文本输入"，并用 `mock_tokens` 应答。**但**这不等于"系统没有 ASR"——本地 ASR 在**同传（native）**路径已真实可用（见下），只是没接进 AI 助手这个 bidi 语音通道。 |
| 1.1 | "缺乏从真机麦克风捕获 PCM→NPU→播放的底层管线" | 🟡 **部分属实** | WebView `getUserMedia` 已能采 PCM（同传/麦克风按钮），本地 **sherpa-onnx** ASR（`amos-asr`，feature `sherpa`）与 **Piper** TTS（`amos-tts`，feature `piper`）已 headless 验证通过（`docs/native-voice.md`）。缺的是：① AI 助手 bidi 语音通路的 ASR 接入；② 真机上的音频采集（目前是 WebView getUserMedia，非原生 AAudio/cpal）；③ NPU 上的推理（见 2.2）。 |
| 1.2 | "dialer 属纯 UI 静态模拟；缺 SIM 拨号 / 来电监听 / 强制 110-112" | ✅ **属实** | 全仓无 `amos-telephony`、无 telephony/Binder 代码。`crates/amos-tauri/frontend-ts/src/components/CommsApps.tsx:213` `PhoneApp` 仅 `useState(calling)` UI 状态，无真实拨号、无紧急号码通路。这是本报告确认的**真实核心缺口**。 |
| 1.3 | "amos-appstore 有校验/解压/依赖审计，但缺 PackageInstaller 静默安装与 GMS 云端扫描" | 🟡 **部分属实 + 框架偏差** | 现树比该分析说的更完整：已有 `model`(sha256)/`sign`(Ed25519 发布签名)/`http`(HttpStoreProvider)/`client`/`serve`/`webinstall` + `amos-appstore-cli` + Tauri `StoreBridge`(`crates/amos-tauri/src/appstore.rs`) + 商店 UI(`StoreApp.tsx`) + 动态主屏注入(`lib/storeApps.ts`)（均 2026-09-03 落地，见 `CHANGELOG.md`）。缺 PackageInstaller/静默安装/GMS 扫描——这点属实。**但框架偏差**：`webinstall.rs` 装的是 **web-bundle（`index.html`+assets+`amos-app.json`），不是 Android APK**；商店当前根本没有 APK 安装通路，所以"去调用 PackageInstaller 静默装 APK"是另一个未来机制，不是给现有商店打补丁。 |

### 二、🟡 中优先级

| # | 外部文档主张 | 判定 | 仓库实况（证据） |
|---|---|---|---|
| 2.1 | "缺跨应用全局剪切板桥 + 原生态多任务手势拦截" | ✅ **属实** | `amos-wm` 全仓仅 `src/lib.rs` 一个文件（传输无关状态机，9 测试），无 clipboard / compositor 代码。跨 Webview↔Android 容器的全局剪切板与手势拦截确为真空缺。 |
| 2.1 | （隐含）"amos-wm 已创建状态机" | ✅ 属实 | 与仓库一致。 |
| 2.2 | "amos-ai 默认跑 Mock 推理引擎；GGML/llama.cpp 绑定未完全连线；RK3588 NPU/RKNN 悬空" | 🟡 **部分属实** | ① 默认 backend 确为 `mock`（`crates/amos-ai/src/cli.rs:58` `default "mock"`）。② 但已有**真实后端**可切：`api`/`ollama`/`hermes`/`ggml`。③ GGML 现状是**外部 `allama` 子进程**（`crates/amos-ai/src/inference/real.rs:141,159`，引擎不可用则回落 mock；有 `ggml_command_e2e.rs` 门控测试）——确**无进程内 llama.cpp C 绑定**，此点属实。④ RK3588/RKNN 全仓无任何代码——属实且为真缺口。 |
| — | "12GB 真机 / RK3588 / MicroG" | ⚠️ **仓库内无对应物** | 现树无 RK3588/RKNN/MicroG 任何引用；此为商业叙事而非仓库现状。 |

### 三、🛠 工程改进建议

| # | 外部文档主张 | 判定 | 仓库实况（证据） |
|---|---|---|---|
| 3.1 | "CI 的 lint-and-test 与 gated-native-backends 在主分支合并频繁挂掉（x86 vs arm64 / NDK 交叉链不一致）" | 🟠 **当前不可复现 / 依据不足** | 两个 job 在 `.github/workflows/ci.yml` 中**存在**（`lint-and-test`、`gated-native-backends` + `smoke`）。其引用的"证据"是 mail.google.com 链接（外部对话历史），**非本仓库产物**，无法据此判定当前 CI 红绿。本地实测：`cargo fmt --check` **exit=0**（fmt 半边当前通过）。近期提交（`style: cargo fmt — make lint's fmt check was failing…` 等）说明 lint 门曾在**本地机器**上因 fmt 抖动，但不等于 CI 持续挂。结论：请以真实 CI run / `make lint` 日志为准，勿沿用外部文档的说法。 |
| 3.2 | "通过 init.rc 给 amos-ai 设 oom_score_adj=-1000" | ❌ **过时（已在仓库）** | `deploy/android/amos.rc` **已有** `service amos-ai … oom_score_adj -1000`（且带自动重启、seclabel、UDS `0700`）。外部文档把"建议"当作缺失项，属漏读现有资产。 |
| — | "可以先让我写 Mac 上 NDK/ARM64 交叉编译踩坑指南" | ❌ **已在仓库覆盖** | `scripts/build-android.sh`（读 `$ANDROID_NDK_HOME`、rustup 目标、写 `.cargo/config.toml`、build `amos-ai`+`amos-wm`）+ `docs/no-ui-android.md` §3 + `docs/mobile-targets.md` 已给出该指南。可做的是**校验/补强**它，而非从零写。 |

---

## 两个必须正视的跨主题问题

### A. 运行时战略自相矛盾（比任何单项缺口都优先）
仓库内部同时存在**两套互相冲突的"OS 底座"叙事**：
- `crates/amos-android/src/lib.rs:1` + `docs/android-compat.md`：**Waydroid/LXC 容器**，Tauri 不直接跑 APK，容器 surface 经 Wayland/DMA-BUF 合成（外部文档沿用此思路）。
- `docs/no-ui-android.md`（§1 明言"No Linux migration, no Waydroid"）：**无 UI Android 基座**（内核+驱动+HAL+Binder，无 SystemUI），`amos-ai` 进 `/system/bin`、Tauri 壳为唯一 HOME launcher APK，旧 APK 经 SurfaceControl/VirtualDisplay 起 surface。

若对外要与 OEM 谈"12GB 真机、直接控底层硬件"，这**两条路必须先定一条**——它决定 telephony 走 Binder 还是 shell、商店是否/如何跑真 APK、剪切板桥怎么设计。FUNCTIONAL_GAP_ANALYSIS 建议路线也隐含这两条线的摇摆，建议上升为决策项。

### B. 一句话定位仍然成立，但需修正措辞
外部文档与 `FUNCTIONAL_GAP_ANALYSIS.md` §五结论一致：**管道（gRPC/UDS、多窗口、AI 流式、Android 兼容层）已通，核心仍是演示/占位（推理默认 mock、前端应用占位、安全层部分未接线）**。但"ASR 完全没做"、"剪切板/TTS/翻译全缺"、"LMK 与 NDK 指南缺失"均**不实**——真实清单是：把**已写好但没接/没默认启用**的东西接进运行时（AI 助手 bidi 语音→ASR、真实后端设为默认、enhanced AndroidManager 接线），再补**真正空着的**（telephony、全局剪切板、进程内 GGML/NPU、商店 APK 静默安装 + GMS 审计）。

---

## 建议的"别再重做"清单（已存在资产）
1. 本地 ASR/TTS/翻译/同传：`amos-asr`/`amos-tts`/`amos-translate`/`amos-int` + `docs/native-voice.md` 协议与已验证结果 → 用真实模型补一轮 UI 窗口测试即可（`docs/native-voice.md` §"Window test protocol"）。
2. `amos-ai` 真实后端（api/ollama/hermes/ggml-allama）：改 `AMOS_BACKEND` / 完善默认而非"接一个真引擎"。
3. 商店：桥接与 UI 已通；先决定"web-bundle vs APK"再谈静默安装。
4. 交叉编译与 init.rc：`scripts/build-android.sh` + `docs/no-ui-android.md` + `deploy/android/amos.rc`（含 `oom_score_adj -1000`）。
5. 监控/健康：`crates/amos-ai/src/monitoring.rs` + 周期心跳已落地（2026-09-03）。
