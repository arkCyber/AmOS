/**
 * splitPersist.test.ts — the pure decode half of the shell's durable split intent.
 *
 * `parseSplit` is where the honest boundary lives (REQ-A512 boundary ③): a stored
 * split is only returned when **both** pane apps are still available, so an
 * uninstalled app or a hand-edited `amos.split` yields `null` instead of a split the
 * shell would have to render as one pane of nothing. These are pure-function tests —
 * the store round-trip is pinned separately in `svelte-tests/shell-state.svelte.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  clampSplitPercent,
  encodeSplit,
  isSplittablePair,
  parseSplit,
  SPLIT_AXES,
  SPLIT_KEY,
  SPLIT_PERCENT_MAX,
  SPLIT_PERCENT_MIN,
} from "../lib/splitPersist";

const APPS = ["notes", "photos", "calendar"];

describe("clampSplitPercent — one clamp for every ratio", () => {
  test("the live range is 1..=99 (a pane may never reach zero width)", () => {
    expect(clampSplitPercent(0)).toBe(SPLIT_PERCENT_MIN);
    expect(clampSplitPercent(-5)).toBe(SPLIT_PERCENT_MIN);
    expect(clampSplitPercent(1)).toBe(1);
    expect(clampSplitPercent(99)).toBe(99);
    expect(clampSplitPercent(100)).toBe(SPLIT_PERCENT_MAX);
    expect(clampSplitPercent(9999)).toBe(SPLIT_PERCENT_MAX);
  });

  test("a non-number or non-finite value is the conservative fresh-split 50", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "50", null, undefined, {}]) {
      expect(clampSplitPercent(bad)).toBe(50);
    }
  });

  test("it rounds, and the answer is always an integer in range", () => {
    expect(clampSplitPercent(33.6)).toBe(34);
    for (const p of [-1e9, 50.5, 1e9, 0.4]) {
      const r = clampSplitPercent(p);
      expect(Number.isInteger(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(SPLIT_PERCENT_MIN);
      expect(r).toBeLessThanOrEqual(SPLIT_PERCENT_MAX);
    }
  });
});

describe("parseSplit — decode only what can still be shown", () => {
  test("a well-formed pair of installed apps decodes verbatim", () => {
    expect(parseSplit({ primary: "notes", secondary: "photos", axis: "horizontal", percent: 40 }, APPS)).toEqual({
      primary: "notes",
      secondary: "photos",
      axis: "horizontal",
      percent: 40,
    });
  });

  test("an unavailable pane app refuses the WHOLE split (never a partial intent)", () => {
    // The honest boundary: there is no app to put in the pane, so there is no split.
    expect(parseSplit({ primary: "notes", secondary: "ghost", axis: "auto", percent: 50 }, APPS)).toBeNull();
    expect(parseSplit({ primary: "ghost", secondary: "photos", axis: "auto", percent: 50 }, APPS)).toBeNull();
  });

  test("a non-object, a missing id, or a self-split is refused", () => {
    for (const bad of [
      null,
      undefined,
      "notes",
      42,
      [],
      {},
      { primary: "notes" },
      { primary: "notes", secondary: 7 },
      { primary: 7, secondary: "photos" },
      { primary: "notes", secondary: "notes" },
      { primary: "", secondary: "photos" },
      { primary: "notes", secondary: "" },
    ]) {
      expect(parseSplit(bad, APPS)).toBeNull();
    }
  });

  test("an unknown axis falls back to `auto` (defer to the host's class rule)", () => {
    expect(parseSplit({ primary: "notes", secondary: "photos", axis: "diagonal", percent: 50 }, APPS)?.axis).toBe(
      "auto",
    );
    expect(parseSplit({ primary: "notes", secondary: "photos", percent: 50 }, APPS)?.axis).toBe("auto");
  });

  test("every declared axis round-trips", () => {
    for (const axis of SPLIT_AXES) {
      expect(parseSplit({ primary: "notes", secondary: "photos", axis, percent: 50 }, APPS)?.axis).toBe(axis);
    }
  });

  test("an absent or out-of-range percent clamps rather than refusing", () => {
    // Recoverable nuances (axis/percent) default; an unavailable pane is not.
    expect(parseSplit({ primary: "notes", secondary: "photos" }, APPS)?.percent).toBe(50);
    expect(parseSplit({ primary: "notes", secondary: "photos", percent: 0 }, APPS)?.percent).toBe(1);
    expect(parseSplit({ primary: "notes", secondary: "photos", percent: 100 }, APPS)?.percent).toBe(99);
  });

  test("the empty availability set refuses everything (an empty install has no split)", () => {
    expect(parseSplit({ primary: "notes", secondary: "photos", axis: "auto", percent: 50 }, [])).toBeNull();
  });
});

describe("encodeSplit — the writer's shape, clamped", () => {
  test("it clamps the percent so the writer cannot store a degenerate ratio", () => {
    expect(encodeSplit({ primary: "a", secondary: "b", axis: "auto", percent: 0 })).toEqual({
      primary: "a",
      secondary: "b",
      axis: "auto",
      percent: 1,
    });
  });

  test("whatever encodeSplit writes, parseSplit accepts (round-trip on live ids)", () => {
    const written = encodeSplit({ primary: "notes", secondary: "photos", axis: "vertical", percent: 250 });
    expect(parseSplit(written, APPS)).toEqual({
      primary: "notes",
      secondary: "photos",
      axis: "vertical",
      percent: 99,
    });
  });
});

describe("isSplittablePair — the one rule for what two panes may hold", () => {
  test("two distinct, non-empty ids are a pair", () => {
    expect(isSplittablePair("notes", "photos")).toBe(true);
    expect(isSplittablePair("store:com.x", "notes")).toBe(true);
  });

  test("the same app twice is not a pair (one app painted twice, not two panes)", () => {
    expect(isSplittablePair("notes", "notes")).toBe(false);
  });

  test("an empty id is not a pair, on either side", () => {
    expect(isSplittablePair("", "photos")).toBe(false);
    expect(isSplittablePair("notes", "")).toBe(false);
    expect(isSplittablePair("", "")).toBe(false);
  });

  test("it is exactly the rule parseSplit applies to a decoded pair", () => {
    // The decode half must not be stricter or looser than the live doors.
    const cases: [string, string][] = [
      ["notes", "photos"],
      ["notes", "notes"],
      ["", "photos"],
      ["notes", ""],
    ];
    for (const [a, b] of cases) {
      const decoded = parseSplit({ primary: a, secondary: b, axis: "auto", percent: 50 }, [a, b]);
      expect(decoded !== null).toBe(isSplittablePair(a, b));
    }
  });
});

describe("SPLIT_KEY — the one key name", () => {
  test("it is the documented amos.* key the store gate classifies", () => {
    expect(SPLIT_KEY).toBe("amos.split");
  });
});
