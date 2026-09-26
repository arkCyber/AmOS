/**
 * dragSession.svelte.ts — the live cross-app drag (REQ-A683).
 *
 * A drag is global shell state: the pointer moves over *panes owned by other apps*,
 * so no single component can hold it. This module keeps the one session — what is
 * being carried, where the pointer is, which pane it is over, and what a release
 * there would do — as module-level runes so every `AppPane` can highlight itself
 * reactively and the ghost can follow the pointer.
 *
 * The **decision** is not here: {@link resolveDrop} (pure, `lib/dragDrop.ts`) turns
 * a (payload, target, source) triple into accept/refuse. This module only carries it.
 */
import { resolveDrop, type DragPayload, type DropResolution } from "../lib/dragDrop";

export interface DragSession {
  payload: DragPayload;
  /** App id the drag started in; a release back on it is `same-app`. */
  sourceApp: string;
  /** Pointer position (client px) — the ghost's anchor. */
  x: number;
  y: number;
  /** App id of the pane under the pointer, or `null` over nothing. */
  overAppId: string | null;
  /** What releasing right now would do. */
  resolution: DropResolution;
}

const NO_TARGET: DropResolution = { kind: "reject", reason: "no-target" };

let session = $state<DragSession | null>(null);

/** Reactive read of the current drag, or `null`. */
export function dragSession(): DragSession | null {
  return session;
}

/** Begin a drag. Ignored if one is already running (one gesture at a time). */
export function startDrag(payload: DragPayload, sourceApp: string, x: number, y: number): void {
  if (session) return;
  session = { payload, sourceApp, x, y, overAppId: null, resolution: NO_TARGET };
}

/** Track the pointer: its position and the pane (if any) it is over. */
export function moveDrag(x: number, y: number, overAppId: string | null): void {
  if (!session) return;
  const over = overAppId && overAppId.trim() !== "" ? overAppId : null;
  session = {
    payload: session.payload,
    sourceApp: session.sourceApp,
    x,
    y,
    overAppId: over,
    resolution: resolveDrop(session.payload, over, session.sourceApp),
  };
}

/** End the drag, clearing the session, and hand back what it was (for the caller to commit). */
export function endDrag(): DragSession | null {
  const done = session;
  session = null;
  return done;
}

/** Abort the drag (Escape, pointercancel) — nothing is handed over. */
export function cancelDrag(): void {
  session = null;
}
