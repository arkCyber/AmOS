/**
 * DOM tests for the **dock** widgets (REQ-A262) — the dock's half of the container split.
 *
 * `Dock.svelte` used to hard-code its three system items (Launchpad / Finder / Trash) and
 * their glyphs, labels and handlers inside its own template; the app tiles and the system
 * tiles were two different implementations of the same 56 px glass square. Now each tile
 * is a widget with a test of its own, `DockTileButton` is the one implementation they
 * share, and the container only does layout (order, capacity, magnification, the running
 * dot).
 *
 * What this file pins, and why each is a contract rather than taste:
 *   • every tile has a name and a tooltip, and carries the shared dock look
 *     (`lib/shellChrome.ts`) — the drift this round removed;
 *   • the **Trash** is disabled and says why. Its handler used to be
 *     `if (id === "trash") return;` — a tile that looks pressable, is announced as
 *     pressable, and does nothing (FMEA F-SH-001).
 *   • the Finder tile opens the real window (`wm_open`), and the app tiles pass their own
 *     id — no "open or focus?" decision in the frontend (`wm_open` is create + focus).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DockAppItem from "../src/svelte/modules/DockAppItem.svelte";
import DockFinderItem from "../src/svelte/modules/DockFinderItem.svelte";
import DockLaunchpadItem from "../src/svelte/modules/DockLaunchpadItem.svelte";
import DockTrashItem from "../src/svelte/modules/DockTrashItem.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { DOCK_ITEM_TILE } from "../src/lib/shellChrome";
import { zh } from "../src/i18n/locales/zh";

afterEach(cleanup);
afterEach(() => setLocale("zh"));
beforeEach(() => window.localStorage.clear());

/** A fake host, so the tiles' `wm_open` calls can be observed. */
function installHost(): string[] {
  const commands: string[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      commands.push(cmd);
      return null;
    },
    listen: async () => () => {},
  };
  return commands;
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("dock widgets (mounted alone)", () => {
  test("the shared dock tile is the one implementation the tiles use", () => {
    // Pinned against the **live** `DOCK_ITEM_TILE` constant — the test used to
    // assert `rounded-2xl` + `active:scale-90`, but the token is now
    // `rounded-[16px]` + `active:scale-85` (matches macOS measurements: 16px
    // ≈ 1/3 of the icon, scale(0.85) is what UIKit uses). Both are kept here
    // so a future rename does not silently desync the visible widget from
    // the shared token.
    for (const cls of ["rounded-[16px]", "shadow-xl", "active:scale-85", "flex"]) {
      expect(DOCK_ITEM_TILE, `the token must carry ${cls}`).toContain(cls);
    }
  });

  test("the Launchpad tile is named, hinted and asks the shell (no handle ⇒ it is quiet)", async () => {
    const { container } = render(DockLaunchpadItem);
    await tick();
    const tile = container.querySelector<HTMLButtonElement>('[data-testid="dock-launchpad"]')!;
    expect(tile.getAttribute("aria-label")).toBe(zh["desktop.launchpad"]);
    expect(tile.textContent).toBe("🚀");
    expect(tile.className).toContain("rounded-[16px]");
    // Mounted outside a shell there is no handle: the tile must do nothing, not throw.
    await fireEvent.click(tile);
    expect(tile.disabled).toBe(false);
  });

  test("the Finder tile opens the real window through wm_open", async () => {
    const commands = installHost();
    const { container } = render(DockFinderItem);
    await tick();
    const tile = container.querySelector<HTMLButtonElement>('[data-testid="dock-finder"]')!;
    expect(tile.getAttribute("aria-label")).toBe(zh["desktop.finder"]);
    await fireEvent.click(tile);
    expect(commands).toContain("wm_open");
  });

  test("the Trash is disabled and says why (an inert control would be worse)", async () => {
    const { container } = render(DockTrashItem);
    await tick();
    const tile = container.querySelector<HTMLButtonElement>('[data-testid="dock-trash"]')!;
    expect(tile.disabled).toBe(true);
    expect(tile.getAttribute("aria-disabled")).toBe("true");
    expect(tile.getAttribute("aria-label")).toBe(zh["desktop.trashUnavailable"]);
    expect(tile.getAttribute("aria-label")).toContain("尚未接入");
    // Dimmed rather than invisible: the slot is still part of the dock's shape.
    expect(tile.className).toContain("opacity-40");
  });

  test("an app tile is named with its translated label and opens its own id", async () => {
    const commands = installHost();
    const { container } = render(DockAppItem, {
      props: { id: "notes", icon: "📝", label: zh["app.notes"] },
    });
    await tick();
    const tile = container.querySelector<HTMLButtonElement>('[data-testid="dock-app-notes"]')!;
    expect(tile.getAttribute("aria-label")).toBe(zh["app.notes"]);
    expect(tile.getAttribute("title")).toBe(zh["app.notes"]);
    expect(tile.textContent).toBe("📝");
    await fireEvent.click(tile);
    expect(commands).toContain("wm_open");
  });
});
