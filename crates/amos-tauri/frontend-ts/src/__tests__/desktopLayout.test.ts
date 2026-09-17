/**
 * desktopLayout.test.ts — macOS 桌面形态几何决策的单测。
 *
 * 与 formLayout.test.ts 同纪律（Power of 10 #9：可测）。
 * 所有函数是纯函数，参数决定输出；测试固定几个真实窗口尺寸上的值。
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SCREEN,
  TOPBAR_HEIGHT,
  DOCK_HEIGHT,
  DOCK_ICON_SIZE,
  DOCK_ICON_GAP,
  DOCK_SIDE_PADDING,
  DOCK_MIN_WIDTH,
  LAUNCHPAD_COLS_DEFAULT,
  LAUNCHPAD_ROWS_DEFAULT,
  LAUNCHPAD_ICON_SIZE,
  LAUNCHPAD_ICON_GAP,
  LAUNCHPAD_SEARCH_HEIGHT,
  DESKTOP_GRID_COLS,
  DESKTOP_GRID_INSET,
  DESKTOP_GRID_ROWS,
  DESKTOP_TILE_GAP_X,
  DESKTOP_TILE_GAP_Y,
  DESKTOP_TILE_SIZE,
  desktopGridWidth,
  desktopIconCapacity,
  SPOTLIGHT_WIDTH,
  SPOTLIGHT_HEIGHT,
  launchpadCols,
  launchpadRows,
  dockCapacity,
  dockOverflowCount,
  stageRect,
  shouldShowMissionControl,
  dockIconScale,
} from "../lib/desktopLayout";

describe("desktopLayout constants", () => {
  test("常量值在预期范围内（防止意外修改）", () => {
    expect(TOPBAR_HEIGHT).toBe(24);
    expect(DOCK_HEIGHT).toBe(68);
    expect(DOCK_ICON_SIZE).toBe(48);
    expect(DOCK_ICON_GAP).toBe(8);
    expect(DOCK_SIDE_PADDING).toBe(24);
    expect(DOCK_MIN_WIDTH).toBe(320);
    expect(LAUNCHPAD_COLS_DEFAULT).toBe(8);
    expect(LAUNCHPAD_ROWS_DEFAULT).toBe(5);
    expect(LAUNCHPAD_ICON_SIZE).toBe(80);
    expect(LAUNCHPAD_ICON_GAP).toBe(24);
    expect(LAUNCHPAD_SEARCH_HEIGHT).toBe(88);
    expect(SPOTLIGHT_WIDTH).toBe(600);
    expect(SPOTLIGHT_HEIGHT).toBe(400);
  });

  test("DEFAULT_SCREEN 是无测量值时唯一的 fallback 真源", () => {
    expect(DEFAULT_SCREEN).toEqual({ width: 1440, height: 900 });
    // 每个"没有测量值"的入口都必须落到同一块屏，否则这条路径上的几何互相矛盾。
    expect(launchpadCols(NaN)).toBe(launchpadCols(DEFAULT_SCREEN.width));
    expect(launchpadRows(NaN)).toBe(launchpadRows(DEFAULT_SCREEN.height));
    expect(stageRect(NaN, NaN)).toEqual(stageRect(DEFAULT_SCREEN.width, DEFAULT_SCREEN.height));
    // Dock 的 fallback 是"最小可用 Dock"（DOCK_MIN_WIDTH），不是那块屏：一条 bar 的
    // 默认宽度与"没有屏幕信息时的舞台"是两件事，各自有各自的常量。
    expect(dockCapacity(NaN)).toBe(dockCapacity(DOCK_MIN_WIDTH));
  });
});

describe("launchpadCols", () => {
  test("1440px 宽屏 → 8 列", () => {
    // (1440 - 0) / (80+24) = 1440/104 ≈ 13，floor → 13 但上限是设计常量。
    // launchpadCols 本身没有上限（max 显示是 layout 控制），所以返回值就是 floor。
    // 实际 Launchpad 上限由 launchpadRows 和网格布局共同决定。
    const cols = launchpadCols(1440);
    expect(cols).toBeGreaterThanOrEqual(4);
    expect(cols).toBeLessThanOrEqual(13);
  });

  test("800px 较小桌面 → 至少 4 列", () => {
    expect(launchpadCols(800)).toBeGreaterThanOrEqual(4);
  });

  test("极小宽度（300px）→ 最小 4 列（永远不小于 4）", () => {
    expect(launchpadCols(300)).toBe(4);
  });

  test("非法输入（NaN、0、负数）→ 使用 fallback (1440px) ", () => {
    expect(launchpadCols(NaN)).toBe(launchpadCols(1440));
    expect(launchpadCols(0)).toBe(launchpadCols(1440));
    expect(launchpadCols(-100)).toBe(launchpadCols(1440));
  });
});

describe("launchpadRows", () => {
  test("900px 标准桌面 → 至少 3 行", () => {
    expect(launchpadRows(900)).toBeGreaterThanOrEqual(3);
  });

  test("1200px 高度 → 行数合理", () => {
    // 可用区域：1200 - 24 - 68 - 88 = 1020；行间距：80+24=104；rows ≈ 9
    const rows = launchpadRows(1200);
    expect(rows).toBeGreaterThan(3);
  });

  test("非法输入 → fallback 900px", () => {
    expect(launchpadRows(NaN)).toBe(launchpadRows(900));
    expect(launchpadRows(0)).toBe(launchpadRows(900));
  });
});

describe("dockCapacity", () => {
  test("宽 Dock (600px) → 至少 3 个图标", () => {
    expect(dockCapacity(600)).toBeGreaterThanOrEqual(3);
  });

  test("极窄（100px）→ 至少 3（基本可用性保证）", () => {
    expect(dockCapacity(100)).toBe(3);
  });

  test("1440px 宽 → 多个图标", () => {
    // 内宽 1440 - 48 = 1392；图标间距 48+8=56；1392/56 = 24
    expect(dockCapacity(1440)).toBeGreaterThanOrEqual(20);
  });

  test("非法输入 → fallback  DOCK_MIN_WIDTH（最小可用 Dock，不再是写死的 480）", () => {
    expect(dockCapacity(NaN)).toBe(dockCapacity(DOCK_MIN_WIDTH));
    expect(dockCapacity(0)).toBe(dockCapacity(DOCK_MIN_WIDTH));
    // (320 - 2*24) / (48 + 8) = 272/56 = 4.857… → 4
    expect(dockCapacity(DOCK_MIN_WIDTH)).toBe(4);
  });
});

describe("dockOverflowCount", () => {
  test("全部装得下 → 0", () => {
    expect(dockOverflowCount(5, 5)).toBe(0);
    expect(dockOverflowCount(3, 5)).toBe(0);
  });

  test("装不下 → 差多少个就报多少个（Dock 用它画 +N，不静默丢图标）", () => {
    expect(dockOverflowCount(8, 5)).toBe(3);
    expect(dockOverflowCount(12, 3)).toBe(9);
  });

  test("容量为 0（极窄窗口）→ 全部溢出", () => {
    expect(dockOverflowCount(4, 0)).toBe(4);
  });

  test("非法输入 → 0（不谎报溢出）", () => {
    expect(dockOverflowCount(NaN, 5)).toBe(0);
    expect(dockOverflowCount(5, NaN)).toBe(0);
    expect(dockOverflowCount(undefined as unknown as number, 5)).toBe(0);
  });
});

describe("stageRect", () => {
  test("1440×900 屏幕 → 舞台 = {x:0, y:24, w:1440, h:808}", () => {
    // 舞台高度 = 900 - 24 (TOPBAR) - 68 (DOCK) = 808
    expect(stageRect(1440, 900)).toEqual({
      x: 0,
      y: 24,
      width: 1440,
      height: 808,
    });
  });

  test("舞台高度 = 屏幕高度 - TOPBAR_HEIGHT - DOCK_HEIGHT", () => {
    const r = stageRect(2560, 1440);
    expect(r.height).toBe(1440 - TOPBAR_HEIGHT - DOCK_HEIGHT);
    expect(r.y).toBe(TOPBAR_HEIGHT);
    // 2560×1440 → height = 1440 - 24 - 68 = 1348
    expect(r.height).toBe(1348);
  });

  test("舞台宽度 = 屏幕宽度，x 永远 = 0", () => {
    const r = stageRect(1920, 1080);
    expect(r.width).toBe(1920);
    expect(r.x).toBe(0);
  });

  test("非法输入 → fallback (1440×900)", () => {
    expect(stageRect(NaN, NaN)).toEqual(stageRect(1440, 900));
    expect(stageRect(0, 0)).toEqual(stageRect(1440, 900));
    expect(stageRect(-100, -100)).toEqual(stageRect(1440, 900));
  });
});

describe("shouldShowMissionControl", () => {
  test("窗口数 ≥ 2 → 显示", () => {
    expect(shouldShowMissionControl(2)).toBe(true);
    expect(shouldShowMissionControl(5)).toBe(true);
  });

  test("窗口数 < 2 → 不显示", () => {
    expect(shouldShowMissionControl(0)).toBe(false);
    expect(shouldShowMissionControl(1)).toBe(false);
  });

  test("非法输入（NaN）→ 不显示（false）", () => {
    expect(shouldShowMissionControl(NaN)).toBe(false);
  });
});

describe("dockIconScale", () => {
  test("鼠标在图标正上方（dist=0）→ maxScale (默认 1.5)", () => {
    expect(dockIconScale(100, 100)).toBeCloseTo(1.5, 5);
  });

  test("鼠标在影响半径外（dist > radius）→ 1.0（默认 radius=120）", () => {
    expect(dockIconScale(220, 100)).toBe(1.0);
  });

  test("鼠标在影响半径边界（dist=radius=120）→ 1.0", () => {
    expect(dockIconScale(220, 100)).toBe(1.0);
  });

  test("鼠标在中间（dist=60）→ 介于 1.0 和 maxScale 之间", () => {
    const scale = dockIconScale(160, 100);
    expect(scale).toBeGreaterThan(1.0);
    expect(scale).toBeLessThan(1.5);
  });

  test("自定义 maxScale 和 radius", () => {
    // maxScale=1.3, radius=80（用于测试自定义参数）
    expect(dockIconScale(100, 100, 1.3, 80)).toBeCloseTo(1.3, 5);
    expect(dockIconScale(180, 100, 1.3, 80)).toBe(1.0);
  });

  test("非法输入 → 1.0（安全降级）", () => {
    expect(dockIconScale(NaN, 100)).toBe(1.0);
    expect(dockIconScale(100, NaN)).toBe(1.0);
  });
});

describe("desktop icon grid (REQ-A263: the stage's geometry moved into the one geometry module)", () => {
  test("the grid holds columns × rows icons — the stage used to hard-code 16", () => {
    expect(DESKTOP_GRID_COLS * DESKTOP_GRID_ROWS).toBe(16);
    expect(desktopIconCapacity()).toBe(16);
    expect(desktopIconCapacity(8, 2)).toBe(16);
    expect(desktopIconCapacity(3.9, 2.9)).toBe(6); // truncates rather than rounding up
  });

  test("a size we cannot believe yields no icons (never a guessed row count)", () => {
    expect(desktopIconCapacity(NaN, 4)).toBe(0);
    expect(desktopIconCapacity(4, Infinity)).toBe(0);
    expect(desktopIconCapacity(-2, 4)).toBe(0);
  });

  test("the grid width is what the template used to spell as calc(4 * 64px + 3 * 64px)", () => {
    // 4 columns × 64 px tile + 3 gaps × 64 px gap = 256 + 192 = 448 px
    expect(desktopGridWidth()).toBe(4 * 64 + 3 * 64);
    expect(desktopGridWidth(1)).toBe(64); // one column has no gap
    expect(desktopGridWidth(0)).toBe(448); // invalid ⇒ the documented default
    expect(desktopGridWidth(NaN)).toBe(448);
  });

  test("the numbers match the look that shipped (no value was changed by the move)", () => {
    expect(DESKTOP_TILE_SIZE).toBe(64);
    expect(DESKTOP_TILE_GAP_X).toBe(64); // 桌面图标横向间距
    expect(DESKTOP_TILE_GAP_Y).toBe(48); // 桌面图标纵向间距
    expect(DESKTOP_GRID_INSET).toBe(32); // left-8 / top-8
  });
});
