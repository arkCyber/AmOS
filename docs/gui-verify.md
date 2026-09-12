# Amos GUI 人工验证清单(多窗口 + 跨窗口同步)

> 目标：在一台有桌面的机器上,用真实 Tauri 运行时逐条核对多窗口与跨窗口同步是否
> 如预期工作。同一份流程已由 `crates/amos-wm/tests/use_cases.rs` 在纯状态机层面
> 自动断言;本节是**真机交互版**。

## 前置

```bash
# 1. 启动 AI 守护进程 + System UI(脚本会自动等待 socket 就绪)
scripts/dev.sh
```

> 启动器窗口(label `main`)出现,状态栏显示当前时间;通知中心铃铛默认有 3 条种子通知。

## 场景 A：多窗口(建窗 / 聚焦 / 返回主屏)

| # | 操作 | 预期结果 |
|---|---|---|
| A1 | 在启动器点击「AI 助手」图标 | 弹出**新的独立窗口**,显示 AI 助手界面(标题栏 + 输入框);启动器留在原处 |
| A2 | 再点「设置」图标 | 又弹出新的**设置窗口**;它盖在 AI 窗口之上(聚焦) |
| A3 | 在设置窗口点标题栏「⌂」返回键 | 启动器窗口被聚焦并盖到最上层(设置、AI 窗口仍在后台,未销毁) |
| A4 | 回到设置窗口点「刷新」(若已隐藏可再点设置图标) | 「窗口管理器 (调试)」卡片列出所有窗口,形如 `main [Launcher] Shown`、`ai [App] Shown`、`settings [App] Focused ←聚焦` |
| A5 | 再次点击「AI 助手」图标 | 不新建窗口,而是把已有 AI 窗口**置顶聚焦**(复用而非重复创建) |
| A6 | 在设置窗口点「⌂」,再关闭各 App 窗口 | 焦点始终回落到最近使用的窗口;最后一个 App 关闭后回到 Launcher |

## 场景 B：跨窗口状态同步(设置 → 通知中心)

| # | 操作 | 预期结果 |
|---|---|---|
| B1 | 打开「设置」窗口,把「无线局域网」开关打开 | 设置写入 `SharedStore` 并广播 `store-updated` |
| B2 | 回到启动器,从状态栏下拉(或点🔔)打开通知中心 | 快速开关区「无线 📶」应显示为**已点亮**(蓝色)——即便启动器窗口从未手动改过它 |
| B3 | 在设置窗口把「深色模式」打开 | 启动器通知中心的「深色 🌙」也实时点亮(无需刷新) |
| B4 | 重启 System UI 后再下拉通知中心 | 开关状态保持(水合 `store_snapshot` 把 Rust 权威状态写回新窗口缓存) |

## 场景 C：主屏布局跨窗口重置

| # | 操作 | 预期结果 |
|---|---|---|
| C1 | 在设置窗口点「主屏布局 → 重置」 | 设置窗口提示"已重置";同时**启动器主屏恢复为默认图标排列**(内存布局缓存被失效并重载) |

## 场景 D：AI 上下文注入(前端可点击)

| # | 操作 | 预期结果 |
|---|---|---|
| D1 | 打开「备忘录」，写/点开一条笔记，展开后在编辑工具条点「✦ 发送到 AI」（`appLinks.sendToAi`） | 笔记文本经 `system_set_context(target="ai", source="notes", text)` 附加到 AI 窗口，并切到 AI 屏（`shellState.open("ai")`）。**离线**（无桥）则不附加任何东西，AI 屏也不会显示提示 |
| D2 | 观察 AI 屏消息区上方的提示条 | 显示「已附加系统上下文（来自 notes）：…」（`system_peek_context`，多行笔记折叠成一行预览）；点 ✕ 调 `system_clear_context` 并立即消失。**没有附加上下文时不显示任何东西**（`null` 既可能是「没附加」也可能是「问不到」，故不作任何声明） |
| D3 | 在 AI 助手发送消息 | `chat_agent` 把该项 merge 进 `AgentRequest.context["system_selection"]` 并**消费**它；发送后提示条自行消失（前端重新 peek）。若从未附加过任何 per-window 项，`chat_agent` 会回退到**全局剪贴板最新文本**（此时屏上不显示任何提示——前端不对该回退做声明） |

> Waydroid/安卓侧的多窗口核对见 `docs/android-compat.md` 末尾「验证：Waydroid 侧的多窗口行为」。

## 核对失败时怎么办

- 建窗/聚焦不对 → 查 `amos-wm` 状态机(运行 `cargo test -p amos-wm`);适配层在
  `crates/amos-tauri/src/wm.rs` 的 `apply(&WmEvent)`。
- 跨窗口不同步 → 确认写路径真的调了 `store_set`（`lib/amosStore.writeStoreValue` →
  `lib/backend.systemStoreSet`；历史上这里走的是**从未被注入**的 `window.Amos.storeWrite`，
  于是透写静默失效，REQ-A101）；读回确认 `svelte/store.ts` 的 `createStoreValue` 订阅了
  `store-updated`；Rust 侧 `store.rs` 是否广播。
- 每次改完代码重新跑 `make lint` + `make test`。
