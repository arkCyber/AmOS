import { describe, expect, test } from "bun:test";
import { APP_META, appTitleKey, isKnownApp } from "../lib/appMeta";
import {
  CATEGORY_ORDER,
  categorizeApps,
  categoryOf,
  frequentTools,
  orderByRecency,
} from "../lib/appGroups";

describe("orderByRecency (Spotlight's app ordering)", () => {
  const ids = ["clock", "settings", "calculator", "weather", "notes"];

  test("puts opened apps first, most recent first", () => {
    expect(orderByRecency(ids, (id) => id, ["notes", "clock"])).toEqual([
      "notes",
      "clock",
      "settings",
      "calculator",
      "weather",
    ]);
  });

  test("never invents usage: an empty (or irrelevant) recents list changes nothing", () => {
    expect(orderByRecency(ids, (id) => id, [])).toEqual(ids);
    // Ids that are not in the list are ignored rather than shifting anything.
    expect(orderByRecency(ids, (id) => id, ["store", "maps"])).toEqual(ids);
  });

  test("unopened apps keep their original relative order (stable)", () => {
    const out = orderByRecency(ids, (id) => id, ["calculator"]);
    expect(out).toEqual(["calculator", "clock", "settings", "weather", "notes"]);
  });

  test("works on objects (the shape Spotlight actually passes) and does not mutate", () => {
    const apps = [
      { id: "maps", n: 1 },
      { id: "camera", n: 2 },
      { id: "mail", n: 3 },
      { id: "magnifier", n: 4 },
    ];
    const out = orderByRecency(apps, (a) => a.id, ["magnifier", "maps"]);
    expect(out.map((a) => a.id)).toEqual(["magnifier", "maps", "camera", "mail"]);
    expect(apps.map((a) => a.id)).toEqual(["maps", "camera", "mail", "magnifier"]);
  });

  test("agrees with the App Library's frequentTools ordering for opened apps", () => {
    const recents = ["notes", "clock", "settings"];
    const available = ids.concat(["store"]);
    const ordered = orderByRecency(ids, (id) => id, recents).slice(0, 3);
    expect(ordered).toEqual(frequentTools(recents, available, 3));
  });

  test("the real registry has no duplicate ids (ranking keys stay unique)", () => {
    const all = APP_META.map((a) => a.id);
    expect(new Set(all).size).toBe(all.length);
    // Sanity: every real id resolves through the titleKey lookup used by the filter.
    expect(all.every((id) => appTitleKey(id) !== null)).toBe(true);
    expect(all.every((id) => isKnownApp(id))).toBe(true);
  });

/**
 * REQ-A406 — the App Library's **folders**. `categoryOf` / `categorizeApps` had no test at
 * all (12 executable lines, never entered by any file in the suite), so the only thing
 * standing between "a new app" and "a stray 其他 folder" was a comment in the table.
 * These tests pin the two halves that matter: the fallback for unknown/third-party ids,
 * and the fact that **every** app actually in the registry is classified.
 */
describe("categoryOf / categorizeApps (App Library folders)", () => {
  test("every app in the registry is classified — none silently lands in 其他", () => {
    const unclassified = APP_META.map((a) => a.id).filter((id) => categoryOf(id) === "other");
    // A new app id that nobody added to ASSIGN shows up here (and would render an extra
    // "other" folder in the App Library), which is exactly what this assertion is for.
    expect(unclassified).toEqual([]);
  });

  test("unknown / third-party / empty ids fall back to 其他", () => {
    expect(categoryOf("store:com.example.thing")).toBe("other");
    expect(categoryOf("definitely-not-an-app")).toBe("other");
    expect(categoryOf("")).toBe("other");
  });

  test("each built-in id resolves to the category its neighbours are in", () => {
    expect(categoryOf("phone")).toBe("communication");
    expect(categoryOf("messages")).toBe("communication");
    expect(categoryOf("camera")).toBe("media");
    expect(categoryOf("notes")).toBe("productivity");
    expect(categoryOf("shortcuts")).toBe("productivity");
    expect(categoryOf("webman")).toBe("utilities");
    expect(categoryOf("settings")).toBe("system");
  });

  test("CATEGORY_ORDER lists every category exactly once, in display order", () => {
    const ids = CATEGORY_ORDER.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["communication", "media", "productivity", "utilities", "system", "other"]);
    for (const def of CATEGORY_ORDER) expect(def.nameKey).toMatch(/^group\./);
  });

  test("categorizeApps keeps input order inside a folder and drops empty folders", () => {
    const folders = categorizeApps(["settings", "notes", "phone", "zzz-unknown", "reminders"]);
    expect(folders.map((f) => f.id)).toEqual(["communication", "productivity", "system", "other"]);
    expect(folders.map((f) => f.apps)).toEqual([
      ["phone"],
      ["notes", "reminders"],
      ["settings"],
      ["zzz-unknown"],
    ]);
  });

  test("no folders at all for an empty list (never an empty 其他)", () => {
    expect(categorizeApps([])).toEqual([]);
  });

  test("the real registry produces exactly the five built-in folders", () => {
    const folders = categorizeApps(APP_META.map((a) => a.id));
    expect(folders.map((f) => f.id)).toEqual([
      "communication",
      "media",
      "productivity",
      "utilities",
      "system",
    ]);
    const placed = folders.flatMap((f) => f.apps);
    expect(placed).toHaveLength(APP_META.length);
    expect(new Set(placed).size).toBe(APP_META.length);
  });
});

});