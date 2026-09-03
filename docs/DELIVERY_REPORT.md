# Amos — 交付与验证报告

生成：2026-09。范围：本弧线（从「未连接守护进程」真实现象起）的根因修复、功能补全、测试基建与语音闭环。

## 1. 现状运行态（最后一次验证）
- `amos-ai`（DeepSeek，经持久化 `0600` key 恢复）· `amos-translate`（DeepSeek）· release 内嵌 UI `target/release/amos-tauri`（`sherpa-asr`+`piper-tts`）
- `make health` → health OK；socket `/tmp/amos-ai.sock` `/tmp/amos-translate.sock`

## 2. 根因澄清（重要）
- “未连接守护进程”是本前端 `backend.offline` 文案。**debug** 版 `amos-tauri` 按 `devUrl` 载 localhost:1420（= allama），那是别家 UI。
- **正确窗口 = release 内嵌 UI**：`make run-ui-release`（忽略 devUrl、不占 1420、带真实桥接与 daemon 直连）。

## 3. 基建
- `scripts/run-ui-release.sh` / Makefile `run-ui-release`。
- **DOM 逐文件进程隔离**：`scripts/bun-iso-test.mjs`（纯批一进程 + 每 DOM 文件独立 `bun test`；happy-dom 全局 per-process）。`package.json test/check/coverage:gate` 接线（cov 测纯批 `src/lib` ≥90）。

## 4. 真缺陷修复
| 项 | 修复 |
|---|---|
| 地图 | `clampZoom(NaN/±Inf)` 无兜底 → 回落最小缩放 + 回归断言 |
| 同传 transcript | `onInterpOutput` 无上界 → `INTERP_LINE_CAP=200` |
| 通知存储 | `normalizeNotifs` 无上界 → `NOTIF_CAP=100` |
| 朗读 | `realtimeTts` final 段重叠 → `activeSrc` 抢占式停旧 |
| 秒表 | 时钟回拨负值 → `max(0)`（弧线前） |
| i18n | `t()` 缺 key 回退裸 key → 全量字面量存在性守门 |
| 计算器 | iOS 左折叠误导断言（2+3×4=20）校正 |

## 5. 功能上线（release 内嵌 UI）
- **AI**：复制回答、↺ 重发、新建会话（多轮 id 轮换）、清空二次确认。
- **同传**：一键复制全部译文、双语开关、朗读/暂停/继续/清空、mic/text 输入。
- **备忘录/清单**：只读快勾、全部完成、单条+跨笔记完成率、富文本、搜索、置顶、归档/回收站。
- **Clock**：世界时钟可编辑（删/加/持久化）、秒表（计次+圈差+最快圈）、闹钟贪睡(5min)/铃/重复/删除、计时器。
- **天气**：可编辑多城市子集 + 当前城市记忆（目录含巴黎/悉尼）。

## 6. Rust daemon
- 会话管理命令：`list_sessions`、`clear_sessions`、`remove_session`、`get_history`（proto 自动 codegen）+ server 实现（安全层→`SessionManager`）+ 单测 + wire e2e。
- 会话历史：`SessionMetadata.history`（unary `stream_chat` 与 bidi `chat()` 均在单轮正常完成收尾写入 user+assistant 回合；上限 200；持久化 serde-default 兼容旧档）。
- 前端贯通：bridge `get_ai_sessions`/`clear_ai_sessions`/`remove_ai_session`/`get_ai_session_history` → TS `listSessions`/`clearSessions`/`removeSession`/`getSessionHistory` → AiApp「会话」面板（列表 + 逐行 ✕ + 历史 … + 清空全部）。

## 7. 测试与门禁
- TS：`bun-iso-test.mjs test` → 280 pass / 0 fail（39 测试文件，逐 DOM 隔离，稳定多次）。
- `tsc --noEmit` 通过；`coverage:gate` src/lib ≥90（97.9% 级）。
- `cargo test --workspace` 无 FAILED（含 daemon e2e）；`clippy --workspace -D warnings` 干净。
- UI 交互测试（假 `__TAURI_INTERNALS__` + 内部 `onChange`）：AiApp、InterpApp、Segmented、VoiceMicButton(① mic 生命周期无头)、notes/clock/weather dom。

## 8. 语音闭环证据
- ② sherpa ASR：真语音 `models/sherpa-en-20m/test_wavs/0.wav` → partial→FINAL（THE YELLOW LAMPS…）。
- ③ Piper：`en_US-lessac-low` → `/tmp/piper_out.wav`（2.24s，16000Hz Int16）。
- ① mic：组件逻辑（假 getUserMedia+AudioContext 驱动 录帧→transcribe→onTranscript）无头验证；真实麦克风/系统权限授予仍需人工在 release 窗口点按。

## 9. 复现 / 运行
```
make run-ui-release          # 拉起 daemon(DeepSeek)+release UI（看本 UI 的正确入口）
make check                   # TS 隔离测试 + typecheck
make cov                     # src/lib 覆盖率门禁
make lint                    # cargo fmt+clippy+tsc
cargo test --workspace       # Rust 全量
```
参考：`docs/AEROSPACE_SOFTWARE_AUDIT.md`、`docs/TRACEABILITY_MATRIX.md`（均已随弧线同步）。
