/* Pure camera-control helpers (no DOM) so the viewfinder UI is thin and the
 * toggle/capture math is unit-testable headlessly. Mirrors common phone-camera
 * options: lens flip, flash, timer, aspect ratio, zoom and rule-of-thirds grid. */

export type CamFacing = "back" | "front";
export type CamFlash = "auto" | "on" | "off";
export type CamRatio = "4:3" | "square" | "16:9";
export type CamZoom = number; // 1 = no zoom

export const FACING_ORDER: CamFacing[] = ["back", "front"];
export const FLASH_ORDER: CamFlash[] = ["auto", "on", "off"];
export const RATIO_ORDER: CamRatio[] = ["4:3", "square", "16:9"];
/** Timer presets in seconds (0 = capture immediately). */
export const TIMER_PRESETS = [0, 3, 10];
export const ZOOM_STEPS = [1, 2, 3];
/** Cap zoom so a misbehaving value can't produce a degenerate crop. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;
export const ZOOM_SLIDER_STEP = 0.25;

/* ---- Viewfinder capture resolution presets (iPhone-like tiers) ---- */
export type CamResId = "sd" | "hd" | "fhd";
export interface CamRes {
  id: CamResId;
  label: string;
  w: number;
  h: number;
}
export const RESOLUTIONS: CamRes[] = [
  { id: "sd", label: "SD", w: 640, h: 480 },
  { id: "hd", label: "HD", w: 1280, h: 720 },
  { id: "fhd", label: "FHD", w: 1920, h: 1080 },
];
export function resOf(id: string): CamRes {
  return RESOLUTIONS.find((r) => r.id === id) ?? RESOLUTIONS[1]!;
}
/** Next resolution id (wraps SD → HD → FHD → SD). */
export function nextRes(id: CamResId): CamResId {
  const i = RESOLUTIONS.findIndex((r) => r.id === id);
  return RESOLUTIONS[(i + 1) % RESOLUTIONS.length]!.id;
}


/** The capture canvas size for a chosen aspect ratio (a 640-wide source). */
export function captureDims(ratio: CamRatio): { w: number; h: number } {
  switch (ratio) {
    case "square":
      return { w: 640, h: 640 };
    case "16:9":
      return { w: 640, h: 360 };
    case "4:3":
    default:
      return { w: 640, h: 480 };
  }
}

/** getUserMedia facingMode value for a lens choice. */
export function facingMode(f: CamFacing): string {
  return f === "front" ? "user" : "environment";
}

/** Mirror the preview only on the front (selfie) lens. */
export function mirrorPreview(f: CamFacing): boolean {
  return f === "front";
}

/** Clamp a zoom to a sane range. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * The largest `out.aspect`-shaped region that fits inside the source, centred
 * (no letterboxing, no stretching). Used when capture must obey the chosen
 * aspect ratio even at 1× zoom. Returns null when the video has no size yet.
 */
export function fitCrop(
  vw: number,
  vh: number,
  out: { w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
  if (!(vw > 0) || !(vh > 0)) return null;
  const scale = Math.min(vw / out.w, vh / out.h);
  const w = out.w * scale;
  const h = out.h * scale;
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}

/** True when the video source is not 1:1 with the target aspect (needs crop). */
export function needsCrop(vw: number, vh: number, out: { w: number; h: number }): boolean {
  const crop = fitCrop(vw, vh, out);
  return crop ? Math.abs(crop.w - vw) > 1 || Math.abs(crop.h - vh) > 1 : false;
}

/**
 * The centre-crop rectangle (in *video* pixels) that corresponds to `zoom` at 1 =
 * full frame. Returns null when zoom ≤ 1 (capture the whole frame) or when the
 * video has no dimensions yet. `out` is the target canvas size.
 */
export function zoomCrop(
  vw: number,
  vh: number,
  zoom: number,
  out: { w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
  const z = clampZoom(zoom);
  if (z <= ZOOM_MIN || !(vw > 0) || !(vh > 0)) return null;
  // Fit the target aspect inside the video, then zoom that region down further.
  const scale = Math.min(vw / out.w, vh / out.h);
  let cw = (out.w * scale) / z;
  let ch = (out.h * scale) / z;
  if (cw > vw) {
    const k = vw / cw;
    cw = vw;
    ch *= k;
  }
  if (ch > vh) {
    const k = vh / ch;
    ch = vh;
    cw *= k;
  }
  return { x: (vw - cw) / 2, y: (vh - ch) / 2, w: cw, h: ch };
}

/** Cycle helpers: return the value after `current` within `order` (wraps). */
export function cycleAfter<T>(order: readonly T[], current: T): T {
  const i = order.indexOf(current);
  return order[(i + 1) % order.length] ?? order[0]!;
}

/** Next zoom step (cycles 1 → 2 → 3 → back to 1). */
export function nextZoom(current: number): number {
  return cycleAfter(ZOOM_STEPS, clampZoom(current));
}

/* ---- Tap-to-focus / AE-AF lock (pure model; hardware focus via track
 *       applyConstraints pointsOfInterest is best-effort and device-gated).
 *       iOS behaviour: tap sets an AF point; a second tap on the same point
 *       locks exposure+focus ("AE/AF LOCK"); tapping elsewhere re-aims. ---- */
export interface FocusPoint {
  /** Normalised 0..1 within the viewfinder (0,0 = top-left). */
  x: number;
  y: number;
}
export interface AfState {
  x: number | null;
  y: number | null;
  locked: boolean;
}

/** Clamp a coordinate to the 0..1 unit viewfinder. */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** Convert a pointer position (relative to the viewfinder element) into a
 * normalised focus point. Returns null when the element has no area yet. */
export function focusFromRect(
  cx: number,
  cy: number,
  rect: { x: number; y: number; width: number; height: number },
): FocusPoint | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return { x: clamp01((cx - rect.x) / rect.width), y: clamp01((cy - rect.y) / rect.height) };
}

export function afInit(): AfState {
  return { x: null, y: null, locked: false };
}

/** First tap aims (unlocked) at the point; a second tap within `tol` locks
 * (AE/AF LOCK); a tap elsewhere re-aims and unlocks. Pure. */
export function afTap(s: AfState, p: FocusPoint, tol = 0.04): AfState {
  if (
    s.x !== null &&
    s.y !== null &&
    !s.locked &&
    Math.abs(s.x - p.x) <= tol &&
    Math.abs(s.y - p.y) <= tol
  ) {
    return { ...s, locked: true };
  }
  return { x: p.x, y: p.y, locked: false };
}

/** The iOS "AE/AF LOCK" caption when a locked point is shown. */
export function afCaption(state: AfState): string {
  return state.locked ? "AE/AF LOCKED" : "AF";
}
