/**
 * dock-reorder.svelte.test.ts — dragging a dock icon reorders `layout.dock` (REQ-A456).
 *
 * The rule is pure and unit-tested (`lib/amosStore.ts::dockReorderIds` / `reorderVisibleDock`
 * in `src/__tests__/amosStore.test.ts`). What these cases pin is the **wiring**, and each one
 * is a way the feature would be broken while still "looking" right:
 *
 *   • a drag commits (and the default layout's `phone` — which the desktop never draws — is
 *     still in the store afterwards: the write-back must not delete what it cannot show);
 *   • a **click** still opens the app (a drag threshold that is not applied turns every
 *     click into a one-slot reorder or a swallowed gesture);
 *   • system tiles are not drop targets (their order is a product decision, not user data);
 *   • a release outside the dock changes nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Dock from "../src/svelte/Dock.svelte";
import { LAYOUT_KEY, readStoreValue, writeStoreValue, type HomeLayout } from "../src/lib/amosStore";

type Call = { cmd: string; args?: Record<string, unknown> };
let calls: Call[] = [];

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

/** The dock the desktop draws here: `phone` is in the store and never rendered. */
const SEEDED: HomeLayout = { page: [], dock: ["phone", "clock", "notes", "files"], hidden: [] };

const docked = () => readStoreValue<HomeLayout>(LAYOUT_KEY, SEEDED).dock;
const tile = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLElement>(`[data-dock-item="${id}"]`)!;

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

describe("Dock.svelte — drag to reorder (REQ-A456)", () => {
  async function startDrag(c: HTMLElement, id: string, x = 100, y = 600) {
    await fireEvent.mouseDown(tile(c, id), { button: 0, clientX: x, clientY: y });
    // Move past the 4 px threshold: a press-and-wiggle is a drag, not a click.
    await fireEvent.mouseMove(document.body, { clientX: x + 20, clientY: y });
    await tick();
  }

  test("dropping an icon on a neighbour reorders the store — and keeps the hidden `phone`", async () => {
    const { container } = render(Dock);
    await tick();
    await settle();

    await startDrag(container, "notes");
    // …over `clock`, then release.
    await fireEvent.mouseMove(tile(container, "clock"), { clientX: 60, clientY: 600 });
    await tick();
    expect(tile(container, "clock").getAttribute("data-dock-drop-target")).toBe("true");
    await fireEvent.mouseUp(window);
    await tick();

    // `notes` took `clock`'s slot; `phone` kept its own (index 0) — the entry the desktop
    // never draws must survive the write-back, or the phone form loses it.
    expect(docked()).toEqual(["phone", "notes", "clock", "files"]);
    // …and the rendered order followed (the dock subscribes to the store now).
    const rendered = [...container.querySelectorAll("[data-dock-item]")].map((el) =>
      el.getAttribute("data-dock-item"),
    );
    expect(rendered.slice(0, 3)).toEqual(["notes", "clock", "files"]);
  });

  test("a press-and-release without movement is a CLICK: the app opens, nothing reorders", async () => {
    const { container } = render(Dock);
    await tick();
    await settle();

    await fireEvent.mouseDown(tile(container, "notes"), { button: 0, clientX: 100, clientY: 600 });
    await fireEvent.mouseMove(tile(container, "notes"), { clientX: 101, clientY: 601 });
    await fireEvent.mouseUp(window);
    await fireEvent.click(container.querySelector('[data-testid="dock-app-notes"]')!);
    await tick();

    expect(docked()).toEqual(SEEDED.dock);
    expect(calls.some((c) => c.cmd === "wm_open" && c.args?.label === "notes")).toBe(true);
  });

  test("system tiles are not drop targets (launchpad / finder / trash keep their places)", async () => {
    const host = render(Dock);
    const { container } = host;
    await tick();
    await settle();

    await startDrag(container, "notes");
    for (const sys of ["dock-trash", "dock-finder", "dock-launchpad"]) {
      await fireEvent.mouseMove(tile(container, sys), { clientX: 900, clientY: 600 });
      await tick();
      // Nothing is painted as a target while the pointer is over a system item…
      expect(container.querySelectorAll('[data-dock-drop-target="true"]')).toHaveLength(0);
    }
    await fireEvent.mouseUp(window);
    await tick();
    // …and the release changed nothing. Honest note: this outcome is guaranteed by the
    // **pure** layer (`reorderVisibleDock` refuses a hovered id that is not in the dock —
    // see `amosStore.test.ts`), so this case pins the user-visible property, not the
    // container's `dockAppIds` guard (removing that guard does not turn this case red).
    expect(docked()).toEqual(SEEDED.dock);
  });

  test("releasing outside the dock changes nothing", async () => {
    const { container } = render(Dock);
    await tick();
    await settle();

    await startDrag(container, "files");
    await fireEvent.mouseMove(document.body, { clientX: 400, clientY: 100 });
    await fireEvent.mouseUp(window);
    await tick();

    expect(docked()).toEqual(SEEDED.dock);
  });
});