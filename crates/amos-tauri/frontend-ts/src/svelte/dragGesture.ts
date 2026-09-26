/**
 * dragGesture.ts — the shared "hold, then move, to start a cross-app drag" gesture
 * (REQ-A683).
 *
 * Both drag sources (a Contacts row, a Notes row) need the same disambiguation: a
 * list scrolls and a tap opens, so a drag must not begin until the user has *held*
 * (`holdMs`) **and** then moved past a small threshold. Encoding it once keeps the
 * two sources from drifting into two different feel rules.
 *
 * Plain TS (no runes): it is a factory of DOM handlers a component spreads onto a
 * row. The live session it drives lives in `dragSession.svelte.ts`.
 *
 * Once a drag has begun the ghost owns the pointer (its window-level listeners
 * commit the drop), so these handlers stop doing anything but cleaning up their own
 * timers — they never finish a drag, which is what keeps a release from committing
 * twice.
 */
import { startDrag } from "./dragSession.svelte";
import type { DragPayload } from "../lib/dragDrop";

const HOLD_MS = 400;
const THRESHOLD_PX = 10;

export interface DragGesture {
  onpointerdown: (e: PointerEvent) => void;
  onpointermove: (e: PointerEvent) => void;
  onpointerup: (e: PointerEvent) => void;
  onpointercancel: (e: PointerEvent) => void;
  /**
   * Whether this gesture became a real drag. The row's `onclick` checks it and
   * returns early, so releasing a drag does not also open the item — a drag and a
   * tap must never both fire.
   */
  dragged: () => boolean;
}

export function dragGesture(opts: {
  /** The payload to carry; `null` means "nothing draggable here" and aborts the gesture. */
  payload: () => DragPayload | null;
  /** App id the drag starts in (drives the `same-app` refusal). */
  sourceApp: () => string;
  holdMs?: number;
  thresholdPx?: number;
}): DragGesture {
  const holdMs = opts.holdMs ?? HOLD_MS;
  const threshold = opts.thresholdPx ?? THRESHOLD_PX;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let armed = false;
  let started = false;
  let dragged = false;
  let startX = 0;
  let startY = 0;
  let pointerId: number | null = null;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    armed = false;
  }

  return {
    onpointerdown(e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      dragged = false;
      started = false;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      clearTimer();
      timer = setTimeout(() => {
        armed = true;
        timer = null;
      }, holdMs);
    },

    onpointermove(e) {
      if (started) return; // the ghost owns the pointer now
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) < threshold) return;
      // A move before the hold elapsed is a scroll, not a drag.
      if (!armed) {
        clearTimer();
        return;
      }
      const payload = opts.payload();
      if (!payload) {
        clearTimer();
        return;
      }
      if (pointerId !== null && e.pointerId !== pointerId) return;
      started = true;
      dragged = true;
      clearTimer();
      // Stop the browser starting a text selection / native drag from this move.
      e.preventDefault();
      startDrag(payload, opts.sourceApp(), e.clientX, e.clientY);
    },

    onpointerup() {
      clearTimer();
      pointerId = null;
    },

    onpointercancel() {
      clearTimer();
      pointerId = null;
    },

    dragged: () => dragged,
  };
}
