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
  /**
   * Tilt angles for level display. Each axis is **independently nullable**: a
   * `deviceorientation` frame may carry one of `beta`/`gamma` and not the other
   * (the two are separate sensor fields, each `double?`), so `null` here means
   * "this axis was not measured in this frame" — it is **not** a tilt of 0°.
   * Folding it to `0` was the F-SH-755 defect: an unmeasured axis drew a bubble
   * on the centre line and printed `0.0°`, and (with the other axis inside the
   * 2° band) let the level tab claim 「已水平」 over a frame that never measured
   * it.
   */
  tilt: { x: number | null; y: number | null };
  /**
   * Whether tilt data is flowing — the accelerometer's `beta`/`gamma`. This is
   * what the **level** tab needs, and it stays true on a device with no
   * magnetometer.
   */
  available: boolean;
  /**
   * Whether a heading was actually reported — `alpha`, which needs a
   * magnetometer. `alpha` is `null` on a device that has none while `beta`/
   * `gamma` keep arriving, so "we have orientation data" and "we have a heading"
   * are **two** facts: the compass tab needs this one, the level tab needs
   * `available`.
   */
  headingKnown: boolean;
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
 * Pull the declination out of a World Magnetic Model API payload, or `null` when
 * the payload does not carry one. The API answers `{ result: [{ declination }] }`
 * with a **number**, but older/other endpoints return it as a numeric **string** —
 * both are accepted; anything else (missing field, `"east"`, `NaN`) is `null`.
 *
 * Pure on purpose: the parse rule is the part worth testing without a network, and
 * keeping it here means `fetchDeclination` is only network I/O on top of it.
 */
export function declinationFromApiPayload(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const result = (raw as { result?: unknown }).result;
  if (!Array.isArray(result) || result.length === 0) return null;
  const first = result[0];
  if (!first || typeof first !== "object") return null;
  const value = (first as { declination?: unknown }).declination;
  // A blank string is not a number: `Number("")` is 0, and accepting it would
  // fabricate exactly the plausible zero this function exists to refuse.
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return null;
  return validateDeclination(n);
}

/**
 * Fetch magnetic declination from the World Magnetic Model API.
 *
 * Returns `null` when the value could **not be obtained** — offline, a non-2xx
 * answer, an unparseable body, or a timeout. It deliberately does **not** fall
 * back to `0`: `0°` is a perfectly real declination (it holds along the agonic
 * line, and is within a degree or two of it over a lot of the planet), so a
 * fabricated zero is indistinguishable from a measured one and would be applied
 * as a true-north correction that never happened. `null` forces the caller to
 * decide what to show, which is the only way to keep the label honest.
 *
 * @param lat - Latitude in degrees (-90 to 90)
 * @param lon - Longitude in degrees (-180 to 180)
 * @returns Magnetic declination in degrees (+ = east, - = west), or `null` if unavailable
 * @throws Error if coordinates are invalid
 */
export async function fetchDeclination(lat: number, lon: number): Promise<number | null> {
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
      return null;
    }

    const declination = declinationFromApiPayload(await response.json());
    if (declination === null) {
      console.warn("[Compass] No usable declination in API response");
    }
    return declination;
  } catch (error) {
    // Re-throw validation errors (programming errors should fail fast)
    if (error instanceof Error && error.message.includes("Invalid latitude")) {
      throw error;
    }
    if (error instanceof Error && error.message.includes("Invalid longitude")) {
      throw error;
    }

    // Network errors, timeouts, parse errors - report "unknown", never a guess.
    console.warn("[Compass] Failed to fetch declination:", error);
    return null;
  }
}

/** A cached look-up site, with the time the declination there was obtained. */
export type DeclinationCacheLocation = { lat: number; lon: number; timestamp: number };

/** Reply of [`fetchDeclinationWithCache`]. */
export interface DeclinationResult {
  /**
   * The declination to use, or `null` when it is not known. A known `0` is a real
   * value; `null` is the absence of one — the two must not be conflated.
   */
  declination: number | null;
  /**
   * Cache site to persist alongside a **known** declination. On a failed look-up
   * this is the site handed in, unchanged (never a fresh one): a timestamp is a
   * claim that the value there was measured, so it is only minted on success.
   */
  cachedLocation: DeclinationCacheLocation | undefined;
  fromCache: boolean;
}

/**
 * Fetch declination with caching support.
 * Returns the cached value when it is still valid, otherwise fetches from the API
 * and — **only on success** — mints a fresh cache site.
 *
 * A failed look-up yields `declination: null` and leaves `cachedLocation` exactly
 * as it was handed in. The two rules go together: a caller that keys "do I know
 * the declination?" off `declination !== null` can never be told it knows one when
 * it does not, and a caller that keys it off the presence of a cache site can
 * never be handed a cache site that vouches for a value nobody measured.
 *
 * @param lat - Current latitude in degrees
 * @param lon - Current longitude in degrees
 * @param currentDeclination - The declination stored alongside `cachedLocation`
 * @param cachedLocation - Previously cached location data
 * @returns The declination (or `null`), the cache site to persist, and the source
 */
export async function fetchDeclinationWithCache(
  lat: number,
  lon: number,
  currentDeclination: number,
  cachedLocation?: DeclinationCacheLocation
): Promise<DeclinationResult> {
  // Check if cache is valid
  if (isCachedDeclinationValid(cachedLocation, lat, lon)) {
    // Use cached declination
    return {
      declination: currentDeclination,
      cachedLocation: cachedLocation!,
      fromCache: true,
    };
  }

  // Cache miss: ask the API. A failure is reported as unknown — the stale cache
  // site (if any) is passed straight back, not refreshed.
  const declination = await fetchDeclination(lat, lon);
  if (declination === null) {
    return { declination: null, cachedLocation, fromCache: false };
  }

  return {
    declination,
    cachedLocation: { lat, lon, timestamp: Date.now() },
    fromCache: false,
  };
}

/** Convert tilt angles to level percentage (0 = level, 100 = max tilt). */
export function levelPercentage(tiltX: number, tiltY: number): number {
  if (!Number.isFinite(tiltX) || !Number.isFinite(tiltY)) return 100;
  const magnitude = Math.sqrt(tiltX * tiltX + tiltY * tiltY);
  return Math.min(100, (magnitude / 90) * 100);
}

/**
 * Check if device is approximately level (within threshold degrees).
 *
 * A `null` axis is **not** level: "we did not measure this axis" is not the same
 * claim as "this axis reads 0°", and the level tab draws 「已水平」 off this
 * answer — so an unmeasured axis must refuse the claim (F-SH-755).
 */
export function isLevel(tiltX: number | null, tiltY: number | null, threshold = 2): boolean {
  if (tiltX === null || tiltY === null) return false;
  if (!Number.isFinite(tiltX) || !Number.isFinite(tiltY)) return false;
  if (!Number.isFinite(threshold) || threshold < 0) return false;
  return Math.abs(tiltX) < threshold && Math.abs(tiltY) < threshold;
}
