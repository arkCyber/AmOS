# Amos GUI 人工验证清单(多窗口 + 跨窗口同步)

> 目标：在一台有桌面的机器上,用真实 Tauri 运行时逐条核对多窗口与跨窗口同步是否
> 如预期工作。同一份流程已由 `crates/amos-wm/tests/use_cases.rs` 在纯状态机层面
> 自动断言;本节是**真机交互版**。

## 前置

```bash
# 1. 启动 AI 守护进程 + System UI(脚本会自动等待 socket 就绪;并启动 debug 构建
#    所需的 Vite dev server,见 tauri.conf.json 的 `build.devUrl`)
make dev          # 等价于 scripts/dev.sh
# scripts/dev.sh
```

> 启动器窗口(label `main`)出现,状态栏显示当前时间;通知中心铃铛默认有 3 条种子通知。

## 场景 A：多窗口(建窗 / 聚焦 / 返回主屏)

> **前置说明(REQ-A224/A225 审计后如实标注)**：本场景的 A1/A2/A5 需要前端走**真实多窗口路径**
> (`wm_open` 开一个独立 `WebviewWindow`)。**当前 Svelte 壳在自己的单 surface 内渲染 app**
> (`shellState` + `appRegistry` 懒加载)，`wm_open` 尚无界面调用点 ⇒ 这三条只能由多窗口
> 宿主本身驱动(例如 `wm_split_demo` 或后续把启动器图标接上 `wm_open`)时才有意义；
> A3/A4/A6 与「窗口管理器 (调试)」卡片则**任何情况下都可验证**(卡片恒有 `main [Launcher]`)。

| # | 操作 | 预期结果 |
|---|---|---|
| A1 | 在启动器点击「AI 助手」图标(需真实多窗口路径，见上) | 弹出**新的独立窗口**,显示 AI 助手界面(标题栏 + 输入框);启动器留在原处 |
| A2 | 再点「设置」图标(同上) | 又弹出新的**设置窗口**;它盖在 AI 窗口之上(聚焦) |
| A3 | 在设置窗口点标题栏「⌂」返回键 | 启动器窗口被聚焦并盖到最上层(设置、AI 窗口仍在后台,未销毁) |
| A4 | 打开/切到「设置 → 窗口与形态」,滚到底部「窗口管理器 (调试)」卡片(或点卡片上的「刷新」) | 卡片列出宿主**当前**的全部窗口,形如 `main [Launcher] Shown`、`notes [App] Shown`、`legacy:waydroid_0 [System] Shown · 外部表面`,聚焦者标 `←聚焦`;宿主未应答时卡片如实显示「未应答」而**不保留上一份列表** |
| A5 | 再次点击「AI 助手」图标(需真实多窗口路径) | 不新建窗口,而是把已有 AI 窗口**置顶聚焦**(复用而非重复创建) |
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

---

## 设备读数：真机上的「看得见 / 点得到」（REQ-A486）

上面的清单靠人眼；这一节是它的**仪器版** —— 同一台机器上，用辅助功能树**读**真实 UI、用合成指针**驱动**它。
工具在仓库里（`scripts/device/amos-device.swift`，包装脚本 `scripts/device.sh`）：

```bash
make device-tool ARGS='ax Amos 新建窗口'      # 谁在屏幕上：role / 标题 / 位置尺寸 / enabled / 键帽
make device-tool ARGS='ax Amos 隐藏 --visible' # 只看**真的在窗口里**的节点（其余是排版出来的）
make device-tool ARGS='activate Amos'         # 把它带到前台（点它窗口之前必须做，见下）
make device-tool ARGS='rclick 793 868'        # 在 Dock 图标上右键（真实指针事件）
make device-tool ARGS='click 1212 954'        # 点一个读到的坐标（坐标必须**在窗口内**，见下）
make device-tool ARGS='scroll 700 500 10'     # 滚轮（把排到窗口外的东西带进来）
make device-tool ARGS='key cmd+shift+n'        # 真实按键（也认 ⌘⇧N 这种字形写法）
make device-tool ARGS='press Amos 新建窗口'    # 用 AX 动作激活一个控件（绕过指针路径）
make device-tool ARGS='drag 300 120 430 250'  # 真实拖拽（AX 只能「设置位置」，不能拖）
make device-tool ARGS='--selftest'            # 设备无关的那一半（`make lint` 会跑）
```

**为什么它在仓库里**：这些读数在本项目里找到的缺陷最多（类规则的 x/y 从未到达窗口、去抖存储没有轮询者、
右键菜单的下半截被窗口裁掉、原生菜单栏广告一个壳已经不认的键），而它们此前每个会话都写在 `/tmp` 里然后丢掉
—— **无法复跑的读数不算证据**。

### 四条必须记住的读数性质

1. **AX 的 frame 是 DOM 布局，不是「窗口显示出来的东西」。** 实测：一个右键菜单的行被报在 y=913，而窗口下边缘在
   909 —— frame 是诚实的，行却是看不见的（F-DEV-069）。所以「看得见」要用**像素**判断（`screencapture` + 取色），
   两者不矛盾时结论才成立。
2. **滚动过的 web 视图里，AX frame 是「排版坐标」，不是屏幕坐标。** 实测（REQ-A489）：设置窗口 `AXWindow "设置"
   pos=(236,70) size=(1024x720)` 底边在 **y=790**，而「键盘快捷键」页的 `隐藏应用` 行被报在 **y=945** —— 数字是诚实
   的，内容却在窗外。**在这种坐标上 `click` 等于点在窗口外面：命令返回成功、什么也没发生**（本轮我在这上面白点了
   好几次，直到 `--visible` 把「157 个节点排在窗外」直接说出来）。规矩：动手前先 `--visible`，需要它就先让它进窗口
   （`scroll`，或把页面缩短/窗口放大），再按读到的坐标点。
3. **键帽不在标题里。** 菜单项广告的快捷键只能从 `AXMenuItemCmdChar` + `AXMenuItemCmdModifiers` 读出来；本工具
   会把它们翻成 `Cmd+Shift+Alt+Ctrl+<char>` 打印（REQ-A485 的读数就是这样拿到的）。
4. **点一个非活动窗口的内容，第一下只用来激活它。** macOS 会把这一次点击吞掉（除非视图 `acceptsFirstMouse`），
   现象与「点空了」一模一样：实测 `click` 返回成功、那一行没变。规矩：先 `activate <process>`，再点。另外
   ⌘-chord 会送给**聚焦的那个窗口**，不是你以为的那个 —— 本轮我用 `key cmd+w` 关掉的是主窗口而不是设置窗口。

### 一次真实读数长什么样

```
$ make device-tool ARGS='rclick 793 868'
rclick at (793,868)
$ make device-tool ARGS='ax Amos 新建窗口'
                AXMenuItem title="新建窗口 ⌘N" desc="" value="" pos=(794,682) size=(198x31) enabled
```

行在 **y=682**（指针在 868）说明菜单**翻转到了指针上方**（REQ-A481 的修复），标题里的 `⌘N` 说明键帽来自
用户的合并绑定（REQ-A484）。**一次读数同时验证了两件事** —— 这正是把工具留在仓库里的价值。

### 一次「改绑/禁用真的生效了吗」的读数（REQ-A490）

键位设置页（`设置 ▸ 键盘快捷键`）是唯一会写键位的地方，所以「用户把某个键关掉之后，原生菜单栏还广告它吗」只有在
真机上驱动那一页才答得出来：

```
$ make device-tool ARGS='activate Amos'
$ make device-tool ARGS='key cmd+shift+n'          # …或点页面里的 ✕ / 编辑徽章
$ make device-tool ARGS='ax Amos 隐藏'              # 打开 Apple 菜单后读那一行
        AXMenuItem title="隐藏 Amos" … enabled                         ← 关掉之后：没有 keyEquivalent
        AXMenuItem title="隐藏其他" … enabled  keyEquivalent=Cmd+Alt+H   ← 没同步的行原样保留
```

**修之前**（同一条命令、同一个配置）：`隐藏 Amos … keyEquivalent=Cmd+H` —— 用户关掉的键仍然印在原生菜单上，而且
macOS 会继续按它执行（F-SH-042：muda 的 `set_key_accelerator(None)` 在 macOS 上根本不碰 `NSMenuItem`，却返回
`Ok`）。修法见 `menu.rs::BINDING_OVERRIDES`：禁用行**重建**整条菜单栏（不带那个键帽），宿主日志会说
`re-drew the menu bar so the disabled rows carry no chord`。反向也验过：`重置全部` 之后那一行又拿回 `Cmd+H`。

> **写入前请知道你在动真配置**：这一页写的是**用户的**键位（WebView 的 localStorage），实验做完要还原
> （页面顶部的「重置全部」；它有一个确认对话框，对话框里的按钮要用 `click` 按坐标点，因为 `press` 取的是**第一个**
> 同名控件 —— 见下）。`press` 认名字不认序号，遇到 16 个一样的 ✕、或工具栏与对话框各有一个「重置」时，
> 用 `ax` 读到的 frame 换算中心点 `click`。

