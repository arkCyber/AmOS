export interface Note {
  text: string;
  ts: number;
}

export const NOTES_KEY = "amos.notes";

/** Add a note at the front (newest first). `now` is injected for testability. */
export function prependNote(list: Note[], text: string, now: number): Note[] {
  return [{ text, ts: now }, ...list];
}

export function removeNote(list: Note[], ts: number): Note[] {
  return list.filter((n) => n.ts !== ts);
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
