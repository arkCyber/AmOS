/**
 * Magnifier geometry + tone math (pure — unit-testable without a DOM).
 *
 * The lens is a circle of radius [LENS_R] that magnifies the content underneath
 * its centre. All the numbers here are shared by the component (MagnifierApp)
 * and its unit tests.
 */

/** Lens outer radius in CSS pixels (the lens canvas is 2R×2R device px). */
export const LENS_R = 66;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
export const DEFAULT_ZOOM = 2;
/** Brightness/contrast slider default (100 → tone factor 1.0 = no change). */
export const DEFAULT_TONE = 100;
/** Range the tone sliders expose (0–200 → tone factor 0–2). */
export const MIN_TONE = 0;
export const MAX_TONE = 200;

/** Shared-store key persisting the last-used Magnifier adjustments (iOS-like). */
export const MAGNIFIER_SETTINGS_KEY = "amos.magnifier";

/** User-tweakable Magnifier adjustments, persisted across app opens. */
export interface MagnifierSettings {
  zoom: number;
  brightness: number;
  contrast: number;
}

/** The neutral starting settings (also what Reset restores to). */
export function defaultMagnifierSettings(): MagnifierSettings {
  return { zoom: DEFAULT_ZOOM, brightness: DEFAULT_TONE, contrast: DEFAULT_TONE };
}

function clampSetting(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : fallback;
}

/**
 * Coerce a raw persisted payload (absent/corrupt/out-of-range) into a safe,
 * clamped {@link MagnifierSettings}. Never throws — absent/corrupt → defaults.
 */
export function normalizeMagnifierSettings(raw: unknown): MagnifierSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  return {
    zoom: clampSetting(o.zoom, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM),
    brightness: clampSetting(o.brightness, DEFAULT_TONE, MIN_TONE, MAX_TONE),
    contrast: clampSetting(o.contrast, DEFAULT_TONE, MIN_TONE, MAX_TONE),
  };
}

/** Clamp to a sane tone factor: never fully black, never blown out. */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0.05, v));
}
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Clamp a lens centre so the circle stays fully inside a `w`×`h` viewport.
 * Degenerate (tiny / zero-sized) viewports clamp to the lens radius so the
 * circle is never pushed off-canvas.
 */
export function clampCenter(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: clamp(x, LENS_R, Math.max(LENS_R, w - LENS_R)),
    y: clamp(y, LENS_R, Math.max(LENS_R, h - LENS_R)),
  };
}

/** The lens centre for a `w`×`h` viewport — its middle, kept in bounds. */
export function centredLens(w: number, h: number): { x: number; y: number } {
  return clampCenter(w / 2, h / 2, w, h);
}

/**
 * Radius of the source sub-rectangle the lens samples from the base scene. The
 * lens circle (radius [lensRadius]) shows a `1/zoom`-sized slice blown up to
 * fill it, i.e. content underneath is magnified `zoom`×.
 */
export function lensSourceRadius(zoom: number, lensRadius: number = LENS_R): number {
  return Math.max(0.5, lensRadius / Math.max(1, zoom));
}

/** CSS filter string applying brightness/contrast tone factors to a canvas. */
export function toneFilter(brightness: number, contrast: number): string {
  return `brightness(${clamp01(brightness)}) contrast(${clamp01(contrast)})`;
}
