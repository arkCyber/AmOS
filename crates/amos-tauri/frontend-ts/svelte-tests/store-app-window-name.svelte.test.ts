/**
 * store-app-window-name.svelte.test.ts — REQ-A1185 / F-SH-476.
 *
 * A **window** of an *installed store app* must be named by the app's own name and drawn with
 * the app's own glyph, on every surface that lists windows.
 *
 * The defect this pins: `windowName` resolved a name through `appTitleKey` alone — the
 * compile-time registry of the build's own 36 apps. An installed app's name lives in the
 * **store registry** (`lib/storeApps`, the tile list), which `appTitleKey` cannot see, so the
 * resolver fell through to `appId || label` and every surface printed the raw wire id
 * `store:org.amos.demo` while the sibling built-in window beside it printed `文件`. The
 * switcher and the title bar also drew the generic 🧩 / 🪟 fallback glyph.
 *
 * Measured on this machine before the fix (scratch probe, deleted):
 *   APPWINDOW title text:               "store:org.amos.demo"
 *   APPWINDOW titlebar aria-label:      "store:org.amos.demo"
 *   MISSIONCONTROL text:                "🧩 store:org.amos.demo📁 文件  选择应用窗口切换"
 *
 * The four assertions below are the four surfaces: an app window's own title bar
 * (`DesktopAppWindow`), Mission Control's switcher, App Exposé's tiles and the Spaces panel's
 * window list. All four go through the one resolver, so all four are checked.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopAppWindow from "../src/svelte/DesktopAppWindow.svelte";
import MissionControl from "../src/svelte/MissionControl.svelte";
import AppExpose from "../src/svelte/AppExpose.svelte";
import SpacesPanel from "../src/svelte/SpacesPanel.svelte";
import * as backend from "../src/lib/backend";
import * as spaces from "../src/lib/spaces";
import { setStoreTiles, type StoreTile } from "../src/lib/storeApps";

vi.mock("../src/lib/backend");
// Only the host-facing reads are stubbed; `fileableWindows` stays REAL — it is the rule that
// decides *which* windows the Spaces panel lists, and stubbing it would make the panel's
// window list a fixture rather than the production filter.
vi.mock("../src/lib/spaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/spaces")>();
  return {
    ...actual,
    listSpaces: vi.fn(async () => []),
    activeSpace: vi.fn(async () => 0),
  };
});
vi.mock("../src/lib/focusTrap", () => ({ attachFocusTrap: vi.fn(() => () => {}) }));
// The store app's window body is a web-bundle runtime (`ExtAppHost`) that fetches a bundle
// from the host — irrelevant here, and its fetch would reject without a host to answer. This
// suite is about the window's *name and glyph*, so the body is elided.
vi.mock("../src/svelte/ExtAppHost.svelte", () => ({ default: () => null }));

/** The installed app under test: a store id, a manifest id, a display name and a glyph. */
const DEMO: StoreTile = {
  id: "store:org.amos.demo",
  mid: "org.amos.demo",
  name: "Demo",
  icon: "D",
};

/** The probe used 2 windows because Mission Control hides itself for 0/1 (`shouldShowMissionControl`). */
const WINDOWS = [
  { label: DEMO.id, app: DEMO.id, kind: "App", state: "Focused" },
  { label: "files", app: "files", kind: "App", state: "Normal" },
];

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  // The four surfaces read the tile list from `SHELL_CHROME_API` when a shell provides it and
  // fall back to the module cache when rendered alone — which is how this suite renders them.
  setStoreTiles([DEMO]);
  vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "wm_windows") return { windows: WINDOWS } as never;
    return null;
  });
  vi.mocked(spaces.listSpaces).mockResolvedValue([]);
  vi.mocked(spaces.activeSpace).mockResolvedValue(0);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setStoreTiles([]);
});

describe("REQ-A1185 — a store app's window is named and drawn by the store registry", () => {
  test("an app window's title bar shows the app's name, not its wire id", async () => {
    const { container } = render(DesktopAppWindow, { props: { id: DEMO.id, ext: [DEMO] } });
    await tick();
    const bar = container.querySelector('[data-testid="app-window-titlebar"]');
    const title = container.querySelector('[data-testid="app-window-title"]');
    expect(title?.textContent?.trim()).toBe("Demo");
    // The accessible name of the title bar is the same word — a screen reader reads the
    // window's name, not a platform identifier.
    expect(bar?.getAttribute("aria-label")).toBe("Demo");
    expect(container.textContent).not.toContain(DEMO.id);
  });

  test("Mission Control names and draws the tile from the store registry", async () => {
    const { container } = render(MissionControl, { props: { onclose: vi.fn() } });
    await waitFor(() => expect(container.querySelector('[data-testid="mission-windows"]')).toBeTruthy());

    const tiles = [...container.querySelectorAll('[data-testid="mission-windows"] button')];
    const storeTile = tiles.find((b) => b.getAttribute("aria-label") === "Demo");
    expect(storeTile, "the store app's window is listed under its own name").toBeTruthy();
    // …and its own glyph, not the generic 🧩 fallback. Read the *glyph* element, not the
    // tile's whole text: "Demo" also contains a `D`, so a `toContain("D")` would stay green
    // with the fallback glyph in place (measured — that is exactly how NC-B first came out).
    expect(storeTile?.querySelector("div")?.textContent?.trim()).toBe("D");
    expect(container.textContent).not.toContain(DEMO.id);
    // The sibling built-in window is still named the way it always was — the fix must not
    // have cost the built-in path its name.
    expect(tiles.some((b) => b.getAttribute("aria-label") === "文件")).toBe(true);
  });

  test("App Exposé's tiles name the store window and draw its glyph", async () => {
    // The focused app is the store app, so its windows are what this panel tiles.
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_windows")
        return {
          windows: [
            { label: DEMO.id, app: DEMO.id, kind: "App", state: "Normal", focused: true },
            { label: `${DEMO.id}_2`, app: DEMO.id, kind: "App", state: "Normal" },
          ],
        } as never;
      return null;
    });
    const { container } = render(AppExpose, { props: { onclose: vi.fn() } });
    await waitFor(() => expect(container.querySelector('[data-testid="app-expose"]')).toBeTruthy());

    const tiles = [...container.querySelectorAll('[data-testid="app-expose-tile"]')];
    expect(tiles.length).toBe(2);
    // The first window is `Demo`; the second carries its instance marker.
    expect(tiles[0].getAttribute("aria-label")).toBe("Demo");
    expect(tiles[1].getAttribute("aria-label")).toBe("Demo — 2");
    // The glyph, read from the tile's icon element (not its whole text — "Demo" contains a
    // `D` too, so a substring check would pass with the generic 🪟 fallback in place).
    expect(tiles[0].querySelector("div")?.textContent?.trim()).toBe("D");
    expect(container.textContent).not.toContain(DEMO.id);
  });

  test("the Spaces panel's window list names the store window", async () => {
    const { container } = render(SpacesPanel, { props: {} });
    await waitFor(() => expect(container.textContent).toContain("Demo"));
    expect(container.textContent).not.toContain(DEMO.id);
  });
});
