import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  defaultLayout,
  getLayout,
  getRecents,
  hideFromHome,
  pushRecent,
  restoreToHome,
  moveBefore,
  moveWithinHome,
  canMoveWithinHome,
  type HomeLayout,
} from "../lib/amosStore";
import { APP_META as APPS, appIcon, appTitleKey } from "../lib/appMeta";
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

/**
 * pure 批次是一个进程跑所有文件，所以 `window` 桩必须逐用例还原 —— 否则后面的文件
 * （例如 `enterprise-audit.test.ts`）会凭空多出一个可用的 localStorage，走另一条分支。
 */
let realWindow: unknown;
beforeEach(() => {
  realWindow = (globalThis as unknown as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = realWindow;
});

describe("core shell", () => {
  test("default layout puts known dock apps on the dock, the rest on a page", () => {
    const l = defaultLayout(["settings", "clock", "ai", "camera"]);
    expect(l.dock).toEqual(["ai"]); // ai stays docked; camera & settings are page apps
    expect(l.page).toEqual(["settings", "clock", "camera"]);
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

  // REQ-A462: the home editor's ‹ › buttons. The direction-sensitive slot rule is the
  // reason this is not `moveBefore` (which inserts *before* the neighbour in both
  // directions, i.e. moves the icon the wrong way half the time) — the same lesson the
  // dock's reorder learned in REQ-A456.
  test("moveWithinHome moves one slot, and the direction is real", () => {
    const l: HomeLayout = { page: ["a", "b", "c"], dock: ["d"], hidden: [] };
    expect(moveWithinHome(l, "b", -1).page).toEqual(["b", "a", "c"]);
    expect(moveWithinHome(l, "b", 1).page).toEqual(["a", "c", "b"]);
    // …and inside the dock, the same rule
    expect(moveWithinHome({ page: [], dock: ["x", "d"], hidden: [] }, "d", -1).dock).toEqual([
      "d",
      "x",
    ]);
  });

  test("moveWithinHome never changes which list an app belongs to", () => {
    const l: HomeLayout = { page: ["a", "c"], dock: ["d"], hidden: [] };
    // "c" is the last page app. Its "later" neighbour *on screen* would be the dock's
    // "d" — moving there would pin it to the dock, which a reorder button must not do.
    const moved = moveWithinHome(l, "c", 1);
    expect(moved).toBe(l); // same reference: there is nowhere to go
    expect(moved.dock).toEqual(["d"]);
    expect(canMoveWithinHome(l, "c", 1)).toBe(false);
    expect(canMoveWithinHome(l, "c", -1)).toBe(true);
    // the ends of the dock behave the same way
    expect(canMoveWithinHome(l, "d", -1)).toBe(false);
    expect(canMoveWithinHome(l, "d", 1)).toBe(false);
  });

  test("canMoveWithinHome is the UI's disabled state, from the same rule", () => {
    const l: HomeLayout = { page: ["a", "b"], dock: [], hidden: [] };
    expect(canMoveWithinHome(l, "a", -1)).toBe(false);
    expect(canMoveWithinHome(l, "a", 1)).toBe(true);
    expect(canMoveWithinHome(l, "b", 1)).toBe(false);
    // an app the layout does not hold cannot move anywhere
    expect(canMoveWithinHome(l, "zz", 1)).toBe(false);
    expect(moveWithinHome(l, "zz", 1)).toBe(l);
  });

  test("moveWithinHome skips the ids a surface does not show", () => {
    const l: HomeLayout = { page: ["a", "junk", "b"], dock: [], hidden: [] };
    const isShown = (x: string) => x !== "junk";
    // "b" steps past the neighbour the *user can point at* (a), and `junk` keeps its slot
    expect(moveWithinHome(l, "b", -1, isShown).page).toEqual(["b", "junk", "a"]);
    // a hidden-in-this-surface id itself cannot be moved
    expect(moveWithinHome(l, "junk", -1, isShown)).toBe(l);
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
    // nothing stored -> default dock (camera/settings are on the page now)
    expect(getLayout(["settings", "clock", "ai", "camera"]).dock).toEqual(["ai"]);
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
