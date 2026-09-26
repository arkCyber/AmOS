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
 *   • the **Trash** opens Files *on its trash pane* (REQ-A783) — the tile's handler used to be
 *     `if (id === "trash") return;` (FMEA F-SH-001), and the round that greyed it instead did so
 *     on the claim that `wm_open`'s label was the only channel into the target window. It is the
 *     only *window* channel; the pane travels on the shared store, so the tile is live again and
 *     this file pins both halves of the route.
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
import { normalizeViewIntent } from "../src/lib/files";
import { zh } from "../src/i18n/locales/zh";

afterEach(cleanup);
afterEach(() => setLocale("zh"));
beforeEach(() => window.localStorage.clear());

/** A fake host, so the tiles' `wm_open` calls can be observed. */
function installHost(): string[] {
  const commands: string[] = [];
  hostCalls = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: unknown) => {
      commands.push(cmd);
      hostCalls.push({ cmd, args });
      return null;
    },
    listen: async () => () => {},
  };
  return commands;
}

/**
 * Every `invoke` since the last `installHost()`, **with its payload** — the command name alone
 * cannot tell "opened Files" from "opened Notes", and the trash tile's whole contract is *which*
 * window it opens (the view it lands on rides the store, not this call).
 */
let hostCalls: Array<{ cmd: string; args: unknown }> = [];

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
    // The Launchpad tile now uses a vector icon (IconLaunchpad.svelte), not the
    // historical 🚀 glyph — verify the SVG is in the slot rather than text, so
    // a future "fall back to an emoji" doesn't silently desync the tile from
    // the design that replaced the emoji.
    expect(tile.querySelector("svg")).toBeTruthy();
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

  test("the Trash tile opens Files ON ITS TRASH PANE (the label was never the whole channel)", async () => {
    const commands = installHost();
    const { container } = render(DockTrashItem);
    await tick();
    const tile = container.querySelector<HTMLButtonElement>('[data-testid="dock-trash"]')!;

    // Live, and named for what it opens. REQ-A455 shipped the trash and made the old
    // "not wired up yet: there is no trash view" reason untrue; the round after that greyed
    // the tile on a *second* reason — "`wm_open(label)` carries a label and nothing else, so a
    // Dock tile cannot open the trash pane". That is true of `wm_open` and false about the
    // shell: the cross-window intent (REQ-A458) already carries a destination *inside* the
    // target window through the shared store, so the label was never the whole channel.
    //
    // REQ-A783: the tile now does what a trash tile should, and this test pins **both halves**
    // of the two-part route — the window (by label, through the host) and the pane (through
    // the store). Pinning only the first is how the old reasoning survived: opening Files and
    // landing on the user's last view is exactly the "Files opened, not the trash" failure.
    expect(tile.disabled).toBe(false);
    expect(tile.getAttribute("aria-disabled")).not.toBe("true");
    expect(tile.getAttribute("aria-label")).toBe(zh["desktop.trash"]);
    // The new name is no longer a direction. "…（在「文件」里查看）" told the user where to go;
    // on a control that already takes them there, that is a label that contradicts its button.
    expect(tile.getAttribute("aria-label")).not.toContain("里查看");
    // No longer dimmed: nothing about it is unavailable any more.
    expect(tile.className).not.toContain("opacity-40");

    await fireEvent.click(tile);

    expect(commands).toContain("wm_open");
    expect(hostCalls.find((c) => c.cmd === "wm_open")?.args).toEqual({ label: "files" });

    // Pinned against the **literal** key, not the constant: this is the wire name two windows
    // agree on, and a rename has to be a deliberate, visible edit here too.
    const raw = window.localStorage.getItem("amos.files.view");
    expect(raw).toBeTruthy();
    expect(normalizeViewIntent(JSON.parse(raw as string))?.view).toBe("trash");
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
