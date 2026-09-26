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

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Lowest tone factor — the lens never goes fully black (0% floors here, not to 0). */
export const MIN_TONE_FACTOR = 0.05;
/** Highest tone factor — the sliders' [MAX_TONE] (200%) means 2×, per the docs above. */
export const MAX_TONE_FACTOR = MAX_TONE / 100;

/**
 * Convert a tone **percentage** — the sliders' own domain, `[MIN_TONE]..[MAX_TONE]`
 * with `[DEFAULT_TONE]` (100) neutral — into the CSS `brightness()`/`contrast()`
 * **factor** the filter wants: 100% → 1.0 (no change), 200% → 2.0, 0% → floored to
 * [MIN_TONE_FACTOR] so the lens is never fully black.
 *
 * This is the *only* place the two domains meet. It exists because they drifted
 * once: the component handed raw percentages to a factor-domain clamp, so every
 * slider position from 1% to 200% produced the same `brightness(1) contrast(1)` and
 * the sliders were inert (REQ-A729 / F-SH-187).
 */
export function toneFactor(percent: number): number {
  return clamp(percent / 100, MIN_TONE_FACTOR, MAX_TONE_FACTOR);
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

/**
 * CSS filter string applying brightness/contrast to a canvas.
 *
 * Both arguments are the sliders' **percentages** (`[MIN_TONE]..[MAX_TONE]`, 100 =
 * neutral) — the same values the component holds in `bright`/`contrast` and the same
 * ones `normalizeMagnifierSettings` persists — so no caller has to remember to divide.
 */
export function toneFilter(brightness: number, contrast: number): string {
  return `brightness(${toneFactor(brightness)}) contrast(${toneFactor(contrast)})`;
}
