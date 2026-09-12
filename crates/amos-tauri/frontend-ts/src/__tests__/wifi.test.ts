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
  connectWithPassword,
  autoRejoin,
  forgetNetwork,
  hasPassword,
  isSaved,
  normalizeWifi,
  wifiInit,
  NEIGHBORHOOD,
  type WifiCfg,
} from "../lib/wifi";

const cfg = (
  current: string | null = null,
  saved: string[] = [],
  passwords: Record<string, string> = {},
): WifiCfg => ({ current, saved, passwords });

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

  test("a secure network without a stored password is NOT connectable", () => {
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

describe("wifi remembered password (auto-join next time)", () => {
  test("entering a password connects AND remembers it for reuse", () => {
    const out = connectWithPassword(cfg(), NEIGHBORHOOD, "AmOS-5G", "hunter2");
    expect(out.current).toBe("AmOS-5G");
    expect(hasPassword(out, "AmOS-5G")).toBe(true);
    expect(out.passwords["AmOS-5G"]).toBe("hunter2");
  });

  test("a remembered secure network joins again without re-entering", () => {
    const have = cfg(null, [], { "Home-2.4G": "pw" });
    const out = connectOpenOrSaved(have, NEIGHBORHOOD, "Home-2.4G");
    expect(out.current).toBe("Home-2.4G");
  });

  test("autoRejoin reconnects the strongest remembered (passworded) network when idle", () => {
    // remembered Home-2.4G (signal 3) + iPhone-Mini (signal 2), both have pw.
    const idle = cfg(null, ["Home-2.4G", "iPhone-Mini"], {
      "Home-2.4G": "a",
      "iPhone-Mini": "b",
    });
    const out = autoRejoin(idle, NEIGHBORHOOD);
    expect(out.current).toBe("Home-2.4G"); // strongest remembered
  });

  test("autoRejoin ignores a remembered secure network with no stored password", () => {
    const idle = cfg(null, ["Neighbor_AX"], {});
    expect(autoRejoin(idle, NEIGHBORHOOD).current).toBeNull();
    // but re-joins an open remembered one
    const open = autoRejoin(cfg(null, ["Cafe_Free"], {}), NEIGHBORHOOD);
    expect(open.current).toBe("Cafe_Free");
  });

  test("autoRejoin is a no-op when already connected", () => {
    const c = cfg("Cafe_Free", ["Cafe_Free"], {});
    expect(autoRejoin(c, NEIGHBORHOOD).current).toBe("Cafe_Free");
  });

  test("forgetNetwork also forgets the stored password", () => {
    const out = forgetNetwork(cfg("AmOS-5G", ["AmOS-5G"], { "AmOS-5G": "pw" }), "AmOS-5G");
    expect(out.current).toBeNull();
    expect(hasPassword(out, "AmOS-5G")).toBe(false);
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
    const g = normalizeWifi({
      current: "Home-2.4G",
      saved: ["Home-2.4G", "x", "", 5],
      passwords: { "Home-2.4G": "pw", junk: "" },
    });
    expect(g.current).toBe("Home-2.4G");
    expect(g.saved).toEqual(["Home-2.4G", "x"]);
    expect(g.passwords).toEqual({ "Home-2.4G": "pw" });
    // Junk falls back to the ONE default config (`wifiInit()`), not a re-typed
    // literal — so the default can never drift between the guard and the factory.
    expect(normalizeWifi(null)).toEqual(wifiInit());
    expect(normalizeWifi("x")).toEqual(wifiInit());
    expect(normalizeWifi({ current: "" }).saved).toEqual([]);
    expect(normalizeWifi({ current: 5 }).current).toBeNull();
  });
});
