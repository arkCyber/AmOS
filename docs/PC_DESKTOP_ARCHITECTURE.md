# AmOS — PC 桌面版架构设计文档

> 状态：**草稿 v1**（2026-09-15）
> 关联：`docs/PC_DESKTOP_AUDIT.md`（审计报告）
> 目标：把 AmOS System UI 在 macOS 桌面形态下的呈现从"手机版放大"改为"macOS Aqua 桌面体验对齐"

## 1. 目标与设计原则

### 1.1 用户可观察目标（来自 `docs/PC_DESKTOP_AUDIT.md` §7）

| # | 判据 | 优先级 |
|---|---|---|
| W1 | 窗口默认最大化（满屏工作区），不再是 480×820 手机板 | 🔴 P0 |
| W2 | 顶部 28px 毛玻璃顶栏：左侧 🍎 + 当前 App 名 + 主菜单占位；右侧 Spotlight / 控制中心 / 时钟 / WiFi / 电池 | 🔴 P0 |
| W3 | 底部 76px 常驻 Dock：启动台图标（点击召出 Launchpad）+ 打开 app 运行中指示 + 点击切焦点窗口 | 🔴 P0 |
| W4 | Launchpad 全屏网格：8 列（自适配） × 5 行（自适配）+ 顶部搜索 + 抖动编辑 | 🔴 P0 |
| W5 | 点击 app 图标 → 多窗口（新 `WebviewWindow`）而非 SPA 路由 | 🟡 P1 |
| W6 | `⌘ Space` → Spotlight 居中浮层；`⌘ Tab` → 窗口切换 | 🟡 P1 |
| W7 | phone / tablet 形态**零变化** | 🔴 P0 |

### 1.2 设计纪律（Power of 10 对齐）

| 纪律 | 在本设计的体现 |
|---|---|
| #1 无外部危险服务 | 所有 IPC 走 Tauri 命令 / 事件；不引入额外网络服务 |
| #2 资源边界静态 | 桌面几何用 `const`（无 `new`、无 I/O、编译期确定） |
| #3 无递归 | 所有迭代用循环或显式栈 |
| #4 完整输入边界 | 所有来自主机的 `LayoutSnapshot` 字段经 `normalizeLayout` 降级（phone 默认），绝不因畸形载荷而"获得"能力 |
| #5 信任边界清晰 | 主机（Rust）→前端（TS）是单向数据流；前端只消费 host-authoritative 数据 |
| #6 诚实失败 | 离线 / 无宿主 → 显示"—"并说明原因；绝不显示陈旧数据 |
| #7 报告而非猜测 | 窗口尺寸、形态由主机测量并推送；前端绝不"猜" |
| #8 确定性 | 相同输入 → 相同输出；时钟驱动的 UI（时间/日期）仅用于显示，不参与布局计算 |
| #9 可测 | 所有决策逻辑在 `lib/desktopLayout.ts` 里是纯函数；`formLayout.ts` 已有单测；`desktopLayout.ts` 新增单测 |
| #10 审计 | `formLayout.test.ts` 锁存 desktop 路径；`desktopLayout.test.ts` 新增 |

## 2. 桌面壳层拓扑（macOS Aqua 类比）

### 2.1 桌面 Shell vs. 手机 Shell 的根本区别

```
┌──────────────────────────────────────────────────────────────┐
│  macOS 桌面层级（AmOS Desktop Shell）                        │
├────────────────────────────────────────────────────────────┤
│  ┌─ 顶部毛玻璃顶栏 (28px) ─────────────────────────────┐   │
│  │  🍎  Amos  │  File  Edit  View  Window  Help      │   │
│  │  AppleMenu  │  ───── 动态 App 菜单 ──────  │ Spotlight │ 控制中心 │ 时间 │ 电池 │  │
│  └──────────────────────────────────────────────────┘   │
│  ┌─ 多窗口舞台 (flex-1, 剩余高度) ────────────────────┐   │
│  │                                                       │   │
│  │  [WebviewWindow: Calendar]  [WebviewWindow: Files]   │   │
│  │           ↑ Dock 上的 app 点击由 wm_open() 创建      │   │
│  │                                                       │   │
│  └───────────────────────────────────────────────────┘   │
│  ┌─ 底部常驻 Dock (76px) ────────────────────────────┐   │
│  │  🚀 Launchpad │  Finder  Notes  Calendar  AI  ...  🧹 │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

- **顶栏**：在所有 `WebviewWindow` **之上**渲染（`z-index` 最高），作为全局 chrome。
- **多窗口舞台**：Tauri 的多个 `WebviewWindow` 直接放在 macOS 桌面上，各自独立。
- **Dock**：固定在底部，`position: fixed`，在舞台层之下但高于内容。

**关键设计决策**：桌面形态下，**Shell 不再是唯一的根容器**——每个 app 是独立的 `WebviewWindow`，但"顶栏"需要出现在**所有窗口之上**。有两种实现路径：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 顶栏 + Dock 作为"系统窗口" | 创建一个 `WebviewWindow(label="system")`，固定尺寸（screen-width × 28px / 76px），`alwaysOnTop: true`，渲染顶栏和 Dock | 实现简单，不改 Tauri 主窗口 | 每个 app 窗口仍需共享"焦点 app 状态"（当前 app → 顶栏显示哪个菜单） |
| B. 顶栏 + Dock 在主窗口（Launcher）中渲染，app 窗口走独立窗口 | Launcher 窗口最大化后，在其内部渲染顶栏和 Dock；app 窗口仅承载 app 内容 | 焦点 app 状态自然在主窗口内 | 与"app 是独立 WebviewWindow"的语义冲突（app 窗口内部没有 Dock） |

**本设计采用方案 A**（系统窗口），理由：
1. macOS 的顶栏是**操作系统提供的全局 chrome**，本工程在 WebView 里复现它，用 `alwaysOnTop` 系统窗口是最接近 macOS 语义的做法。
2. 焦点 app 状态（哪个 app 菜单在顶栏）通过 `amos-tauri` 的 `SharedStore` 跨窗口共享（`amos.app_focused`，写路径 `WmState::on_focus_change` → 更新 store）。
3. 独立系统窗口只渲染顶栏和 Dock，不包含任何 app 内容——内存开销极小。

### 2.2 Surface 状态机（桌面扩展）

桌面形态在手机 5 种 surface（`home / app / library / edit / lock`）基础上新增：

```
SurfaceDesktop =
  | "home"       — 桌面主视图（多窗口舞台 + 隐藏 Dock/顶栏外框）
  | "app"        — 聚焦某个 app（顶栏高亮该 app 名）
  | "launchpad"  — Launchpad 全屏覆盖（不创建新窗口）
  | "spotlight"  — Spotlight 浮层（居中覆盖）
  | "mission"    — Mission Control 窗口切换（半屏覆盖）
  | "edit"       — 现有编辑 surface
  | "library"    — 现有 App Library surface（桌面形态下 = Launchpad）
  | "lock"       — 现有锁屏 surface
```

桌面形态与手机的语义映射：

| 手机 surface | 桌面等价 | 说明 |
|---|---|---|
| `home` | `home` | Dock + 舞台，无"主屏幕图标网格" |
| `app` | `app`（聚焦 app 窗口）| 顶栏显示 app 菜单 |
| `library` | `launchpad` | 启动台全屏网格 |
| `edit` | `edit` | 同 |
| `lock` | `lock` | 同 |

## 3. 新增文件清单

```
frontend-ts/src/
├── lib/
│   └── desktopLayout.ts      ← 新：桌面布局几何常量 + 纯决策函数
├── svelte/
│   ├── DesktopShell.svelte   ← 新：桌面形态 Shell（顶栏 + Dock + 舞台）
│   ├── TopBar.svelte         ← 新：macOS 风格顶栏
│   ├── Dock.svelte           ← 新：macOS 风格 Dock
│   ├── Launchpad.svelte      ← 新：Launchpad 全屏浮层
│   ├── SpotlightOverlay.svelte ← 新：Spotlight 居中浮层
│   └── MissionControl.svelte   ← 新：窗口切换浮层（简化版）
```

## 4. 模块详细设计

### 4.1 `frontend-ts/src/lib/desktopLayout.ts`（新文件）

**职责**：桌面布局几何常量的唯一真源 + 纯决策函数（可单测）。

```typescript
/**
 * desktopLayout.ts — macOS 桌面形态布局几何常量 + 纯决策函数。
 *
 * 与 `formLayout.ts` 的纪律完全一致（Power of 10 #2：静态/无 I/O/无分配）。
 * 所有值由宿主提供（`LayoutSnapshot.screen_w/h`），前端绝不从 WebView 尺寸猜。
 */

// ─── 常量 ───────────────────────────────────────────────────────────────────

/** macOS 顶栏高度（px），包括刘海区占位。 */
export const TOPBAR_HEIGHT = 28;

/** macOS Dock 高度（px），不含顶部圆角区。 */
export const DOCK_HEIGHT = 76;

/** macOS Dock 最小宽度（px）。 */
export const DOCK_MIN_WIDTH = 320;

/** Dock 图标尺寸（px，正方形）。 */
export const DOCK_ICON_SIZE = 56;

/** Dock 图标间距（px）。 */
export const DOCK_ICON_GAP = 8;

/** Launchpad 默认列数（1440px+ 宽屏）。 */
export const LAUNCHPAD_COLS_DEFAULT = 8;

/** Launchpad 默认行数（900px+ 高度）。 */
export const LAUNCHPAD_ROWS_DEFAULT = 5;

/** 每个 Launchpad 图标尺寸（px）。 */
export const LAUNCHPAD_ICON_SIZE = 80;

/** Launchpad 图标间距（px）。 */
export const LAUNCHPAD_ICON_GAP = 24;

/** Spotlight 浮层最大宽度（px）。 */
export const SPOTLIGHT_WIDTH = 600;

/** Spotlight 浮层最大高度（px）。 */
export const SPOTLIGHT_HEIGHT = 400;

// ─── 纯决策函数 ───────────────────────────────────────────────────────────

/** 给定可用宽度，计算 Launchpad 列数（最少 4 列）。 */
export function launchpadCols(screenW: number): number {
  return Math.max(4, Math.floor(screenW / (LAUNCHPAD_ICON_SIZE + LAUNCHPAD_ICON_GAP)));
}

/** 给定可用高度，计算 Launchpad 行数（最少 3 行，不含搜索区 + 标题区 80px）。 */
export function launchpadRows(screenH: number): number {
  const usable = screenH - TOPBAR_HEIGHT - DOCK_HEIGHT - 80;
  return Math.max(3, Math.floor(usable / (LAUNCHPAD_ICON_SIZE + LAUNCHPAD_ICON_GAP)));
}

/** 给定 Dock 区域宽度，返回该宽度能容纳的最大 Dock 图标数（考虑边距）。 */
export function dockCapacity(dockW: number): number {
  const inner = dockW - 48; // 两侧各 24px 边距
  return Math.max(3, Math.floor(inner / (DOCK_ICON_SIZE + DOCK_ICON_GAP)));
}

/** 给定宽度，计算顶栏 Spotlight 按钮宽度。 */
export const TOPBAR_SPOTLIGHT_W = 200;

/** 舞台区域（顶栏之下、Dock 之上）的完整 bounding rect。 */
export interface StageRect {
  x: 0;
  y: TOPBAR_HEIGHT;
  width: number;
  height: number;
}

/** 根据屏幕尺寸计算舞台区域。 */
export function stageRect(screenW: number, screenH: number): StageRect {
  return {
    x: 0,
    y: TOPBAR_HEIGHT,
    width: screenW,
    height: screenH - TOPBAR_HEIGHT - DOCK_HEIGHT,
  };
}

/** 是否应渲染 Mission Control（窗口数 ≥ 2）。 */
export function shouldShowMissionControl(openWindowCount: number): boolean {
  return openWindowCount >= 2;
}
```

**单测范围**（`desktopLayout.test.ts`）：
- `launchpadCols(1440) === 8`、`launchpadCols(800) === 5`。
- `launchpadRows(900) >= 3`。
- `dockCapacity(600) >= 3`。
- `stageRect(1440, 900)` → `{ x:0, y:28, width:1440, height:796 }`。
- `shouldShowMissionControl(2) === true`、`shouldShowMissionControl(1) === false`。

### 4.2 `frontend-ts/src/lib/formLayout.ts` 补 desktop 路径

在 `homeGrid(form, w, h)` 中补 desktop 分支：

```typescript
// 在 formLayout.ts 的 homeGrid 函数中：

/** macOS 桌面图标网格（Launchpad 密度）。 */
const DESKTOP_GRID: HomeGrid = { cols: 8, rows: 5 };

export function homeGrid(form: FormFactor, width: number, height: number): HomeGrid {
  const measured =
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  if (!measured) return PHONE_GRID;
  switch (form) {
    case "tablet":
      return height >= width ? TABLET_PORTRAIT_GRID : TABLET_LANDSCAPE_GRID;
    case "desktop":
      // 桌面类的"主屏幕网格"是 Launchpad 密度（8×5），
      // 但桌面形态下 home 表面渲染的是 Dock + 舞台，不是图标网格。
      // 此函数在桌面形态下只被 App Library / Launchpad 消费。
      return DESKTOP_GRID;
    default:
      return PHONE_GRID;
  }
}
```

**注意**：`desktop` 的 `homeGrid` 值为 `DESKTOP_GRID`（8×5），但 `HomeDock` 在桌面形态下**不渲染图标网格**（渲染 Dock），所以 `DESKTOP_GRID` 只被 `AppLibrary` / `Launchpad` 的网格组件使用。

### 4.3 `amos-tauri/src/wm.rs` — `wm_open` 带 `#window=<id>` fragment

在 `WmEvent::Created` → `WebviewWindowBuilder` 处：

```rust
// crates/amos-tauri/src/wm.rs

fn apply(&self, app: &AppHandle, event: &WmEvent) -> Result<(), String> {
    match event {
        // ... existing branches ...
        WmEvent::Created(id) => {
            let label = self.lock()?.labels.get(id).ok_or("unknown id")?;
            let url = if label == LAUNCHER_LABEL {
                // Launcher 窗口不携带 fragment。
                WebviewUrl::App(APP_ENTRY.into())
            } else {
                // App 窗口携带 #window=<label>，让前端从 hash 读到 app id。
                // (docs/multi-window.md §1.5 "REQ-A234 应用窗口必须以「自己的 app」开屏")
                let fragment = format!("#window={}", label);
                WebviewUrl::App(format!("{APP_ENTRY}{fragment}").into())
            };
            // 使用当前 class 的 initial_window（desktop: 最大化，tablet: 900×1200）
            let policy = self.lock()?.policy;
            let size = match policy.form {
                FormFactor::Desktop => {
                    // Desktop 形态下 app 窗口应当：可自由缩放、可移动（free_resize=true）。
                    // 初始尺寸：最大化（填满舞台）。
                    None // 让 Tauri 默认行为决定；舞台区域的计算在窗口布局逻辑里。
                }
                _ => Some(tauri::Size::Logical(Size {
                    width: policy.initial_window.width,
                    height: policy.initial_window.height,
                })),
            };
            let mut builder = tauri::WebviewWindowBuilder::new(app, label, url)
                .title(app_window_title(label)) // 从 appMeta 取标题
                .resizable(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay);
            if let Some(s) = size {
                builder = builder.inner_size(s.width.into(), s.height.into());
            }
            // 窗口打开时通知 SharedStore 更新焦点 app 状态。
            // 后续 focus 事件通过 `WmEvent::FocusChanged` 触发 store 更新。
            let _win = builder.build().map_err(|e| e.to_string())?;
            Ok(())
        }
        // ...
    }
}
```

**关键变化**：
1. App 窗口 URL = `index.html#window=<label>`，前端 `windowRoute.ts` 的 `appIdFromHash()` 已能解析。
2. 窗口初始尺寸：desktop 形态下不指定（Tauri 默认 + 后续 `wm_*` 命令控制）。
3. `title_bar_style: Overlay` — macOS 上隐藏原生标题栏，为后续自绘顶栏腾空间。

### 4.4 `amos-tauri/src/wm.rs` — 焦点 app 状态写入 SharedStore

在 `apply(app, &WmEvent::FocusChanged(Some(id)))` 后：

```rust
// 焦点 app 变化 → 更新全局 store，供 TopBar 读取渲染动态菜单。
if let Some(id) = focused_id {
    let label = self.lock()?.labels.get(&id).cloned();
    if let Some(label) = label {
        let store = app.state::<SharedStore>();
        let _ = store.set(
            "amos.app_focused".to_string(),
            serde_json::json!(label),
        );
    }
}
```

**数据流**（REQ-A254 更正：**只有 store 一条通道**——`SharedStore::set` 自己会广播
`store-updated`；这里原本还有一条 `app-focused-changed` 事件，因「发出去没人订阅」被
`scripts/tauri-event-scan.mjs` 挡下并删除）：
```
[w] wm_open("calendar")  →  [Rust] WmEvent::Created(id)  →  WebviewWindow(url="#window=calendar")
[w] 点击 app 窗口  →  [Rust] WmEvent::FocusChanged(id)  →  store.set("amos.app_focused", "calendar")
                                                         →  [Rust emit] "store-updated"（已有通道）
[TS] TopBar.svelte  createStoreValue("amos.app_focused")  →  渲染 "Calendar" 菜单
```

### 4.5 `frontend-ts/src/svelte/DesktopShell.svelte`（新文件）

**职责**：桌面形态的顶层 Shell，渲染顶栏 + Dock + 多窗口舞台。

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { wmLayoutSnapshot, onLayoutChanged } from "../lib/wm";
  import { stageRect, TOPBAR_HEIGHT, DOCK_HEIGHT } from "../lib/desktopLayout";
  import { createStoreValue } from "./store";
  import TopBar from "./TopBar.svelte";
  import Dock from "./Dock.svelte";
  import SpotlightOverlay from "./SpotlightOverlay.svelte";
  import MissionControl from "./MissionControl.svelte";
  import { t } from "./locale.svelte";

  // ─── 布局状态 ─────────────────────────────────────────────────────────
  let layoutSnap = $state<LayoutSnapshot | null>(null);
  const stage = $derived(layoutSnap
    ? stageRect(layoutSnap.screen_w, layoutSnap.screen_h)
    : { x: 0, y: TOPBAR_HEIGHT, width: 1440, height: 796 }); // 合理的 fallback

  // ─── 浮层状态 ──────────────────────────────────────────────────────────
  let showSpotlight = $state(false);
  let showMission = $state(false);
  let showLaunchpad = $state(false);

  // ─── 键盘快捷键 ──────────────────────────────────────────────────────
  function onKeyDown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey; // Mac: metaKey; 其他: ctrlKey
    if (meta && e.key === " ") { e.preventDefault(); showSpotlight = !showSpotlight; }
    else if (e.key === "Escape") {
      showSpotlight = false;
      showMission = false;
      // Launchpad 用 Esc 关（但不退出桌面，只退回舞台）
    }
    else if (meta && e.key === "Tab") {
      e.preventDefault();
      showMission = true;
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    void wmLayoutSnapshot().then(s => { if (s) layoutSnap = s; });
    void onLayoutChanged(s => { layoutSnap = s; });
    return () => window.removeEventListener("keydown", onKeyDown);
  });
</script>

<div class="relative w-full h-full overflow-hidden bg-neutral-900">
  <!-- 顶栏：全局，始终在最上层 -->
  <TopBar />

  <!-- 多窗口舞台（CSS absolute 定位，撑满顶栏下、Dock 上的区域） -->
  <!-- 注意：真实的 WebviewWindow 由 Tauri 管理，这里只是舞台占位区 -->
  <!-- 舞台背景：深色桌面 -->
  <div
    class="absolute"
    style="left:{stage.x}px; top:{stage.y}px; width:{stage.width}px; height:{stage.height}px;"
  >
    <!-- 桌面背景占位（将来可放桌面图标） -->
    <div class="w-full h-full bg-[length:cover] bg-center"
         style="background-image:url('/wallpapers/desktop-default.png')">
    </div>
  </div>

  <!-- 底部 Dock：常驻 -->
  <Dock on:launchpad={() => (showLaunchpad = true)} />

  <!-- Launchpad 全屏覆盖（z-index 最高，舞台之上） -->
  {#if showLaunchpad}
    <Launchpad on:close={() => (showLaunchpad = false)} />
  {/if}

  <!-- Spotlight 居中浮层 -->
  {#if showSpotlight}
    <SpotlightOverlay on:close={() => (showSpotlight = false)} />
  {/if}

  <!-- Mission Control 窗口切换浮层 -->
  {#if showMission}
    <MissionControl on:close={() => (showMission = false)} />
  {/if}
</div>
```

### 4.6 `frontend-ts/src/svelte/TopBar.svelte`（新文件）

**职责**：macOS 风格顶栏（28px 高，含刘海区占位）。

```svelte
<script lang="ts">
  import { createStoreValue } from "./store";
  import { t, locale } from "./locale.svelte";
  import { fmtClock } from "../lib/time";
  import { batterySvg, iconSvg, radioIcon } from "../lib/sysIcons";
  import { firstBattery, batteryTone } from "../lib/batteryStatus";
  import { statusIcons } from "../lib/netStatus";
  import { QUICK_KEY } from "../lib/settings";
  import { wmLayoutSnapshot } from "../lib/wm";

  // ─── 动态状态 ─────────────────────────────────────────────────────────
  let now = $state(new Date());
  let online = $state(navigator.onLine);
  const APP_FOCUSED_KEY = "amos.app_focused";
  const appFocusedStore = createStoreValue<string>(APP_FOCUSED_KEY, "");
  let focusedApp = $state("");

  $effect(() => {
    const un = appFocusedStore.subscribe(v => (focusedApp = v ?? ""));
    return un;
  });
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });
  $effect(() => {
    const on = () => (online = true);
    const off = () => (online = false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  });

  // ─── 电池 / 网络（复用 StatusBar 的逻辑）─────────────────────────────
  const { levelPct, charging } = $derived(firstBattery(/* 各层读取 */));
  const battTone = $derived(batteryTone({ levelPct, charging }));
  const icons = $derived(statusIcons(/* quick */, online, /* wifi */));
  const battText = $derived(levelPct === null ? "—" : `${Math.round(levelPct)}%`);
</script>

<!--
  macOS 顶栏：
  - 高度 28px，含刘海区占位 12px
  - 左侧：Apple Logo 🍎 (点击 → 下拉系统菜单) + 当前 app 名 + 主菜单（File/Edit/View/Window/Help）
  - 右侧：Spotlight (⌘ Space) + 控制中心 + 时间 + 电池 + WiFi
  - 毛玻璃背景（backdrop-filter: blur）
  - 字体：-apple-system, SF Pro Text
-->
<div
  aria-label={t("desktop.topbar")}
  class="relative flex h-7 w-full items-center justify-between px-4"
  style="padding-top: 12px; height: 40px; background: rgba(30,30,30,0.75); backdrop-filter: blur(20px);"
>
  <!-- 左侧：Apple Logo + 当前 app + 菜单 -->
  <div class="flex items-center gap-4">
    <button
      aria-label="Apple"
      class="text-white/90 hover:text-white cursor-default"
      style="font-size:14px;"
    >🍎</button>
    <span class="text-white text-[13px] font-semibold">{focusedApp || "Amos"}</span>
    <!-- 主菜单占位 -->
    <span class="flex gap-3 text-[12px] text-white/80">
      {#each ["File", "Edit", "View", "Window", "Help"] as menu}
        <button class="hover:text-white cursor-default">{menu}</button>
      {/each}
    </span>
  </div>

  <!-- 右侧：Spotlight + 控制中心 + 时间 + WiFi + 电池 -->
  <div class="flex items-center gap-3">
    <!-- Spotlight 快捷键提示 -->
    <button
      aria-label={t("desktop.spotlight")}
      class="flex items-center gap-1 text-[12px] text-white/60 hover:text-white/90"
      title="⌘ Space"
    >
      🔍
    </button>
    <!-- 控制中心 -->
    <button
      aria-label={t("desktop.controlCenter")}
      class="text-[12px] text-white/60 hover:text-white/90"
    >⚙️</button>
    <!-- 时钟 -->
    <span class="text-[12px] tabular-nums text-white/90">{fmtClock(now)}</span>
    <!-- WiFi -->
    {#each icons as ic (ic.kind)}
      <span class="text-[11px]" title={ic.titleKey ? t(ic.titleKey) : undefined}>
        {@html iconSvg(radioIcon(ic.kind), ic.on ? "text-white/90" : "text-white/40")}
      </span>
    {/each}
    <!-- 电池 -->
    <span class="text-[11px] text-white/90 tabular-nums">
      {@html batterySvg(levelPct ?? 0, "h-3 w-3", battTone)}
      {battText}
    </span>
  </div>
</div>
```

### 4.7 `frontend-ts/src/svelte/Dock.svelte`（新文件）

**职责**：macOS 风格底部 Dock（76px 高，含放大效果 + 运行中指示）。

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { t } from "./locale.svelte";
  import { createStoreValue } from "./store";
  import { invoke } from "../lib/backend";
  import { appIcon, appTitleKey } from "../lib/appMeta";
  import type { HomeLayout } from "../lib/amosStore";
  import { DOCK_HEIGHT, DOCK_ICON_SIZE, DOCK_ICON_GAP } from "../lib/desktopLayout";
  import { APP_META } from "../lib/appMeta";

  const dispatch = createEventDispatcher<{ launchpad: void }>();

  // ─── 布局状态 ─────────────────────────────────────────────────────────
  // 桌面形态下 Dock 的"dock"语义是：哪些 app 常驻在 Dock 上（来自 home layout 的 dock 字段）。
  // 与手机形态不同的是：这里的 dock 项是"可打开"而非"主屏幕图标"。
  let dockLayout = $state<HomeLayout>({ page: [], dock: [], hidden: [] });
  $effect(() => {
    // 订阅 home layout 变化（与 HomeDock 相同的水合逻辑）
    const raw = localStorage.getItem("amos.home.layout");
    if (raw) {
      try { dockLayout = JSON.parse(raw); } catch { /* ignore */ }
    }
  });

  // ─── 已打开窗口状态 ────────────────────────────────────────────────────
  // 通过 wm_windows 命令获取当前打开的窗口列表。
  // Dock 上对应的 app 显示运行中指示点（底部小圆点）。
  let openLabels = $state<Set<string>>(new Set());
  $effect(() => {
    void invoke<{ windows: Array<{ label: string; state: string }> }>("wm_windows")
      .then(r => {
        if (r?.windows) {
          openLabels = new Set(
            r.windows.filter(w => w.state !== "Hidden").map(w => w.label)
          );
        }
      });
  });

  // ─── Dock 项列表（固定 Dock 项 + 动态 dock layout 项）─────────────────
  // 固定 Dock 项：Finder（launcher/桌面文件）+ Launchpad（启动台入口）+ 废纸篓
  // 动态 Dock 项：来自 dockLayout.dock
  const DOCK_FIXED = [
    { id: "finder", icon: "💻", label: "Finder" },
    { id: "launchpad", icon: "🚀", label: "Launchpad", special: true },
    { id: "trash", icon: "🗑️", label: "Trash" },
  ];
  const dockItems = $derived([
    ...dockLayout.dock
      .filter(id => appTitleKey(id) !== null)
      .map(id => ({ id, icon: appIcon(id), label: appTitleKey(id) ?? id })),
    ...DOCK_FIXED,
  ]);

  // ─── 点击行为 ─────────────────────────────────────────────────────────
  // - launchpad → 召出 Launchpad
  // - finder → open("files")
  // - trash → 无操作（占位）
  // - 普通 app → 若未打开：invoke("wm_open", id)；若已打开：invoke("wm_focus", id)
  async function handleDockClick(id: string) {
    if (id === "launchpad") { dispatch("launchpad"); return; }
    if (id === "finder") { await invoke("wm_open", { label: "files" }); return; }
    if (openLabels.has(id)) {
      await invoke("wm_focus", { label: id });
    } else {
      await invoke("wm_open", { label: id });
    }
  }

  // ─── 鼠标悬停放大效果（CSS transform）───────────────────────────────────
  // macOS Dock 有"放大镜"效果：鼠标靠近哪个图标，哪个图标就放大。
  // 实现：监听 mouse X 位置，计算每个图标到鼠标的水平距离，
  // 用 CSS scale() 放大最近的那个（最多放大 1.3×）。
  let mouseX = $state(0);
  function onMouseMove(e: MouseEvent) { mouseX = e.clientX; }
  function iconScale(index: number, count: number): number {
    // 简化版：鼠标 X 与 Dock 图标中心的距离。
    // 实际需计算每个图标在屏幕上的 X 坐标，与 mouseX 的距离。
    return 1.0; // 占位；后续迭代
  }
</script>

<!--
  macOS Dock：
  - 高度 76px，含顶部圆角区（圆角 18px）
  - 毛玻璃背景
  - 放大镜效果（鼠标靠近放大）
  - 运行中 app 底部白点指示
  - 点击有弹跳动画
-->
<div
  class="absolute bottom-0 left-0 right-0 flex justify-center"
  style="height:{DOCK_HEIGHT}px;"
  role="toolbar"
  aria-label={t("desktop.dock")}
  onmousemove={onMouseMove}
>
  <div
    class="flex items-end gap-1 px-6 pb-2"
    style="background: rgba(255,255,255,0.15); backdrop-filter: blur(20px); border-radius: 18px 18px 0 0; border-top: 1px solid rgba(255,255,255,0.2);"
  >
    {#each dockItems as item, i (item.id)}
      {@const isOpen = openLabels.has(item.id)}
      {@const scale = iconScale(i, dockItems.length)}
      <button
        class="group flex flex-col items-center transition-transform duration-100"
        style="transform: scale({scale});"
        aria-label={item.label}
        title={item.label}
        onclick={() => handleDockClick(item.id)}
      >
        <span
          class="flex items-center justify-center rounded-2xl bg-gradient-to-br from-neutral-700 to-neutral-900 shadow-md transition-transform group-active:scale-90"
          style="width:{DOCK_ICON_SIZE}px; height:{DOCK_ICON_SIZE}px; font-size:32px;"
        >
          {item.icon}
        </span>
        <!-- 运行中指示点 -->
        {#if isOpen}
          <span class="mt-1 h-1 w-1 rounded-full bg-white"></span>
        {:else}
          <span class="mt-1 h-1"></span>
        {/if}
      </button>
    {/each}

    <!-- 分隔线 -->
    <div class="mx-1 self-center" style="width:1px; height:48px; background:rgba(255,255,255,0.2);"></div>
  </div>
</div>
```

### 4.8 `frontend-ts/src/svelte/Launchpad.svelte`（新文件）

**职责**：Launchpad 全屏覆盖层（8×5 网格 + 搜索 + 抖动编辑）。

```svelte
<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { invoke } from "../lib/backend";
  import { APP_META, appIcon, appTitleKey } from "../lib/appMeta";
  import { launchpadCols, launchpadRows, LAUNCHPAD_ICON_SIZE, LAUNCHPAD_ICON_GAP } from "../lib/desktopLayout";
  import { t } from "./locale.svelte";
  import { wmLayoutSnapshot } from "../lib/wm";

  const dispatch = createEventDispatcher<{ close: void }>();

  let cols = $state(LAUNCHPAD_COLS_DEFAULT);
  let rows = $state(LAUNCHPAD_ROWS_DEFAULT);
  let search = $state("");
  let editMode = $state(false);

  $effect(() => {
    void wmLayoutSnapshot().then(s => {
      if (s) {
        cols = launchpadCols(s.screen_w);
        rows = launchpadRows(s.screen_h);
      }
    });
  });

  const filteredApps = $derived(
    search
      ? APP_META.filter(a => t(a.titleKey).toLowerCase().includes(search.toLowerCase()))
      : APP_META
  );

  // 抖动编辑：长按或点击编辑按钮进入编辑模式（app 图标出现删除减号）。
  function toggleEdit() { editMode = !editMode; }

  async function openApp(id: string) {
    await invoke("wm_open", { label: id });
    dispatch("close");
  }
</script>

<!--
  Launchpad 全屏覆盖：
  - 深色背景（macOS Big Sur+ 风格）
  - 顶部搜索框 + 标题 "Launchpad"
  - 8×5 应用网格（自适配列数）
  - 点击应用图标 → wm_open → 关闭 Launchpad
  - 编辑模式：app 角标出现减号，点击可从 home layout 隐藏
  - Esc / 点击空白区域 关闭
-->
<div
  class="absolute inset-0 z-50 flex flex-col items-center overflow-hidden"
  style="background: rgba(20,20,20,0.95); backdrop-filter: blur(30px);"
  onclick={(e) => { if (e.target === e.currentTarget) dispatch("close"); }}
>
  <!-- 顶部搜索区 -->
  <div class="flex w-full items-center justify-between px-8 pt-8 pb-4">
    <h1 class="text-[22px] font-semibold text-white">{t("desktop.launchpad")}</h1>
    <div class="flex items-center gap-3">
      <input
        type="text"
        placeholder={t("desktop.search")}
        bind:value={search}
        class="h-8 w-64 rounded-lg bg-white/10 px-3 text-sm text-white placeholder-white/50 outline-none ring-1 ring-white/20 focus:ring-white/40"
      />
      <button
        class="text-[13px] text-white/60 hover:text-white"
        onclick={toggleEdit}
      >{editMode ? t("desktop.done") : t("desktop.edit")}</button>
    </div>
  </div>

  <!-- 应用网格 -->
  <div
    class="grid gap-6 px-8"
    style="grid-template-columns: repeat({cols}, {LAUNCHPAD_ICON_SIZE}px);"
  >
    {#each filteredApps as app (app.id)}
      <button
        class="group flex flex-col items-center gap-1"
        onclick={() => openApp(app.id)}
      >
        <span
          class="relative flex items-center justify-center rounded-[22px] bg-gradient-to-br from-neutral-700 to-neutral-900 shadow-md transition-transform group-active:scale-90"
          class:animate-pulse={editMode}
          style="width:{LAUNCHPAD_ICON_SIZE}px; height:{LAUNCHPAD_ICON_SIZE}px; font-size:48px;"
        >
          {app.icon}
          {#if editMode}
            <span
              class="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-danger text-[10px] text-white"
            >−</span>
          {/if}
        </span>
        <span class="max-w-full truncate text-[11px] text-white/80">{t(app.titleKey)}</span>
      </button>
    {/each}
  </div>
</div>
```

### 4.9 `frontend-ts/src/svelte/SpotlightOverlay.svelte`（新文件）

**职责**：Spotlight 居中浮层（`⌘ Space` 触发）。

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { invoke } from "../lib/backend";
  import { t } from "./locale.svelte";
  import { SPOTLIGHT_WIDTH, SPOTLIGHT_HEIGHT } from "../lib/desktopLayout";

  const dispatch = createEventDispatcher<{ close: void }>();

  let query = $state("");
  let results = $state<string[]>([]);

  // TODO: 调用 AI 同传 / 本地搜索。Phase 1 先做占位。
  function onInput() {
    // 占位：回显搜索词。
    results = query.length > 0 ? [`Search: "${query}"`, "Open Calculator", "Open Calendar"] : [];
  }
</script>

<!--
  Spotlight 居中浮层：
  - 宽 600px，高 400px，圆角 12px
  - 深色毛玻璃背景
  - 巨大搜索输入框（macOS Big Sur 风格）
  - 结果列表
  - Esc 关闭
-->
<div
  class="fixed inset-0 z-[100] flex items-start justify-center pt-24"
  style="background: rgba(0,0,0,0.4);"
  onclick={(e) => { if (e.target === e.currentTarget) dispatch("close"); }}
>
  <div
    class="flex flex-col overflow-hidden rounded-xl shadow-2xl"
    style="width:{SPOTLIGHT_WIDTH}px; background:rgba(40,40,40,0.95); backdrop-filter:blur(30px);"
  >
    <input
      type="text"
      placeholder={t("desktop.spotlightPlaceholder")}
      bind:value={query}
      oninput={onInput}
      autofocus
      class="h-14 border-b border-white/10 bg-transparent px-5 text-[22px] text-white placeholder-white/40 outline-none"
    />
    <div class="flex-1 overflow-y-auto p-2">
      {#each results as result (result)}
        <button
          class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-white/80 hover:bg-white/10"
          onclick={() => dispatch("close")}
        >
          🔍 <span>{result}</span>
        </button>
      {/each}
    </div>
  </div>
</div>
```

### 4.10 `frontend-ts/src/svelte/MissionControl.svelte`（新文件）

**职责**：窗口切换覆盖（`⌘ Tab` 触发，简化版：列出已打开窗口列表）。

```svelte
<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { invoke } from "../lib/backend";
  import { t } from "./locale.svelte";

  const dispatch = createEventDispatcher<{ close: void }>();

  let windows = $state<Array<{ label: string; kind: string }>>([]);

  onMount(async () => {
    const raw = await invoke<{ windows: Array<{ label: string; kind: string }> }>("wm_windows");
    if (raw?.windows) windows = raw.windows;
  });

  async function focusWindow(label: string) {
    await invoke("wm_focus", { label });
    dispatch("close");
  }
</script>

<!--
  Mission Control 简化版：
  - 半屏覆盖（底部 200px 高）
  - 列出所有已打开窗口
  - 点击切换焦点
-->
<div
  class="fixed inset-x-0 bottom-0 z-[100] flex items-center justify-center gap-6 p-8"
  style="background:rgba(20,20,20,0.9); backdrop-filter:blur(20px); height:200px;"
  onclick={(e) => { if (e.target === e.currentTarget) dispatch("close"); }}
>
  {#each windows as w (w.label)}
    <button
      class="flex flex-col items-center gap-1"
      onclick={() => focusWindow(w.label)}
    >
      <span class="text-4xl">📄</span>
      <span class="text-[11px] text-white/70">{w.label}</span>
    </button>
  {/each}
</div>
```

## 5. Shell 路由：桌面 vs. 手机

`Shell.svelte` 根据 `LayoutSnapshot.form` 选择渲染哪个 Shell：

```svelte
<script lang="ts">
  // Shell.svelte 的改动：
  import DesktopShell from "./DesktopShell.svelte";

  // 在 Shell.svelte 中，桌面形态走 DesktopShell，手机形态走现有逻辑。
  const s = $derived(surface());
  const isDesktop = $derived(layoutSnap?.form === "desktop");
</script>

{#if isDesktop}
  <!-- 桌面形态：DesktopShell -->
  <DesktopShell />
{:else}
  <!-- 手机形态：现有全部逻辑（不变） -->
  <!-- (现有 Shell 逻辑不变) -->
{/if}
```

## 6. Rust 侧改动

### 6.1 `wm.rs` 改动清单

| 改动 | 文件 | 描述 |
|---|---|---|
| App 窗口 URL 带 `#window=<label>` | `wm.rs` | `apply()` 中 `WmEvent::Created` 分支 |
| 焦点 app 写入 SharedStore | `wm.rs` | `WmEvent::FocusChanged` 分支 |
| 广播 `app-focused-changed` 事件 | ~~`wm.rs`~~ | **已删除（REQ-A254）**：前端一直只读 store，事件无人订阅（`tauri-event-scan` 挡下），`store-updated` 已是现成通道 |
| `title_bar_style: Overlay`（desktop 形态） | `wm.rs` | macOS 隐藏原生标题栏 |
| `wm_windows` 命令暴露窗口列表给前端 | `wm.rs` | Dock 的运行中指示 + Mission Control |

### 6.2 新增 Tauri 命令（可选）

| 命令 | 参数 | 返回 | 用途 |
|---|---|---|---|
| `desktop_launchpad` | — | `bool` | Dock 启动台图标 → 召出 Launchpad（通过浮层，不需要命令，Shell 内部状态控制） |

## 7. i18n 补键

在 `frontend-ts/src/i18n/locales/zh.ts` 和 `en.ts` 中补：

```typescript
// zh.ts / en.ts 新增键：
"desktop.topbar": "顶栏",
"desktop.dock": "Dock 栏",
"desktop.launchpad": "启动台",
"desktop.spotlight": "Spotlight 搜索",
"desktop.spotlightPlaceholder": "输入以搜索…",
"desktop.controlCenter": "控制中心",
"desktop.search": "搜索",
"desktop.edit": "编辑",
"desktop.done": "完成",
"desktop.missionControl": "窗口切换",
```

## 8. 实现顺序

```
Phase 3.1: Rust 侧 wm_open 补 #window=<label>
Phase 3.2: formLayout.ts 补 desktop 分支 + desktopLayout.ts
Phase 3.3: TopBar.svelte（最小化版）
Phase 3.4: Dock.svelte（最小化版）
Phase 3.5: DesktopShell.svelte（顶栏 + Dock + 舞台）
Phase 3.6: Shell.svelte 桌面/手机路由
Phase 3.7: Launchpad.svelte
Phase 3.8: SpotlightOverlay.svelte
Phase 3.9: MissionControl.svelte（简化版）
Phase 3.10: wm.rs 焦点 app 写入 SharedStore + 广播事件
Phase 4: 单测补（desktopLayout.test.ts）
Phase 5: i18n 补全
Phase 6: 文档更新
```

## 9. 不回归保证

| 文件 | 改动类型 | 验证 |
|---|---|---|
| `formLayout.ts` | 增量（desktop 分支） | `formLayout.test.ts` 中 `homeGrid("desktop", …)` 已有断言；新增断言 |
| `Shell.svelte` | 增量（`isDesktop` 分支） | 现有所有 surface 测试不变 |
| `StatusBar.svelte` | 无改动 | 桌面形态下 `DesktopShell` 不使用 `StatusBar` |
| `HomeDock.svelte` | 无改动 | 手机/平板形态仍用 |
| `amos-wm/src/form.rs` | 无改动 | 纯领域逻辑，不改 |
| `amos-wm/src/layout.rs` | 无改动 | 同上 |

## 10. 已知局限（诚实边界）

1. **顶栏菜单占位**：Phase 3 顶栏的 File/Edit/View/Window/Help 是静态占位，无实际下拉菜单；完整下拉菜单需要 Tauri 2 的 `Menu` API（Phase 6+）。
2. **Dock 放大镜效果**：Phase 3 Dock 使用简化放大（CSS `scale(1.0)`），完整放大效果需要鼠标位置追踪（Phase 4+ 迭代）。
3. **窗口拖动/缩放**：macOS 的窗口拖动/缩放由 Tauri 原生窗口 chrome 提供（`resizable: true`）；Phase 3 阶段保留原生 chrome。
4. **桌面图标**：macOS 桌面上的文件/文件夹图标不在 Phase 3 范围内（用户首要诉求是"看起来像 macOS"，桌面图标是文件管理器功能）。
