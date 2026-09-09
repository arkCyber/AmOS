# AAudio 采集 → 本地 Sherpa ASR 真机接线 runbook

**日期**: 2026-09-05
**状态**: 🟢 **host 端已验收**（三种 Android ABI 交叉编译全绿 + AAudio 对 NDK `libaaudio.so` 真链接）+ 🔴 真机 runtime 待设备验收（诚实边界）。

本文回答：**「把真机麦克风 AAudio 采集送进本地 Sherpa ASR，再进 daemon 的 bidi `Payload::Audio`」这条设备接线，具体怎么在真机上跑通、每一步怎么验收。** 只含 host 可验证的代码/脚本/CI，不含设备侧需写的真机代码（seam 与门面已就绪，真机只需「接线」不用「新写采集逻辑」）。

## 0. 一句话结论

全链路软件已在仓库内就位：`AAudioCapture`（16 kHz mono，手写 FFI）→ `PlatformMic::open_device()`（门面）→ `VoiceLink::spawn_resident`（常驻采集线程，`amos-tauri`）→ 16k 下采样 → bidi `Payload::Audio` → daemon `ChatAsr`（`AMOS_ASR_BACKEND=sherpa` 真 sherpa）。真机上缺的只是**把上面这些在 NDK 交叉编译 + 打包 + 授权 + 放模型后真正跑起来**。本轮已把「无设备也能验收」的部分全部补齐并验证：

| 改动 | 作用 | 验收 |
|---|---|---|
| `#[link(name="aaudio")]`（`amos-audio/src/android/aaudio.rs`） | 让 seam 真链接 NDK `libaaudio.so`，否则真机 `.so` 运行时 `AAudio_*` undefined 崩溃 | `readelf -d` 见 `DT_NEEDED: libaaudio.so` |
| 清理 android-only lint（type alias camelCase / dead_code / unreachable） | 交叉编译 warning-clean | 3 ABI 0 warning |
| `examples/aaudio_link_smoke.rs` | Android **可执行文件** link 证明：可执行文件不允许 undefined 符号 | NDK build 成功 + DT_NEEDED 断言 |
| `scripts/android-audio-check.sh` + `Makefile android-audio-check` | 一键交叉编译 + link 验收 | `make android-audio-check` PASSED |
| `.github/workflows/ci.yml` `android-audio-seams` job | CI 门：**host 全绿也碰不到**这些 android-only seam，必须单独编 | PR 门 |
| `amos-tauri` `android` feature 增 `amos-audio/aaudio` | **真机上** `PlatformMic::open_device()` 才会真开 AAudio 麦（否则即便在设备上也报「no native backend」） | `cargo check -p amos-tauri --features android` |

---

## 1. 链路与各 seam 位置

```
[ NDK AAudio mic ]                        [ mock: FrameMic/SineMic ]
   AAudioCapture::open(16000)                    from_mock()
        │                                          │
        └──────────► PlatformMic (Send, AudioCapture) ◄─┘   amos-audio::source
                        │ read()
                        ▼
   spawn_resident_capture / VoiceLink::spawn_resident     amos-tauri (assistant_voice)
        16k 下采样(若设备只给44.1/48k) → f32-le
                        │  Payload::Audio 帧  (+ 尾静音门 AudioEnd 切句)
                        ▼
   amos-ai daemon bidi Chat ──► ChatAsr ──► sherpa StreamingRecognizer (asr-sherpa)
                        │ finalize() 文本当 Prompt
                        ▼
                    推理 → 逐 token 回流 UI（assistant-voice-event）
```

关键 seam 文件：
- `crates/amos-audio/src/android/aaudio.rs` — AAudio 采集/回放（app 路径）
- `crates/amos-audio/src/android/tinyalsa.rs` — TinyALSA（**系统**路径，仅编译验证；NDK 不含 `libtinyalsa`）
- `crates/amos-audio/src/source.rs` — `PlatformMic`/`PlatformMicKind::detect`（Android+`aaudio` → `Aaudio`）
- `crates/amos-ai/src/chat_asr.rs` — `ChatAsr::from_env`（`sherpa`/`mock`/`off`）
- `crates/amos-tauri` `assistant_voice.rs` — 常驻采集 worker

## 2. host 可验证部分（无设备，已跑通）

```bash
# 1) 三种 Android ABI 交叉编译 aaudio+tinyalsa + arm64 AAudio 真链接
make android-audio-check        # 或 bash scripts/android-audio-check.sh

# 2) 单独 link 证明（arm64）
cargo ndk -t arm64-v8a -P 26 build -p amos-audio \
    --features aaudio --example aaudio_link_smoke
llvm-readelf -d target/aarch64-linux-android/release/examples/aaudio_link_smoke \
    | grep NEEDED            # 期望含 libaaudio.so

# 3) host 无回归
cargo test -p amos-audio
cargo clippy -p amos-audio --all-targets -- -D warnings
cargo clippy -p amos-audio --features aaudio,tinyalsa --all-targets -- -D warnings
cargo check -p amos-tauri --features android   # android feature 接线编译

# 4) host 真 sherpa 识别 e2e（真 daemon + 真 sherpa 识别 demo 语音 → 作答）
cargo test -p amos-ai --features asr-sherpa --test bidi_sherpa_audio
#    （若 host 设了 all_proxy=socks5，sherpa-onnx-sys 的下载会报 SOCKS feature
#     disabled；用 `env -u all_proxy -u ALL_PROXY cargo ...` 让它走 http 代理）

# 5) amos-ai(真 sherpa) 的 Android 交叉编译 + 链接门（arm64，联网首次会下载 sherpa 库）
make android-ai-sherpa-check    # 或 bash scripts/android-ai-sherpa-check.sh
```

前提：`ANDROID_NDK_HOME`（NDK ≥ 26，AAudio 自 API 26 起随 NDK 提供）、`cargo-ndk`、rustup 目标 `aarch64-linux-android`/`x86_64-linux-android`/`armv7-linux-androideabi`；`android-ai-sherpa-check` 还需 `protoc` 与联网。

## 3. 真机 bring-up 步骤

### 3.1 前置确认
- 设备 Android API **≥ 26**（AAudio 需要的 API level；manifest `minSdkVersion ≥ 26`）。
- manifest 声明 **`RECORD_AUDIO`** 权限并在运行时授权（`CapabilityGate` mic，见 `docs` 权限落地）。
- 设备出厂驱动里有 `libaaudio.so`（现代 Android 系统固件均有）。

### 3.2 编译带真采集的 System UI
`amos-tauri` 的 `android` feature 现会把 `amos-audio/aaudio` 编进来 → `PlatformMicKind::detect()` 在设备上返回 `Aaudio`、`open_device()` 以 16 kHz 打开真麦：
```bash
cd crates/amos-tauri && cargo tauri android build --features android   # APK
```
把 APK 装到设备，启动 System UI。

### 3.3 编译 daemon 带真 sherpa（可选：daemon 内 ASR）
> 若语音的 ASR 走 daemon（方案 A，`docs/bidi-voice-asr.md` 推荐），daemon 需带 `asr-sherpa`。也可走 native（System UI 内 sherpa）把文本给 daemon——两条路的采集侧相同，只是 ASR 位置不同。
```bash
# 用 scripts/build-android.sh --ai-voice（含 sherpa 下载 + 交叉编译）
AMOS_AI_VOICE=1 bash scripts/build-android.sh
```
运行时 env：`AMOS_ASR_BACKEND=sherpa` + `AMOS_SHERPA_MODEL_DIR=/data/amos/sherpa`。

### 3.4 接线点 = 已注册的 Tauri 命令 `device_mic_start`（真实调用入口，勿手写）
「真麦交进常驻 worker」已被封装成 **System UI 一条 Tauri 命令**，设备端 UI 只需
`invoke("device_mic_start")`，无需（也不应）在别处再手写采集循环：
```text
[System UI]  invoke("device_mic_start")   ← 已注册：crates/amos-tauri/src/lib.rs:118
   │  （进程需已获 RECORD_AUDIO 运行时授权）
   ▼
open_platform_mic()  → amos_audio::PlatformMic::open_device()
   │                    Android+aaudio → AAudioCallbackCapture @16 kHz
   ▼
spawn_resident_capture::<PlatformMic>(link.feeder(), mic, 16000, 3, feed_silence=true)
   │  16k 下采样 → Payload::Audio 帧 →(尾静音门) AudioEnd
   ▼
daemon bidi Chat → ChatAsr(sherpa) → 推理 token 回流 assistant-voice-event
```
对应命令与实现位置：`device_mic_start` / `device_mic_stop` / `device_mic_status`
（`crates/amos-tauri/src/assistant_voice.rs:418/465/476`）。
> 诚实边界：普通 **host 构建**上这三条命令对麦返回「no native backend」错误
> （绝无静默假麦）；只有带 `amos-audio/aaudio` 的 **Android 构建**才真开 AAudio 麦。

### 3.5 放模型
```bash
adb push models/sherpa-en-20m/ /data/amos/sherpa/     # encoder/decoder/joiner .onnx + tokens.txt
```
（`models/sherpa-en-20m` 仓库已带 demo 模型，其 `test_wavs/0.wav` 是 UDS e2e 用的真实语音。）

### 3.6 跑 + 观察
- **两条语音输入路径别混淆**：现有 AI 应用的麦克风走的是 WebView `getUserMedia` →
  JS PCM（浏览器采集，非 AAudio）；**本文要验的 AAudio 原生麦**走 `device_mic_start`
  （见 3.4）——它才是「硬件采样回调 → 本地 sherpa」的真机闭环。开麦前先在 System UI
  授权 `RECORD_AUDIO`。
- 前端订阅 `assistant-voice-event`：先见灰色「正在识别…」transcript（interim），松麦后见模型 token 流出到回复气泡。
- daemon `get_status` 应报 `asr = sherpa`（真后端，非 mock）。

## 4. 设备验收 checklist（判定标准）

| 判据 | 期望 | 命令/观察 |
|---|---|---|
| C1 设备上报 AAudio | `PlatformMicKind == Aaudio` | 日志 `platform_mic=aaudio` 或 `get_status` mic 字段 |
| C2 打开真麦不报错 | `open_device()` Ok | daemon/System UI 无「no native backend」 |
| C3 采集出音频 | `read()` > 0 | 常驻 worker `Audio` 帧持续上行 |
| C4 sherpa 真实识别 | interim 递增、final 成句 | transcript 灰字先于模型 token |
| C5 尾静音切句 | 松麦触发 `AudioEnd` | 一轮作答完整 |
| C6 端到端作答 | 语音 → 文本 → 推理回复 | UI 回复气泡出现 |
| C7 录音权限拒绝路径 | 未授权 → 诚实降级/报错 | 不崩溃、不伪造 |

## 5. 诚实边界（本轮没做、也不应假装）

- **TinyALSA 只做了编译验证、未做链接**：`libtinyalsa` 是 AOSP 系统库，**NDK 不携带**，其链接发生在系统镜像/AOSP 构建里。普通 app 也开不了 `/dev/snd`——TinyALSA 是系统组件 / 通话语音流拦截的 seam。
- **AAudio link 已验证、真机 runtime 未验**：`#[link]` + DT_NEEDED 保证链接期绑定，但设备上麦克风实际出声、DSP 路由、低延迟表现仍需 C1–C7 真机判。
- **通话/SIM 语音流拦截**是系统级（audio-route/HAL 钩子 + 特权），不在 AAudio 可达范围，仍属未来项。
- **sherpa-onnx-sys 的 Android 自动下载在本仓库不可直接使用**：其 1.13.7 build.rs 假设 android 归档解出 `<版本>-android/` 包裹目录，但真实 `...-android.tar.bz2` 把 `jniLibs/<abi>/` 直接铺到根。故 android 构建必须先把该归档解出并用 `SHERPA_ONNX_LIB_DIR` 指到实际的 `jniLibs/<abi>`（`scripts/android-ai-sherpa-check.sh` 已内置这一步）。这是上游打包怪癖，非本仓缺陷。桌面 host 归档有 `lib/` 包裹目录，故 host 可自动下载。
- **amos-ai 真 sherpa 只做到「交叉编译 + 链接」（DT_NEEDED: libsherpa-onnx-c-api.so）**：跑真识别是 host e2e（`bidi_sherpa_audio`，已跑通）；Android 上 `.so` 需随 daemon/APK 部署到设备（`jniLibs`），真机运行时识别仍需设备验收。
- CI 的 `android-audio-seams` 在 GitHub **联网** runner 上装 NDK 编 seam；它验证「能编能链」，**不等于**真机行为。

## 6. 关联
- `docs/audio-hal-bridge.md` — Audio HAL Bridge（本 runbook 的父文档）
- `docs/bidi-voice-asr.md` — daemon 内 ASR（方案 A）设计
- `docs/device-poc.md` / `docs/mobile-targets.md` / `scripts/build-android.sh` — 交叉编译与设备 staging
- `scripts/android-audio-check.sh` — host 侧 AAudio/TinyALSA seam 验收脚本
- `scripts/android-ai-sherpa-check.sh` — host 侧 amos-ai(真 sherpa) Android 交叉编译/链接验收脚本

## 7. 「真机接线」审计 —— 三大 wiring 的 done / remaining（2026-09-09 复核）

> 本节的目的是回答「哪些代码面已闭环、哪些真缺口仍在」。凡标 ✅ 均可用 **host 门禁**
> 证明（`cargo test -p amos-audio` 24 passed 已复核）；标 🔴 的是无法在 host 闭环、或
> 仍未实现的真缺口。

### 7.1 Wiring ①：麦克风 → ASR（AAudio 采集 → sherpa 输入缓冲）—— **代码面 ✅ 已完成**

| 环节 | 状态 | 证据 |
|---|---|---|
| AAudio 手写 FFI（含 `setDataCallback` 真实 data-callback seam） | ✅ | `crates/amos-audio/src/android/aaudio.rs`（`AAudioCallbackCapture`，API 26 可链接） |
| 硬件回调 → 宿主可测有界 ring（I16→f32，稳态零分配） | ✅ | `ring.rs`（6 例单测）+ `aaudio.rs` 回调 |
| `PlatformMic::open_device()` 默认开回调采集（16 kHz） | ✅ | `source.rs:135-145` |
| 常驻采集线程喂 `Payload::Audio` + 尾静音门 `AudioEnd` | ✅ | `assistant_voice.rs` `spawn_resident_capture`（多例单测） |
| daemon bidi `Payload::Audio` → `ChatAsr`（真 sherpa）→ 收句作答 | ✅ | `amos-ai/src/server.rs:1038/1057`、`chat_asr.rs`；host e2e `bidi_sherpa_audio` |
| 运行时真机采样验收（回调出声 / DSP / 权限 / 延迟） | 🔴 待设备 | 判据 C1–C7，host 无法伪造 |

**前端可达路径（2026-09-09 补完）**：`device_mic_start/stop/status` 已由前端接通——
`frontend-ts` 新增 `lib/backend.ts` 的 `deviceMicStart/Stop/Status` bridge 包装 +
纯 `lib/deviceMic.ts`（`parseDeviceMicStatus` / `isNativeMicBackend`，host 单测 3 例）+ AI 应用
composer 上的 `DeviceMicButton.svelte`「常驻原生听麦」开关（`AiApp.svelte` 挂载，`aria-label=
"device voice input"`）。诚实行为：浏览器/离线禁用并提示需真机 AAudio；bridged 但无原生麦
（host 构建）时 `deviceMicStart` 降级 null，按钮据 `bridgeDiag` 提示「无原生麦 / 未授权
RECORD_AUDIO」，绝不伪造「正在听麦」；并**每秒轮询 `deviceMicStatus`**：实时显示已识别句数、
并反映外部停止（采集是否活着一眼可见，供 bring-up 观察）。**回复显示已上收到 AiApp 单一
`assistant-voice-event` `turn_done` sink**（`AiApp.svelte` 订阅 → 一个 agent 气泡）：
`StreamVoiceButton`/`DeviceMicButton`
都不再自订订阅，杜绝双气泡、且 DeviceMicButton 不再隐性依赖 StreamVoiceButton 被挂载；已用
bridged svelte 测试锁定「一个 turn_done → 恰一个 agent 气泡」（`ai.svelte.test.ts`）。验证：
`bun run typecheck` / `typecheck:svelte` 0/0、`bun run test`（src/__tests__）全绿、
`bun run test:svelte` **59 文件 333 例全绿**（含新增 deviceMic 纯测 3 + backend 桥接 2 +
voice-buttons 离线 1 + ai 单一 sink 锁 1）。

**OS 级 `RECORD_AUDIO` 原生授权 seam（2026-09-09 结构到位，待设备/gradle 验收）**：
新增 **JS-awaitable** 的 `mic_permission_state` / `mic_permission_request` Tauri 命令
（`crates/amos-tauri/src/mic_permission.rs`：非 Android host 诚实回 `native:false`；
Android 上经 Kotlin `MicPermissionGlue` 驱动 `isGranted()`/`request()`，OS 对话框结果经
`onResult(granted)` JNI upcall 回填一个 oneshot，命令在对话框结束后返回）。Kotlin 侧
`android-glue/com/amos/ai/glue/MicPermissionGlue.kt`（已同步 `gen/android`）在
`PermissionWire.requestNeeded` 里于启动时 `ensureBound`，`onResult` 增加 `REQ_MIC` 分支回传
原生结果（不经 `getUserMedia`）。前端 `DeviceMicButton` 开麦前先调 `micPermissionRequest()`，
`native && granted` 才 `deviceMicStart`，否则诚实提示。Rust 验证：`cargo check`/`cargo clippy
--features android --lib -D warnings` 两配置全绿、`mic_permission` host 单测 2 例过；前端
`bun run check` 全绿。**待设备**：Kotlin 编译并入 `gen/android` 后跑 `./gradlew
:app:compileDebugKotlin`，再真机授权 `REQ_MIC` 闭环。

**🔴 仍未闭环（都需设备/OS，非 host 可验）**：
- **设备 runtime C1–C7**：AAudio 实际出声/DSP/延迟 + 上面的 Kotlin 授权真实走通，只能真机判。
  建议用一键驱动器：`make android-voice-bringup`（脚本 `scripts/android-voice-bringup.sh`，
  dry-run 打印完整 plan；`--check-prereqs` 只查 adb；`--apply` 才真碰设备——stage sherpa 模型
  → grant RECORD_AUDIO → 跑 AAudio probe 拿 C2/C3 证据，并诚实打印 C1/C4–C7 人工清单）。
- **preview6.js 预览包**：为离线单文件预览的已提交产物，未在本改动重新生成（生产 System UI
  走 Svelte 源；如需同步预览再跑前端 build）。

### 7.2 Wiring ②：init.rc 托管运行（真机 daemon/采集的拉起）
- `deploy/android/amos.rc` ✅ 已写好：`on property:sys.boot_completed=1` 拉起
  `amos-ai`（`/system/bin/amos-ai --socket /data/amos/ai.sock`），已带
  `AMOS_ASR_BACKEND=sherpa` + `AMOS_SHERPA_MODEL_DIR=/data/amos/sherpa`、
  `oom_score_adj -1000`。
- 🔴 真缺口：`amos.rc` 只拉起 **daemon**；「常驻麦采集」活在 System UI
  （`device_mic_start`，见 7.1），而 System UI 是由 launcher 自动启动的 APK——
  并非 init 服务。若产品要**无 UI 自启的常驻语音唤醒**，才需要新增一个带
  `RECORD_AUDIO` 的系统级 native 采集服务（直接 `amos-audio` seam），这是独立设计决策。

### 7.3 Wiring ③：加速器 / NPU 闭环（qcom/mtk）
- 现状：`amos-ai/src/accelerator.rs` 走 **feature 门控**（`qnn`/`neuropilot`），
  `compiled_in()` 未接入 SDK 时如实为假，不会把 NPU 当「已用」上报；`qcom-mtk-bringup.md`
  记录 OEM 集成路径。此链路只做了「编译期 feature 声明」，**无真机/无 SDK 即不可闭环**。
- 🔴 全部待设备/OEM SDK 验收；不属本 runbook 的 AAudio→sherpa 范围，另立工单。

### 7.4 一句话
**Wiring ① 的代码面（含硬件回调 seam + sherpa 输入缓冲）+ 前端可达路径已 100% 在 host 闭环并复核
（`amos-audio` 24/24、前端 bun+svelte 全绿、svelte-check 0/0）。** 真正剩的只有：
① 真机 OS 级 `RECORD_AUDIO` 原生授权（Kotlin 独立请求，见 7.1）；② 真机按 C1–C7 跑 runtime；
③ 若要无 UI 自启语音唤醒则再加一个 init 采集服务。host 上没有任何「尚可安全补完的
采集/sherpa/桥接 seam」——本 runbook 不为凑改动而强改已审计代码。


