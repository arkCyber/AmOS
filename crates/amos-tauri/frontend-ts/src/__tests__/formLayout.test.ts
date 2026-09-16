import { describe, expect, test } from "bun:test";
import {
  appLibraryColumns,
  DESKTOP_MAX_COLS,
  DESKTOP_MAX_ROWS,
  deviceChrome,
  homeGrid,
  homeTile,
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

  test("desktop gets a Launchpad-class grid derived from the window it has", () => {
    // The Mac this work was measured on: a maximized shell window is 1496×881
    // (REQ-A233). 1496 ⇒ 8 columns at the 170 px pitch, (881−284) ⇒ 4 rows at 140.
    // Pinned as a *number*, not just a property: this is the geometry an operator
    // sees on that desktop, and a silent change to it should fail a test.
    expect(homeGrid("desktop", 1496, 881)).toEqual({ cols: 8, rows: 4 });
    expect(pageCapacity(homeGrid("desktop", 1496, 881))).toBe(32);
    // …and it really is denser than the phone grid it used to borrow.
    expect(pageCapacity(homeGrid("desktop", 1496, 881))).toBeGreaterThan(
      pageCapacity(PHONE_GRID),
    );
  });

  test("a desktop window never gets FEWER icons per page than a phone", () => {
    // A small desktop window is a real case (a Mac window can be resized down): the
    // answer must never be worse than the phone's, and never a zero/negative grid.
    for (const [w, h] of [
      [800, 600],
      [480, 820],
      [640, 400],
      [300, 200],
      [200, 1200],
    ] as Array<[number, number]>) {
      const g = homeGrid("desktop", w, h);
      expect(g.cols).toBeGreaterThanOrEqual(PHONE_GRID.cols);
      expect(g.rows).toBeGreaterThanOrEqual(PHONE_GRID.rows);
    }
    expect(homeGrid("desktop", 800, 600)).toEqual(PHONE_GRID);
  });

  test("the desktop grid is bounded and monotonic in the window size", () => {
    expect(homeGrid("desktop", 100_000, 100_000)).toEqual({
      cols: DESKTOP_MAX_COLS,
      rows: DESKTOP_MAX_ROWS,
    });
    // Wider is never fewer columns; taller is never fewer rows.
    let last = 0;
    for (const w of [600, 900, 1200, 1496, 1920, 2560]) {
      const cols = homeGrid("desktop", w, 1000).cols;
      expect(cols).toBeGreaterThanOrEqual(last);
      last = cols;
    }
  });

  test("an unmeasured desktop screen degrades to the phone grid, never a guess", () => {
    for (const [w, h] of [
      [0, 0],
      [0, 881],
      [1496, 0],
      [-1, -1],
      [Number.NaN, 881],
      [1496, Number.POSITIVE_INFINITY],
    ]) {
      expect(homeGrid("desktop", w as number, h as number)).toEqual(PHONE_GRID);
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
        // Class-aware ceiling: the desktop may go up to its own caps, every other
        // class stays within the iPad/phone densities.
        expect(g.cols).toBeLessThanOrEqual(form === "desktop" ? DESKTOP_MAX_COLS : 6);
        expect(g.rows).toBeLessThanOrEqual(DESKTOP_MAX_ROWS);
        expect(pageCapacity(g)).toBe(g.cols * g.rows);
        // No class ever pages *less* densely than the phone, whatever it is told.
        expect(g.cols).toBeGreaterThanOrEqual(PHONE_GRID.cols);
        expect(g.rows).toBeGreaterThanOrEqual(PHONE_GRID.rows);
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

describe("homeTile — a desktop Launcher draws Launchpad-class tiles", () => {
  test("only the desktop is `large`; every other class keeps today's tiles", () => {
    expect(homeTile("desktop")).toBe("large");
    for (const form of ["phone", "tablet", "robot"] as FormFactor[]) {
      expect(homeTile(form)).toBe("regular");
    }
  });
});

describe("deviceChrome — do not draw another device's hardware", () => {
  test("the Dynamic Island is iPhone hardware: only the phone gets it", () => {
    // It was drawn unconditionally, so a maximized macOS window showed a black pill
    // that stands for an iPhone 14 Pro screen cutout — hardware that is not there.
    // An iPad has none either (iPadOS has no Dynamic Island).
    expect(deviceChrome("phone").dynamicIsland).toBe(true);
    for (const form of ["tablet", "desktop", "robot"] as FormFactor[]) {
      expect(deviceChrome(form).dynamicIsland).toBe(false);
    }
  });

  test("the home indicator is a touch gesture bar: touch classes only", () => {
    expect(deviceChrome("phone").homeIndicator).toBe(true);
    expect(deviceChrome("tablet").homeIndicator).toBe(true);
    // A macOS window has no gesture bar; its way back is the toolbar control.
    expect(deviceChrome("desktop").homeIndicator).toBe(false);
    // The robot class has no UI at all (`FormFactor::has_ui()`), so it gets neither.
    expect(deviceChrome("robot")).toEqual({
      dynamicIsland: false,
      homeIndicator: false,
      titleBar: false,
    });
  });

  test("only a desktop window has an OS title bar to put a name in (REQ-A250)", () => {
    expect(deviceChrome("desktop").titleBar).toBe(true);
    for (const form of ["phone", "tablet", "robot"] as FormFactor[]) {
      expect(deviceChrome(form).titleBar).toBe(false);
    }
  });

  test("every class gets an answer (no field left to a caller's guess)", () => {
    for (const form of FORMS) {
      const chrome = deviceChrome(form);
      expect(typeof chrome.dynamicIsland).toBe("boolean");
      expect(typeof chrome.homeIndicator).toBe("boolean");
      expect(typeof chrome.titleBar).toBe("boolean");
    }
  });
});

describe("appLibraryColumns — the library surface scales with the class (REQ-A289)", () => {
  test("phone keeps today's 4 columns (no UI drift on existing devices)", () => {
    expect(appLibraryColumns("phone")).toBe(4);
  });

  test("tablet widens to 6 columns (iPadOS App-Library density)", () => {
    // The audit (REQ-A289) found the App Library surface rendering on a tablet was
    // still 4 columns wide — REQ-A234 wired the *home* grid for tablet but not the
    // library. iPadOS uses 6; the screen real estate on a 900x1200 tablet is otherwise
    // wasted as a half-empty 4-col grid.
    expect(appLibraryColumns("tablet")).toBe(6);
  });

  test("desktop widens further (matches Launchpad-class capacity, capped by the desktop cap)", () => {
    // Pinned to DESKTOP_MAX_COLS rather than a magic number: this is the same cap
    // `homeGrid` honors, so the library and the launcher stay in step.
    expect(appLibraryColumns("desktop")).toBe(DESKTOP_MAX_COLS);
  });

  test("robot has no UI, so its library column count is the phone's (never zero)", () => {
    expect(appLibraryColumns("robot")).toBe(4);
  });

  test("the column count is a positive integer for every class", () => {
    for (const form of FORMS) {
      const n = appLibraryColumns(form);
      expect(Number.isInteger(n) && n >= 1).toBe(true);
    }
  });
});
