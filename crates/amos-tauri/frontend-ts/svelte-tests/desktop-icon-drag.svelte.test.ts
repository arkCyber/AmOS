/**
 * desktop-icon-drag.svelte.test.ts — dragging a **selected** desktop icon reorders the page.
 *
 * Why this file exists (it is written against a defect, not as a spare assertion):
 *
 * `DesktopStage.svelte` has a complete move-drag implementation — `onIconMouseDown` builds
 * `drag = { kind: "move", … }`, `onWindowMouseMove` computes the drop target, and
 * `onWindowMouseUp` calls `moveBefore` and re-saves the layout. `onWindowMouseUp`'s own
 * comment even anticipates the follow-up click (`dragJustEnded`). And yet the *first* step
 * of that path could never be taken: the stage's backdrop handler (`onStageMouseDown`) is
 * on an **ancestor** of every icon, `onIconMouseDown` never stopped the event, so a
 * mousedown on an icon started the move-drag and then immediately bubbled up to the
 * backdrop, which overwrote it with a rubber-band and cleared `selectedIds`. Pressing a
 * selected icon therefore deselected it instead of picking it up, and icons could never be
 * reordered by dragging.
 *
 * The case below drives the real pointer sequence (mousedown on the icon → mousemove to a
 * neighbour → mouseup on the window) and asserts both halves of that promise: the
 * selection survives the mousedown, and the drop lands in the layout.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import { LAYOUT_KEY, readStoreValue, writeStoreValue, type HomeLayout } from "../src/lib/amosStore";

const settle = () => new Promise((r) => setTimeout(r, 40));

const SNAPSHOT = {
  screen_w: 1496,
  screen_h: 882,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
};

/** The two wm reads the desktop shell makes at mount. */
function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "wm_layout_snapshot") return SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      return null;
    },
    listen: async () => () => {},
  };
}

const page = (): string[] => readStoreValue<HomeLayout | null>(LAYOUT_KEY, null)?.page ?? [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("desktop icon drag", () => {
  test("dragging a selected icon onto a neighbour moves it there and keeps it selected", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, { page: ["clock", "notes", "calendar", "files"], dock: [], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const clock = container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
    const files = container.querySelector<HTMLElement>('[data-desktop-icon-id="files"]')!;

    // Select `clock` first (macOS: a drag moves the selection, so the icon must be in it).
    await fireEvent.click(clock);
    await tick();
    expect(clock.getAttribute("aria-selected")).toBe("true");

    // Pick it up. The stage backdrop must NOT take this mousedown — if it does, the
    // selection is cleared right here and the drag below becomes a rubber-band.
    await fireEvent.mouseDown(clock, { button: 0, clientX: 40, clientY: 40 });
    await tick();
    expect(clock.getAttribute("aria-selected")).toBe("true");

    // Move onto `files` and release. `elementFromPoint` is how the drop target is found.
    vi.spyOn(document, "elementFromPoint").mockReturnValue(files);
    await fireEvent.mouseMove(window, { clientX: 300, clientY: 300 });
    await fireEvent.mouseUp(window, { clientX: 300, clientY: 300 });
    await tick();
    await settle();

    expect(page()).toEqual(["notes", "calendar", "clock", "files"]);
    expect(clock.getAttribute("aria-selected")).toBe("true");
  });
});
