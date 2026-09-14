/**
 * Pure unit tests for the personal-hotspot view model (lib/hotspot.ts).
 * The behaviours pinned here are what keep the settings page honest: a config
 * write that cannot produce a working AP must be *detected* (never silently
 * switched on), and the guard must never invent a default the user cleared.
 */
import { describe, expect, spyOn, test } from "bun:test";
import {
  HOTSPOT_KEY,
  clampClients,
  hotspotInit,
  hotspotProblems,
  hotspotReady,
  isOpenNetwork,
  normalizeHotspot,
  sanitizeSsid,
  setBand,
  setMaxClients,
  setPassword,
  setSecurity,
  setSsid,
  suggestPassword,
  type HotspotCfg,
} from "../lib/hotspot";

/** A valid, ready-to-serve config (a WPA2 key long enough to provision). */
const cfg = (over: Partial<HotspotCfg> = {}): HotspotCfg => ({
  ...hotspotInit(),
  password: "hunter2x",
  ...over,
});

describe("hotspot client cap", () => {
  test("clampClients bounds, rounds and guards junk into 1..10", () => {
    expect(clampClients(5)).toBe(5);
    expect(clampClients(0)).toBe(1);
    expect(clampClients(-3)).toBe(1);
    expect(clampClients(99)).toBe(10);
    expect(clampClients(3.4)).toBe(3);
    expect(clampClients(NaN)).toBe(1);
  });

  test("setMaxClients clamps through the same bound", () => {
    expect(setMaxClients(cfg(), 100).maxClients).toBe(10);
    expect(setMaxClients(cfg(), 0).maxClients).toBe(1);
  });
});

describe("hotspot ssid / password fields", () => {
  test("sanitizeSsid trims and caps at 32 BYTES", () => {
    expect(sanitizeSsid("  My Net  ")).toBe("My Net");
    expect(sanitizeSsid("x".repeat(40))).toBe("x".repeat(32));
    // A blank name is allowed through the sanitizer; the validator judges it.
    expect(sanitizeSsid("   ")).toBe("");
  });

  test("sanitizeSsid counts octets, so a CJK name cannot blow the 32-byte cap", () => {
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    // 3 bytes per CJK char: 10 fit (30), the 11th would make 33.
    expect(sanitizeSsid("网".repeat(20))).toBe("网".repeat(10));
    expect(bytes(sanitizeSsid("网".repeat(20)))).toBeLessThanOrEqual(32);
    // A mixed name keeps the longest prefix that fits.
    expect(sanitizeSsid("abc" + "网".repeat(11))).toBe("abc" + "网".repeat(9));
    // 4-byte code points: 8 emoji = exactly 32 bytes, the 9th would be 36.
    expect(sanitizeSsid("😀".repeat(9))).toBe("😀".repeat(8));
  });

  test("the byte cap never splits a code point (the name stays valid UTF-8)", () => {
    const out = sanitizeSsid("😀".repeat(9) + "x");
    const round = new TextDecoder().decode(new TextEncoder().encode(out));
    // A split surrogate would decode back as U+FFFD.
    expect(round).toBe(out);
    expect(out).not.toContain("\uFFFD");
  });

  test("setSsid / setPassword are pure and cap their inputs", () => {
    const base = cfg();
    const named = setSsid(base, "  Cafe  ");
    expect(named.ssid).toBe("Cafe");
    expect(base.ssid).toBe("AmOS Hotspot"); // unchanged (immutable)
    expect(setPassword(base, "p".repeat(80)).password.length).toBe(63);
  });

  test("setBand / setSecurity only touch their own field", () => {
    const base = cfg();
    expect(setBand(base, "2.4")).toEqual({ ...base, band: "2.4" });
    expect(setSecurity(base, "wpa3")).toEqual({ ...base, security: "wpa3" });
    // Switching to open keeps the stored key so toggling back does not re-type.
    expect(setSecurity(base, "open").password).toBe(base.password);
  });
});

describe("hotspot password suggestion (pure by parameter)", () => {
  test("is deterministic for an injected rand and honours the length", () => {
    expect(suggestPassword(() => 0, 4)).toBe("AAAA");
    expect(suggestPassword(() => 1, 4)).toBe("9999"); // last alphabet char
    expect(suggestPassword(() => 0.5, 6).length).toBe(6);
  });

  test("the DEFAULT draw is the platform CSPRNG, not Math.random", () => {
    // The suggestion becomes the AP's Wi-Fi PSK, so a predictable draw is a real
    // weakness — hence crypto.getRandomValues by default.
    expect(typeof globalThis.crypto?.getRandomValues).toBe("function");
    const spy = spyOn(Math, "random");
    try {
      const a = suggestPassword();
      const b = suggestPassword();
      expect(spy).not.toHaveBeenCalled();
      expect(a.length).toBe(12);
      expect(a).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
      expect(a).not.toBe(b); // 62^12 collisions are impossible in practice
    } finally {
      spy.mockRestore();
    }
  });

  test("stays inside the alphabet and never emits a look-alike", () => {
    const pw = suggestPassword(() => 0.42, 64);
    expect(pw.length).toBe(64);
    expect(pw).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/); // no 0/O, 1/l/I
  });

  test("a non-finite rand degrades to the first character, never a crash", () => {
    expect(suggestPassword(() => NaN, 3)).toBe("AAA");
    expect(suggestPassword(() => -5, 3)).toBe("AAA");
  });
});

describe("hotspot validation (must block a config that cannot serve)", () => {
  test("a valid WPA2 config has no problem", () => {
    expect(hotspotProblems(cfg())).toEqual([]);
    expect(hotspotReady(cfg())).toBe(true);
  });

  test("a blank name is a blocking problem", () => {
    expect(hotspotProblems(cfg({ ssid: "" }))).toContain("ssidEmpty");
    expect(hotspotReady(cfg({ ssid: "" }))).toBe(false);
  });

  test("a WPA2/WPA3 key under 8 characters is a blocking problem", () => {
    expect(hotspotProblems(cfg({ password: "short" }))).toContain("passwordTooShort");
    expect(hotspotReady(cfg({ password: "1234567" }))).toBe(false);
    expect(hotspotReady(cfg({ password: "12345678" }))).toBe(true);
  });

  test("an open network needs no password (its risk is a warning, not a block)", () => {
    const open = cfg({ security: "open", password: "" });
    expect(hotspotProblems(open)).toEqual([]);
    expect(hotspotReady(open)).toBe(true);
    expect(isOpenNetwork(open)).toBe(true);
    expect(isOpenNetwork(cfg())).toBe(false);
  });

  test("both problems are reported together (no early stop)", () => {
    expect(hotspotProblems(cfg({ ssid: "", password: "" }))).toEqual([
      "ssidEmpty",
      "passwordTooShort",
    ]);
  });
});

describe("hotspot persistence guard", () => {
  test("keeps a valid stored config", () => {
    const g = normalizeHotspot({
      ssid: "Home",
      password: "hunter2x",
      band: "2.4",
      security: "wpa3",
      maxClients: 3,
    });
    expect(g).toEqual({
      ssid: "Home",
      password: "hunter2x",
      band: "2.4",
      security: "wpa3",
      maxClients: 3,
    });
  });

  test("junk falls back to the ONE default config (`hotspotInit()`)", () => {
    expect(normalizeHotspot(null)).toEqual(hotspotInit());
    expect(normalizeHotspot("x")).toEqual(hotspotInit());
    expect(normalizeHotspot([])).toEqual(hotspotInit());
  });

  test("coerces unknown enum/number fields but keeps a deliberately blank name", () => {
    const g = normalizeHotspot({
      ssid: "",
      band: "6",
      security: "wep",
      maxClients: 999,
      password: "p".repeat(90),
    });
    expect(g.ssid).toBe(""); // a cleared name is honoured, not defaulted
    expect(g.band).toBe("5"); // unknown band → default
    expect(g.security).toBe("wpa2"); // unknown security → default
    expect(g.maxClients).toBe(10); // clamped
    expect(g.password.length).toBe(63); // capped
  });

  test("the store key is the documented single source", () => {
    expect(HOTSPOT_KEY).toBe("amos.hotspot");
  });
});
