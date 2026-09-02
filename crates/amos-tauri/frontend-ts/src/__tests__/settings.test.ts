import { describe, expect, test } from "bun:test";
import { flipQuick, removeNotif, seedNotifs, countForApp, removeAppNotifs } from "../lib/settings";

describe("settings / NC helpers", () => {
  test("flipQuick toggles immutably", () => {
    const s0 = { wifi: false };
    const s1 = flipQuick(s0, "wifi");
    expect(s1.wifi).toBe(true);
    expect(s0.wifi).toBe(false);
    expect(flipQuick(s1, "wifi").wifi).toBe(false);
  });

  test("notifications seed and dismiss", () => {
    const list = seedNotifs(1000);
    expect(list.length).toBe(3);
    const after = removeNotif(list, list[0].id);
    expect(after.length).toBe(2);
  });

  test("badge counts and clearing per app", () => {
    const list = seedNotifs(1000); // includes app 信息
    expect(countForApp(list, "信息")).toBe(1);
    const read = removeAppNotifs(list, "信息");
    expect(read.length).toBe(2);
    expect(countForApp(read, "信息")).toBe(0);
  });
});
