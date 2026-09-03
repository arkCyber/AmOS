import { describe, expect, test } from "bun:test";
import { capTail } from "../lib/bounded";

describe("capTail", () => {
  test("keeps the most recent items and drops the oldest", () => {
    expect(capTail([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });

  test("returns a copy when within bounds and never mutates the input", () => {
    const src = [1, 2];
    const out = capTail(src, 10);
    expect(out).toEqual([1, 2]);
    expect(out).not.toBe(src); // non-mutating copy
  });

  test("handles empty list and non-positive caps", () => {
    expect(capTail([], 5)).toEqual([]);
    expect(capTail([1, 2], 0)).toEqual([]);
    expect(capTail([1, 2], -1)).toEqual([]);
  });

  test("handles huge lists and degenerate caps without throwing", () => {
    const big = Array.from({ length: 50_000 }, (_, i) => i);
    const tail = capTail(big, 10);
    expect(tail).toEqual([49990, 49991, 49992, 49993, 49994, 49995, 49996, 49997, 49998, 49999]);
    // NaN cap is not <=0 → behaves like "no cap" (copies all), stays finite
    const nanOut = capTail([1, 2, 3], Number.NaN);
    expect(nanOut).toEqual([1, 2, 3]);
    expect(nanOut.every((v) => Number.isFinite(v))).toBe(true);
  });
});
