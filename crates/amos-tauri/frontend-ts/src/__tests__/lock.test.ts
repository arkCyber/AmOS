import { describe, expect, test } from "bun:test";
import { makeLock, sanitizePin, validPin, PIN_MIN, PIN_MAX } from "../lib/lock";

describe("lock passcode", () => {
  test("sanitizePin keeps only digits and caps at 6", () => {
    expect(sanitizePin("12a34")).toBe("1234");
    expect(sanitizePin("1234567")).toBe("123456");
  });

  test("policy: 4-6 digit passcode", () => {
    expect(PIN_MIN).toBe(4);
    expect(PIN_MAX).toBe(6);
    expect(validPin("1234")).toBe(true);
    expect(validPin("123456")).toBe(true);
    expect(validPin("123")).toBe(false); // too short
    expect(validPin("12a34")).toBe(true); // non-digits stripped -> 1234
    expect(validPin("1234567")).toBe(true); // sanitize caps to 6 -> valid (UI also caps input)
  });

  test("makeLock disables and keeps a previous valid pin on empty input", () => {
    expect(makeLock(false, "1234", { enabled: true, pin: "0000" })).toEqual({ enabled: false });
    expect(makeLock(true, "", { enabled: true, pin: "0000" })).toEqual({ enabled: true, pin: "0000" });
  });

  test("makeLock enables only with a valid 4-6 digit pin", () => {
    expect(makeLock(true, "1234", { enabled: false })).toEqual({ enabled: true, pin: "1234" });
    expect(makeLock(true, "123456", { enabled: false })).toEqual({ enabled: true, pin: "123456" });
    // Changing an existing pin is validated too.
    expect(makeLock(true, "9999", { enabled: true, pin: "0000" })).toEqual({ enabled: true, pin: "9999" });
  });

  test("makeLock refuses to enable without a usable pin", () => {
    // Too-short new pin, no previous: refused (never an unlockable-less lock).
    expect(makeLock(true, "123", { enabled: false })).toEqual({ enabled: false });
    // Enabling with empty input and no previous pin: refused.
    expect(makeLock(true, "", { enabled: false })).toEqual({ enabled: false });
    // Invalid change keeps the previous valid pin.
    expect(makeLock(true, "12", { enabled: true, pin: "0000" })).toEqual({ enabled: true, pin: "0000" });
  });
});
