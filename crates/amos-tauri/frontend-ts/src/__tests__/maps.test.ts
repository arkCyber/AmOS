import { describe, expect, test } from "bun:test";
import { clampZoom, latLonToTile, PLACES, tileUrl, zoomIn, zoomOut } from "../lib/maps";

describe("maps", () => {
  test("known cities are present", () => {
    expect(Object.keys(PLACES)).toContain("北京");
    expect(PLACES["北京"][0]).toBeGreaterThan(20);
  });

  test("tile math yields finite web-mercator coords and clamped zoom", () => {
    const { x, y } = latLonToTile(39.9, 116.4, 12);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
    expect(x).toBeGreaterThan(0);
    expect(clampZoom(2)).toBe(3);
    expect(clampZoom(99)).toBe(18);
    expect(zoomIn(18)).toBe(18);
    expect(zoomOut(3)).toBe(3);
  });

  test("tileUrl references openstreetmap", () => {
    expect(tileUrl(12, 1, 2)).toBe("https://tile.openstreetmap.org/12/1/2.png");
  });

  test("latLonToTile stays finite at poles / invalid input (no Inf/NaN)", () => {
    // Latitude clamped to valid Mercator range.
    const north = latLonToTile(90, 0, 3);
    const south = latLonToTile(-90, 0, 3);
    for (const { x, y } of [north, south]) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
    // Origin is the mercator centre for (0,0).
    const mid = latLonToTile(0, 0, 3);
    expect(mid.x).toBeCloseTo(4, 5); // 2^3 / 2
    expect(mid.y).toBeCloseTo(4, 5);
    // Non-finite inputs degrade deterministically to the tile origin, not NaN.
    const bad = latLonToTile(Number.NaN, Number.POSITIVE_INFINITY, 3);
    expect(Number.isFinite(bad.x)).toBe(true);
    expect(Number.isFinite(bad.y)).toBe(true);
    expect(bad.x).toBeCloseTo(4, 5);
  });
});
