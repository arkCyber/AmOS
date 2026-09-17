/**
 * compass.ts — pure logic for the Compass app.
 *
 * Provides device orientation handling, coordinate calculations, and state
 * management for compass headings (magnetic/true north) and level measurements.
 */

export interface CompassSettings {
  /** Whether to use true north (vs magnetic north). */
  useTrueNorth: boolean;
  /** Cached magnetic declination (degrees, + = east, - = west). Range: -180 to 180. */
  declination: number;
  /** Cached location coordinates for declination. */
  cachedLocation?: {
    /** Latitude in degrees. Range: -90 to 90. */
    lat: number;
    /** Longitude in degrees. Range: -180 to 180. */
    lon: number;
    /** Timestamp in milliseconds since epoch. */
    timestamp: number;
  };
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

// Cache configuration
const DECLINATION_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
const LOCATION_CHANGE_THRESHOLD = 50; // 50 km - if moved more than this, refetch declination

/** Default settings. */
export function defaultCompassSettings(): CompassSettings {
  return {
    useTrueNorth: false,
    declination: 0,
  };
}

/**
 * Validate and clamp declination to valid range (-180 to 180 degrees).
 */
function validateDeclination(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-180, Math.min(180, value));
}

/**
 * Validate latitude coordinate (-90 to 90 degrees).
 */
function validateLatitude(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Invalid latitude: not finite");
  if (value < -90 || value > 90) throw new Error(`Invalid latitude: ${value} (must be -90 to 90)`);
  return value;
}

/**
 * Validate longitude coordinate (-180 to 180 degrees).
 */
function validateLongitude(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Invalid longitude: not finite");
  if (value < -180 || value > 180) throw new Error(`Invalid longitude: ${value} (must be -180 to 180)`);
  return value;
}

/** Normalize persisted settings. */
export function normalizeCompassSettings(raw: unknown): CompassSettings {
  const d = defaultCompassSettings();
  if (!raw || typeof raw !== "object") return d;
  const obj = raw as Record<string, unknown>;
  
  const declination = typeof obj.declination === "number" 
    ? validateDeclination(obj.declination) 
    : d.declination;
  
  let cachedLocation: CompassSettings["cachedLocation"];
  if (obj.cachedLocation && typeof obj.cachedLocation === "object") {
    const loc = obj.cachedLocation as Record<string, unknown>;
    if (
      typeof loc.lat === "number" &&
      typeof loc.lon === "number" &&
      typeof loc.timestamp === "number"
    ) {
      try {
        cachedLocation = {
          lat: validateLatitude(loc.lat),
          lon: validateLongitude(loc.lon),
          timestamp: loc.timestamp,
        };
      } catch {
        // Invalid cached location, discard it
        cachedLocation = undefined;
      }
    }
  }
  
  return {
    useTrueNorth: typeof obj.useTrueNorth === "boolean" ? obj.useTrueNorth : d.useTrueNorth,
    declination,
    cachedLocation,
  };
}

/** Format heading as compass direction (e.g. "N", "NE", "S"). */
export function cardinalDirection(heading: number, locale: "zh" | "en"): string {
  if (!Number.isFinite(heading)) return locale === "zh" ? "未知" : "Unknown";
  
  const dirs = locale === "zh"
    ? ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]
    : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const normalized = normalizeHeading(heading);
  const idx = Math.round((normalized / 45)) % 8;
  return dirs[idx] ?? dirs[0] ?? "N";
}

/** Normalize angle to 0-360 range. */
export function normalizeHeading(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const n = deg % 360;
  return n < 0 ? n + 360 : n === 0 ? 0 : n;
}

/** Apply magnetic declination to convert magnetic → true north. */
export function applyDeclination(magnetic: number, declination: number): number {
  if (!Number.isFinite(magnetic) || !Number.isFinite(declination)) return 0;
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
 * Calculate distance between two coordinates using Haversine formula (in km).
 * 
 * @param lat1 - First latitude in degrees (-90 to 90)
 * @param lon1 - First longitude in degrees (-180 to 180)
 * @param lat2 - Second latitude in degrees (-90 to 90)
 * @param lon2 - Second longitude in degrees (-180 to 180)
 * @returns Distance in kilometers
 * @throws Error if coordinates are invalid
 */
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  // Validate inputs
  validateLatitude(lat1);
  validateLongitude(lon1);
  validateLatitude(lat2);
  validateLongitude(lon2);
  
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Check if cached declination is still valid.
 * Cache is valid if:
 * 1. Less than 7 days old
 * 2. Current location within 50km of cached location
 * 
 * @param cachedLocation - Previously cached location data
 * @param currentLat - Current latitude in degrees
 * @param currentLon - Current longitude in degrees
 * @returns true if cache is still valid, false otherwise
 */
export function isCachedDeclinationValid(
  cachedLocation: { lat: number; lon: number; timestamp: number } | undefined,
  currentLat: number,
  currentLon: number
): boolean {
  if (!cachedLocation) return false;

  const now = Date.now();
  const cacheAge = now - cachedLocation.timestamp;

  // Cache expired (older than 7 days)
  if (cacheAge > DECLINATION_CACHE_DURATION) {
    return false;
  }

  // Location changed significantly (more than 50km)
  try {
    const distance = calculateDistance(
      cachedLocation.lat,
      cachedLocation.lon,
      currentLat,
      currentLon
    );
    if (distance > LOCATION_CHANGE_THRESHOLD) {
      return false;
    }
  } catch {
    // Invalid coordinates, invalidate cache
    return false;
  }

  return true;
}

/**
 * Fetch magnetic declination from World Magnetic Model API.
 * Falls back to 0 if unavailable (offline or API error).
 * 
 * @param lat - Latitude in degrees (-90 to 90)
 * @param lon - Longitude in degrees (-180 to 180)
 * @returns Magnetic declination in degrees (+ = east, - = west), or 0 on error
 * @throws Error if coordinates are invalid
 */
export async function fetchDeclination(lat: number, lon: number): Promise<number> {
  try {
    // Validate coordinates first (throws on invalid input - intentional for API misuse detection)
    validateLatitude(lat);
    validateLongitude(lon);
    
    // NOAA World Magnetic Model API (public, free)
    const url = `https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination`;
    const params = new URLSearchParams({
      lat1: lat.toFixed(4),
      lon1: lon.toFixed(4),
      resultFormat: "json",
    });
    
    const response = await fetch(`${url}?${params}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      console.warn(`[Compass] API error: ${response.status} ${response.statusText}`);
      return 0;
    }
    
    const data = await response.json();
    const declination = data.result?.[0]?.declination;
    
    if (typeof declination !== "number" || !Number.isFinite(declination)) {
      console.warn("[Compass] Invalid declination in API response:", data);
      return 0;
    }
    
    return validateDeclination(declination);
  } catch (error) {
    // Re-throw validation errors (programming errors should fail fast)
    if (error instanceof Error && error.message.includes("Invalid latitude")) {
      throw error;
    }
    if (error instanceof Error && error.message.includes("Invalid longitude")) {
      throw error;
    }
    
    // Network errors, timeouts, parse errors - graceful degradation
    console.warn("[Compass] Failed to fetch declination:", error);
    return 0;
  }
}

/**
 * Fetch declination with caching support.
 * Returns cached value if valid, otherwise fetches from API and updates cache.
 * 
 * @param lat - Current latitude in degrees
 * @param lon - Current longitude in degrees
 * @param cachedLocation - Previously cached location data
 * @returns Object containing declination, cache location, and whether it was from cache
 */
export async function fetchDeclinationWithCache(
  lat: number,
  lon: number,
  currentDeclination: number,
  cachedLocation?: { lat: number; lon: number; timestamp: number }
): Promise<{
  declination: number;
  cachedLocation: { lat: number; lon: number; timestamp: number };
  fromCache: boolean;
}> {
  // Check if cache is valid
  if (isCachedDeclinationValid(cachedLocation, lat, lon)) {
    // Use cached declination
    return {
      declination: currentDeclination,
      cachedLocation: cachedLocation!,
      fromCache: true,
    };
  }

  // Fetch new declination
  const declination = await fetchDeclination(lat, lon);
  const newCachedLocation = {
    lat,
    lon,
    timestamp: Date.now(),
  };

  return {
    declination,
    cachedLocation: newCachedLocation,
    fromCache: false,
  };
}

/** Convert tilt angles to level percentage (0 = level, 100 = max tilt). */
export function levelPercentage(tiltX: number, tiltY: number): number {
  if (!Number.isFinite(tiltX) || !Number.isFinite(tiltY)) return 100;
  const magnitude = Math.sqrt(tiltX * tiltX + tiltY * tiltY);
  return Math.min(100, (magnitude / 90) * 100);
}

/** Check if device is approximately level (within threshold degrees). */
export function isLevel(tiltX: number, tiltY: number, threshold = 2): boolean {
  if (!Number.isFinite(tiltX) || !Number.isFinite(tiltY)) return false;
  if (!Number.isFinite(threshold) || threshold < 0) return false;
  return Math.abs(tiltX) < threshold && Math.abs(tiltY) < threshold;
}
