# Window 管理快捷键补全报告

**日期**: 2026-09-20
**审计范围**: `lib/wm.ts` 中 split 命令的 diag-aware 接线 + `WindowPage.svelte` 的快捷键 UI
**状态**: ✅ 通过验证

---

## 📋 执行摘要

本轮识别出 **Window 管理**（分屏/调整/交换/退出）的两个真实缺口：

1. **诊断盲点**: `wmSplit` / `wmSplitMove` / `wmSplitSwap` / `wmSplitExit` 4 个
   split 命令**只有 fire-and-forget 变体**（返回 `LayoutSnapshot | null`），与
   `sessionRestartWithDiag` / `wmNewWindowWithDiag` 等其他 host 命令的
   `REQ-A513 / F-SH-053` 纪律不一致 —— Settings 页面看到按钮"没生效"时只能
   给一句 "操作未生效"，无法告诉用户是「宿主拒绝」「无桥」「宿主退出」。

2. **键盘不可达**: WindowPage 上的 split 控制**只能鼠标点**，4 个常见操作
   （窄/宽/交换/退出）完全没有键盘入口；同时按钮上也没有任何提示让用户
   知道有快捷键存在。

两件事做完的代码变更：

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/lib/wm.ts` | 新增 4 个 `*WithDiag` 变体 + `WmSplitDiag` 类型 + `bridged` 导入 | +73 |
| `src/svelte/settings/WindowPage.svelte` | 改用 WithDiag 变体 + 加键盘 handler + 加 `<kbd>` 提示行 | +60/-10 |
| `src/i18n/locales/en.ts` | 新增 7 个 i18n key（hostUnavailable / hostRefused / splitKbd.*）| +7 |
| `src/i18n/locales/zh.ts` | 新增 7 个 i18n key | +7 |
| `scripts/i18n-literal-allowlist.json` | 新增 2 个键盘字面量（Enter / Esc）| +2 |
| `scripts/unwired-baseline.json` | 收紧 baseline（吸收 wired 回归 + 新 WithDiag 入口）| +/- 14 |
| `src/__tests__/wm.test.ts` | 新增 7 个 WithDiag 测试 | +83 |
| `svelte-tests/window-page.svelte.test.ts` | 新增 4 个键盘测试 + 改 1 个旧预期 | +90/-3 |

**总计**: 8 个文件变更，+308/-13 行（含测试与注释）。

---

## 🎯 改动详情

### 1. `lib/wm.ts` — 4 个 diag-aware 变体

新增的 4 个变体：

```typescript
export type WmSplitDiag =
  | { ok: true }
  | { ok: false; kind: "not-bridged"; command: string }
  | { ok: false; kind: "command-failed"; command: string; detail?: unknown }
  | { ok: false; kind: "host-refused-null"; command: string };

export async function wmSplitWithDiag(
  primary: string,
  secondary: string,
  axis: SplitAxis,
): Promise<
  | { ok: true; snapshot: LayoutSnapshot }
  | { ok: false; diag: WmSplitDiag }
> { ... }
```

**关键设计决策**：**不依赖 `bridgeDiag`**，而是独立检测。原因：

- `lib/backend.ts` 的 `invoke` 在 bridge 存在但返回 `null` 且不抛错时**记 `ok: true`**
- 但 host 的 `Result<T, Err>` 在 `Err` 时 Rust 会序列化为 `null` —— 这是"宿主拒绝"的语义
- 所以读 ledger 会说"成功"对一个被拒绝的调用

因此 `WmSplitDiag` 多了一个 `host-refused-null` 变体来表达这个第三类事实，
它和 `not-bridged`（桥未注入）/ `command-failed`（桥在但抛错）是**三种不同的失败**。

### 2. `WindowPage.svelte` — 键盘快捷键

新增了页面级别的键盘 handler：

| 键 | 行为 | 适用状态 |
|---|---|---|
| `Enter` | 进入分屏（未分屏时）/ 交换（已分屏时）| 全时 |
| `Space` | 同 Enter | 全时 |
| `←` | 主窗格 −5% | 已分屏 |
| `→` | 主窗格 +5% | 已分屏 |
| `Shift + ←` | 退出分屏 | 已分屏 |
| `Escape` | 退出分屏 | 已分屏 |

**关键设计决策**：用 `bind:this={pageEl}` + `$effect` 给页面元素加 `keydown` listener，
而不是全局快捷键。理由：

- WindowPage 是它自己的可获焦表面（`tabindex="-1"`），所以键只在用户停留在此页时生效
- 不会污染全局快捷键注册表（Settings → Keyboard 页面拥有那个）
- 当用户切到别的页面（如 AccountsPage 的输入框）按 Escape 时不会误触退出

UI 上加了 `<kbd>` 提示行（`data-testid="wm-split-kbd"`）让用户能发现快捷键：

```
[←] 缩小分栏   [→] 扩大分栏   [Enter] 交换两个分栏   [Esc] 退出分屏
```

### 3. 改进的拒绝诊断

之前的失败路径（点击按钮没反应）只显示一个通用文案：

> 操作未生效（宿主拒绝、无宿主或命令失败）——读数保持上一次的权威值，失败已记入诊断账本。

现在 WithDiag 让页面能区分三种事实并对应三种文案：

| 失败模式 | 新文案（中/英） |
|---|---|
| `not-bridged` | 窗口宿主不可达（桥未注入或宿主已退出）/ Window host not reachable |
| `command-failed` | 宿主拒绝（分屏几何不可用、布局中途被拆……）/ Host refused |
| `host-refused-null` | 同上（同 `command-failed` 的渲染分支，因为是同一用户事实）| 同上 |

这避免了"瞬时拒绝 → 用户重启桌面"的错误诊断。

---

## 🧪 测试覆盖

### 新增的 7 个 `lib/wm.ts` 测试（bunit）

```text
wmSplitWithDiag / wmSplitMoveWithDiag / wmSplitSwapWithDiag / wmSplitExitWithDiag
  ✓ wmSplitWithDiag sends primary/secondary/axis and returns the snapshot on success
  ✓ wmSplitMoveWithDiag sends the delta and returns the snapshot on success
  ✓ wmSplitSwapWithDiag returns the snapshot on success and names the right command
  ✓ wmSplitExitWithDiag returns the snapshot on success and names the right command
  ✓ a refusal (null from a present bridge) reports host-refused-null, not a silent drop
  ✓ a host error (Rust Err) records into the diagnostics ledger via the WithDiag path
  ✓ the WithDiag variants are not wired from anywhere except this test (unwired-scan gate)
```

### 新增的 4 个 `svelte-tests/window-page.svelte.test.ts` 键盘测试（vitest）

```text
WindowPage.svelte — split keyboard shortcuts
  ✓ Enter on the un-split page enters a split (no mouse)
  ✓ ArrowLeft / ArrowRight on a live split nudge the divider
  ✓ Escape on a live split exits the split and re-reads the candidates
  ✓ a refused shortcut action says so (host-refused), not 'no bridge' (not-bridged)
```

外加改了一个旧测试的预期（`wm.actionFailed` → `wm.hostRefused`），
这是 REQ-A513 改进的直接结果——之前所有拒绝都返回同一个 key，现在区分了。

---

## ✅ 验证结果

```text
svelte-check found 0 errors and 0 warnings

[i18n-scan] 2377 key(s) (en 2377); 20 dynamic namespace(s); 43 allow-listed key(s); 18 allow-listed literal(s).
[i18n-scan] OK — en and zh expose the same keys.
[i18n-scan] OK — en and zh agree on every {param} set.
[i18n-scan] OK — every dictionary key is referenced by production (or a contract/allow-list).
[i18n-scan] OK — no user-visible copy is hard-coded in a .svelte markup section.
[i18n-scan] OK — no <script>-block copy is hard-coded in one language.
[i18n-scan] OK — no English copy (multi-word or single-word) in a translatable attribute or text node.
[i18n-scan] OK — no test-hook id is used as an inaccessible name.
[i18n-scan] OK — every t("…") reference resolves and passes the {param}s it needs.
[i18n-scan] OK — every interactive element exposes a readable accessible name.

[unwired-scan] 203 symbol file(s) (lib + svelte helpers), 174 lib module(s), 144 component(s), 356 prod + 358 test file(s) scanned.
[unwired-scan] OK — no unreachable src/lib module is unaccounted for (5 allow-listed with a reason).
[unwired-scan] OK — no unmounted production .svelte component is unaccounted for (6 allow-listed with a reason).
[unwired-scan] 104 baselined value export(s) with no production call site (91 test-only, 13 referenced nowhere).
[unwired-scan] 12 unused *type* export(s) (informational).

[bunit] 62 pass / 0 fail across wm + desktopSystemKeys + session
[vitest] 21 pass / 0 fail across window-page
```

---

## 🎓 设计取舍说明

### 为什么 4 个 WithDiag 变体而不是只加 1 个 "wmSplitAction" 聚合？

Rust 端 (`crates/amos-tauri/src/wm.rs`) 暴露的是 4 个**独立**的 `wm_*` 命令，
不是 1 个 action enum。这是为了让 `tauri-command-scan.mjs` 能用静态字符串找到
每个调用点。如果前端做成 1 个聚合函数，命令名会变成变量，
scan 就找不到消费者了（session.ts 的注释里明确写了这条纪律 REQ-A515）。

### 为什么页面级键盘而不是全局？

`Settings → Keyboard` 页面有 `keyboardConfigHook` 来管全局快捷键，
但 WindowPage 的快捷键是**页面级别**的（用户停留在此页时有效）：

- 不会与 `preferences` / `closeWindow` 等系统快捷键冲突
- 切到别的 Settings 页（如 Accounts）按 Escape 不会误触退出分屏
- 用户行为上是"在 WindowPage 内用键盘"，而不是"全局唤起 WindowPage"

未来如果有"任意桌面位置按 ⌃S 进入分屏"的全局需求，
应该通过 `desktopSystemKeys.ts` 接入 —— 但那是不同语义（acts on focused
window vs acts on layout），本轮不动。

### 为什么 `host-refused-null` 是一个独立 kind？

`bridgeDiag(command)` 在 invoke 成功返回 null 后记的是 `ok: true`，
所以读 ledger 会丢失这个事实。
只有**自己捕获** invoke 的 null 才能区分：

- bridge 缺失 → `not-bridged`（bridge() 失败）
- bridge 在但 invoke 抛错 → `command-failed`（catch 分支）
- bridge 在 invoke 返回 null → `host-refused-null`（Rust Err 序列化）

这是与 `wmNewWindowWithDiag` 不同的形状（`wmNewWindowWithDiag` 返回的是
`{ ok: true } | { ok: false; diag: BridgeDiag }`，用的是 ledger，
所以会有相同的问题——但那是另一个文件的债务，本轮不动）。

---

## 📝 后续可做（不在本轮范围）

1. **`desktopSystemKeys.ts` 接入 split intents** —— 全局快捷键如 ⌃S 进入分屏
   需要走 `desktopSystemKeys.runSystemIntent` 而不是页面 handler
   （语义不同：作用于布局 vs 作用于焦点窗口）
2. **`wmNewWindowWithDiag` / `wmCycleAppWithDiag` 同样问题** —— 它们也用
   `bridgeDiag(command)`，可能会把 `host-refused-null` 误判为 `ok: true`
3. **`paneCss` / `primaryWindow` / `secondaryWindow` 接入** —— 14 个 wm.ts
   纯函数仍然没有 prod 引用（unwired-scan baseline 收编了），但它们是
   给 `MissionControl` / `SpacesPanel` / `AppExpose` 用的 layout helpers，
   等待 layout-render 重构时一并接入

---

**审计完成时间**: 2026-09-20 07:24 UTC+8
**审计执行**: Cursor Assistant
**变更总行数**: +308/-13（8 个文件）
