/**
 * systemInk.test.ts — the system ink layer's history (REQ-A1590).
 *
 * The module is small on purpose: `lib/ink.ts` owns the geometry, and this owns only *what a
 * commit does*. The two rules worth pinning are the ones a naive implementation gets wrong and a
 * user feels immediately:
 *
 *   * an **equal** commit is not a step (the eraser passing over empty space must not spend an
 *     undo slot), and
 *   * a commit **drops the redo branch** (draw → undo → draw must not leave a second future).
 *
 * The negative controls below exist because both rules can be "satisfied" by an implementation
 * that is wrong in the other direction — a history that never records anything passes "equal
 * commits are not steps", so every non-equal case is asserted too.
 */
import { describe, expect, test } from "bun:test";
import {
  SYSTEM_INK_UNDO_LIMIT,
  canRedoSystemInk,
  canUndoSystemInk,
  commitSystemInk,
  emptySystemInk,
  redoSystemInk,
  undoSystemInk,
  type SystemInkState,
} from "../lib/systemInk";
import type { Ink, InkPoint, InkStroke } from "../lib/ink";

function pt(x: number, y = 0): InkPoint {
  return { x, y, p: 0.5, t: 0 };
}

function stroke(xs: number[]): InkStroke {
  return { tool: "pen", color: "#1f2937", width: 2, pts: xs.map((x) => pt(x)) };
}

/** A drawing with `n` one-point strokes — cheap to build and distinguishable by stroke count. */
function sheet(n: number): Ink {
  const strokes: InkStroke[] = [];
  for (let i = 0; i < n; i++) strokes.push(stroke([i]));
  return { w: 100, h: 100, strokes };
}

describe("systemInk — commit", () => {
  test("a first stroke becomes the current drawing and is undoable back to blank", () => {
    const s0 = emptySystemInk();
    expect(s0.ink).toBeNull();
    expect(canUndoSystemInk(s0)).toBe(false);

    const s1 = commitSystemInk(s0, sheet(1));
    expect(s1.ink?.strokes.length).toBe(1);
    expect(canUndoSystemInk(s1)).toBe(true);
    expect(canRedoSystemInk(s1)).toBe(false);

    const s2 = undoSystemInk(s1);
    expect(s2.ink).toBeNull(); // back to the blank sheet, not to "no history"
    expect(canUndoSystemInk(s2)).toBe(false);
    expect(canRedoSystemInk(s2)).toBe(true);
  });

  test("committing a drawing equal to the current one is not a step", () => {
    const s1 = commitSystemInk(emptySystemInk(), sheet(1));
    // An equal-but-new object (what a caller that rebuilt the layer would hand over).
    const equal = sheet(1);
    expect(equal).not.toBe(s1.ink);
    const s2 = commitSystemInk(s1, equal);
    expect(s2).toBe(s1); // same reference: nothing was recorded
    expect(s2.undo.length).toBe(1); // still exactly one step (the blank)
  });

  test("committing null over a null sheet is not a step either", () => {
    const s0 = emptySystemInk();
    expect(commitSystemInk(s0, null)).toBe(s0);
  });

  test("null is a real step (Clear is undoable)", () => {
    const s1 = commitSystemInk(emptySystemInk(), sheet(2));
    const s2 = commitSystemInk(s1, null);
    expect(s2.ink).toBeNull();
    expect(canUndoSystemInk(s2)).toBe(true);
    expect(undoSystemInk(s2).ink?.strokes.length).toBe(2);
  });

  test("a commit drops the redo branch (draw → undo → draw has one future)", () => {
    const a = commitSystemInk(emptySystemInk(), sheet(1));
    const b = commitSystemInk(a, sheet(2));
    const back = undoSystemInk(b);
    expect(canRedoSystemInk(back)).toBe(true);

    const c = commitSystemInk(back, sheet(3));
    expect(canRedoSystemInk(c)).toBe(false);
    expect(c.ink?.strokes.length).toBe(3);
  });

  test("the undo stack is bounded and drops the oldest step, never the current drawing", () => {
    let s: SystemInkState = emptySystemInk();
    const total = SYSTEM_INK_UNDO_LIMIT + 10;
    for (let i = 1; i <= total; i++) s = commitSystemInk(s, sheet(i));
    expect(s.undo.length).toBe(SYSTEM_INK_UNDO_LIMIT);
    // The drawing on screen is the newest, whichever bound the stack has.
    expect(s.ink?.strokes.length).toBe(total);
    // Rewinding the whole retained history lands on the step just past the dropped ones.
    let rewinded = s;
    for (let i = 0; i < SYSTEM_INK_UNDO_LIMIT; i++) rewinded = undoSystemInk(rewinded);
    expect(rewinded.ink?.strokes.length).toBe(total - SYSTEM_INK_UNDO_LIMIT);
    expect(canUndoSystemInk(rewinded)).toBe(false);
  });
});

describe("systemInk — undo / redo", () => {
  test("undo at the bottom of the history is identity, not a fabricated state", () => {
    const s0 = emptySystemInk();
    expect(undoSystemInk(s0)).toBe(s0);

    const s1 = commitSystemInk(s0, sheet(1));
    const s0b = undoSystemInk(s1);
    expect(canUndoSystemInk(s0b)).toBe(false);
    expect(undoSystemInk(s0b)).toBe(s0b); // exactly here: nothing left to undo
  });

  test("redo with nothing to redo is identity", () => {
    const s1 = commitSystemInk(emptySystemInk(), sheet(1));
    expect(canRedoSystemInk(s1)).toBe(false);
    expect(redoSystemInk(s1)).toBe(s1);
  });

  test("undo then redo restores the same drawing", () => {
    const a = commitSystemInk(emptySystemInk(), sheet(1));
    const b = commitSystemInk(a, sheet(2));
    const back = undoSystemInk(b);
    const again = redoSystemInk(back);
    expect(again.ink?.strokes.length).toBe(2);
    expect(canRedoSystemInk(again)).toBe(false);
    expect(canUndoSystemInk(again)).toBe(true);
  });

  test("a blank sheet is a state redo can return to (null is not 'empty stack')", () => {
    // The distinguishing case for a `!== undefined`-style guard: the *value* popped is `null`,
    // which a truthiness test would read as "nothing to redo".
    const a = commitSystemInk(emptySystemInk(), sheet(1));
    const blank = undoSystemInk(a);
    expect(blank.ink).toBeNull();
    const redone = redoSystemInk(blank);
    expect(redone.ink?.strokes.length).toBe(1);
  });
});

describe("systemInk — the ink.ts seam", () => {
  test("equal but reordered strokes are a real commit (inkEqual is structural)", () => {
    const one = sheet(1);
    const two: Ink = { w: 100, h: 100, strokes: [stroke([0]), stroke([1])] };
    const s1 = commitSystemInk(emptySystemInk(), one);
    const s2 = commitSystemInk(s1, two);
    expect(s2).not.toBe(s1);
    expect(s2.undo.length).toBe(2);
  });
});
