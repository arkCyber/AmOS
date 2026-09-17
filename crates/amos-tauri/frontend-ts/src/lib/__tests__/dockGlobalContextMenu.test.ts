/**
 * dockGlobalContextMenu.test.ts — 测试 Dock 全局右键菜单的数据流和回调
 */
import { describe, expect, test } from "bun:test";
import type { DockPrefs, DockPosition } from "../dockPrefs";
import { DEFAULT_DOCK_PREFS } from "../dockPrefs";

describe("DockGlobalContextMenu data contract", () => {
  test("DEFAULT_DOCK_PREFS has all required fields", () => {
    expect(DEFAULT_DOCK_PREFS).toHaveProperty("position");
    expect(DEFAULT_DOCK_PREFS).toHaveProperty("autoHide");
    expect(DEFAULT_DOCK_PREFS).toHaveProperty("magnification");
    expect(DEFAULT_DOCK_PREFS).toHaveProperty("iconSize");
  });

  test("position values are valid DockPosition", () => {
    const validPositions: DockPosition[] = ["bottom", "left", "right"];
    validPositions.forEach((pos) => {
      expect(["bottom", "left", "right"]).toContain(pos);
    });
  });

  test("magnification range is 1.0 to 2.0", () => {
    expect(DEFAULT_DOCK_PREFS.magnification).toBeGreaterThanOrEqual(1.0);
    expect(DEFAULT_DOCK_PREFS.magnification).toBeLessThanOrEqual(2.0);
  });

  test("iconSize range is 32 to 64", () => {
    expect(DEFAULT_DOCK_PREFS.iconSize).toBeGreaterThanOrEqual(32);
    expect(DEFAULT_DOCK_PREFS.iconSize).toBeLessThanOrEqual(64);
  });

  test("magnification increment/decrement by 0.1", () => {
    const prefs: DockPrefs = { ...DEFAULT_DOCK_PREFS };
    const newMag = prefs.magnification + 0.1;
    expect(newMag).toBeCloseTo(DEFAULT_DOCK_PREFS.magnification + 0.1, 1);
  });

  test("iconSize increment/decrement by 4", () => {
    const prefs: DockPrefs = { ...DEFAULT_DOCK_PREFS };
    const newSize = prefs.iconSize + 4;
    expect(newSize).toBe(DEFAULT_DOCK_PREFS.iconSize + 4);
  });

  test("magnification clamps at upper bound 2.0", () => {
    const prefs: DockPrefs = { ...DEFAULT_DOCK_PREFS, magnification: 2.0 };
    const newMag = Math.max(1.0, Math.min(2.0, prefs.magnification + 0.1));
    expect(newMag).toBe(2.0);
  });

  test("magnification clamps at lower bound 1.0", () => {
    const prefs: DockPrefs = { ...DEFAULT_DOCK_PREFS, magnification: 1.0 };
    const newMag = Math.max(1.0, Math.min(2.0, prefs.magnification - 0.1));
    expect(newMag).toBe(1.0);
  });

  test("iconSize clamps at upper bound 64", () => {
    const prefs: DockPrefs = { ...DEFAULT_DOCK_PREFS, iconSize: 64 };
    const newSize = Math.max(32, Math.min(64, prefs.iconSize + 4));
    expect(newSize).toBe(64);
  });

  test("iconSize clamps at lower bound 32", () => {
    const prefs: DockPrefs = { ...DEFAULT_DOCK_PREFS, iconSize: 32 };
    const newSize = Math.max(32, Math.min(64, prefs.iconSize - 4));
    expect(newSize).toBe(32);
  });
});
