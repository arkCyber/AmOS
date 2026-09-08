# 手机接入 — 剪贴板特性「全面测试 / 补全」runbook

> **✅ 已真机执行（2026-09-08）**：零售 Android（model `S5`，Android 14 / API 34，`arm64-v8a`，shell 用户，非 AmOS 基座）上，
> `amos-clipboard` on-device 自检 **8/8 通过**，打印 `AMOS_CLIPBOARD_SELFCHECK_OK`（exit 0）。**debug 与 release 两种构建均已真机跑通**，release 连跑两遍结果一致（确定性）。详见 §2 与 §5。

> 目标：拿到一台能被 `adb` 看到的设备后，按本清单**真机验证** AmOS 剪贴板同步相关代码
> （`crates/amos-clipboard` / `crates/amos-tauri`），并诚实标注每一步在哪种形态上可行。
> 本页只编排「既有 seam 的执行步骤 + 判据」，不含新增业务逻辑（与仓库 `device-bringup-checklist.md`
> 同体例）。涉及跨容器/合成的更深验收见 `docs/clipboard-container-sync.md` §7。

## 0. 前置：确认 adb 能看到设备

```sh
adb devices -l        # 期望出现一行 `xxxx  device  product:... model:...`
```
- 空 / `unauthorized`：手机端开 **开发者选项 → USB 调试**，并在手机上**允许此电脑的 RSA 调试授权**；
  换数据线 / USB 口；必要时 `adb kill-server && adb start-server`。
- 出现 `device` 后再继续。

## 1. 先判定设备形态（三选一，决定能测什么）

```sh
adb shell getprop ro.product.model
adb shell getprop ro.build.version.sdk
adb shell getprop ro.build.version.release
adb shell ls /system/bin/amos-ai 2>/dev/null && echo "AMOS-no-UI-base" || echo "NOT AmOS base"
adb shell 'pm list packages 2>/dev/null | grep -i waydroid' && echo has-waydroid-pkg || echo no-waydroid-pkg
adb shell whoami; adb shell id   # 是否 root / shell 用户
```

- **A 零售 Android 手机**（最可能）：非 AmOS no-UI 基座、无 Waydroid。
- **B AmOS no-UI 基座设备**：`/system/bin/amos-ai` 存在。
- **C Waydroid（Linux 宿主）**：Waydroid 在 **Linux** 宿主跑（本 macOS 无 Waydroid）。

## 2. 形态 A（零售 Android）：能真机验证的部分

**可做（headless、无 Context）：在真 Android userspace 跑 `amos-clipboard` 全套纯逻辑。**

```sh
# 已在本仓库交叉编译产出（或自行重建）：
#   cargo build -p amos-clipboard --example on_device_selfcheck --target aarch64-linux-android
adb push target/aarch64-linux-android/debug/examples/on_device_selfcheck /data/local/tmp/
adb shell chmod +x /data/local/tmp/on_device_selfcheck
adb shell /data/local/tmp/on_device_selfcheck
```
判据：末尾打印 **`AMOS_CLIPBOARD_SELFCHECK_OK`**，且 8 行 `[pass]` 全过
（agent 宿主推送→guest 应用且不回显 / 真实复制上报 / 协议 encode↔decode 往返 / echo guard /
Backoff 指数+封顶+放弃 / min_delay 地板）。这证明该 crate 能**为并在真机 Android userspace 运行**
（架构/加载/`panic=abort` 语义等编译与运行时均成立）。

**不做 / 诚实标注（零售手机无法验证）**
- 带 `Context` 的 `AndroidClipboardProvider` 与 guest Kotlin bridge：只能在能拿到
  `ClipboardManager` 的**应用进程**里跑（零售机上无我们的 guest 容器宿主）。
- P2b/P3「宿主↔Waydroid guest 容器 / no-UI 合成器」互拷：零售机上没有我们的容器/合成器。

## 3. 形态 B（AmOS no-UI 基座）：按基座 bring-up 验收

- 参考 `docs/device-bringup-checklist.md` / `docs/android-lmk-e2e.md` 跑基座系统验收。
- 剪贴板宿主半（`amos-tauri` System UI）只在基座的 launcher APK 内；用 `cargo tauri android`
  产出后随 APK 验系统剪贴板镜像（对应既有 `ClipboardGlue.kt` / 形态 B seam）。

## 4. 形态 C（Waydroid / Linux 宿主）：P2b/P3 guest 通道

- 需一台 **Linux**（本 macOS 无 Waydroid）。按 `docs/clipboard-container-sync.md` §7 P2b/P3：
  显式 host↔guest socket/vsock 通道 → 宿主/guest 各给 `link::supervise` 真实 `connect` 与
  `|d| thread::sleep(d)` → e2e：A 复制→guest 微信粘贴；微信复制→A 粘贴（秒级、无回环、断线重连）。

## 5. 任何形态下都可先复跑的全部门禁（无设备也绿，作为基线）

```sh
make test        # cargo test --workspace + 前端 bun test
make lint        # fmt + workspace clippy -D warnings + TS typecheck
make cov         # 前端 src/lib 覆盖率 ≥90%（现 92%）
cargo test -p amos-clipboard          # 49
cargo test -p amos-tauri --lib        # 144
cargo test -p amos-tauri --test clipboard_e2e  # 4（内存全双工 host↔guest 互通）
```
