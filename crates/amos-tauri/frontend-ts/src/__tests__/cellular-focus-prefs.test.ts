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
  test("exposes the two intent scenarios and an all-off default (DND is NOT an intent — it is the quick-settings bit)", () => {
    expect(FOCUS_SCENARIOS).toEqual(["work", "sleep"]);
    expect(defaultFocus()).toEqual({ work: false, sleep: false });
  });

  test("normalize keeps only intent booleans; the legacy decorative dnd field is dropped, never converted", () => {
    expect(normalizeFocus(null)).toEqual({ work: false, sleep: false });
    expect(normalizeFocus({ work: true })).toEqual({ work: true, sleep: false });
    // REQ-A206: a pre-fix store's `dnd` field never had any effect, so it is
    // dropped on read (byte-identical behaviour) — NOT auto-applied as real DND
    // (that would newly silence a device on upgrade).
    expect(normalizeFocus({ dnd: true, sleep: true, extra: 1 })).toEqual({
      work: false,
      sleep: true,
    });
  });

  test("toggleFocus is immutable and flips one scenario", () => {
    const base = defaultFocus();
    const next = toggleFocus(base, "work");
    expect(base).toEqual({ work: false, sleep: false }); // untouched
    expect(next).toEqual({ work: true, sleep: false });
    expect(toggleFocus(next, "work")).toEqual(defaultFocus()); // can toggle back off
  });
});
