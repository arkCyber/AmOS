import { describe, expect, test, afterEach } from "bun:test";
import {
  batteryReadout,
  clampPct,
  batteryTone,
  firstBattery,
  sampleHostBattery,
  normalizeSample,
  EMPTY_BATTERY,
  watchHostBattery,
  type BatterySample,
} from "../lib/batteryStatus";

// Minimal structural stand-in so the test file has no ambient-type dependency on
// the BatteryManager lib.dom type (bun + happy-dom may differ).
type BatteryManagerLike = {
  level: number;
  charging: boolean;
  addEventListener?: (t: string, cb: () => void) => void;
  removeEventListener?: (t: string, cb: () => void) => void;
};

describe("batteryStatus", () => {
  test("clampPct bounds stray readings into 0..100", () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(150)).toBe(100);
    expect(clampPct(42.6)).toBe(42.6);
    expect(clampPct(Number.NaN)).toBe(0);
  });

  test("batteryTone tiers a draining battery (low ≤20, critical ≤10)", () => {
    expect(batteryTone({ levelPct: 50, charging: false })).toBe("ok");
    expect(batteryTone({ levelPct: 20, charging: false })).toBe("low");
    expect(batteryTone({ levelPct: 10, charging: false })).toBe("critical");
    expect(batteryTone({ levelPct: 5, charging: false })).toBe("critical");
  });

  test("batteryTone reports charging regardless of level; unknown when no level", () => {
    expect(batteryTone({ levelPct: 3, charging: true })).toBe("charging");
    expect(batteryTone({ levelPct: 80, charging: true })).toBe("charging");
    expect(batteryTone({ levelPct: null, charging: true })).toBe("unknown");
  });

  test("batteryReadout names the state and rounds the level; null when unknown", () => {
    // Unknown must stay unknown: `null` is what makes a surface fall back to its own
    // honest "no reading" name instead of inventing a percentage.
    expect(batteryReadout({ levelPct: null, charging: null })).toBeNull();
    expect(batteryReadout({ levelPct: null, charging: true })).toBeNull();

    expect(batteryReadout({ levelPct: 80, charging: false })).toEqual({
      key: "a11y.battery",
      pct: "80%",
    });
    expect(batteryReadout({ levelPct: 64, charging: true })).toEqual({
      key: "a11y.batteryCharging",
      pct: "64%",
    });
    // A level with the charging bit unread is a level, not a charging report.
    expect(batteryReadout({ levelPct: 42, charging: null })?.key).toBe("a11y.battery");
    // Rounded once, here, so the name and the drawn text cannot disagree.
    expect(batteryReadout({ levelPct: 79.6, charging: false })?.pct).toBe("80%");
    expect(batteryReadout({ levelPct: 79.4, charging: false })?.pct).toBe("79%");
  });

  test("normalizeSample coerces a loose raw object and clamps level", () => {
    expect(normalizeSample({ levelPct: 87.6, charging: true })).toEqual({
      levelPct: 87.6,
      charging: true,
    });
    expect(normalizeSample({ levelPct: 500, charging: false })).toEqual({
      levelPct: 100,
      charging: false,
    });
    expect(normalizeSample({ levelPct: undefined, charging: undefined })).toEqual(
      EMPTY_BATTERY,
    );
  });

  test("firstBattery picks the first finite level across an ordered list", () => {
    const none: BatterySample = { levelPct: null, charging: null };
    const host: BatterySample = { levelPct: 75, charging: false };
    const dev: BatterySample = { levelPct: 30, charging: true };
    // daemon → host → browser order: host is skipped only if a higher layer has data.
    expect(firstBattery([dev, host])).toEqual(dev);
    expect(firstBattery([none, host])).toEqual(host);
    expect(firstBattery([none, none, host])).toEqual(host);
    expect(firstBattery([none, none, none, undefined, null])).toEqual(EMPTY_BATTERY);
  });

  test("firstBattery: the daemon (system) reading beats the host one", () => {
    const system = { levelPct: 60, charging: false };
    const host: BatterySample = { levelPct: 92, charging: true };
    expect(firstBattery([system, host])).toEqual({ levelPct: 60, charging: false });
    // A level-less system block defers to the host; no source → honestly unknown.
    expect(firstBattery([{ levelPct: null, charging: null }, host])).toEqual(host);
    expect(firstBattery([null, null])).toEqual(EMPTY_BATTERY);
  });

  test("sampleHostBattery maps a BatteryManager level (0..1) onto a 0..100 %", () => {
    const m = { level: 0.8, charging: true } as BatteryManagerLike;
    expect(sampleHostBattery(m)).toEqual({ levelPct: 80, charging: true });
    // A real fully-drained 0 is kept (distinct from unknown).
    expect(sampleHostBattery({ level: 0, charging: false } as BatteryManagerLike)).toEqual({
      levelPct: 0,
      charging: false,
    });
    expect(sampleHostBattery(null)).toEqual(EMPTY_BATTERY);
  });
});

describe("watchHostBattery", () => {
  const origGetBattery = Object.getOwnPropertyDescriptor(
    navigator,
    "getBattery",
  );
  afterEach(() => {
    if (origGetBattery) {
      Object.defineProperty(navigator, "getBattery", origGetBattery);
    } else {
      // @ts-expect-error removing the stub we added
      delete navigator.getBattery;
    }
  });

  test("returns null (no-op) when the host has no Battery API", () => {
    // happy-dom's navigator typically exposes no getBattery → honest no-op.
    const stop = watchHostBattery(() => {});
    expect(stop).toBeNull();
  });

  test("emits the current sample then stops when stopped", async () => {
    const listeners = new Map<string, () => void>();
    const manager = {
      level: 0.45,
      charging: false,
      addEventListener: (t: string, cb: () => void) => listeners.set(t, cb),
      removeEventListener: (t: string) => listeners.delete(t),
    };
    Object.defineProperty(navigator, "getBattery", {
      configurable: true,
      value: () => Promise.resolve(manager),
    });
    const seen: BatterySample[] = [];
    const stop = watchHostBattery((s) => seen.push(s));
    expect(stop).toBeTypeOf("function");
    // Let the promise resolve so the initial sample is delivered.
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([{ levelPct: 45, charging: false }]);
    expect(listeners.has("levelchange")).toBe(true);
    expect(listeners.has("chargingchange")).toBe(true);

    // levelchange → new sample forwarded.
    manager.level = 0.3;
    listeners.get("levelchange")?.();
    expect(seen[seen.length - 1]).toEqual({ levelPct: 30, charging: false });

    stop?.();
    manager.level = 0.9;
    listeners.get("levelchange")?.();
    expect(seen.length).toBe(2); // stopped → no further samples
  });

  test("`stop()` really detaches both listeners from the page-singleton manager", async () => {
    // `BatteryManager` is a page singleton, so "stop" must mean *remove*, not
    // merely "stop calling `cb`": a muted-but-attached listener still pins `cb`
    // (and everything it closes over) for the life of the document, and every
    // mount/unmount cycle would stack two more. The test above cannot see this —
    // it keeps its own reference to the callback and invokes it directly, so it
    // passes whether or not the listener was ever removed.
    const attached = new Set<string>();
    const manager = {
      level: 0.5,
      charging: false,
      addEventListener: (t: string) => attached.add(t),
      removeEventListener: (t: string) => attached.delete(t),
    };
    Object.defineProperty(navigator, "getBattery", {
      configurable: true,
      value: () => Promise.resolve(manager),
    });
    const stop = watchHostBattery(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect([...attached].sort()).toEqual(["chargingchange", "levelchange"]);

    stop?.();
    expect(attached.size).toBe(0); // both listeners detached, not merely muted
  });

  test("`stop()` before the API resolves subscribes nothing", async () => {
    // The promise may resolve after the owner is already gone (a Svelte app that
    // unmounted in the same tick). Attaching then would leak into a dead owner.
    const attached = new Set<string>();
    const manager = {
      level: 0.5,
      charging: false,
      addEventListener: (t: string) => attached.add(t),
      removeEventListener: (t: string) => attached.delete(t),
    };
    Object.defineProperty(navigator, "getBattery", {
      configurable: true,
      value: () => Promise.resolve(manager),
    });
    const seen: BatterySample[] = [];
    const stop = watchHostBattery((s) => seen.push(s));
    stop?.(); // detach synchronously, before the promise settles
    await new Promise((r) => setTimeout(r, 5));
    expect(attached.size).toBe(0);
    expect(seen).toEqual([]); // and no initial sample either
  });
});
