/**
 * app-groups.svelte.test.ts — pure grouping model for the iOS-style "App Library".
 * No rendering: bucket every known built-in into a category and confirm the
 * "Frequently Used" (recents) set respects availability + ordering + cap.
 */
import { describe, expect, test } from "vitest";
import {
  categorizeApps,
  categoryOf,
  frequentTools,
} from "../src/lib/appGroups";
import { appIds } from "../src/lib/appMeta";

describe("appGroups — categorizeApps", () => {
  const folders = categorizeApps(appIds());

  test("covers every known built-in app exactly once across non-empty folders", () => {
    const seen = folders.flatMap((f) => f.apps);
    expect(seen).toHaveLength(appIds().length);
    expect(new Set(seen).size).toBe(appIds().length); // no duplicates
  });

  test("places representative apps into the expected category folders", () => {
    const byId = (id: string) => categoryOf(id);
    expect(byId("phone")).toBe("communication");
    expect(byId("photos")).toBe("media");
    expect(byId("notes")).toBe("productivity");
    expect(byId("clock")).toBe("utilities");
    expect(byId("settings")).toBe("system");
    expect(byId("store:org.amos.unknown")).toBe("other"); // third-party → other
  });

  test("orders folders by the canonical display order (communication first)", () => {
    expect(folders.map((f) => f.id)).toEqual([
      "communication",
      "media",
      "productivity",
      "utilities",
      "system",
    ]);
  });

  test("drops empty folders and buckets an arbitrary subset", () => {
    const subset = categorizeApps(["phone", "mail", "notes", "not-a-real-app"]);
    expect(subset.map((f) => f.id)).toEqual(["communication", "productivity", "other"]);
    expect(subset[2]!.apps).toEqual(["not-a-real-app"]);
  });
});

describe("appGroups — frequentTools (Frequently Used top group)", () => {
  const available = ["phone", "messages", "clock", "notes"];

  test("keeps recents order, drops unavailable ids, respects the cap", () => {
    // 'reminders' is not available → dropped; only 2 fit the cap of 2.
    expect(frequentTools(["clock", "reminders", "phone"], available, 2)).toEqual([
      "clock",
      "phone",
    ]);
  });

  test("returns empty when there is nothing available or no recents", () => {
    expect(frequentTools([], available, 8)).toEqual([]);
    expect(frequentTools(["clock"], [], 8)).toEqual([]);
  });

  test("default cap is 8", () => {
    const many = ["phone", "messages", "clock", "notes"];
    expect(frequentTools(many, many)).toEqual(many);
  });
});
