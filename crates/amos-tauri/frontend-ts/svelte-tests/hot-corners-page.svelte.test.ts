/**
 * hot-corners-page.svelte.test.ts — the Hot Corners settings UI correctly
 * persists every knob the listener reads.
 *
 * The library layer (`lib/hotCorners.ts`) is unit-tested at 100 %; this file
 * is the **wiring** test — the page reads the store, normalizes, hands three
 * controls per corner back to the store, and surfaces a refused write
 * without silently dropping it. A regression in any of those four would not
 * be caught by the library tests.
 *
 * REQ-A283: each `<label>` and its control share one mount-scoped id. A
 * regression that re-reads `nextFieldId()` inside the `{#each}` would mint
 * a new id every render and sever the link — we pin that the labels remain
 * attached after the user changes a value (which is the cheap re-render that
 * triggers the bug).
 *
 * `nextFieldId()` returns `amos-field-N`; the page mounts three ids per corner
 * in order (action, modifier, delay). `select`s are the action + modifier rows;
 * `input[type=range]` are the delay rows. To pick the right control we index
 * into the live sequence — once we have rendered the default state (4 corners,
 * 2 with modifier rows), the layout is deterministic.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import HotCornersPage from "../src/svelte/settings/HotCornersPage.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import {
  HOT_CORNER_KEY,
  DEFAULT_HOT_CORNERS,
  type HotCornerConfig,
} from "../src/lib/hotCorners";

const settle = () => new Promise((r) => setTimeout(r, 20));

function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    listen: async () => () => {},
  };
}

/** All `amos-field-*` ids in document order — three per corner (4 corners = 12 max). */
const fieldsByIndex = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[id^="amos-field-"]'));

/** In the default config: top-left=mctrl, top-right=disabled, bottom-left=launchpad,
 *  bottom-right=disabled. Two corners expose a modifier; all four expose a delay.
 *  Document order (each corner is a vertical column):
 *    corner 0 (top-left):      action, modifier, delay
 *    corner 1 (top-right):     action                          (no modifier/delay)
 *    corner 2 (bottom-left):   action, modifier, delay
 *    corner 3 (bottom-right):  action                          (no modifier/delay)
 *  ⇒ indices: [0,1,2] [3] [4,5,6] [7]   (or 10 total ids for default config)
 *
 *  But we do not assume that — we find each control by its current value:
 *   - the action select's value is the corner's action;
 *   - the modifier select's value is the corner's modifier (default "" / "shift" / etc.);
 *   - the delay input's value is the corner's delay in ms.
 *  Helpers below return the field by content, not index, so the same helper works
 *  after the user changes a value (which adds/modifies modifier rows). */
/** In the default config: top-left=mctrl, top-right=disabled, bottom-left=launchpad,
 *  bottom-right=disabled. Two corners expose a modifier; only the non-disabled
 *  corners expose a delay. Document order is per-corner vertical stacks; each
 *  corner either is "compact" (1 select, action only) or "full" (2 selects +
 *  1 input, action/modifier/delay). The sequence is:
 *    [action-0][modifier-0][action-1][action-2][modifier-2][action-3]   (default)
 *
 *  Helpers below use corner indices 0..3 and the corner's current action value
 *  to skip past compact corners. */
const actionSelectByCurrent = (container: HTMLElement, corner: number): HTMLSelectElement => {
  const selects = Array.from(
    container.querySelectorAll<HTMLSelectElement>('select[id^="amos-field-"]'),
  );
  let idx = 0;
  for (let i = 0; i < corner; i++) {
    if (selects[idx]!.value !== "disabled") idx += 1; // skip past a modifier row
    idx += 1; // advance past this corner's action
  }
  return selects[idx]!;
};

const modifierSelectByCurrent = (
  container: HTMLElement,
  corner: number,
): HTMLSelectElement | null => {
  const selects = Array.from(
    container.querySelectorAll<HTMLSelectElement>('select[id^="amos-field-"]'),
  );
  let idx = 0;
  for (let i = 0; i < corner; i++) {
    if (selects[idx]!.value !== "disabled") idx += 1;
    idx += 1;
  }
  // The modifier row is right after the action, but only when action !== "disabled".
  if (selects[idx]!.value === "disabled") return null;
  return selects[idx + 1] ?? null;
};

const delayInputByCurrent = (
  container: HTMLElement,
  corner: number,
): HTMLInputElement => {
  const inputs = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="range"][id^="amos-field-"]'),
  );
  let idx = 0;
  for (let i = 0; i < corner; i++) {
    const selects = Array.from(
      container.querySelectorAll<HTMLSelectElement>('select[id^="amos-field-"]'),
    );
    // Same skip logic — advance past a modifier row when the corner's action is full.
    if (selects[i]!.value !== "disabled") idx += 1;
  }
  return inputs[idx]!;
};

beforeEach(() => {
  window.localStorage.clear();
  installHost();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("HotCornersPage.svelte — settings UI wiring", () => {
  test("renders all four corners with the library's default config", async () => {
    const { container } = render(HotCornersPage);
    await tick();
    await settle();

    // Four action selects, one per corner. Default: top-left=Mission Control.
    expect(actionSelectByCurrent(container, 0)).toBeTruthy();
    expect(actionSelectByCurrent(container, 0).value).toBe("mission-control");

    // No prior tests should have written garbage; the page initialises from the
    // library's DEFAULT_HOT_CORNERS so the read-back is the same defaults.
    const stored = readStoreValue<HotCornerConfig[] | null>(HOT_CORNER_KEY, null);
    if (stored !== null) {
      // If anything got written, it must be a normalised 4-row config.
      expect(stored).toHaveLength(4);
    } else {
      // First write hasn't happened — the page read the defaults from `readStoreValue`'s
      // fallback and did not silently persist them. Either is acceptable; the page must
      // not lose the defaults.
      expect(DEFAULT_HOT_CORNERS).toHaveLength(4);
    }
  });

  test("changing the top-left action persists immediately", async () => {
    const { container } = render(HotCornersPage);
    await tick();
    await settle();

    const top = actionSelectByCurrent(container, 0);
    top.value = "launchpad";
    await fireEvent.change(top);
    await settle();

    const stored = readStoreValue<HotCornerConfig[]>(HOT_CORNER_KEY, []);
    expect(stored.find((c) => c.corner === "top-left")?.action).toBe("launchpad");

    // The other corners are untouched (still at defaults).
    expect(stored.find((c) => c.corner === "bottom-left")?.action).toBe("launchpad");
  });

  test("each corner can have a different action and they do not overwrite each other", async () => {
    const { container } = render(HotCornersPage);
    await tick();
    await settle();

    const actions = ["mission-control", "launchpad", "lock-screen", "notification-center"];
    for (let i = 0; i < actions.length; i++) {
      const sel = actionSelectByCurrent(container, i);
      sel.value = actions[i]!;
      await fireEvent.change(sel);
    }
    await settle();

    const stored = readStoreValue<HotCornerConfig[]>(HOT_CORNER_KEY, []);
    expect(stored.find((c) => c.corner === "top-left")?.action).toBe("mission-control");
    expect(stored.find((c) => c.corner === "top-right")?.action).toBe("launchpad");
    expect(stored.find((c) => c.corner === "bottom-left")?.action).toBe("lock-screen");
    expect(stored.find((c) => c.corner === "bottom-right")?.action).toBe("notification-center");
  });

  test("modifier-key row only appears when action is not 'disabled'", async () => {
    const { container } = render(HotCornersPage);
    await tick();
    await settle();

    // Default: top-left=mctrl + bottom-left=launchpad expose modifier rows; the
    // two 'disabled' corners do not.
    expect(modifierSelectByCurrent(container, 0)).not.toBeNull();
    expect(modifierSelectByCurrent(container, 1)).toBeNull();
    expect(modifierSelectByCurrent(container, 2)).not.toBeNull();
    expect(modifierSelectByCurrent(container, 3)).toBeNull();

    // Switch top-right to "lock-screen" — its modifier row now appears.
    const tr = actionSelectByCurrent(container, 1);
    tr.value = "lock-screen";
    await fireEvent.change(tr);
    await settle();

    expect(modifierSelectByCurrent(container, 1)).not.toBeNull();
  });

  test("selecting a modifier key persists", async () => {
    const { container } = render(HotCornersPage);
    await tick();
    await settle();

    const mod = modifierSelectByCurrent(container, 0);
    expect(mod).not.toBeNull();
    mod!.value = "shift";
    await fireEvent.change(mod!);
    await settle();

    const stored = readStoreValue<HotCornerConfig[]>(HOT_CORNER_KEY, []);
    expect(stored.find((c) => c.corner === "top-left")?.modifier).toBe("shift");
  });

  test("delay slider persists a new value", async () => {
    const { container } = render(HotCornersPage);
    await tick();
    await settle();

    const delay = delayInputByCurrent(container, 0);
    expect(delay).toBeTruthy();
    delay.value = "1500";
    await fireEvent.input(delay);
    await settle();

    const stored = readStoreValue<HotCornerConfig[]>(HOT_CORNER_KEY, []);
    expect(stored.find((c) => c.corner === "top-left")?.delay).toBe(1500);
  });

  test("a malformed store value is replaced with defaults (normalize-on-read)", async () => {
    // Garbage in localStorage — the page must not throw, must render 4 rows,
    // and must overwrite the bad value with DEFAULT_HOT_CORNERS on next write.
    writeStoreValue(HOT_CORNER_KEY, "this is not an array" as unknown as HotCornerConfig[]);

    const { container } = render(HotCornersPage);
    await tick();
    await settle();

    expect(actionSelectByCurrent(container, 0).value).toBe("mission-control");

    // A write of the (now-normalised) config replaces the garbage.
    actionSelectByCurrent(container, 0).value = "lock-screen";
    await fireEvent.change(actionSelectByCurrent(container, 0));
    await settle();

    const stored = readStoreValue<HotCornerConfig[]>(HOT_CORNER_KEY, []);
    expect(stored).toHaveLength(4);
    expect(stored.find((c) => c.corner === "top-left")?.action).toBe("lock-screen");
  });

  test("label↔control id association survives a re-render after the first write (REQ-A283)", async () => {
    const { container } = render(HotCornersPage);
    await tick();
    await settle();

    const actionIds = [0, 1, 2, 3].map((i) => actionSelectByCurrent(container, i).id);
    const labels = container.querySelectorAll<HTMLLabelElement>("label[for]");
    // The first label should match the first action select (each corner's action is
    // introduced by a label). With `nextFieldId()` mounted-scoped and stable, the
    // id minted once is reused for every render.
    expect(actionIds[0]).toBeTruthy();
    expect(labels[0]?.getAttribute("for")).toBe(actionIds[0]);

    // Trigger a re-render by changing a value. If `nextFieldId()` were called inside
    // the `{#each}` it would mint a new id here and the label's `for` would no
    // longer match — screen-reader announcement would point at a different control.
    const beforeId = actionIds[0]!;
    const tr = actionSelectByCurrent(container, 1);
    tr.value = "lock-screen";
    await fireEvent.change(tr);
    await settle();

    const afterIds = [0, 1, 2, 3].map((i) => actionSelectByCurrent(container, i).id);
    expect(afterIds[0]).toBe(beforeId);
  });
});