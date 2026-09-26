/**
 * Unit tests for lib/photoEdit.ts — the pure model plus the canvas render.
 *
 * The render is tested against a **recording fake context** rather than a real canvas:
 * happy-dom implements no 2D context, and the point of `drawEdited` taking an injectable
 * surface is exactly that the geometry (canvas size, transform order, filter) is decidable
 * headlessly. What this file cannot prove is that a browser rasterises the result — see the
 * exported-photo path exercised in the svelte suite for that half.
 */
import { describe, expect, test } from "bun:test";
import {
  ADJUST_MAX,
  ADJUST_MIN,
  CROP_MIN,
  EXPORT_QUALITY,
  FULL_CROP,
  MAX_EXPORT_EDGE,
  type Canvas2DLike,
  type CanvasLikeContext,
  type Rect,
  clampRect,
  cropPx,
  defaultEdit,
  drawEdited,
  exportEditedDataUrl,
  filterCss,
  fitEdge,
  flipEdit,
  isNoop,
  moveCrop,
  previewTransform,
  resizeCrop,
  rotateEdit,
  rotatedSize,
  setAdjust,
  setCrop,
  setFilter,
} from "../lib/photoEdit";

/** A context that records what was done to it, in order. */
function recorder(): { ctx: CanvasLikeContext; calls: string[] } {
  const calls: string[] = [];
  const ctx: CanvasLikeContext = {
    filter: "",
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    translate: (x, y) => calls.push(`translate(${x},${y})`),
    rotate: (rad) => calls.push(`rotate(${Math.round((rad * 180) / Math.PI)})`),
    scale: (x, y) => calls.push(`scale(${x},${y})`),
    drawImage: (img, dx, dy, dw, dh) => {
      const i = img as { width: number; height: number };
      calls.push(`drawImage(${i.width}x${i.height}@${dx},${dy},${dw},${dh})`);
    },
  };
  return { ctx, calls };
}

function fakeCanvas(ctx: CanvasLikeContext | null): Canvas2DLike {
  return { width: 0, height: 0, getContext: () => ctx };
}

const img = { width: 400, height: 300 };

/** Rect equality up to float noise — `0.2 + 0.1` is not `0.3`. */
function expectRect(got: { x: number; y: number; w: number; h: number }, want: Rect): void {
  expect(got.x).toBeCloseTo(want.x, 9);
  expect(got.y).toBeCloseTo(want.y, 9);
  expect(got.w).toBeCloseTo(want.w, 9);
  expect(got.h).toBeCloseTo(want.h, 9);
}

describe("photoEdit: the model", () => {
  test("a fresh edit is a no-op, and any change stops being one", () => {
    expect(isNoop(defaultEdit())).toBe(true);
    expect(isNoop(rotateEdit(defaultEdit(), 1))).toBe(false);
    expect(isNoop(flipEdit(defaultEdit(), "h"))).toBe(false);
    expect(isNoop(setFilter(defaultEdit(), "mono"))).toBe(false);
    expect(isNoop(setAdjust(defaultEdit(), { brightness: 1.1 }))).toBe(false);
    expect(isNoop(setCrop(defaultEdit(), { x: 0.1, y: 0, w: 0.5, h: 1 }))).toBe(false);
  });

  test("rotateEdit turns a quarter at a time and wraps both ways", () => {
    let e = defaultEdit();
    e = rotateEdit(e, 1);
    expect(e.rot).toBe(90);
    e = rotateEdit(e, 1);
    e = rotateEdit(e, 1);
    expect(e.rot).toBe(270);
    expect(rotateEdit(e, 1).rot).toBe(0); // wraps forward
    expect(rotateEdit(defaultEdit(), -1).rot).toBe(270); // wraps backward
  });

  test("flipEdit toggles only the named axis", () => {
    const e = flipEdit(defaultEdit(), "h");
    expect(e.flipH).toBe(true);
    expect(e.flipV).toBe(false);
    expect(flipEdit(e, "h").flipH).toBe(false);
  });

  test("setAdjust clamps to the usable range and refuses non-finite input", () => {
    expect(setAdjust(defaultEdit(), { brightness: 99 }).adjust.brightness).toBe(ADJUST_MAX);
    expect(setAdjust(defaultEdit(), { contrast: -99 }).adjust.contrast).toBe(ADJUST_MIN);
    // A NaN that reached the filter string would make the browser drop the whole filter.
    expect(setAdjust(defaultEdit(), { saturation: Number.NaN }).adjust.saturation).toBe(1);
    expect(setAdjust(defaultEdit(), { brightness: Number.POSITIVE_INFINITY }).adjust.brightness).toBe(1);
  });

  test("setAdjust patches only the keys it was given", () => {
    const before = setAdjust(defaultEdit(), { contrast: 1.3 });
    const after = setAdjust(before, { brightness: 1.2 });
    expect(after.adjust.contrast).toBe(1.3);
    expect(after.adjust.brightness).toBe(1.2);
  });
});

describe("photoEdit: the crop rectangle", () => {
  test("clampRect keeps the minimum size and the frame bounds", () => {
    expect(clampRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    const tiny = clampRect({ x: 0, y: 0, w: 0, h: -3 });
    expect(tiny.w).toBe(CROP_MIN);
    expect(tiny.h).toBe(CROP_MIN);
    // A non-finite rectangle resolves to the full frame, not to `NaN` everywhere.
    expect(clampRect({ x: Number.NaN, y: 0, w: Number.NaN, h: 1 })).toEqual(FULL_CROP);
  });

  test("moveCrop slides the rectangle but never out of the frame", () => {
    const r = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    expectRect(moveCrop(r, 0.1, 0), { x: 0.3, y: 0.2, w: 0.5, h: 0.5 });
    expectRect(moveCrop(r, 1, 1), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expectRect(moveCrop(r, -1, -1), { x: 0, y: 0, w: 0.5, h: 0.5 });
  });

  test("resizeCrop moves the edges each corner owns, anchored at the opposite corner", () => {
    const r = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    // nw: the bottom-right stays put.
    expectRect(resizeCrop(r, "nw", 0.1, 0.1), { x: 0.35, y: 0.35, w: 0.4, h: 0.4 });
    // ne: the bottom-left stays put.
    expectRect(resizeCrop(r, "ne", 0.1, 0.1), { x: 0.25, y: 0.35, w: 0.6, h: 0.4 });
    // sw: the top-right stays put.
    expectRect(resizeCrop(r, "sw", 0.1, 0.1), { x: 0.35, y: 0.25, w: 0.4, h: 0.6 });
    // se: the top-left stays put.
    expectRect(resizeCrop(r, "se", 0.1, 0.1), { x: 0.25, y: 0.25, w: 0.6, h: 0.6 });
  });

  test("growing a crop past the frame edge stops at the edge, keeping the anchor", () => {
    const r = { x: 0.6, y: 0.6, w: 0.2, h: 0.2 };
    // se's anchor is the top-left, so the frame edge caps w/h without moving x/y.
    expectRect(resizeCrop(r, "se", 5, 5), { x: 0.6, y: 0.6, w: 0.4, h: 0.4 });
  });

  test("a corner dragged past its opposite pins the rectangle instead of inverting it", () => {
    const r = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    // The anchor is the bottom-right corner (0.75, 0.75); the pin must stay against it.
    expectRect(resizeCrop(r, "nw", 1, 1), {
      x: 0.75 - CROP_MIN,
      y: 0.75 - CROP_MIN,
      w: CROP_MIN,
      h: CROP_MIN,
    });
  });

  test("setCrop stores the clamped rectangle", () => {
    expectRect(setCrop(defaultEdit(), { x: -1, y: 2, w: 0.3, h: 0.3 }).crop, {
      x: 0,
      y: 0.7,
      w: 0.3,
      h: 0.3,
    });
  });
});

describe("photoEdit: preview and render agree", () => {
  test("rotatedSize swaps the axes on a quarter turn only", () => {
    expect(rotatedSize(400, 300, 0)).toEqual({ w: 400, h: 300 });
    expect(rotatedSize(400, 300, 90)).toEqual({ w: 300, h: 400 });
    expect(rotatedSize(400, 300, 180)).toEqual({ w: 400, h: 300 });
    expect(rotatedSize(400, 300, 270)).toEqual({ w: 300, h: 400 });
  });

  test("filterCss is neutral by default and folds the preset into the adjustments", () => {
    expect(filterCss(defaultEdit())).toBe("brightness(1) contrast(1) saturate(1)");
    expect(filterCss(setFilter(defaultEdit(), "mono"))).toContain("grayscale(1)");
    expect(filterCss(setFilter(defaultEdit(), "sepia"))).toContain("sepia(0.85)");
    const vivid = filterCss(setFilter(defaultEdit(), "vivid"));
    expect(vivid).toContain("saturate(1.4)");
    expect(vivid).toContain("contrast(1.05)");
    // The adjustment multiplies the preset rather than replacing it.
    expect(
      filterCss(setAdjust(setFilter(defaultEdit(), "vivid"), { saturation: 0.5 })),
    ).toContain("saturate(0.7)");
    // Rounded, so the same edit is always the same string.
    expect(filterCss(setAdjust(defaultEdit(), { brightness: 1.23456 }))).toContain(
      "brightness(1.235)",
    );
  });

  test("previewTransform mirrors the canvas order (rotate, then scale)", () => {
    expect(previewTransform(defaultEdit())).toBe("rotate(0deg) scaleX(1) scaleY(1)");
    const e = flipEdit(rotateEdit(defaultEdit(), 1), "v");
    expect(previewTransform(e)).toBe("rotate(90deg) scaleX(1) scaleY(-1)");
  });

  test("cropPx maps the normalised crop onto the rotated frame, at least 1px", () => {
    expect(cropPx(defaultEdit(), 400, 300)).toEqual({ sx: 0, sy: 0, sw: 400, sh: 300 });
    const half = setCrop(defaultEdit(), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(cropPx(half, 400, 300)).toEqual({ sx: 200, sy: 150, sw: 200, sh: 150 });
    // A crop narrower than one source pixel still yields a 1px canvas (0 would throw).
    expect(cropPx(setCrop(defaultEdit(), { x: 0, y: 0, w: 0.001, h: 0.001 }), 4, 4).sw).toBe(1);
  });
});

describe("photoEdit: the canvas render", () => {
  test("drawEdited sizes the canvas to the crop and applies rotation, flip and filter", () => {
    const { ctx, calls } = recorder();
    const canvas = fakeCanvas(ctx);
    const e = flipEdit(rotateEdit(setFilter(defaultEdit(), "mono"), 1), "h");
    expect(drawEdited(canvas, img, e)).toBe(true);
    // 400x300 turned 90° is a 300x400 frame, and the crop is the whole frame.
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(400);
    expect(ctx.filter).toContain("grayscale(1)");
    expect(calls).toEqual([
      "save",
      "translate(150,200)", // to the canvas centre
      "scale(1,1)", // 300x400 is within the cap → no downscale
      "translate(0,0)", // crop is the whole frame → its centre is the frame centre
      "rotate(90)",
      "scale(-1,1)",
      "drawImage(400x300@-200,-150,400,300)",
      "restore",
    ]);
  });

  test("an off-centre crop shifts the frame so the kept region lands at the origin", () => {
    const { ctx, calls } = recorder();
    const canvas = fakeCanvas(ctx);
    // Keep the bottom-right quarter of the rotated frame.
    const e = setCrop(defaultEdit(), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(drawEdited(canvas, img, e)).toBe(true);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(150);
    expect(calls).toContain("translate(-100,-75)");
  });

  // A laid-out <img> reports its **rendered** size in `width`/`height` — the decoded size
  // lives in `naturalWidth`/`naturalHeight`. Rendering against the rendered size would crop
  // and scale against the preview box instead of the photo (REQ-A1147).
  test("drawEdited renders at the decoded size, not the rendered one", () => {
    const { ctx, calls } = recorder();
    const canvas = fakeCanvas(ctx);
    const laidOut = { width: 40, height: 30, naturalWidth: 400, naturalHeight: 300 };
    expect(drawEdited(canvas, laidOut, defaultEdit())).toBe(true);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
    expect(calls).toContain("drawImage(40x30@-200,-150,400,300)");
  });

  test("drawEdited reports failure instead of drawing nothing", () => {
    // No 2d context (a WebView build without canvas).
    expect(drawEdited(fakeCanvas(null), img, defaultEdit())).toBe(false);
    // A source with no pixels would make a 0-area canvas whose toDataURL throws.
    expect(drawEdited(fakeCanvas(recorder().ctx), { width: 0, height: 0 }, defaultEdit())).toBe(
      false,
    );
    expect(
      drawEdited(fakeCanvas(recorder().ctx), { width: Number.NaN, height: 10 }, defaultEdit()),
    ).toBe(false);
  });
});

describe("photoEdit: the export cap", () => {
  test("fitEdge bounds the longest side and never enlarges", () => {
    expect(fitEdge(4000, 3000, MAX_EXPORT_EDGE)).toEqual({ w: 4000, h: 3000, scale: 1 });
    expect(fitEdge(8192, 4096, 4096)).toEqual({ w: 4096, h: 2048, scale: 0.5 });
    // Portrait bounds the *longest* side, not both.
    expect(fitEdge(1000, 8000, 4096)).toEqual({ w: 512, h: 4096, scale: 0.512 });
    // A cap at or below zero is not "keep full size", it is a typo — fall back to the real cap.
    expect(fitEdge(100_000, 100_000, 0)).toEqual({ w: MAX_EXPORT_EDGE, h: MAX_EXPORT_EDGE, scale: MAX_EXPORT_EDGE / 100_000 });
    // The thinnest allowed result is still a pixel, never a 0-area canvas.
    expect(fitEdge(10_000, 1, 4096).h).toBe(1);
  });

  test("drawEdited caps an oversized crop instead of encoding it full size", () => {
    const { ctx, calls } = recorder();
    const canvas = fakeCanvas(ctx);
    expect(drawEdited(canvas, { width: 8000, height: 6000 }, defaultEdit())).toBe(true);
    expect(canvas.width).toBe(MAX_EXPORT_EDGE);
    expect(canvas.height).toBe(3072);
    expect(calls).toContain(`scale(${4096 / 8000},${3072 / 6000})`);
    // The source rectangle is untouched — it is the *canvas* that shrank.
    expect(calls).toContain("drawImage(8000x6000@-4000,-3000,8000,6000)");
  });

  test("an explicit maxEdge overrides the default cap", () => {
    const { ctx } = recorder();
    const canvas = fakeCanvas(ctx);
    expect(drawEdited(canvas, { width: 800, height: 400 }, defaultEdit(), 100)).toBe(true);
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(50);
  });

  test("a saved edit encodes at the named quality", () => {
    let seen: number | undefined;
    const c = {
      toDataURL: (_type?: string, quality?: number) => {
        seen = quality;
        return "data:image/jpeg;base64,AAAA";
      },
    };
    exportEditedDataUrl(c, "image/jpeg");
    expect(seen).toBe(EXPORT_QUALITY);
  });
});

describe("photoEdit: encoding the result", () => {
  const canvasOf = (url: string | (() => string)): { toDataURL: () => string } => ({
    toDataURL: typeof url === "function" ? url : () => url,
  });

  test("a known image MIME is kept, anything else falls back to jpeg", () => {
    let seen = "";
    const c = {
      toDataURL: (type?: string) => {
        seen = type ?? "";
        return "data:image/jpeg;base64,AAAA";
      },
    };
    expect(exportEditedDataUrl(c, "image/png")).toContain("data:image/");
    expect(seen).toBe("image/png");
    exportEditedDataUrl(c, "application/octet-stream");
    expect(seen).toBe("image/jpeg");
    exportEditedDataUrl(c, undefined);
    expect(seen).toBe("image/jpeg");
  });

  test("a canvas that throws or returns junk yields null, never an empty data URL", () => {
    expect(
      exportEditedDataUrl(
        canvasOf(() => {
          throw new Error("tainted canvas");
        }),
        "image/jpeg",
      ),
    ).toBeNull();
    // A zero-area canvas answers "data:," — that is not a photo.
    expect(exportEditedDataUrl(canvasOf("data:,"), "image/jpeg")).toBeNull();
    expect(exportEditedDataUrl(canvasOf("not-a-url"), "image/jpeg")).toBeNull();
  });

  test("a real-format URL round-trips", () => {
    expect(exportEditedDataUrl(canvasOf("data:image/png;base64,BBBB"), null)).toBe(
      "data:image/png;base64,BBBB",
    );
  });
});
