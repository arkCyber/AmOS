# AmOS 功能差距分析 (Functional Gap Analysis)

**日期**: 2026-09-03
**范围**: 全 workspace（amos-proto / amos-ai / amos-wm / amos-android / amos-tauri / amos-supervisor / amos-mail / amos-appstore 等）

> 🔄 **2026-09-03 审计同步**：本文件已对照 `docs/external-analysis-review.md` 复核并修正若干已过时条目（见 §二.C、§二.I.37、§三、§四）。关键战略判定：**真机产品本体 = no-UI Android 基座；Waydroid 仅作开发/原型**（见 §六 与 `docs/no-ui-android.md` / `docs/android-compat.md` 顶部）。

---

## 一、已实现且真实可用的能力

| 能力 | 状态 | 说明 |
|------|------|------|
| gRPC over UDS 全链路 | ✅ | Tauri core ↔ amos-ai daemon，单 UDS 同时承载 AiAgent + AndroidManager 两个服务 |
| AI 助手（文本流式） | ✅ | `StreamChat` / `Chat`(bidi)，token 流式渲染、`Cancel` 取消、系统上下文注入 |
| **语义 UI 卡片协议** | ✅ | 2026-09-01：AI 意图识别引擎（`semantic.rs`）把"天气/音乐/笔记/钱包/打开"意图转为结构化 `UiCard`，经 UDS gRPC → Tauri 桥 → `ai-card-received` 事件 → 前端（frontend-ts `AiCardView`/`stream.ts cardOf`）动态渲染交互卡片（AI 直接驱动 UI） |
| 会话管理 | ✅ | 会话创建/清理/上下文（内存态） |
| 窗口管理器 | ✅ | `amos-wm` 状态机 + Tauri 适配，多窗口、焦点、外部 surface 跟踪 |
| 跨窗口共享存储 | ✅ | `SharedStore` + `store-updated` 广播，多窗口同步 |
| **进程管理器 `amos-supervisor`** | ✅ | 2026-09-01 新增 crate：拉起/监控/热重启 CLI 守护进程，重启策略（上限+指数退避）、`stop`/`shutdown_all` 优雅关闭、`status`/`list` 查询 |
| **CLI daemon 编排入口** | ✅ | 2026-09-01：`amos-supervisor` 二进制 + JSON 配置（`deploy/daemons.json`），`amos-supervisor check|run <config>` 统一校验/启动/监控 amos-ai 与 amos-translate；`SupervisorConfig`/`load_config`/`start_all` 库支持 |
| **硬件按钮（Home/语音/AI）** | ✅ | 2026-09-01：`amos-tauri/src/buttons.rs` 抽象 + `hardware-button` 事件 + `simulate_button` 命令 + 前端（frontend-ts `App.tsx`）路由 + 桌面键盘快捷键；平台驱动接入点见 `docs/hardware-buttons.md` |
| **语音转写（ASR）管线** | ✅ | 2026-09-01：`amos-translate` 新增 `Transcribe` RPC + `SpeechRecognizer` trait（Mock/WhisperProvider）+ 流式音频段转写；`amos-tauri` `transcribe_audio`/`translate_text` 命令 + 前端 `lib/backend.ts` 的 `transcribeAudio`；`deploy/daemons.json` 默认 `AMOS_ASR_BACKEND=mock` |
| **同传领域引擎 `amos-int`** | ✅ | 2026-09-01：传输无关会话状态机（Idle→Collecting→Interpreting→Speaking）+ `UtteranceBuilder`（流式 partial→stable→final）+ `Pipeline` trait + `BothMode`；`SessionEvent` 进 / `InterpretationOutput` 出 |
| **同传 daemon 桥接 `GrpcPipeline`** | ✅ | 2026-09-01：`Pipeline` 的 gRPC 实现，`StreamTranslate` 音频路径做 ASR + 一元 `Translate` RPC 翻译；断线自动重连（translate/audio 失败均 `invalidate` 缓存）|
| **流式 ASR `amos-asr`** | ✅ | 2026-09-01：`StreamingRecognizer` trait（partial/hypothesis/endpoint）+ 确定性 `MockStreamingRecognizer` + `AsrPipeline`（组合本地 ASR + 远端翻译）；sherpa-onnx 后端以 `sherpa` feature 门控（需联网下载预编译库）|
| **TTS `amos-tts`** | ✅ | 2026-09-01：`TtsProvider` trait + 确定性 `MockTtsProvider` + `PiperProvider`（`piper` feature 门控）；Tauri `tts_synthesize` 命令 → Web Audio 播放 |
| **同传 CLI `amos-int-cli`** | ✅ | 2026-09-01：stdin 进文本、译文出，`.lang`/`.status`/`.pause`/`.resume`/`.stop` 命令；驱动 `Session` + `GrpcPipeline` |
| **应用商店核心 `amos-appstore`** | ✅(领域内核) | 2026-09-03 新增 crate：传输无关 `AppManifest`/`Version`/`Checksum(sha256)` + `StoreProvider`(Mock) seam + `AppStore` 引擎（download→校验→install/upgrade/uninstall）+ 注册表 JSON 持久化；契约见 `docs/appstore.md` |
| **同传 App（GUI）** | ✅ | 2026-09-01：`frontend-ts/src/components/BackendApps.tsx` 的 `InterpApp` — 语言选择、会话控制、麦克风采集（16k mono→`AmosInterp.audio`）、流式 partial/译文渲染、`🔊 朗读`（`AmosTts`）；已入 dock |
| **全链路冒烟** | ✅ | 2026-09-01：`amos-translate/tests/full_chain.rs` 无头跑通 音频→partial→daemon 译文→TTS 音频；`scripts/gui-smoke.sh` 真机一键冒烟 |
| 通知中心 + 快速设置 | ✅ | 下拉面板、快捷开关、亮度/音量滑块、通知列表（localStorage） |
| 锁屏 / 解锁（含 PIN） | ✅ | 2026-09-01 补全：时钟/日期、通知预览、PIN 数字密码、上滑/按钮解锁 |
| 最近使用 / App 切换器 | ✅ | 2026-09-01 补全：主屏指示条上滑进入 Recents，卡片式切换 |
| 深色模式 / 亮度调节 | ✅ | 2026-09-01 补全：设置开关真实生效（浅色主题 CSS 变量 + 全屏亮度遮罩） |
| Android 兼容层 | ✅ | `amos-android` 驱动 Waydroid 运行时（**开发/原型**）+ DemoRuntime（演示）；launch/list/icon 已接线。真机产品走 no-UI Android 基座、旧 APK 原生运行（见 `docs/no-ui-android.md`） |
| 安全层（rate limit/audit/permission） | ✅ | 2026-09-01 已接入 `AiAgentService` 每 RPC 校验 + 速率限制 + token 审计（见 §二.B.8） |
| **电话（telephony）** | ✅(领域/服务/桥/桌面闭环) | 2026-09-03 起：`amos-telephony` 领域内核 + `proto/telephony.proto` + `TelephonyService`（Mock）挂 `amos-ai` 同一 UDS + Tauri `telephony_*` 命令桥 + `PhoneApp` 拨号接线 + 锁屏紧急呼叫 110 + `Watch` 真实事件流/注入式来电模拟 + 通话录音（`RecordingState`/provider seam/proto/Tauri/UI）；**2026-09-04 桌面闭环**：Tauri `Watch` 事件桥 + 前端**来电浮层**（接听/拒接/录音/挂断）+ `telephony_answer` + 出局拨号 **demo 自动接通**（`demo_server()`）使 拨号→通话→录音→挂断 真实可操作。**2026-09-04 审计校正（见 `docs/telephony.md` §12）**：真电话宿主进程定稿（System UI/`ROLE_DIALER` 持 Context，非 headless daemon 手写 binder）；紧急硬保证责任边界澄清（framework/RIL/厂商，非用户态"内核通路"）；`EmergencyMap` 司法区化（`for_region`/`quick_dial`，未知区域回退全局）；锁屏紧急一键单一来源 + 自恢复；`PhoneApp` 无 daemon 拨号优雅降级（Rust 单测 51 全绿、`tsc --noEmit` 通过）。剩余：P3 真机 Android provider 代码（宿主与要点已定稿，见 `docs/telephony.md` §10.4） |
| **Radio / connectivity（wifi/蓝牙/飞行）** | ✅(内核/桥/UI) | 2026-09-04：`amos-radio` 领域内核（`RadioManager` 策略 + 飞行级联 + `MockRadioProvider`）+ Tauri `radio_*` 命令桥（进程内，真机属 Android 系统服务故不走 daemon）+ 通知中心接线（持久化镜像、跨窗口广播、未 bridge `flipRadio` 降级、开面板 `radioStatus` 权威同步）。真机 Android provider（`AndroidRadioProvider`，`android` feature JNI 骨架）待设备（见 `docs/radio.md`） |
| **电话通信录（contacts）** | ✅(领域/UI) | 2026-09-04：`lib/contacts.ts` 纯领域（校验/归一化/损坏自愈、增删改、收藏、搜索按名/号码、重复号码拦截含 +CC 与裸号互判、首字母分组、头像色、号码反查姓名 `contactNameFor`）+ `ContactsApp`（👥，已注册进网格）+ en/zh。持久化 `amos.contacts`。另有 `lib/calllog.ts`（最近/常用通话，持久化 `amos.calllog`：`recordCall`/`recentNumbers`/`frequentNumbers`/`logNameFor`/`normalizeCallLog`）→ 呼叫成功即记录并出「最近」快速拨打条。领域 100% 函数覆盖 + DOM 交互测试（`contacts.test.ts`/`calllog.test.ts`/`ContactsApp.test.tsx`） |
| **通知三件套 + 策略（system UX）** | ✅ | 2026-09-04：`NotificationBanner`（到达顶部横幅、点按处理）、`useNotificationAlert`（到达按策略 震动 `navigator.vibrate` + Web Audio 铃声）、ring/vibrate 策略位（`lib/sound.ts`）+ DND 一键静音 + 🔔/dock 角标实时未读（DND 隐藏）+ 状态栏 radio/DND 常驻指示 + 响应式跨窗口 store（`useStoreValue`/`store-updated` 权威值）。单元 + DOM + 端到端覆盖 |
| 桌面 Tauri 壳 + 移动 UI | ✅ | 模拟手机桌面的系统 UI |

---

## 二、核心缺口（按优先级排序）

### 🔴 A. AI / 推理核心 —— 最高优先级
1. ~~**真实推理引擎未接入**~~ → **✅ 大幅完成（2026-09-01）**：`ApiBackend`（OpenAI 兼容 SSE）、**`OllamaBackend`**（直连本地 Ollama，`/api/tags` 健康检查）、**`HermesAgentBackend`**（接 Hermes-Rust agent，解析原生 `{"type":"token"}` 帧做真实逐 token 流式，`/health` 探测）均已实现；`AMOS_BACKEND=api|ollama|hermes` 即可接入。`GgmlBackend`（本地 GGML/llama.cpp）为外部 `allama` 子进程（无进程内 C 绑定；引擎/模型缺失时回落 mock，有 `ggml_command_e2e.rs` 门控测试）。
2. **无进程内模型加载**：本地 GGML/llama.cpp **无进程内 C 绑定**（现走外部 `allama` 子进程；进程内需引入 `llama-cpp-rs`/`candle` 原生依赖）；`ApiBackend` 已不需要本地模型。
3. **GPU/NPU 加速无实现**：`Config.enable_acceleration` 存在但无对应后端。
4. **无 function calling / 工具调用**：`BackendMetadata.supports_function_calling` 为 false，AI 无法调用系统能力。
5. **无多模态（图像理解）**：`supports_images` 为 false。
6. ~~**无会话持久化**~~ → **✅ 已完成（2026-09-01）**：`SessionManager::save/load`（原子 JSON，缺失/损坏非致命降级），重启加载会话并反推 staleness；已接入 daemon（`AMOS_SESSIONS_PATH`）。长期记忆/RAG 仍无（见 7）。
7. **无 RAG / 本地检索**：无 embedding 索引，无法"询问我的文件/笔记"。

### 🟠 B. 已写但未接线的"半成品"
8. ~~**`SecurityManager` 未接入 gRPC server**~~ → **✅ 已完成（2026-09-01）**：`AiAgentService` 现在在 `stream_chat`/`chat`/`get_status` 每个 RPC 都执行权限校验 + 每客户端速率限制，并做 token 计量与审计日志；`security.rs` 不再是死代码。客户端身份通过 `x-amos-client` metadata 传递（Tauri 桥接层已发送），`system-ui` 默认授予 `Standard`。见 `server.rs` / `security.rs` / `ai_bridge.rs`。
9. ~~**`EnhancedAndroidManager` 未接入 `AndroidManagerService`**~~ → **✅ 已完成（2026-09-01）**：`service.rs` 现由 `Arc<EnhancedAndroidManager>` 支撑，所有 Android 操作（launch/list/icon）都经过超时保护与 LRU 图标缓存；`server()` 工厂自动用默认增强配置包装 runtime，调用点不变。
10. ~~**`BackendKind` 后端选择未接入 server**~~ → **✅ 已完成（2026-09-01）**：daemon 现持有 `Arc<dyn InferenceBackend>`，`stream_chat`/`chat` 均经 `backend.infer()` 异步流式生成；`build_backend_from_env()` 按 `AMOS_BACKEND`（mock/api/ollama/hermes/ggml）选择后端，选择与接线基础设施真实生效（各后端实际生成见条目 1/2）。

### 🟠 C. 语音交互（2026-09-03 已大幅实做，见 §一 表与 docs/native-voice.md）
11. ~~**语音输入/ASR 未接入**~~ → **✅ 已实做（同传/native 路径）**：`amos-asr`（`StreamingRecognizer`，sherpa feature 门控，headless 用真实模型验证）、`amos-translate` `Transcribe` RPC + `SpeechRecognizer`（Mock/WhisperProvider）、`amos-tauri` `transcribe_audio`。**仍未接**：AI 助手 bidi `Payload::Audio`→ASR 的语音通道（`server.rs` 对 audio 帧仍"诚实忽略"并回 mock 文本），以及真机原生采集（现为 WebView `getUserMedia`，非 AAudio/cpal）。
**2026-09-03 补充（bidi 语音已闭合）**：`amos-ai` 新增 `ChatAsr`（`amos-asr` Mock 默认，`AMOS_ASR_BACKEND=off` 关闭），`server.rs` 对 `Payload::Audio` 逐帧喂识别器，endpoint 到达时把识别文本作为 Prompt 复用既有推理/审计/会话（73 lib 测试通过，见 `docs/bidi-voice-asr.md`）。真机原生采集与真 sherpa 后端仍待接。
**2026-09-04 补充（Audio HAL Bridge 落地，见 `docs/audio-hal-bridge.md`）**：新增 **`crates/amos-audio`**（纯 std）＝音频 HAL 抽象层：`AudioCapture`/`AudioSink` trait、16 kHz 规格/编解码、流式 `LinearDownsampler`、确定性 mock，以及按 `target_os="android"`+feature 门控的**手写直接 FFI** TinyALSA/AAudio 设备 seam（宿主不编译）。`amos-ai` 新增 **`asr-sherpa`** feature：`AMOS_ASR_BACKEND=sherpa` + `AMOS_SHERPA_MODEL_DIR` 时 bidi `Payload::Audio` 走**真 sherpa 本地 ASR**（未配置则诚实回退 `None`，绝不静默降级 mock）；UDS e2e 用真实语音 wav 验证识别→作答闭环。**仍待设备 bring-up 做的事**：在 NDK 交叉目标编译/联调 `amos-audio` 的 android seam；把采集线程接进 System UI（常驻听麦→`Payload::Audio`）；SIM/通话语音流拦截需系统级 HAL/audio-route 钩子。
12. ~~**TTS 语音输出缺失**~~ → **✅ 已实做（headless 验证）**：`amos-tts`（`TtsProvider` Mock/Piper，`piper` feature 门控）+ `tts_synthesize`→Web Audio。真机原生回放仍待接。
13. **多模态输入（图/音/文混合）缺失**。

### 🟠 D. 移动端 / 真机
14. **mobile targets 未初始化**：无 `android/`、`ios/` 平台目录，目前只是桌面。
15. ~~**无真机设备 API**~~ → **✅ 部分完成（2026-09-01）**：**相机**接入 WebView `getUserMedia`（真实取景器 + 拍照存相册，无摄像头时降级演示）；**地图**接入 OpenStreetMap 在线瓦片 + `navigator.geolocation` 定位 + 城市搜索 + 缩放（离线降级）。麦克风、GPS 原生插件、传感器、电话/SMS、联系人仍缺失。
16. ~~**无锁屏 / 解锁**~~ → **✅ 部分完成（2026-09-01）**：锁屏（时钟/日期/通知预览）+ 数字 PIN 密码 + 上滑/按钮解锁已实现；生物识别（指纹/面容）仍缺失。
17. ~~**无首次启动引导（onboarding）**~~ → **✅ 已完成（2026-09-01）**：首次开机进入欢迎流程（介绍 → 外观选择 → 可选设置锁屏密码 → 完成），完成标记持久化到 `amos.onboarded`，之后直接进入锁屏。
18. **无 OTA / 自动更新**。

### 🟡 E. 桌面 OS 级功能
19. ~~**设置不落盘**~~ → **✅ 已完成（2026-09-03）**：`SharedStore`（`amos-tauri/src/store.rs`）现持久化到磁盘——每次写入写回 `AMOS_STATE_FILE`（缺省 `~/.amos/state.json`），重启可恢复且 Rust 侧可读；损坏文件降级为空并可自愈；localStorage 仅作前端缓存。测试覆盖跨实例持久化/删除/损坏容错。
20. **文件系统无真实访问**：files 应用是 mock 静态列表 → **✅ 部分完成（2026-09-01）**：已改为 store 支撑的虚拟文件系统（建文件夹/建文本/查看/删除），但尚未接真实磁盘/Tauri `fs` 插件。
21. ~~**快捷设置不生效**~~ → **✅ 大部分完成（2026-09-01 + 2026-09-04）**：深色模式/亮度真实生效（前端主题 + 遮罩）。**wifi/蓝牙/飞行** 已接 `RadioManager` 策略（飞行级联关 Wi-Fi/蓝牙、飞行中禁开）+ Tauri `radio_status/radio_set` 命令桥 + 持久化镜像（`amos.settings` 跨窗口广播）；桌面走 `MockRadioProvider`，未 bridge 时前端 `flipRadio` 同策略降级。真机 Android 射频后端（`AndroidRadioProvider`，`android` feature JNI 骨架，`cargo check --features android` 可编译）待设备接通。`location` 快速开关已接为**系统级定位主开关**（默认开；关时即使某 app 已授权也拦截 `MapsApp` 的 `navigator.geolocation`，2026-09-04）。`dnd` 快速开关已接为**勿扰**（默认关；开启时首页/dock 未读角标隐藏、通知中心列表静音呈现，2026-09-04）。
22. **无应用生命周期管理**：无后台/墓碑/冻结/进程调度。
23. **无全局搜索**（Spotlight 式）。
24. **无系统托盘、全局快捷键、多显示器支持**。
25. **无后台任务调度器**。

### 🟡 F. 前端应用多为演示占位
26. ~~相机=mock 取景器，地图=样式化占位，文件=mock 列表，照片/电话/信息/音乐/时钟/笔记 多为静态 UI~~ → **✅ 大幅完成（2026-09-01）**：**相册**、**文件**、**相机**（`getUserMedia`）、**地图**（OSM+定位）、**音乐**（Web Audio 合成播放器 + store 播放列表 + 播放/暂停/上一首/下一首/进度）均已做实。电话/信息仍为演示占位。
27. 无真实相册、真实通信、真实媒体播放 → 相册与媒体播放（音乐）已真实；通信（电话/信息）仍为演示。

### 🟡 G. 安全与隐私
28. **UDS 仅 0o700 权限，无认证/授权/加密**。
29. **无密钥管理、无端到端加密**。
30. **无用户/多用户模型落 UI**（permission 层存在但 UI 无体现）。
31. **无权限弹窗 / 隐私看板**。

### 🟡 H. 可观测性 / 运维
32. ~~**无监控指标**（`monitoring.rs` 未创建）~~ → **✅ 已完成（2026-09-03）**：`amos-ai` 新增 `monitoring.rs`——`Monitor` 无锁计数（rpc_total、uptime、周期心跳）经 tonic interceptor 集中统计；`StatusReply` 现携带 `rpc_total`/`heartbeats`，任意 `GetStatus` 探针即可读实时指标；`AMOS_METRICS_INTERVAL_SECS` 调周期。
33. ~~**无周期性健康检查/探针**（`GetStatus` 仅 boot 时查一次）~~ → **✅ 部分完成（2026-09-03）**：daemon 侧周期自健康心跳（heartbeat 计数 + 指标日志）已落地并随 `serve()` 启停；跨进程/客户端侧定时调用 `GetStatus` 的探针仍待接（见下）。
34. **无日志持久化/聚合**（tracing 仅 stdout）。
35. **无缓存层 / 连接池**（`cache.rs`、`pool.rs` 未创建）。
36. **无基准/压力/混沌测试**。

### 🟢 I. 生态 / 分发
37. ~~**无应用市场 / 只能从精选列表启动**~~ → **✅ 已实做（2026-09-03）**：`amos-appstore` 领域内核（manifest + sha256 + download→verify→install/upgrade/uninstall + 注册表持久化）之外，**Ed25519 发布签名**、**HTTP 目录后端**（`live` feature）、`amos-appstore-cli`、Tauri `StoreBridge`、商店 UI（`StoreApp.tsx`）与**动态主屏注入已安装应用**（`lib/storeApps.ts`、`store:<mid>` tiles，tapping 打开 `ExtApp` 占位容器）均已落地（见 `CHANGELOG.md`）。**剩余缺口**：装的是 **web-bundle 而非 Android APK**；无 PackageInstaller 特权静默安装；无云端 GMS 依赖合规审计/沙盒代理；且"web-bundle vs APK"机制需先定夺（见 §六）。契约与路线图见 `docs/appstore.md`。
38. **无开发者 SDK / API 文档站**。
39. **CI 无发布产物**（release artifacts）。

### ⚪ J. 本质定位
40. **当前是 Tauri 桌面应用模拟移动 OS**，不是可引导 OS；`deploy/android` 只有 init.rc 骨架，无内核/启动器/bootloader 真实集成。

---

## 三、Phase 2 报告里点名"下一步"但尚未完成的事项
（来源：`PHASE2_COMPLETION_REPORT.md` / `CODE_COMPLETION_SUMMARY.md`）
- [x] 集成 `SecurityManager` 到推理 gRPC 服务（✅ 2026-09-01，`server.rs`）
- [x] 集成 `EnhancedAndroidManager` 到 AndroidManager 服务（✅ 2026-09-01，`service.rs`）
- [ ] 实现真实 GGML/llama.cpp 后端（现状：外部 `allama` 子进程 + 引擎缺失时回落 mock；无进程内 C 绑定，见 `docs/external-analysis-review.md`）
- [x] 实现 `monitoring.rs`（性能指标/健康检查，✅ 2026-09-03）
- [ ] 连接池 `pool.rs`、缓存层 `cache.rs`
- [x] 会话持久化（✅ 2026-09-01，`SessionManager` + `AMOS_SESSIONS_PATH`）
- [ ] 压力/负载测试

---

## 四、建议的推进路线

### 短期（让"已有"真正生效）
1. ~~**把 SecurityManager 接进 AiAgentService**（每请求 rate-limit + audit + permission）~~ → **✅ 已完成（2026-09-01）**
2. ~~**JSON 语义 UI 协议**（AI 驱动 UI 卡片）~~ → **✅ 已完成（2026-09-01）**：`proto/UiCard` + `semantic.rs` 意图引擎 + 桥接事件 + 前端动态渲染（`AiCardView`）。
3. ~~**把 EnhancedAndroidManager 接进 AndroidManagerService**~~ → **✅ 已完成（2026-09-01）**：`service.rs` 由 `Arc<EnhancedAndroidManager>` 支撑（每操作超时保护 + LRU 图标缓存），`server()` 工厂自动用增强配置包装 runtime，调用点不变。
4. ~~**会话持久化到磁盘**~~ → **✅ 已完成（2026-09-01）**：`SessionManager::save(path)`（原子 JSON 写入）与 `SessionManager::load(path)`（缺失/损坏文件非致命降级为空）。`Instant` 在保存时转墙钟、加载时反推，重启后 staleness 仍正确。**并已接入 daemon**：`AiAgentService` 持有 `Arc<SessionManager>`，`stream_chat`/`chat` 每次生成都创建会话并记录 token 用量；`AMOS_SESSIONS_PATH` 设定后启动时加载、优雅关闭时保存。
5. **后端 HTTP 超时** → **✅ 已完成（2026-09-01）**：`ApiBackend`/`OllamaBackend`/`HermesAgentBackend` 的所有 `ureq` 调用（chat 60s、Ollama tags 10s、hermes health 5s）均加超时，后端挂死不再阻塞 daemon。

### 中期（让演示变"真"）
5. 移动端 `cargo tauri android/ios init` + 真机设备 API（相机/麦克风/GPS）。
6. ASR/TTS 语音交互。
7. 文件系统真实访问（Tauri `fs` plugin）+ 设置落盘。
8. 监控指标 + 日志持久化。

### 长期（OS 化）
9. 锁屏/生物识别、应用生命周期（墓碑/后台）。
10. 应用市场 / APK 安装 / 开发者 SDK。
11. 全局搜索、OTA 更新、多用户。
12. 真实 Android 容器合成（Waydroid 纹理合成，而非仅跟踪外部窗口）。

---

## 五、一句话总结
**骨架/管道（gRPC、多窗口、AI 流式、Android 兼容层）已经搭好且跑得通，但核心要么是"演示占位"（推理、前端应用）、要么是"代码已写未接线"（安全层、Android 增强）。** 最高优先级是把已有但未接线的模块真正挂进运行时，并替换掉 mock 推理引擎，其次是补齐语音、真机设备 API 与移动端 targets。

---

## 六、2026-09-03 战略判定 & 审计结论

### 战略判定（先于任何实现，必须统一）
- **真机产品本体 = no-UI Android 基座**（`docs/no-ui-android.md`）：内核 + 驱动 + HAL + Binder，无 SystemUI；`amos-ai` 进 `/system/bin`，Tauri 壳为唯一 HOME launcher APK；旧 APK 作为**原生 Android 进程**直接运行。
- **Waydroid 仅用于「开发 / 原型」**（`docs/android-compat.md`）：在非 Android 主机上验证 APK 兼容管线；真机不需要 Waydroid。
- 该判定决定下游一切设计：telephony 走 Binder、剪切板桥的目标容器、商店是否/如何跑真 APK、`AndroidRuntime` 驱动形态。
- 若对外与 OEM 谈"12GB 真机、直接控底层硬件、预装 MicroG 代替 GMS"，必须以此判定为准，避免文档内两套底座叙事互相打架。

### 审计校正后的"真缺口 vs 已存在"（详见 `docs/external-analysis-review.md`）
**真缺口（需要新写）**：`amos-telephony` 的 **P3 真机 Android/Binder provider** 与 **Watch 前端来电浮层/事件桥**（领域内核 + gRPC 服务 + UDS 挂载 + Tauri 命令桥 + 拨号器/锁屏紧急入口 110 + Watch 真实事件流/注入式来电模拟 已实现，2026-09-03，见 §一表与 `docs/telephony.md`）；AI 助手的**真机采集/真 sherpa** 与 transcript 回显（daemon `ChatAsr` + Mock 已接，2026-09-03）；跨应用全局剪切板桥 + 多任务手势拦截；进程内 GGML/llama.cpp 与 NPU/RKNN；商店真 APK 静默安装 + 云端 GMS 审计。
**已存在、别再重做**：本地 ASR/TTS/翻译/同传（`amos-asr`/`amos-tts`/`amos-translate`/`amos-int` + `native-voice.md` 已验证）；`amos-ai` 真实后端（api/ollama/hermes/ggml-allama）与监控健康（`monitoring.rs`）；商店桥接与 UI；交叉编译脚本 `build-android.sh`；`deploy/android/amos.rc` 已含 `oom_score_adj -1000`。
**已被审计澄清的"非事实"**：CI"频繁挂掉"当前不可复现（`cargo fmt --check` exit=0，job 均在 `ci.yml`）；外部分析引用的"证据"是外部邮件链接而非本仓库。

### 建议推进顺序
1. **阶段 0（本文件所在）**：统一底座判定 + 文档同步（已完成）。
2. **阶段 1**：真机 POC —— `scripts/build-android.sh` 交叉编译 `amos-ai`，`adb push /data/local/tmp` 跑 `chat_once`/UDS，验证 IPC 与权限边界（见 `docs/mobile-targets.md` / `no-ui-android.md` §3）。
3. **阶段 2**：补真缺口 —— 先 `amos-telephony`（含紧急拨号）与 AI 语音→ASR，再全局剪切板桥。
4. **阶段 3**：商业化使能 —— Default Phone App 注册（OEM 出厂权限）、商店 web-bundle vs APK 定夺、推理先 aarch64 CPU（llama.cpp）后 NPU（仅 OEM/芯片平台确认后）。
