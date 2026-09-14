import { describe, expect, test } from "bun:test";
import {
  homeGrid,
  pageCapacity,
  PHONE_GRID,
  type HomeGrid,
} from "../lib/formLayout";
import type { FormFactor } from "../lib/wm";

const FORMS: FormFactor[] = ["phone", "tablet", "desktop", "robot"];

/** A few real-ish measured screens, including the unmeasured 0×0 fallback. */
const SCREENS: Array<[number, number]> = [
  [0, 0],
  [480, 820],
  [820, 480],
  [900, 1200],
  [1200, 900],
  [900, 900],
  [1496, 881],
];

describe("homeGrid — the phone path is byte-identical", () => {
  test("phone keeps the hard-coded 4×3 = 12 the component used before", () => {
    for (const [w, h] of SCREENS) {
      expect(homeGrid("phone", w, h)).toEqual({ cols: 4, rows: 3 });
    }
    expect(pageCapacity(PHONE_GRID)).toBe(12);
  });

  test("robot has no UI, so its inert grid is the phone's (never a zero grid)", () => {
    for (const [w, h] of SCREENS) {
      expect(homeGrid("robot", w, h)).toEqual(PHONE_GRID);
    }
  });

  test("desktop is deliberately out of scope and keeps the phone grid", () => {
    // The desktop window is already a real, freely resizable OS window; changing
    // its launcher density must not ride along with the tablet work (see the
    // module doc). Pinned here so the exclusion is a decision, not an oversight.
    for (const [w, h] of SCREENS) {
      expect(homeGrid("desktop", w, h)).toEqual(PHONE_GRID);
    }
  });
});

describe("homeGrid — the tablet gets iPadOS densities", () => {
  test("portrait is 4×6 (24 per page), landscape 6×4 (24 per page)", () => {
    expect(homeGrid("tablet", 900, 1200)).toEqual({ cols: 4, rows: 6 });
    expect(homeGrid("tablet", 1200, 900)).toEqual({ cols: 6, rows: 4 });
    expect(pageCapacity(homeGrid("tablet", 900, 1200))).toBe(24);
    expect(pageCapacity(homeGrid("tablet", 1200, 900))).toBe(24);
  });

  test("a square screen counts as portrait (same rule as split_axis)", () => {
    expect(homeGrid("tablet", 900, 900)).toEqual({ cols: 4, rows: 6 });
  });

  test("an unmeasured table screen degrades to the phone grid, never a guess", () => {
    // Mirrors `LayoutPolicy::columns_for(0) == 1`: an unmeasured screen gets the
    // most conservative answer rather than an invented tablet density.
    for (const [w, h] of [
      [0, 0],
      [0, 1200],
      [900, 0],
      [-1, -1],
      [Number.NaN, 1200],
      [900, Number.POSITIVE_INFINITY],
    ]) {
      expect(homeGrid("tablet", w as number, h as number)).toEqual(PHONE_GRID);
    }
  });
});

describe("homeGrid / pageCapacity — invariants over every class and screen", () => {
  test("pages are always non-empty and bounded by iPad/phone densities", () => {
    for (const form of FORMS) {
      for (const [w, h] of SCREENS) {
        const g: HomeGrid = homeGrid(form, w, h);
        expect(Number.isInteger(g.cols) && g.cols >= 1).toBe(true);
        expect(Number.isInteger(g.rows) && g.rows >= 1).toBe(true);
        expect(g.cols).toBeLessThanOrEqual(6);
        expect(g.rows).toBeLessThanOrEqual(6);
        expect(pageCapacity(g)).toBe(g.cols * g.rows);
      }
    }
  });

  test("the plan is a pure function of its inputs", () => {
    for (const form of FORMS) {
      for (const [w, h] of SCREENS) {
        expect(homeGrid(form, w, h)).toEqual(homeGrid(form, w, h));
      }
    }
  });
});
