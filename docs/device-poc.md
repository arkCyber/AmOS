# 真机 POC 运行手册 (On-Device POC)

**日期**: 2026-09-03
**对应路线图阶段 1**：在 12GB 真机（可先跑普通 Android，无需先打包整个 OS）上验证「Rust AI daemon 真机可用」这个商业前提——`amos-ai` 能交叉编译成 `aarch64-linux-android`、能 `adb push` 跑起来、能经 **UDS gRPC** 与同机客户端跨进程通信、权限/延迟符合预期。**在写 telephony / NPU / 商店等新模块之前先做这一关。**
**前置文档**：`scripts/build-android.sh`、`docs/no-ui-android.md` §3（交叉编译）、`docs/mobile-targets.md`（targets 初始化）。本手册不覆盖如何打包完整 OS 镜像。

> ⚠️ **产品底座 = no-UI Android 基座**（见 `docs/no-ui-android.md`）。本 POC 只是用**一台普通 Android 真机**先验证 daemon 侧链路，不等同于产品底座；SELinux / 用户 / socket 归属在生产上由 `deploy/android/amos.rc`（`u:r:system_app:s0`、`/data/amos`、`oom_score_adj -1000`）接管。

---

## 0. 前置检查（Mac 上）

```bash
# 1) Rust 交叉目标已装
rustup target list --installed | grep aarch64-linux-android || rustup target add aarch64-linux-android

# 2) Android NDK 路径（macOS 常见位置：~/Library/Android/sdk/ndk/<版本>）
ls -d "$HOME/Library/Android/sdk/ndk/"* 2>/dev/null || echo "未找到 NDK，请先装 Android Studio SDK/NDK"

# 3) 真机已连（开发者模式 + USB 调试）
adb devices -l          # 应列出你的 12GB 设备
```

> 交叉编译只需要 **NDK 的 clang linker**，不需要完整 Android SDK。`scripts/build-android.sh` 读 `$ANDROID_NDK_HOME` 并在仓库根生成 `.cargo/config.toml`；**该文件不要提交**，验证完可删。

---

## 1. 交叉编译 amos-ai（+ 同机客户端 chat_once）

```bash
cd /Users/arksong/AmOS
export ANDROID_NDK_HOME="$HOME/Library/Android/sdk/ndk/<你本机版本>"

# ① daemon（build-android.sh 会顺带编 amos-wm）
./scripts/build-android.sh
# 产物: target/aarch64-linux-android/release/amos-ai

# ② 客户端示例 chat_once（真机上同时跑 client+server，走同一 UDS）
cargo build --release --target aarch64-linux-android -p amos-ai --example chat_once
# 产物: target/aarch64-linux-android/release/examples/chat_once
```

> 若 `build-android.sh` 报 linker 不存在：确认 `$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android34-clang` 存在（Apple Silicon 上 prebuilt 目录是 `darwin-x86_64`，NDK 统一用 x86_64 host 工具）。
> 依赖提示：`amos-ai` 走纯 Rust（tokio/tonic/ureq-rustls），android 目标可编；若某依赖需要额外 C 库报错，先确保是网络拉取或 feature 门控问题（本仓的 sherpa/piper 均以 feature 门控，POC 用默认 offline 配置，勿开 `sherpa`/`piper`/`appstore-live`）。

---

## 2. 推到设备并启动 daemon

```bash
adb root                # 若 adb 非 root，先切 root（仅 POC 机）
adb shell mkdir -p /data/local/tmp
adb push target/aarch64-linux-android/release/amos-ai       /data/local/tmp/amos-ai
adb push target/aarch64-linux-android/release/examples/chat_once /data/local/tmp/chat_once
adb shell chmod 0755 /data/local/tmp/amos-ai /data/local/tmp/chat_once

# 后台启动 daemon，显式指定 socket（与 chat_once 一致）
adb shell "setsid /data/local/tmp/amos-ai --socket /data/local/tmp/amos-ai.sock \
            > /data/local/tmp/amos-ai.log 2>&1 &"

# 确认起来了（日志应有 "amos-ai listening"）
adb shell "sleep 1; cat /data/local/tmp/amos-ai.log"
```

> socket 权限：`amos-ai` 对 socket `chmod 0o700`（`server.rs`）。同 shell 用户跑的 `chat_once` 可访问；若 SELinux 拦截（`permission denied`），在 **POC 机**上临时 `adb shell setenforce 0` 验证，生产走 `amos.rc` 的 seclabel 而非关 SELinux。

---

## 3. 跑 chat_once：验证 UDS IPC + 权限边界

```bash
# 真机上跑客户端（与 daemon 同机，走 UDS）
adb shell "cd /data/local/tmp && time ./chat_once /data/local/tmp/amos-ai.sock '你好，AmOS'"
```

**通过判据**
1. 正常打印 token 流，并以 `done` 结束（`chat_once` 无 done 会报错退出）。
2. 非交互：全程不需要 TTY——证明无头 daemon + 客户端成立。
3. 默认 `AMOS_BACKEND=mock` 时回复带 `[amos-ai]` 签名即可（本关目的是 **IPC/权限/延迟**，不是真推理）。

**观察项（记录下供后续决策）**
- `time` 给出的端到端耗时（首次握手 + 流式）。
- 异常路径：删掉 socket 再跑应报 `daemon not reachable`；换一个不该有权限的用户跑客户端应被拒——验证权限边界。

---

## 4.（可选）真推理联通验证
IPC 通了之后，若要确认“非 mock”链路，把设备指向可达的推理服务再跑一次：
```bash
# 例：局域网内已有 Ollama 或 OpenAI 兼容端点
adb shell "AMOS_BACKEND=ollama AMOS_OLLAMA_HOST=http://<局域网IP>:11434 \
  /data/local/tmp/amos-ai --socket /data/local/tmp/amos-ai.sock ... &"
adb shell "cd /data/local/tmp && ./chat_once /data/local/tmp/amos-ai.sock 'hi'"
```
此时回复应**不带** `[amos-ai]` mock 签名，证明文本真来自远端引擎（对应 `crates/amos-tauri/tests/ggml_command_e2e.rs` 的判据）。设备本地跑 llama.cpp / RKNN 属后续（见路线图 §3）。

---

## 5. 收尾
```bash
adb shell "pkill -f '/data/local/tmp/amos-ai'" || true
rm -f .cargo/config.toml        # 撤销交叉编译生成的本地配置（勿提交）
```
记录 `amos-ai.log` + `time` 输出，作为「真机可跑」的证据归档。

---

## 参考：命令与产物一览
| 项 | 值 |
|---|---|
| 交叉产物 | `target/aarch64-linux-android/release/amos-ai`、`.../examples/chat_once` |
| 交叉脚本 | `scripts/build-android.sh`（需 `$ANDROID_NDK_HOME` + `rustup target add aarch64-linux-android`） |
| daemon 入口 | `amos-ai --socket <PATH>`（`-s`；env `AMOS_SOCKET`；无则用平台默认 `/data/local/tmp/amos-ai.sock`） |
| 客户端示例 | `cargo run -p amos-ai --example chat_once -- <socket> <prompt>`（`examples/chat_once.rs`，host 端开发也可用） |
| socket | `0o700`；同一 UDS 承载 `AiAgent` + `AndroidManager` 两服务（`server.rs`） |
| 状态查询 | `GetStatus` RPC（`amos-ai` monitoring）可读 rpc_total/heartbeats——可在真机上另起探针验证健康心跳 |
