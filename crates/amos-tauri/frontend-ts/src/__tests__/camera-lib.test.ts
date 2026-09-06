import { describe, expect, test } from "bun:test";
import {
  captureDims,
  facingMode,
  mirrorPreview,
  clampZoom,
  nextZoom,
  zoomCrop,
  fitCrop,
  needsCrop,
  resOf,
  nextRes,
  cycleAfter,
} from "../lib/camera";

describe("camera capture geometry", () => {
  test("captureDims returns a canvas size per aspect ratio", () => {
    expect(captureDims("4:3")).toEqual({ w: 640, h: 480 });
    expect(captureDims("square")).toEqual({ w: 640, h: 640 });
    expect(captureDims("16:9")).toEqual({ w: 640, h: 360 });
  });

  test("facingMode maps back→environment and front→user", () => {
    expect(facingMode("back")).toBe("environment");
    expect(facingMode("front")).toBe("user");
    expect(mirrorPreview("front")).toBe(true);
    expect(mirrorPreview("back")).toBe(false);
  });
});

describe("camera zoom crop", () => {
  test("clampZoom keeps a sane range", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(3)).toBe(3);
    expect(clampZoom(0.5)).toBe(1); // never below 1×
    expect(clampZoom(999)).toBe(5);
    expect(clampZoom(NaN)).toBe(1);
  });

  test("nextZoom cycles 1 → 2 → 3 → 1", () => {
    expect(nextZoom(1)).toBe(2);
    expect(nextZoom(2)).toBe(3);
    expect(nextZoom(3)).toBe(1);
  });

  test("zoom 1× (or no video size) captures the whole frame → null crop", () => {
    expect(zoomCrop(1280, 720, 1, { w: 640, h: 480 })).toBeNull();
    expect(zoomCrop(0, 0, 2, { w: 640, h: 480 })).toBeNull();
  });

  test("zoom crop is centred and scaled from the source", () => {
    const out = zoomCrop(1280, 720, 2, { w: 640, h: 480 });
    expect(out).not.toBeNull();
    // A 4:3 region fully inside the 16:9 source is 960 x 720, then halved by 2×.
    expect(out!.w).toBe(480);
    expect(out!.h).toBe(360);
    expect(out!.x).toBe((1280 - 480) / 2);
    expect(out!.y).toBe((720 - 360) / 2);
  });
});

describe("camera fit/aspect crop", () => {
  test("square output from a 16:9 source is a centred square, never stretched", () => {
    const out = fitCrop(1280, 720, { w: 640, h: 640 });
    expect(out).toEqual({ x: 280, y: 0, w: 720, h: 720 });
    expect(needsCrop(1280, 720, { w: 640, h: 640 })).toBe(true);
  });

  test("matching aspect needs no crop", () => {
    expect(fitCrop(640, 480, { w: 640, h: 480 })).toEqual({ x: 0, y: 0, w: 640, h: 480 });
    expect(needsCrop(640, 480, { w: 640, h: 480 })).toBe(false);
  });

  test("fitCrop returns null without video dimensions", () => {
    expect(fitCrop(0, 0, { w: 640, h: 480 })).toBeNull();
  });
});

describe("camera cycle helpers", () => {
  test("cycleAfter wraps around", () => {
    expect(cycleAfter(["a", "b", "c"], "a")).toBe("b");
    expect(cycleAfter(["a", "b", "c"], "c")).toBe("a");
    expect(cycleAfter(["a", "b"], "unknown" as never)).toBe("a");
  });
});

describe("camera resolution presets", () => {
  test("resOf resolves tiers and falls back to HD for unknown ids", () => {
    expect(resOf("sd")).toMatchObject({ id: "sd", w: 640, h: 480 });
    expect(resOf("hd")).toMatchObject({ id: "hd", w: 1280, h: 720 });
    expect(resOf("fhd")).toMatchObject({ id: "fhd", w: 1920, h: 1080 });
    expect(resOf("bogus")).toMatchObject({ id: "hd" }); // safe fallback
  });

  test("nextRes cycles SD → HD → FHD → SD", () => {
    expect(nextRes("sd")).toBe("hd");
    expect(nextRes("hd")).toBe("fhd");
    expect(nextRes("fhd")).toBe("sd");
  });
});
