# React → Svelte 全量移除计划（“不应该有 React”）

> 审计日期：2026-09-07 ｜ **状态更新：2026-09-11 — 已完成（本文保留作追溯）**
> 结论：应用屏 100% Svelte；**React 宿主已彻底移除**——生产入口 `index.html → src/shell-entry.ts → mount(Shell.svelte)`，`App.tsx`/`main.tsx`/React chrome/providers 与 `react`/`react-dom` 依赖均已删除；`tsconfig` 已去掉 `jsx`，仓库内最后两个 `.tsx` 测试也改名为 `.ts`（**`.tsx` 归零**）。P1 的系统层亦全部落在 Svelte：硬件按钮→home/AI、`telephony-event`→`IncomingCall`、clipboard ingest/announce、display（`screen_state_set`/auto screen-off/**wakeHome resume→home**）、**edge-swipe（顶部下拉 NC / 底部上滑 Recents / 主屏下拉 Spotlight）**、**开机 `hydrateFromSystemStore`**、OS 到点 watcher（alarm/reminder/timer）。下文为历史计划文本。

## 1. 现状盘点（审计结果；2026-09-07 时点）
- **生产宿主**：`index.html` → `src/main.tsx`（ReactDOM）→ `src/App.tsx`（React `Shell()` 状态机：home/dock/lock/edit/library/app + overlays NC/Recents/Spotlight + chrome islands）。
- **应用屏**：全部为 Svelte，React 侧只剩 loader 壳 `src/apps.tsx`（`SvelteAppHost` 挂载 Svelte）+ `src/components/SvelteAppHost.tsx`/`SveltePropsHost.tsx`。
- **仍为 React 的文件（非测试）** 约 20 个：`App.tsx / apps.tsx / main.tsx / i18n/index.tsx / theme/index.tsx / ui.tsx` + chrome 组件（`StatusBar / NotificationBanner / NotificationCenter / HomeDock / HomeWidgets / IncomingCall / SystemPanels / EditHome / Wallpaper / ExtApp / SplitDemoButton / SplitFrame / CapabilityGate / AppIcon`）。
- **React 宿主独有、Svelte 壳尚未覆盖的逻辑**（迁 `Shell.svelte` 时必须补）：
  - 系统桥接：硬件按钮→home/AI；`telephony-event` 订阅喂 `IncomingCall`；来电/录音接线；`clipboard` ingest/announce；`display`（`screen_state_set`、auto screen-off idle、`wakeHome` resume→home）；`sensor/flashlight` UI pusher；`buttons::install_android_app`。
  - OS 提醒/闹钟钩子：`useDueReminderAlerts`、`useDueAlarmAlerts`（React hook → 需迁为 runes 版并挂到 Shell）。
  - 壳级下拉 NC 快设、Recents、Spotlight、App Library、home/edit/lock 路由与 edge-swipe、pulse/softLaunch、AppShell（标题栏 + home 手势）、surface 埋点日志、开机 `hydrateFromSystemStore`。
- **React 单测**：`src/__tests__/*.tsx` 现 **27 个**（React + `@testing-library/react` 挂载路径），移除 React 时需按屏迁移为 Svelte vitest 或删除；`package.json` 有 `react/react-dom` 依赖、`@vitejs/plugin-react`、`@types/react`、tsconfig `jsx`、`.tsx` 参与 `tsc`。

## 2. 目标形态
```
index.html → (Svelte 入口，替换 main.tsx) → mount(Shell.svelte)
Shell.svelte 读 shellState.svelte.ts，挂所有屏 + chrome（全部 .svelte）
```
删除：React 宿主、React chrome、SvelteAppHost/PropsHost 的 React 版本（改为原生 `mount` 加载）、React hooks、React providers、react 依赖与 React bun 测试；`tsconfig` 去掉 `jsx`；bun 扫 27 个 `.tsx` 移除。

## 3. 分步执行（每步留绿并可跑 `npm run check`）
- **P0（本文件）**：盘点与计划。✅
- **P1 宿主逻辑移植（runes → Shell.svelte），逐步且各自配 vitest**
  1. boot/主题/语言 + Backdrop + StatusBar（既有 Svelte 组件接 runes store）。
  2. home + HomeDock + AppLibrary + EditHome（既有）+ `pushRecent/open/goHome/softLaunch`（shellState 已有）。
  3. overlays：NC 快设（读 `amos.settings`/radio）、Recents、Spotlight、NotificationBanner（既有 .svelte），接 edge-swipe（下拉开 NC / 上滑回 home）。
  4. lock + auto screen-off idle + `wakeHome` resume（移植 `lib/display` + `useScreenHold`/`keepAwake` 的 runes 版）。
  5. 系统事件：`buttons`(home/AI)、`telephony-event`→IncomingCall、`clipboard-changed` 横幅、`lmk-surface`、`sensor`/`flashlight` UI pusher（runes 订阅）。
  6. OS 提醒/闹钟：把 `useDueReminderAlerts`/`useDueAlarmAlerts` 迁为 runes 版（复用 `lib/*` 纯逻辑），挂 Shell 生命周期。
     - 进度：**闹钟/提醒/计时器的 OS 到时逻辑均已拆为 React-free 的 `lib/*Core.ts` + Svelte watcher 并挂 `Shell.svelte`**（`osAlarmWatcher`/`osReminderWatcher`/`osTimerWatcher`，各配 bun 测试）。**宿主侧已去 React hook**：`App.tsx` 现改为直接 start 这三个 React-free watcher（`activeRef` 提供前台 id），已删除 `useDueAlarmAlerts/useDueReminderAlerts/useDueTimerAlerts` 三个 React hook 及 `lib/timerNotify.ts`、React DOM 测试 `reminderNotify-dom.test.tsx`；`alarmNotify/reminderNotify` 收窄为纯 re-export。这样 React 宿主与未来的 Svelte 宿主用同一份 React-free watcher（杜绝双份实现）。
  7. 权限流 `CapabilityGate`/`PermissionsApp` 接线。
- **P2 切宿主**：`index.html` 改挂 Svelte 入口（把 `shell-entry.ts` 生产化 / 新建 `svelte-entry.ts`），保留一段过渡：`import.meta.env.PROD` 走 Svelte、dev 可用 Svelte。冒烟：本地起 UI、逐屏手测 + CDP 无头遍历（沿用仓库脚本）。
- **P3 删除 React**
  - 删 `main.tsx/App.tsx/apps.tsx` 的 React 宿主层与 React chrome 组件、`SvelteAppHost.tsx/SveltePropsHost.tsx`（改用 Svelte `mount` loader）、React hooks/providers。
  - 迁/删 27 个 React `__tests__/*.tsx`（有 Svelte 对应屏的迁成 vitest；纯 React 壳的删）。
  - `package.json` 去 `react/react-dom`、`@vitejs/plugin-react`、`@types/react(-dom)`；`vite.config`/`svelte.config` 移除 react 插件；`tsconfig` 去 `jsx`。
- **P4 全绿门槛**：`npm run check`（bun test + tsc + svelte-check + vitest）、`vite build`、真机/浏览器视觉过一遍。

## 4. 诚实边界 / 建议
- 这是**多阶段、高风险重构**：一次到位会破坏宿主功能且无法在无头环境完整验证（自动息屏、硬件键、来电、系统桥都依赖运行态/真机）。**不应在单次大提交里“删除全部 React”**。
- 建议在独立分支按 P1 逐子项做（每子项有 vitest 与 svelte-check），稳定后再 P2/P3。
- 我可在本仓库直接推进 P1 的子项（例如先做 “Shell.svelte 生产化宿主 + boot/home/overlay 与 edge-swipe + 对应 vitest”），但要先把 `App.tsx` 的这些逻辑对应搬过去并保绿，再谈删 React。
