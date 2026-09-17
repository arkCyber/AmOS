/**
 * measure.ts — pure logic for the Measure app.
 *
 * Provides measurement calculations, unit conversions, and state management
 * for AR-style distance/dimension measurements using camera and reference objects.
 */

export interface MeasureSettings {
  /** Preferred unit system. */
  unit: "metric" | "imperial";
  /** Camera reference distance (mm, calibrated). */
  referenceDistance: number;
  /** Show measurement guides. */
  showGuides: boolean;
}

export interface MeasurePoint {
  /** Screen x coordinate (0-1, normalized). */
  x: number;
  /** Screen y coordinate (0-1, normalized). */
  y: number;
  /** Optional depth hint (mm, from calibration). */
  depth?: number;
}

export interface Measurement {
  /** Unique ID. */
  id: string;
  /** Start point. */
  start: MeasurePoint;
  /** End point. */
  end: MeasurePoint;
  /** Measured distance (mm). */
  distance: number;
  /** Timestamp. */
  timestamp: number;
  /** Optional label. */
  label?: string;
}

export const MEASURE_SETTINGS_KEY = "amos.measure.settings";
export const MEASURE_HISTORY_KEY = "amos.measure.history";

/** Default reference distance (mm) - assumes ~500mm (50cm) from camera. */
const DEFAULT_REFERENCE_DISTANCE = 500;

/** Default settings. */
export function defaultMeasureSettings(): MeasureSettings {
  return {
    unit: "metric",
    referenceDistance: DEFAULT_REFERENCE_DISTANCE,
    showGuides: true,
  };
}

/** Normalize persisted settings. */
export function normalizeMeasureSettings(raw: unknown): MeasureSettings {
  const d = defaultMeasureSettings();
  if (!raw || typeof raw !== "object") return d;
  const obj = raw as Record<string, unknown>;
  return {
    unit: obj.unit === "imperial" ? "imperial" : d.unit,
    referenceDistance:
      typeof obj.referenceDistance === "number" && obj.referenceDistance > 0
        ? obj.referenceDistance
        : d.referenceDistance,
    showGuides: typeof obj.showGuides === "boolean" ? obj.showGuides : d.showGuides,
  };
}

/** Normalize measurement history. */
export function normalizeMeasureHistory(raw: unknown): Measurement[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && typeof m === "object")
    .map((m) => {
      const obj = m as Record<string, unknown>;
      if (
        typeof obj.id !== "string" ||
        typeof obj.distance !== "number" ||
        typeof obj.timestamp !== "number" ||
        !isValidPoint(obj.start) ||
        !isValidPoint(obj.end)
      ) {
        return null;
      }
      return {
        id: obj.id,
        start: obj.start as MeasurePoint,
        end: obj.end as MeasurePoint,
        distance: obj.distance,
        timestamp: obj.timestamp,
        label: typeof obj.label === "string" ? obj.label : undefined,
      };
    })
    .filter((m): m is Measurement => m !== null)
    .slice(0, 50); // Keep last 50 measurements
}

function isValidPoint(p: unknown): boolean {
  if (!p || typeof p !== "object") return false;
  const obj = p as Record<string, unknown>;
  return (
    typeof obj.x === "number" &&
    typeof obj.y === "number" &&
    obj.x >= 0 &&
    obj.x <= 1 &&
    obj.y >= 0 &&
    obj.y <= 1
  );
}

/**
 * Calculate 2D distance between two points (pixels).
 * Returns pixel distance in the viewport.
 */
export function pixelDistance(
  p1: MeasurePoint,
  p2: MeasurePoint,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const dx = (p2.x - p1.x) * viewportWidth;
  const dy = (p2.y - p1.y) * viewportHeight;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Estimate real-world distance (mm) from pixel distance.
 * Uses simple pinhole camera model with reference distance calibration.
 * 
 * Formula: realDistance = (pixelDistance / viewportWidth) * referenceWidth
 * where referenceWidth is derived from field of view and reference distance.
 */
export function estimateRealDistance(
  pixelDist: number,
  viewportWidth: number,
  referenceDistance: number,
): number {
  // Assume ~60° horizontal FOV (typical smartphone camera)
  const fovRadians = (60 * Math.PI) / 180;
  const referenceWidth = 2 * referenceDistance * Math.tan(fovRadians / 2);
  const pixelRatio = pixelDist / viewportWidth;
  return pixelRatio * referenceWidth;
}

/**
 * Calculate distance between two points and return measurement.
 */
export function createMeasurement(
  start: MeasurePoint,
  end: MeasurePoint,
  viewportWidth: number,
  viewportHeight: number,
  referenceDistance: number,
  label?: string,
): Measurement {
  const pixelDist = pixelDistance(start, end, viewportWidth, viewportHeight);
  const realDist = estimateRealDistance(pixelDist, viewportWidth, referenceDistance);
  
  return {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    start,
    end,
    distance: realDist,
    timestamp: Date.now(),
    label,
  };
}

/** Convert mm to display string with unit. */
export function formatDistance(mm: number, unit: "metric" | "imperial"): string {
  if (unit === "imperial") {
    const inches = mm / 25.4;
    if (inches < 12) {
      return `${inches.toFixed(1)}"`;
    }
    const feet = Math.floor(inches / 12);
    const remainingInches = inches % 12;
    return remainingInches < 0.5
      ? `${feet}'`
      : `${feet}' ${remainingInches.toFixed(1)}"`;
  }
  
  // Metric
  if (mm < 10) {
    return `${mm.toFixed(1)} mm`;
  } else if (mm < 100) {
    return `${Math.round(mm)} mm`;
  } else if (mm < 1000) {
    return `${(mm / 10).toFixed(1)} cm`;
  } else {
    return `${(mm / 1000).toFixed(2)} m`;
  }
}

/** Parse distance string (e.g. "50cm", "12in") to mm. */
export function parseDistance(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  
  // Metric
  const mmMatch = trimmed.match(/^([\d.]+)\s*mm$/);
  if (mmMatch) return parseFloat(mmMatch[1]);
  
  const cmMatch = trimmed.match(/^([\d.]+)\s*cm$/);
  if (cmMatch) return parseFloat(cmMatch[1]) * 10;
  
  const mMatch = trimmed.match(/^([\d.]+)\s*m$/);
  if (mMatch) {
    const val = parseFloat(mMatch[1]);
    return isNaN(val) ? null : val * 1000;
  }
  
  // Imperial (must come before bare number check)
  const inMatch = trimmed.match(/^([\d.]+)\s*(?:in|")$/);
  if (inMatch) return parseFloat(inMatch[1]) * 25.4;
  
  const ftMatch = trimmed.match(/^([\d.]+)\s*(?:ft|')$/);
  if (ftMatch) return parseFloat(ftMatch[1]) * 304.8;
  
  // Feet + inches (e.g. "5' 6\"", "5ft 6in")
  const ftInMatch = trimmed.match(/^([\d.]+)\s*(?:ft|')\s*([\d.]+)\s*(?:in|")?$/);
  if (ftInMatch) {
    const feet = parseFloat(ftInMatch[1]);
    const inches = parseFloat(ftInMatch[2]);
    return (feet * 12 + inches) * 25.4;
  }
  
  return null;
}

/**
 * Calibrate reference distance using known object size.
 * User measures a known object (e.g. credit card = 85.6mm) to improve accuracy.
 */
export function calibrateReference(
  knownSizeMm: number,
  measuredPixels: number,
  viewportWidth: number,
  currentReference: number,
): number {
  // Reverse the estimation formula
  const fovRadians = (60 * Math.PI) / 180;
  const pixelRatio = measuredPixels / viewportWidth;
  const referenceWidth = knownSizeMm / pixelRatio;
  const newReference = referenceWidth / (2 * Math.tan(fovRadians / 2));
  
  // Sanity check: reference distance should be 100-2000mm
  if (newReference < 100 || newReference > 2000) {
    return currentReference; // Keep current if calibration seems wrong
  }
  
  return newReference;
}

/** Common reference objects for calibration. */
export const REFERENCE_OBJECTS = {
  creditCard: { name: "credit_card", size: 85.6, unit: "mm" as const },
  a4Paper: { name: "a4_paper", size: 297, unit: "mm" as const },
  usDollar: { name: "us_dollar", size: 156, unit: "mm" as const },
  usLetter: { name: "us_letter", size: 279.4, unit: "mm" as const },
} as const;

/** Get reference object by name. */
export function getReferenceObject(name: string) {
  const key = name as keyof typeof REFERENCE_OBJECTS;
  return REFERENCE_OBJECTS[key] ?? null;
}
