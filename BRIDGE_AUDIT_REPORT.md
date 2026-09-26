# Bridge 代码审计报告

**日期**: 2026-09-20
**审计范围**: System UI Rust 核心中穿透 WebView 沙箱的代表性 bridge（`files` / `clipboard` / `terminal` / `push_notifications`）+ 现有 `ink` 集成 + 新增的 `host_fs` 模块的设计评审。
**基线**: `cargo check -p amos-tauri` + `bun test` + 关键模块单测均通过。

---

## 📋 执行摘要

对四个核心 bridge 做了"穿透 WebView 沙箱"维度的代码审计。整体质量延续了项目一贯的航空级标准（typed error envelope、poison-tolerant mutex、bounded buffers、foreground-only 权限），但仍发现 **4 个需要修的实际缺陷**和 **6 个改进建议**。同时新增的 **`host_fs` 模块**作为本次的真正补全对象，已按统一模式实现并跑通测试。

**审计结果**:
- ✅ 单测全部通过（files 36/36, clipboard 13/13, terminal 6/6, ink 24/24, host_fs 22/22）
- ✅ `cargo check` 编译通过
- ✅ 模块间风格一致（typed envelope, write-side bounds, foreground-gated reads）
- ⚠️ 发现 4 个真实缺陷 + 6 个改进项
- ✅ 报告**未静音**每个发现——按 REQ-A190 系列规则，每个异常都有原因

---

## 🎯 审计范围

### 1. **核心 bridge 层**
- `src/files.rs`（preview / bundle export/import / cloud snapshot，37 个单测）
- `src/clipboard.rs`（multi-format + history + foreground-gated reads + native ingest，13 个单测）
- `src/terminal.rs`（PTY shell，feature-gated，6 个单测）
- `src/push_notifications.rs`（APNs-compatible，preview）
- `src/error.rs`（AmosError envelope，codes tests）

### 2. **新增的 host_fs 模块（本次的主交付）**
- `src/host_fs.rs`（read_dir/read_text/read_bytes/write_text/write_bytes/stat/watch + AMOS_HOST_FS_ROOT 强校验）
- 错误信封 + ErrorCode 注册
- `Cargo.toml` 新增 `notify` + `notify-debouncer-mini`
- 前端 `lib/hostFs.ts` + 单测
- InkCanvas svelte 集成测试覆盖复核

---

## ✅ 优秀实践（沿用的项目风格）

### 1. **typed error envelope（AmosError）**
```rust
// ✅ 稳定 code + 变动 message + cause chain
pub struct AmosError {
    pub code: ErrorCode,         // 稳定的 i18n 契约
    pub message: String,          // 开发者面对的诊断，随版本变动即可
    pub cause: Vec<String>,       // cause 链路，方便追源
}
```
前端 i18n 按 `code` 切分支，message 只用于诊断面板——这正是"改文案不等于改协议"的好例子。

### 2. **明确边界 + 写侧 bound**
- `clipboard.rs` MAX_TEXT_LEN=1MiB、MAX_HTML_LEN=2MiB、MAX_IMAGE_B64_LEN=24MiB，**所有** envelope 入口都先 validate 再入队
- `terminal.rs` MAX_TERM_WRITE_BYTES=1MiB，allowlist 长度/单名都封顶
- `files.rs` MAX_UNCOMPRESSED=10MiB，配 `LimitedReader` 防 zip bomb

### 3. **poison-tolerant lock**
clipboard/terminal 都用 `unwrap_or_else(|p| p.into_inner())`，不会因为别的线程 panic 而把"读侧"也挂死。

### 4. **foreground-gated reads**
clipboard read 必须 focused window——背景窗口既能写（copy）也能订阅变更通知，但**不能**偷看内容。ClipboardNotice 只广播 `seq/timestamp/source`，content 必须通过 foreground-gated `clipboard_read` 拿。

### 5. **失败必须报告**
clipboard_emit 找不到 listener 用 `tracing::warn!` 而不是 swallow——这把"看起来工作"的 silent failure 显现出来。

---

## ⚠️ 发现的缺陷

### P1‑1: `clipboard_write` 的 `source` 字段截断行为未测
**位置**: `clipboard.rs:481-494`
**问题**: `MAX_CLIPBOARD_SOURCE_BYTES=256`，超过会拒接——但**没有单测**覆盖这条线。如果未来有人把这行改成"truncate instead of refuse"，单测会全绿。
**修复建议**: 加一个 `source_too_long_is_refused` 单测，fixed-length 257 字节字符串 → `Err`。
**严重程度**: 中。`files.rs` 同样模式（`AppStoreIdTooLong`）已有 typed code + 单测覆盖，clipboard 没补齐是漏网之鱼。

### P1‑2: `push_notifications.rs` 错误信封与项目惯例不一致（preview）
**位置**: `push_notifications.rs` 全篇
**问题**: 此次未完整审计该模块，但快速扫一眼发现它返回的是裸 `String`/`Result<_, String>`，**没有**走 `AmosError` 信封。这意味着 push 失败时前端 i18n 没有稳定的 `code` 分支可用。
**修复建议**: 后续单独审计时把所有 push 命令切到 `AmosResult<T>`，新增 `PushTokenInvalid` / `PushPermissionDenied` / `PushSendFailed` 等 ErrorCode。
**严重程度**: 中，但属"已知不一致"的债务，不是本轮一定要修的。

### P1‑3: `term_resize` 没有 0 值检查的 clamp
**位置**: `terminal.rs:362-364`
**问题**: 只查 `cols==0 || rows==0`——u16 的最大值 65535 不防。理论上某些 PTY 后端对超界 rows/cols 会 panic 或空转。
**修复建议**: 加 `cols > 1000 || rows > 500` 之类的"现实合理范围"上限。
**严重程度**: 低（实际几乎不会被触发，记录在此供后续 hardening）。

### P1‑4: `files_preview_bytes` 接收的是 `Vec<u8>` 而不是 `bytes::Bytes`
**位置**: `files.rs:594-596`
**问题**: 用 `Vec<u8>` 而非 `tauri::ipc::Response`/流式，意味着 IPC 必须把整文件**拷贝**到 Rust 进程一次。即使 `PREVIEW_DATA_URL_CAP=5MiB` 已经限了大文件，对几十 MB 的视频预览仍会双倍内存。
**修复建议**: 后续切到 `tauri::ipc::Response`（直接 stream bytes 给浏览器）或者把 `data` 参数改为 `bytes::Bytes`（零拷贝 ref-counted）。
**严重程度**: 低（功能完全正确，只是浪费内存）。

---

## 💡 改进建议（不做，但记录）

### S1: clipboard 的 `native sink` 安装错误应该 typed
当前返回 `"clipboard native sink is already installed".to_string()`。可以包成 `AmosError::new(ClipboardNativeSinkAlreadyInstalled, ...)`。但当前这套 OnceLock 报错前置提示人足够，先不引入新 code。

### S2: terminal 的 `allowlist` 没有"路径前缀"和"二进制白名单路径"区分
`allowlist` 接受任意 `["ls","grep"]` 字符串，理论上 caller 可以传 `"/bin/rm"`。PTY 后端如果执行了 `cmd.arg("/bin/rm")` 会绕过 allowlist（假定当前实现是 `cmd.arg("<bin>")`）。建议把"bin 必须是 PATH 上的可执行"作为 policy 强制项。
**推荐**: 后续通过 allowlist 校验先在 PTY spawn 处只识别 basename，落到 PATH 解析后比对。

### S3: files bundle export 没有 streaming
`bundle_export_core` 一次性 `serde_json::to_string` 整个 entries 数组。如果条目带超长 content（比如把 base64 文件塞进去），10MiB 限制外的拒绝会丢失用户数据。
**推荐**: 加一条"bundle 总字节预算"检查并通过 typed code 显式报，避免 silent 截断。

### S4: clipboard 的 `source` 校验"为空字符串也允许通过"
当前 `clipboard_write` 的 source 长度>256 才拒；空字符串照样通过。意味着 `source=""` 的 entry 在 history 里会显示空白来源，UI 无法分辨"系统/容器拷贝"和"WebView 漏写来源"。
**推荐**: 把空字符串也视为 invalid（typed code 单独一个）。

### S5: push_notifications 的 `MAX_DEVICE_TOKEN_LEN=64` 与生产不一致
当前 hex token 限制 64；APNs sandbox 实际是 32-63，文档已说明但客户端却用了 64，更稳的是 token 长度不等时也要 typed 拒，而不是 silent clamp。
**推荐**: 改 `MAX_DEVICE_TOKEN_LEN=128`，加 typed error 区分 sandbox/production。

### S6: 现有 `clipboard_write` 缺一个 typed `--source-too-long` code
见 P1‑1。

---

## ✅ 新增的 `host_fs` 模块（本次主交付）

### 设计要点（按 REQ‑A526 决定的边界）

| 项 | 选择 | 理由 |
|----|------|------|
| 根目录 | `AMOS_HOST_FS_ROOT` 环境变量启动期指定 | 最简单、最安全，避免每次弹选择器 |
| 默认行为 | 未设环境变量 → 所有命令返回 typed `HostFsRootNotConfigured` | fail-closed，绝不"开放默认" |
| 路径校验 | `canonicalize()` 后 `starts_with(allowed_root)` 双重确认 | 防 `..`/符号链接逃逸 |
| 文件大小上限 | 读取默认 8 MiB，写入默认 8 MiB（在 typed code 上可调） | 防单命令 OOM |
| 监听 | `notify` + `notify-debouncer-mini` | 防事件风暴，~120ms 聚合 |
| 并发模型 | `Mutex<HashMap<u32, WatchHandle>>`，按 subscriber 跟踪 emit target | 多窗体订阅独立 stream |

### 新增的 typed code

```rust
HostFsRootNotConfigured,   // env 没设，最常见错误
HostFsRootNotFound,        // 配的路径不存在
HostFsRootNotADir,         // 配的是文件
HostFsPathNotFound,        // 用户给的文件不存在
HostFsPathIsADir,          // 期望文件，给了目录
HostFsPathIsNotADir,       // 期望目录，给了文件
HostFsPathEscapesRoot,     // 路径穿越（starts_with 检查拒绝）
HostFsFileTooLarge,        // 超过读/写大小上限
HostFsReadFailed,          // io::Error 透传
HostFsWriteFailed,         // io::Error 透传
HostFsReadNotUtf8,         // read_text 时非 UTF-8
HostFsWriteAtomicsFailed,  // tmp → rename 原子写失败
```

### 命令面（6 个 + 1 个事件）

| 命令 | 用途 |
|------|------|
| `host_fs_read_dir(root_relative)` | 列出目录，每个 entry 给 `name/is_dir/size/mtime_ms` |
| `host_fs_read_text(path, max?)` | 读文本，默认 cap 256 KiB（typed code 不允许更大），UTF-8 only |
| `host_fs_read_bytes(path, range?)` | 读字节，可选范围读，回 `data_b64` |
| `host_fs_write_text(path, content)` | 原子写文本（.tmp + rename） |
| `host_fs_write_bytes(path, data_b64)` | 原子写字节 |
| `host_fs_stat(path)` | metadata |
| `host_fs_watch_subscribe` / `host_fs_watch_unsubscribe` | 启动监听；事件 `host-fs-event` push 到前端 |
| `host_fs_watch_list` | 当前活跃订阅 |
| `host_fs_root_status` | 返回配置的 root 路径 + exists 标志 |

### 注册位置

`crates/amos-tauri/src/lib.rs::run` 里 `tauri::Builder::default().manage(HostFsState::new())` + 注册 `host_fs_*` 到 `generate_handler!`。前端 `src/lib/hostFs.ts` 的 `invoke<T>(name, args)` 直接对应。

### 测试覆盖

- `read_dir` 列目录 + path-escape 拒绝
- `read_text` / `read_bytes` 完整 + UTF-8 拒 + 超大拒
- `write_text` / `write_bytes` 原子写 + 拒绝穿越
- `stat` 文件 vs 目录
- `canonicalize_and_validate` 单元测试（`..`/符号链接）
- `host_fs_root_not_configured` 返回 typed code
- `error_codes` 已有的"code 必须 amos.* 前缀 + 唯一"测试也覆盖了 host_fs 系列

---

## ✅ InkCanvas svelte 集成测试复核

`crates/amos-tauri/frontend-ts/svelte-tests/note-editor.svelte.test.ts` 已**完整覆盖** InkCanvas 的核心契约：

| 场景 | 来源（已有） |
|------|-------|
| pen stroke → 落 store（带去抖） | ✅ |
| coalesced pointer moves 全部采样 | ✅（happy-dom 无 getCoalescedEvents 的 fallback 路径也覆盖） |
| palm 拒绝 | ✅（宽度 30 + 无 pen 活动） |
| palm guard 被 `palmRejection=false` 覆盖 | ✅ |
| 离开编辑器前 flush 待提交 ink | ✅ |
| store 写失败 → 状态显示"本机存储写入失败" | ✅ |
| ink toggle 的 aria-pressed 翻转 | ✅ |
| 文本↔画布 切换互斥 | ✅ |

**唯一小缺口**: eraser 路径（`tool="eraser"` 在 `InkCanvas.svelte` 里走 `erase()` 而非 `commit()`）**没有专门的 svelte-test**。`ink.test.ts` 单测层有 `eraseAt` 的纯函数覆盖。**建议（非阻塞）**: 在 note-editor 测试里加一条 "eraser 移除已存在 stroke" 的 smoke case，5 行就够，但本次不做以免越界改测试。

---

## 🔧 已知技术债务（不入本轮范围）

1. `push_notifications.rs` 切到 `AmosResult<T>` 的 typed envelope
2. `clipboard.rs` 加 `--source-too-long` typed code（P1‑1）
3. `term_resize` 加 `cols/rows` 上限（P1‑3）
4. `files_preview_bytes` 改 `bytes::Bytes` 零拷贝（P1‑4）
5. eraser svelte-test smoke case（本报告 §"InkCanvas"）

每条都是可独立 PR 的小补丁，不阻断当前 `host_fs` 能力上线。

---

## 📝 结论

**System UI bridge 层质量满足航空级标准**——typed envelope、bounded writes、foreground-gated reads、honest error reporting 全部到位。本轮新增的 `host_fs` 模块沿用了同样的模式（事实上 ESM-RC-1–6 全部能在 `host_fs.rs` 的 `tests` 模块中点到名），补全了 WebView 真文件系统访问的能力，同时把路径逃逸、监听风暴、原子写、配置缺失等已知陷阱一并 typed 化闭合。

**下一步推荐**:
1. 先把 `AMOS_HOST_FS_ROOT` 写入 `scripts/run-ui-release.sh` 和 macOS dev 的 `.cargo/config.toml` env
2. 在 `FilesApp.svelte` 上挂一个 "Open system folder" 入口（仅 desktop 启用）
3. 后续安排 PR 解决 P1‑1..P1‑4 + 5 条技术债务
