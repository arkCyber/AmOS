import { describe, expect, test } from "bun:test";
import {
  clampZoom,
  latLonToTile,
  PLACES,
  tileUrl,
  tileToLatLon,
  panTiles,
  shiftCenter,
  cityLabel,
  cityKey,
  zoomIn,
  zoomOut,
} from "../lib/maps";

describe("maps", () => {
  test("known cities are present", () => {
    expect(Object.keys(PLACES)).toContain("北京");
    expect(PLACES["北京"]![0]).toBeGreaterThan(20);
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

  test("tileToLatLon inverts latLonToTile and panning round-trips", () => {
    const bj = PLACES["北京"]!;
    const z = 12;
    // forward then inverse returns the original centre (within tolerance)
    const t = latLonToTile(bj[0], bj[1], z);
    const back = tileToLatLon(t.x, t.y, z);
    expect(back[0]).toBeCloseTo(bj[0], 4);
    expect(back[1]).toBeCloseTo(bj[1], 4);

    // panning one tile east increases longitude by exactly 360/2^z …
    const east = panTiles(bj, z, 1, 0);
    expect(east[1]).toBeCloseTo(bj[1] + 360 / 2 ** z, 4);
    // … and panning back west returns to the start.
    const back2 = panTiles(east, z, -1, 0);
    expect(back2[0]).toBeCloseTo(bj[0], 4);
    expect(back2[1]).toBeCloseTo(bj[1], 4);
  });

  test("shiftCenter pans by screen pixels in the gesture direction", () => {
    const bj = PLACES["北京"]!;
    const z = 12;
    // Dragging content right (dx>0) reveals west → longitude decreases.
    const west = shiftCenter(bj, z, 256, 0);
    expect(west[1]).toBeLessThan(bj[1]);
    // Dragging content down (dy>0) reveals north → latitude increases.
    const north = shiftCenter(bj, z, 0, 256);
    expect(north[0]).toBeGreaterThan(bj[0]);
    // Shift then shift back returns to the start.
    const back = shiftCenter(shiftCenter(bj, z, 256, 128), z, -256, -128);
    expect(back[0]).toBeCloseTo(bj[0], 3);
    expect(back[1]).toBeCloseTo(bj[1], 3);
  });

  test("city labels localize and searching accepts the active locale", () => {
    expect(cityLabel("北京", "zh")).toBe("北京");
    expect(cityLabel("北京", "en")).toBe("Beijing");
    expect(cityLabel("未知", "en")).toBe("未知"); // unknown passthrough

    expect(cityKey("北京", "zh")).toBe("北京");
    expect(cityKey(" 上海 ", "zh")).toBe("上海");
    expect(cityKey("Shanghai", "en")).toBe("上海"); // english search in en locale
    expect(cityKey("北京", "en")).toBe("北京"); // both languages are accepted
    expect(cityKey("nope", "en")).toBeUndefined();
  });

  test("repeated out-of-range zoom/pan stays finite and lat stays clamped", () => {
    let zoom = clampZoom(100); // clamp extreme zoom
    for (let i = 0; i < 200; i++) {
      zoom = clampZoom(zoom + (i % 2 === 0 ? 50 : -60));
      const t = latLonToTile(90, 1e6, zoom);
      expect([t.x, t.y].every((v) => Number.isFinite(v))).toBe(true);
      // panning far off-map must never yield NaN/Inf or an out-of-range latitude
      const [lat, lng] = panTiles(tileToLatLon(t.x, t.y, zoom), zoom, 1e5, -1e5);
      expect([lat, lng].every((v) => Number.isFinite(v))).toBe(true);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
    }
    expect(clampZoom(Number.NaN)).toBeGreaterThanOrEqual(0); // NaN zoom → sane fallback
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(18); // +Inf clamped high
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBeGreaterThanOrEqual(3); // -Inf clamped low
  });
});
