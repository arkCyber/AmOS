import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TONE,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MAX_TONE,
  MIN_TONE,
  LENS_R,
  clamp,
  clampCenter,
  centredLens,
  defaultMagnifierSettings,
  lensSourceRadius,
  normalizeMagnifierSettings,
  toneFactor,
  toneFilter,
} from "../lib/magnifier";

// Pure geometry/tone unit tests for the Magnifier lens math (no DOM needed).
describe("magnifier lens geometry", () => {
  test("clamp stays within [lo, hi]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(20, 0, 10)).toBe(10);
  });

  test("clampCenter keeps an in-bounds centre as-is", () => {
    expect(clampCenter(200, 400, 400, 800)).toEqual({ x: 200, y: 400 });
  });

  test("clampCenter pulls out-of-bounds centres to the edge so the circle fits", () => {
    expect(clampCenter(-100, 50, 400, 800)).toEqual({ x: LENS_R, y: LENS_R });
    expect(clampCenter(500, 900, 400, 800)).toEqual({
      x: 400 - LENS_R,
      y: 800 - LENS_R,
    });
  });

  test("clampCenter is stable on a degenerate (zero) viewport", () => {
    // With no room the lens pins to its own radius so it never leaves the canvas.
    expect(clampCenter(5, 5, 0, 0)).toEqual({ x: LENS_R, y: LENS_R });
    // Exactly wide enough for one lens: the centre is forced to the only valid spot.
    expect(clampCenter(100, 0, LENS_R * 2, LENS_R * 2)).toEqual({
      x: LENS_R,
      y: LENS_R,
    });
  });

  test("clampCenter output always keeps the lens inside the viewport (property)", () => {
    const w = 320;
    const h = 640;
    for (let x = -200; x <= 520; x += 10) {
      for (let y = -200; y <= 840; y += 10) {
        const { x: cx, y: cy } = clampCenter(x, y, w, h);
        expect(cx).toBeGreaterThanOrEqual(LENS_R);
        expect(cx).toBeLessThanOrEqual(w - LENS_R);
        expect(cy).toBeGreaterThanOrEqual(LENS_R);
        expect(cy).toBeLessThanOrEqual(h - LENS_R);
      }
    }
  });

  test("centredLens returns the (clamped) middle", () => {
    expect(centredLens(400, 800)).toEqual({ x: 200, y: 400 });
    expect(centredLens(0, 0)).toEqual({ x: LENS_R, y: LENS_R });
    // A short viewport clamps the vertical centre up to the lens radius.
    expect(centredLens(400, 100).y).toBe(LENS_R);
    expect(centredLens(400, 100).x).toBe(200);
  });
});

describe("magnifier lens sampling + tone", () => {
  test("source radius is lensRadius at 1× and shrinks as zoom grows", () => {
    expect(lensSourceRadius(1)).toBe(LENS_R);
    expect(lensSourceRadius(2)).toBe(LENS_R / 2);
    expect(lensSourceRadius(8)).toBe(LENS_R / 8);
  });

  test("sub-1× zoom and extreme zoom are bounded", () => {
    expect(lensSourceRadius(0.5)).toBe(LENS_R); // floored to 1×
    expect(lensSourceRadius(0)).toBe(LENS_R);
    expect(lensSourceRadius(1000)).toBe(0.5); // never samples a <0.5px slice
  });

  test("custom lens radius is honoured", () => {
    expect(lensSourceRadius(0, 200)).toBe(200);
    expect(lensSourceRadius(2, 200)).toBe(100);
  });

  test("toneFactor maps the declared percent range onto the declared factor range", () => {
    // The docs on MIN_TONE/MAX_TONE/DEFAULT_TONE promise 0–200% → factor 0–2 with
    // 100 = 1.0 (neutral); the floor keeps the lens from going fully black.
    expect(toneFactor(DEFAULT_TONE)).toBe(1);
    expect(toneFactor(MAX_TONE)).toBe(2);
    expect(toneFactor(MIN_TONE)).toBe(0.05);
    expect(toneFactor(150)).toBe(1.5);
    expect(toneFactor(50)).toBe(0.5);
    expect(toneFactor(-10)).toBe(0.05); // floored
    expect(toneFactor(9999)).toBe(2); // capped at the declared max
  });

  test("toneFilter renders the brightness/contrast percentages as factors", () => {
    expect(toneFilter(100, 100)).toBe("brightness(1) contrast(1)");
    expect(toneFilter(150, 20)).toBe("brightness(1.5) contrast(0.2)");
    expect(toneFilter(0, 200)).toBe("brightness(0.05) contrast(2)");
  });

  test("the tone sliders are not inert: the whole 0–200% travel changes the filter", () => {
    // Before REQ-A729 the component handed raw percentages to a factor-domain clamp,
    // so every position from 1% to 200% produced the identical `brightness(1)
    // contrast(1)`: the sliders moved a number nothing read. The travel must now
    // produce distinct filters (only 0 and 1 both floor to 0.05, so ≥9 of 10 distinct).
    const travel = [0, 20, 40, 60, 80, 100, 120, 140, 160, 200];
    const seen = new Set(travel.map((v) => toneFilter(v, v)));
    expect(seen.size).toBeGreaterThanOrEqual(9);
    // The neutral default is the one value that must read as "no change".
    expect(toneFilter(DEFAULT_TONE, DEFAULT_TONE)).toBe("brightness(1) contrast(1)");
  });
});

describe("magnifier persisted settings", () => {
  test("defaultMagnifierSettings is the neutral starting state", () => {
    expect(defaultMagnifierSettings()).toEqual({
      zoom: DEFAULT_ZOOM,
      brightness: DEFAULT_TONE,
      contrast: DEFAULT_TONE,
    });
  });

  test("normalize tolerates garbage/absent payloads → defaults (never throws)", () => {
    for (const bad of [undefined, null, 42, "nope", [], {}, { zoom: "x" }]) {
      expect(normalizeMagnifierSettings(bad)).toEqual(defaultMagnifierSettings());
    }
  });

  test("normalize passes valid in-range settings through", () => {
    expect(normalizeMagnifierSettings({ zoom: 4, brightness: 150, contrast: 80 })).toEqual({
      zoom: 4,
      brightness: 150,
      contrast: 80,
    });
  });

  test("normalize clamps out-of-range and drops non-finite values", () => {
    expect(normalizeMagnifierSettings({ zoom: 99, brightness: -5, contrast: 500 })).toEqual({
      zoom: MAX_ZOOM,
      brightness: 0,
      contrast: MAX_TONE,
    });
    expect(normalizeMagnifierSettings({ zoom: Number.NaN, brightness: Infinity, contrast: 50 })).toEqual({
      zoom: DEFAULT_ZOOM,
      brightness: DEFAULT_TONE,
      contrast: 50,
    });
  });
});
