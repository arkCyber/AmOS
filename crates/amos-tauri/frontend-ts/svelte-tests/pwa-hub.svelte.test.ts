/**
 * DOM tests for the Svelte 5 PWA picker (PwaHubApp.svelte).
 *
 * Pure data lives in lib/pwaIndex (covered by its own unit tests). Here we verify
 * the *layout* wiring: the grid column count adapts to the device class
 * (REQ-A293) — phone uses 4 columns, tablet widens to 6, desktop widens to
 * `DESKTOP_MAX_COLS`, and the "no host yet" state falls back to the phone default.
 *
 * The grid itself is fed by `fetchPwaIndex()`; mocking it lets the component
 * render the picker without going through the Tauri bridge.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import PwaHubApp from "../src/svelte/PwaHubApp.svelte";
import { setFormFactor } from "../src/lib/desktopApps";
import { DESKTOP_MAX_COLS } from "../src/lib/formLayout";
import * as pwaIndex from "../src/lib/pwaIndex";

// `fetchPwaIndex` is the only side-channel PwaHubApp uses to fetch the index;
// stub it out so the tests never reach into the real bridge or filesystem.
//
// The fixture is a *minimally-valid* PwaEntry: every field the UI touches
// (display.url, display.icon) must be present, otherwise `iconFor`/`pwaEntryIconUrl`
// blows up inside the component and vitest surfaces it as an uncaught exception
// (the layout tests cannot see the column count they care about).
const okDoc = {
  kind: "ok" as const,
  doc: {
    apps: [
      {
        id: "a",
        name: "A",
        version: "1.0",
        description: "",
        display: { url: "https://a.example", icon: null, mode: "standalone", orientation: "portrait", themeColor: null },
        mcpTools: [],
        allowedDomains: [],
      },
      {
        id: "b",
        name: "B",
        version: "1.0",
        description: "",
        display: { url: "https://b.example", icon: null, mode: "standalone", orientation: "portrait", themeColor: null },
        mcpTools: [],
        allowedDomains: [],
      },
    ],
  },
};

afterEach(() => {
  cleanup();
  setFormFactor(null);
  vi.restoreAllMocks();
});

function renderHub() {
  return render(PwaHubApp);
}

/** Extract the grid-node's column count from its inline `grid-template-columns`. */
function colCount(node: HTMLElement | null): number | null {
  if (!node) return null;
  const style = node.getAttribute("style") ?? "";
  // Either "grid-template-columns: repeat(6, minmax(0, 1fr));" or the Tailwind
  // fallback the test environment may produce; we read the `repeat(N, ...)` form.
  const m = style.match(/repeat\((\d+),\s*minmax/);
  return m ? Number(m[1]) : null;
}

describe("PwaHubApp — grid column count adapts to the device class (REQ-A293)", () => {
  test("with no host answering (no form factor set), the picker falls back to the phone's 4 columns", async () => {
    vi.spyOn(pwaIndex, "fetchPwaIndex").mockResolvedValue(okDoc);
    const { findByTestId } = renderHub();
    const grid = await findByTestId("pwa-grid");
    expect(colCount(grid as HTMLElement)).toBe(4);
  });

  test("phone keeps the iOS-picker 4-column density", async () => {
    vi.spyOn(pwaIndex, "fetchPwaIndex").mockResolvedValue(okDoc);
    setFormFactor("phone");
    const { findByTestId } = renderHub();
    const grid = await findByTestId("pwa-grid");
    expect(colCount(grid as HTMLElement)).toBe(4);
  });

  test("tablet widens to 6 columns (iPadOS picker density)", async () => {
    vi.spyOn(pwaIndex, "fetchPwaIndex").mockResolvedValue(okDoc);
    setFormFactor("tablet");
    const { findByTestId } = renderHub();
    const grid = await findByTestId("pwa-grid");
    expect(colCount(grid as HTMLElement)).toBe(6);
  });

  test("desktop widens to DESKTOP_MAX_COLS (the launcher cap, not a hand-picked number)", async () => {
    vi.spyOn(pwaIndex, "fetchPwaIndex").mockResolvedValue(okDoc);
    setFormFactor("desktop");
    const { findByTestId } = renderHub();
    const grid = await findByTestId("pwa-grid");
    expect(colCount(grid as HTMLElement)).toBe(DESKTOP_MAX_COLS);
  });

  test("robot has no UI, so the picker falls back to the phone default (4)", async () => {
    vi.spyOn(pwaIndex, "fetchPwaIndex").mockResolvedValue(okDoc);
    setFormFactor("robot");
    const { findByTestId } = renderHub();
    const grid = await findByTestId("pwa-grid");
    expect(colCount(grid as HTMLElement)).toBe(4);
  });
});
