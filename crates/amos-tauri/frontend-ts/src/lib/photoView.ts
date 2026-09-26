/**
 * photoView.ts — the photo viewer's **zoom / pan** model (REQ-A1147).
 *
 * The viewer used to show every photo in a fixed 160×160 box with no way to look closer,
 * which is the one thing a photo viewer is for. This is the arithmetic half of the fix: a
 * [`View`] is a plain value (a zoom factor and a pan offset in stage pixels), and every
 * function here is pure, so the whole gesture model — fit, clamp, zoom-about-a-point,
 * double-tap — is decided headlessly and the screen only maps pointer events onto it.
 *
 * Three deliberate properties:
 *
 * 1. **The image is never left off-screen.** [`clampPan`] derives the allowed offset from the
 *    *displayed* size: at fit there is no slack at all (offset pinned to 0), and once zoomed
 *    the image may travel exactly far enough to show its edge and no further. A pan with no
 *    clamp is a gesture that can strand the user on a blank stage with no way back.
 * 2. **Zoom holds the point under the fingers.** [`zoomAt`] solves for the offset that keeps
 *    the stage point being pinched pinned to the same image pixel, so a pinch magnifies what
 *    the user aimed at rather than the centre of the photo.
 * 3. **Nothing here measures anything.** The stage and the image are passed in, so the model
 *    has no DOM, no `ResizeObserver`, and no timers — the same split `photoEdit`'s geometry
 *    uses.
 */

/** A width/height pair in pixels. */
export interface Size {
  w: number;
  h: number;
}

/** What the viewer is looking at: the image's intrinsic size and the stage it sits in. */
export interface ViewBox {
  img: Size;
  stage: Size;
}

/** A zoom factor (1 = fit) and a pan offset from the stage centre, in stage pixels. */
export interface View {
  zoom: number;
  x: number;
  y: number;
}

/** Fit-to-stage: the whole photo is visible. */
export const MIN_ZOOM = 1;

/** Beyond this a photo is a field of pixels and a phone's pinch has no precision left. */
export const MAX_ZOOM = 4;

/** What a double-tap magnifies to (and back from). */
export const ZOOM_STEP = 2;

export function defaultView(): View {
  return { zoom: MIN_ZOOM, x: 0, y: 0 };
}

/** Clamp a zoom factor into `[MIN_ZOOM, MAX_ZOOM]`; a non-finite input is the fit factor. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * The scale that fits `img` inside `stage` (the smaller ratio), or `1` when either has no
 * extent — a stage that has not been laid out yet must not produce a `NaN`/`Infinity` scale
 * that would poison every downstream offset.
 */
export function fitScale(img: Size, stage: Size): number {
  if (!(img.w > 0) || !(img.h > 0) || !(stage.w > 0) || !(stage.h > 0)) return 1;
  return Math.min(stage.w / img.w, stage.h / img.h);
}

/** The on-screen size of the image for a view. */
export function imageBox(v: View, box: ViewBox): Size {
  const s = fitScale(box.img, box.stage) * clampZoom(v.zoom);
  return { w: box.img.w * s, h: box.img.h * s };
}

/**
 * Clamp a view so the image cannot be dragged away from the stage.
 *
 * At fit the displayed image is no larger than the stage, so the only valid offset is `0` —
 * derived from the box rather than special-cased, so the same line also handles the axis that
 * still fits while the other overflows (a portrait photo in a square stage pans vertically
 * before it pans horizontally).
 */
export function clampPan(v: View, box: ViewBox): View {
  const zoom = clampZoom(v.zoom);
  const b = imageBox({ ...v, zoom }, box);
  const mx = Math.max(0, (b.w - box.stage.w) / 2);
  const my = Math.max(0, (b.h - box.stage.h) / 2);
  return {
    zoom,
    x: Math.min(mx, Math.max(-mx, Number.isFinite(v.x) ? v.x : 0)),
    y: Math.min(my, Math.max(-my, Number.isFinite(v.y) ? v.y : 0)),
  };
}

/**
 * Zoom by `factor`, keeping the stage point `(px, py)` over the same image pixel.
 *
 * With the stage centre as the origin, an offset `o` places image point `i` at stage point
 * `o + s·i`. Requiring the pinned point `d` to keep its image pixel across the zoom gives
 * `o' = d·(1 - k) + k·o`, where `k` is the ratio of the new on-screen scale to the old.
 */
export function zoomAt(v: View, factor: number, px: number, py: number, box: ViewBox): View {
  const zoom = clampZoom(v.zoom * factor);
  // Clamped at the ceiling the ratio is 1, so the offset must not move either.
  const k = zoom / clampZoom(v.zoom);
  const dx = px - box.stage.w / 2;
  const dy = py - box.stage.h / 2;
  return clampPan({ zoom, x: dx * (1 - k) + k * v.x, y: dy * (1 - k) + k * v.y }, box);
}

/** Drag the photo by a stage-pixel delta (clamped, so a drag cannot escape the stage). */
export function panBy(v: View, dx: number, dy: number, box: ViewBox): View {
  return clampPan({ ...v, x: v.x + dx, y: v.y + dy }, box);
}

/**
 * Double-tap: magnify about the tapped point, or return to fit when already zoomed.
 *
 * The "already zoomed" test is `zoom > MIN_ZOOM`, not "the view differs from the default":
 * a photo panned back to the centre by hand is still zoomed, and a tap there must reset it
 * rather than magnify further.
 */
export function toggleZoom(v: View, px: number, py: number, box: ViewBox): View {
  return isZoomed(v) ? defaultView() : zoomAt(v, ZOOM_STEP, px, py, box);
}

/** Whether the view is magnified beyond fit. */
export function isZoomed(v: View): boolean {
  return clampZoom(v.zoom) > MIN_ZOOM;
}
