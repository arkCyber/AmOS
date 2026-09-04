import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_SOUND,
  effectiveAlert,
  loadSound,
  normalizeSound,
  saveSound,
  shouldVibrateOnArrival,
  shouldRingOnArrival,
  SOUND_KEY,
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
  test("normalizeSound defaults to ON and keeps only booleans", () => {
    expect(normalizeSound(null)).toEqual(DEFAULT_SOUND);
    expect(normalizeSound(undefined)).toEqual(DEFAULT_SOUND);
    expect(normalizeSound([1])).toEqual(DEFAULT_SOUND);
    expect(normalizeSound({})).toEqual(DEFAULT_SOUND);
    expect(normalizeSound({ ring: false })).toEqual({ ring: false, vibrate: true });
    expect(normalizeSound({ ring: false, vibrate: false })).toEqual({
      ring: false,
      vibrate: false,
    });
    expect(normalizeSound({ ring: "no", vibrate: true })).toEqual({ ring: true, vibrate: true });
  });

  test("effectiveAlert mutes both when DND is active, otherwise passes through", () => {
    const policy = { ring: true, vibrate: true };
    expect(effectiveAlert(policy, false)).toEqual(policy);
    expect(effectiveAlert(policy, true)).toEqual({ ring: false, vibrate: false });

    const vibOnly = { ring: false, vibrate: true };
    expect(effectiveAlert(vibOnly, false)).toEqual(vibOnly);
    expect(effectiveAlert(vibOnly, true)).toEqual({ ring: false, vibrate: false });
  });

  test("shouldVibrateOnArrival requires growth AND allowed vibration", () => {
    const normal = { ring: true, vibrate: true };
    expect(shouldVibrateOnArrival(2, 3, normal)).toBe(true); // growth + allowed
    expect(shouldVibrateOnArrival(3, 3, normal)).toBe(false); // no growth
    expect(shouldVibrateOnArrival(3, 2, normal)).toBe(false); // shrink
    expect(shouldVibrateOnArrival(0, 1, normal)).toBe(true); // first arrival

    // DND mutes vibration (effective all-false).
    const dnd = { ring: false, vibrate: false };
    expect(shouldVibrateOnArrival(2, 3, dnd)).toBe(false);
    // Policy with vibration off but ring on.
    const ringOnly = { ring: true, vibrate: false };
    expect(shouldVibrateOnArrival(2, 3, ringOnly)).toBe(false);
  });

  test("shouldRingOnArrival requires growth AND audible alerts allowed", () => {
    const normal = { ring: true, vibrate: true };
    expect(shouldRingOnArrival(1, 2, normal)).toBe(true); // growth + ring allowed
    expect(shouldRingOnArrival(2, 2, normal)).toBe(false); // no growth
    expect(shouldRingOnArrival(0, 1, normal)).toBe(true); // first arrival
    // DND mutes ring; vibrate-only policy has ring off.
    const dnd = { ring: false, vibrate: false };
    expect(shouldRingOnArrival(1, 2, dnd)).toBe(false);
    const vibOnly = { ring: false, vibrate: true };
    expect(shouldRingOnArrival(1, 2, vibOnly)).toBe(false);
  });

  test("saveSound/loadSound round-trips through the store and normalizes", () => {
    fakeWindow();
    saveSound({ ring: false, vibrate: true });
    expect(loadSound()).toEqual({ ring: false, vibrate: true });

    // Saving garbage normalizes to defaults rather than persisting junk.
    saveSound({ ring: "x" } as unknown as { ring: boolean; vibrate: boolean });
    expect(loadSound()).toEqual(DEFAULT_SOUND);
    expect(globalThis.window && (window as unknown as Record<string, unknown>).localStorage).toBeTruthy();
    expect(SOUND_KEY).toBe("amos.sound");
  });
});
