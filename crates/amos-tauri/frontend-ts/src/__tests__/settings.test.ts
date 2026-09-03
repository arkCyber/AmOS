import { describe, expect, test } from "bun:test";
import { flipQuick, removeNotif, seedNotifs, countForApp, removeAppNotifs, normalizeQuick, normalizeNotifs, NOTIF_CAP } from "../lib/settings";
import {
  SETTINGS_KEY,
  readCloud,
  setCloudPrefs,
  snapshotStores,
} from "../lib/cloud";

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
    const after = removeNotif(list, list[0]!.id);
    expect(after.length).toBe(2);
  });

  test("badge counts and clearing per app", () => {
    const list = seedNotifs(1000); // includes app 信息
    expect(countForApp(list, "信息")).toBe(1);
    const read = removeAppNotifs(list, "信息");
    expect(read.length).toBe(2);
    expect(countForApp(read, "信息")).toBe(0);
  });

  test("cloud prefs read/write round-trip and tolerate garbage", () => {
    expect(readCloud(null)).toEqual({ enabled: false, lastSync: 0 });
    expect(readCloud(undefined)).toEqual({ enabled: false, lastSync: 0 });
    const on = setCloudPrefs({}, { enabled: true, lastSync: 5 });
    expect(on.iCloudSync).toBe(true);
    expect(readCloud(on)).toEqual({ enabled: true, lastSync: 5 });
    expect(readCloud({ iCloudSync: "yes", cloudLast: "nope" })).toEqual({
      enabled: false,
      lastSync: 0,
    });
    expect(SETTINGS_KEY).toBe("amos.settings");
    // write entry must tolerate a non-object blob without crashing or leaking keys
    const fromNull = setCloudPrefs(null as unknown as Record<string, unknown>, {
      enabled: true,
      lastSync: 1,
    });
    expect(fromNull).toEqual({ iCloudSync: true, cloudLast: 1 });
    const fromArray = setCloudPrefs(["x"] as unknown as Record<string, unknown>, {
      enabled: false,
    });
    expect(fromArray).toEqual({ iCloudSync: false });
  });

  test("snapshotStores is deterministic and fixed-ordered", () => {
    const stores: Record<string, unknown> = {
      "amos.photos": [{ id: "p1" }],
      "amos.notes": [{ text: "hi" }],
      "amos.other-not-synced": undefined, // non-listed key is ignored entirely
    };
    const a = snapshotStores(stores);
    const b = snapshotStores({ ...stores });
    expect(a).toBe(b); // same fixed key order → same JSON every time
    expect(a).toContain('"amos.photos"');
    expect(a).toContain('"amos.notes"');
    expect(a).not.toContain("other-not-synced"); // non-sync store omitted
    const parsed = JSON.parse(a) as Record<string, unknown>;
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
  });

  test("normalizeQuick keeps only known boolean toggles", () => {
    const v = { wifi: true, dnd: false, darkmode: true, other: 1, nested: { x: 1 } };
    expect(normalizeQuick(v)).toEqual({ wifi: true, dnd: false, darkmode: true });
    expect(normalizeQuick([1, 2])).toEqual({});
    expect(normalizeQuick(null)).toEqual({});
    expect(normalizeQuick("x")).toEqual({});
  });

  test("normalizeNotifs keeps valid entries, dedups, tolerates garbage", () => {
    const corrupt = [
      { id: "a", app: "信息", time: 1 },
      { id: "a", app: "天气", time: 2 }, // dup id → dropped
      { id: "b", body: "no time" }, // missing numeric time → dropped
      null,
      3,
    ];
    const out = normalizeNotifs(corrupt);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({ id: "a", app: "信息", time: 1 });
    expect(normalizeNotifs(null)).toEqual([]);
  });

  test("normalizeNotifs caps a pathologically large store at NOTIF_CAP (keeps newest)", () => {
    const big = Array.from({ length: NOTIF_CAP + 40 }, (_, i) => ({ id: `id${i}`, app: "信息", time: i }));
    const out = normalizeNotifs(big);
    expect(out.length).toBe(NOTIF_CAP);
    expect(out[0]!.id).toBe("id40"); // oldest id0..id39 evicted
    expect(out[out.length - 1]!.id).toBe(`id${NOTIF_CAP + 39}`); // newest tail intact
  });
});
