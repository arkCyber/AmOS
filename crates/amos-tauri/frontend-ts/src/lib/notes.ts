export interface Note {
  id: string;
  text: string;
  ts: number;
  /** Optional star: pinned notes float to the top of the list. */
  pinned?: boolean;
  /** Optional lifecycle bucket: active notes omit this; others are archived or
   * in the trash ("Recently Deleted"). */
  state?: "archived" | "trash";
}

export const NOTES_KEY = "amos.notes";

/** First meaningful (title) line of a note body — the bold row title (iOS Notes). */
export function noteTitle(text: string): string {
  for (const line of text.split("\n")) {
    const v = line.replace(/^\s*[-*]\s*/, "").trim();
    if (v) return v;
  }
  return text.trim();
}

/** A whitespace-collapsed preview of the body *after* the title line, for the
 *  iOS-style list row. `max` caps the length (marker syntax is kept plain). */
export function notePreview(text: string, max = 140): string {
  const lines = text.split("\n");
  const body = lines.slice(1).join(" ").replace(/\s+/g, " ").trim();
  if (body) return body.length > max ? `${body.slice(0, max)}…` : body;
  return "";
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** Whole-day difference from `now` (0 today, -1 yesterday, …) — for the row stamp. */
export function noteDayOf(ts: number, now: number): number {
  return Math.round((startOfDay(ts) - startOfDay(now)) / 86_400_000);
}

// Process-local monotonic counter so ids stay unique even for two notes created
// in the same millisecond (and deterministic within a process for tests).
let seq = 0;

/** Create a new note with a unique id. */
export function makeNote(text: string, now: number): Note {
  seq += 1;
  return { id: `${now.toString(36)}-${seq}`, text, ts: now };
}

/** Toggle the pin/star on a note: pinning floats it to the top; unpinning just
 * drops the star (keeps the note). Returns a new array (no-op if id missing). */
export function togglePin(list: Note[], id: string): Note[] {
  const i = list.findIndex((n) => n.id === id);
  if (i < 0) return list;
  const note = list[i]!;
  if (!note.pinned) {
    const rest = list.filter((n) => n.id !== id);
    return [{ ...note, pinned: true }, ...rest];
  }
  // Un-pin: keep the note, just clear its star.
  return list.map((n) => (n.id === id ? { ...n, pinned: undefined } : n));
}

/** Reorder so pinned notes sit above the rest, each group keeping insertion order. */
export function orderPinned(list: Note[]): Note[] {
  return [...list.filter((n) => n.pinned), ...list.filter((n) => !n.pinned)];
}

/** Move a note into a lifecycle bucket: "archived", "trash", or back to active
 * (`undefined`). No-op (same ref) if the id is missing. */
export function setNoteState(
  list: Note[],
  id: string,
  state: "archived" | "trash" | undefined,
): Note[] {
  if (!list.some((n) => n.id === id)) return list;
  return list.map((n) => (n.id === id ? { ...n, ...(state ? { state } : { state: undefined }) } : n));
}

/** Notes belonging to a lifecycle bucket (`undefined` = active). */
export function notesOf(list: Note[], state: "archived" | "trash" | undefined): Note[] {
  return list.filter((n) => (n.state ?? undefined) === state);
}

/** Case-insensitive search over note text; empty query passes everything. */
export function searchNotes(list: Note[], query: string): Note[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((n) => n.text.toLowerCase().includes(q));
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
    out.push({
      id,
      text,
      ts,
      ...(typeof o.pinned === "boolean" ? { pinned: o.pinned } : {}),
      ...(o.state === "archived" || o.state === "trash" ? { state: o.state } : {}),
    });
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

/**
 * Replace the text of exactly one note (bumping its timestamp). Returns the
 * input unchanged when the id is missing, the new text is blank, or it is the
 * same as the current text (avoids churning timestamps on no-op saves).
 */
export function editNote(list: Note[], id: string, text: string, now: number): Note[] {
  const v = text.trim();
  if (!v) return list;
  const i = list.findIndex((n) => n.id === id);
  if (i < 0) return list; // id missing → true no-op (same ref)
  const target = list[i];
  if (!target) return list; // defensive: index in range by construction
  if (target.text === v) return list; // unchanged → same ref, no ts churn
  return list.map((n) => (n.id === id ? { ...n, text: v, ts: now } : n));
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

export interface NoteStats {
  chars: number; // visible characters (spaces excluded from the trimmed body)
  words: number; // whitespace-separated tokens (informative for CJK-ish counting)
  lines: number; // number of lines in the trimmed body
}

/** Count characters / words / lines for a note body (pure, headless-friendly). */
export function noteStats(text: string): NoteStats {
  const body = text.trim();
  if (!body) return { chars: 0, words: 0, lines: 0 };
  const chars = Array.from(body).length; // counts code points, not UTF-16 units
  const words = body.split(/\s+/).filter((w) => w.length > 0).length;
  const lines = text.split("\n").length;
  return { chars, words, lines };
}

/* ---- Inline task lists (checkbox lines like "- [ ] …" / "[x] …") ---- */
// A task line keeps its indentation and content; only the "[ ]" / "[x]" box
// marker participates in parsing/toggling, so other note text is untouched.
const TASK_LINE = /^(\s*(?:-\s*)?)(\[[ xX]\])(.*)$/;

export interface TaskItem {
  done: boolean;
  label: string; // content after the box, trimmed
}

/** Pull every task box out of a note body (only `[ ]` / `[x]` lines count). */
export function tasksOf(text: string): TaskItem[] {
  const out: TaskItem[] = [];
  for (const raw of text.split("\n")) {
    const m = TASK_LINE.exec(raw);
    if (!m) continue;
    out.push({ done: m[2]!.includes("x") || m[2]!.includes("X"), label: (m[3] ?? "").trim() });
  }
  return out;
}

/** Flip the Nth task box (0-based) in the text, leaving all other content alone.
 * Returns the same string when `taskIndex` is out of range (pure no-op). */
export function toggleTaskInText(text: string, taskIndex: number): string {
  const lines = text.split("\n");
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_LINE.exec(lines[i]!);
    if (!m) continue;
    seen += 1;
    if (seen === taskIndex) {
      const indent = m[1] ?? "";
      const marker = m[2] ?? "";
      const rest = m[3] ?? "";
      const done = marker.includes("x") || marker.includes("X");
      lines[i] = `${indent}${done ? "[ ]" : "[x]"}${rest}`;
      break;
    }
  }
  return lines.join("\n");
}

/** Quick progress readout for UI labels: {total, done}. */
export function taskSummary(text: string): { total: number; done: number } {
  const tasks = tasksOf(text);
  return { total: tasks.length, done: tasks.filter((tk) => tk.done).length };
}

/** Toggle the Nth task of a note *in place in the list* (without reordering or
 * bumping `ts`), so a checkbox tap in the read-only list edits that one box only. */
export function toggleTaskInNote(list: Note[], id: string, taskIndex: number): Note[] {
  if (!list.some((n) => n.id === id)) return list;
  return list.map((n) => (n.id === id ? { ...n, text: toggleTaskInText(n.text, taskIndex) } : n));
}

/** Mark every task line as done (`[x]`), preserving indentation/other content. */
export function completeTasksInText(text: string): string {
  const lines = text.split("\n").map((line) => {
    const m = TASK_LINE.exec(line);
    if (!m) return line;
    return `${m[1] ?? ""}[x]${m[3] ?? ""}`;
  });
  return lines.join("\n");
}

/** Complete all tasks of one note in the list (keeps order + ts). */
export function completeAllTasks(list: Note[], id: string): Note[] {
  return list.map((n) => (n.id === id ? { ...n, text: completeTasksInText(n.text) } : n));
}

/** Aggregate task progress across a set of notes (e.g. the active list). */
export function noteListProgress(list: Note[]): { notes: number; total: number; done: number } {
  let notes = 0;
  let total = 0;
  let done = 0;
  for (const n of list) {
    const s = taskSummary(n.text);
    if (s.total === 0) continue;
    notes += 1;
    total += s.total;
    done += s.done;
  }
  return { notes, total, done };
}

/* ---- Light inline rich text: **bold**, ==highlight==, ~~strike~~, [link](url) ---- */
export interface RichSeg {
  text: string;
  bold: boolean;
  hl: boolean;
  strike: boolean;
  /** Present only for a `[text](url)` segment. */
  url?: string;
  link?: boolean;
}

const PLAIN_SEG = (text: string): RichSeg => ({ text, bold: false, hl: false, strike: false });

/** Split a note body into plain / bold / highlighted / struck / link segments.
 * Text not wrapped in markers stays plain; the original text is kept verbatim
 * (newlines included). Pure + headless-testable. */
export function fmtInline(text: string): RichSeg[] {
  const out: RichSeg[] = [];
  const re =
    /(\*\*([^*]+?)\*\*|==([^=]+?)==|~~([^~]+?)~~|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(PLAIN_SEG(text.slice(last, m.index)));
    const raw = m[0]!;
    if (m[2] !== undefined) {
      out.push({ text: m[2], bold: true, hl: false, strike: false });
    } else if (m[3] !== undefined) {
      out.push({ text: m[3], bold: false, hl: true, strike: false });
    } else if (m[4] !== undefined) {
      out.push({ text: m[4], bold: false, hl: false, strike: true });
    } else {
      // [text](url)
      out.push({
        text: m[5]!,
        bold: false,
        hl: false,
        strike: false,
        url: m[6],
        link: true,
      });
    }
    last = m.index + raw.length;
  }
  if (last < text.length) out.push(PLAIN_SEG(text.slice(last)));
  return out;
}
