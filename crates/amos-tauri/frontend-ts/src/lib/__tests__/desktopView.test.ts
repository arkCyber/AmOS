/**
 * desktopView.ts — pure data + persistence (REQ-A275).
 *
 * The View menu reads from `amos.settings.view`. Two layers to pin:
 *   1. The **pure** layer (`readDesktopView`, `writeDesktopView`, `toggleInView`)
 *      — no DOM, no localStorage side effects beyond what `amosStore` does. We
 *      drive the store directly, then assert the menu's toggles round-trip.
 *   2. The **defaults** — missing keys must fall back to `DEFAULT_DESKTOP_VIEW`
 *      (`showWallpaper` + `showIcons` start `true`; `showStageWidgets` starts
 *      `false` because macOS shows time in the topbar, not as a desktop widget).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { writeStoreValue } from "../amosStore";
import {
  DEFAULT_DESKTOP_VIEW,
  DESKTOP_VIEW_KEY,
  readDesktopView,
  toggleDesktopView,
  toggleInView,
  writeDesktopView,
  type DesktopView,
} from "../desktopView";

// Bring up a real DOM for this file (globals are per-process in bun).
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

afterEach(() => window.localStorage.clear());
beforeEach(() => window.localStorage.clear());

describe("readDesktopView", () => {
  test("returns defaults when nothing is stored (showWallpaper/showIcons=true, showStageWidgets=false)", () => {
    expect(readDesktopView()).toEqual(DEFAULT_DESKTOP_VIEW);
    expect(readDesktopView().showWallpaper).toBe(true);
    expect(readDesktopView().showIcons).toBe(true);
    expect(readDesktopView().showStageWidgets).toBe(false);
  });

  test("returns defaults for partial JSON (only showIcons set)", () => {
    writeStoreValue(DESKTOP_VIEW_KEY, { showIcons: false });
    const v = readDesktopView();
    expect(v.showIcons).toBe(false);
    // The unset keys fall back to their documented defaults — the wallpaper
    // defaults to visible, but the stage widget defaults to hidden (the time
    // lives in the topbar, not as a desktop widget).
    expect(v.showWallpaper).toBe(true);
    expect(v.showStageWidgets).toBe(false);
  });

  test("tolerates corrupt JSON without throwing", () => {
    window.localStorage.setItem(DESKTOP_VIEW_KEY, "{not-json");
    expect(readDesktopView()).toEqual(DEFAULT_DESKTOP_VIEW);
  });
});

describe("toggleInView", () => {
  test("flips one key, leaves the other two untouched", () => {
    const start: DesktopView = { showWallpaper: true, showIcons: true, showStageWidgets: false };
    expect(toggleInView(start, "wallpaper")).toEqual({
      showWallpaper: false,
      showIcons: true,
      showStageWidgets: false,
    });
  });

  test("two flips restore the original state", () => {
    const start = DEFAULT_DESKTOP_VIEW;
    const once = toggleInView(start, "icons");
    const twice = toggleInView(once, "icons");
    expect(twice).toEqual(start);
  });
});

describe("writeDesktopView + toggleDesktopView", () => {
  test("writeDesktopView persists and readDesktopView reads it back", () => {
    writeDesktopView({
      showWallpaper: false,
      showIcons: true,
      showStageWidgets: false,
    });
    expect(readDesktopView()).toEqual({
      showWallpaper: false,
      showIcons: true,
      showStageWidgets: false,
    });
  });

  test("toggleDesktopView flips one key and persists", () => {
    // Start in defaults (everything visible).
    expect(readDesktopView().showWallpaper).toBe(true);
    toggleDesktopView("wallpaper");
    expect(readDesktopView().showWallpaper).toBe(false);
    toggleDesktopView("wallpaper");
    expect(readDesktopView().showWallpaper).toBe(true);
  });
});
