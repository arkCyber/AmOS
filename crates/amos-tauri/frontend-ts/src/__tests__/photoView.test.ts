/**
 * Unit tests for lib/photoView.ts — the viewer's zoom/pan arithmetic.
 *
 * The model is pure, so every gesture is decided here rather than by driving a pointer in a
 * DOM (the screen's own wiring is covered by the svelte suite). The load-bearing property is
 * that a zoom **holds the pinned point**: the test computes the image coordinate under the
 * finger before and after and requires them to match.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  type View,
  type ViewBox,
  clampPan,
  clampZoom,
  defaultView,
  fitScale,
  imageBox,
  isZoomed,
  panBy,
  toggleZoom,
  zoomAt,
} from "../lib/photoView";

/** A 200×200 stage holding a 400×300 photo: fit = 0.5, so the photo fills the width. */
const box: ViewBox = { img: { w: 400, h: 300 }, stage: { w: 200, h: 200 } };

/** The image pixel under a stage point for a view — what a zoom must leave alone. */
function imagePointAt(v: View, px: number, py: number, b: ViewBox): { x: number; y: number } {
  const s = fitScale(b.img, b.stage) * v.zoom;
  return { x: (px - b.stage.w / 2 - v.x) / s, y: (py - b.stage.h / 2 - v.y) / s };
}

describe("photoView: fit and clamping", () => {
  test("fitScale contains the photo (and refuses to divide by an unmeasured frame)", () => {
    expect(fitScale({ w: 400, h: 300 }, { w: 200, h: 200 })).toBe(0.5);
    // Portrait: the height is the binding ratio.
    expect(fitScale({ w: 300, h: 400 }, { w: 200, h: 200 })).toBe(0.5);
    // A laid-out stage is required; an unmeasured one falls back to 1, never NaN/Infinity.
    expect(fitScale({ w: 400, h: 300 }, { w: 0, h: 200 })).toBe(1);
    expect(fitScale({ w: 0, h: 300 }, { w: 200, h: 200 })).toBe(1);
  });

  test("clampZoom pins the range and treats a non-finite factor as fit", () => {
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(0.2)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
    // A runaway factor (a pinch that divided by a zero distance) is "unusable", not "max".
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(MIN_ZOOM);
    expect(clampZoom(2)).toBe(2);
  });

  test("at fit the pan is pinned to zero on both axes", () => {
    expect(clampPan({ zoom: 1, x: 80, y: 80 }, box)).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  test("clampPan allows exactly enough travel to reach an edge once zoomed", () => {
    // zoom 2 → the 400×300 photo is shown at 400×300 in a 200×200 stage.
    expect(imageBox({ zoom: 2, x: 0, y: 0 }, box)).toEqual({ w: 400, h: 300 });
    expect(clampPan({ zoom: 2, x: 999, y: 999 }, box)).toEqual({ zoom: 2, x: 100, y: 50 });
    expect(clampPan({ zoom: 2, x: -999, y: -999 }, box)).toEqual({ zoom: 2, x: -100, y: -50 });
    // The axis that still fits keeps its zero even while the other pans.
    expect(clampPan({ zoom: 2, x: 0, y: 50 }, { img: { w: 100, h: 300 }, stage: { w: 200, h: 200 } }).x).toBe(0);
  });

  test("a non-finite offset resolves to centred, not to NaN everywhere", () => {
    expect(clampPan({ zoom: 2, x: Number.NaN, y: Number.NaN }, box)).toEqual({
      zoom: 2,
      x: 0,
      y: 0,
    });
  });
});

describe("photoView: gestures", () => {
  test("zoomAt holds the pinned image pixel under the finger", () => {
    // Only points whose required offset is inside the pan range can be held exactly; the
    // edge case (where the clamp wins) is the next test.
    for (const [px, py] of [
      [200, 100],
      [150, 100],
      [100, 100],
      [130, 140],
    ] as const) {
      const before = imagePointAt(defaultView(), px, py, box);
      const v = zoomAt(defaultView(), 2, px, py, box);
      const after = imagePointAt(v, px, py, box);
      expect(v.zoom).toBe(2);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  test("zoomAt near an edge gives up the pinned point rather than leaving the stage", () => {
    // Tapping near the bottom edge: holding the point would need y = -70, past the -50 the
    // clamp allows. The clamp wins — the result is the legal view closest to the request.
    const v = zoomAt(defaultView(), 2, 130, 170, box);
    expect(v).toEqual({ zoom: 2, x: -30, y: -50 });
    expect(imagePointAt(v, 130, 170, box).y).not.toBe(imagePointAt(defaultView(), 130, 170, box).y);
  });

  test("zoomAt at the ceiling does not drift, and always returns a legal view", () => {
    // A pinch at the top zoom ceiling: the ratio is 1, so the offset must not move.
    const at = { zoom: MAX_ZOOM, x: 100, y: 50 };
    expect(zoomAt(at, 2, 0, 0, box)).toEqual(clampPan(at, box));
    const v = zoomAt(defaultView(), 2, 0, 0, box);
    expect(v).toEqual(clampPan(v, box));
  });

  test("panBy slides by the delta and stops at the edge", () => {
    const v = { zoom: 2, x: 0, y: 0 };
    expect(panBy(v, 30, 10, box)).toEqual({ zoom: 2, x: 30, y: 10 });
    expect(panBy(v, 1e6, 1e6, box)).toEqual({ zoom: 2, x: 100, y: 50 });
    // At fit a drag is a no-op — there is nowhere to go.
    expect(panBy(defaultView(), 30, 30, box)).toEqual(defaultView());
  });

  test("toggleZoom magnifies about the tap, then returns to fit", () => {
    expect(toggleZoom(defaultView(), 100, 100, box)).toEqual({
      zoom: ZOOM_STEP,
      x: 0,
      y: 0,
    });
    // Already zoomed → back to fit, even though the pan happens to be centred.
    expect(toggleZoom({ zoom: ZOOM_STEP, x: 0, y: 0 }, 100, 100, box)).toEqual(defaultView());
    // A view panned by hand is still "zoomed": a tap resets rather than magnifying again.
    const panned = { zoom: 2, x: 40, y: 20 };
    expect(isZoomed(panned)).toBe(true);
    expect(toggleZoom(panned, 100, 100, box)).toEqual(defaultView());
  });

  test("isZoomed is false at fit only", () => {
    expect(isZoomed(defaultView())).toBe(false);
    expect(isZoomed({ zoom: 1.5, x: 0, y: 0 })).toBe(true);
  });
});
