import { describe, expect, test } from "bun:test";
import {
  capSet,
  grantCap,
  grantedApps,
  grantedCaps,
  loadLedger,
  normalizeLedger,
  revokeCap,
  saveLedger,
  type Capability,
} from "../lib/permissions";

describe("durable permission ledger (pure)", () => {
  test("normalize drops unknown caps/apps and dedupes", () => {
    const raw = {
      "org.amos.notes": ["camera", "camera", "bogus", 42],
      "": ["camera"],
      store__x: [],
    };
    const l = normalizeLedger(raw);
    expect(l["org.amos.notes"]).toEqual(["camera"]);
    expect(l[""]).toBeUndefined();
    expect(l.store__x).toBeUndefined();
    expect(normalizeLedger(null)).toEqual({});
    expect(normalizeLedger("nope")).toEqual({});
  });

  test("grant / revoke are immutable and idempotent", () => {
    const start = {};
    const one = grantCap(start, "camera-app", "camera");
    expect(start).toEqual({}); // original untouched
    expect(capSet(one, "camera-app", "camera")).toBe(true);
    // granting twice is a no-op (no duplicate).
    const twice = grantCap(one, "camera-app", "camera");
    expect(grantedCaps(twice, "camera-app")).toEqual(["camera"]);

    const gone = revokeCap(twice, "camera-app", "camera");
    expect(grantedCaps(gone, "camera-app")).toEqual([]);
    expect(Object.keys(gone)).toHaveLength(0); // empty app entry removed
  });

  test("an app can hold several capabilities; queries index both ways", () => {
    let l = grantCap({}, "maps", "location");
    l = grantCap(l, "maps", "camera");
    l = grantCap(l, "mic-app", "microphone");
    expect(capSet(l, "maps", "location")).toBe(true);
    expect(capSet(l, "maps", "microphone")).toBe(false);
    expect(grantedApps(l, "location")).toEqual(["maps"]);
    expect(grantedApps(l, "microphone")).toEqual(["mic-app"]);
    expect(grantedApps(l, "notifications")).toEqual([]);
  });

  test("typed helpers compile for all known capabilities", () => {
    const caps: Capability[] = ["camera", "microphone", "location", "notifications"];
    expect(caps).toHaveLength(4);
  });

  test("saveLedger/loadLedger round-trip through the durable store", () => {
    const real = (globalThis as { window?: unknown }).window;
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      dispatchEvent: () => false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    try {
      saveLedger({ maps: ["location"] });
      expect(loadLedger()).toEqual({ maps: ["location"] });
      // A corrupt persisted ledger degrades to empty without crashing.
      store.set("amos.permissions", "not json");
      expect(loadLedger()).toEqual({});
    } finally {
      (globalThis as { window?: unknown }).window = real;
    }
  });
});
