export type LatLon = [number, number];

export const PLACES: Record<string, LatLon> = {
  北京: [39.9042, 116.4074],
  上海: [31.2304, 121.4737],
  广州: [23.1291, 113.2644],
  深圳: [22.5431, 114.0579],
  成都: [30.5728, 104.0668],
  杭州: [30.2741, 120.1551],
};

export function clampZoom(z: number): number {
  return Math.min(18, Math.max(3, Math.round(z)));
}

/** Slippy-map tile coordinate (Web Mercator). */
export function latLonToTile(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function tileUrl(z: number, x: number, y: number): string {
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

export function zoomIn(z: number): number {
  return clampZoom(z + 1);
}
export function zoomOut(z: number): number {
  return clampZoom(z - 1);
}
