import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_SOUND,
  effectiveAlert,
  flipSound,
  loadSound,
  normalizeSound,
  saveSound,
  setSoundVolume,
  shouldVibrateOnArrival,
  shouldRingOnArrival,
  SOUND_KEY,
  type SoundPolicy,
} from "../lib/sound";

let realWindow: unknown;
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

/** Minimal window (Map-backed localStorage + no-op events) for store round-trips. */
function fakeWindow(): void {
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
}

describe("sound / alert policy", () => {
  test("normalizeSound defaults to ON and keeps only well-formed fields", () => {
    expect(normalizeSound(null)).toEqual(DEFAULT_SOUND);
    expect(normalizeSound(undefined)).toEqual(DEFAULT_SOUND);
    expect(normalizeSound([1])).toEqual(DEFAULT_SOUND);
    expect(normalizeSound({})).toEqual(DEFAULT_SOUND);
    expect(normalizeSound({ ring: false })).toEqual({ ring: false, vibrate: true, volume: 1 });
    expect(normalizeSound({ ring: false, vibrate: false })).toEqual({
      ring: false,
      vibrate: false,
      volume: 1,
    });
    expect(normalizeSound({ ring: "no", vibrate: true })).toEqual({
      ring: true,
      vibrate: true,
      volume: 1,
    });
  });

  test("normalizeSound clamps volume into 0..1; unreadable falls back to the default", () => {
    expect(normalizeSound({ volume: 0.5 })).toEqual({ ring: true, vibrate: true, volume: 0.5 });
    expect(normalizeSound({ volume: 0 })).toEqual({ ring: true, vibrate: true, volume: 0 });
    expect(normalizeSound({ volume: 1.5 })).toEqual({ ring: true, vibrate: true, volume: 1 });
    expect(normalizeSound({ volume: -0.2 })).toEqual({ ring: true, vibrate: true, volume: 0 });
    expect(normalizeSound({ volume: "loud" })).toEqual(DEFAULT_SOUND);
    expect(normalizeSound({ volume: Number.NaN })).toEqual(DEFAULT_SOUND);
  });

  test("effectiveAlert mutes both bits under DND but carries the loudness through", () => {
    const policy = { ring: true, vibrate: true, volume: 1 };
    expect(effectiveAlert(policy, false)).toEqual(policy);
    expect(effectiveAlert(policy, true)).toEqual({ ring: false, vibrate: false, volume: 1 });

    const vibOnly = { ring: false, vibrate: true, volume: 0.25 };
    expect(effectiveAlert(vibOnly, false)).toEqual(vibOnly);
    expect(effectiveAlert(vibOnly, true)).toEqual({ ring: false, vibrate: false, volume: 0.25 });
  });

  test("shouldVibrateOnArrival requires an arrival AND allowed vibration", () => {
    const normal = { ring: true, vibrate: true, volume: 1 };
    expect(shouldVibrateOnArrival(true, normal)).toBe(true); // arrived + allowed
    expect(shouldVibrateOnArrival(false, normal)).toBe(false); // nothing arrived

    // DND mutes vibration (effective all-false).
    const dnd = { ring: false, vibrate: false, volume: 1 };
    expect(shouldVibrateOnArrival(true, dnd)).toBe(false);
    // Policy with vibration off but ring on.
    const ringOnly = { ring: true, vibrate: false, volume: 1 };
    expect(shouldVibrateOnArrival(true, ringOnly)).toBe(false);
  });

  test("shouldRingOnArrival requires an arrival AND audible alerts allowed", () => {
    const normal = { ring: true, vibrate: true, volume: 1 };
    expect(shouldRingOnArrival(true, normal)).toBe(true); // arrived + ring allowed
    expect(shouldRingOnArrival(false, normal)).toBe(false); // nothing arrived
    // DND mutes ring; vibrate-only policy has ring off.
    const dnd = { ring: false, vibrate: false, volume: 1 };
    expect(shouldRingOnArrival(true, dnd)).toBe(false);
    const vibOnly = { ring: false, vibrate: true, volume: 1 };
    expect(shouldRingOnArrival(true, vibOnly)).toBe(false);
  });

  test("normalizeSound reads through the legacy {notify,haptics} schema", () => {
    // The Settings sound page once persisted {notify,haptics} under the SAME key;
    // a user's choice must survive the schema unification, not reset to defaults.
    // A legacy record has no loudness either — it reads back at the default 1.
    expect(normalizeSound({ notify: false, haptics: true })).toEqual({
      ring: false,
      vibrate: true,
      volume: 1,
    });
    expect(normalizeSound({ notify: false })).toEqual({ ring: false, vibrate: true, volume: 1 });
    expect(normalizeSound({ haptics: false })).toEqual({ ring: true, vibrate: false, volume: 1 });
    // New-schema fields win when both are present.
    expect(normalizeSound({ ring: true, vibrate: true, notify: false, haptics: false })).toEqual({
      ring: true,
      vibrate: true,
      volume: 1,
    });
  });

  test("flipSound is immutable, toggles the requested bit, and preserves loudness", () => {
    const base = DEFAULT_SOUND;
    const next = flipSound(base, "ring");
    expect(base).toEqual({ ring: true, vibrate: true, volume: 1 }); // original untouched
    expect(next).toEqual({ ring: false, vibrate: true, volume: 1 });
    expect(flipSound(next, "vibrate")).toEqual({ ring: false, vibrate: false, volume: 1 });
    expect(next).toEqual({ ring: false, vibrate: true, volume: 1 }); // still untouched
    // A legacy/garbage input is normalized first, so the flip is total.
    expect(flipSound({ notify: true } as unknown as SoundPolicy, "ring")).toEqual({
      ring: false,
      vibrate: true,
      volume: 1,
    });
  });

  test("setSoundVolume clamps into 0..1, is pure, and ignores garbage", () => {
    expect(setSoundVolume(DEFAULT_SOUND, 0.5)).toEqual({ ring: true, vibrate: true, volume: 0.5 });
    expect(setSoundVolume(DEFAULT_SOUND, 0)).toEqual({ ring: true, vibrate: true, volume: 0 });
    expect(setSoundVolume(DEFAULT_SOUND, 7)).toEqual(DEFAULT_SOUND); // clamped to 1
    expect(setSoundVolume(DEFAULT_SOUND, -1)).toEqual({ ring: true, vibrate: true, volume: 0 });
    // Garbage is ignored — the normalized policy comes back unchanged.
    expect(setSoundVolume(DEFAULT_SOUND, "loud")).toEqual(DEFAULT_SOUND);
    expect(setSoundVolume(DEFAULT_SOUND, Number.NaN)).toEqual(DEFAULT_SOUND);
    // Pure: the input policy object is never mutated.
    expect(DEFAULT_SOUND).toEqual({ ring: true, vibrate: true, volume: 1 });
  });

  test("saveSound/loadSound round-trips through the store and normalizes", () => {
    fakeWindow();
    saveSound({ ring: false, vibrate: true, volume: 1 });
    expect(loadSound()).toEqual({ ring: false, vibrate: true, volume: 1 });

    // The loudness survives the round-trip too (REQ-A205).
    saveSound({ ring: true, vibrate: true, volume: 0.25 });
    expect(loadSound()).toEqual({ ring: true, vibrate: true, volume: 0.25 });

    // Saving garbage normalizes to defaults rather than persisting junk.
    saveSound({ ring: "x" } as unknown as SoundPolicy);
    expect(loadSound()).toEqual(DEFAULT_SOUND);
    expect(globalThis.window && (window as unknown as Record<string, unknown>).localStorage).toBeTruthy();
    expect(SOUND_KEY).toBe("amos.sound");
  });

  test("saveSound returns the store's verdict — false (and nothing persisted) when it refuses", () => {
    // The policy has readers other than the page that writes it (the arrival ring/haptic and
    // the incoming-call path), so a caller must be able to see a refused write. A `void`
    // return made that structurally impossible; this pins the verdict now that it exists.
    const store = new Map<string, string>([["amos.sound", JSON.stringify({ ring: true, vibrate: true, volume: 1 })]]);
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: (k: string) => void store.delete(k),
      },
      dispatchEvent: () => false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    expect(saveSound({ ring: true, vibrate: false, volume: 1 })).toBe(false);
    // Nothing was persisted: the old policy is still exactly what a reader would load.
    expect(loadSound()).toEqual({ ring: true, vibrate: true, volume: 1 });

    // And a store that accepts the write answers true.
    const ok = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => ok.get(k) ?? null,
        setItem: (k: string, v: string) => void ok.set(k, v),
        removeItem: (k: string) => void ok.delete(k),
      },
      dispatchEvent: () => false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    expect(saveSound({ ring: true, vibrate: false, volume: 1 })).toBe(true);
    expect(loadSound()).toEqual({ ring: true, vibrate: false, volume: 1 });
  });
});
