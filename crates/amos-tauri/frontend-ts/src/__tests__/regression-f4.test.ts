import { describe, expect, test } from "vitest";
import { shortcutMatches, normalizeKey } from "../lib/shellModule";

describe("regression", () => {
  test("F4 key matches {key:F4}", () => {
    expect(shortcutMatches({ key: "F4" }, { key: "F4" })).toBe(true);
  });
  test("Space key matches {key:Space}", () => {
    expect(shortcutMatches({ key: " " }, { key: "Space" })).toBe(true);
  });
  test("Tab with meta matches {key:Tab,meta:true}", () => {
    expect(shortcutMatches({ key: "Tab", metaKey: true }, { key: "Tab", meta: true })).toBe(true);
  });
  test("normalizeKey F4", () => {
    expect(normalizeKey("F4")).toBe("F4");
  });
});
