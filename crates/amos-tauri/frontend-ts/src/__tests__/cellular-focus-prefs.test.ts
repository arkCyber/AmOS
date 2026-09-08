/**
 * Unit tests for the two preference ledgers that power the Settings「蜂窝网络」and
 * 「专注模式」pages: lib/cellular (data + roaming) and lib/focusPrefs (scenarios).
 * Verifies the corruption-guard normalizers + immutable flip/toggle helpers.
 */
import { describe, expect, test } from "vitest";
import {
  defaultCellular,
  flipCellular,
  normalizeCellular,
} from "../lib/cellular";
import {
  FOCUS_SCENARIOS,
  defaultFocus,
  normalizeFocus,
  toggleFocus,
} from "../lib/focusPrefs";

describe("cellular prefs", () => {
  test("default: data on, roaming off (a safe phone default)", () => {
    expect(defaultCellular()).toEqual({ data: true, roaming: false });
  });

  test("normalize tolerates garbage input", () => {
    for (const v of [null, undefined, "x", [1], 42]) {
      expect(normalizeCellular(v)).toEqual({ data: true, roaming: false });
    }
  });

  test("normalize keeps known booleans and fills unknown with defaults", () => {
    expect(normalizeCellular({ data: false })).toEqual({ data: false, roaming: false });
    expect(normalizeCellular({ roaming: true, data: "yes", extra: 1 })).toEqual({
      data: true,
      roaming: true,
    });
  });

  test("flipCellular is immutable and toggles the requested key", () => {
    const base = defaultCellular();
    const next = flipCellular(base, "roaming");
    expect(base).toEqual({ data: true, roaming: false }); // untouched
    expect(next).toEqual({ data: true, roaming: true });
  });
});

describe("focus prefs", () => {
  test("exposes the three scenarios and an all-off default", () => {
    expect(FOCUS_SCENARIOS).toEqual(["dnd", "work", "sleep"]);
    expect(defaultFocus()).toEqual({ dnd: false, work: false, sleep: false });
  });

  test("normalize keeps only known scenario booleans (default off)", () => {
    expect(normalizeFocus(null)).toEqual({ dnd: false, work: false, sleep: false });
    expect(normalizeFocus({ work: true })).toEqual({ dnd: false, work: true, sleep: false });
    // unknown keys / non-booleans are dropped
    expect(normalizeFocus({ dnd: "yes", sleep: true, extra: true })).toEqual({
      dnd: false,
      work: false,
      sleep: true,
    });
  });

  test("toggleFocus is immutable and flips one scenario", () => {
    const base = defaultFocus();
    const next = toggleFocus(base, "work");
    expect(base).toEqual({ dnd: false, work: false, sleep: false }); // untouched
    expect(next).toEqual({ dnd: false, work: true, sleep: false });
    expect(toggleFocus(next, "work")).toEqual(defaultFocus()); // can toggle back off
  });
});
