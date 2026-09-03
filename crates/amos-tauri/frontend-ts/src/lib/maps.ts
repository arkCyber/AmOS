export type LatLon = [number, number];

export const PLACES: Record<string, LatLon> = {
  北京: [39.9042, 116.4074],
  上海: [31.2304, 121.4737],
  广州: [23.1291, 113.2644],
  深圳: [22.5431, 114.0579],
  成都: [30.5728, 104.0668],
  杭州: [30.2741, 120.1551],
};

/** English display names for the built-in cities (Chinese is the key/locale). */
export const CITY_LABELS: Record<string, string> = {
  北京: "Beijing",
  上海: "Shanghai",
  广州: "Guangzhou",
  深圳: "Shenzhen",
  成都: "Chengdu",
  杭州: "Hangzhou",
};

/** Localized display name of a city (Chinese key). Unknown keys pass through. */
export function cityLabel(city: string, locale: string): string {
  if (locale !== "zh" && CITY_LABELS[city]) return CITY_LABELS[city];
  return city;
}

/** Resolve a typed label (in the current locale) back to the Chinese city key,
 * or undefined when it isn't a known city. Enables searching in English too. */
export function cityKey(label: string, locale: string): string | undefined {
  const q = label.trim();
  if (!q) return undefined;
  if (locale !== "zh") {
    const hit = Object.entries(CITY_LABELS).find(([, v]) => v.toLowerCase() === q.toLowerCase());
    if (hit) return hit[0];
  }
  return PLACES[q] ? q : undefined;
}

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) z = 3; // NaN/±Inf zoom → sane default, never taints the transform
  return Math.min(18, Math.max(3, Math.round(z)));
}

/**
 * Slippy-map tile coordinate (Web Mercator). Latitude is clamped to the valid
 * Mercator range so poles/out-of-range inputs never yield Inf/NaN.
 */
export function latLonToTile(lat: number, lon: number, z: number): { x: number; y: number } {
  // Guard: non-finite inputs are rejected to the tile origin (deterministic).
  const la = Number.isFinite(lat) ? lat : 0;
  const lo = Number.isFinite(lon) ? lon : 0;
  const MERCATOR_MAX_LAT = 85.05112878;
  const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, la));
  const n = 2 ** z;
  const x = ((lo + 180) / 360) * n;
  const latRad = (clampedLat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function tileUrl(z: number, x: number, y: number): string {
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

const MERCATOR_MAX_LAT = 85.05112878;

/** Inverse Web Mercator: fractional (possibly non-integer) tile coordinate →
 * `[lat, lon]`. Mirrors `latLonToTile` exactly, so panning round-trips. */
export function tileToLatLon(x: number, y: number, z: number): LatLon {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (y / n)))) * 180) / Math.PI;
  return [
    Number.isFinite(lat) ? Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) : 0,
    Number.isFinite(lon) ? lon : 0,
  ];
}

const PX_PER_TILE = 256;

/** Pan the map center by whole/partial *tiles* in Web-Mercator space. Adding one
 * tile to `x` moves the viewport one tile-width east (longitude increases). */
export function panTiles(center: LatLon, zoom: number, dxTiles: number, dyTiles: number): LatLon {
  const t = latLonToTile(center[0], center[1], zoom);
  return tileToLatLon(t.x + dxTiles, t.y + dyTiles, zoom);
}

/** Pan by a screen-pixel drag: dragging the map surface right/down (positive
 * dx/dy) reveals area to its west/north, so the visible center moves
 * west/north — the natural gesture for a pointer-drag map. */
export function shiftCenter(center: LatLon, zoom: number, dxPx: number, dyPx: number): LatLon {
  return panTiles(center, zoom, -dxPx / PX_PER_TILE, -dyPx / PX_PER_TILE);
}

export function zoomIn(z: number): number {
  return clampZoom(z + 1);
}
export function zoomOut(z: number): number {
  return clampZoom(z - 1);
}
