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
| **设备传感器/多媒体领域内核 `amos-sensor`** | ✅(领域/服务总线/daemon) | 2026-09-04：相机 / GPS-GNSS / IMU 领域内核（`SensorKind`/`SensorMode`、`CameraConfig`/`CameraFrame` RGBA8/NV21、`GeoFix`/`FixMode`、`ImuSample`/`Vec3`、采样上限；`SensorProvider` seam + 确定性 `MockSensorProvider`；`SensorManager` 能量策略）**已 `add_service` 挂进 daemon 同一条 UDS**：`proto/sensor.proto`（`amos_sensor`）→ `amos-proto` 生成 → `amos-sensor/src/service.rs` 的 `SensorService`（ListCameras/CaptureCamera/GetGnss/GetImu/GetMode/SetMode/AcquireStream）→ `amos-ai::serve()`（真 UDS e2e：`sensor_rpc_e2e.rs` 单服务 + `rpc_test.rs` 与 AiAgent 同 socket）。**剩余 seam**：真机相机帧/IMU 流桥与 System UI 真 `Context` 接线（GNSS 的 `AndroidSensorProvider` 已真实现、feature `android` 骨架已 `cargo check` 通过；System UI 桌面桥 `sensor_snapshot/set_mode/acquire` + `lib/sensors.ts` 已落地，见 `docs/sensors.md`）。单测 25 + e2e、clippy -D warnings 干净 |
| **推理性能/功耗 Profiling `amos-profiling`** | ✅(领域/daemon 装配) | 2026-09-04：度量内核（`ProfileTracker` decode/prompt tokens-per-second、TTFT、每 token 延迟、除零守卫；`PowerSource` seam+`MockPowerSource`；`time`/`time_and`；可展示 `ProfileReport`）**已装配进 `amos-ai`**：`amos-ai/src/profiler.rs` `ProfileStore`（Arc 共享）在 **`stream_chat` 与 bidi `Chat` 两条文本解码路径**都按 turn 记录流式 token 数+墙钟与 time-to-first-token（`Cancel` 打断不记），`get_status` 经 `StatusReply.profile`（`ProfileMetrics`，proto 字段 12）暴露，`serve()` 另以健康心跳同周期日志（`amos-ai inference profile`）落 profile；`status_once`/新增 `profile_once`/`sensor_once` 示例打印。**诚实标签**：无 tokenizer 不计 prompt tokens，`decode_tokens_per_sec`=端到端流到客户端的生成 token/s。**剩余 seam**：真机 `EXTRA_VOLTAGE`→`est_energy_j`、传感器 tile（profile 已由 `aiEngine.describeEngine` 解析并渲染进 Settings 诊断区；`AndroidBatteryPowerSource` 骨架已 `cargo check -p amos-profiling --features android` 通过，见 `docs/profiling.md`）。单测 15、clippy -D warnings 干净 |
| **电话通信录（contacts）** | ✅(领域/UI) | 2026-09-04：`lib/contacts.ts` 纯领域（校验/归一化/损坏自愈、增删改、收藏、搜索按名/号码、重复号码拦截含 +CC 与裸号互判、首字母分组、头像色、号码反查姓名 `contactNameFor`）+ `ContactsApp`（👥，已注册进网格）+ en/zh。持久化 `amos.contacts`。另有 `lib/calllog.ts`（最近/常用通话，持久化 `amos.calllog`：`recordCall`/`recentNumbers`/`frequentNumbers`/`logNameFor`/`normalizeCallLog`）→ 呼叫成功即记录并出「最近」快速拨打条。领域 100% 函数覆盖 + DOM 交互测试（`contacts.test.ts`/`calllog.test.ts`/`ContactsApp.test.tsx`） |
| **通知三件套 + 策略（system UX）** | ✅ | 2026-09-04：`NotificationBanner`（到达顶部横幅、点按处理）、`useNotificationAlert`（到达按策略 震动 `navigator.vibrate` + Web Audio 铃声）、ring/vibrate 策略位（`lib/sound.ts`）+ DND 一键静音 + 🔔/dock 角标实时未读（DND 隐藏）+ 状态栏 radio/DND 常驻指示 + 响应式跨窗口 store（`useStoreValue`/`store-updated` 权威值）。单元 + DOM + 端到端覆盖 |
| **节能策略决策内核 `amos-power`** | ✅(内核+daemon 装配) | 2026-09-04：电量/充电/温度/实时功耗/前后台 → `SensorMode`（迟滞）+ `cap_inference`/`throttle_background`；已挂 daemon 周期 beat 并经 `StatusReply.energy` 暴露。真 HAL 采样为 seam（docs/power-policy.md） |
| **应用生命周期内核 `amos-applife`** | ✅(内核) | 2026-09-04：per-App 状态阶梯 Foreground/Visible/ForegroundService/Background/Cached=墓碑/Stopped + 保护态永不回收 + LRU + 内存压力 `reclaim_candidates`(LMK-proxy)。真 per-app 进程宿主为 seam（docs/app-lifecycle.md） |
| **后台调度/唤醒对齐内核 `amos-scheduler`** | ✅(内核) | 2026-09-04：AlarmExact vs Deferred + `[earliest,latest]` 窗 + Doze/充电/维护窗门控 + 批量合并对齐 + `next_wake`。真 AlarmManager/JobScheduler/Doze 绑定为 seam（docs/scheduler.md） |
| **资源闭环 `ResourceGovernor`（daemon）** | ✅(装配已接线) | 2026-09-04：`amos_ai::governor` 把节能+生命周期+调度合成闭环——低电→PowerSave→冻结后台 App+压住 Deferred；恢复/充电+维护窗→解冻+跑合并批；显式内存压力→LRU 回收；已在 `serve()` 周期 beat 运行。per-app 宿主注册 app/job 后即自动治理（bottom-layer-os-audit.md §3.P2 注） |
| 桌面 Tauri 壳 + 移动 UI | ✅ | 模拟手机桌面的系统 UI |

---

## 二、核心缺口（按优先级排序）

### 🔴 A. AI / 推理核心 —— 最高优先级
1. ~~**真实推理引擎未接入**~~ → **✅ 大幅完成（2026-09-01）**：`ApiBackend`（OpenAI 兼容 SSE）、**`OllamaBackend`**（直连本地 Ollama，`/api/tags` 健康检查）、**`HermesAgentBackend`**（接 Hermes-Rust agent，解析原生 `{"type":"token"}` 帧做真实逐 token 流式，`/health` 探测）均已实现；`AMOS_BACKEND=api|ollama|hermes` 即可接入。`GgmlBackend`（本地 GGML/llama.cpp）为外部 `allama` 子进程（无进程内 C 绑定；引擎/模型缺失时回落 mock，有 `ggml_command_e2e.rs` 门控测试）。**2026-09-04**：新增 `AMOS_GGML_STRICT=1` 诚实开关——真实部署里引擎/模型不可用时**直接报错**而非静默回落 mock（默认仍 `off` 保住离线/CI 回落）。
2. **无进程内模型加载**：本地 GGML/llama.cpp **无进程内 C 绑定**（现走外部 `allama` 子进程；进程内需引入 `llama-cpp-rs`/`candle` 原生依赖）；`ApiBackend` 已不需要本地模型。
3. **GPU/NPU 加速原无实现** → **✅ 部分（2026-09-04）**：新增 `amos-ai::accelerator`（`crates/amos-ai/src/accelerator.rs`）域——`SoCVendor`（Qualcomm/MediaTek/Host，`AMOS_SOC_VENDOR` 覆盖）、`Accel`（auto/cpu/vulkan/metal/nnapi/qnn/neuropilot）+ `AccelProfile`；`Config.enable_acceleration`/`AMOS_ACCEL` 现在被解析成可上报的芯片画像（android `auto`→NNAPI 共通 NPU；`resolve()` 如实给出降级 reason；`--features qnn/neuropilot` 门控厂商 SDK）。daemon 启动打 `vendor/accel/llama_layers` 日志。真 GPU/NPU **驱动/运行时**接入属真机 + OEM SDK 工作（`docs/qcom-mtk-bringup.md`）。
4. **无 function calling / 工具调用**：`BackendMetadata.supports_function_calling` 为 false，AI 无法调用系统能力。
5. **无多模态（图像理解）**：`supports_images` 为 false。
6. ~~**无会话持久化**~~ → **✅ 已完成（2026-09-01）**：`SessionManager::save/load`（原子 JSON，缺失/损坏非致命降级），重启加载会话并反推 staleness；已接入 daemon（`AMOS_SESSIONS_PATH`）。长期记忆/RAG 仍无（见 7）。
7. ~~**无 RAG / 本地检索**~~ → **✅ 已完成（2026-09-03 起）**：`crates/amos-ai/src/rag.rs`（本地向量索引 + 精确 top-k 余弦）与 `rag_service.rs`（`Rag.Index/Remove/Query/Status` RPC **已挂进 daemon 同一 UDS**，嵌入后端 mock/Ollama/API 经 `AMOS_RAG_EMBEDDER` 选择），Tauri `rag_client.rs` + 前端 `lib/rag.ts`、「先检索再作答」由调用方组合 `Rag.Query` + `AiAgent.StreamChat`；索引经 `AMOS_RAG_STATE` 持久化（`rag_persist_e2e` 验证重启存活）。**UI 已接入（2026-09-11，REQ-A46/A47）**：`lib/notesRagRun.ts`（IO 编排，只记 daemon 确认结果）+ `svelte/NotesApp.svelte`「🔍 问笔记」面板（索引→提问→带来源片段，离线诚实明示）+ `svelte/AiApp.svelte`「📚 问我的笔记」（检索→`buildRagPrompt`→chat，用户气泡仍是原问题、模型收到带引用提示，离线明示且照常作答）。见 `docs/offline-rag-pdf.md` / `docs/vector-db-rag.md`。

### 🟠 B. 已写但未接线的"半成品"
8. ~~**`SecurityManager` 未接入 gRPC server**~~ → **✅ 已完成（2026-09-01）**：`AiAgentService` 现在在 `stream_chat`/`chat`/`get_status` 每个 RPC 都执行权限校验 + 每客户端速率限制，并做 token 计量与审计日志；`security.rs` 不再是死代码。客户端身份通过 `x-amos-client` metadata 传递（Tauri 桥接层已发送），`system-ui` 默认授予 `Standard`。见 `server.rs` / `security.rs` / `ai_bridge.rs`。
9. ~~**`EnhancedAndroidManager` 未接入 `AndroidManagerService`**~~ → **✅ 已完成（2026-09-01）**：`service.rs` 现由 `Arc<EnhancedAndroidManager>` 支撑，所有 Android 操作（launch/list/icon）都经过超时保护与 LRU 图标缓存；`server()` 工厂自动用默认增强配置包装 runtime，调用点不变。
10. ~~**`BackendKind` 后端选择未接入 server**~~ → **✅ 已完成（2026-09-01）**：daemon 现持有 `Arc<dyn InferenceBackend>`，`stream_chat`/`chat` 均经 `backend.infer()` 异步流式生成；`build_backend_from_env()` 按 `AMOS_BACKEND`（mock/api/ollama/hermes/ggml）选择后端，选择与接线基础设施真实生效（各后端实际生成见条目 1/2）。

### 🟠 C. 语音交互（2026-09-03 已大幅实做，见 §一 表与 docs/native-voice.md）
11. ~~**语音输入/ASR 未接入**~~ → **✅ 已实做（同传/native 路径）**：`amos-asr`（`StreamingRecognizer`，sherpa feature 门控，headless 用真实模型验证）、`amos-translate` `Transcribe` RPC + `SpeechRecognizer`（Mock/WhisperProvider）、`amos-tauri` `transcribe_audio`。**残留缺口（仅真机采集）**：真机原生采集（现为 WebView `getUserMedia`，非 AAudio/cpal）；daemon 侧 bidi `Payload::Audio`→ASR 通道自 2026-09-03 起已闭合（见下条）。
**2026-09-03 补充（bidi 语音已闭合）**：`amos-ai` 新增 `ChatAsr`（`amos-asr` Mock 默认，`AMOS_ASR_BACKEND=off` 关闭），`server.rs` 对 `Payload::Audio` 逐帧喂识别器，endpoint 到达时把识别文本作为 Prompt 复用既有推理/审计/会话（73 lib 测试通过，见 `docs/bidi-voice-asr.md`）。真机原生采集与真 sherpa 后端仍待接。
**2026-09-04 补充（Audio HAL Bridge 落地，见 `docs/audio-hal-bridge.md`）**：新增 **`crates/amos-audio`**（纯 std）＝音频 HAL 抽象层：`AudioCapture`/`AudioSink` trait、16 kHz 规格/编解码、流式 `LinearDownsampler`、确定性 mock，以及按 `target_os="android"`+feature 门控的**手写直接 FFI** TinyALSA/AAudio 设备 seam（宿主不编译）。`amos-ai` 新增 **`asr-sherpa`** feature：`AMOS_ASR_BACKEND=sherpa` + `AMOS_SHERPA_MODEL_DIR` 时 bidi `Payload::Audio` 走**真 sherpa 本地 ASR**（未配置则诚实回退 `None`，绝不静默降级 mock）；UDS e2e 用真实语音 wav 验证识别→作答闭环。**仍待设备 bring-up 做的事**：在 NDK 交叉目标编译/联调 `amos-audio` 的 android seam；把采集线程接进 System UI（常驻听麦→`Payload::Audio`）；SIM/通话语音流拦截需系统级 HAL/audio-route 钩子。
12. ~~**TTS 语音输出缺失**~~ → **✅ 已实做（headless 验证）**：`amos-tts`（`TtsProvider` Mock/Piper，`piper` feature 门控）+ `tts_synthesize`→Web Audio。真机原生回放仍待接。
13. **多模态输入（图/音/文混合）缺失**。

### 🟠 D. 移动端 / 真机
14. **mobile targets 未初始化**：无 `android/`、`ios/` 平台目录，目前只是桌面。
15. ~~**无真机设备 API**~~ → **✅ 部分完成（2026-09-01 + 2026-09-04）**：**相机**接入 WebView `getUserMedia`（真实取景器 + 拍照存相册，无摄像头时降级演示）；**地图**接入 OpenStreetMap 在线瓦片 + `navigator.geolocation` 定位 + 城市搜索 + 缩放（离线降级）。**2026-09-04**：相机 / GPS-GNSS / IMU 的**领域内核**（`amos-sensor`：`SensorProvider` seam + 确定性 Mock + `SensorManager` 能量策略，见 §一 与 `docs/sensors.md`）已就绪，且其 **gRPC `SensorService` 已挂进 daemon 同一条 UDS**（`amos_ai::serve()` `add_service`，与 AiAgent 同 socket 真 UDS 往返验证）。**仍为后续**：真机 Camera2/Gnss/SensorManager HAL provider（feature `android`）与 System UI Tauri 客户端桥。麦克风、原生 GPS 插件、电话/SMS、联系人等 WebView 侧原生插件仍缺失。
16. ~~**无锁屏 / 解锁**~~ → **✅ 部分完成（2026-09-01）**：锁屏（时钟/日期/通知预览）+ 数字 PIN 密码 + 上滑/按钮解锁已实现；生物识别（指纹/面容）仍缺失。
17. ~~**无首次启动引导（onboarding）**~~ → **✅ 已完成（2026-09-01）**：首次开机进入欢迎流程（介绍 → 外观选择 → 可选设置锁屏密码 → 完成），完成标记持久化到 `amos.onboarded`，之后直接进入锁屏。
18. **无 OTA / 自动更新**。

### 🟡 E. 桌面 OS 级功能
19. ~~**设置不落盘**~~ → **✅ 已完成（2026-09-03）**：`SharedStore`（`amos-tauri/src/store.rs`）现持久化到磁盘——每次写入写回 `AMOS_STATE_FILE`（缺省 `~/.amos/state.json`），重启可恢复且 Rust 侧可读；损坏文件降级为空并可自愈；localStorage 仅作前端缓存。测试覆盖跨实例持久化/删除/损坏容错。
20. **文件系统无真实访问**：files 应用是 mock 静态列表 → **✅ 部分完成（2026-09-01）**：已改为 store 支撑的虚拟文件系统（建文件夹/建文本/查看/删除），但尚未接真实磁盘/Tauri `fs` 插件。
21. ~~**快捷设置不生效**~~ → **✅ 大部分完成（2026-09-01 + 2026-09-04）**：深色模式/亮度真实生效（前端主题 + 遮罩）。**wifi/蓝牙/飞行** 已接 `RadioManager` 策略（飞行级联关 Wi-Fi/蓝牙、飞行中禁开）+ Tauri `radio_status/radio_set` 命令桥 + 持久化镜像（`amos.settings` 跨窗口广播）；桌面走 `MockRadioProvider`，未 bridge 时前端 `flipRadio` 同策略降级。真机 Android 射频后端（`AndroidRadioProvider`，`android` feature JNI 骨架，`cargo check --features android` 可编译）待设备接通。`location` 快速开关已接为**系统级定位主开关**（默认开；关时即使某 app 已授权也拦截 `MapsApp` 的 `navigator.geolocation`，2026-09-04）。`dnd` 快速开关已接为**勿扰**（默认关；开启时首页/dock 未读角标隐藏、通知中心列表静音呈现，2026-09-04）。
22. **无应用生命周期管理**：无后台/墓碑/冻结/进程调度 → **✅ 内核+装配已落地（2026-09-04）**：`amos-applife` 状态阶梯 + LRU/LMK-proxy 回收（docs/app-lifecycle.md）；daemon `ResourceGovernor` 在低电时自动把后台 App 冻结到 Cached(墓碑)。真 per-app 进程宿主为 runtime seam。**2026-09-12 补（REQ-A146）**：host↔容器两个 registry **可能分叉**——反向驱动的 `freeze/thaw/destroy/force_stop` 失败、以及容器报的 tier host 无法表示（`Visible` 无 host 对应态，`move_app` 恒 `InvalidTransition`）——这些失败以前是 `let _ =`（既无重试也无日志，governor 记着 Cached **不会重试**）。现在**逐处记 `warn`**（`mirror_failed`，按 op/package/error），并有**捕获日志的测试**；**2026-09-12 再补（REQ-A148，wire 入口）**：同一分叉的**第二个入口**（`AndroidManagerService::apply_host_action`，宿主/System UI 经 `ApplyHostDecision` 下发）此前不仅沉默，还**发假事件**——容器拒绝 `Freeze` 时仍然广播 `Frozen`（订阅者以为 app 已墓碑）。现在拒绝即 `warn` 且**不发那条事件**，Reclaim 的 `force-stop`/`destroy` 失败也 `warn`；**仍未做**：分叉的**自动收敛**（不重试、不修复，一致性依旧依赖"容器事件流为权威来源、靠事件自愈"的约定），以及给 host 增加 `Visible` 对应 tier 的模型层改动。
23. ~~无全局搜索~~ → **✅ 大幅完成（Spotlight 式面板 + 四类内容检索）**：`svelte/SpotlightPanel.svelte` 打开即聚焦搜索框（rAF 聚焦以唤出软键盘）、`lib/focusTrap` 键盘焦点陷阱 + Esc 关闭；结果**分组**显示——**应用**（`APP_META` 按本地化名/id 过滤）、**笔记**（用领域自身的 `lib/notes.searchNotes` 全文匹配，行标题走 `noteTitle`）、**文件**（`lib/files.searchFiles` 且 `includeContent=true`，即**按文件内容**匹配，行内显示 `folderPath` 面包屑）、**联系人**（`lib/contacts.searchContacts`，名称与号码）；四个分组任一为空则不渲染，全空才显示「未找到匹配项」。选中应用即打开；选中笔记经 `appLinks.openNote`（`notes` 深链通道）**直达该便签**（活跃便签进全页编辑器，归档/回收站的便签切到对应页并展开）。选中文件/联系人走新的 `files`/`contacts` 深链通道（`appLinks.openFile`/`openContact`）：这两个屏幕**没有单条目页面**，所以不假装有——链接只要求它们**诚实做得到的事**：清掉会挡住目标的筛选/搜索、把目标放到屏幕上并**标记**该行（`data-spotlight="hit"`），文件还会先跳到它**真正所在的目录**。三种链接一律**消费一次**（通道清空，重开不会重复触发，新 nonce 可再次触发），且**目标已不存在时诚实忽略**（不伪造便签/文件/联系人）。**边界**：系统动作（设置开关、拨号等）仍**不在**检索范围；无跨应用"最近使用/常用"排序，也无拼音/模糊匹配。**2026-09-12 补全（REQ-A127）**：边界收窄一格——Spotlight 现在**能“做”一件事**：查询非空时出现 **「动作」** 分组，唯一动作是 **`新建笔记「{q}」`**（把搜索框里的文字**存成便签**并直达该便签，走 `prependNote` + `writeStoreValueChecked` + 既有 `openNote` 深链）。**诚实性**：空查询**不提**该动作（没有内容可存）；写入**被拒**（存储满/不可用）⇒ 显示失败横幅、**面板不关闭**、查询文字**原样留着**（绝不「关闭即已保存」）。**仍刻意不做**：拨号与设置开关——它们需要**尚不存在**的手机/设置深链，猜一个比留着边界更糟（如要做，先补 `appLinks` 的通道与目标的接受契约）。**2026-09-12 又补（REQ-A128）**：**拨号那一半做掉了**——新增 `appLinks.PHONE_CHANNEL` + `dialNumber(n)`（PropsChannel，与 Messages 的 compose 链接**同一套契约**：非空才发、带 nonce 可重复触发、目标**消费一次**），PhoneApp 收到后**预填拨号盘并切回键盘页**、清掉上一次的 `dialError`。**关键诚实点**：链接**绝不自动拨号**（拨号是用户的动作；`lib/phone.dialableQuery` 负责判断查询**真是**号码——数字 + `+*#` 与常见分隔符、至少两位数字，分隔符剥掉并截到 `MAX_DIAL_LEN`，所以「买牛奶」不会变成号码），测试用**桥调用断言**（`telephony_dial` **不得出现**）而不是看 UI，负控证明它能抓到自动拨号。**设置开关仍不做**（同样缺深链）。**2026-09-12 再补（REQ-A129）**：**设置那一半也做掉了**，但**不是**用「猜页面」的方式——新增 `appLinks.SETTINGS_CHANNEL` + `openSettingsSearch(q)`，Spotlight 对**任意非空查询**提供第三个动作 **`在设置中搜索「{q}」`**：只把文字**交给设置自己的索引搜索**（回到 index 页 + 预填搜索框 + 滚回顶部），**不替用户挑页面**——设置索引搜索本来就知道每个页面、它们的**同义别名**与**实时取值**，比这里任何猜测都更准。**诚实性**：搜索链接**只导航、不拨动任何开关**（改设置仍是用户在页面上的一次按压）；链接**消费一次**，`nonce` 变更可重触发；查询为空时**不显示**该动作。**2026-09-12 再补一格（REQ-A130）**：**跨应用「最近使用」排序做掉了**——Spotlight 的**应用结果**不再只按注册表顺序：新增纯函数 `lib/appGroups.orderByRecency(items, idOf, recents)`，按**本机真实使用记录**排序（复用 App Library「常用」同源的 `amos.recents`，最近打开的在前）。**诚实点**：**没打开过 = 不排名**（不是"不显示"）——未使用过的应用保持注册表顺序，`recents` 为空时**原样返回**，所以新设备上不会看到凭空捏造的"热门"排序；顺序仍在 `slice(0,12)` **之前**施加，否则很靠后的常用应用永远进不了榜。**仍缺**：拼音/模糊匹配（需要拼音数据表）、按**频次**（当前 store 只存去重后的最近列表，故这里是"最近"而非"次数"）。
24. **无系统托盘、全局快捷键、多显示器支持**。
25. **无后台任务调度器** → **✅ 内核+装配已落地（2026-09-04）**：`amos-scheduler`（AlarmExact vs Deferred、Doze 门控、合并对齐、next_wake，docs/scheduler.md）；daemon `ResourceGovernor` 在节电/Doze 时压住 Deferred、恢复/维护窗跑合并批。真 AlarmManager/JobScheduler/Doze 绑定为 seam。

### 🟡 F. 前端应用多为演示占位
26. ~~相机=mock 取景器，地图=样式化占位，文件=mock 列表，照片/电话/信息/音乐/时钟/笔记 多为静态 UI~~ → **✅ 大幅完成**：**相册**、**文件**、**相机**（`getUserMedia`）、**地图**（OSM+定位）、**音乐**（Web Audio 合成播放器 + store 播放列表）均已做实。**信息已接真机 SMS**（`AndroidSmsProvider` + `SmsGlue`：真发送/接收、收件箱/发件箱/草稿、屏蔽过滤、跨进程事件桥）；**电话**真机 `ACTION_CALL` 起呼已接，但**接听/挂断/录音/实时状态仍是显式 `Provider(...)` 未实现骨架**（`docs/telephony.md`）。
27. ~~无真实相册、真实通信、真实媒体播放~~ → 相册与媒体播放（音乐）真实；**通信已部分真实**：SMS 收发为设备真链路，来电/去电控制（`answer`/`end`/录音/实时 `status`）与 InCallService 仍为骨架（诚实返回未实现，不假装）。

### 🟡 G. 安全与隐私
28. **UDS 仅 0o700 权限，无认证/授权/加密**。**2026-09-12 部分补全（REQ-A141）**：**认证那一半做掉了**——UDS 接受连接时向内核要**对端凭据**（Linux/Android `SO_PEERCRED`、macOS/BSD `getpeereid`），**不同用户一律拒绝**（`crates/amos-ai/src/peercred.rs`；`PeerGuard` 在 accept 循环里判定，被拒连接**根本不进 tonic**，且每次拒绝都记日志）。**为什么必须加**：`0700` 是**文件系统属性、不是认证**——socket 路径被复制/替换、父目录共享或是 root 拥有时它都拦不住，也**分不清"我们的 UI"与同一用户下的任意进程**。策略 `AMOS_UDS_PEER`：`enforce`（默认）/`warn`（只记日志，诊断用）/`require`（**连"问不到凭据"也拒绝**）；"问不到"默认**放行但记 warn**（绝不静默）。**仍然缺**：**授权**（无按客户端的能力校验）、**加密**（明文 UDS）、**pid 校验**（不做，pid 有竞态且对用户判定无必要）。**2026-09-12 又补（REQ-A142，TCP 那一半）**：`AMOS_TCP_ADDR` 的**环回 TCP** 传输此前**既无 0700 也无凭据检查**（环回对设备上任何进程可达）。现在：`AMOS_TCP_TOKEN` 设置后**每条请求必须带 `x-amos-token`**，否则**路由前**以 `PermissionDenied` 拒绝（常量时间比较；`InterceptorLayer` 覆盖全部服务）；**未设置则仍服务但启动 warn 明说无认证**；UDS **刻意不看**该 token。另把 `AMOS_TCP_ADDR` 改为**严格解析 + 强制环回**（非环回拒绝启动，`AMOS_TCP_ALLOW_REMOTE=1` 为显式告警逃生口），并把**格式错误从"静默退回 UDS"改为启动报错**。**TCP 侧仍缺**：TLS、token 轮换/按客户端区分、授权。**2026-09-12 又补（REQ-A144，客户端那一半）**：应用自身的 TCP 客户端（`amos-tauri::daemon`）此前**不发 token**——R79 只把它记账，因为"把 header 穿过 ~10 个类型化客户端"看起来是设备路径的活。本轮把它做掉了：新增泛型包装 `TokenChannel<S>`（实现 `tonic::client::GrpcService<Body>`，只填不覆盖调用方自带的 header），**在通道工厂处**统一挂 `x-amos-token`，因此**没有任何调用点需要记得这件事**；UDS 传输**刻意不挂**（守护进程在该传输上也不看它，避免无关 env 把 shell 锁在自己的 socket 外）；token 非法/空 ⇒ **构造时**丢弃并告警（发一个和配置不同的值比不发更糟）。端到端测试（`crates/amos-tauri/tests/tcp_token_client_e2e.rs`）用**真实守护进程 + 真实通道工厂**证明：配了 token ⇒ 被服务；**同一个客户端**去掉 token ⇒ `PermissionDenied`（说明前一步是靠 header 而不是靠宽松）；错 token ⇒ 拒；**UDS 上留着 `AMOS_TCP_TOKEN` 也不受影响**。真机 bring-up 脚本仍**没有**自动化覆盖（这是 token 仍然可选的原因）。
29. **无密钥管理、无端到端加密**。
30. ~~无用户/多用户模型落 UI~~ → **✅ 已完成（能力视图）**：`PermissionsApp`（按能力列出持有者 + 按应用列出所持能力，含本地↔守护进程**漂移**标记）+ 设置页 `PrivacyPage`（应用能力台账 + **系统媒体访问**管理）+ 8 处**应用内授权提示**（相机/地图/放大镜/语音备忘/同传/3 个语音麦），全部经单一缝 `svelte/osPermissions.ts` 落本地账本并镜像守护进程。**边界**：仍是**单用户**模型，无多用户账号隔离。
31. ~~无权限弹窗 / 隐私看板~~ → **✅ 已完成**：应用内能力提示（`perm.*` 文案，allow/deny）+ 隐私看板（`PermissionsApp`）+ 设置页隐私区；守护进程的「最近访问」审计链在桥可用时显示，离线**隐藏**而非伪造。

### 🟡 H. 可观测性 / 运维
32. ~~**无监控指标**（`monitoring.rs` 未创建）~~ → **✅ 已完成（2026-09-03）**：`amos-ai` 新增 `monitoring.rs`——`Monitor` 无锁计数（rpc_total、uptime、周期心跳）经 tonic interceptor 集中统计；`StatusReply` 现携带 `rpc_total`/`heartbeats`，任意 `GetStatus` 探针即可读实时指标；`AMOS_METRICS_INTERVAL_SECS` 调周期。
33. ~~**无周期性健康检查/探针**（`GetStatus` 仅 boot 时查一次）~~ → **✅ 已完成（2026-09-11）**：daemon 侧周期自健康心跳（heartbeat 计数 + 指标日志）随 `serve()` 启停；**客户端侧定时探针**也已在 AI 设置页落地——页面打开且**可见**时每 10 秒重读 `get_status`（驱动 `describeEngine` 的引擎/模型/降级/池/缓存读数），并显示「上次探测 HH:MM:SS」，因此守护进程掉线/降级/换引擎会即时反映而不再留着过期快照；隐藏标签页**不**轮询（不是后台探针）。
34. ~~**无日志持久化/聚合**（tracing 仅 stdout）~~ → **✅ 已完成（2026-09-11）**：`crates/amos-ai/src/logfile.rs` —— **有界、自轮转**的文件 sink（**纯 `std`、零新依赖**）：`AMOS_LOG_DIR` 指定目录（未设 ⇒ `$HOME/.amos/logs`；`off`/`none`/`0`/空 ⇒ 仅 stdout）、`AMOS_LOG_MAX_BYTES`（默认 5 MiB）、`AMOS_LOG_KEEP`（默认 3，硬上限 64，防止坏 env 占满磁盘）。`tracing_subscriber` 经 `TeeWriter`（`MakeWriter`）**同时**写 stdout 与文件，启动时如实打印 sink 状态（active / unavailable / disabled）；轮转只发生在**行边界**（文件绝不半条记录结尾）；**任何 IO 失败一律降级为仅 stdout**（stderr 告警一次），绝不因日志把无头守护进程带崩。验证：单测 **6**（env 策略/大小与 keep 解析/轮转上界/行边界/降级不 panic）+ **真跑** `target/debug/amos-ai` 确认落盘 8 行且 stdout 输出不变、`AMOS_LOG_DIR=off` 时**不建**日志文件。**边界**：**聚合**（转发/远端收集）仍无——落地的是本地文件，不是采集栈。**（补充 2026-09-11）落盘健康上 wire**：`get_status.log_sink` 报告 `enabled/path/bytes_written/lost_bytes/write_failures/rotations/active_bytes`（未接线时是"无 sink"的诚实零），System UI 会显示"已落盘 N 字节"并在**丢失字节/写入失败 > 0** 时显式告警——"轨迹不完整"不再只留在守护进程的 stderr 里，见 REQ-A87。
35. **无缓存层 / 连接池**（~~`cache.rs`、`pool.rs` 未创建~~ **已于 2026-09-11 补全**：`pool.rs` = `GenerationPool` 生成准入池（`AMOS_MAX_SESSIONS` 已接线，REQ-A43）；`cache.rs` = `ResponseCache` + `CachingBackend`（默认关，`AMOS_RESPONSE_CACHE=1`，REQ-A44）；见 `docs/daemon-resource-gate.md`）。
36. ~~**无基准/压力/混沌测试**~~ → **✅ 部分完成（2026-09-11）**：新增 `crates/amos-ai/tests/load_test.rs` —— 经**真实 UDS** 的**有界**负载/混沌测试：16 个并发 `StreamChat` 打向容量 **4** 的准入池（`AMOS_MAX_SESSIONS=4`），断言 ①无调用超时（超时即**断言失败**，绝不挂住 CI）；②负载**进行中**的 `GetStatus` 采样**必须成功**且满足 `in_flight + available == capacity`、`in_flight <= capacity`；③风暴后 `in_flight == 0`（不泄漏槽位）、`acquired_total >= 成功数`；④所有失败必须是**分类明确**的 `ResourceExhausted`（不吞错）。**该测试当轮就抓到真实缺陷**：守护进程的**存活探针与生成请求共用同一个限流桶**（默认 10 req/s/client），生成突发会让 `GetStatus` 被安全层以 `ResourceExhausted` 拒绝——**忙的时候反而看不见"守护进程是健康的"**；已修（探针独立限流桶，见 #36 同轮 REQ-A82）。**边界**：这是**有界功能型**负载测试，**不是**基准/性能回归框架（无 microbench、无吞吐/延迟基线、无长时间 soak）；"混沌"仅限"拒绝-降级-恢复"这一族，未做故障注入（网络/磁盘/信号）。

### 🟢 I. 生态 / 分发
37. ~~**无应用市场 / 只能从精选列表启动**~~ → **✅ 已实做（2026-09-03）**：`amos-appstore` 领域内核（manifest + sha256 + download→verify→install/upgrade/uninstall + 注册表持久化）之外，**Ed25519 发布签名**、**HTTP 目录后端**（`live` feature）、`amos-appstore-cli`、Tauri `StoreBridge`、商店 UI（`StoreApp.tsx`）与**动态主屏注入已安装应用**（`lib/storeApps.ts`、`store:<mid>` tiles，tapping 打开 `ExtApp` 占位容器）均已落地（见 `CHANGELOG.md`）。**剩余缺口**：装的是 **web-bundle 而非 Android APK**；无 PackageInstaller 特权静默安装；无云端 GMS 依赖合规审计/沙盒代理；且"web-bundle vs APK"机制需先定夺（见 §六）。契约与路线图见 `docs/appstore.md`。
38. ~~**无开发者 SDK / API 文档站**~~ → **✅ 部分完成（2026-09-11）**：新增零依赖生成器 **`scripts/proto-doc.mjs`**（与 `unwired-scan.mjs`/`hot-loop-scan.mjs` 同风格：只用 `node`，不装 protoc 插件，**不执行也不 import** 被检查的代码），把 `proto/*.proto` 渲染成 **`docs/api-grpc.md`**（**1268 行**）：索引表（每文件的 package/服务数/RPC 数/消息数/枚举数，锚点按 GitHub slug 规则生成）+ 逐文件的服务→方法表（**Method / Request / Reply / Kind（unary·server streaming·client streaming·bidi）/ 注释**）+ 消息字段表（字段名/类型/编号/`repeated`·`optional`·`oneof` 归属/注释）+ 枚举值表——**注释全部来自 proto 自身的文档注释**（含"诚实边界"原文，如 `NoteEgress` 仅在 `AMOS_NETGUARD_ALLOW_INJECT=1` 时可用）。当前覆盖 **9 个文件 / 10 个服务 / 58 个 RPC / 114 个消息 / 18 个枚举**。**防漂移**：生成器内建 `--check`（与检出文件逐字节比较，不一致即 `exit 1` 并打印"checked-in vs generated"的首个差异行）与 `--selftest`（20 条解析/渲染断言，含 file header、`oneof`、`map<>`、`repeated`/`optional`、stream 标记、枚举注释与 GFM 表格转义），二者均接入 `make lint`（CI 的 `lint-and-test` 已跑 `make lint`），另加 `make api-docs` 用于重新生成。**边界**：这是 **gRPC 契约文档**（OS 内部/同机 API，共享一个 UDS），**不是**跨语言 SDK（无 pip/npm/cargo 客户端包、无 stub 生成）也**不是**托管文档站（无站点/搜索）；REST/OpenAPI 面不存在故未覆盖。
39. ~~**CI 无发布产物**（release artifacts）~~ → **✅ 已完成（2026-09-11）**：新增 `scripts/release-artifacts.sh` 作为**发布内容的唯一真源**（`make release-artifacts` 与 `.github/workflows/release.yml` 都只调它，故 CI 产物在维护者机器上可原样复现）：`cargo build --release --locked` 构建 **8 个无头二进制**（`amos-ai`/`amos-supervisor`/`amos-translate`/`amos-int-cli`/`amos-mail-cli`/`amos-appstore-cli`/`amos-timesync-cli`/`amos-pdf-parser`）→ 暂存 `dist/amos-<version>-<target>/{bin/,VERSION,README.txt}` → `tar.gz` + `SHA256SUMS`。**并顺手补上真实缺口**：其中 **6 个 CLI 原先不认识 `--version`**（发布后无法自证身份），已为全部 8 个二进制补 `-V/--version`（`<name> <version>`，USAGE 同步记录，解析层与打印串均有单测），且**脚本会逐个执行 `--version` 并在版本不匹配时中止发布**——"不能自报版本的产物不允许发布"。CI：`v*` tag 触发 `Release` workflow，矩阵**仅原生**（`ubuntu-24.04`=x86_64-linux、`macos-14`=aarch64-darwin，无交叉编译风险），每条腿 `upload-artifact`（`if-no-files-found: error`）；`publish` 任务先 `sha256sum -c SHA256SUMS` **校验**再建/更新 GitHub Release（用预装 `gh`，不引入第三方 release action）。**边界**：**不含** Tauri 桌面包与 Android APK（另有构建路径，tarball 内 README 明说）、暂无 arm64-linux 腿、无签名/公证/SBOM、`--locked` 级可复现而非逐位可复现。**（补充 2026-09-11）标签一致性**：`vX.Y.Z` 标签构建会传入 `AMOS_RELEASE_TAG`，与打包版本不符即**拒绝发布**（防止"用 v0.2.0 的名义发布 0.1.0 的内容"）；版本解析改为**只读 `[workspace.package]` 段**（原先按行取首个 `version =`，依赖版本在前时会静默改名），见 REQ-A86。

### ⚪ J. 本质定位
40. **当前是 Tauri 桌面应用模拟移动 OS**，不是可引导 OS；`deploy/android` 只有 init.rc 骨架，无内核/启动器/bootloader 真实集成。

---

## 三、Phase 2 报告里点名"下一步"但尚未完成的事项
（来源：`PHASE2_COMPLETION_REPORT.md` / `CODE_COMPLETION_SUMMARY.md`）
- [x] 集成 `SecurityManager` 到推理 gRPC 服务（✅ 2026-09-01，`server.rs`）
- [x] 集成 `EnhancedAndroidManager` 到 AndroidManager 服务（✅ 2026-09-01，`service.rs`）
- [x] 实现真实 GGML/llama.cpp 后端（✅ 部分 2026-09-04：外部 `allama` 子进程路径 + `AMOS_GGML_STRICT=1` 诚实报错开关已落地；进程内 C 绑定与厂商 NPU 运行时仍待真机 + SDK，见 `docs/qcom-mtk-bringup.md`）
- [x] 实现 `monitoring.rs`（性能指标/健康检查，✅ 2026-09-03）
- [x] 连接池 `pool.rs`、缓存层 `cache.rs`（✅ 2026-09-11：`GenerationPool` 生成准入池 + `ResponseCache`/`CachingBackend`，REQ-A43/A44，`docs/daemon-resource-gate.md`）
- [x] 会话持久化（✅ 2026-09-01，`SessionManager` + `AMOS_SESSIONS_PATH`）
- [x] 压力/负载测试（✅ 2026-09-11，**部分**）：`crates/amos-ai/tests/load_test.rs` 经真实 UDS 做**有界**并发负载（16 并发 `StreamChat` vs 容量 4 的准入池）+ 池不变量采样 + 失败分类断言 + 风暴后恢复检查。**同轮抓到并修复**：存活探针与生成请求共用限流桶导致忙时 `GetStatus` 被拒（REQ-A82）。**边界**：非 benchmark 框架（无基线/无 soak/无故障注入）。
- [ ] **静默丢弃的结果：只有棘轮的存量未逐处审计**（2026-09-12，REQ-A146/A147/A148）。类型判定（`clippy::let_underscore_must_use`）数出生产代码 **152 处**对 `#[must_use]` 值写 `let _ =`（35 文件；R82 起 165 → R83 修 9 → R84 修 4）。`crates/amos-ai`（含 `rag_service.rs`）、`crates/amos-supervisor`、`crates/amos-android/src/service.rs`、`crates/amos-tauri/src/ai_bridge.rs`、`wm.rs`、`assistant_voice.rs` 的站点已**逐处读过**（真问题均已修：守护进程 host/容器分叉 6 处、监督进程回收失败、云端 key 落盘/权限、窗口布局与表面注册、**wire 路径的假 `Frozen` 事件**、RAG 缺失/损坏不分、语音结尾帧丢弃），其余文件**只是记账**：`scripts/rust-discard-baseline.json` 是**棘轮**（拦增长、降下来提示 stale），**不代表存量已被审计**。另有一个**否定结果**：`.ok()`（189 处）**刻意不上闸**——多为 env/parse 取默认值的惯用写法，正则无法区分"缺失"与"读不出来"（判据写在 `scripts/rust-discard-scan.mjs` 顶部）。

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
