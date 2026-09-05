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

### 3.4 接线点（真机 worker 已泛型就绪，无需改逻辑）
System UI 侧把真麦交进常驻 worker（代码 seam 已就位，device-bring-up 只需在这里调用）：
```rust
// 在设备端调用（System UI 持有 Context / 已授权 RECORD_AUDIO 后）：
let mic = amos_audio::PlatformMic::open_device()?;   // Android+aaudio → AAudio, 16 kHz
VoiceLink::spawn_resident(mic, ...)?;                 // 常驻采集 → Payload::Audio
```

### 3.5 放模型
```bash
adb push models/sherpa-en-20m/ /data/amos/sherpa/     # encoder/decoder/joiner .onnx + tokens.txt
```
（`models/sherpa-en-20m` 仓库已带 demo 模型，其 `test_wavs/0.wav` 是 UDS e2e 用的真实语音。）

### 3.6 跑 + 观察
- 打开 AI 应用，开「常驻听麦」（`assistantVoiceStart/Feed/End`），对麦说话。
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

