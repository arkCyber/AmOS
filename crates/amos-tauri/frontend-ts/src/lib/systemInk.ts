/**
 * systemInk.ts — the **system ink layer**'s history: a scratch drawing that floats over whatever
 * the shell is showing, with undo/redo (REQ-A1590).
 *
 * Why this exists: `lib/ink.ts` (REQ-A526) is a complete, pure ink model — strokes with
 * pressure/tilt, the eraser geometry, the SVG outline builder — but it had exactly **one**
 * consumer, `InkCanvas.svelte`, and that component is bound to a single note (it hard-codes a
 * white background, a scroll container and `aria-label={t("note.inkCanvas")}`). Freehand ink was
 * therefore a Notes feature, not a device capability: nothing in the system could be annotated,
 * and the stylus had no system-wide meaning at all.
 *
 * This module is the half of that feature which can be *decided* without a browser: what a new
 * committed stroke does to the drawing, and what undo/redo mean. It deliberately owns no geometry
 * — that is `lib/ink.ts`'s job, and duplicating it here is how two answerers of "where does this
 * stroke go" appear. The component composes: `eraseAt` / `appendPoint` / `simplifyStroke` build
 * the next `Ink`, and this module records *that* as a step.
 *
 * The rules that keep a history honest:
 *
 *  * **A commit equal to the current drawing is not a step.** The eraser's own contract
 *    (`eraseAt` returns the **same reference** when it crossed nothing) is the cheap half of
 *    this, but a caller can still hand over an equal-but-new object; `inkEqual` is what makes
 *    "the eraser passed over empty space" not consume one of the user's undo slots. Undo is a
 *    user-visible budget — spending it on a no-op is the defect, not the optimization.
 *  * **A new commit drops the redo branch.** Otherwise "draw, undo, draw" would leave a redo
 *    that rewinds to a drawing the user has already replaced: two futures for one present.
 *  * **Undo/redo at the end of their stack are identity, not an error.** A stray key press at
 *    the bottom of the history must not fabricate a state (the same rule `shellState`'s
 *    `exitSplit` follows: a no-op where there is nothing to undo).
 *  * **The stack is bounded.** A session's drawing is unbounded in principle; each step holds a
 *    whole `Ink`, so the oldest steps are dropped past {@link SYSTEM_INK_UNDO_LIMIT}. The drawing
 *    itself is never truncated — only how far back it can be rewound.
 */

import { inkEqual, type Ink } from "./ink";

/**
 * A scratch ink history: the drawing on screen, plus the states it can be rewound to.
 *
 * `null` is this model's "nothing drawn yet" — the same sentinel `lib/ink.ts` uses for a layer
 * with no strokes — so the empty sheet and the cleared sheet are one shape.
 */
export interface SystemInkState {
  /** The drawing currently on screen. `null` = blank. */
  readonly ink: Ink | null;
  /** Earlier drawings, oldest first. The last entry is what `undo` restores. */
  readonly undo: ReadonlyArray<Ink | null>;
  /** Drawings undone since the last commit, most recent first. Cleared by any commit. */
  readonly redo: ReadonlyArray<Ink | null>;
}

/**
 * How many undo steps are kept. Each step pins a whole `Ink`, so this bounds the memory a long
 * annotation session can hold. Chosen to be comfortably more than a user will ever press
 * (a pencil-and-paper sheet is not a document editor) without pinning thousands of drawings.
 */
export const SYSTEM_INK_UNDO_LIMIT = 50;

/** A blank sheet: nothing drawn, nothing to undo or redo. */
export function emptySystemInk(): SystemInkState {
  return { ink: null, undo: [], redo: [] };
}

/** Whether there is an earlier drawing to return to. */
export function canUndoSystemInk(s: SystemInkState): boolean {
  return s.undo.length > 0;
}

/** Whether an undone drawing can be re-applied. */
export function canRedoSystemInk(s: SystemInkState): boolean {
  return s.redo.length > 0;
}

/**
 * Record `next` as the current drawing, making the previous one undoable.
 *
 * Returns the **same state** (reference-equal) when `next` draws the same thing as what is
 * already on screen — see the module note. A `null` for `null` is likewise not a step, which is
 * what lets "clear" be a plain `commit(…, null)` without a special case.
 */
export function commitSystemInk(s: SystemInkState, next: Ink | null): SystemInkState {
  if (inkEqual(s.ink, next)) return s;
  const undo = [...s.undo, s.ink];
  // Drop the oldest steps past the bound. The current drawing is never dropped, and the entry
  // just pushed is the newest, so this can never empty the stack.
  while (undo.length > SYSTEM_INK_UNDO_LIMIT) undo.shift();
  return { ink: next, undo, redo: [] };
}

/**
 * Step back one drawing. Identity when there is nothing to undo (see the module note).
 *
 * The restored state is pushed onto `redo` — **including** a `null`, which is why the emptiness
 * test is `undo.length === 0` and not a truthiness check on the value: "the sheet was blank
 * before this stroke" is a legitimate state to return to.
 */
export function undoSystemInk(s: SystemInkState): SystemInkState {
  if (s.undo.length === 0) return s;
  const prev = s.undo[s.undo.length - 1] ?? null;
  return {
    ink: prev,
    undo: s.undo.slice(0, -1),
    redo: [...s.redo, s.ink],
  };
}

/**
 * Re-apply an undone drawing. Identity when there is nothing to redo.
 *
 * The step is pushed back onto `undo` without re-applying the bound: `undo` can only have shrunk
 * to get here (a redo pops one back), so it cannot exceed {@link SYSTEM_INK_UNDO_LIMIT}.
 */
export function redoSystemInk(s: SystemInkState): SystemInkState {
  if (s.redo.length === 0) return s;
  const next = s.redo[s.redo.length - 1] ?? null;
  return {
    ink: next,
    redo: s.redo.slice(0, -1),
    undo: [...s.undo, s.ink],
  };
}
