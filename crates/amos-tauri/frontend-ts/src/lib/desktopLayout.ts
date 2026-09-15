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

/** macOS 顶栏高度（px），包括刘海区占位 12px。 */
export const TOPBAR_HEIGHT = 28;

/** macOS Dock 高度（px），不含顶部圆角区。 */
export const DOCK_HEIGHT = 76;

/** macOS Dock 最小宽度（px），用于极窄窗口 fallback。 */
export const DOCK_MIN_WIDTH = 320;

/** Dock 图标尺寸（px，正方形）。 */
export const DOCK_ICON_SIZE = 56;

/** Dock 图标间距（px）。 */
export const DOCK_ICON_GAP = 8;

/** macOS Dock 两侧边距（px）。 */
export const DOCK_SIDE_PADDING = 24;

/** Launchpad 默认列数（≥1440px 宽屏）。 */
export const LAUNCHPAD_COLS_DEFAULT = 8;

/** Launchpad 默认行数（≥900px 高度）。 */
export const LAUNCHPAD_ROWS_DEFAULT = 5;

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
// (REQ-A249's rule: geometry has exactly one home). They live here now, with **no value
// changed**: the look is pixel-identical. What "the right numbers are" is still an **open
// product decision** (two sets exist in this repo — see `docs/multi-window.md` §1.5 and
// `docs/PC_DESKTOP_AUDIT.md`), but it is now a decision in one place, with a test.

/** Desktop icon tile edge (px) — the same size as the home screen's large tile. */
export const DESKTOP_TILE_SIZE = 80;

/** Gap between desktop icon columns (px). */
export const DESKTOP_TILE_GAP_X = 24;

/** Gap between desktop icon rows (px). */
export const DESKTOP_TILE_GAP_Y = 20;

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
 * @param mouseX - 鼠标 X 坐标（视口坐标）
 * @param iconCenterX - 该图标中心的 X 坐标
 * @param maxScale - 最大放大倍数（默认 1.3）
 * @param radius - 放大影响半径（px，默认 80）
 */
export function dockIconScale(
  mouseX: number,
  iconCenterX: number,
  maxScale = 1.3,
  radius = 80,
): number {
  if (!Number.isFinite(mouseX) || !Number.isFinite(iconCenterX)) return 1.0;
  const dist = Math.abs(mouseX - iconCenterX);
  if (dist >= radius) return 1.0;
  // 线性插值：距离 0 → maxScale，距离 radius → 1.0
  return maxScale - (maxScale - 1.0) * (dist / radius);
}
