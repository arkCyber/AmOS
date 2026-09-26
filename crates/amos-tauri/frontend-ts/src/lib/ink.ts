/**
 * ink.ts — the freehand-ink model: strokes carrying pressure/tilt, the geometry that turns them
 * into pixels, and the one input-routing decision (REQ-A526).
 *
 * Why this module is pure TypeScript rather than a host command: a stroke is sampled at the
 * pointer's own rate (a 120 Hz stylus, up to ~240 coalesced samples/s), and every one of those
 * samples must become a pixel **in the same frame**. A round trip to the Rust host per sample would
 * put IPC latency inside the stroke, which is exactly the input the user feels. So the geometry
 * lives here, in the same process as the canvas, and no host state is involved — the model is
 * presentational. (`menuPlacement.ts` and `virtualScroll.ts` are the same shape of module.)
 *
 * The coordinates are **CSS pixels in the strip's own space at capture time**, and `Ink.w`/`Ink.h`
 * record that space. Rendering multiplies by `fitScale(ink.w, viewW)`, so a window resize rescales
 * the drawing instead of losing it. Storing real pixels rather than normalized `[0,1]` keeps
 * `ERASER_RADIUS`, `stroke.width` and the hit-test arithmetic in the same units a fingerprint is,
 * which is what this module's tests assert against.
 *
 * Rules that keep a device honest:
 *
 *  * **Every entry point takes `unknown` and returns a sentinel.** Stored JSON is not trusted: a
 *    malformed or oversized layer degrades to `null` (the note simply has no ink) rather than
 *    throwing on load and taking the whole note list with it.
 *  * **Bounds are enforced on read, not on write.** `INK_MAX_STROKES` / `INK_MAX_POINTS` bound what
 *    a corrupt or hostile store can make the renderer allocate.
 *  * **Palm rejection never guesses from pressure.** Many touch controllers report a constant
 *    `0` or `1` for a finger, so a pressure threshold would be a coin flip presented as a decision.
 *    The contact ellipse and the pen-active window are the two signals that carry information.
 */

/** Which tool drew a stroke. Only `"pen"` is ever committed; `"eraser"` erases strokes instead of
 *  being stored, and is kept in the union so a stored layer stays self-describing. */
export type InkTool = "pen" | "eraser";

/** One sampled contact, in the ink strip's CSS-pixel space. */
export interface InkPoint {
  /** X, px from the strip's left edge. */
  x: number;
  /** Y, px from the strip's top edge. */
  y: number;
  /** Normalized pressure in `[0,1]`; `0.5` when the device reports none. */
  p: number;
  /** Normalized tilt magnitude in `[0,1]` (`0` = perpendicular to the glass, `1` = flat). */
  t: number;
}

/** One continuous contact from pen-down to pen-up. */
export interface InkStroke {
  tool: InkTool;
  /** CSS color the stroke is painted in. */
  color: string;
  /** Base width in CSS px; per-point pressure/tilt widen or narrow it around this. */
  width: number;
  pts: InkPoint[];
}

/** A note's whole drawing: the space it was captured in, plus its strokes. */
export interface Ink {
  /** Strip width in CSS px at capture time. */
  w: number;
  /** Strip height in CSS px at capture time. */
  h: number;
  strokes: InkStroke[];
}

/** What a pointer-down should do. */
export type PointerDecision = "draw" | "palm" | "ignore";

/**
 * The routing input, deliberately free of DOM types so {@link classifyPointer} is a pure predicate
 * that can be tested with no browser (and so a future non-DOM pointer source can reuse it).
 */
export interface InkPointerSample {
  /** `PointerEvent.pointerType`: `"pen"` / `"touch"` / `"mouse"`, or `""` when unreported. */
  pointerType: string;
  /** Contact ellipse width, CSS px; `0` on devices that do not report contact geometry. */
  width: number;
  /** Contact ellipse height, CSS px; `0` on devices that do not report contact geometry. */
  height: number;
  /** `PointerEvent.isPrimary`. */
  isPrimary: boolean;
  /** True when a pen event was seen within {@link PALM_PEN_IDLE_MS}. */
  penActive: boolean;
  /** The user's `notePrefs.palmRejection`. An explicit `false` wins over every heuristic. */
  palmRejection: boolean;
}

/** Narrowest a stroke may be drawn — a full-pressure-minimum line must stay visible. */
export const INK_MIN_WIDTH = 0.75;
/** Widest a stroke may be drawn; beyond this a stroke reads as a smear, not a line. */
export const INK_MAX_WIDTH = 6;
/** Upper bound on strokes retained in one layer (bounds a corrupt store's allocation). */
export const INK_MAX_STROKES = 2000;
/** Upper bound on points retained in one stroke. */
export const INK_MAX_POINTS = 2000;
/** Samples closer together than this are dropped: a 120 Hz stylus emits far more than the eye needs. */
export const INK_MIN_DIST = 0.75;
/** Ramer–Douglas–Peucker tolerance used on the commit path, in CSS px. */
export const INK_SIMPLIFY_TOL = 0.5;
/** Contact-ellipse long axis, CSS px, at or above which a touch is read as a resting palm. */
export const PALM_CONTACT_MIN = 22;
/** How long a pen stays "active" after its last event, in ms. */
export const PALM_PEN_IDLE_MS = 4000;
/** Eraser footprint radius, CSS px. */
export const ERASER_RADIUS = 12;
/** Default ink color — reads as ink against both light and dark chrome. */
export const INK_DEFAULT_COLOR = "#1f2937";
/** Default base stroke width, CSS px. */
export const INK_DEFAULT_WIDTH = 2;

/** Clamp into `[0,1]`; a non-finite input takes `fallback` instead of poisoning the value. */
function clamp01(v: number, fallback = 0): number {
  if (!Number.isFinite(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Clamp a width into the drawable range, falling back to the default for a non-finite input. */
function clampWidth(v: number): number {
  if (!Number.isFinite(v)) return INK_DEFAULT_WIDTH;
  if (v < INK_MIN_WIDTH) return INK_MIN_WIDTH;
  if (v > INK_MAX_WIDTH) return INK_MAX_WIDTH;
  return v;
}

/**
 * Coerce stored JSON into a bounded, finite, in-range [`Ink`] — or `null` when there is nothing
 * drawable to keep.
 *
 * `null` is the contract for "no ink", and it is also what an empty layer normalizes to, so the
 * caller has exactly one shape to test. A stroke is dropped when it has no usable point; an
 * individually malformed point is dropped without discarding its stroke. Numbers are **not**
 * coerced from strings: `"3"` is a different serialization, and accepting it would hide a bug in
 * whatever wrote it.
 */
export function normalizeInk(raw: unknown): Ink | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.strokes)) return null;
  const strokes: InkStroke[] = [];
  for (const rawStroke of o.strokes) {
    if (strokes.length >= INK_MAX_STROKES) break;
    if (!rawStroke || typeof rawStroke !== "object") continue;
    const s = rawStroke as Record<string, unknown>;
    const tool: InkTool | null = s.tool === "eraser" ? "eraser" : s.tool === "pen" ? "pen" : null;
    if (tool === null) continue;
    if (!Array.isArray(s.pts)) continue;
    const pts: InkPoint[] = [];
    for (const rawPt of s.pts) {
      if (pts.length >= INK_MAX_POINTS) break;
      if (!rawPt || typeof rawPt !== "object") continue;
      const p = rawPt as Record<string, unknown>;
      if (typeof p.x !== "number" || !Number.isFinite(p.x)) continue;
      if (typeof p.y !== "number" || !Number.isFinite(p.y)) continue;
      pts.push({
        x: p.x,
        y: p.y,
        p: clamp01(typeof p.p === "number" ? p.p : NaN, 0.5),
        t: clamp01(typeof p.t === "number" ? p.t : NaN, 0),
      });
    }
    if (pts.length === 0) continue;
    strokes.push({
      tool,
      color: typeof s.color === "string" && s.color ? s.color : INK_DEFAULT_COLOR,
      width: clampWidth(typeof s.width === "number" ? s.width : NaN),
      pts,
    });
  }
  if (strokes.length === 0) return null;
  const w = typeof o.w === "number" && Number.isFinite(o.w) && o.w > 0 ? o.w : 0;
  const h = typeof o.h === "number" && Number.isFinite(o.h) && o.h > 0 ? o.h : 0;
  return { w, h, strokes };
}

/**
 * Structural equality, with the two "no ink" spellings (`undefined`, `null`) and an
 * explicit empty layer all treated as equal — so a caller deciding "did this change?" does not
 * rewrite a note because a layer was materialized and then emptied.
 */
export function inkEqual(a: Ink | null | undefined, b: Ink | null | undefined): boolean {
  const sa = a?.strokes;
  const sb = b?.strokes;
  const na = sa?.length ?? 0;
  const nb = sb?.length ?? 0;
  if (na !== nb) return false;
  if (na === 0) return true;
  if (!sa || !sb) return true;
  for (let i = 0; i < na; i++) {
    const x = sa[i];
    const y = sb[i];
    if (!x || !y) return false;
    if (x.tool !== y.tool || x.color !== y.color || x.width !== y.width) return false;
    if (x.pts.length !== y.pts.length) return false;
    for (let j = 0; j < x.pts.length; j++) {
      const px = x.pts[j];
      const py = y.pts[j];
      if (!px || !py) return false;
      if (px.x !== py.x || px.y !== py.y || px.p !== py.p || px.t !== py.t) return false;
    }
  }
  return true;
}

/** Whether a note carries a drawing. The single predicate for the list badge and the editor hint,
 *  so the two cannot disagree about what "has ink" means — and `Ink | null` is accepted so a holder
 *  that spells blank as `null` (the system ink layer's history) reads the *same* rule instead of
 *  inventing a second test beside it. */
export function noteHasInk(note: { ink?: Ink | null }): boolean {
  return (note.ink?.strokes.length ?? 0) > 0;
}

/**
 * Map pressure and tilt to a CSS-px stroke width.
 *
 * Pressure is **neutral at `0.5`** and spans half to one-and-a-half times the chosen `base`, and
 * tilt widens the result by up to half again (a pen laid flat deposits a broader mark than one
 * held upright). Everything is finally clamped into `[`{@link INK_MIN_WIDTH}`,
 * `{@link INK_MAX_WIDTH}`]`.
 *
 * Making `base` the *centre* of the range rather than a mere fallback is what keeps the user's
 * width setting meaningful: with pressure spanning a fixed absolute range instead, every stroke
 * would draw at the same width whatever the user picked, and the setting would be decorative on
 * exactly the devices that report pressure at all. A **non-finite pressure returns `base`**: a
 * device that reports none should draw at the chosen width, not at the narrowest one.
 */
export function sampleWidth(
  pressure: number,
  tilt: number,
  base: number = INK_DEFAULT_WIDTH,
): number {
  const b = Number.isFinite(base) && base > 0 ? base : INK_DEFAULT_WIDTH;
  if (!Number.isFinite(pressure)) return clampWidth(b);
  const p = clamp01(pressure);
  const t = clamp01(tilt);
  const byPressure = b * (0.5 + p);
  return clampWidth(byPressure * (1 + t * 0.5));
}

/**
 * Collapse the device's two tilt axes into one normalized `[0,1]` scalar.
 *
 * `tiltX`/`tiltY` are degrees in `[-90,90]`, so the magnitude of the pair spans `[0,90√2]`; `90` is
 * used as the divisor because it is the angle at which a pen is unambiguously on its side. A
 * non-finite axis means the device is not reporting tilt, which is `0` and not a guess.
 */
export function tiltMagnitude(tiltX: number, tiltY: number): number {
  if (!Number.isFinite(tiltX) || !Number.isFinite(tiltY)) return 0;
  return clamp01(Math.sqrt(tiltX * tiltX + tiltY * tiltY) / 90);
}

/**
 * Immutable append with a distance gate: a sample closer than `minDist` to the last one is dropped
 * as jitter. Returns the input array unchanged (same reference) when nothing is appended, so a
 * caller can cheaply detect "no new sample".
 */
export function appendPoint(
  pts: InkPoint[],
  pt: InkPoint,
  minDist: number = INK_MIN_DIST,
): InkPoint[] {
  const last = pts[pts.length - 1];
  if (!last) return [pt];
  const dx = pt.x - last.x;
  const dy = pt.y - last.y;
  const gate = Number.isFinite(minDist) && minDist > 0 ? minDist : 0;
  if (dx * dx + dy * dy < gate * gate) return pts;
  return [...pts, pt];
}

/** Squared distance from `p` to segment `a`–`b` (0 when the segment is degenerate). */
function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

/**
 * Ramer–Douglas–Peucker: drop samples that sit within `tolerance` of the chord they lie on.
 *
 * This runs once, on commit, and typically cuts a stroke's payload five- to ten-fold with no
 * visible change — which is what keeps a long handwriting session inside the store's quota. The
 * endpoints are always kept, and a stroke of fewer than three points is returned as-is so a
 * deliberate dot survives.
 */
export function simplifyStroke(pts: InkPoint[], tolerance: number = INK_SIMPLIFY_TOL): InkPoint[] {
  if (pts.length < 3) return pts;
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;
  if (tol === 0) return pts;
  const keep = new Set<number>([0, pts.length - 1]);
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  const tolSq = tol * tol;
  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) break;
    const [first, last] = range;
    if (last - first < 2) continue;
    const a = pts[first];
    const b = pts[last];
    if (!a || !b) continue;
    let worst = -1;
    let worstD = 0;
    for (let i = first + 1; i < last; i++) {
      const pt = pts[i];
      if (!pt) continue;
      const d = distToSegmentSq(pt.x, pt.y, a.x, a.y, b.x, b.y);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst > 0 && worstD > tolSq) {
      keep.add(worst);
      stack.push([first, worst], [worst, last]);
    }
  }
  return pts.filter((_, i) => keep.has(i));
}

/**
 * Distance from `(x,y)` to a stroke's polyline — the eraser's whole geometry.
 *
 * `Infinity` for a stroke with no points, so "no points" can never read as a hit. The distance is
 * to the nearest **segment**, not the nearest sample: a fast stroke has samples far apart, and an
 * endpoint-only test would let the eraser fall straight through the middle of a long line.
 */
export function strokeHitRadius(stroke: InkStroke, x: number, y: number): number {
  const pts = stroke.pts;
  const first = pts[0];
  if (!first) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Number.POSITIVE_INFINITY;
  let best = distToSegmentSq(x, y, first.x, first.y, first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    const d = distToSegmentSq(x, y, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * Remove every stroke within `radius` of `(x,y)`.
 *
 * Returns the **same reference** when nothing was erased, which is what lets the canvas skip a
 * repaint (and the editor skip a save) on an eraser pass that crossed nothing.
 */
export function eraseAt(ink: Ink, x: number, y: number, radius: number = ERASER_RADIUS): Ink {
  const r = Number.isFinite(radius) && radius > 0 ? radius : ERASER_RADIUS;
  const kept = ink.strokes.filter((s) => strokeHitRadius(s, x, y) > r);
  if (kept.length === ink.strokes.length) return ink;
  return { ...ink, strokes: kept };
}

/** Unit normal to the direction `(dx,dy)`, or `[0,1]` for a degenerate direction. */
function normalOf(dx: number, dy: number): [number, number] {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(len) || len === 0) return [0, 1];
  return [-dy / len, dx / len];
}

/**
 * Build the SVG `d` of a stroke's **filled outline**: the polyline offset by half its local width
 * on both sides, and closed.
 *
 * An outline rather than a centreline because the width varies point to point — a single
 * `stroke-width` attribute cannot express a stroke that starts thin and swells, and one `<path>`
 * per segment would put a DOM node per sample on the page. Offsetting keeps the whole thing in one
 * pure function: the component builds a string and fills it, and every geometric decision here is
 * testable without a canvas.
 *
 * A single point becomes a small circle (a deliberate dot); an empty or wholly non-finite stroke
 * becomes `""`, never a path containing `NaN`.
 */
export function strokePath(pts: InkPoint[], base: number = INK_DEFAULT_WIDTH): string {
  const clean = pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const first = clean[0];
  if (!first) return "";
  const widths = clean.map((p) => sampleWidth(p.p, p.t, base) / 2);
  const n = clean.length;
  if (n === 1) {
    const r = widths[0] ?? INK_MIN_WIDTH / 2;
    const { x, y } = first;
    return `M ${x - r} ${y} A ${r} ${r} 0 1 0 ${x + r} ${y} A ${r} ${r} 0 1 0 ${x - r} ${y} Z`;
  }
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < n; i++) {
    const pt = clean[i];
    if (!pt) continue;
    const half = widths[i] ?? INK_MIN_WIDTH / 2;
    const prev = clean[i - 1];
    const next = clean[i + 1];
    const dx = (next?.x ?? pt.x) - (prev?.x ?? pt.x);
    const dy = (next?.y ?? pt.y) - (prev?.y ?? pt.y);
    const [nx, ny] = normalOf(dx, dy);
    left.push(`${pt.x + nx * half} ${pt.y + ny * half}`);
    right.push(`${pt.x - nx * half} ${pt.y - ny * half}`);
  }
  if (left.length === 0) return "";
  const head = left[0];
  const tail = right[0];
  if (!head || !tail) return "";
  return `M ${head} L ${left.slice(1).join(" L ")} L ${right.reverse().join(" L ")} Z`;
}

/**
 * The scale from captured space to view space.
 *
 * `1` (no scaling) whenever either side is unmeasured, so an unmeasured canvas draws the model
 * 1:1 rather than collapsing it to nothing — the same "an unmeasured thing is not moved" rule
 * `menuPlacement` follows.
 */
export function fitScale(inkW: number, viewW: number): number {
  if (!Number.isFinite(inkW) || !Number.isFinite(viewW)) return 1;
  if (inkW <= 0 || viewW <= 0) return 1;
  return viewW / inkW;
}

/** Inverse of the view transform: a pointer position in the canvas becomes a stored coordinate. */
export function toModelPoint(
  localX: number,
  localY: number,
  scale: number,
): { x: number; y: number } {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    x: Number.isFinite(localX) ? localX / s : 0,
    y: Number.isFinite(localY) ? localY / s : 0,
  };
}

/**
 * Decide what a pointer contact means: draw with it, treat it as a resting palm, or ignore it.
 *
 * Order matters, and each rule exists because of how the hardware actually behaves:
 *
 *  1. A **pen always draws**. No heuristic is allowed to reject the one input this feature is for.
 *  2. A **mouse always draws** — the desktop shell is a first-class target, not a test fixture.
 *  3. A **touch** is the only ambiguous contact, so it is the only one that consults anything:
 *     an explicit `palmRejection: false` wins immediately (the user said "I draw with my finger");
 *     then a pen seen recently means the hand is resting while the pen writes — the rule that
 *     actually does the work on a real device, because it does not depend on contact geometry;
 *     finally a wide contact ellipse, or a non-primary touch alongside another contact, is a palm.
 *  4. **Anything else is ignored.** An unreported or unknown `pointerType` must not be allowed to
 *     invent input.
 *
 * Ordering `palmRejection` ahead of `penActive` is deliberate: the preference is the user's, and a
 * user who turned rejection off has asked for their hand to draw.
 */
export function classifyPointer(s: InkPointerSample): PointerDecision {
  if (s.pointerType === "pen") return "draw";
  if (s.pointerType === "mouse") return "draw";
  if (s.pointerType !== "touch") return "ignore";
  if (!s.palmRejection) return "draw";
  if (s.penActive) return "palm";
  const long = Math.max(
    Number.isFinite(s.width) ? s.width : 0,
    Number.isFinite(s.height) ? s.height : 0,
  );
  if (long >= PALM_CONTACT_MIN) return "palm";
  if (!s.isPrimary) return "palm";
  return "draw";
}
