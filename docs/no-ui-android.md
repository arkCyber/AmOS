# Amos on the No-UI Android Base

The "operating system" beneath Amos is a **headless Android** — Linux kernel,
Android drivers, HAL, Binder, and base daemons — but **without** the Java UI
framework / SystemUI. This is the ideal substrate: it gives us every hardware
driver and the ActivityManager/SurfaceFlinger, while letting Rust + Tauri own
the entire user-facing system.

> **✅ 定位判定 (Deployment Decision, 2026-09-03)**：本文（no-UI Android 基座）是 **AmOS 产品在真机上的唯一底座**。与之相对的 `docs/android-compat.md` / `amos-android` 的 **Waydroid 容器路径仅用于「开发 / 原型」**（非 Android 主机上验证 APK 兼容管线）；真机上旧 APK 作为原生 Android 进程直接运行，无需 Waydroid。两者不矛盾——按部署目标分工。

## 1. Why the existing code already fits

| Amos component | Runs as | Notes |
|---|---|---|
| `amos-ai` (AI daemon) | `/system/bin/amos-ai`, started by init | Pure Rust, headless, gRPC over UDS, socket `0700`, graceful shutdown |
| `amos-wm` (window manager) | in-process Rust lib | Transport-agnostic state machine (9 tests) |
| `amos-tauri` (System UI) | single launcher APK | WebView renders full-screen as Launcher + System UI; its Rust core is the gRPC client |

No Linux migration, no Waydroid — the "no-UI Android" *is* the container and the
hardware abstraction layer.

## 2. Boot orchestration (`deploy/android/amos.rc`)

Order guaranteed by init:
1. `on early-init` → `mkdir /data/amos` (socket dir, `0770 system:system`).
2. `on property:sys.boot_completed=1` → `start amos-ai`.
3. `service amos-ai /system/bin/amos-ai --socket /data/amos/ai.sock`:
   `class main`, `user root`, `seclabel`, `setenv AMOS_SOCKET=...`,
   `oom_score_adj -1000` (never kill the inference core), auto-restart.
4. Tauri System UI = the **only** app declaring `HOME` intent → Android starts
   it as the launcher after boot; it connects to `/data/amos/ai.sock`.

`amos-ai` now also accepts `--socket PATH` / `--help` / `--version` (unit-tested)
so init can pass the path explicitly.

## 3. Cross-compilation

- **Headless Rust** (`amos-ai`, `amos-wm`): `scripts/build-android.sh` generates
  `.cargo/config.toml` with the NDK linker and runs
  `cargo build --release --target aarch64-linux-android -p amos-ai -p amos-wm`.
  - For **real on-device ASR** the shipped `amos-ai` must be built with sherpa:
    `scripts/build-android.sh --ai-voice` (adds `--features asr-sherpa`; first run
    downloads sherpa-onnx's aarch64 static lib → needs network). Then push the
    sherpa model to the path `amos.rc` sets (`AMOS_SHERPA_MODEL_DIR=/data/amos/sherpa`),
    e.g. the repo demo `models/sherpa-en-20m/`. Without this, the daemon built base
    reports the honest "voice not configured" rather than pretending.
- **Tauri System UI**: `cd crates/amos-tauri && cargo tauri android init && cargo tauri android build`
  → produces the launcher APK (needs Android SDK/NDK).

## 4. Design: JNI / Binder Rust bindings (next)

To let Rust (Agent / Tauri core) talk to low-level Android services (power,
network, sensors, ActivityManager):
- **`jni` crate** for JNI calls into system services that still exist but lack a
  UI: e.g. `PowerManager`, `ConnectivityManager` via the system context.
- **`binder` crate** (Rust implementation of Binder) for high-throughput IPC to
  `SurfaceFlinger` / `AMS` / `input` without going through Java at all —
  preferred for latency-critical paths.
- Gate behind `#[cfg(target_os = "android")]` and expose a thin
  `android_bridge` module to `amos-tauri`.

## 5. Design: launch old APKs & mount their surface (next)

When the user taps "微信" in the Tauri Launcher:
1. Rust launches the app (`am start` via binder, or `am start` shell) → AMS
   creates its window.
2. **方案 A (层叠)** — `SurfaceControl`: reparent the old app's surface as a
   child of the Tauri window's layer, positioned/opacity-controlled from Rust.
3. **方案 B (纹理, 最硬核)** — `VirtualDisplay`: render the old app to an
   off-screen virtual display, capture its `HardwareBuffer`, and upload as a
   WebGL texture so the legacy app becomes a `<div>` in the Tauri webview.

## 6. AI Agent on the base (降维打击)

With root/system privileges the Rust Agent can, without Accessibility:
- Inject input: `input tap x y`, `input text "..."` via binder/shell.
- Read the screen: `screencap` or GraphicsBuffer reads at high FPS for VLM.
- Feed the frame/text into the same gRPC pipe (`amos-ai`) for on-device
  inference.
## 7. 真机 AI POC — 一键验收 (Acceptance)

> 前置：Android NDK、`rustup target add aarch64-linux-android`、**无代理网络**
>（sherpa-onnx 需从 GitHub 下载 aarch64 静态库）、一台已 root 的真机（adb）。
> 本步在文档/脚本层就绪；真正的"通电"必须在一台无代理的 Android 构建机上执行。

```bash
# 1) 交叉编译（含真 sherpa 本地 ASR）。首跑联网下载 sherpa 库。
scripts/build-android.sh --ai-voice

# 2) 推二进制 + sherpa 模型（路径与 deploy/android/amos.rc 的 env 一致）
adb root && adb wait-for-device
adb shell mkdir -p /data/amos/sherpa
adb push target/aarch64-linux-android/release/amos-ai /data/local/tmp/amos-ai
adb shell chmod 0755 /data/local/tmp/amos-ai
adb push models/sherpa-en-20m/. /data/amos/sherpa/
adb shell ls /data/amos/sherpa   # 期望 encoder/decoder/joiner .onnx + tokens.txt
```

```bash
# 3) POC：手动拉起 daemon（生产应把 amos.rc 合并进镜像，由 init 在
#    sys.boot_completed 后拉起；此处为快速验证，用与 amos.rc 相同的 env）。
adb shell 'mkdir -p /data/amos && chown system:system /data/amos /data/amos/sherpa 2>/dev/null || true'
adb shell 'AMOS_BACKEND=ollama AMOS_OLLAMA_HOST=http://localhost:11434 \
  AMOS_ASR_BACKEND=sherpa AMOS_SHERPA_MODEL_DIR=/data/amos/sherpa \
  AMOS_SOCKET=/data/amos/ai.sock nohup /data/local/tmp/amos-ai \
  >/data/amos/ai.log 2>&1 &'
adb shell 'sleep 2; tail -20 /data/amos/ai.log'
```

```bash
# 4) 验收判据（用桌面/主机端 daemon 同款逻辑核对，或直接用 System UI APK）
#    a) daemon 起来后 get_status 应如实上报 engine/asr（不降级、不谎报）：
#       主机端: cargo run -p amos-ai --example status_once -- <device-socket>
#         → engine=ollama asr=sherpa degraded=false（若本地真装了可对话 Ollama）
#         → 若未装 Ollama：engine=mock degraded=true（UI 会显示红色警示）
#         → 若 amos-ai 未带 asr-sherpa 或模型缺失：asr 报告 voice not configured
#    b) 在 System UI 的 AI 对话里按住说话（流式语音）→ 语音转写 → 真回复。
```

> amos.rc 若要"开机即真引擎"：把 `deploy/android/amos.rc` 并入设备 init.rc
>（如 `TARGET_PROVIDES_INIT_RC`）后重做系统镜像；仅靠 adb push 无法热应用 init.rc。

