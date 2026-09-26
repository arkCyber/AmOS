/**
 * slideOver.test.ts — the pure decode half of the shell's durable Slide Over intent.
 *
 * `parseSlideOver` is where the honest boundary lives (REQ-A675): a stored panel is
 * only returned when its app is still available, so an uninstalled app or a
 * hand-edited `amos.slideOver` yields `null` instead of a panel the shell would have
 * to render as a pane of nothing. These are pure-function tests — the store round-trip
 * and the host-rect wiring are pinned in the svelte suites.
 */
import { describe, expect, test } from "bun:test";
import {
  clampSlidePercent,
  encodeSlideOver,
  parseSlideOver,
  SLIDE_OVER_AXES,
  SLIDE_OVER_KEY,
  SLIDE_PERCENT_DEFAULT,
  SLIDE_PERCENT_MAX,
  SLIDE_PERCENT_MIN,
} from "../lib/slideOver";

const APPS = ["notes", "photos", "calendar"];

describe("slideOver — the key and the band", () => {
  test("the store key is namespaced like its neighbours", () => {
    expect(SLIDE_OVER_KEY).toBe("amos.slideOver");
  });

  test("the band is narrower than a split's — a floating panel, not a second pane", () => {
    // Below ~15% is a sliver; above ~60% has stopped floating *over* the app.
    expect(SLIDE_PERCENT_MIN).toBe(15);
    expect(SLIDE_PERCENT_MAX).toBe(60);
    expect(SLIDE_PERCENT_MIN).toBeLessThan(SLIDE_PERCENT_MAX);
    expect(SLIDE_PERCENT_DEFAULT).toBeGreaterThanOrEqual(SLIDE_PERCENT_MIN);
    expect(SLIDE_PERCENT_DEFAULT).toBeLessThanOrEqual(SLIDE_PERCENT_MAX);
  });

  test("the axis allowlist is the three the host accepts", () => {
    expect([...SLIDE_OVER_AXES]).toEqual(["vertical", "horizontal", "auto"]);
  });
});

describe("clampSlidePercent — one clamp for every share", () => {
  test("values are pulled into the band", () => {
    expect(clampSlidePercent(0)).toBe(SLIDE_PERCENT_MIN);
    expect(clampSlidePercent(-5)).toBe(SLIDE_PERCENT_MIN);
    expect(clampSlidePercent(15)).toBe(15);
    expect(clampSlidePercent(60)).toBe(60);
    expect(clampSlidePercent(61)).toBe(SLIDE_PERCENT_MAX);
    expect(clampSlidePercent(9999)).toBe(SLIDE_PERCENT_MAX);
  });

  test("a non-number or non-finite value is the conservative fresh-panel default", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "33", null, undefined, {}]) {
      expect(clampSlidePercent(bad)).toBe(SLIDE_PERCENT_DEFAULT);
    }
  });

  test("it rounds, and the answer is always an integer in band", () => {
    expect(clampSlidePercent(33.6)).toBe(34);
    for (const p of [-1e9, 33.5, 1e9, 0.4, 100]) {
      const r = clampSlidePercent(p);
      expect(Number.isInteger(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(SLIDE_PERCENT_MIN);
      expect(r).toBeLessThanOrEqual(SLIDE_PERCENT_MAX);
    }
  });
});

describe("parseSlideOver — decode only what can still be shown", () => {
  test("a well-formed installed app decodes verbatim", () => {
    expect(parseSlideOver({ id: "notes", axis: "horizontal", percent: 40 }, APPS)).toEqual({
      id: "notes",
      axis: "horizontal",
      percent: 40,
    });
  });

  test("an unavailable app refuses the WHOLE panel (never a partial intent)", () => {
    expect(parseSlideOver({ id: "ghost", axis: "auto", percent: 33 }, APPS)).toBeNull();
  });

  test("a non-object, a missing id and an empty id all refuse", () => {
    for (const raw of [null, undefined, 5, "notes", {}, { id: 7 }, { id: "" }]) {
      expect(parseSlideOver(raw, APPS)).toBeNull();
    }
  });

  test("an unknown axis falls back to auto and a bad share to the clamped default", () => {
    expect(parseSlideOver({ id: "notes", axis: "diagonal", percent: "wide" }, APPS)).toEqual({
      id: "notes",
      axis: "auto",
      percent: SLIDE_PERCENT_DEFAULT,
    });
    // An out-of-band share is clamped, not refused (recoverable, unlike a missing app).
    expect(parseSlideOver({ id: "photos", axis: "vertical", percent: 99 }, APPS)?.percent).toBe(
      SLIDE_PERCENT_MAX,
    );
  });

  test("encodeSlideOver clamps the share on the write path", () => {
    expect(encodeSlideOver({ id: "notes", axis: "auto", percent: 5 })).toEqual({
      id: "notes",
      axis: "auto",
      percent: SLIDE_PERCENT_MIN,
    });
    expect(encodeSlideOver({ id: "notes", axis: "auto", percent: 50 })).toEqual({
      id: "notes",
      axis: "auto",
      percent: 50,
    });
  });
});
