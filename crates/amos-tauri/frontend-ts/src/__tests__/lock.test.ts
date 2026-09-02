import { describe, expect, test } from "bun:test";
import { makeLock, sanitizePin } from "../lib/lock";

describe("lock passcode", () => {
  test("sanitizePin keeps only digits and caps at 6", () => {
    expect(sanitizePin("12a34")).toBe("1234");
    expect(sanitizePin("1234567")).toBe("123456");
  });

  test("makeLock builds/keeps the config", () => {
    expect(makeLock(false, "123", { enabled: true, pin: "1" })).toEqual({ enabled: false });
    expect(makeLock(true, "123", { enabled: false })).toEqual({ enabled: true, pin: "123" });
    // empty input keeps the previous pin
    expect(makeLock(true, "", { enabled: true, pin: "0000" })).toEqual({ enabled: true, pin: "0000" });
  });
});
