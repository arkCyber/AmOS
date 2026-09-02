import { describe, expect, test } from "bun:test";
import { defaultLayout, hideFromHome, restoreToHome, moveBefore, type HomeLayout } from "../lib/amosStore";
import { APPS, appTitleKey } from "../apps";
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";

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
});
