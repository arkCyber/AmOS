# 跨系统边界全局剪贴板同步（Container Clipboard Sync）

**日期**: 2026-09-08 · **范围**: 宿主↔Android 容器（Waydroid / no-UI 基座）的全局剪贴板文本同步
**状态**: 🟡 **P0（宿主半）+ P1（共享协议 + guest 代理 crate）+ P2a（离线可测 link supervisor：注入式 connect/Backoff 重连）已实现并测试**；P2b 真实宿主↔guest 字节通道与 P3 接线/审计为**设备侧待办**（⬜，需真 Waydroid/设备验收）

> **定位判定（Deployment Decision）**：仓库同时维护**两套部署底座**（`docs/android-compat.md` 定位块 + `docs/no-ui-android.md`），而「跨系统边界剪贴板是否隔离」取决于底座，不能混谈：
>
> * **形态 A — 开发/原型：Waydroid（LXC 容器）**：宿主 Webview 是桌面/Linux Wayland 客户端；微信等旧 APK 跑在**无界面 guest**（`waydroid shell am start` 驱动、表面经 Wayland/DMA-BUF 合成）。guest 拥有**独立** AOSP `ClipboardManager`，与宿主剪贴板**隔离** —— 本文要打通的正是这条「死局」。
> * **形态 B — 产品真机：no-UI Android 基座**：AmOS Webview 与旧 APK 是**同一台 Android 上的原生进程**，天然共享系统 `ClipboardManager`，**不存在隔离**。既有 `ClipboardGlue.kt`/`clipboard_glue.rs`（APK+JNI）命中的是此形态，需做的是把既有 seam 接线走通，而非新建机制。

## 1. 现状核对（已存在、可复用，勿重造）

`crates/amos-tauri/src/clipboard.rs` 是**传输无关**的全局剪贴板内核，对外同步走可插拔 seam：

```text
宿主 Webview clipboard_write ──► GlobalClipboard ──┬─► emit clipboard-changed (仅元数据 notice)
                                                   └─► mirror_to_native(entry)  ──► [ClipboardNative]
                                                                                        ▲ 可插拔传输
容器侧复制 ──► ingest_native_text("android:container", text) ──► 共享缓冲（arm_ingest 布防）
```

* `ClipboardNative` trait + `set_native_sink`/`mirror_to_native`：**宿主写→平台/容器**。
* `ingest_native_text` + `arm_ingest(Arc<GlobalClipboard>)` + `set_notifier`：**容器→共享缓冲**。
* 读/清仅前台（`require_foreground(&WmState, caller)`，对照 `amos-wm` focused）；写任意窗口可发。
* 多格式载荷 `ClipboardPayload::{Text,Html,Image,Uris}`、有界历史（`HISTORY_LIMIT=32`）。

既有实现只有形态 B 的 `ClipboardGlue`（Kotlin/JNI，`android` feature）。**形态 A 的宿主半此前缺失** —— 本轮新增 `clipboard_guest.rs` 补齐，且完全复用上述 seam。

## 2. 协议契约（单源共享，宿主半已按此实现并测试）

协议层是**单一路径**：定义在共享 crate `crates/amos-clipboard`（`amos_clipboard::proto`），宿主传输与 guest 代理**编译同一份**，杜绝两端定义漂移。宿主半传输层 `crates/amos-tauri/src/clipboard_guest.rs` `pub use` 它。由 `amos-clipboard` 的 31 项单测 + 宿主 11 项单测钉住：

**分帧（wire）**：长度前缀 JSON —— `[ len: u32 LE ][ json: <len> bytes ]`；单帧 ≤ `MAX_JSON_LEN`(1 MiB)，空帧/超限/坏 JSON 一律拒绝（fail-fast），解码器坏帧后**自动复位**、缓冲严格有界（防内存 DoS）。

**消息集**：

| 方向 | 消息 | 语义 |
|---|---|---|
| Host→Guest | `PushText { seq, ts_ms, text }` | 把一条 AmOS 纯文本复制镜像进 guest 剪贴板 |
| Guest→Host | `ClipboardChanged { ts_ms, text }` | guest 剪贴板变化（真实复制 **或** 我们推送的回显） |
| Guest→Host | `PushAcked { seq }` | 信息性确认已应用推送（永不 ingest） |

**Echo 抑制**：推送会立刻使 guest 剪贴板变化、被 guest 代理如实回报；若不拦，宿主自己的推送会以「容器侧复制」身份回流成假条目（复制回环）。宿主 `EchoGuard` 记录最近一次推送，窗口 `ECHO_WINDOW_MS`=500ms 内**同文本**的 `ClipboardChanged` 判为本方回显并丢弃；异文本（或窗口外的同文本＝用户真再复制）正常 ingest。此语义与 Kotlin `SUPPRESS_WINDOW_MS` 一致，使形态 A/B 在 Rust 边界统一。

**传输无关**：`GuestSink<W: Write> : ClipboardNative` 与 `run_ingest<R: Read>` 基于注入式字节通道——headless 全测，不绑定真实 socket。

## 3. 目标架构（形态 A：宿主 ↔ guest）

```text
[ AmOS Webview ]  复制 ──► clipboard_write ──► GlobalClipboard ──► mirror_to_native
                                                                     │
                                              GuestSink (ClipboardNative)   ← host 半（本轮）
                                                                     ▼
                                          [ 宿主↔guest 字节通道 ]（socket/vsock 桥，待实现）
                                                                     ▲
                                           guest 代理 read loop + EchoGuard
      guest app 粘贴 ◄── AOSP ClipboardManager ◄─ PushText 应用         │
      guest app 复制 ──► ClipboardManager ──► ClipboardChanged ─────────┘
                                                                    │ ingest_native_text
                                                                    ▼
                                                         共享缓冲（前台可读）
```

## 4. Guest 侧代理（P1 ✅ 已实现 `crates/amos-clipboard`）

容器内 headless 常驻组件，职责与既有 Kotlin glue 等价、但对准本协议，由 `amos-clipboard` 落地：

* **`amos_clipboard::provider::ClipboardProvider` seam**：`primary_text` / `set_primary_text` / `set_change_listener`。`MockClipboardProvider`（确定性、headless 全测，真值变更才同步触发监听、同值 no-op——对齐 AOSP）；`#[cfg(feature="android")] crate::android::AndroidClipboardProvider`（经 Kotlin bridge 的 JNI，`cargo check --features android` 编译验证，运行时需设备）。
  > 配对 Kotlin bridge（设备 bring-up、符号对齐 native upcall）：`crates/amos-clipboard/android-glue/com/amos/ai/glue/AndroidClipboardGlue.kt`。

* **`amos_clipboard::agent::GuestAgent<P>`**：`apply(HostToGuest::PushText)` 镜像进平台剪贴板（先记 echo、同值 no-op）；`attach(out)` 装监听，**真实** guest 复制 → `GuestToHost::ClipboardChanged` 交给 outbound（echo 抑制、`should_report` fail-safe）。headless 全测（Mock provider，含「宿主推送不回显」「真实复制上报」「同文本不再报」等 9 项）。
* **`amos_clipboard::proto`**：共享分帧协议（见 §2）。

实现形态二选一仍属设备判定（与两底座对应）：no-UI 基座（系统级 Rust 经 JNI/binder）或 Waydroid guest 内 system-app。`android` provider 是编译门 + Kotlin bridge 契约，**运行时未在设备验证**（诚实 no-op 惯例）。

## 5. 宿主↔guest 通道桥（P2a 离线核心已实现 `link`；P2b 真实通道 ⬜ 待设备）

`crates/amos-clipboard/src/link.rs` 落地通道桥里**传输无关、因此可离线全测**的生命周期编排：

* **`link::Backoff`**——指数退避重连策略：`base×2^n`（封顶 `max`）、有限重试预算（fail-safe：死 peer 最终放弃而非永远重试）、有用连接后 `reset`。
* **`link::supervise`**——阻塞式 connect→drain→重连驱动：注入式 `connect`（返回 `Read` 传输）、`on_connected`（每连接重建编解码器，绝不让半帧跨重连存活）、`consume`（喂原始字节）、注入式 `sleep`、`report`（诊断）。规则：连接失败按指数退避；**零字节**连接按失败处理（防 accept-即-drop 空转）；有字节的连接 `reset` 退避后立即重连。全部用内存连接器 headless 测试（Backoff 5 项 + supervise 5 项）。

「局域 UDS 秒级同步」的**难点在通道本身**（P2b）：Waydroid guest 与宿主**不共享默认 UNIX 命名空间**，需显式架桥（`waydroid shell`/vsock/binder 之上铺字节流，或容器配置显式挂 socket）。与「表面合成/DMA-BUF、IME 共享」同级，属真实 Waydroid 验收项——届时宿主/guest 各给 `supervise` 一个真实 `connect`（client / listener）与 `|d| thread::sleep(d)`，字节层以上与本处测试完全一致。

## 6. 安全与隐私

* 宿主→guest 推送会把内容落到 guest `ClipboardManager`，**明文、容器内第三方 app 可读**——应计入审计并尊重既有 deny-by-default/前台语义（镜像发生在写时、不受前台读限制，需专项测试钉住该语义边界，勿开成后台把宿主内容塞进 guest 的后门）。
* 双向经 `EchoGuard` 防复制回环；跨信任域推送应显式、可审计（对齐仓库「宿主始终是权限/审计权威」）。

## 7. 分阶段落地与验证矩阵

| 阶段 | 内容 | 载体 | 验证 |
|---|---|---|---|
| P0 ✅ | 宿主半传输 + 单源协议抽离 | `amos-tauri` `clipboard_guest.rs`；`amos-clipboard` `proto` | 宿主 **11/11**；`cargo test -p amos-tauri --lib` **143/143**；clippy/fmt 干净 |
| P1 ✅ | guest 侧代理 crate（`ClipboardProvider` seam + Mock + `GuestAgent` + `android`-gated provider） | `amos-clipboard`（`provider`/`agent`/`android`） | `cargo test -p amos-clipboard`（proto/provider/agent） |
| P2a ✅ | 通道桥离线核心（`Backoff` + `supervise`：注入式 connect/重连，含**零延迟防 flapping 地板** `min_delay`）+ **内存全双工 e2e**（host transport ↔ guest agent） | `amos-clipboard`（`link`）；`amos-tauri/tests/clipboard_e2e.rs` | `cargo test -p amos-clipboard` 全量 **43/43**；`cargo test -p amos-tauri --test clipboard_e2e` **4/4**（宿主复制→guest 应用无回环、容器复制→宿主 ingest、host guard 丢自回显、双向无损）；`cargo check --features android` + clippy(all-targets 默认 & android)/fmt 干净 |
| P2b ⬜ | 宿主↔guest 真实字节通道桥（Waydroid socket/vsock 显式架桥） | Waydroid/设备 | 真 Waydroid e2e：A 复制→微信粘贴；微信复制→A 粘贴（秒级、无回环、断线重连） |
| P3 ⬜ | 接线 `set_native_sink`/`supervise`/`run_ingest` + 审计 + guest 进程托管 | System UI + guest | 设备上长稳、断线重连、无明文泄漏 |



## 8. 诚实边界

* P0（宿主半）+ P1（guest 代理 crate：provider/agent/proto）+ P2a（`link` Backoff/supervise 重连）已实现且**可离线验证**。P2b 真实宿主↔guest 字节通道、P3 接线与端到端为设备侧工作：`android` provider 仅**编译门** + Kotlin bridge 契约，guest 进程托管、真机 A↔微信互拷、断线重连 e2e 仍未在设备验证——不伪造（同 DMA-BUF 表面合成/IME 共享的既有诚实标注）。
* 本文只约束**文本**同步；图片/URI 多格式跨容器同步超出文本 `ClipboardManager` 能力，属后续。
* 分支上 `crates/amos-tauri/src/terminal.rs` 存在**既有** fmt/clippy 债务（非本次改动引入），`make lint` 整体红需另行清理。

## 9. 相关工件

* 代码：
  * `crates/amos-clipboard/`（**新增**，P1/P2a）—— `proto.rs`（单源共享协议/分帧/echo guard）、`provider.rs`（`ClipboardProvider` seam + Mock）、`agent.rs`（`GuestAgent`）、`android.rs`（`android`-gated JNI provider）、`link.rs`（`Backoff` + `supervise` 通道桥生命周期）、`android-glue/com/amos/ai/glue/AndroidClipboardGlue.kt`（guest Kotlin bridge，设备 bring-up）。
  * `crates/amos-tauri/src/clipboard.rs`（内核 seam）、`src/clipboard_guest.rs`（宿主半，`pub use amos_clipboard::proto`）、`src/clipboard_glue.rs` + `android-glue/.../ClipboardGlue.kt`（形态 B）。
* 架构：`docs/android-compat.md`（形态 A）、`docs/no-ui-android.md`（形态 B）、`docs/multi-window.md`。


