# AmOS — PC 桌面版对齐审计报告 (macOS 优先)

> 状态：**草稿 v1**（2026-09-15）
> 发起人：@arkCyber
> 范围：PC / desktop 形态因子在 macOS 上的"对齐 macOS Aqua 桌面体验"路径。
> 关联：
> - `docs/multi-window.md`（多窗口协议与 form-factor 域）
> - `docs/multi-window.md` §1.5（形态 → 内容几何）
> - `crates/amos-wm/src/form.rs`（形态/布局策略）
> - `crates/amos-tauri/src/wm.rs`（Tauri 适配）
> - `frontend-ts/src/svelte/Shell.svelte`（运行时壳）

## 1. 用户诉求

> "操作系统的PC 版本现在是手机版本的显示扩大版本，不合理！希望你能够帮助我对齐 苹果电脑的桌面版本的摸样，帮助我全面实现，开始帮助我审计与补全代码。"

**关键词**：PC 版 = "手机版放大"、要求对齐 **macOS 桌面 Aqua** 体验、要全面实现、要先审计再补全。

## 2. 项目对"PC 形态"的现有承诺（代码 + 文档）

按已完成的代码与文档，工程对"PC 形态"已有以下交付物：

| 模块 | 现状 | 评价 |
|---|---|---|
| `amos-wm::form::FormFactor` | `phone / tablet / desktop / robot` 四类已落地；`LayoutPolicy` 给出 `multi_window / free_resize / divider_gap / min_pane / max_columns / initial_window`。 | ✅ **领域形态**完整，desktop 类（`multi_window=true`、`free_resize=true`、`max_columns=4`、`initial_window=1024×720`）已建模。 |
| `amos-wm::LayoutPolicy::shell_fit` | `Leave / Resize(Size) / Maximize` 三种；desktop → `Maximize`（让平台决定可用区）。 | ✅ shell 窗口已可最大化（REQ-A233 实测：1496×881 实测应用，cols=4）。 |
| `amos-tauri::wm::sync_window_layout` | 真实窗口 `Resized / ScaleFactorChanged` 事件 → 重新测量屏幕并广播 `layout-changed`。 | ✅ **物理→逻辑像素**换算 + DPR 处理已落地（REQ-A218）。 |
| `amos-tauri::wm::apply_split_to_real` | 把 split 窗格落到**真实 OS 窗口**（不是壳内虚拟窗格）。 | ✅ 真正的"分屏到 OS"已具备宿主侧能力（`docs/multi-window.md` §1.5 已记录）。 |
| `amos-tauri::wm` 的命令族 | `wm_open / wm_focus / wm_hide / wm_close / wm_home / wm_windows / wm_split*`。 | ✅ 全部命令已实现，但 **UI 消费者只有"窗口与形态"页的 split 控件**（REQ-A224）—— 启动器图标依然走**单窗口 SPA 路由**，不调 `wm_open`。 |
| `tauri.conf.json` 桌面默认窗口 | `480 × 820`（phone 板）→ REQ-A222 → REQ-A233 后由 `fit_shell_window` 改成 `Maximize`。 | ✅ 主窗口尺寸已自适应。 |
| `frontend-ts/src/lib/formLayout.ts` | phone=4×3、tablet=4×6 / 6×4；**desktop 刻意排除**（注释："its window is already a real, freely resizable OS window… changing its launcher density is a separate, visible decision that must not ride along with the tablet work. It therefore keeps the phone grid"）。 | ⚠️ **桌面类的"内容几何"被刻意排除**，本审计要补的就是这一段。 |
| `frontend-ts/src/svelte/Shell.svelte` | 单一全屏 `Shell`，`surface` 状态机：`home / app / library / edit / lock`；无 "desktop" surface。 | ⚠️ 桌面形态**没有专用的 shell 拓扑**——同一份 Shell 模板既要服务 480×820 手机板，又要服务 1496×881 macOS 桌面，结果就是"手机版放大"。 |
| `frontend-ts/src/svelte/HomeDock.svelte` | 单列全屏 + 4×3 图标网格 + 底部 Dock；iOS-style 启动器。 | ⚠️ 是**手机启动台**；桌面形态下没有"Dock 永久常驻 + Launchpad 召出 + 多窗口舞台"的拓扑。 |
| `frontend-ts/src/svelte/StatusBar.svelte` | 顶部一条窄条 + Dynamic Island；只有手机/平板的语义（信号、电池、单点时间）。 | ⚠️ 桌面形态下：① 没有 **macOS 顶栏（Global Menu）**；② 没有 **侧栏 / Spotlight 坞站**；③ "信号" 等手机语义在桌面上无意义。 |
| `frontend-ts/src/svelte/NotificationCenter.svelte` | iOS 风格下拉面板，含亮度/音量/勿扰/快速开关/通知列表。 | ⚠️ 是**手机控制中心**——macOS 上没有这个面板，也没有 macOS 风格的"通知中心侧栏"。 |

**结论**：工程**有能力**呈现桌面形态（Rust 侧的 `FormFactor::Desktop` + `ShellFit::Maximize` + 多窗口 + free resize + 真实 split），**但前端没有 desktop 形态的壳拓扑**——所有现有 UI 都是"手机壳套到桌面窗口里"的拉伸版。

## 3. 缺陷 / Gap 清单

### 3.1 缺陷 P0-1：没有"桌面 shell"拓扑，PC 版即手机版放大

**现状**：
- `Shell.svelte` 渲染一个全屏 `<div class="relative h-full w-full overflow-hidden">`，把 `surface=home / app / library / edit / lock` 叠在上面；HomeDock 是 **单列单页**（`HomeDock.svelte` 顶部 widget 区 + 4×3 图标 + 单行 Dock）。
- `tauri.conf.json` 的窗口 `resizable: true` 已经开启 free resize，但**任何子组件都不会按窗口尺寸重新排版**：`HomeDock.svelte` 的图标网格使用 `grid-cols-4` + `grid-template-columns: repeat({grid.cols}, …)`，desktop 类上 `grid.cols = 4` ⇒ 在 1496px 宽度上仍然只画出 4 列，与 macOS Finder 视窗的"很多列"完全不同。
- 没有"窗口列表 / 已打开应用"、没有"顶栏"、没有"侧栏"。

**macOS Aqua 的对应物**：
1. **顶部 Global Menu Bar**：聚焦哪个应用，顶栏就显示该应用的主菜单（File / Edit / View / Window / Help…）+ 系统侧菜单（Apple 🍎 / App / File / Edit…）。
2. **底部 Dock**：常驻、最多显示最近/收藏的若干个应用 + 分隔线 + 堆叠 + 下载 + 废纸篓。
3. **Mission Control / 应用切换**：`F3` / 四指上滑 → 所有打开的窗口平铺预览。
4. **Launchpad / 启动台**：Dock 上的图标 / 快捷键 → 全屏网格查看所有应用。
5. **Spotlight**：`⌘ Space` → 全局搜索 + 计算器 + 字典 + 单位换算。
6. **通知中心**：右上角时间 → 侧滑出通知 + Widget 面板。
7. **桌面窗口**：Finder / 任何 app 都是**独立的 `WebviewWindow`**，可以自由移动、缩放、最小化、关闭、Z 序排列。

### 3.2 缺陷 P0-2：启动器只走"单 SPA 路由"，没有走 `wm_open` 多窗口

**现状**：
- `frontend-ts/src/svelte/Shell.svelte` 在用户点图标时调 `open(id)` → `shellState.open()` → `_surface = { kind: 'app', id }`（**Svelte 单窗口内 SPA 路由**）。
- `amos-tauri/src/wm.rs` 的 `wm_open` 命令完全没有被启动器调用——`scripts/unwired-scan.mjs` 不报警（因为桌面/手机形态都不调它）。
- `frontend-ts/src/lib/windowRoute.ts` 已经实现了 `appIdFromHash(hash)`，让**真实窗口**在 `#window=<id>` 时能正确切到对应 app。但**没有任何代码生成这个 fragment**——`wm_open`（Rust 侧）创建新窗口时也没有给新窗口传 `#window=<id>`（`docs/multi-window.md` §1.5 注释提到要传，但 `apply()` 在 `WmEvent::Created` 分支并没有附加）。

**macOS 期望行为**：
- 用户点击启动器上的 **Calendar** 图标 → 调 `wm_open('calendar')` → 宿主创建一个**新的 `WebviewWindow`**（`label=calendar`，初始尺寸按 `LayoutPolicy::Desktop.initial_window = 1024×720` 或 `Lib::maximized`），加载 `index.html#window=calendar` → 前端从 hash 读到 `calendar` → 进入 `surface = { kind: 'app', id: 'calendar' }`。
- 这才是 macOS "每个 app 是独立窗口" 的行为。

### 3.3 缺陷 P0-3：`formLayout.ts` 桌面类被刻意排除，没有任何桌面专用几何

**现状**：
- `homeGrid(form, w, h)`：
  ```ts
  if (form !== "tablet" || !measured) return PHONE_GRID;
  ```
- desktop 类 → `PHONE_GRID`（4×3）。

**缺陷**：
- macOS Finder 桌面 / Launchpad 是 **8 列 × 5 行 = 40 网格**（1440×900 默认）或更大网格。
- 即使想做"Launchpad 启动台"（全屏网格 + 大图标 + 分组），桌面类也必须有自己的 `DESKTOP_LAUNCHPAD_GRID` 与 `DESKTOP_DOCK_GRID`。
- macOS Dock 的尺寸随窗口宽度自适应（Dock 偏好设置里的"大小"），但工程连"桌面 Dock 常驻"这一层都没有。

### 3.4 缺陷 P0-4：没有 macOS 风格的顶栏 / 全局菜单

**现状**：
- `StatusBar.svelte` 是一条 22px 高的窄条 + Dynamic Island + 右侧信号/WiFi/电池。
- 桌面形态下没有 "🍎 Apple" + "AppName" + "File / Edit / View / Window / Help" 的全局菜单。

**macOS 期望**：
- **顶部 ~28px 菜单栏**：左侧 Apple menu + 当前 App 名 + 主菜单；右侧 Spotlight / 控制中心 / 时钟 / 电池 / WiFi；这是 macOS 桌面体验**最显眼**的特征之一。
- 桌面上是"系统菜单 + 应用菜单"两类——本工程可以先实现"系统菜单（App / File / Edit / View / Window / Help）" + 一个动态"App 菜单（聚焦哪个 app 就显示哪个 app 的菜单）"，这在 WebView 里通过 IPC 把"当前 app 的菜单描述"从 Rust 注入是可行的。

### 3.5 缺陷 P0-5：没有侧栏 / 桌面 widget 面板

**现状**：
- `AppLibrary.svelte` 是**手机 iOS 的 App Library**（已分组的应用网格）。
- 桌面上没有 "Finder 侧栏"（收藏 / iCloud / 桌面 / 文档 / 下载）或 "Dashboard Widget" 概念。

**Phase 2 不一定补**：macOS 风格的侧栏不是 PC 形态的核心（用户首要诉求是"看起来像 macOS"，不是"复制 Finder"）。可以保留为后续工作，但**第一轮必须做到**：
1. 桌面 shell 拓扑（顶栏 + Dock + 启动台）。
2. 多窗口（每个 app 真实 OS 窗口）。
3. 顶栏（含 Spotlight / 时钟 / 电池）。
4. 启动台（点击 Dock app 图标召出）。

### 3.6 缺陷 P0-6：壳内的"overlay/RecentsPanel/SpotlightPanel/NotificationCenter"语义错配

**现状**：
- `RecentsPanel.svelte`：iOS 风格的"最近 app 大卡片列表"——macOS 是 `⌘ Tab` 切换或 `Mission Control`，语义不同。
- `SpotlightPanel.svelte`：作为 iOS 的"下拉搜索"——macOS 的 `⌘ Space` 是**全屏居中浮层**，且能跑任意命令（计算、单位换算、跳转）。
- `NotificationCenter.svelte`：iOS 的下拉控制中心——macOS 是右上角时间 → 侧滑出通知列表 + Widget 面板。

**桌面改造建议**（作为后续 Phase）：
- Spotlight 改造为 `⌘ Space` 全局快捷键 + 居中浮层 + 命令面板能力。
- Recents 改造为 `⌘ Tab` + 顶栏任务栏（聚焦窗口的最小化预览）。
- NotificationCenter 改造为顶栏右上角的"通知计数 + 侧滑面板"。

### 3.7 缺陷 P1-1：窗口尺寸 / 拖动 / 缩放的策略不完整

**现状**：
- `LayoutPolicy::Desktop.initial_window = 1024×720`，但这是**新窗口的初始尺寸**。
- 桌面形态的窗口**应当**：① 可以被用户拖动；② 可以从边缘缩放；③ 可以最小化到 Dock；④ 关闭按钮（已有 `wm_close`）。
- 工程**没有**实现"窗口 chrome（标题栏 / 红绿黄按钮）"的改造；Tauri 默认窗口有原生 chrome，但工程没把它"对齐 macOS"——这取决于用户的实际诉求（保留 Tauri 原生 vs. 自绘 WebView 标题栏）。

### 3.8 缺陷 P1-2：快捷键缺失

**现状**：
- `Shell.svelte` 的键盘处理只有 `Escape` 关 overlay。
- 桌面形态需要：`⌘ Q` 退出 / `⌘ W` 关窗口 / `⌘ M` 最小化 / `⌘ Tab` 切窗口 / `⌘ Space` Spotlight / `⌘ ,` 偏好 / `⌘ N` 新建 / `F11` 全屏。

### 3.9 缺陷 P2-1：CSS 设计语言没有"桌面"分支

**现状**：
- `index.css` / Tailwind 配置是**手机优先**的（圆角、阴影、模糊、iOS-like dynamic island）。
- 桌面形态需要：① 顶栏毛玻璃；② Dock 毛玻璃；③ 启动台全屏网格 + 大图标；④ Spotlight 全屏居中浮层 + 巨大输入框。

## 4. 修复总览（路线图）

| 阶段 | 内容 | 文件 | 状态 |
|---|---|---|---|
| Phase 1 | 本审计报告 + 架构设计文档 | `docs/PC_DESKTOP_AUDIT.md`（本文件）、`docs/PC_DESKTOP_ARCHITECTURE.md` | ✅ 草稿 |
| Phase 2.1 | `frontend-ts/src/lib/formLayout.ts`：补 `desktop` 类的桌面专用几何（启动台 8×5、Dock 7-9 项、顶栏 28px） | `formLayout.ts` | ⏳ |
| Phase 2.2 | `frontend-ts/src/lib/desktopLayout.ts`：新增"桌面布局策略"模块（顶栏 / Dock / Spotlight / Mission Control 的几何常量与决策函数） | `desktopLayout.ts`（新） | ⏳ |
| Phase 3.1 | `amos-tauri/src/wm.rs`：`apply_split_to_real` 之外，扩展 `wm_open` 让新窗口附带 `#window=<id>` fragment | `wm.rs` | ⏳ |
| Phase 3.2 | `frontend-ts/src/svelte/Shell.svelte`：根据 `LayoutSnapshot.form === 'desktop'` 渲染 **DesktopShell**（顶栏 + Dock + 启动台 + 多窗口舞台），其他形态走现有手机壳 | `Shell.svelte` + 新增 `DesktopShell.svelte` | ⏳ |
| Phase 3.3 | 新增 `TopBar.svelte`（macOS 顶栏）、`Dock.svelte`（macOS 底部 Dock，常驻）、`Launchpad.svelte`（启动台，全屏网格）、`MissionControl.svelte`（应用切换） | `frontend-ts/src/svelte/` | ⏳ |
| Phase 3.4 | `apps.tsx` 注册流程：`open(id)` 在桌面形态下改为调 `wm_open`；`amos.home.layout` 在桌面形态下变为"哪些 app 进 Dock + 哪些 app 进 Launchpad" | `apps.tsx` / `shellState.svelte.ts` | ⏳ |
| Phase 3.5 | i18n 键补：`desktop.*`（顶栏 / Dock / 启动台 / Spotlight / Mission Control） | `frontend-ts/src/i18n/locales/zh.ts`、`en.ts` | ⏳ |
| Phase 4 | 单元测试 / 集成测试：`formLayout.test.ts` 补桌面类断言、`desktopLayout.test.ts` 新文件、`Shell.test.ts` 桌面/手机切换 | `frontend-ts/src/__tests__/` | ⏳ |
| Phase 5 | 文档同步：`docs/multi-window.md`、`docs/ENV_VARIABLES.md`（`AMOS_FORM_FACTOR=desktop`）、`README.md` 增加 "PC 桌面版对齐"段落 | 多文件 | ⏳ |

## 5. 不在本次范围（诚实边界）

按工程纪律，以下事项**不在本轮"PC 桌面版对齐"目标内**，但作为**已知缺口**记录：

1. **完整的 macOS 全局菜单注入**（每个 app 描述自己的菜单结构，由 Rust 注入到顶栏）—— 需要每个 app 注册菜单描述，且需 Tauri 2 的 `Menu` API（不在工程当前依赖里）。Phase 3.3 顶栏可以先实现"系统菜单 + 当前 app 名 + 占位 Help"，待 Phase 6 引入 `tauri::menu` 后再扩。
2. **Mission Control 的真实窗口平铺**（操作系统层级的窗口管理器）—— 这是 OS 提供的功能，工程可以发一个 `MissonControl` 快捷键给宿主，但**实际平铺由 macOS 完成**，工程只提供"显示所有 app + 各 app 窗口缩略图"的浮层作为降级（即使在 WebView 里我们也不知道其他进程窗口的缩略图）。
3. **macOS 通知中心 widget** —— macOS 的 Widget 由独立 widget 进程提供；本工程可以从 `amos-store` 暴露 JSON，让用户在 macOS 的"今天"面板里放我们的 widget；但这是 Phase 6+ 的工作。
4. **macOS 系统级快捷键覆盖**（如 `⌘ Tab` 改写为 `amos Mission Control`）—— 可能干扰用户对 macOS 的肌肉记忆，建议**保留原生行为**，仅在壳内补充。

## 6. 立即可落地的最小集合（Phase 3 子集 → 完整 macOS 对齐感）

按"用户能立刻看到 macOS 桌面模样"的优先级：

| 优先级 | 改动 | 文件 |
|---|---|---|
| 🔴 P0 | `Shell.svelte` 在 desktop 形态下挂载 `DesktopShell.svelte`，渲染顶栏 + Dock + 启动台入口 | `Shell.svelte` + 新文件 |
| 🔴 P0 | `TopBar.svelte`：28px 高 + 左侧 Apple logo + 当前 app 名 + 占位主菜单 + 右侧 Spotlight/控制中心/时钟/电池 | 新文件 |
| 🔴 P0 | `Dock.svelte`：底部 76px 高 + 常驻 + 启动台图标（点击召出 Launchpad）+ 已打开 app 的运行指示 + 通知角标 | 新文件 |
| 🔴 P0 | `Launchpad.svelte`：点击 Dock 启动台图标 → 全屏覆盖（不卸载 shell）→ 8×5 网格 + 搜索框 + iOS-style 抖动编辑 | 新文件 |
| 🟡 P1 | `wm_open` 让新窗口带 `#window=<id>`，启动器改走 `wm_open` | `wm.rs` + `apps.tsx` |
| 🟡 P1 | `desktopLayout.ts` 模块化 + 单测 | 新文件 + 测试 |
| 🟢 P2 | Spotlight `⌘ Space` 全局快捷键 + 居中浮层 | 新文件 + 键盘事件 |
| 🟢 P2 | 任务切换 `⌘ Tab` Mission Control 简版 | 新文件 |
| 🟢 P2 | NotificationCenter 改侧栏 | 改造 `NotificationCenter.svelte` |

## 7. 验收判据

桌面版的"对齐 macOS 桌面体验"需要满足下列**可观察**判据：

1. **窗口尺寸**：`cargo run -p amos-tauri --release` 启动后，窗口默认**最大化**（铺满桌面工作区，菜单栏 29px 之下、Dock 之上）；不再是 480×820。
2. **顶栏**：顶部 28px 高，左侧显示 `🍎 Amos` + 当前 App 名 + 主菜单占位；右侧 Spotlight / 控制中心 / 时钟 / WiFi / 电池。
3. **Dock**：底部 76px 高，常驻；点击启动台图标召出 Launchpad；点击已打开 app 切回焦点窗口；点击未打开 app 通过 `wm_open` 创建新窗口。
4. **Launchpad**：Dock 上的启动台图标点击 → 全屏覆盖 → 8×5 网格（自适配窗口宽度）→ 顶部搜索框 → 输入字符过滤 → 抖动编辑 / 关闭。
5. **多窗口**：点击 Files → 新建独立 `WebviewWindow`，不是 SPA 路由切换；Dock 上对应 app 显示"运行中指示点"；多个 app 并排 / 重叠 / Z 序排列。
6. **顶栏快捷键**：`⌘ Space` → Spotlight 居中浮层；`⌘ Tab` → 切窗口；`Esc` → 关浮层。
7. **不回归**：在 phone / tablet 形态下，所有现有 UI 与测试**不发生任何字节级变化**（`formLayout.ts` 的 desktop 路径不污染 phone 路径；`HomeDock.svelte` 的桌面版是 sibling 而非替换）。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| Tauri 默认窗口 chrome（标题栏 / 红绿黄按钮）与 macOS Aqua 不一致 | 第一阶段**保留**原生 chrome——macOS 的"无标题栏窗口"是更高阶的需求，需要把窗口 `decorations: false` 后自绘；用户的诉求是"看起来像 macOS"，原生窗口 chrome 在 macOS 上**已经是 macOS**。 |
| WebView 多窗口的内存开销 | 第一阶段**限制**在"只允许 desktop 形态使用多窗口；phone / tablet 仍走单窗口 SPA"——这与 `LayoutPolicy` 已有的 `multi_window` 标志一致。 |
| 启动台覆盖层与多窗口舞台的 Z 序冲突 | Launchpad 是**单窗口内**的浮层（`surface = { kind: 'launchpad' }`），**不创建新 OS 窗口**；它叠加在 `DesktopShell` 之上但不影响其他 `WebviewWindow`。 |
| 桌面壳层与现有 `home` / `app` / `edit` / `lock` 表面状态机冲突 | 引入新的 surface：`launchpad`；现有 surface 在 desktop 形态下保留 `app` 语义（但路由到**多窗口舞台**而非 SPA）。 |

## 9. 总结

工程已具备 PC 桌面形态的**领域基础**（`FormFactor::Desktop`、`LayoutPolicy::ShellFit::Maximize`、多窗口 / free resize / 真实 split），但**前端 UI**没有对应的桌面壳拓扑，于是呈现给用户的就是"手机版放大"。本审计识别了 9 处缺陷 / Gap，给出了 5 阶段路线图 + 最低可交付集合 + 验收判据，下一步产出 `docs/PC_DESKTOP_ARCHITECTURE.md` 给出具体设计与数据流，然后按 Phase 2-5 实施。

---

## 10. 第二轮补全（2026-09-15）：门禁实测出来的缺口，逐条接线或删除

> 这一轮不是"继续写新功能"，而是**让 `bun run check` 变绿**——它当时在 `unwired:scan` 处**实测 FAIL**。
> 一个"已定义 + 已单测 + 文档说了 + 生产里没人调用"的几何模块，正是本仓反复出现的缺陷形状
> （`unwired-scan.mjs` 的动机段落列的 keep-awake / wakeHome / RAG / clipboard-announce 都是同一个形状）。

### 10.1 未接线 → 接线（8 个导出）

| 导出 | 之前（实测） | 现在 |
|---|---|---|
| `dockCapacity` | Dock 无容量概念，图标多了溢出窗口 | Dock 按实测宽度算容量；**系统项（启动台/访达/废纸篓）永不挤掉**，先压缩用户 app |
| `dockOverflowCount` | —（新增的纯函数） | 被截掉的 app 以 `+N` **显式计数**（`title` 列出名字），不静默消失 |
| `dockIconScale` | Dock 把 `1.3 - (1.3-1)*(d/80)` **抄了第二遍** | Dock 只喂 DOM 实测坐标，插值只有一处实现 |
| `DOCK_MIN_WIDTH` | 无消费者 | Dock 面板的 `min-width` |
| `LAUNCHPAD_COLS_DEFAULT` / `ROWS_DEFAULT` | Launchpad 里又写了一遍 `8` / `5` | Launchpad 的初始行列读常量 |
| `shouldShowMissionControl` | ⌘Tab 在 0/1 个窗口时也弹出只有一项的面板 | 0/1 个窗口不弹（与 macOS 一致） |
| `SPOTLIGHT_HEIGHT` / `SPOTLIGHT_INPUT_HEIGHT` | 组件里写的是 `max-height: 480px` / `h-12`，与常量**互相矛盾** | 组件读常量 |
| `DEFAULT_SCREEN`（新增） | `1440×900` 在模块里写了 4 次；`DesktopShell` 还内联了一份 `1440×796` 的**错值** | 无测量值的 fallback 只有一处真源，组件不再自己猜几何 |

### 10.2 同轮查出并修掉的缺陷

1. **Dock 的可访问名吐的是 i18n key**：`label: appTitleKey(id)` ⇒ 读屏软件念 `app.clock`；系统项 `Launchpad`/`Finder`/`Trash` 是英文硬编码。现在全部走 `t()`（新增 `desktop.finder`/`desktop.trash`/`desktop.appleMenu`/`desktop.mainMenu`/`desktop.menu.*`/`desktop.dockOverflow*`）。
2. **分隔线画在废纸篓之后**（Dock 唯一的分组视觉是错的）→ 改为「用户 app + 启动台/访达 ‖ 废纸篓」。
3. **`SpotlightOverlay` 的 `$effect` 嵌套在另一个 `$effect` 里**（Svelte 5 不推荐、依赖图错误）→ 收敛为单个 effect。
4. **交互内容被 `aria-hidden="true"`**（读屏用户看不到对话框）→ 外层 `role="presentation"`、内层 `role="dialog"`+`aria-modal`+`aria-label`+`tabindex="-1"`，Esc 在背景板上也真的关闭；`MissionControl` 同样补上对话框语义。
5. **i18n 两处死键**：`desktop.missionControl` 接成 Mission Control 的可访问名；`desktop.folderComingSoon` **删除**（"新建文件夹"目前只是占位事件，UI 不该谎称支持）。
6. **`appRegistry.ts` 私自又写了一份 `PHONE_ONLY_APP_IDS = ["phone"]`**，与 `lib/phoneApps.ts` 重复 → 收敛为 `isPhoneApp()` 单一真源（删掉本地副本与只为测试存在的 `PHONE_ONLY_IDS`）。
7. **`TopBar` 的 `amos.app_focused` 未登记**（`store-scan` FAIL）→ 提到 `lib/wm.ts` 的 `APP_FOCUSED_KEY`（与 Rust `store.rs` 同名），并在 `store-allowlist.json` 归为 `derived`（窗口焦点是**当前运行态**，不该进备份）。
8. **遗留探针文件** `svelte-tests/zz-probe.svelte.test.ts` 删除（调试用的 `console.log` 探针，测试恒真）。
9. **`DesktopShell` 的清理写法**：`onDestroy(...)` 曾写在 `onMount` 回调里 → 改为从 `onMount` 返回清理函数。**诚实更正**：实测 Svelte 5.57 下 `onDestroy` 就是 `onMount(() => () => fn())`，所以**旧写法当时并没有泄漏监听器**；这是一个写法正确化，不是 bug 修复。

### 10.3 新增守门：`svelte-tests/desktop-shell.svelte.test.ts`（8 例）

舞台宽度取自宿主实测 `screen_w`；Dock `min-width == DOCK_MIN_WIDTH`；**卸载后它加的每个 window 监听器都被移除**；⌘Space → Spotlight（宽高来自常量、`role="dialog"`、Esc 关闭）；⌘Tab **只在 ≥2 个窗口**时出现；Dock 系统项已本地化 / app 名不是 key / 分隔线在废纸篓之前 / 装不下如实报 `+N`。

**负控**：删掉 `DesktopShell.onMount` 的清理块 ⇒「卸载后每个监听器都被移除」FAILED（`keydown listener was never removed`）。空的断言不算守门，这一条证明它有判别力。

### 10.4 仍然不做的（诚实边界）

- `+N` 只告知**数量与名字**，没有"点击展开"的溢出面板；
- Dock 容量是按**图标 + 间距**的静态几何估算（缩放、圆角、分隔线不参与计算）；
- Dock 仍以 **5s 轮询** `wm_windows`（未改成宿主推事件）；
- 「新建文件夹」仍是占位（本轮**登记**，不实现）；
- 桌面形态的真机观感（顶栏 / Dock 在 1496×881 下的实际观感）属**肉眼复核项**。
