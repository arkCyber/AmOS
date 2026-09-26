/**
 * desktop-shell-trackpad-swipe.svelte.test.ts — the desktop's trackpad gesture layer, end to
 * end (REQ-A1586).
 *
 * What this pins, in the user's language: a **two-finger horizontal swipe** on the desktop
 * surface switches Spaces the same way `⌃←` / `⌃→` does; a **vertical** scroll (and a pinch)
 * does not touch the Spaces at all. The second case is the negative control — the guard that
 * keeps ordinary scrolling from navigating the desktop is the whole reason the classifier
 * exists, and a test that only checks the positive path would pass with the guard removed.
 *
 * The gesture rules live in `lib/trackpad.ts` and are unit-tested there with a synthetic clock;
 * this file only checks the **wiring**: that `DesktopShell` feeds the tracker and routes the
 * answer through the one `stepSpaces` path (so the host sees a real `spaces_switch`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import { resetDesktopFeaturesForTest } from "../src/lib/desktopFeatures";
import { isBootFact } from "./shellHostBootFacts";

const settle = () => new Promise((r) => setTimeout(r, 40));

const DESKTOP_SNAPSHOT = {
  screen_w: 1496,
  screen_h: 882,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
  rail_width: 0,
};

/** A fake host answering the three `spaces_*` reads the swipe path makes, plus the boot facts. */
function installHost(spaceCount: number, active: number) {
  const switches: number[] = [];
  (window as unknown as Record<string, unknown>).__switches = switches;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      if (cmd === "desktop_features_disabled") return [];
      if (cmd === "stage_snapshot") return { enabled: false, on_stage: [], parked: [] };
      if (cmd === "spaces_list") {
        return Array.from({ length: spaceCount }, (_, i) => ({
          id: `space-${i}`,
          name: `Space ${i}`,
          windows: [],
        }));
      }
      if (cmd === "spaces_active") return active;
      if (cmd === "spaces_switch") {
        const index = (args as { index?: number } | undefined)?.index ?? -1;
        switches.push(index);
        return { index, hide_failed: [], show_failed: [] };
      }
      // The boot reads the shell sends once at mount (REQ-A487) are not "a gesture reached
      // the host"; answering them with the real `null` keeps the probe clean.
      if (isBootFact(cmd)) return null;
      return null;
    },
    listen: async () => () => {},
  };
  return switches;
}

/**
 * Dispatch one wheel sample on the desktop root.
 *
 * `ctrlKey` is forced on with `defineProperty` because happy-dom's `WheelEvent` carries the
 * `delta*` members but **not** the `MouseEvent` init members — the constructor ignores it, so a
 * pinch sample would arrive at the component with `ctrlKey: false` and the pinch case would
 * silently test nothing. The production handler reads `e.ctrlKey` exactly as a real browser
 * sets it; only this harness has to assert it.
 */
function wheel(
  root: HTMLElement,
  sample: { deltaX?: number; deltaY?: number; deltaMode?: number; ctrlKey?: boolean },
): void {
  const ev = new WheelEvent("wheel", {
    deltaX: sample.deltaX ?? 0,
    deltaY: sample.deltaY ?? 0,
    deltaMode: sample.deltaMode ?? 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, "ctrlKey", {
    value: sample.ctrlKey ?? false,
    configurable: true,
  });
  root.dispatchEvent(ev);
}

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as unknown as { __switches?: unknown }).__switches;
  resetDesktopFeaturesForTest();
});

describe("DesktopShell.svelte — trackpad swipe between Spaces", () => {
  test("a horizontal swipe asks the host to switch Space, once per gesture", async () => {
    const switches = installHost(3, 0);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const root = container.querySelector('[data-testid="desktop-shell-root"]') as HTMLElement;
    expect(root).toBeTruthy();

    // Three ~50px samples cross the 120px threshold. The trailing 150px is momentum *past*
    // the threshold, and the latch must swallow it (without the latch this fires a second
    // switch — the "several Spaces per flick" bug, pinned by the negative control).
    wheel(root, { deltaX: 50 });
    wheel(root, { deltaX: 50 });
    wheel(root, { deltaX: 50 });
    wheel(root, { deltaX: 150 });
    await settle();

    // Swiping right is "previous": from Space 0 it wraps to the last (index 2).
    expect(switches).toEqual([2]);
  });

  test("a vertical scroll never touches the Spaces (negative control)", async () => {
    const switches = installHost(3, 0);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const root = container.querySelector('[data-testid="desktop-shell-root"]') as HTMLElement;
    for (let i = 0; i < 6; i++) wheel(root, { deltaX: 20, deltaY: 120 });
    await settle();

    expect(switches).toEqual([]);
  });

  test("a trackpad pinch (ctrlKey) never switches Space (negative control)", async () => {
    const switches = installHost(3, 0);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const root = container.querySelector('[data-testid="desktop-shell-root"]') as HTMLElement;
    for (let i = 0; i < 6; i++) wheel(root, { deltaX: 40, ctrlKey: true });
    await settle();

    expect(switches).toEqual([]);
  });
});
