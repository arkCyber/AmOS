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
  FLASH_ORDER,
  FACING_ORDER,
  RATIO_ORDER,
  TIMER_PRESETS,
  ZOOM_STEPS,
  ZOOM_MIN,
  ZOOM_MAX,
  clamp01,
  focusFromRect,
  afInit,
  afTap,
  afCaption,
  type CamFlash,
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

// iOS-style control cycles the UI drives — pinned here so a future reorder of
// the "orders" in lib/camera can never silently change the on-screen cycle.
describe("camera iPhone control cycles", () => {
  test("flash cycles auto → on → off → auto", () => {
    const cycle = (f: CamFlash) => cycleAfter(FLASH_ORDER, f);
    expect(FLASH_ORDER).toEqual(["auto", "on", "off"]);
    expect(cycle("auto")).toBe("on");
    expect(cycle("on")).toBe("off");
    expect(cycle("off")).toBe("auto");
  });

  test("lens flip alternates back ↔ front", () => {
    expect(FACING_ORDER).toEqual(["back", "front"]);
    expect(cycleAfter(FACING_ORDER, "back")).toBe("front");
    expect(cycleAfter(FACING_ORDER, "front")).toBe("back");
  });

  test("aspect ratio cycles 4:3 → square → 16:9 → 4:3", () => {
    expect(RATIO_ORDER).toEqual(["4:3", "square", "16:9"]);
    expect(cycleAfter(RATIO_ORDER, "4:3")).toBe("square");
    expect(cycleAfter(RATIO_ORDER, "square")).toBe("16:9");
    expect(cycleAfter(RATIO_ORDER, "16:9")).toBe("4:3");
  });

  test("self-timer presets cycle 0 → 3 → 10 → 0", () => {
    expect(TIMER_PRESETS).toEqual([0, 3, 10]);
    expect(cycleAfter(TIMER_PRESETS, 0)).toBe(3);
    expect(cycleAfter(TIMER_PRESETS, 3)).toBe(10);
    expect(cycleAfter(TIMER_PRESETS, 10)).toBe(0);
  });

  test("zoom steps / bounds invariants stay iOS-like", () => {
    expect(ZOOM_STEPS).toEqual([1, 2, 3]);
    expect(ZOOM_MIN).toBe(1);
    expect(ZOOM_MAX).toBe(5);
    expect(nextZoom(1)).toBe(2);
    expect(nextZoom(2)).toBe(3);
    expect(nextZoom(3)).toBe(1);
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

describe("camera tap-to-focus / AE-AF lock", () => {
  test("clamp01 bounds coordinates and guards non-finite", () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
  });

  test("focusFromRect maps a tap into normalised viewfinder coords", () => {
    const rect = { x: 0, y: 0, width: 1000, height: 500 };
    expect(focusFromRect(250, 250, rect)).toEqual({ x: 0.25, y: 0.5 });
    // clamps taps outside the frame
    expect(focusFromRect(-50, 9999, rect)).toEqual({ x: 0, y: 1 });
    // no area → null
    expect(focusFromRect(10, 10, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
  });

  test("first tap aims (unlocked), a second near tap locks (AE/AF LOCK)", () => {
    const first = afTap(afInit(), { x: 0.4, y: 0.5 });
    expect(first).toEqual({ x: 0.4, y: 0.5, locked: false });
    expect(afCaption(first)).toBe("AF");
    const locked = afTap(first, { x: 0.402, y: 0.501 });
    expect(locked.locked).toBe(true);
    expect(afCaption(locked)).toBe("AE/AF LOCKED");
  });

  test("a far tap re-aims and unlocks; tapping while locked unlocks (iOS gesture)", () => {
    const locked = afTap(afTap(afInit(), { x: 0.5, y: 0.5 }), { x: 0.5, y: 0.5 });
    expect(locked.locked).toBe(true);
    // tapping again (even the same spot) while locked is the unlock gesture
    expect(afTap(locked, { x: 0.51, y: 0.5 }).locked).toBe(false);
    // tapping elsewhere re-aims & unlocks
    const reaimed = afTap(locked, { x: 0.1, y: 0.9 });
    expect(reaimed).toEqual({ x: 0.1, y: 0.9, locked: false });
  });
});
