/**
 * REQ-A790 (Dock half) — the Dock's 「打开偏好设置」 row, end to end.
 *
 * The Settings half lives in `settings-page-intent.svelte.test.ts`; this is the other end of the
 * same wire, and it exists because **no test covered this row at all**. That is exactly the gap
 * F-SH-001 is about: the row has been rewritten twice (REQ-A415: it used to be `openApp("settings",
 * "dock")`, the *touch* shell's surface switcher, which `Shell.svelte` never renders in the desktop
 * form — a silent no-op) and both times the fix was verified by reading the code. A row that is
 * announced as working and does nothing is the defect; a test that only asserts "Settings opened"
 * cannot tell it apart from a row that opens Settings at the wrong place.
 *
 * So the properties pinned here are the three a reader of the row would assume:
 *   1. it **opens the Settings window** (`wm_open("settings")`, create-or-focus) — not a
 *      surface switch, which is what the row used to do and what does nothing on the desktop;
 *   2. it lands on the **Dock pane**, i.e. the intent is in the store *before* the window is
 *      opened (the window is created after, and seeds itself from the store at mount);
 *   3. when that intent could not be recorded it **says so** instead of opening Settings at its
 *      index and letting the user believe this is the page they asked for.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { isBootFact } from "./shellHostBootFacts";
import Dock from "../src/svelte/Dock.svelte";
import { LAYOUT_KEY, readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_PAGE_KEY } from "../src/lib/settingsPages";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const DESKTOP_SNAPSHOT = {
  screen_w: 1600,
  screen_h: 900,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
};

/** The minimal host the Dock needs: a layout snapshot, a window list, and `wm_open`. */
function installHost() {
  const calls: { cmd: string; args: unknown }[] = [];
  /**
   * What the store held at the instant `wm_open` was invoked. This is the only honest way to
   * test the write-then-open order from outside: checking the store *after* the click cannot
   * distinguish "written first" from "written after", and only the former works on a first click.
   */
  const atOpen: unknown[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      if (!isBootFact(cmd)) calls.push({ cmd, args });
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      if (cmd === "desktop_features_disabled") return [];
      // `lib/wm.ts` reports success as `result !== null`, so a fake host must answer the
      // window mutations with an object — `null` reads as a refusal (REQ-A415).
      if (cmd === "wm_open" || cmd === "wm_close" || cmd === "wm_hide" || cmd === "wm_focus") {
        if ((args as { label?: string })?.label === "settings") atOpen.push(readStoreValue(SETTINGS_PAGE_KEY, null));
        return { windows: [] };
      }
      return null;
    },
    listen: async () => () => {},
  };
  return { calls, atOpen };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 40));
const pending = () => readStoreValue<unknown>(SETTINGS_PAGE_KEY, null);

/** Right-click the dock's empty background and press 「打开偏好设置」. */
async function clickOpenPreferences(setWindowWidth: (w: number) => void, failWrites = false) {
  setWindowWidth(2000);
  writeStoreValue(LAYOUT_KEY, { page: [], dock: ["notes"], hidden: [] });
  const { calls, atOpen } = installHost();
  const restore = failWrites ? failWritesFor(SETTINGS_PAGE_KEY) : () => {};
  try {
    const { container } = render(Dock);
    await tick();
    await settle();
    const panel = container.querySelector<HTMLElement>('[data-testid="dock-panel"]')!;
    await fireEvent.contextMenu(panel, { clientX: 5, clientY: 5 });
    await tick();
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="dock-global-ctx-open-prefs"]',
    )!;
    expect(row, "the Dock background menu must have an 打开偏好设置 row").toBeTruthy();
    await fireEvent.click(row);
    await tick();
    await settle();
    return { container, calls, atOpen };
  } finally {
    restore();
  }
}

/** Swap in a storage whose writes of `key` throw, as a full quota does. */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

const originalInnerWidth = window.innerWidth;
const setWindowWidth = (w: number) =>
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true });

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  setWindowWidth(originalInnerWidth);
  setLocale("zh");
});

describe("Dock.svelte — 「打开偏好设置」 opens the Settings window on the Dock pane (REQ-A790)", () => {
  test("it opens the Settings WINDOW — the host gets `wm_open('settings')`", async () => {
    // The pre-REQ-A415 row called `openApp("settings", "dock")`, the touch shell's surface
    // switcher, which the desktop form never renders: the row did nothing at all. A test that
    // asserted only "no throw" would have passed that row.
    const { calls } = await clickOpenPreferences(setWindowWidth);
    const opened = calls.filter((c) => c.cmd === "wm_open").map((c) => (c.args as { label?: string }).label);
    expect(opened).toContain("settings");
  });

  test("it records the destination BEFORE opening, so the new window seeds itself onto the Dock pane", async () => {
    // `wm_open` is create-or-focus: on the first click there is no Settings window to receive a
    // broadcast, so the intent has to be in the store first and is only ever read at mount. The
    // write order is therefore the whole mechanism, not an implementation detail — asserting only
    // that the store holds a value after the click would pass an open-then-write version that is
    // broken on every *first* click.
    const { atOpen } = await clickOpenPreferences(setWindowWidth);
    // The host saw the destination already in the store at the moment it was asked to open the
    // window — which is the property, stated directly.
    expect(atOpen).toEqual([{ page: "dock", nonce: expect.any(Number) }]);
  });

  test("a refused write is REPORTED and the window is NOT opened onto the wrong page", async () => {
    // The one failure the row must not paper over: Settings opens, lands on its index, and the
    // user reads that as "this is the Dock pane I asked for". If the destination could not be
    // recorded, opening Settings anyway is a claim the row cannot keep — so it does not open.
    const { container, calls } = await clickOpenPreferences(setWindowWidth, true);
    expect(container.querySelector('[data-testid="store-write-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="store-write-error"]')!.textContent).toContain(
      zh["common.storeWriteFailed"],
    );
    expect(calls.filter((c) => c.cmd === "wm_open")).toEqual([]);
    expect(pending()).toBeNull();
  });
});
