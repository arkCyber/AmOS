/**
 * dropActions.ts — perform a cross-app drop (REQ-A683).
 *
 * The imperative half of the drag: {@link resolveDrop} decides *whether* and *as what*
 * (`lib/dragDrop.ts`); this file names the app API that carries it out. Every
 * {@link DropVerb} has exactly one branch here, and `drag-drop.svelte.test.ts` walks
 * {@link DROP_CAPABILITIES} and asserts each verb reaches its app with the payload —
 * so a table row cannot ship without its handler (a row with no handler would open the
 * target at its root with nothing handed over: the user reads that as success).
 *
 * The hand-offs reuse the **existing deep links** (`composeSmsTo`/`dialNumber`/
 * `sendToAi`/`openNoteDraft`) rather than a parallel path: a drop is "open app X
 * addressed to Y", the same promise a Spotlight pick makes.
 */
import type { DragPayload, DropVerb } from "../lib/dragDrop";
import { composeSmsTo, dialNumber, openNoteDraft, sendToAi } from "./appLinks";

/** The `source` string recorded with text handed to the AI app. */
export const DRAG_SOURCE = "drag";

/**
 * Carry out an accepted drop. Returns whether a hand-off actually happened; a verb
 * that does not match the payload's kind is a **programming error** the capability
 * table already forbids, so it refuses rather than guessing (and is unreachable from
 * `resolveDrop`, which only returns verbs paired with the payload's kind).
 */
export function performDrop(payload: DragPayload, verb: DropVerb): boolean {
  if (payload.kind === "text") {
    switch (verb) {
      case "ai-context":
        // Same rule as the `new-note` arm below, and the reason it is not `return true`:
        // `sendToAi` refuses an empty body, so this arm's answer must be that refusal
        // rather than a hard-coded success (REQ-A1650 ∕ F-SH-840).
        return sendToAi(DRAG_SOURCE, payload.text);
      case "new-note":
        // The verdict *is* this adapter's contract ("returns whether a hand-off actually
        // happened"): `openNoteDraft` refuses an empty body, so hard-coding `true` here
        // would report a hand-off of nothing (REQ-A1557 ∕ F-SH-791).
        return openNoteDraft(payload.text);
      case "compose-sms":
      case "dial":
        return false;
    }
  }
  switch (verb) {
    // Both phone arms carry the verdict their callee answers. `composeSmsTo` / `dialNumber`
    // each refuse an empty number; returning `true` here regardless was this file's own
    // documented contract ("returns whether a hand-off actually happened") being
    // contradicted by three of its four arms — the rule was stated on one arm and copied
    // to the others by hand (REQ-A1650 ∕ F-SH-840).
    case "compose-sms":
      return composeSmsTo(payload.number);
    case "dial":
      return dialNumber(payload.number);
    case "ai-context":
    case "new-note":
      return false;
  }
}
