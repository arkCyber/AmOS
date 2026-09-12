import { describe, expect, test } from "bun:test";
import { dialableQuery, fmtCallDuration, MAX_DIAL_LEN, pushKey } from "../lib/phone";

describe("dialableQuery (Spotlight's dial action)", () => {
  test("accepts a real number, separators stripped", () => {
    expect(dialableQuery("10086")).toBe("10086");
    expect(dialableQuery("+86 138-0000-0000")).toBe("+8613800000000");
    expect(dialableQuery("(010) 1234 5678")).toBe("01012345678");
    expect(dialableQuery(" *100# ")).toBe("*100#");
  });

  test("refuses anything that is not a number (no pretending)", () => {
    expect(dialableQuery("")).toBeNull();
    expect(dialableQuery("   ")).toBeNull();
    expect(dialableQuery("买牛奶")).toBeNull();
    expect(dialableQuery("12abc")).toBeNull();
    expect(dialableQuery("1")).toBeNull(); // a single digit is not a number to dial
    expect(dialableQuery("+")).toBeNull();
  });

  test("caps the result at MAX_DIAL_LEN digits", () => {
    const long = "1".repeat(MAX_DIAL_LEN + 6);
    expect(dialableQuery(long)?.length).toBe(MAX_DIAL_LEN);
  });
});

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
