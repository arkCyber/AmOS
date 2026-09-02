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
});
