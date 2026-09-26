/**
 * dock-item-menu-scope.svelte.test.ts — which Dock tiles get an **app context menu** (REQ-A1124).
 *
 * The Dock's system tiles are drawn by the module registry (`shellModules.ts`). Only one of
 * them names an application: `dock-finder` carries `windowLabel: "files"`, while
 * `dock-launchpad` and `dock-trash` carry none — so `Dock.openItemMenu` falls back to the
 * **module id** as the menu's label.
 *
 * That label is not inert. `DockContextMenu`'s 「打开」 row called `wm_open(label)`, and the
 * host does **not** check the label against the app registry: `WmState::open` parses it,
 * registers a window and builds a real `WebviewWindow` (wm.rs:1271 / :1815). Right-clicking
 * Launchpad therefore opened a window for an application that does not exist — the exact harm
 * the sibling 「新建窗口」 row is guarded against (its comment says so, and its own test at
 * `dock-context-menu.svelte.test.ts` pins it).
 *
 * Two halves are pinned here: a tile that names **no** app offers no app menu at all, and a
 * tile that names one still does (the boundary — otherwise "no menu" is indistinguishable
 * from a deleted feature).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Dock from "../src/svelte/Dock.svelte";
import { LAYOUT_KEY, writeStoreValue, type HomeLayout } from "../src/lib/amosStore";

let calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return null;
    },
    listen: async () => () => {},
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

const SEEDED: HomeLayout = { page: [], dock: ["phone", "clock", "notes", "files"], hidden: [] };

const tile = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLElement>(`[data-dock-item="${id}"]`)!;
const menu = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="dock-context-menu"]');

beforeEach(() => {
  window.localStorage.clear();
  calls = [];
  installHost();
  writeStoreValue(LAYOUT_KEY, SEEDED);
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("Dock — an app menu only for a tile that names an app (REQ-A1124)", () => {
  test("right-clicking Launchpad (a module id, not an app) opens no menu", async () => {
    const { container } = render(Dock);
    await tick();
    await settle();

    await fireEvent.contextMenu(tile(container, "dock-launchpad"));
    await tick();

    expect(menu(container), "Launchpad names no app — it must offer no app menu").toBeNull();
    // And no row anywhere in this menu could have fabricated a window.
    expect(container.querySelector('[data-testid="dock-ctx-open"]')).toBeNull();
  });

  test("right-clicking Trash opens no app menu either", async () => {
    const { container } = render(Dock);
    await tick();
    await settle();

    await fireEvent.contextMenu(tile(container, "dock-trash"));
    await tick();

    expect(menu(container)).toBeNull();
    expect(container.querySelector('[data-testid="dock-ctx-open"]')).toBeNull();
  });

  test("right-clicking Finder still opens the menu, labelled with its app (the boundary)", async () => {
    const { container } = render(Dock);
    await tick();
    await settle();

    await fireEvent.contextMenu(tile(container, "dock-finder"));
    await tick();

    const m = menu(container);
    expect(m, "the Finder tile names an app — its menu must still open").not.toBeNull();
    // `dock-finder` carries `windowLabel: "files"`, and that is what the menu acts on.
    expect(m!.getAttribute("data-label")).toBe("files");
  });

  test("right-clicking a user app still opens the menu for that app", async () => {
    const { container } = render(Dock);
    await tick();
    await settle();

    await fireEvent.contextMenu(tile(container, "notes"));
    await tick();

    expect(menu(container)?.getAttribute("data-label")).toBe("notes");
  });
});
