import { describe, expect, test } from "bun:test";
import {
  fmtOffsetMinutes,
  systemTimeZone,
  zoneDiff,
  zoneUtcOffsetMinutes,
} from "../lib/time";

// 2026-09-07 20:00:00 UTC — safely away from any DST transition.
const D = new Date(Date.UTC(2026, 8, 7, 20, 0, 0));

describe("world-clock diff helpers (pure, host-agnostic)", () => {
  test("zoneUtcOffsetMinutes reads real IANA offsets and rejects garbage", () => {
    expect(zoneUtcOffsetMinutes(D, "Asia/Tokyo")).toBe(540); // JST, no DST
    expect(zoneUtcOffsetMinutes(D, "Europe/London")).toBe(60); // BST in September
    expect(zoneUtcOffsetMinutes(D, "America/Los_Angeles")).toBe(-420); // PDT
    expect(zoneUtcOffsetMinutes(D, "Nope/Nowhere")).toBeNull(); // invalid zone
  });

  test("zoneDiff returns minutes-ahead + day-delta between two explicit zones", () => {
    // London 21:00 (09-07) vs Tokyo 05:00 next day (09-08) → +8 h, +1 day.
    expect(zoneDiff("Europe/London", "Asia/Tokyo", D)).toEqual({
      aheadMinutes: 480,
      dayDelta: 1,
    });
    // LA (09-07 13:00, PDT) vs Tokyo (09-08 05:00) → LA is 16 h behind, previous day.
    expect(zoneDiff("Asia/Tokyo", "America/Los_Angeles", D)).toEqual({
      aheadMinutes: -960,
      dayDelta: -1,
    });
    // Same zone → no offset, same day.
    expect(zoneDiff("Asia/Tokyo", "Asia/Tokyo", D)).toEqual({ aheadMinutes: 0, dayDelta: 0 });
    // Any invalid zone → null (UI hides the subtitle).
    expect(zoneDiff("Asia/Tokyo", "Bad/Zone", D)).toBeNull();
  });

  test("fmtOffsetMinutes drops whole-hour decimals and keeps half-hours", () => {
    expect(fmtOffsetMinutes(0)).toBe("0");
    expect(fmtOffsetMinutes(960)).toBe("16");
    expect(fmtOffsetMinutes(240)).toBe("4");
    expect(fmtOffsetMinutes(-330)).toBe("-5.5");
    expect(fmtOffsetMinutes(480)).toBe("8");
  });

  test("systemTimeZone returns a usable IANA name string", () => {
    const tz = systemTimeZone();
    expect(typeof tz).toBe("string");
    // Our zones are all valid on this runtime, so an empty local zone would
    // simply hide subtitles rather than crash — keep it a soft sanity check.
    if (tz) expect(zoneUtcOffsetMinutes(D, tz)).not.toBeNull();
  });
});
