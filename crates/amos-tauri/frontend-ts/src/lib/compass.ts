/**
 * compass.ts — pure logic for the Compass app.
 *
 * Provides device orientation handling, coordinate calculations, and state
 * management for compass headings (magnetic/true north) and level measurements.
 */

export interface CompassSettings {
  /** Whether to use true north (vs magnetic north). */
  useTrueNorth: boolean;
  /** Cached magnetic declination (degrees, + = east, - = west). */
  declination: number;
}

export interface CompassReading {
  /** Heading in degrees (0-360, 0 = north). */
  heading: number;
  /** Tilt angles for level display. */
  tilt: { x: number; y: number };
  /** Whether device orientation is available. */
  available: boolean;
  /** Accuracy estimate (radians, from DeviceOrientation). */
  accuracy?: number;
}

export const COMPASS_SETTINGS_KEY = "amos.compass.settings";

/** Default settings. */
export function defaultCompassSettings(): CompassSettings {
  return {
    useTrueNorth: false,
    declination: 0,
  };
}

/** Normalize persisted settings. */
export function normalizeCompassSettings(raw: unknown): CompassSettings {
  const d = defaultCompassSettings();
  if (!raw || typeof raw !== "object") return d;
  const obj = raw as Record<string, unknown>;
  return {
    useTrueNorth: typeof obj.useTrueNorth === "boolean" ? obj.useTrueNorth : d.useTrueNorth,
    declination: typeof obj.declination === "number" ? obj.declination : d.declination,
  };
}

/** Format heading as compass direction (e.g. "N", "NE", "S"). */
export function cardinalDirection(heading: number, locale: "zh" | "en"): string {
  const dirs = locale === "zh"
    ? ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]
    : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const normalized = normalizeHeading(heading);
  const idx = Math.round((normalized / 45)) % 8;
  return dirs[idx] ?? dirs[0];
}

/** Normalize angle to 0-360 range. */
export function normalizeHeading(deg: number): number {
  const n = deg % 360;
  return n < 0 ? n + 360 : n === 0 ? 0 : n;
}

/** Apply magnetic declination to convert magnetic → true north. */
export function applyDeclination(magnetic: number, declination: number): number {
  return normalizeHeading(magnetic + declination);
}

/** Check if device supports orientation events. */
export function isOrientationSupported(): boolean {
  return typeof DeviceOrientationEvent !== "undefined" && 
         typeof window !== "undefined";
}

/** Request permission for iOS 13+ devices. */
export async function requestOrientationPermission(): Promise<boolean> {
  if (typeof DeviceOrientationEvent === "undefined") return false;
  
  // @ts-expect-error - iOS 13+ proprietary API
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    try {
      // @ts-expect-error - iOS 13+ proprietary API
      const permission = await DeviceOrientationEvent.requestPermission();
      return permission === "granted";
    } catch {
      return false;
    }
  }
  
  // Non-iOS or older iOS - assume granted
  return true;
}

/**
 * Fetch magnetic declination from World Magnetic Model API.
 * Falls back to 0 if unavailable (offline or API error).
 */
export async function fetchDeclination(lat: number, lon: number): Promise<number> {
  try {
    // NOAA World Magnetic Model API (public, free)
    const url = `https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination`;
    const params = new URLSearchParams({
      lat1: lat.toFixed(4),
      lon1: lon.toFixed(4),
      resultFormat: "json",
    });
    
    const response = await fetch(`${url}?${params}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return 0;
    
    const data = await response.json();
    return typeof data.result?.[0]?.declination === "number" 
      ? data.result[0].declination 
      : 0;
  } catch {
    return 0;
  }
}

/** Convert tilt angles to level percentage (0 = level, 100 = max tilt). */
export function levelPercentage(tiltX: number, tiltY: number): number {
  const magnitude = Math.sqrt(tiltX * tiltX + tiltY * tiltY);
  return Math.min(100, (magnitude / 90) * 100);
}

/** Check if device is approximately level (within threshold degrees). */
export function isLevel(tiltX: number, tiltY: number, threshold = 2): boolean {
  return Math.abs(tiltX) < threshold && Math.abs(tiltY) < threshold;
}
