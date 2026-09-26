import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CAPABILITIES,
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
    // Derived from the one declaration — not re-spelled — so this test cannot
    // pass while `CAPABILITIES` and its own list silently disagree.
    const caps: Capability[] = [...CAPABILITIES];
    expect(caps).toHaveLength(6);
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

describe("capability vocabulary (one declaration, frozen, mirrors the daemon Resource)", () => {
  // The six capabilities the OS knows, in declaration order.
  const FROZEN: readonly string[] = [
    "camera",
    "microphone",
    "location",
    "contacts",
    "storage",
    "notifications",
  ];
  // The five keys the daemon gate-keeps (`amos-ai::privacy::Resource::ALL`).
  // `notifications` is deliberately absent — it is frontend-local, not an OS asset.
  const DAEMON_MIRRORED: readonly string[] = [
    "camera",
    "microphone",
    "location",
    "contacts",
    "storage",
  ];

  test("the one declaration is frozen (add/rename/remove == wire break)", () => {
    // The ledger is persisted to `~/.amos/state.json` and read by Rust, so a
    // renamed key is a **wire break**, not a refactor — pin every value, not
    // just the count. Before this test the only vocabulary assertion re-spelled
    // the six strings locally and checked `length === 6`, so a rename passed.
    expect([...CAPABILITIES] as string[]).toEqual([...FROZEN]);
  });

  test("…and the daemon-mirrored five equal `Resource::key()` in Rust, both directions", () => {
    // Read the daemon's own declaration, so a rename on either side fails here
    // instead of quietly dropping a real grant (`normalizeLedger` drops unknown
    // caps) or admitting a cap the daemon will deny.
    const src = readFileSync(new URL("../../../../amos-ai/src/privacy.rs", import.meta.url), "utf8");
    const keyIdx = src.indexOf("const fn key(self)");
    expect(keyIdx).toBeGreaterThan(0);
    // Slice to the `key()` body: a bare `/Self::\w+ => "…"/g` over the whole file
    // would also pick up `AccessDecision`'s `Display` arms ("granted"/"denied").
    const body = src.slice(keyIdx, keyIdx + 400);
    const rust = [...new Set([...body.matchAll(/Self::\w+ => "([a-z_]+)"/g)].map((m) => m[1] ?? ""))].sort();
    // A vacuous pass is the failure mode of a source-reading test: assert the
    // slice+regex actually found the five arms before comparing the two sets.
    expect(rust).toEqual([...DAEMON_MIRRORED].sort());
    const mirrored = ([...CAPABILITIES] as string[]).filter((c) => c !== "notifications").sort();
    expect(mirrored).toEqual(rust);
  });
});
