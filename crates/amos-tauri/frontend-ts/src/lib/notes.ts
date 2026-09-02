export interface Note {
  id: string;
  text: string;
  ts: number;
}

export const NOTES_KEY = "amos.notes";

// Process-local monotonic counter so ids stay unique even for two notes created
// in the same millisecond (and deterministic within a process for tests).
let seq = 0;

/** Create a new note with a unique id. */
export function makeNote(text: string, now: number): Note {
  seq += 1;
  return { id: `${now.toString(36)}-${seq}`, text, ts: now };
}

/**
 * Back-compat: older persisted notes were `{text, ts}` with no id. Normalize any
 * stored array (tolerating malformed entries) so every note has a unique id.
 */
export function normalizeNotes(list: unknown): Note[] {
  if (!Array.isArray(list)) return [];
  const out: Note[] = [];
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    if (typeof o.text !== "string") return; // drop malformed entries
    const text = o.text as string;
    const ts = typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : 0;
    const baseId =
      typeof o.id === "string" && o.id ? o.id : `${ts.toString(36)}-${i}`;
    let id = baseId;
    let k = 1;
    while (seen.has(id)) id = `${baseId}-${k++}`; // de-dup collisions on the same base
    seen.add(id);
    out.push({ id, text, ts });
  });
  return out;
}

/** Add a note at the front (newest first). `now` is injected for testability. */
export function prependNote(list: Note[], text: string, now: number): Note[] {
  return [makeNote(text, now), ...list];
}

/** Remove exactly one note by its unique id (never touches a same-ts sibling). */
export function removeNote(list: Note[], id: string): Note[] {
  return list.filter((n) => n.id !== id);
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
