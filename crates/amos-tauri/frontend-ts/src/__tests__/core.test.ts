import { describe, expect, test } from "bun:test";
import {
  defaultLayout,
  getLayout,
  getRecents,
  hideFromHome,
  pushRecent,
  restoreToHome,
  moveBefore,
  type HomeLayout,
} from "../lib/amosStore";
import { APPS, appIcon, appTitleKey } from "../apps";
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";

/** Point `window` at a Map-backed localStorage for store round-trips. */
function withStorage(store: Map<string, string>) {
  (globalThis as unknown as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  };
}

describe("core shell", () => {
  test("default layout puts known dock apps on the dock, the rest on a page", () => {
    const l = defaultLayout(["settings", "clock", "ai", "camera"]);
    expect(l.dock).toEqual(["camera", "settings", "ai"]);
    expect(l.page).toEqual(["clock"]);
    expect(l.hidden).toEqual([]);
  });

  test("every ported app has a title key translated in both locales", () => {
    expect(APPS.length).toBeGreaterThan(0);
    for (const a of APPS) {
      const key = appTitleKey(a.id);
      expect(key).not.toBeNull();
      expect(zh[key!]).toBeTruthy();
      expect(en[key!]).toBeTruthy();
    }
  });

  test("every app has a single source of truth for its dock icon (no drift)", () => {
    expect(APPS.length).toBeGreaterThan(0);
    for (const a of APPS) {
      const icon = appIcon(a.id);
      expect(icon).toBeTruthy();
      expect(icon).not.toBe("🧩"); // registered apps must declare a real icon
    }
    expect(appIcon("nope")).toBe("🧩"); // unknown ids still fall back safely
  });

  test("hideFromHome/restoreToHome edit the layout", () => {
    const l = defaultLayout(["a", "b", "c"]);
    const h1 = hideFromHome(l, "a"); // page -> hidden
    expect(h1.page).toEqual(["b", "c"]);
    expect(h1.hidden).toEqual(["a"]);
    const h2 = hideFromHome(h1, "b"); // page -> hidden
    expect(h2.page).toEqual(["c"]);
    expect(h2.hidden).toEqual(["a", "b"]);
    const restored = restoreToHome(h2, "a");
    expect(restored.page).toEqual(["c", "a"]);
    expect(restored.hidden).toEqual(["b"]);
  });

  test("moveBefore reorders within and across lists", () => {
    let l: HomeLayout = { page: ["a", "b", "c"], dock: ["d"], hidden: [] };
    l = moveBefore(l, "c", "a"); // page reorder -> c before a
    expect(l.page).toEqual(["c", "a", "b"]);
    l = moveBefore(l, "c", "d"); // cross-list into dock before d
    expect(l.page).toEqual(["a", "b"]);
    expect(l.dock).toEqual(["c", "d"]);
  });

  test("hiding a dock icon moves it back to the page (never hidden)", () => {
    const l: HomeLayout = { page: [], dock: ["a", "b"], hidden: [] };
    const h = hideFromHome(l, "a");
    expect(h.dock).toEqual(["b"]);
    expect(h.page).toEqual(["a"]);
    expect(h.hidden).toEqual([]);
  });

  test("moveBefore dragging from the dock back onto the page works", () => {
    const l: HomeLayout = { page: ["x"], dock: ["a", "b"], hidden: [] };
    const out = moveBefore(l, "a", "x"); // a before x on the page
    expect(out.dock).toEqual(["b"]);
    expect(out.page).toEqual(["a", "x"]);
  });

  test("getLayout falls back to default and repairs/merges stored layout", () => {
    const store = new Map<string, string>();
    withStorage(store);
    // nothing stored -> default dock
    expect(getLayout(["settings", "clock", "ai", "camera"]).dock).toEqual([
      "camera",
      "settings",
      "ai",
    ]);
    // stored layout: unknown id is dropped; new available ids are appended to page
    store.set(
      "amos.home.layout",
      JSON.stringify({ page: ["clock", "ghost"], dock: ["camera"], hidden: [] }),
    );
    const l = getLayout(["settings", "clock", "ai", "camera"]);
    expect(l.page).toEqual(["clock", "settings", "ai"]);
    expect(l.dock).toEqual(["camera"]);
    expect(l.hidden).toEqual([]);
  });

  test("pushRecent/getRecents dedupe and cap at 8", () => {
    const store = new Map<string, string>();
    withStorage(store);
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) pushRecent(id);
    const rec = getRecents();
    expect(rec.length).toBe(8);
    expect(rec[0]).toBe("i");
    pushRecent("a"); // re-opened app moves to front (dedup)
    expect(getRecents()[0]).toBe("a");
  });
});
