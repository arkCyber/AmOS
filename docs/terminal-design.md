# AmOS 终端 / CLI — 需求与架构设计（shell 型，PTY/沙盒）

> 状态：设计 + 后端骨架（`crates/amos-tauri/src/terminal.rs`，未默认接入构建）。面向**真机**的通用 shell 型终端：在一个 PTY 里跑一个真实 shell，前后端经 Tauri command 桥读写。此文件同时是 bring-up 与安全评审的基线。

## 1. 为什么做 / 为什么现在做
- 现状：**没有**通用终端/CLI App（审计确认：无 `terminal` App；后端只在 `ai_bridge.rs` 跑固定脚本，非 shell、无 PTY）。
- 价值：文件操作、系统监控查询、设置/网络诊断、开发者调试——一个受控命令入口。
- 风险（必须正面处理）：**任意 shell 执行 = 逃逸面**。因此设计三件事：PTY 交互、工作目录/用户隔离、`CmdCtx` 白名单可选的执行策略。

## 2. 目标形态（iOS/桌面混合心智）
- App「终端 Terminal」：全屏可滚终端视图，输入行、回显、历史(↑/↓)、清屏。
- 后端：真机起 PTY（`/system/bin/sh` 或 `mksh`），stdin/stdout/stderr 经桥转发；前端一次性轮询或事件订阅读输出。
- 会话：可多开、可 kill、可 resize（`TIOCSWINSZ`）。

## 3. 安全模型（沙盒）
| 层 | 措施 |
|---|---|
| 进程 | PTY 子进程以**受限 UID**（非 `root`）spawn；Android 上仅在有 ADB/shell 能力时可用 |
| 目录 | 启动 CWD 默认 `appFiles`（`/data/user/0/<pkg>/files`），不继承危险目录 |
| 命令 | 结构体 `CmdCtx { cwd, env }`；预留 `allowlist: Option<Vec<String>>`——填入则非白名单命令直接拒绝 |
| 传输 | 只读/只写按会话 token；无会话则拒绝（防跨会话注入） |
| 上限 | 每会话输出环形上限；并发会话上限（防资源耗尽） |

## 4. 组件与数据流
```
[TerminalApp.svelte]
   │  term_spawn(cwd) ───────────┐
   ▼                            ▼
[backend term session registry]    spawn PTY child (shell)
   │  term_write(session, bytes)   → child stdin
   │  term_read(session) / poll    ← child stdout+stderr (combined pty)
   │  term_kill(session)           → SIGKILL + reap
   │  term_resize(session, cols, rows) → TIOCSWINSZ
   └ state: session → { pty, child, running, cwd, allowlist }
```
会话键：`u64`（进程内单调）；前端每次写/读都带键；键失效即会话已结束。

## 5. 桥命令（Tauri，后端骨架已给签名）
- `term_spawn(cwd: String, allowlist: Option<Vec<String>>) -> TermOut`
- `term_write(session: u64, data: String) -> TermOut`
- `term_read(session: u64, max: Option<usize>) -> TermOut`（返回 `Some(bytes)`；`None` = 会话已退出）
- `term_kill(session: u64) -> TermOut`
- `term_resize(session: u64, cols: u16, rows: u16) -> TermOut`
统一返回 `TermOut { id, output, error, running }`；`error` 非空即失败且 `id=0`。

## 6. 后端骨架（`src/terminal.rs`）
- 提供上述 5 个 `async fn`（`#[tauri::command]` 注释在文档接线段给出）与内部 `Session` 状态表（`Mutex<HashMap<u64, Session>>`）。
- 真实 PTY 分支以 `#[cfg(feature = "terminal-pty")]` 开关（需在 `Cargo.toml` 加可选依赖，如 `portable-pty`），并声明 `// TODO(bring-up): implement portable_pty child`。
- **默认关闭 feature 时编译为"能力未启用"实现**（返回清晰错误，无真实执行）→ 不引入运行时风险。
- 安全性默认即"拒绝一切，逐会话显式放行"。

## 7. 接线（bring-up 时执行，给出代码片段）
在 `crates/amos-tauri/Cargo.toml`：
```toml
[features]
terminal-pty = ["dep:portable-pty"]
[dependencies]
portable-pty = { version = "0.8", optional = true }
```
在 `src/lib.rs` 模块表加：
```rust
#[cfg(feature = "terminal-pty")]
pub mod terminal;
```
在 `generate_handler![]` 内加（仅真机构建启用 feature 后）：
```rust
terminal::term_spawn, terminal::term_write, terminal::term_read,
terminal::term_kill, terminal::term_resize,
```

## 8. 前端（后续一期，非本轮）
`TerminalApp.svelte`：`<pre>` 滚动回显 + 输入行；调 `term_spawn` 取会话、`term_write` 发命令、轮询 `term_read` 追加；`↑/↓` 历史、`Ctrl+C` → write `\x03`、`Ctrl+D` EOF。空态/断连 i18n。主屏/文件夹 App 里加「在此打开终端」入口。

## 9. 测试策略
- 纯层：会话 token/白名单校验、输出环形裁剪、并发上限、resize 参数合法性 —— `crates/amos-tauri/tests/terminal_policy.rs`。
- 集成(桌面 dev)：feature 开启时 spawn `/bin/sh` 跑 `echo hi`、`ls`、非法白名单命令被拒。
- 真机(bring-up)：PTY shell `id`/`pwd`/`ls /data/...` 沙盒内可用；越权路径/`su` 被拒；kill 后子进程确被回收（无孤儿）。

## 10. 验收（DoD）
1. feature 关闭时：5 命令均返回"能力未启用"，无进程残留，构建绿。
2. feature 开启（dev/真机）：真实 PTY 会话能跑只读命令并回显；`term_kill` 后无残留。
3. 白名单开启时非白名单命令被拒。
4. 全量 `bun test`+vitest+`cargo check` 保持绿（终端 UI 未接入前无前端测试负担）。
