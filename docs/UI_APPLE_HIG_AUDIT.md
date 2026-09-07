# Amos System UI — Apple HIG 风格审计报告

> 审计日期：2026-09-07
> 范围：`frontend-ts` 的 **主 UI（壳 / 桌面 / 锁屏 / 通知中心 / 控制中心）** 与 **各应用界面**。
> 目标：逐面核对是否对齐 Apple iOS 人机交互指南（Human Interface Guidelines）下的“应用风格”与观感。
> 审计方式：**源码 + 语义化类名审阅**（非像素级对比）。如需最终确认，请运行 `make run-ui-release` 后按本报告「需肉眼复核」清单目检浅/暗两套主题。

---

## 1. 总体结论

**方向高度正确，但“风格对齐度”约为 70%，未完全对齐。**

- ✅ 底层设计令牌很对：正确 SF 字体栈、自适应 systemBlue/systemRed、iOS 成组列表、11px 圆角卡片、hairline 分隔、iOS 绿开关、分段控件。锁屏 / 计算器 / 来电界面已是相当忠实的 Apple 还原。
- ❌ 存在**跨界面反复出现的系统性偏差**，将整体观感从“像 iPhone”拉低到“像 iOS 的 Web 仿制”。这些不是零散个案，而是**同一策略重复了上百次**（以 emoji 代替 SF Symbols 为主）。

> ⚠️ 架构说明：应用内屏已是 **Svelte 单一实现**，但系统 chrome（状态栏 / 通知中心 / 主屏）仍是 **React 兜底 + Svelte 新版并存**，由 `src/apps.tsx` 的 `svelteEnabled()` 决定（PROD→Svelte，dev→默认 React）。因此同一 emoji 往往在 `.svelte` 与 `.tsx` 两端重复出现，且两端的 DOM 测试直接断言 emoji 文本——**改造 emoji 属跨双端 + 联动测试更新的一次较大重构**。

---

## 2. 系统性偏差（最重要，几乎每个界面都受影响）

### 🔴 P0-1　用 Emoji / 文本字符代替 SF Symbols（最普遍、最不像 Apple）
Apple 风格核心是**统一、矢量、可随主题着色的 SF Symbols**。本项目系统图标几乎全是 Emoji 或 Unicode 字符：跨平台渲染不一致、无法随 `--accent` 着色、字形风格杂乱。证据（真实渲染在 UI 里的图标）：

| 位置 | 文件 | 图标 |
| --- | --- | --- |
| 状态栏 | `src/svelte/StatusBar.svelte` L20-24, L90-98 | `✈️📶🅱🔦🔕🌒`；电池用文本 **`▮▮▮ 87%`** 而非图形 |
| 控制中心 / 通知中心 | `src/svelte/NotificationCenter.svelte` L45-52, L214 | `📶🅱✈️🌙🌒📍`、手电 `🔦/🔆` |
| 锁屏 | `src/svelte/LockScreen.svelte` L104 | `🔒` |
| 主屏搜索 | `src/svelte/HomeDock.svelte` L306 | `🔍` |
| 信息 | `src/svelte/MessagesApp.svelte` L111,167,141-143 | `🗑` `➤` `↩` `✕` |
| 音乐 | `src/svelte/MusicApp.svelte` L154-180 | `⏮▶⏸⏭🔁🔂♪💬✕` |
| 来电 | `src/svelte/IncomingCall.svelte` L141,167,181,192 | `📞🎙️🔇●⏹✕` |
| 其它 | `RemindersApp` / `NotesApp` / 通知图标 | `🔍✕⚠`、`💬`、分组图标 emoji 色板 |

> **建议**：引入统一矢量图标层（内嵌 SF Symbols 子集的 SVG，或等宽开源 SVG 集），提供 `icon(name, color)` 供 React/Svelte 共用，替换全部 emoji/字符。沿用 `src/lib/appIcon.ts` 已有的“函数返回 `<svg>` 字符串 + `{@html}`”模式可低成本落地。这是第一优先级。

### 🔴 P1-1　每个 App 被 OS 外层包裹“‹ 返回主屏 + 标题 + Home 条”——不符合 iOS 呈现
`src/svelte/Shell.svelte` L212-226（React 端同构于 `src/App.tsx` 的 `AppShell` L182-192）为**每个打开的应用**画：顶部 `border-b` 半透明白标题栏（含 `‹` 返回主屏 + 居中标题），底部再单画一根 Home 指示条。

iOS 的真相是：**应用全屏、edge-to-edge、分层堆叠**；系统不会在每个 App 顶部再叠“‹ 回主屏 + 标题”的固定栏（那是 Android app bar / 桌面窗口化概念），Home 手势也不应作为独立 UI 条并排画在 App 内。后果：
- **双重导航堆叠**：设置 →「Wi‑Fi」子页时，先有 Shell 的“‹ 设置”顶栏，再有 `SettingsApp.svelte` L349-358 自己画的“‹ 设置 + 大标题”。
- 各 App 内容无法真正从屏顶开始、无法实现 iOS“大标题穿过透明栏滚动”。

> **建议**：将“返回主屏”收敛为系统手势（下滑 / Home 条），让 App edge-to-edge；App 内部导航用各自导航条呈现，而非 OS 统一包一层。

### 🟠 P1-2　应用图标风格不统一
`src/lib/appIcon.ts` 已为时钟/提醒/语音备忘录/备忘录/计算器等绘制**精致 Apple 风 SVG**（白卡 + 彩色图形，方向正确）；但其余大量图标仍是“emoji 铺在统一渐变圆角块上”（uniform tonal tiles），主屏 / Dock 图标用 `rounded-[19px]`（`HomeDock.svelte` L341）。iOS 图标是**连续曲线 squircle（superellipse）**而非固定 CSS 圆角，用 emoji 当图标艺术品也与 Apple“独立应用美术”相距较远。可作占位，但非真 iOS 图标。

---

## 3. 做得很对、值得保留的部分 ✅

- **字体** `src/index.css` L26-33：`-apple-system … SF Pro Text … PingFang SC` 顺序正确；`text-rendering: optimizeLegibility`、caret 跟随 accent、`::selection` 半透明蓝——到位。
- **系统色** `src/index.css` L8-15：`#007AFF / #0A84FF`、`#FF3B30 / #FF453A` 浅/深自适应，符合 HIG。
- **暗色模式** `src/theme/index.tsx`：`dark` class + `matchMedia` 跟随 OS，符合 iOS。
- **设置成组列表** `src/svelte/settings/kit.ts` + `src/components/ui.tsx`：`rounded-[11px]` 组、15px label、hairline 分隔、**iOS 绿开关**（`Switch.svelte`，约 46×28 近原生）、**分段控件**（`Segmented.svelte` 内嵌胶囊滑块）——结构完全对标 iOS「设置」。
- **锁屏** `src/svelte/LockScreen.svelte`：超细特大时钟 + `tabular-nums` + 日期、半透明圆形按键环 + 绿色确认 + 红色紧急——非常 iOS。
- **来电** `src/svelte/IncomingCall.svelte`：全屏模糊、大圆形头像、红拒/绿接大按钮对排——接近 iOS 通话界面。
- **计算器** `src/svelte/CalculatorApp.svelte`：橙运算符 `#ff9f0a`、浅灰功能 `#a5a5a5`、深灰数字 `#333`、满圆键、宽“0”、常暗背景——几乎就是 iOS 计算器。
- **主屏结构**：分页网格 + 单行 Dock + 红色角标（system-red 圆点白字带描边，`HomeDock.svelte` L348）+ App Library 迷你网格指示（L283-296）+ Dock 磁吸放大 `dock-mag`（`index.css` L85-101）+ 动态岛（`StatusBar.svelte` L80）——概念取自 iOS，还原度高。
- **动效 / 无障碍**：`app-enter`、`sheet-in`、`prefers-reduced-motion`、`touch-action` 防双击缩放等专业到位。

---

## 4. 其它次要偏差

- 🟠 **顶部“🔍 悬浮搜索胶囊 + 底部 Dock”**（`HomeDock.svelte` L301-306）：iOS 主屏无此元素（iOS 是下滑唤出 Spotlight）。可用的快捷入口，但会削弱“iPhone”印象；建议改为下滑手势打开。
- 🟠 **底部 Tab Bar 缺失**：iOS 的 Phone/Music/Mail 用底部标签栏；本项目 Phone 用顶部分段控件（`PhoneApp.svelte` L230）、Music 为单一播放页——结构仿 iOS，但信息架构更偏“单屏工具”。
- 🟡 **依赖 `hover:` 才显示的隐藏控件**（`MessagesApp.svelte` L141-143 `opacity-0 group-hover:opacity-60`）：触屏不可达；iOS 以长按上下文菜单呈现，更像桌面 Web。
- 🟡 工程卫生：仓库根 `frontend-ts/preview6.js` 为数十 MB 旧打包产物，干扰审计与检索，建议清理（非风格问题）。

---

## 5. 分面速览

| 界面 | 对齐度 | 说明 |
| --- | --- | --- |
| 字体 / 系统色 / 暗色 | ✅ 高 | 令牌正确 |
| 设置 / 成组列表 / 开关 / 分段 | ✅ 高 | 结构对标 iOS |
| 锁屏 / 计算器 / 来电 | ✅ 高 | 视觉还原好 |
| 主屏 / Dock / 角标 / App Library / 动态岛 | 🟠 中 | 概念对，图标艺术与搜索胶囊欠还原 |
| 状态栏 / 电池 | ❌ 低 | emoji 图标 + 文本电池 |
| 控制中心 / 通知 | 🟠 中 | 圆角磁贴对，图标 emoji |
| 各 App 屏 | 🟠 中 | 气泡/布局仿 iOS，但普遍用 emoji/文本图标 |
| App 外层 chrome | ❌ 低 | 每 App 固定顶栏 + Home 条，双返回堆叠 |

---

## 6. 建议行动顺序（P0→P3）

1. **P0** 统一 `Icon`(SF-Symbol 式 SVG)：替换**所有**状态栏 / 控制中心 / 锁屏 / 通知 / 按钮里的 emoji 与文本字符；重画**电池**为图形。
2. **P1** 去掉 OS 对每个 App 包裹的“‹ + 标题 + Home 条”固定外框，改回 edge-to-edge + 手势返回；消除设置子页双返回。
3. **P2** 主屏搜索改下滑手势（或移除与 Dock 并列的胶囊）。
4. **P3** 为媒体 / 电话 / 邮件类应用补充 iOS 式底部标签栏；主屏 / Dock 图标改连续 squircle 图标面。
5. **目检**：按第 7 节清单在浅 / 暗两套下核对圆角、毛玻璃透明度、间距与对比度——Apple 对手感的拿捏远超语义化类名所能保证。

> 注意：上述每一项（尤其 P0）均需同步更新对应 `__tests__/*.test.tsx` / svelte DOM 测试，因现有测试直接断言 emoji 文本。

---

## 7. 需肉眼复核清单（运行 `make run-ui-release` 后）

- [ ] 状态栏 emoji 在不同系统字体下是否串位 / 变形；电池占位是否突兀。
- [ ] 毛玻璃（backdrop-blur）在浅 / 暗下的透明度与可读性。
- [ ] 成组卡片 `rounded-[11px]` 与图标 `rounded-[19px]` 视觉是否过度“棱角”。
- [ ] 各 App 打开时顶部固定标题栏与内容是否出现“双层标题”感。
- [ ] 控制中心磁贴 on/off 两态的图标明暗 / 反色是否清晰。
