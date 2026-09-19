/**
 * desktopLayout.ts — macOS 桌面形态布局几何常量 + 纯决策函数。
 *
 * 与 `formLayout.ts` 的纪律完全一致（Power of 10 #2：静态 / 无 I/O / 无分配）。
 * 所有值由宿主提供（`LayoutSnapshot.screen_w/h`），前端绝不从 WebView 尺寸猜。
 *
 * 诚实边界（保持显式）：
 *   * `stageRect` 在 `screen_w/h` 非法时使用合理 fallback（1440×900），而非 NaN。
 *   * 列数/行数永远 ≥ 最小值（`launchpadCols >= 4`、`launchpadRows >= 3`）。
 *   * Dock 容量永远 ≥ 3（即使在极窄窗口下也有基本可用性）。
 */

// ─── 几何常量 ─────────────────────────────────────────────────────────────────

/**
 * 没有 host 测量值时的屏幕 fallback（px）。
 *
 * 这是**唯一**一处写死 fallback 的地方：`launchpadCols/Rows`、`dockCapacity`、
 * `stageRect` 与 `DesktopShell.svelte` 的初始舞台都从这里取，避免同一个 1440×900
 * 在五个地方各写一遍（其中一处写错就会让"无测量值"这一路的几何互相矛盾）。
 */
export const DEFAULT_SCREEN = { width: 1440, height: 900 } as const;

/** macOS 顶栏高度（px）—— macOS 实测标准 24px（无刘海），28px（带刘海感知）。 */
export const TOPBAR_HEIGHT = 24;

/** macOS Dock 高度（px）—— macOS 实测标准 68px（含 16px 底部 padding）。 */
export const DOCK_HEIGHT = 68;

/** macOS Dock 最小宽度（px），用于极窄窗口 fallback。 */
export const DOCK_MIN_WIDTH = 320;

/** Dock 图标尺寸（px，正方形）—— macOS 默认 48px（用户可调至 16-128px）。 */
export const DOCK_ICON_SIZE = 48;

/** Dock 图标间距（px）—— macOS 实测标准 8px。 */
export const DOCK_ICON_GAP = 8;

/** macOS Dock 两侧边距（px）—— macOS 实测标准 24px。 */
export const DOCK_SIDE_PADDING = 24;

/** Launchpad 默认列数（≥1440px 宽屏）。 */
export const LAUNCHPAD_COLS_DEFAULT = 8;

/** Launchpad 默认行数（≥900px 高度）。 */
export const LAUNCHPAD_ROWS_DEFAULT = 5;

/** macOS Overlay 标题栏高度（px）—— G-α。
 *
 * 宿主已经在 `wm.rs` 设置 `title_bar_style(Overlay)`（desktop 形态），所以原生 chrome
 * 不再画，但 WebView 内容区会贴边 —— 需要前端自己留出 28 px 给红绿灯 + 居中标题。
 * 28 px 是 macOS 标准标题栏高度的整数部分（含刘海感知）。
 *
 * 这是**唯一**真源：组件读它，不写第二份（仓内桌面常量全部收口在
 * `lib/desktopLayout.ts` —— `PC_DESKTOP_AUDIT.md` §3 钉住的几何纪律）。
 */
export const APP_WINDOW_TITLEBAR_HEIGHT = 28;

/** macOS Overlay 标题栏左侧留给**系统红绿灯**的宽度（px）—— G-α / REQ-A440。
 *
 * 真机实测（2026-09-19，截图 2× 放大核对）：`title_bar_style(Overlay)` 下 AppKit 在**同一条**
 * 28 px 带上画真正的红绿灯（三个圆点占窗口左侧约 14…66 px），与 WebView 内容重叠 —— 所以
 * 前端要留出这块宽度给它们，而**不要**自绘第二组（自绘那组点不到，且与真的一组叠成双影）。
 * 74 = 66（最右一个点的右沿）+ 8（呼吸余量），取 macOS 自己的间距口径（直径 12、间距 20）。
 */
export const APP_WINDOW_TITLEBAR_INSET = 74;

/** 桌面通知 banner 距顶栏下沿的偏移（px）—— G-γ。
 *
 * macOS Big Sur+ 实测 6 px；保留为常量是因为「顶栏 + 6 px」是 macOS 的标准间距，
 * 任意改一处都意味着「通知视觉上离开了顶栏」，不该由调用方自算。
 *
 * 与 `NOTIF_BANNER_RIGHT_OFFSET` 配合得到 banner 绝对定位的 (top, right)。
 * 真实真源是 `TOPBAR_HEIGHT + NOTIF_BANNER_TOP_OFFSET`——
 * `desktop-notification-banner.svelte.test.ts` 中 `data-banner-top` 数据属性直接
 * 计算这个加法，方便后续如果顶栏高度变了 banner 自动跟随。
 */
export const NOTIF_BANNER_TOP_OFFSET = 6;

/** 桌面通知 banner 距屏幕右沿的偏移（px）—— G-γ。
 *
 * macOS 实测 8 px；与上面 `NOTIF_BANNER_TOP_OFFSET` 同样道理。
 */
export const NOTIF_BANNER_RIGHT_OFFSET = 8;

/** 桌面通知 banner 最大宽度（px）—— G-γ。
 *
 * 与 `DesktopNotificationCenter.svelte` 的右栏宽度（`NC_RIGHT_PANEL_WIDTH`）一致——
 * 同一份通知视觉宽度在两个 surface 上保持一致，是 macOS 的可见特征。
 * 这里不复用 `NC_RIGHT_PANEL_WIDTH`：banner 是浮层、面板是抽屉，未来调整其中之一
 * 不应该自动带动另一个（它们的滚动 / 折叠语义不同），但**初值**保持一致。
 */
export const NOTIF_BANNER_MAX_WIDTH = 360;

/** 通知 banner 自动消失时长（ms）—— G-γ。
 *
 * **与 phone 形态 `NotificationBanner.svelte` 同源**：
 * 桌面与手机用同一个时长，避免「同一 app 的通知，在 PC 上停留 4.2s，在手机上停留
 * 别的时长」这种 UX 分裂。
 *
 * 把字面值集中到 desktopLayout.ts 是为了**一条 grep 就能审计全部几何/时间常量**：
 * G-α 的"标题栏高度 = 28"就靠这条纪律钉住的，G-γ 沿用同一纪律
 * （`desktop-notification-banner.svelte.test.ts` 的负控 #1 钉此）。
 */
export const NOTIF_BANNER_SHOW_MS = 4200;

/** 每个 Launchpad 图标尺寸（px）。 */
export const LAUNCHPAD_ICON_SIZE = 80;

/** Launchpad 图标间距（px）。 */
export const LAUNCHPAD_ICON_GAP = 24;

/** Launchpad 顶部搜索区高度（搜索框 + 标题）。 */
export const LAUNCHPAD_SEARCH_HEIGHT = 88;

/** Spotlight 浮层最大宽度（px）。 */
export const SPOTLIGHT_WIDTH = 600;

/** Spotlight 浮层输入框高度（px）。 */
export const SPOTLIGHT_INPUT_HEIGHT = 56;

/** Spotlight 浮层最大高度（px）。 */
export const SPOTLIGHT_HEIGHT = 400;

// ─── 桌面图标栅格（舞台）──────────────────────────────────────────────────────
// REQ-A263: these numbers used to exist **only inside `DesktopStage.svelte`'s template**
// (`grid-cols-4`, `h-20 w-20`, `gap-x-6 gap-y-5`, `left-8 top-8`, plus a
// `width: calc(4 * 80px + 3 * 24px)` line) — so the same 80/24 was written twice, and the
// stage was the one surface left making its own geometry decisions outside this module
// (REQ-A249's rule: geometry has exactly one home). They live here now.
//
// macOS 实测标准：图标 64px + 标签，整体间距水平 128px / 垂直 112px（含标签高度）

/** Desktop icon tile edge (px) — macOS 默认 64px。 */
export const DESKTOP_TILE_SIZE = 64;

/** Gap between desktop icon columns (px) — macOS 实测 128px（图标中心到中心）。 */
export const DESKTOP_TILE_GAP_X = 64;

/** Gap between desktop icon rows (px) — macOS 实测 112px（含标签，中心到中心）。 */
export const DESKTOP_TILE_GAP_Y = 48;

/** Inset of the icon grid from the stage's top-left corner (px). */
export const DESKTOP_GRID_INSET = 32;

/** Desktop icon grid columns (the rest of the apps live in Launchpad — as on a Mac). */
export const DESKTOP_GRID_COLS = 4;

/** Desktop icon grid rows. */
export const DESKTOP_GRID_ROWS = 4;

/**
 * How many icons the grid holds (columns × rows). Non-finite input yields 0: this function
 * does not guess a size, because its caller already knows that "how many fit on a desktop"
 * is a design decision, not a measurement.
 */
export function desktopIconCapacity(
  cols = DESKTOP_GRID_COLS,
  rows = DESKTOP_GRID_ROWS,
): number {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return 0;
  return Math.max(0, Math.trunc(cols) * Math.trunc(rows));
}

/** The grid's pixel width — the one source for the `calc()` the stage template used to spell. */
export function desktopGridWidth(cols = DESKTOP_GRID_COLS): number {
  const n = Number.isFinite(cols) && cols > 0 ? Math.trunc(cols) : DESKTOP_GRID_COLS;
  return n * DESKTOP_TILE_SIZE + (n - 1) * DESKTOP_TILE_GAP_X;
}

// ─── 纯决策函数 ───────────────────────────────────────────────────────────────

/**
 * 给定可用宽度，计算 Launchpad 列数。
 * 最小 4 列（在 800px 窗口下仍可接受）。
 */
export function launchpadCols(screenW: number): number {
  const w = Number.isFinite(screenW) && screenW > 0 ? screenW : DEFAULT_SCREEN.width;
  return Math.max(4, Math.floor(w / (LAUNCHPAD_ICON_SIZE + LAUNCHPAD_ICON_GAP)));
}

/**
 * 给定可用高度，计算 Launchpad 行数（不含搜索区 + 标题）。
 * 最小 3 行。
 */
export function launchpadRows(screenH: number): number {
  const h = Number.isFinite(screenH) && screenH > 0 ? screenH : DEFAULT_SCREEN.height;
  const usable = h - TOPBAR_HEIGHT - DOCK_HEIGHT - LAUNCHPAD_SEARCH_HEIGHT;
  return Math.max(3, Math.floor(usable / (LAUNCHPAD_ICON_SIZE + LAUNCHPAD_ICON_GAP)));
}

/**
 * 给定 Dock 区域宽度，返回该宽度能容纳的最大 Dock 图标数。
 * 最小 3（在极窄窗口下也保持基本可用性）。
 */
export function dockCapacity(dockW: number): number {
  // 无测量值 / 畸形宽度 → 用 DOCK_MIN_WIDTH 当作"最小的可用 Dock"，与
  // `launchpadCols` 用 DEFAULT_SCREEN 同一条纪律（fallback 只有一处真源）。
  const w = Number.isFinite(dockW) && dockW > 0 ? dockW : DOCK_MIN_WIDTH;
  const inner = w - DOCK_SIDE_PADDING * 2;
  return Math.max(3, Math.floor(inner / (DOCK_ICON_SIZE + DOCK_ICON_GAP)));
}

/**
 * 装不下的 Dock 项数（0 表示全部装得下）。
 *
 * Dock 的可见项是 `items.slice(0, dockCapacity(w))`；被截掉的那几个**不能悄悄消失**
 * （用户会以为 app 没了），所以 Dock 用这个数渲染一个 `+N` 计数。判定是纯函数，
 * 边界（capacity 大于/等于/小于总数、非法计数）在单测里钉住。
 */
export function dockOverflowCount(total: number, capacity: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(capacity)) return 0;
  return Math.max(0, Math.trunc(total) - Math.trunc(capacity));
}

/**
 * 舞台区域（顶栏之下、Dock 之上）的完整 bounding rect。
 * 这是多窗口舞台占据的 CSS absolute 区域。
 */
export interface StageRect {
  /** 舞台左上 X 坐标（始终为 0）。 */
  x: 0;
  /** 舞台左上 Y 坐标 = 顶栏高度。 */
  y: number;
  /** 舞台宽度。 */
  width: number;
  /** 舞台高度（屏幕高度 - 顶栏 - Dock）。 */
  height: number;
}

/**
 * 根据屏幕尺寸计算舞台区域。
 * 非法输入使用 `DEFAULT_SCREEN`（无测量值时的唯一 fallback）。
 */
export function stageRect(screenW: number, screenH: number): StageRect {
  const w = Number.isFinite(screenW) && screenW > 0 ? screenW : DEFAULT_SCREEN.width;
  const h = Number.isFinite(screenH) && screenH > 0 ? screenH : DEFAULT_SCREEN.height;
  return {
    x: 0,
    y: TOPBAR_HEIGHT,
    width: w,
    height: h - TOPBAR_HEIGHT - DOCK_HEIGHT,
  };
}

/**
 * 是否应渲染 Mission Control（窗口数 ≥ 2）。
 * 1 个窗口时 Mission Control 没有意义。
 */
export function shouldShowMissionControl(openWindowCount: number): boolean {
  return Number.isFinite(openWindowCount) && openWindowCount >= 2;
}

/**
 * 计算鼠标在 Dock 中的"放大镜"效果 scale 因子。
 *
 * macOS 使用抛物线衰减（二次函数），不是线性插值。影响范围约 5 个图标宽度。
 *
 * @param mouseX - 鼠标 X 坐标（视口坐标）
 * @param iconCenterX - 该图标中心的 X 坐标
 * @param maxScale - 最大放大倍数（默认 1.5，macOS 实测约 1.5-1.8）
 * @param radius - 放大影响半径（px，默认 120，约 2.5 个图标）
 */
export function dockIconScale(
  mouseX: number,
  iconCenterX: number,
  maxScale = 1.5,
  radius = 120,
): number {
  if (!Number.isFinite(mouseX) || !Number.isFinite(iconCenterX)) return 1.0;
  const dist = Math.abs(mouseX - iconCenterX);
  if (dist >= radius) return 1.0;
  // 抛物线衰减：(1 - (dist/radius)²) 的加权
  const normalized = dist / radius;
  const factor = 1.0 - normalized * normalized;
  return 1.0 + (maxScale - 1.0) * factor;
}
