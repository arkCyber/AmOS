# AmOS 功能差距分析 (Functional Gap Analysis)

**日期**: 2026-09-01
**范围**: 全 workspace（amos-proto / amos-ai / amos-wm / amos-android / amos-tauri）

---

## 一、已实现且真实可用的能力

| 能力 | 状态 | 说明 |
|------|------|------|
| gRPC over UDS 全链路 | ✅ | Tauri core ↔ amos-ai daemon，单 UDS 同时承载 AiAgent + AndroidManager 两个服务 |
| AI 助手（文本流式） | ✅ | `StreamChat` / `Chat`(bidi)，token 流式渲染、`Cancel` 取消、系统上下文注入 |
| **语义 UI 卡片协议** | ✅ | 2026-09-01：AI 意图识别引擎（`semantic.rs`）把"天气/音乐/笔记/钱包/打开"意图转为结构化 `UiCard`，经 UDS gRPC → Tauri 桥 → `ai-card-received` 事件 → 前端 `cards.js` 动态渲染交互卡片（AI 直接驱动 UI） |
| 会话管理 | ✅ | 会话创建/清理/上下文（内存态） |
| 窗口管理器 | ✅ | `amos-wm` 状态机 + Tauri 适配，多窗口、焦点、外部 surface 跟踪 |
| 跨窗口共享存储 | ✅ | `SharedStore` + `store-updated` 广播，多窗口同步 |
| **进程管理器 `amos-supervisor`** | ✅ | 2026-09-01 新增 crate：拉起/监控/热重启 CLI 守护进程，重启策略（上限+指数退避）、`stop`/`shutdown_all` 优雅关闭、`status`/`list` 查询 |
| **CLI daemon 编排入口** | ✅ | 2026-09-01：`amos-supervisor` 二进制 + JSON 配置（`deploy/daemons.json`），`amos-supervisor check|run <config>` 统一校验/启动/监控 amos-ai 与 amos-translate；`SupervisorConfig`/`load_config`/`start_all` 库支持 |
| **硬件按钮（Home/语音/AI）** | ✅ | 2026-09-01：`amos-tauri/src/buttons.rs` 抽象 + `hardware-button` 事件 + `simulate_button` 命令 + 前端 `window.AmosButtons` 路由 + 桌面键盘快捷键；平台驱动接入点见 `docs/hardware-buttons.md` |
| **语音转写（ASR）管线** | ✅ | 2026-09-01：`amos-translate` 新增 `Transcribe` RPC + `SpeechRecognizer` trait（Mock/WhisperProvider）+ 流式音频段转写；`amos-tauri` `transcribe_audio`/`translate_text` 命令 + 前端 `window.AmosVoice`；`deploy/daemons.json` 默认 `AMOS_ASR_BACKEND=mock` |
| **同传领域引擎 `amos-int`** | ✅ | 2026-09-01：传输无关会话状态机（Idle→Collecting→Interpreting→Speaking）+ `UtteranceBuilder`（流式 partial→stable→final）+ `Pipeline` trait + `BothMode`；`SessionEvent` 进 / `InterpretationOutput` 出 |
| **同传 daemon 桥接 `GrpcPipeline`** | ✅ | 2026-09-01：`Pipeline` 的 gRPC 实现，`StreamTranslate` 音频路径做 ASR + 一元 `Translate` RPC 翻译；断线自动重连（translate/audio 失败均 `invalidate` 缓存）|
| **流式 ASR `amos-asr`** | ✅ | 2026-09-01：`StreamingRecognizer` trait（partial/hypothesis/endpoint）+ 确定性 `MockStreamingRecognizer` + `AsrPipeline`（组合本地 ASR + 远端翻译）；sherpa-onnx 后端以 `sherpa` feature 门控（需联网下载预编译库）|
| **TTS `amos-tts`** | ✅ | 2026-09-01：`TtsProvider` trait + 确定性 `MockTtsProvider` + `PiperProvider`（`piper` feature 门控）；Tauri `tts_synthesize` 命令 → Web Audio 播放 |
| **同传 CLI `amos-int-cli`** | ✅ | 2026-09-01：stdin 进文本、译文出，`.lang`/`.status`/`.pause`/`.resume`/`.stop` 命令；驱动 `Session` + `GrpcPipeline` |
| **同传 App（GUI）** | ✅ | 2026-09-01：`frontend/js/apps/interpreter.js` — 语言选择、会话控制、麦克风采集（16k mono→`AmosInterp.audio`）、流式 partial/译文渲染、`🔊 朗读`（`AmosTts`）；已入 dock |
| **全链路冒烟** | ✅ | 2026-09-01：`amos-translate/tests/full_chain.rs` 无头跑通 音频→partial→daemon 译文→TTS 音频；`scripts/gui-smoke.sh` 真机一键冒烟 |
| 通知中心 + 快速设置 | ✅ | 下拉面板、快捷开关、亮度/音量滑块、通知列表（localStorage） |
| 锁屏 / 解锁（含 PIN） | ✅ | 2026-09-01 补全：时钟/日期、通知预览、PIN 数字密码、上滑/按钮解锁 |
| 最近使用 / App 切换器 | ✅ | 2026-09-01 补全：主屏指示条上滑进入 Recents，卡片式切换 |
| 深色模式 / 亮度调节 | ✅ | 2026-09-01 补全：设置开关真实生效（浅色主题 CSS 变量 + 全屏亮度遮罩） |
| Android 兼容层 | ✅ | Waydroid 运行时（真机）+ DemoRuntime（演示），launch/list/icon 已接线 |
| 安全层代码 | ✅(未接线) | rate limit / audit / permission 已写好，但未挂到 gRPC 服务 |
| 桌面 Tauri 壳 + 移动 UI | ✅ | 模拟手机桌面的系统 UI |

---

## 二、核心缺口（按优先级排序）

### 🔴 A. AI / 推理核心 —— 最高优先级
1. ~~**真实推理引擎未接入**~~ → **✅ 大幅完成（2026-09-01）**：`ApiBackend`（OpenAI 兼容 SSE）、**`OllamaBackend`**（直连本地 Ollama，`/api/tags` 健康检查）、**`HermesAgentBackend`**（接 Hermes-Rust agent，解析原生 `{"type":"token"}` 帧做真实逐 token 流式，`/health` 探测）均已实现；`AMOS_BACKEND=api|ollama|hermes` 即可接入。`GgmlBackend`（本地 GGML/llama.cpp）`infer` 仍为 stub。
2. **无模型加载**：本地 GGML/llama.cpp 未绑定（需引入 `llama-cpp-rs`/`candle` 原生依赖）；`ApiBackend` 已不需要本地模型。
3. **GPU/NPU 加速无实现**：`Config.enable_acceleration` 存在但无对应后端。
4. **无 function calling / 工具调用**：`BackendMetadata.supports_function_calling` 为 false，AI 无法调用系统能力。
5. **无多模态（图像理解）**：`supports_images` 为 false。
6. **无长期记忆/会话持久化**：会话仅内存，重启即失。
7. **无 RAG / 本地检索**：无 embedding 索引，无法"询问我的文件/笔记"。

### 🟠 B. 已写但未接线的"半成品"
8. ~~**`SecurityManager` 未接入 gRPC server**~~ → **✅ 已完成（2026-09-01）**：`AiAgentService` 现在在 `stream_chat`/`chat`/`get_status` 每个 RPC 都执行权限校验 + 每客户端速率限制，并做 token 计量与审计日志；`security.rs` 不再是死代码。客户端身份通过 `x-amos-client` metadata 传递（Tauri 桥接层已发送），`system-ui` 默认授予 `Standard`。见 `server.rs` / `security.rs` / `ai_bridge.rs`。
9. ~~**`EnhancedAndroidManager` 未接入 `AndroidManagerService`**~~ → **✅ 已完成（2026-09-01）**：`service.rs` 现由 `Arc<EnhancedAndroidManager>` 支撑，所有 Android 操作（launch/list/icon）都经过超时保护与 LRU 图标缓存；`server()` 工厂自动用默认增强配置包装 runtime，调用点不变。
10. ~~**`BackendKind` 后端选择未接入 server**~~ → **✅ 已完成（2026-09-01）**：daemon 现持有 `Arc<dyn InferenceBackend>`，`stream_chat`/`chat` 均经 `backend.infer()` 异步流式生成；`build_backend_from_env()` 按 `AMOS_BACKEND`（mock/api/ggml）选择后端，`BackendKind::build()` 对三种后端都返回可用实例（Mock 不再报错）。GGML/API 的 `infer` 仍是 stub（返回 mock 文本），但选择与接线基础设施已真实生效。

### 🟠 C. 语音交互
11. **语音输入/ASR 未接入**：proto 已留 `audio` 字段，README 明确 "ASR 未接入"，无麦克风→ASR→`audio` 管线。
12. **TTS 语音输出缺失**。
13. **多模态输入（图/音/文混合）缺失**。

### 🟠 D. 移动端 / 真机
14. **mobile targets 未初始化**：无 `android/`、`ios/` 平台目录，目前只是桌面。
15. ~~**无真机设备 API**~~ → **✅ 部分完成（2026-09-01）**：**相机**接入 WebView `getUserMedia`（真实取景器 + 拍照存相册，无摄像头时降级演示）；**地图**接入 OpenStreetMap 在线瓦片 + `navigator.geolocation` 定位 + 城市搜索 + 缩放（离线降级）。麦克风、GPS 原生插件、传感器、电话/SMS、联系人仍缺失。
16. ~~**无锁屏 / 解锁**~~ → **✅ 部分完成（2026-09-01）**：锁屏（时钟/日期/通知预览）+ 数字 PIN 密码 + 上滑/按钮解锁已实现；生物识别（指纹/面容）仍缺失。
17. ~~**无首次启动引导（onboarding）**~~ → **✅ 已完成（2026-09-01）**：首次开机进入欢迎流程（介绍 → 外观选择 → 可选设置锁屏密码 → 完成），完成标记持久化到 `amos.onboarded`，之后直接进入锁屏。
18. **无 OTA / 自动更新**。

### 🟡 E. 桌面 OS 级功能
19. **设置不落盘**：`SharedStore` 仅内存 + localStorage，重启丢失（Rust 侧无磁盘持久化）。
20. **文件系统无真实访问**：files 应用是 mock 静态列表 → **✅ 部分完成（2026-09-01）**：已改为 store 支撑的虚拟文件系统（建文件夹/建文本/查看/删除），但尚未接真实磁盘/Tauri `fs` 插件。
21. ~~**快捷设置不生效**~~ → **✅ 部分完成（2026-09-01）**：深色模式与亮度现在真实生效（浅色主题 + 亮度遮罩）；wifi/蓝牙/飞行等仍为模拟开关（未接系统能力）。
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
32. **无监控指标**（`monitoring.rs` 未创建）。
33. **无周期性健康检查/探针**（`GetStatus` 仅 boot 时查一次）。
34. **无日志持久化/聚合**（tracing 仅 stdout）。
35. **无缓存层 / 连接池**（`cache.rs`、`pool.rs` 未创建）。
36. **无基准/压力/混沌测试**。

### 🟢 I. 生态 / 分发
37. **无应用市场 / APK 安装**（只能从精选列表启动）。
38. **无开发者 SDK / API 文档站**。
39. **CI 无发布产物**（release artifacts）。

### ⚪ J. 本质定位
40. **当前是 Tauri 桌面应用模拟移动 OS**，不是可引导 OS；`deploy/android` 只有 init.rc 骨架，无内核/启动器/bootloader 真实集成。

---

## 三、Phase 2 报告里点名"下一步"但尚未完成的事项
（来源：`PHASE2_COMPLETION_REPORT.md` / `CODE_COMPLETION_SUMMARY.md`）
- [ ] 集成 `SecurityManager` 到推理 gRPC 服务
- [ ] 集成 `EnhancedAndroidManager` 到 Tauri/AndroidManager 服务
- [ ] 实现真实 GGML/llama.cpp 后端
- [ ] 实现 `monitoring.rs`（性能指标/健康检查）
- [ ] 连接池 `pool.rs`、缓存层 `cache.rs`
- [ ] 会话持久化
- [ ] 压力/负载测试

---

## 四、建议的推进路线

### 短期（让"已有"真正生效）
1. ~~**把 SecurityManager 接进 AiAgentService**（每请求 rate-limit + audit + permission）~~ → **✅ 已完成（2026-09-01）**
2. ~~**JSON 语义 UI 协议**（AI 驱动 UI 卡片）~~ → **✅ 已完成（2026-09-01）**：`proto/UiCard` + `semantic.rs` 意图引擎 + 桥接事件 + `cards.js` 动态渲染。
3. **把 EnhancedAndroidManager 接进 AndroidManagerService**（timeout + 图标缓存）。
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
