import { describe, expect, test } from "bun:test";
import { fmtCallDuration, MAX_DIAL_LEN, pushKey } from "../lib/phone";

describe("fmtCallDuration (pure)", () => {
  test("under a minute is m:ss", () => {
    expect(fmtCallDuration(0)).toBe("0:00");
    expect(fmtCallDuration(5)).toBe("0:05");
    expect(fmtCallDuration(59)).toBe("0:59");
  });

  test("minutes", () => {
    expect(fmtCallDuration(60)).toBe("1:00");
    expect(fmtCallDuration(61)).toBe("1:01");
    expect(fmtCallDuration(600)).toBe("10:00");
  });

  test("past an hour is h:mm:ss", () => {
    expect(fmtCallDuration(3600)).toBe("1:00:00");
    expect(fmtCallDuration(3661)).toBe("1:01:01");
  });

  test("negative or fractional input is clamped deterministically", () => {
    expect(fmtCallDuration(-3)).toBe("0:00");
    expect(fmtCallDuration(90.9)).toBe("1:30");
  });

  test("pushKey never exceeds MAX_DIAL_LEN", () => {
    const full = "1".repeat(MAX_DIAL_LEN);
    expect(pushKey(full, "2")).toBe(full);
  });
});
