/**
 * dock-context-menu-placement.svelte.test.ts — the menu stays inside the shell window (REQ-A481).
 *
 * The defect this pins was found on a real device, not in a test: the Dock sits at the bottom of the
 * shell window, so a right-click on the 访达 tile landed at y=839 inside an 880 pt-tall window while
 * `DockContextMenu` measures ~223 pt. Drawn straight down (as it was), the window clipped the panel
 * and every row below the first — 新建窗口 / 显示 / 隐藏 / 选项… / 退出 — was invisible and
 * unclickable; the pixels showed wallpaper and the macOS Dock where the menu should have been.
 *
 * jsdom reports every element as 0×0, so the rendered size is stubbed here with the numbers measured
 * on device. The rule itself is unit-tested; this file pins the **wiring** — that the component hands
 * its measured panel and the window to the rule — because a rule that is correct and unused is the
 * defect this repository keeps re-finding.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import DockContextMenu from "../src/svelte/modules/DockContextMenu.svelte";
import * as backend from "../src/lib/backend";
import { placeMenu } from "../src/lib/menuPlacement";

vi.mock("../src/lib/backend");

const PANEL = { width: 200, height: 223 };
const WINDOW = { width: 1496, height: 880 };

/** jsdom has no layout: give every element the measured panel size and pin the window size. */
function stubLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => PANEL.width,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => PANEL.height,
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: WINDOW.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: WINDOW.height });
}

function panelOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-testid="dock-context-menu"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe("DockContextMenu placement — the panel obeys the window it is drawn in (REQ-A481)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    // leave no layout stubs behind for the sibling suites
    for (const key of ["offsetWidth", "offsetHeight"] as const) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  test("a Dock-anchored menu (839 pt in an 880 pt window) is flipped above the pointer", () => {
    stubLayout();
    vi.mocked(backend.invoke).mockImplementation(async () => null);
    const { container } = render(DockContextMenu, {
      props: { label: "files", running: false, x: 793, y: 839, onclose: vi.fn() },
    });
    const expected = placeMenu({ x: 793, y: 839 }, PANEL, WINDOW);
    expect(expected.flipped).toBe(true);
    const style = panelOf(container).getAttribute("style") ?? "";
    expect(style).toContain(`left: ${expected.left}px`);
    expect(style).toContain(`top: ${expected.top}px`);
    // and the panel is inside the window, which is the whole point
    expect(expected.top + PANEL.height).toBeLessThanOrEqual(WINDOW.height);
  });

  test("a menu with room below keeps the pointer position (no behaviour change where it fit)", () => {
    stubLayout();
    vi.mocked(backend.invoke).mockImplementation(async () => null);
    const { container } = render(DockContextMenu, {
      props: { label: "files", running: false, x: 120, y: 200, onclose: vi.fn() },
    });
    const style = panelOf(container).getAttribute("style") ?? "";
    expect(style).toContain("left: 120px");
    expect(style).toContain("top: 200px");
  });
});
