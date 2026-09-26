import { describe, expect, test } from "bun:test";
import {
  ERASER_RADIUS,
  INK_DEFAULT_COLOR,
  INK_DEFAULT_WIDTH,
  INK_MAX_POINTS,
  INK_MAX_STROKES,
  INK_MAX_WIDTH,
  INK_MIN_WIDTH,
  appendPoint,
  classifyPointer,
  eraseAt,
  fitScale,
  inkEqual,
  noteHasInk,
  normalizeInk,
  sampleWidth,
  simplifyStroke,
  strokeHitRadius,
  strokePath,
  tiltMagnitude,
  toModelPoint,
  type InkPointerSample,
  type InkPoint,
} from "../ink";

/** A point with the given coordinates at full pressure and no tilt. */
function pt(x: number, y: number, p = 1, t = 0): InkPoint {
  return { x, y, p, t };
}

/** One straight two-sample stroke, the shape most geometry cases need. */
function line(pts: InkPoint[], width = 2) {
  return { tool: "pen" as const, color: "#000", width, pts };
}

function sample(over: Partial<InkPointerSample> = {}): InkPointerSample {
  return {
    pointerType: "touch",
    width: 0,
    height: 0,
    isPrimary: true,
    penActive: false,
    palmRejection: true,
    ...over,
  };
}

describe("normalizeInk", () => {
  test("rejects every non-object, non-layer and empty-layer shape as null", () => {
    expect(normalizeInk(undefined)).toBeNull();
    expect(normalizeInk(null)).toBeNull();
    expect(normalizeInk(42)).toBeNull();
    expect(normalizeInk("x")).toBeNull();
    expect(normalizeInk([])).toBeNull();
    expect(normalizeInk({})).toBeNull();
    expect(normalizeInk({ strokes: "no" })).toBeNull();
    // An explicitly empty layer normalizes to the single "no ink" sentinel, so a
    // caller never has to test two spellings of "nothing".
    expect(normalizeInk({ strokes: [] })).toBeNull();
    expect(normalizeInk({ strokes: [{ tool: "pen", pts: [] }] })).toBeNull();
    expect(normalizeInk({ strokes: [{ tool: "pen" }] })).toBeNull();
  });

  test("drops a malformed point without discarding its stroke", () => {
    const out = normalizeInk({
      strokes: [{ tool: "pen", pts: [{ x: 1, y: 2 }, { x: NaN, y: 3 }, { x: 4, y: 5 }] }],
    });
    expect(out?.strokes[0]?.pts).toHaveLength(2);
    expect(out?.strokes[0]?.pts.map((p) => p.x)).toEqual([1, 4]);
  });

  test("drops a stroke whose tool is unknown", () => {
    const out = normalizeInk({
      strokes: [
        { tool: "highlighter", pts: [pt(0, 0)] },
        { tool: "pen", pts: [pt(1, 1)] },
      ],
    });
    expect(out?.strokes).toHaveLength(1);
    expect(out?.strokes[0]?.pts[0]?.x).toBe(1);
  });

  test("clamps pressure and tilt into [0,1] and fills in a missing pair", () => {
    const out = normalizeInk({
      strokes: [{ tool: "pen", pts: [{ x: 0, y: 0, p: 5, t: -3 }, { x: 1, y: 1 }] }],
    });
    const pts = out?.strokes[0]?.pts;
    expect(pts?.[0]?.p).toBe(1);
    expect(pts?.[0]?.t).toBe(0);
    // Absent pressure is the midpoint (many devices report none), absent tilt is upright.
    expect(pts?.[1]?.p).toBe(0.5);
    expect(pts?.[1]?.t).toBe(0);
  });

  test("clamps width into the drawable range and defaults a bad one", () => {
    const out = normalizeInk({
      strokes: [
        { tool: "pen", pts: [pt(0, 0)], width: 999 },
        { tool: "pen", pts: [pt(1, 1)], width: 0.01 },
        { tool: "pen", pts: [pt(2, 2)], width: "thick" },
      ],
    });
    expect(out?.strokes[0]?.width).toBe(INK_MAX_WIDTH);
    expect(out?.strokes[1]?.width).toBe(INK_MIN_WIDTH);
    expect(out?.strokes[2]?.width).toBe(INK_DEFAULT_WIDTH);
  });

  test("falls back to the default color for an absent or empty one", () => {
    const out = normalizeInk({
      strokes: [
        { tool: "pen", pts: [pt(0, 0)] },
        { tool: "pen", pts: [pt(1, 1)], color: "" },
        { tool: "pen", pts: [pt(2, 2)], color: "#f00" },
      ],
    });
    expect(out?.strokes[0]?.color).toBe(INK_DEFAULT_COLOR);
    expect(out?.strokes[1]?.color).toBe(INK_DEFAULT_COLOR);
    expect(out?.strokes[2]?.color).toBe("#f00");
  });

  // A string coordinate is a *different* serialization, not a number with a costume on.
  // Coercing it would hide whichever writer produced it.
  test("refuses to coerce a string coordinate", () => {
    expect(normalizeInk({ strokes: [{ tool: "pen", pts: [{ x: "3", y: 0 }] }] })).toBeNull();
    const out = normalizeInk({
      strokes: [{ tool: "pen", pts: [{ x: "3", y: 0 }, { x: 3, y: 0 }] }],
    });
    expect(out?.strokes[0]?.pts).toHaveLength(1);
  });

  test("bounds the stroke count and the per-stroke point count", () => {
    const many = {
      strokes: Array.from({ length: INK_MAX_STROKES + 25 }, () => ({
        tool: "pen",
        pts: [pt(0, 0)],
      })),
    };
    expect(normalizeInk(many)?.strokes).toHaveLength(INK_MAX_STROKES);
    const long = {
      strokes: [{ tool: "pen", pts: Array.from({ length: INK_MAX_POINTS + 25 }, (_, i) => pt(i, 0)) }],
    };
    expect(normalizeInk(long)?.strokes[0]?.pts).toHaveLength(INK_MAX_POINTS);
  });

  test("keeps an unmeasured strip size as 0 rather than inventing one", () => {
    const out = normalizeInk({ strokes: [{ tool: "pen", pts: [pt(0, 0)] }] });
    expect(out?.w).toBe(0);
    expect(out?.h).toBe(0);
    const sized = normalizeInk({ w: 320, h: 480, strokes: [{ tool: "pen", pts: [pt(0, 0)] }] });
    expect(sized?.w).toBe(320);
    expect(sized?.h).toBe(480);
  });

  test("survives a JSON round trip unchanged", () => {
    const raw = {
      w: 300,
      h: 500,
      strokes: [
        { tool: "pen", color: "#123456", width: 3, pts: [pt(1, 2, 0.25, 0.5), pt(3, 4, 0.75, 0)] },
      ],
    };
    const norm = normalizeInk(raw);
    expect(norm).not.toBeNull();
    expect(normalizeInk(JSON.parse(JSON.stringify(norm)))).toEqual(norm);
  });
});

describe("sampleWidth", () => {
  test("is neutral at half pressure, so the chosen width is what you get", () => {
    expect(sampleWidth(0.5, 0, 2)).toBe(2);
    expect(sampleWidth(0.5, 0, 4)).toBe(4);
  });

  test("narrows below and broadens above the neutral width", () => {
    expect(sampleWidth(0, 0, 2)).toBe(1);
    expect(sampleWidth(1, 0, 2)).toBe(3);
  });

  test("returns the chosen base when the device reports no pressure", () => {
    expect(sampleWidth(NaN, 0, 3)).toBe(3);
    // A missing or nonsensical base falls back to the default rather than to 0.
    expect(sampleWidth(NaN, 0, 0)).toBe(INK_DEFAULT_WIDTH);
    expect(sampleWidth(NaN, 0, NaN)).toBe(INK_DEFAULT_WIDTH);
  });

  test("is monotonic in pressure and bounds an over-range reading", () => {
    const widths = [0, 0.25, 0.5, 0.75, 1].map((p) => sampleWidth(p, 0, 2));
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]!);
    }
    expect(sampleWidth(10, 0, 2)).toBe(sampleWidth(1, 0, 2));
    expect(sampleWidth(-4, 0, 2)).toBe(sampleWidth(0, 0, 2));
  });

  test("a laid-flat pen widens the stroke", () => {
    expect(sampleWidth(0.5, 1, 2)).toBeGreaterThan(sampleWidth(0.5, 0, 2));
    // …but never past the drawable ceiling.
    expect(sampleWidth(1, 1, 100)).toBe(INK_MAX_WIDTH);
    expect(sampleWidth(0, 0, 0.01)).toBe(INK_MIN_WIDTH);
  });
});

describe("tiltMagnitude", () => {
  test("is zero for an upright pen and clamps a flat one to one", () => {
    expect(tiltMagnitude(0, 0)).toBe(0);
    expect(tiltMagnitude(90, 90)).toBe(1);
    expect(tiltMagnitude(-90, -90)).toBe(1);
  });

  test("treats an unreported axis as no tilt, not as a guess", () => {
    expect(tiltMagnitude(NaN, 0)).toBe(0);
    expect(tiltMagnitude(0, NaN)).toBe(0);
  });

  test("grows with the tilt angle", () => {
    expect(tiltMagnitude(45, 0)).toBeGreaterThan(tiltMagnitude(20, 0));
  });
});

describe("appendPoint", () => {
  test("always keeps the first sample", () => {
    expect(appendPoint([], pt(5, 6))).toEqual([pt(5, 6)]);
  });

  test("drops a sample closer than the gate, keeping the same reference", () => {
    const pts = [pt(0, 0)];
    expect(appendPoint(pts, pt(0.1, 0))).toBe(pts);
  });

  test("appends a sample beyond the gate without mutating the input", () => {
    const pts = [pt(0, 0)];
    const out = appendPoint(pts, pt(10, 0));
    expect(out).toHaveLength(2);
    expect(pts).toHaveLength(1);
  });

  test("a non-positive gate admits every sample", () => {
    const pts = [pt(0, 0)];
    expect(appendPoint(pts, pt(0.01, 0), 0)).toHaveLength(2);
  });
});

describe("simplifyStroke", () => {
  test("collapses collinear interior samples but keeps both endpoints", () => {
    const out = simplifyStroke([pt(0, 0), pt(1, 0), pt(2, 0), pt(3, 0)]);
    expect(out.map((p) => p.x)).toEqual([0, 3]);
  });

  test("keeps a real corner", () => {
    const out = simplifyStroke([pt(0, 0), pt(0, 10), pt(10, 10)]);
    expect(out).toHaveLength(3);
  });

  test("returns short strokes and a zero tolerance untouched", () => {
    const two = [pt(0, 0), pt(1, 1)];
    expect(simplifyStroke(two)).toBe(two);
    const many = [pt(0, 0), pt(1, 0), pt(2, 0)];
    expect(simplifyStroke(many, 0)).toBe(many);
  });

  test("never turns a non-empty stroke into an empty one", () => {
    const out = simplifyStroke([pt(0, 0), pt(0.1, 0.1), pt(0.2, 0.2)]);
    expect(out.length).toBeGreaterThan(0);
  });

  test("preserves each surviving sample's pressure and tilt", () => {
    const out = simplifyStroke([pt(0, 0, 0.1, 0), pt(1, 0, 0.9, 0.4), pt(2, 0, 0.5, 0)]);
    expect(out[0]?.p).toBe(0.1);
    expect(out[1]?.p).toBe(0.5);
  });
});

describe("strokeHitRadius / eraseAt", () => {
  test("measures to the nearest segment, not the nearest sample", () => {
    // The midpoint of a long two-sample segment is 50 px from either endpoint but
    // 0 px from the line — an endpoint-only test would miss this entirely.
    const s = line([pt(0, 0), pt(100, 0)]);
    expect(strokeHitRadius(s, 50, 0)).toBe(0);
    expect(strokeHitRadius(s, 50, 3)).toBe(3);
  });

  test("is Infinity for a stroke with no points, so nothing can be a hit", () => {
    expect(strokeHitRadius(line([]), 0, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(strokeHitRadius(line([]), NaN, NaN)).toBe(Number.POSITIVE_INFINITY);
  });

  test("erases a stroke the eraser crossed", () => {
    const ink = { w: 100, h: 100, strokes: [line([pt(0, 0), pt(100, 0)])] };
    const out = eraseAt(ink, 50, 0, ERASER_RADIUS);
    expect(out.strokes).toHaveLength(0);
  });

  test("returns the same layer reference when nothing was crossed", () => {
    const ink = { w: 100, h: 100, strokes: [line([pt(0, 0), pt(10, 0)])] };
    expect(eraseAt(ink, 90, 90, ERASER_RADIUS)).toBe(ink);
  });

  test("removes only the stroke under the eraser", () => {
    const ink = {
      w: 100,
      h: 100,
      strokes: [line([pt(0, 0), pt(10, 0)]), line([pt(0, 50), pt(10, 50)])],
    };
    const out = eraseAt(ink, 5, 50, ERASER_RADIUS);
    expect(out.strokes).toHaveLength(1);
    expect(out.strokes[0]?.pts[0]?.y).toBe(0);
  });

  test("an eraser on an empty layer is a same-reference no-op", () => {
    const ink = { w: 0, h: 0, strokes: [] };
    expect(eraseAt(ink, 1, 2)).toBe(ink);
  });

  test("the radius boundary is inclusive of a stroke exactly at the rim", () => {
    const ink = { w: 100, h: 100, strokes: [line([pt(0, 0), pt(100, 0)])] };
    // 12 px away: inside a 12 px radius (erased); 12.5 px away: outside.
    expect(eraseAt(ink, 50, 12, 12).strokes).toHaveLength(0);
    expect(eraseAt(ink, 50, 12.5, 12).strokes).toHaveLength(1);
  });
});

describe("inkEqual", () => {
  const a = { w: 10, h: 10, strokes: [line([pt(0, 0), pt(1, 1)])] };

  test("is true for a structurally identical layer", () => {
    expect(inkEqual(a, JSON.parse(JSON.stringify(a)))).toBe(true);
  });

  test("treats absent, null and an explicit empty layer as the same nothing", () => {
    expect(inkEqual(undefined, null)).toBe(true);
    expect(inkEqual(undefined, { w: 0, h: 0, strokes: [] })).toBe(true);
    expect(inkEqual(null, { w: 0, h: 0, strokes: [] })).toBe(true);
  });

  test("is false on a differing count, width, tool, color or one sample", () => {
    expect(inkEqual(a, { w: 10, h: 10, strokes: [] })).toBe(false);
    const wider = { ...a, strokes: [{ ...a.strokes[0]!, width: 9 }] };
    expect(inkEqual(a, wider)).toBe(false);
    const shorter = { ...a, strokes: [{ ...a.strokes[0]!, pts: [pt(0, 0)] }] };
    expect(inkEqual(a, shorter)).toBe(false);
    const pressed = { ...a, strokes: [{ ...a.strokes[0]!, pts: [pt(0, 0), pt(1, 1, 0.2)] }] };
    expect(inkEqual(a, pressed)).toBe(false);
  });
});

describe("noteHasInk", () => {
  test("is true only for a note carrying at least one stroke", () => {
    expect(noteHasInk({})).toBe(false);
    expect(noteHasInk({ ink: { w: 0, h: 0, strokes: [] } })).toBe(false);
    expect(noteHasInk({ ink: { w: 0, h: 0, strokes: [line([pt(0, 0)])] } })).toBe(true);
  });
});

describe("strokePath", () => {
  test("builds a closed outline for a polyline", () => {
    const d = strokePath([pt(0, 0), pt(10, 0), pt(20, 5)], 4);
    expect(d.startsWith("M ")).toBe(true);
    expect(d).toContain(" L ");
    expect(d.endsWith("Z")).toBe(true);
  });

  test("a single sample becomes a small closed circle (a deliberate dot)", () => {
    const d = strokePath([pt(5, 5)], 4);
    expect(d.startsWith("M ")).toBe(true);
    expect(d).toContain("A ");
    expect(d.endsWith("Z")).toBe(true);
  });

  test("emits the empty string rather than a path containing NaN", () => {
    expect(strokePath([])).toBe("");
    expect(strokePath([{ x: NaN, y: 0, p: 1, t: 0 }])).toBe("");
    // One bad sample among good ones is skipped, not spread into the geometry.
    const d = strokePath([pt(0, 0), { x: NaN, y: NaN, p: 1, t: 0 }, pt(10, 0)]);
    expect(d).not.toContain("NaN");
    expect(d.startsWith("M ")).toBe(true);
  });

  test("a wider base moves the outline further from the centreline", () => {
    const narrow = strokePath([pt(0, 0), pt(10, 0)], 1);
    const wide = strokePath([pt(0, 0), pt(10, 0)], 6);
    expect(wide).not.toBe(narrow);
  });
});

describe("fitScale / toModelPoint", () => {
  test("scales view space to capture space", () => {
    expect(fitScale(300, 600)).toBe(2);
    expect(fitScale(300, 300)).toBe(1);
  });

  test("an unmeasured strip draws 1:1 rather than collapsing", () => {
    expect(fitScale(0, 600)).toBe(1);
    expect(fitScale(300, 0)).toBe(1);
    expect(fitScale(NaN, 600)).toBe(1);
    expect(fitScale(300, NaN)).toBe(1);
  });

  test("inverts the view transform and survives a degenerate scale", () => {
    expect(toModelPoint(200, 400, 2)).toEqual({ x: 100, y: 200 });
    expect(toModelPoint(200, 400, 0)).toEqual({ x: 200, y: 400 });
    expect(toModelPoint(NaN, 400, 2)).toEqual({ x: 0, y: 200 });
  });

  test("a model point round-trips through the view transform", () => {
    const scale = fitScale(250, 500);
    const moved = toModelPoint(120 * scale, 80 * scale, scale);
    expect(moved).toEqual({ x: 120, y: 80 });
  });
});

describe("classifyPointer", () => {
  test("a pen always draws — even with a huge contact ellipse", () => {
    expect(classifyPointer(sample({ pointerType: "pen", width: 90, height: 90 }))).toBe("draw");
    expect(classifyPointer(sample({ pointerType: "pen", isPrimary: false }))).toBe("draw");
    expect(classifyPointer(sample({ pointerType: "pen", palmRejection: false }))).toBe("draw");
  });

  test("a mouse always draws (the desktop shell is a real target)", () => {
    expect(classifyPointer(sample({ pointerType: "mouse" }))).toBe("draw");
  });

  test("a touch while a pen is writing is a resting palm", () => {
    expect(classifyPointer(sample({ pointerType: "touch", penActive: true }))).toBe("palm");
    expect(
      classifyPointer(sample({ pointerType: "touch", penActive: true, width: 8 })),
    ).toBe("palm");
  });

  test("a wide contact ellipse is a palm, a narrow one is a finger", () => {
    expect(classifyPointer(sample({ width: 30, height: 20 }))).toBe("palm");
    expect(classifyPointer(sample({ width: 30, height: 20 }))).toBe("palm");
    expect(classifyPointer(sample({ width: 8, height: 6 }))).toBe("draw");
    expect(classifyPointer(sample({ width: 0, height: 0 }))).toBe("draw");
  });

  test("the user's palm-rejection preference outranks every heuristic", () => {
    expect(classifyPointer(sample({ width: 80, height: 80, palmRejection: false }))).toBe("draw");
    expect(classifyPointer(sample({ penActive: true, palmRejection: false }))).toBe("draw");
  });

  test("a non-primary touch alongside another contact is a palm", () => {
    expect(classifyPointer(sample({ isPrimary: false }))).toBe("palm");
  });

  test("an unknown or unreported pointer type is ignored, never invented into input", () => {
    expect(classifyPointer(sample({ pointerType: "unknown" }))).toBe("ignore");
    expect(classifyPointer(sample({ pointerType: "" }))).toBe("ignore");
    expect(classifyPointer(sample({ pointerType: "eraser" }))).toBe("ignore");
  });
});
