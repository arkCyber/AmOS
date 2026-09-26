/**
 * trackpad.ts — the desktop's trackpad gesture layer (REQ-A1586).
 *
 * The desktop shell already switches Spaces from the keyboard (`⌃←` / `⌃→`, `⌃1…9`, all three
 * through `lib/spaces.ts`). A trackpad can ask for the same switch with a two-finger horizontal
 * swipe, and until this module existed nothing on the desktop read the wheel at all: `grep`
 * found `onwheel` only in `PhotosApp.svelte` (image zoom). This is that seam, and it is a
 * **decision** module, not a handler — the wheel listener in `DesktopShell.svelte` is three
 * lines over {@link TrackpadSwipeTracker}.
 *
 * ## What a browser can and cannot tell us (the honest boundary)
 *
 * A page never observes "two fingers moved 4 cm". It observes a stream of `WheelEvent`s, and a
 * trackpad is **not** distinguishable from a mouse in general — the differences we lean on are:
 *
 *   * **`deltaMode`** — a notch-based mouse wheel delivers `DOM_DELTA_LINE` (1); a trackpad
 *     delivers `DOM_DELTA_PIXEL` (0) with many small samples. We accept pixel mode only, so a
 *     plain mouse wheel is "other" and never a swipe (a negative control in the tests pins this).
 *   * **horizontal dominance** — a swipe is `|deltaX| > |deltaY|`. A vertical scroll (the common
 *     case, and the one that must keep working) is never a swipe.
 *   * **`ctrlKey`** — a trackpad **pinch** is synthesized by the browser as a wheel with
 *     `ctrlKey: true`. That is a zoom, not a navigation, so it is its own class and never fires.
 *
 * The classifier therefore answers "this sample looks like a horizontal swipe" — it cannot prove
 * the input device. A horizontal-scrolling mouse would also qualify; that is the accepted cost of
 * a device the platform does not name, and the reason the threshold + latch below are conservative
 * (one switch per gesture, and the desktop root does not scroll, so a false positive costs a
 * keyboard-equivalent switch rather than eaten content).
 *
 * Kept DOM-free so the whole rule is unit-testable headlessly: the caller converts a `WheelEvent`
 * into a {@link WheelSample}.
 */

/** One wheel reading, stripped of the DOM so the pure classifier can be tested without one. */
export interface WheelSample {
  /** `WheelEvent.deltaX` — positive scrolls content to the right. */
  deltaX: number;
  /** `WheelEvent.deltaY` — used only to judge horizontal dominance. */
  deltaY: number;
  /** `WheelEvent.deltaMode`: `0` = `DOM_DELTA_PIXEL`, `1` = `DOM_DELTA_LINE`, `2` = `DOM_DELTA_PAGE`. */
  deltaMode: number;
  /** A trackpad pinch arrives as a wheel with `ctrlKey` set — a zoom, never a swipe. */
  ctrlKey: boolean;
}

/** What a single wheel sample looks like to the desktop. */
export type WheelClass = "swipe" | "pinch" | "other";

/** How far (CSS px) a horizontal swipe must travel before it is a Space switch. */
export const SWIPE_THRESHOLD_PX = 120;

/** A gesture is over once this many ms pass with no wheel sample (lift-off + settle). */
export const GESTURE_IDLE_MS = 300;

/**
 * Classify one wheel sample. `"swipe"` is a candidate horizontal trackpad swipe; `"pinch"` is a
 * trackpad pinch (browser-synthesized `ctrlKey`); `"other"` is everything else, including any
 * line/page-mode wheel — i.e. a mouse.
 *
 * The three checks are ordered so the cheapest disqualifier wins: a pinch is never a swipe even
 * if it has horizontal travel, and a line-mode device is a mouse regardless of axis.
 */
export function classifyWheel(sample: WheelSample): WheelClass {
  if (sample.ctrlKey) return "pinch";
  if (sample.deltaMode !== 0) return "other";
  if (Math.abs(sample.deltaX) <= Math.abs(sample.deltaY)) return "other";
  return "swipe";
}

/** The Space step a swipe asks for: `"prev"` (−1, content moved right) or `"next"` (+1). */
export type SwipeStep = "prev" | "next";

/**
 * Accumulates a wheel stream into at most **one** Space switch per gesture.
 *
 * The browser delivers one wheel event per frame while the fingers move, and — on a real
 * trackpad — keeps delivering momentum events *after* the fingers lift. Firing on every sample
 * past the threshold would therefore switch Spaces several times per swipe. The rules:
 *
 *   1. **Accumulate** `deltaX` while samples classify `"swipe"`; fire when `|Σ| ≥`
 *      {@link SWIPE_THRESHOLD_PX}.
 *   2. **Latch** after firing: further samples of the same gesture are ignored until the gesture
 *      goes idle (a {@link GESTURE_IDLE_MS} gap) — that gap is what ends the gesture, since the
 *      browser never tells us "fingers lifted".
 *   3. **Direction reversal restarts** the sum instead of cancelling it: dragging right then left
 *      is a new intent, not a swipe that nets to zero.
 *   4. **A non-swipe sample ends the gesture** (a vertical scroll or a pinch between two swipes
 *      must not extend a half-finished one).
 */
export class TrackpadSwipeTracker {
  private accum = 0;
  private fired = false;
  private lastMs = 0;

  /**
   * Feed one sample and answer the step to take, or `null` for "do nothing".
   *
   * `nowMs` is the caller's clock (`performance.now()`), passed in rather than read here so the
   * idle rule is testable without waiting on real time.
   */
  push(sample: WheelSample, nowMs: number): SwipeStep | null {
    if (this.lastMs !== 0 && nowMs - this.lastMs > GESTURE_IDLE_MS) {
      this.accum = 0;
      this.fired = false;
    }
    this.lastMs = nowMs;

    if (classifyWheel(sample) !== "swipe") {
      this.accum = 0;
      this.fired = false;
      return null;
    }

    if (this.fired) return null;

    if (this.accum !== 0 && Math.sign(this.accum) !== Math.sign(sample.deltaX)) {
      this.accum = 0;
    }
    this.accum += sample.deltaX;
    if (Math.abs(this.accum) < SWIPE_THRESHOLD_PX) return null;

    // Content follows the fingers: swiping right (deltaX > 0) reveals the Space to the left,
    // which is "previous" — the same step `⌃←` asks for.
    const step: SwipeStep = this.accum > 0 ? "prev" : "next";
    this.fired = true;
    this.accum = 0;
    return step;
  }
}
