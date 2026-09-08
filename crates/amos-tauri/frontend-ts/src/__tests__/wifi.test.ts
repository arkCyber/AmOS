/**
 * Pure unit tests for the Wi-Fi view model (lib/wifi.ts).
 */
import { describe, expect, test } from "bun:test";
import {
  clampSignal,
  signalBars,
  sortNetworks,
  findBySsid,
  connectOpenOrSaved,
  forgetNetwork,
  isSaved,
  normalizeWifi,
  NEIGHBORHOOD,
  type WifiCfg,
} from "../lib/wifi";

const cfg = (current: string | null = null, saved: string[] = []): WifiCfg => ({ current, saved });

describe("wifi signal", () => {
  test("clampSignal bounds + rounds into 0..4", () => {
    expect(clampSignal(4)).toBe(4);
    expect(clampSignal(3.4)).toBe(3);
    expect(clampSignal(99)).toBe(4);
    expect(clampSignal(-2)).toBe(0);
    expect(clampSignal(NaN)).toBe(0);
  });

  test("signalBars maps to iOS-like 0..3 bars", () => {
    expect(signalBars(0)).toBe(0);
    expect(signalBars(1)).toBe(1);
    expect(signalBars(2)).toBe(2);
    expect(signalBars(3)).toBe(3);
    expect(signalBars(4)).toBe(3);
  });
});

describe("wifi scan ordering", () => {
  test("current network pins to the top, then strongest first (stable)", () => {
    const sorted = sortNetworks(NEIGHBORHOOD, "Cafe_Free");
    expect(sorted[0]?.ssid).toBe("Cafe_Free"); // current first
    const rest = sorted.slice(1).map((n) => n.ssid);
    expect(rest[0]).toBe("AmOS-5G"); // signal 4
    expect(rest).toContain("Neighbor_AX");
  });

  test("without a current network it is purely signal-desc, stable", () => {
    const sorted = sortNetworks(NEIGHBORHOOD, null);
    const sig = sorted.map((n) => clampSignal(n.signal));
    for (let i = 1; i < sig.length; i++) {
      expect(sig[i - 1]!).toBeGreaterThanOrEqual(sig[i]!);
    }
  });

  test("remembered networks sort above stronger unknown ones (iOS 'my networks')", () => {
    // Cafe_Free (signal 3) remembered; AmOS-5G (signal 4) is not → remembered first.
    const sorted = sortNetworks(NEIGHBORHOOD, null, ["Cafe_Free"]);
    const ids = sorted.map((n) => n.ssid);
    expect(ids[0]).toBe("Cafe_Free");
    // and it still precedes the strongest unknown
    expect(ids.indexOf("Cafe_Free")).toBeLessThan(ids.indexOf("AmOS-5G"));
  });
});

describe("wifi connect (honest, no fake passworded join)", () => {
  test("an open network can be joined and is remembered", () => {
    const out = connectOpenOrSaved(cfg(), NEIGHBORHOOD, "Library_Guest");
    expect(out.current).toBe("Library_Guest");
    expect(isSaved(out, "Library_Guest")).toBe(true);
  });

  test("a secure network that isn't current is NOT connectable offline", () => {
    const out = connectOpenOrSaved(cfg(), NEIGHBORHOOD, "AmOS-5G");
    expect(out.current).toBeNull();
    expect(isSaved(out, "AmOS-5G")).toBe(false);
  });

  test("unknown ssid is a no-op", () => {
    expect(connectOpenOrSaved(cfg(), NEIGHBORHOOD, "nope")).toEqual(cfg());
  });

  test("findBySsid resolves present networks only", () => {
    expect(findBySsid(NEIGHBORHOOD, "Home-2.4G")?.ssid).toBe("Home-2.4G");
    expect(findBySsid(NEIGHBORHOOD, "nope")).toBeNull();
  });
});

describe("wifi forget / remembered", () => {
  test("forgetNetwork clears current and drops it from saved", () => {
    const joined = connectOpenOrSaved(cfg(), NEIGHBORHOOD, "Cafe_Free");
    expect(joined.current).toBe("Cafe_Free");
    const out = forgetNetwork(joined, "Cafe_Free");
    expect(out.current).toBeNull();
    expect(isSaved(out, "Cafe_Free")).toBe(false);
  });

  test("forgetting a non-current saved network keeps current", () => {
    const c = cfg("Cafe_Free", ["Cafe_Free", "Home-2.4G"]);
    const out = forgetNetwork(c, "Home-2.4G");
    expect(out.current).toBe("Cafe_Free");
    expect(out.saved).toEqual(["Cafe_Free"]);
  });
});

describe("wifi persistence guard", () => {
  test("normalizeWifi keeps a valid current + saved and coerces junk", () => {
    const g = normalizeWifi({ current: "Home-2.4G", saved: ["Home-2.4G", "x", "", 5] });
    expect(g.current).toBe("Home-2.4G");
    expect(g.saved).toEqual(["Home-2.4G", "x"]);
    expect(normalizeWifi(null)).toEqual({ current: null, saved: [] });
    expect(normalizeWifi("x")).toEqual({ current: null, saved: [] });
    expect(normalizeWifi({ current: "" }).saved).toEqual([]);
    expect(normalizeWifi({ current: 5 }).current).toBeNull();
  });
});
