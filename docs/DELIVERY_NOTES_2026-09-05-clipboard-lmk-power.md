# 交付说明与遗留清单 (Delivery Notes & Known Limits) — Clipboard · Power-overlap · LMK G3

**日期**: 2026-09-05
**范围**: 三段全链路 + 收尾审计：
1. **全局系统剪贴板服务**（Rust 多格式/权限/历史/AI 回退 + Android 容器桥 + TS 封装 + 前端复制粘贴/历史浮层）。
2. **power：退化多域拓扑与 overlap 去重策略**（`discover_with_policy` + `OverlapPolicy` + amos-ai 接线 + daemon e2e）。
3. **LMK G3：System UI 触发 LMK / ApplyHostDecision 的调试入口**（Rust 命令 + 常驻 LMK 开发面板，全量 i18n）。
另含 taskmgr/governor 过时注记订正与 `CLIPBOARD` 隐私修复（广播仅元数据 `ClipboardNotice`）。
**状态基线**: 工作树（`main` 之上叠加本会话改动）。
**主设计文档**: `docs/multi-window.md` §3.5、`docs/android-lmk-e2e.md`（G3）、`docs/power-policy.md`。

---

## 1. 可直接使用的提交说明（commit message）

```
feat: global clipboard service + power-overlap dedupe + System UI LMK debug entry

Global system clipboard (crates/amos-tauri/src/clipboard.rs)
- multi-format ClipboardPayload (text/html/image/uris), GlobalClipboard bounded
  history (HISTORY_LIMIT=32, seq, dedup), foreground-read permission
  (require_foreground vs WmState focus: write any window, read/history/clear only
  focused), commands clipboard_write/read/history/clear (registered, Arc-managed,
  arm_ingest in setup). Broadcasts only metadata ClipboardNotice (privacy: no
  content leak to background subscribers). AI ask_ai_agent/chat_agent fall back to
  newest clipboard text under system_selection when no target SystemContext entry
  (merge_system_selection, SystemContext priority kept). Android container bridge
  clipboard_glue.rs (feature android, JNI attach/onContainerCopy + sink) +
  ClipboardGlue.kt wired into AmosGlue (compile-checked bring-up). Frontend
  lib/clipboard.ts + ClipboardTray history overlay + Notes copy/paste/history;
  backend.ts window guard. docs/multi-window.md §3.5.

Power: degenerate multi-domain topology + overlap policy (amos-power)
- tests for sparse/non-contiguous/ghost-member topology, overlap surfacing, big
  cpu_max; new production API discover_with_policy(root,cpu_max,OverlapPolicy) ->
  Discovery{domains,overlaps} (Surface backward-compatible; Dedupe keeps earliest
  low-rep claim, drops later overlapping owner, reports Overlap). amos-ai
  DvfsDriver::from_cpufreq_root uses Dedupe + tracing::warn per overlap; new
  integration e2e dvfs_overlap_e2e.rs boots serve() under an overlapping
  AMOS_CPUFREQ_ROOT and asserts it stays up.

LMK G3 (System UI debug entry, amos-tauri + frontend)
- android_lmk_debug(action,package_name?,budget?) tauri command -> TriggerLmk
  (critical, budget) / ApplyHostDecision (freeze/thaw/reclaim) over the UDS
  AndroidManagerClient; pure mappers + unit tests; registered. Frontend lib/lmk.ts
  androidLmkDebug + resident LmkDebugPanel (settings page) with trigger (budget
  1..8), refresh, dismissible toast note, recent-victims history (clearable),
  state-filtered per-task freeze/thaw/reclaim; full i18n (en/zh incl. aria).
- housekeeping: fix clipboard-changed content leak; correct stale taskmgr
  "job read-only" changelog note.
```

## 2. 改动文件（新增/修改）

新增（Rust）：`crates/amos-tauri/src/clipboard.rs`、`crates/amos-tauri/src/clipboard_glue.rs`、
`crates/amos-ai/tests/dvfs_overlap_e2e.rs`、`crates/amos-tauri/android-glue/com/amos/ai/glue/ClipboardGlue.kt`。
新增（前端）：`frontend-ts/src/lib/clipboard.ts`、`components/{ClipboardTray,LmkDebugPanel}.tsx`、
`__tests__/{clipboard.test.ts,clipboard-tray.test.tsx,lmk-debug-panel.test.tsx}`。
新增（doc）：`docs/DELIVERY_NOTES_2026-09-05-clipboard-lmk-power.md`。
修改：`CHANGELOG.md`、`docs/multi-window.md`、`crates/amos-power/src/{lib,linux}.rs`、
`crates/amos-ai/src/governor.rs`、`crates/amos-tauri/src/{lib.rs,ai_bridge.rs,android_lmk.rs}`、
`AmosGlue.kt`、`frontend-ts/{apps.tsx,i18n/locales/{en,zh}.ts,lib/{backend,lmk}.ts}`。

## 3. 验证汇总

- `cargo test -p amos-power --features linux` **46**；`clippy --all-targets --features linux -D warnings` 干净。
- `cargo test -p amos-ai --lib` **134** + `--test dvfs_overlap_e2e` **1**；`clippy -p amos-ai --all-targets -D warnings` 干净。
- `cargo test -p amos-tauri --lib` **95**；`clippy -p amos-tauri --all-targets -D warnings`（默认 & `--features android`）干净；`cargo check -p amos-tauri --tests` 通过。
- `cargo fmt --check` 干净。
- 前端：`tsc --noEmit` 干净；`bun test` clipboard **3** + clipboard-tray **3** + lmk-debug-panel **7** + task-manager **2**；ISO 套件 `test OK`。

## 4. 已知限制 / 诚实边界 / 后续

- **Android 容器桥（ClipboardGlue / clipboard_glue）为真机 bring-up**：Rust 侧 compile-check 通过；Kotlin 模板已就位（`attach`/`pushTextClipboard`/`onContainerCopy`），真机行为待验。
- **容器摄取广播**：已通过 `setup` 的 `set_notifier` 接上 `clipboard-changed`（运行时依赖真机 `AppHandle`）；`ingest_native_text` 不武装全局 bus 的单元测试（OnceLock 并行竞态），接缝靠编译+静态保证。
- **LMK 真实回收依赖容器 host**：桌面/无容器时 `android_lmk_debug` 是诚实 no-op/报错；真机才真正回收/冻结容器 app。
- **前端本会话模块按“无桥降级 null / 空”约定**；i18n 仅 en/zh（其余 locale 走 zh/en 回退逻辑由既有系统承担）。
- **遗留可做**：剪贴板系统级“长按文本→复制/唤起”手势；power 的 `LinuxFreqGovernor::discover` 若需对 overlap 更细粒度（部分保留成员）可再演进；LMK 面板的 aria 也做“运行时切语言跟随”更多示例（当前 en 用例已断言跟随）。

## 5. 真机/验收跟进顺序

1. Android 容器桥：真机起 System UI + daemon，验证 Webview↔容器复制粘贴双向 + `ClipboardGlue` JNI 回显抑制。
2. power：Linux/Android 上跑 daemon（`AMOS_CPUFREQ_ROOT` 指向真 sysfs），确认交叠 sysfs 不崩、日志出现 overlap warn、正常拓扑无告警。
3. LMK G3：真机“回收某个 waydroid 容器 app”经 `LmkDebugPanel` 触发，观察 victims 历史与 legacy 表面拆除（WatchLmk 事件驱动）。
4. 收尾：把本会话累计改动合入主干前，跑一次 `Makefile gated-check` + 前端 `bun run check` 全量门禁。
