/**
 * Unit tests for the durable sound-preference ledger (lib/soundPrefs) used by the
 * Settings「声音与触感」page. Verifies the corruption-guard normalize + immutable
 * flip helpers.
 */
import { describe, expect, test } from "vitest";
import {
  defaultSound,
  flipSound,
  normalizeSound,
} from "../lib/soundPrefs";

describe("soundPrefs", () => {
  test("default is audible-alert friendly (notify + haptics on)", () => {
    expect(defaultSound()).toEqual({ notify: true, haptics: true });
  });

  test("normalize tolerates garbage input", () => {
    expect(normalizeSound(null)).toEqual({ notify: true, haptics: true });
    expect(normalizeSound("nope")).toEqual({ notify: true, haptics: true });
    expect(normalizeSound([1])).toEqual({ notify: true, haptics: true });
    expect(normalizeSound(undefined)).toEqual({ notify: true, haptics: true });
  });

  test("normalize keeps only known booleans and fills unknown with defaults", () => {
    expect(normalizeSound({ notify: false })).toEqual({ notify: false, haptics: true });
    expect(normalizeSound({ notify: "yes", haptics: false, extra: 1 })).toEqual({
      notify: true,
      haptics: false,
    });
  });

  test("flipSound is immutable and toggles the requested key", () => {
    const base = defaultSound();
    const next = flipSound(base, "notify");
    expect(base).toEqual({ notify: true, haptics: true }); // original untouched
    expect(next).toEqual({ notify: false, haptics: true });

    const next2 = flipSound(next, "haptics");
    expect(next2).toEqual({ notify: false, haptics: false });
    expect(next).toEqual({ notify: false, haptics: true }); // still untouched
  });
});
