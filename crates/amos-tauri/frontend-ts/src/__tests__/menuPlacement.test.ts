import { describe, expect, test } from "bun:test";

import {
  MENU_MARGIN,
  placeMenu,
  placeMenuAt,
  type MenuAnchor,
  type MenuSize,
  type MenuViewport,
} from "../lib/menuPlacement";

/**
 * The numbers in these tests are the **measured** ones from the device pass that found the defect
 * (REQ-A481): the shell window is 1496×880 at (0,29) on a 967 pt-tall screen, the Dock sits at its
 * bottom, a right-click on the 访达 tile lands at (793,868) in window coordinates, and
 * `DockContextMenu` is 200×223. Everything below is derived from that, not invented.
 */
const SHELL: MenuViewport = { width: 1496, height: 880 };
const DOCK_MENU: MenuSize = { width: 200, height: 223 };
const DOCK_TILE: MenuAnchor = { x: 793, y: 839 };

describe("placeMenu — a cursor-anchored menu stays inside its viewport", () => {
  test("there is room below: the anchor is kept, nothing flips", () => {
    const p = placeMenu({ x: 300, y: 100 }, DOCK_MENU, SHELL);
    expect(p).toEqual({ left: 300, top: 100, flipped: false });
  });

  test("no room below but room above: the menu flips above the pointer", () => {
    // 868 + 223 + 8 > 880 ⇒ the measured device case (only 41 pt of window below the pointer).
    const p = placeMenu(DOCK_TILE, DOCK_MENU, SHELL);
    expect(p.flipped).toBe(true);
    expect(p.top).toBe(839 - 223 - MENU_MARGIN);
    expect(p.left).toBe(793);
  });

  test("the flipped panel is fully inside the viewport", () => {
    const p = placeMenu(DOCK_TILE, DOCK_MENU, SHELL);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.top + DOCK_MENU.height).toBeLessThanOrEqual(SHELL.height);
  });

  test("neither side fits: the first rows win, the panel overhangs the bottom", () => {
    // A menu taller than the window: pinning it to the top keeps the rows a user reads first.
    const tall: MenuSize = { width: 200, height: 900 };
    const p = placeMenu({ x: 100, y: 400 }, tall, SHELL);
    expect(p.top).toBe(MENU_MARGIN);
    expect(p.flipped).toBe(false);
  });

  test("a pointer near the left/right edge is pulled inside by the margin", () => {
    expect(placeMenu({ x: 2, y: 100 }, DOCK_MENU, SHELL).left).toBe(MENU_MARGIN);
    expect(placeMenu({ x: 1490, y: 100 }, DOCK_MENU, SHELL).left).toBe(1496 - 200 - MENU_MARGIN);
  });

  test("an unmeasured menu is returned unchanged (jsdom, or not painted yet)", () => {
    // Placing by guesswork is how the clipping defect would come back, so a menu with no measured
    // size is left exactly where the caller put it.
    expect(placeMenu({ x: 0, y: 0 }, { width: 0, height: 0 }, SHELL)).toEqual({
      left: 0,
      top: 0,
      flipped: false,
    });
    expect(placeMenu({ x: 10, y: 20 }, DOCK_MENU, { width: 0, height: 0 })).toEqual({
      left: 10,
      top: 20,
      flipped: false,
    });
  });

  test("a huge margin cannot push the menu off the other edge", () => {
    const p = placeMenu({ x: 500, y: 100 }, DOCK_MENU, SHELL, 2000);
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.left).toBeLessThanOrEqual(SHELL.width);
  });
});

describe("placeMenuAt — the component-facing half", () => {
  test("reads the rendered size and the window, then applies the same rule", () => {
    const el = { offsetWidth: 200, offsetHeight: 223 } as HTMLElement;
    const p = placeMenuAt(el, DOCK_TILE.x, DOCK_TILE.y, { innerWidth: 1496, innerHeight: 880 });
    expect(p.flipped).toBe(true);
    expect(p).toEqual(placeMenu(DOCK_TILE, DOCK_MENU, SHELL));
  });

  test("a menu with room below is untouched", () => {
    const el = { offsetWidth: 200, offsetHeight: 100 } as HTMLElement;
    const p = placeMenuAt(el, 40, 60, { innerWidth: 1496, innerHeight: 880 });
    expect(p).toEqual({ left: 40, top: 60, flipped: false });
  });
});
