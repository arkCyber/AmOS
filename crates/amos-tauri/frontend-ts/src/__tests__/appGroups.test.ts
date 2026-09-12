import { describe, expect, test } from "bun:test";
import { APP_META, appTitleKey, isKnownApp } from "../lib/appMeta";
import { frequentTools, orderByRecency } from "../lib/appGroups";

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
});