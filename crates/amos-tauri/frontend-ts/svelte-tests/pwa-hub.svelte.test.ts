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
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import PwaHubApp from "../src/svelte/PwaHubApp.svelte";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
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

describe("PwaHubApp — 「从网址添加」把 pwa_open_remote 接进屏幕（REQ-A560）", () => {
  test("提交网址：调用宿主、显示宿主回报的名字，并重读索引（新磁贴才算证据）", async () => {
    const fetchSpy = vi.spyOn(pwaIndex, "fetchPwaIndex").mockResolvedValue(okDoc);
    const openSpy = vi
      .spyOn(pwaIndex, "openRemotePwa")
      .mockResolvedValue({ kind: "ok", app: { id: "org.amos.remote", name: "Remote", version: "2.0" } });

    const { findByTestId, getByTestId } = renderHub();
    // The form is present before any index load resolves — an *empty* index is exactly when it
    // matters, so it is not nested inside the "there are apps" branch.
    const input = (await findByTestId("pwa-remote-url")) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "https://apps.example.org/manifest.toml" } });
    await fireEvent.click(getByTestId("pwa-remote-add"));

    expect(openSpy).toHaveBeenCalledWith("https://apps.example.org/manifest.toml");
    const added = await findByTestId("pwa-remote-added");
    expect(added.textContent).toContain("Remote");
    // The initial load + the reload after the successful add.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The field is cleared so the next paste is not appended to the previous URL.
    expect(input.value).toBe("");
  });

  test("宿主拒绝：显示宿主自己的那句话，并保留用户输入以便修正", async () => {
    vi.spyOn(pwaIndex, "fetchPwaIndex").mockResolvedValue(okDoc);
    vi.spyOn(pwaIndex, "openRemotePwa").mockResolvedValue({
      kind: "failed",
      reason: "refused",
      detail: "no remote PWA host is allow-listed: set AMOS_PWA_REMOTE_ALLOW",
    });

    const { findByTestId, getByTestId } = renderHub();
    const input = (await findByTestId("pwa-remote-url")) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "https://evil.example/m.toml" } });
    await fireEvent.click(getByTestId("pwa-remote-add"));

    const error = await findByTestId("pwa-remote-error");
    const detail = await findByTestId("pwa-remote-detail");
    expect(error.textContent).not.toBe(""); // a translated reason, never blank
    expect(detail.textContent).toContain("AMOS_PWA_REMOTE_ALLOW");
    expect(input.value).toBe("https://evil.example/m.toml");
  });
});

