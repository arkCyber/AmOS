import { describe, expect, test } from "bun:test";
import { batteryPercent, fmtClock } from "../lib/time";

describe("time / status bar", () => {
  test("fmtClock pads hours/minutes", () => {
    expect(fmtClock(new Date(2024, 0, 1, 9, 5))).toBe("09:05");
    expect(fmtClock(new Date(2024, 0, 1, 23, 59))).toBe("23:59");
  });

  test("batteryPercent counts down with the seconds", () => {
    expect(batteryPercent(new Date(2024, 0, 1, 0, 0, 0))).toBe(100);
    expect(batteryPercent(new Date(2024, 0, 1, 0, 0, 30))).toBe(70);
  });
});
