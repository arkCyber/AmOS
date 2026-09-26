/**
 * photoEdit.ts — the **edit** half of the photo domain (REQ-A1147).
 *
 * The gallery could browse, favourite, share and export a photo, but it could not *change*
 * one: a whole-tree grep for `crop` / `rotate` / `filter(` found nothing but the camera's
 * own capture path (`CameraApp` draws a video frame into a canvas; it never edits a stored
 * photo). This module is the missing piece.
 *
 * Three properties are deliberate, and each one is the reason a specific choice was made:
 *
 * 1. **The edit is data, not a canvas.** A [`PhotoEdit`] is a plain value (rotation,
 *    flips, a normalised crop, a filter preset, three adjustments). Every reducer returns a
 *    new value, so the screen can hold it in `$state` and render a live preview, and the
 *    headless suite can test the whole model without a DOM.
 * 2. **The preview and the saved pixels share one source of truth.** [`previewTransform`]
 *    and [`filterCss`] are what the on-screen `<img>` is styled with, and [`drawEdited`]
 *    applies the *same* values to the canvas that gets exported. A preview that is computed
 *    a second time is a preview that will eventually disagree with the file the user saves.
 * 3. **Rendering is honest about failing.** `getContext("2d")` can return null (a WebView
 *    build without canvas, a tainted source) and `toDataURL` can throw. Both are reported as
 *    a `null`/`false` verdict, never as a silent success — the caller must not claim a save
 *    that did not happen (the same rule `mediaExport` follows for its write).
 *
 * **Crop frame.** The crop rectangle is expressed in the **rotated + flipped** frame — the
 * frame the user is actually looking at after they turn the photo. This is what iOS does
 * (a crop drawn on a turned photo stays on that region), and it is why `cropPx` derives its
 * pixel rectangle from {@link rotatedSize} rather than from the source dimensions.
 */

/** Quarter-turn rotations, in degrees clockwise. */
export type Rot = 0 | 90 | 180 | 270;

/** Which axis a flip mirrors across. */
export type FlipAxis = "h" | "v";

/** The preset list, in tool order (the toolbar renders exactly this). The type is derived
 *  from it so a preset is added or renamed in one place. */
export const FILTERS = ["none", "mono", "sepia", "vivid"] as const;

/** The filter presets. */
export type FilterKind = (typeof FILTERS)[number];

/** A normalised rectangle (`0..1` on both axes) in the rotated frame. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The three continuous adjustments; **1 is neutral** on every one of them. */
export interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface PhotoEdit {
  rot: Rot;
  flipH: boolean;
  flipV: boolean;
  /** Region of the rotated frame to keep; the whole frame is [`FULL_CROP`]. */
  crop: Rect;
  filter: FilterKind;
  adjust: Adjust;
}

/** The whole rotated frame. */
export const FULL_CROP: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** Adjustment clamp: below 0.5 a photo is crushed to black/flat, above 1.5 it clips. */
export const ADJUST_MIN = 0.5;
export const ADJUST_MAX = 1.5;

/** Smallest crop side, as a fraction of the frame — a 1-pixel crop is not an edit, it is a
 *  way to lose the photo (and a zero-area canvas throws in `toDataURL`). */
export const CROP_MIN = 0.05;

/** Longest side of a saved edit, in pixels. An edit is re-encoded into a data URL and stored
 *  in `amos.photos` (localStorage), so the output has to be **bounded**: a 50 MP source
 *  cropped and re-encoded at full size is a ~20 MB base64 string, which is a quota refusal
 *  (and a `writeStoreValue` that fails) rather than a saved photo. Downscaling only — a photo
 *  smaller than this is written 1:1. */
export const MAX_EXPORT_EDGE = 4096;

/** JPEG quality for a saved edit. Named rather than inlined so the encode policy has one
 *  spelling (and so a test can pin it instead of repeating the literal). */
export const EXPORT_QUALITY = 0.92;

/**
 * Scale `w`×`h` down so its longest side is at most `maxEdge`, **never enlarging**.
 *
 * The result is integer pixels (a canvas dimension is one) and at least 1×1. `scale` is the
 * exact ratio *before* rounding, so a caller that wants an exact mapping can use `w/sw` —
 * see {@link drawEdited}, which does exactly that.
 */
export function fitEdge(
  w: number,
  h: number,
  maxEdge: number = MAX_EXPORT_EDGE,
): { w: number; h: number; scale: number } {
  const cap = Number.isFinite(maxEdge) && maxEdge >= 1 ? maxEdge : MAX_EXPORT_EDGE;
  const longest = Math.max(w, h);
  const scale = longest > cap ? cap / longest : 1;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

export function defaultEdit(): PhotoEdit {
  return {
    rot: 0,
    flipH: false,
    flipV: false,
    crop: { ...FULL_CROP },
    filter: "none",
    adjust: { brightness: 1, contrast: 1, saturation: 1 },
  };
}

/** Clamp to the adjustment range; a non-finite input falls back to neutral rather than
 *  poisoning the whole filter string with `NaN` (which browsers drop silently). */
function clampAdjust(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(ADJUST_MAX, Math.max(ADJUST_MIN, v));
}

/** Turn the photo a quarter step clockwise (`dir = 1`) or counter-clockwise (`dir = -1`). */
export function rotateEdit(e: PhotoEdit, dir: 1 | -1): PhotoEdit {
  const rot = (((e.rot + dir * 90) % 360) + 360) % 360;
  return { ...e, rot: rot as Rot };
}

/** Mirror across the horizontal (left/right) or vertical (top/bottom) axis. */
export function flipEdit(e: PhotoEdit, axis: FlipAxis): PhotoEdit {
  return axis === "h" ? { ...e, flipH: !e.flipH } : { ...e, flipV: !e.flipV };
}

export function setFilter(e: PhotoEdit, filter: FilterKind): PhotoEdit {
  return { ...e, filter };
}

/** Patch one or more adjustments (each clamped; missing keys are left alone). */
export function setAdjust(e: PhotoEdit, patch: Partial<Adjust>): PhotoEdit {
  const next: Adjust = { ...e.adjust };
  if (patch.brightness !== undefined) next.brightness = clampAdjust(patch.brightness);
  if (patch.contrast !== undefined) next.contrast = clampAdjust(patch.contrast);
  if (patch.saturation !== undefined) next.saturation = clampAdjust(patch.saturation);
  return { ...e, adjust: next };
}

/**
 * Clamp a rectangle into `0..1` at or above [`CROP_MIN`] on both axes.
 *
 * A drag handler can produce any rectangle at all (a pointer that leaves the preview box, a
 * pinch that collapses a corner past its opposite). Clamping here — rather than in each
 * handler — makes "the crop is always valid" an invariant of the model, so `cropPx` never
 * has to defend against a negative or out-of-frame region.
 */
export function clampRect(r: Rect): Rect {
  const w = Math.min(1, Math.max(CROP_MIN, Number.isFinite(r.w) ? r.w : 1));
  const h = Math.min(1, Math.max(CROP_MIN, Number.isFinite(r.h) ? r.h : 1));
  const x = Math.min(1 - w, Math.max(0, Number.isFinite(r.x) ? r.x : 0));
  const y = Math.min(1 - h, Math.max(0, Number.isFinite(r.y) ? r.y : 0));
  return { x, y, w, h };
}

/** Set the crop (clamped). */
export function setCrop(e: PhotoEdit, r: Rect): PhotoEdit {
  return { ...e, crop: clampRect(r) };
}

/** Move a crop rectangle by a normalised delta, keeping it inside the frame. */
export function moveCrop(r: Rect, dx: number, dy: number): Rect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy });
}

/** The four draggable corners of the crop rectangle. */
export type CropHandle = "nw" | "ne" | "sw" | "se";

/**
 * Drag one corner by a normalised delta.
 *
 * Each corner moves the two edges it owns; the **opposite corner is the anchor** and does
 * not move. The minimum size is enforced against that anchor (`x = right - MIN`, not
 * `x += dx` then clamp) — clamping an over-dragged corner by its own coordinate would slide
 * the whole rectangle to the far edge and tear the kept region away from the anchor the user
 * was holding, which reads as the crop jumping out from under the pointer.
 */
export function resizeCrop(r: Rect, handle: CropHandle, dx: number, dy: number): Rect {
  const right = r.x + r.w;
  const bottom = r.y + r.h;
  let { x, y, w, h } = r;
  if (handle === "nw") {
    // Anchor: bottom-right.
    x = Math.min(right - CROP_MIN, Math.max(0, r.x + dx));
    y = Math.min(bottom - CROP_MIN, Math.max(0, r.y + dy));
    w = right - x;
    h = bottom - y;
  } else if (handle === "ne") {
    // Anchor: bottom-left.
    y = Math.min(bottom - CROP_MIN, Math.max(0, r.y + dy));
    w = Math.min(1 - r.x, Math.max(CROP_MIN, r.w + dx));
    h = bottom - y;
  } else if (handle === "sw") {
    // Anchor: top-right.
    x = Math.min(right - CROP_MIN, Math.max(0, r.x + dx));
    w = right - x;
    h = Math.min(1 - r.y, Math.max(CROP_MIN, r.h + dy));
  } else {
    // Anchor: top-left.
    w = Math.min(1 - r.x, Math.max(CROP_MIN, r.w + dx));
    h = Math.min(1 - r.y, Math.max(CROP_MIN, r.h + dy));
  }
  return clampRect({ x, y, w, h });
}

/** True when the edit would change nothing — the caller can skip the render entirely. */
export function isNoop(e: PhotoEdit): boolean {
  return (
    e.rot === 0 &&
    !e.flipH &&
    !e.flipV &&
    e.filter === "none" &&
    e.adjust.brightness === 1 &&
    e.adjust.contrast === 1 &&
    e.adjust.saturation === 1 &&
    e.crop.x === FULL_CROP.x &&
    e.crop.y === FULL_CROP.y &&
    e.crop.w === FULL_CROP.w &&
    e.crop.h === FULL_CROP.h
  );
}

/** The size of the frame after rotation (90/270 swap the axes). */
export function rotatedSize(w: number, h: number, rot: Rot): { w: number; h: number } {
  return rot === 90 || rot === 270 ? { w: h, h: w } : { w, h };
}

/** What a preset does, as numbers the CSS filter string and the canvas both consume. */
interface FilterSpec {
  /** Multiplier folded into the saturation adjustment. */
  sat: number;
  /** Extra contrast the preset adds on top of the adjustment. */
  contrast: number;
  gray: boolean;
  sepia: boolean;
}

function filterSpec(kind: FilterKind): FilterSpec {
  switch (kind) {
    case "mono":
      return { sat: 1, contrast: 1, gray: true, sepia: false };
    case "sepia":
      return { sat: 1, contrast: 1, gray: false, sepia: true };
    case "vivid":
      return { sat: 1.4, contrast: 1.05, gray: false, sepia: false };
    default:
      return { sat: 1, contrast: 1, gray: false, sepia: false };
  }
}

/** Round to 3 decimals so the same edit always produces a byte-identical filter string
 *  (the preview and the saved render are compared in the suite). */
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The CSS filter for this edit.
 *
 * This is applied to the on-screen preview *and* assigned to `ctx.filter` in
 * {@link drawEdited}, so what the user sees is what gets written.
 */
export function filterCss(e: PhotoEdit): string {
  const spec = filterSpec(e.filter);
  const parts = [
    `brightness(${r3(e.adjust.brightness)})`,
    `contrast(${r3(e.adjust.contrast * spec.contrast)})`,
    `saturate(${r3(e.adjust.saturation * spec.sat)})`,
  ];
  if (spec.gray) parts.push("grayscale(1)");
  if (spec.sepia) parts.push("sepia(0.85)");
  return parts.join(" ");
}

/**
 * The CSS transform for this edit, in the same order the canvas render uses
 * (`rotate` then `scale`) — preview and saved pixels again agree.
 */
export function previewTransform(e: PhotoEdit): string {
  return `rotate(${e.rot}deg) scaleX(${e.flipH ? -1 : 1}) scaleY(${e.flipV ? -1 : 1})`;
}

/**
 * The source-pixel rectangle to keep, in the rotated frame.
 *
 * Always at least 1×1 (a zero-width canvas makes `toDataURL` throw) and never past the
 * frame's edge, so the `drawImage` call in {@link drawEdited} can trust it.
 */
export function cropPx(
  e: PhotoEdit,
  rotW: number,
  rotH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const c = clampRect(e.crop);
  const sw = Math.max(1, Math.round(c.w * rotW));
  const sh = Math.max(1, Math.round(c.h * rotH));
  const sx = Math.min(Math.max(0, Math.round(c.x * rotW)), Math.max(0, rotW - sw));
  const sy = Math.min(Math.max(0, Math.round(c.y * rotH)), Math.max(0, rotH - sh));
  return { sx, sy, sw, sh };
}

/** The smallest surface `drawEdited` needs from a canvas (so a test can pass a recorder). */
export interface Canvas2DLike {
  width: number;
  height: number;
  getContext(kind: "2d"): CanvasLikeContext | null;
}

/** The subset of `CanvasRenderingContext2D` this module uses. */
export interface CanvasLikeContext {
  filter: string;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(rad: number): void;
  scale(x: number, y: number): void;
  // `unknown` (not `CanvasImageLike`) so a real `CanvasRenderingContext2D` is structurally
  // assignable here — its overload set takes `CanvasImageSource`, which is wider than the
  // minimal shape this module actually touches ({@link CanvasImageLike}).
  drawImage(img: unknown, dx: number, dy: number, dw: number, dh: number): void;
}

/**
 * Anything with intrinsic dimensions that `drawImage` accepts.
 *
 * `naturalWidth`/`naturalHeight` are preferred when present, because an
 * `HTMLImageElement`'s `width`/`height` are the **rendered** size as soon as the element is
 * laid out — reading those would crop and scale against the preview box instead of the
 * photo. They are optional so a plain `{ width, height }` (a `<video>`, an offscreen
 * source, a test double) still works.
 */
export interface CanvasImageLike {
  width: number;
  height: number;
  naturalWidth?: number;
  naturalHeight?: number;
}

/** The image's intrinsic size, preferring the decoded dimensions over the rendered ones. */
function intrinsic(img: CanvasImageLike): { w: number; h: number } {
  const w = typeof img.naturalWidth === "number" ? img.naturalWidth : img.width;
  const h = typeof img.naturalHeight === "number" ? img.naturalHeight : img.height;
  return { w, h };
}

/**
 * Render `img` with `e` applied into `canvas`, returning whether it actually drew.
 *
 * `false` covers both "no 2d context" and "the source has no pixels" (a 0×0 image would
 * produce a 0-area canvas whose `toDataURL` throws). The canvas is sized to the crop
 * rectangle **capped at `maxEdge`** (`{@link fitEdge}`), so the saved file carries the aspect
 * the user cropped to at a bounded number of pixels — an oversized source is downscaled, a
 * source already within the cap is 1:1.
 */
export function drawEdited(
  canvas: Canvas2DLike,
  img: CanvasImageLike,
  e: PhotoEdit,
  maxEdge: number = MAX_EXPORT_EDGE,
): boolean {
  const { w: iw, h: ih } = intrinsic(img);
  if (!Number.isFinite(iw) || !Number.isFinite(ih) || iw <= 0 || ih <= 0) return false;
  const rot = rotatedSize(iw, ih, e.rot);
  const { sx, sy, sw, sh } = cropPx(e, rot.w, rot.h);
  const out = fitEdge(sw, sh, maxEdge);
  canvas.width = out.w;
  canvas.height = out.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  // Put canvas point (0,0) at the crop's top-left corner in the rotated frame, then rotate
  // about the frame's centre — the same centre the preview's CSS transform rotates about.
  // The two axis ratios differ by less than one pixel (the canvas dimensions are integers
  // and the ratio is not), which cannot shear the image: `e.rot` is a multiple of 90°, so
  // every edge stays axis-aligned.
  ctx.save();
  ctx.translate(out.w / 2, out.h / 2);
  ctx.scale(out.w / sw, out.h / sh);
  ctx.translate(-(sx + sw / 2 - rot.w / 2), -(sy + sh / 2 - rot.h / 2));
  ctx.rotate((e.rot * Math.PI) / 180);
  ctx.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1);
  ctx.filter = filterCss(e);
  ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
  ctx.restore();
  return true;
}

/** The subset of a canvas `exportEditedDataUrl` needs. */
export interface CanvasDataLike {
  toDataURL(type?: string, quality?: number): string;
}

/**
 * Encode the rendered canvas, or `null` when the canvas refuses.
 *
 * `toDataURL` throws on a 0-area canvas and on a tainted one (a cross-origin source drawn
 * without CORS). Returning `null` here is what lets the caller say "could not save the
 * edited photo" instead of writing an empty data URL into the library.
 */
export function exportEditedDataUrl(
  canvas: CanvasDataLike,
  mime: string | null | undefined,
  quality = EXPORT_QUALITY,
): string | null {
  const type = mime && /^image\/(jpeg|png|webp)$/.test(mime) ? mime : "image/jpeg";
  try {
    const url = canvas.toDataURL(type, quality);
    return typeof url === "string" && url.startsWith("data:image/") ? url : null;
  } catch {
    return null;
  }
}
